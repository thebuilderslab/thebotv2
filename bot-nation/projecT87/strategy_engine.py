"""
Per-Wallet Delegated Strategy Engine — Full Automation Only
============================================================
Runs macro/micro/growth/capacity strategies on each delegated user wallet.
All on-chain actions are routed through the REAADelegationManager contract,
not the bot's own wallet.

There is ONE mode only: full automation. A wallet is either:
  - fully delegated (isActive=true, all flags per FULL_AUTOMATION profile), or
  - disabled / revoked / error_permissions (strategies must not run).
No "monitoring only" — misconfigurations become explicit errors.

HF Band Priority Order (checked top to bottom, first match wins):
-----------------------------------------------------------------
0. RESUME (any HF): If an incomplete distribution is detected (execution state
   file exists OR user wallet has DAI from a prior borrow), the swap pipeline
   resumes immediately. This runs BEFORE Nurse and BEFORE HF threshold checks.
1. EMERGENCY (HF < 2.20): Position at risk. Log critical warning, SKIP.
2. GROWTH (HF >= 2.60, collateral grew >= $50 or >= 10%, available borrows >= $13.20):
   Full 6-step distribution: borrow DAI, supply DAI, swap+supply WBTC, swap+supply WETH,
   swap DAI->ETH for gas, transfer DAI to Wallet_S, swap DAI->USDC (stays in user wallet).
3. CAPACITY (HF >= 2.40, available borrows >= $8.20):
   Same 6-step engine with smaller amounts.
4. MACRO SHORT (collateral velocity drop >= $50 in 5 min, HF >= 3.05):
   Hedge via WETH borrow against market downturn. $15 short size.
5. MICRO SHORT (collateral velocity drop >= $30 in 5 min, HF >= 3.00):
   Smaller hedge ($8). 3-min cooldown. Max hold 10 min.
6. IDLE / SKIP: No conditions met. Log reason and wait for next cycle.

USER WALLET vs PERSONAL BOT — Two Intentional Differences:
  1. Profit Bucket: DISABLED for user wallets. USDC stays in user wallet, never flushed.
  2. Liability Short close: 20/20/30/20/10 split — 20% Wallet_S (DAI), 20% USDC (wallet), 30% WBTC (Aave), 20% WETH (Aave), 10% USDT (Aave). Personal bot uses 20/20/60.

Inputs (all from defi_positions — single source of truth):
  - health_factor, total_collateral_usd, total_debt_usd (from DB, refreshed by monitoring)
  - available_borrows_usd (fetched live from Aave via delegation_client.get_user_account_data)
  - Delegation permissions (from on-chain getDelegation call)

One action per wallet per cycle. No double-execution.
"""

import os
import json
import time
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

GROWTH_HF_THRESHOLD = 3.60
CAPACITY_HF_THRESHOLD = 3.40
MACRO_HF_THRESHOLD = 4.05
MICRO_HF_THRESHOLD = 4.00
EMERGENCY_HF_THRESHOLD = 3.20

BORROW_COOLDOWN_SECONDS = 1800

GROWTH_MIN_CAPACITY_USD = 13.20
CAPACITY_MIN_CAPACITY_USD = 8.20

GROWTH_ABSOLUTE_TRIGGER_USD = 50.0
GROWTH_RELATIVE_TRIGGER_PCT = 0.10

GROWTH_BORROW_USD = 11.40
CAPACITY_BORROW_USD = 6.70

GROWTH_DISTRIBUTION = {
    'total_borrow': 11.40,
    'usdt_swap_supply': 2.75,
    'wbtc_swap_supply': 2.80,
    'weth_swap_supply': 2.45,
    'eth_gas_reserve': 1.10,
    'dai_transfer': 1.10,
    'usdc_tax': 1.20,
}

CAPACITY_DISTRIBUTION = {
    'total_borrow': 6.70,
    'usdt_swap_supply': 1.10,
    'wbtc_swap_supply': 1.10,
    'weth_swap_supply': 1.10,
    'eth_gas_reserve': 1.10,
    'dai_transfer': 1.10,
    'usdc_tax': 1.20,
}

DELEGATED_STEP_ORDER = [
    "borrowed",
    "usdt_supplied",
    "wbtc_supplied",
    "weth_supplied",
    "eth_converted",
    "wallet_s_transferred",
    "usdc_taxed",
]

EXECUTION_STATE_DIR = "/tmp/reaa_delegation_states"

MACRO_VELOCITY_DROP_USD = 50.0
MACRO_VELOCITY_WINDOW_MIN = 5
MICRO_VELOCITY_DROP_USD = 30.0
MICRO_VELOCITY_WINDOW_MIN = 5
MICRO_COOLDOWN_HOURS = 0.05

MACRO_SHORT_SIZE_USD = 15.0
MICRO_SHORT_SIZE_USD = 8.0

MAX_SHORT_HOLD_MINUTES = 10

SIMULATION_MODE = True

SHORT_WBTC_PCT = 0.40
SHORT_USDT_PCT = 0.35
SHORT_WETH_PCT = 0.25

try:
    import db as database
    DB_AVAILABLE = True
except ImportError:
    DB_AVAILABLE = False

try:
    from delegation_client import (
        get_delegation_permissions,
        get_user_account_data,
        check_borrow_allowance,
        delegated_borrow_dai,
        delegated_borrow_weth,
        delegated_repay_weth,
        delegated_supply_dai_onbehalf,
        delegated_supply_wbtc_onbehalf,
        delegated_supply_weth_onbehalf,
        delegated_supply_usdt_onbehalf,
        delegated_withdraw_usdt,
        pull_token_from_user,
        dm_execute_supply,
        transfer_token_to_address,
        ensure_bot_dex_approval,
        _forward_tokens_to_user,
        delegated_borrow_to_bot,
        get_multi_token_balances,
        get_token_balance,
        unwrap_weth_to_eth,
        send_eth_to_address,
        ensure_bot_dex_approvals_all_tokens,
        DAI_ADDRESS,
        WETH_ADDRESS,
        WBTC_TOKEN_ADDRESS,
        USDT_ADDRESS,
        USDC_ADDRESS,
        UNISWAP_ROUTER_ADDRESS,
    )
    DELEGATION_AVAILABLE = True
except ImportError:
    DELEGATION_AVAILABLE = False

try:
    from permissions import FULL_AUTOMATION, REQUIRED_FLAGS, validate_full_automation
    PERMISSIONS_AVAILABLE = True
except ImportError:
    PERMISSIONS_AVAILABLE = False

try:
    from uniswap_integration import UniswapIntegration
    UNISWAP_AVAILABLE = True
except ImportError:
    UNISWAP_AVAILABLE = False


def _compute_velocity_drop(wallet_address, window_minutes):
    if not DB_AVAILABLE:
        return 0.0, 0.0, 0
    snapshots = database.get_collateral_snapshots(wallet_address, window_minutes)
    if len(snapshots) < 2:
        return 0.0, 0.0, len(snapshots)
    max_collateral = max(float(s['collateral_usd']) for s in snapshots)
    latest_collateral = float(snapshots[-1]['collateral_usd'])
    drop = max_collateral - latest_collateral
    return drop, latest_collateral, len(snapshots)


def _get_open_short(wallet_address):
    if not DB_AVAILABLE:
        return None
    return database.get_open_short(wallet_address)


def _save_short_position(user_id, wallet_address, tier, weth_borrowed, entry_collateral, entry_hf, tx_hash=None):
    if not DB_AVAILABLE:
        return None
    return database.save_short_position(user_id, wallet_address, tier, weth_borrowed, entry_collateral, entry_hf, tx_hash)


def _close_short_position(short_id, tx_hash_close=None, close_details=None):
    if not DB_AVAILABLE:
        return
    database.close_short_position(short_id, tx_hash_close, close_details)


def _check_micro_cooldown(wallet_address):
    if not DB_AVAILABLE:
        return True
    last_closed = database.get_last_closed_short(wallet_address)
    if not last_closed:
        return True
    if last_closed.get('tier') != 'micro':
        return True
    close_time = last_closed.get('close_time') or last_closed.get('entry_time')
    if not close_time:
        return True
    from datetime import datetime, timezone, timedelta
    cooldown_delta = timedelta(hours=MICRO_COOLDOWN_HOURS)
    now = datetime.now(timezone.utc)
    if hasattr(close_time, 'tzinfo') and close_time.tzinfo is None:
        close_time = close_time.replace(tzinfo=timezone.utc)
    return now >= close_time + cooldown_delta


def _log_strategy(user_id, wallet, mode, action, hf_before, hf_after=None, details=""):
    hf_after_str = f", hf_after={hf_after:.4f}" if hf_after is not None else ""
    msg = f"[Strategy] user={user_id} wallet={wallet[:10]}... mode={mode} action={action} hf_before={hf_before:.4f}{hf_after_str}"
    if details:
        msg += f" | {details}"
    logger.info(msg)
    print(msg)
    return msg


def _record_strategy_action(user_id, wallet_address, action_text):
    if not DB_AVAILABLE:
        return
    try:
        database.update_strategy_status(user_id, wallet_address, action_text)
    except Exception as e:
        logger.error(f"Failed to record strategy action for user {user_id}: {e}")


def _get_wallet_baseline(user_id, wallet_address):
    if not DB_AVAILABLE:
        return 0.0
    try:
        mw = database.get_managed_wallet(user_id, wallet_address)
        if mw and mw.get('last_collateral_baseline'):
            return float(mw['last_collateral_baseline'])
    except Exception:
        pass
    return 0.0


def _update_wallet_baseline(user_id, wallet_address, new_baseline):
    if not DB_AVAILABLE:
        return
    try:
        database.update_collateral_baseline(user_id, wallet_address, new_baseline)
    except Exception as e:
        logger.error(f"Failed to update baseline for user {user_id}: {e}")


def _get_execution_state_path(wallet_address):
    os.makedirs(EXECUTION_STATE_DIR, exist_ok=True)
    safe_addr = wallet_address.lower().replace("0x", "")
    return os.path.join(EXECUTION_STATE_DIR, f"exec_state_{safe_addr}.json")


def _save_execution_state(wallet_address, step, path_name, distribution):
    state = {
        "step": step,
        "path_name": path_name,
        "distribution": distribution,
        "timestamp": time.time(),
        "timestamp_human": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
    }
    try:
        path = _get_execution_state_path(wallet_address)
        with open(path, 'w') as f:
            json.dump(state, f, indent=2)
        logger.info(f"[ExecState] {wallet_address[:10]}... step={step} path={path_name}")
    except Exception as e:
        logger.error(f"[ExecState] save failed for {wallet_address[:10]}...: {e}")


def _load_execution_state(wallet_address):
    try:
        path = _get_execution_state_path(wallet_address)
        if os.path.exists(path):
            with open(path, 'r') as f:
                state = json.load(f)
            age = time.time() - state.get("timestamp", 0)
            if age > 86400:
                logger.warning(f"[ExecState] {wallet_address[:10]}... state is {age:.0f}s old (>24h) — clearing stale state")
                _clear_execution_state(wallet_address)
                return None
            return state
    except Exception as e:
        logger.error(f"[ExecState] load failed for {wallet_address[:10]}...: {e}")
    return None


def _clear_execution_state(wallet_address):
    try:
        path = _get_execution_state_path(wallet_address)
        if os.path.exists(path):
            os.remove(path)
            logger.info(f"[ExecState] {wallet_address[:10]}... state cleared")
    except Exception as e:
        logger.error(f"[ExecState] clear failed for {wallet_address[:10]}...: {e}")


def _get_borrow_cooldown_path(wallet_address):
    os.makedirs(EXECUTION_STATE_DIR, exist_ok=True)
    safe = wallet_address.lower().replace("0x", "")[:16]
    return os.path.join(EXECUTION_STATE_DIR, f"last_borrow_{safe}.json")


def _record_borrow_timestamp(wallet_address):
    try:
        path = _get_borrow_cooldown_path(wallet_address)
        with open(path, 'w') as f:
            json.dump({"timestamp": time.time(), "human": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")}, f)
    except Exception as e:
        logger.error(f"[Cooldown] {wallet_address[:10]}... save failed: {e}")


def _check_borrow_cooldown(wallet_address):
    try:
        path = _get_borrow_cooldown_path(wallet_address)
        if not os.path.exists(path):
            return True, 0
        with open(path, 'r') as f:
            data = json.load(f)
        elapsed = time.time() - data.get("timestamp", 0)
        remaining = BORROW_COOLDOWN_SECONDS - elapsed
        if remaining <= 0:
            return True, 0
        return False, remaining
    except Exception:
        return True, 0


def _get_dai_debt_balance(wallet_address):
    if not DELEGATION_AVAILABLE:
        return 0.0
    try:
        from delegation_client import _get_web3, VARIABLE_DEBT_TOKENS
        from web3 import Web3
        w3 = _get_web3()
        dai_debt_addr = VARIABLE_DEBT_TOKENS.get("DAI")
        if not dai_debt_addr or not w3:
            return 0.0
        erc20_abi = [{"inputs": [{"name": "account", "type": "address"}], "name": "balanceOf", "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"}]
        debt_token = w3.eth.contract(address=Web3.to_checksum_address(dai_debt_addr), abi=erc20_abi)
        raw = debt_token.functions.balanceOf(Web3.to_checksum_address(wallet_address)).call()
        return raw / 1e18
    except Exception as e:
        logger.error(f"[DAIDebt] {wallet_address[:10]}... check error: {e}")
        return 0.0


def _detect_orphaned_dai(wallet_address):
    if not DELEGATION_AVAILABLE:
        return False, 0.0
    try:
        balances = get_multi_token_balances(wallet_address)
        dai_balance = balances.get("DAI", {}).get("balance", 0) if balances else 0

        dai_debt = _get_dai_debt_balance(wallet_address)

        if dai_balance >= 2.0 and dai_debt >= 1.0:
            return True, dai_balance
    except Exception as e:
        logger.error(f"[OrphanDAI] {wallet_address[:10]}... detection error: {e}")
    return False, 0.0


def has_active_distribution(wallet_address):
    state = _load_execution_state(wallet_address)
    if state and state.get("step") and state.get("path_name"):
        step = state["step"]
        last_step = DELEGATED_STEP_ORDER[-1]
        if step != last_step:
            return True

    orphaned, dai_bal = _detect_orphaned_dai(wallet_address)
    if orphaned:
        logger.info(f"[ActiveDist] {wallet_address[:10]}... orphaned DAI detected (${dai_bal:.2f} DAI + debt) — treating as active distribution")
        return True
    return False


def resume_incomplete_distribution(user_id, wallet_address, agent):
    state = _load_execution_state(wallet_address)

    if state:
        step = state.get("step", "")
        path_name = state.get("path_name", "")
        distribution = state.get("distribution", {})
        last_step = DELEGATED_STEP_ORDER[-1]

        if step == last_step:
            _clear_execution_state(wallet_address)
            return None

        if not path_name or not distribution:
            logger.warning(f"[Resume] {wallet_address[:10]}... corrupt execution state — clearing")
            _clear_execution_state(wallet_address)
        else:
            age = time.time() - state.get("timestamp", 0)
            logger.info(f"[Resume] {wallet_address[:10]}... INCOMPLETE distribution (state file)! "
                        f"path={path_name}, last_step={step}, age={age:.0f}s — resuming swap pipeline")

            live_data = get_user_account_data(wallet_address) if DELEGATION_AVAILABLE else None
            live_hf = live_data.get("healthFactor", 0) if live_data else 0

            result = _execute_delegated_distribution(user_id, wallet_address, agent, path_name, distribution, live_hf)
            result["resumed"] = True
            result["resume_source"] = "state_file"
            logger.info(f"[Resume] {wallet_address[:10]}... state-file resume result: "
                        f"action={result.get('action')}, details={result.get('details')}")
            return result

    orphaned, dai_balance = _detect_orphaned_dai(wallet_address)
    if orphaned:
        logger.info(f"[Resume] {wallet_address[:10]}... ORPHANED DAI detected! "
                    f"DAI=${dai_balance:.2f} in wallet + active DAI debt — building recovery distribution")

        if dai_balance < 5.0:
            logger.info(f"[Resume] {wallet_address[:10]}... orphaned DAI ${dai_balance:.2f} below $5 minimum — "
                        f"too small for meaningful swaps, skipping recovery")
            return None

        recovery_distribution = dict(CAPACITY_DISTRIBUTION)
        if dai_balance > GROWTH_BORROW_USD:
            recovery_distribution = dict(GROWTH_DISTRIBUTION)

        total_available = dai_balance
        recovery_distribution['total_borrow'] = 0

        template_total = sum(v for k, v in recovery_distribution.items() if k != 'total_borrow')
        scale = min(1.0, total_available / template_total) if template_total > 0 else 0

        for k in recovery_distribution:
            if k != 'total_borrow':
                recovery_distribution[k] = round(recovery_distribution[k] * scale, 2)

        viable_legs = sum(1 for k, v in recovery_distribution.items() if k != 'total_borrow' and v >= 1.0)
        if viable_legs < 2:
            logger.info(f"[Resume] {wallet_address[:10]}... recovery distribution has only {viable_legs} legs >= $1 — "
                        f"not enough for meaningful recovery, skipping")
            return None

        _save_execution_state(wallet_address, "borrowed", "recovery", recovery_distribution)

        live_data = get_user_account_data(wallet_address) if DELEGATION_AVAILABLE else None
        live_hf = live_data.get("healthFactor", 0) if live_data else 0

        result = _execute_delegated_distribution(user_id, wallet_address, agent, "recovery", recovery_distribution, live_hf)
        result["resumed"] = True
        result["resume_source"] = "orphaned_dai"
        logger.info(f"[Resume] {wallet_address[:10]}... orphaned DAI resume result: "
                    f"action={result.get('action')}, details={result.get('details')}")
        return result

    return None


def _get_uniswap(agent):
    if hasattr(agent, 'uniswap') and agent.uniswap:
        return agent.uniswap
    return _get_bot_uniswap()


_bot_uniswap_cache = None

def _get_bot_uniswap():
    global _bot_uniswap_cache
    if _bot_uniswap_cache is not None:
        return _bot_uniswap_cache
    if UNISWAP_AVAILABLE:
        try:
            from delegation_client import _get_web3, _get_bot_account
            w3 = _get_web3()
            acct = _get_bot_account()
            if w3 and acct:
                _bot_uniswap_cache = UniswapIntegration(w3, acct)
                logger.info(f"[Uniswap] Bot-wallet UniswapIntegration created for {acct.address}")
                return _bot_uniswap_cache
            else:
                logger.error("[Uniswap] Cannot create bot UniswapIntegration: missing w3 or bot account")
        except Exception as e:
            logger.error(f"[Uniswap] Failed to initialize bot UniswapIntegration: {e}")
    return None


def _execute_delegated_distribution(user_id, wallet_address, agent, path_name, distribution, live_hf, path_min_hf=None):
    """
    Execute the full 7-step distribution for a delegated user wallet.
    Bot borrows directly from Aave via credit delegation (tokens go to bot wallet).
    User delegates credit to bot wallet via EIP-712 signatures, so no pull step needed.

    Steps:
      1. Borrow DAI via credit delegation (bot calls Pool.borrow onBehalfOf=user, DAI lands in BOT wallet)
      2. Swap DAI->USDT (multi-hop via WETH) -> supply USDT to Aave onBehalfOf user
      3. Swap DAI->WBTC -> supply WBTC to Aave onBehalfOf user
      4. Swap DAI->WETH -> supply WETH to Aave onBehalfOf user
      5. Swap DAI->WETH -> unwrap -> send ETH to user (gas reserve)
      6. Transfer DAI to Wallet_S
      7. Swap DAI->USDC -> transfer USDC to user wallet

    PRECONDITIONS:
      - User has delegated credit (DAI + WETH variable debt) to bot wallet via EIP-712 signatures.
      - BOT->DEX Router approval is asserted before each swap (ensure_bot_dex_approval).

    SAFETY: Each swap step is wrapped in try/except. On failure, tokens are
    returned to user wallet via _forward_tokens_to_user before aborting that step.
    Crash recovery via execution_state files.
    """
    result = {"mode": path_name, "action": "DISTRIBUTION", "executed": False, "details": "", "steps_completed": []}
    total_borrow = distribution['total_borrow']

    existing_state = _load_execution_state(wallet_address)
    resume_after = None
    if existing_state and existing_state.get("path_name") == path_name:
        resume_after = existing_state.get("step")
        logger.info(f"[Distribution] {wallet_address[:10]}... resuming {path_name} after step '{resume_after}'")

    already_done = set()
    if resume_after and resume_after in DELEGATED_STEP_ORDER:
        idx = DELEGATED_STEP_ORDER.index(resume_after)
        already_done = set(DELEGATED_STEP_ORDER[:idx + 1])

    uniswap = _get_bot_uniswap()
    if not uniswap:
        result["details"] = "Bot-wallet Uniswap unavailable — cannot execute swaps"
        result["action"] = "UNISWAP_UNAVAILABLE"
        logger.error(f"[Distribution] {wallet_address[:10]}... ABORTED: bot-wallet UniswapIntegration is None")
        _record_strategy_action(user_id, wallet_address, "ERROR: bot uniswap unavailable")
        return result

    dist_serializable = {k: v for k, v in distribution.items()}
    steps_completed = list(already_done)
    steps_failed = []

    try:
        if "borrowed" not in already_done:
            if total_borrow <= 0:
                logger.info(f"[Distribution] {wallet_address[:10]}... total_borrow=0 (recovery mode) — skipping borrow step")
                _save_execution_state(wallet_address, "borrowed", path_name, dist_serializable)
                steps_completed.append("borrowed")
            else:
                dai_allowance = check_borrow_allowance(wallet_address, "DAI") if DELEGATION_AVAILABLE else 0
                if dai_allowance == 0:
                    logger.warning(f"[Strategy] wallet={wallet_address[:10]}... DAI credit delegation missing (borrowAllowance=0). Skipping borrow — user must re-sign delegation or background processor will submit.")
                    result["details"] = "DAI credit delegation not active (borrowAllowance=0). Pending on-chain submission."
                    result["action"] = "BORROW_SKIPPED_NO_DELEGATION"
                    return result
                _log_strategy(user_id, wallet_address, path_name, "STEP1_BORROW", live_hf,
                              details=f"Borrowing ${total_borrow:.2f} DAI via delegation (allowance={dai_allowance})")
                tx_hash = delegated_borrow_dai(wallet_address, total_borrow)
                if not tx_hash:
                    result["details"] = f"DAI borrow failed for ${total_borrow:.2f}"
                    result["action"] = "BORROW_FAILED"
                    _record_strategy_action(user_id, wallet_address, f"FAILED: {path_name} borrow ${total_borrow:.2f} DAI")
                    return result
                _save_execution_state(wallet_address, "borrowed", path_name, dist_serializable)
                steps_completed.append("borrowed")
                _record_borrow_timestamp(wallet_address)
                time.sleep(3)

                post_borrow_data = get_user_account_data(wallet_address) if DELEGATION_AVAILABLE else None
                post_borrow_hf = post_borrow_data.get("healthFactor", 0) if post_borrow_data else 0
                _effective_path_min = path_min_hf if path_min_hf is not None else CAPACITY_HF_THRESHOLD
                if post_borrow_hf > 0 and post_borrow_hf < EMERGENCY_HF_THRESHOLD:
                    logger.warning(f"[Distribution] {wallet_address[:10]}... POST-BORROW HF {post_borrow_hf:.4f} < "
                                   f"EMERGENCY {EMERGENCY_HF_THRESHOLD} — ABORTING distribution, preserving state at 'borrowed' for recovery")
                    _save_execution_state(wallet_address, "borrowed", path_name, dist_serializable)
                    result["details"] = f"Post-borrow HF {post_borrow_hf:.4f} dropped below emergency threshold ({EMERGENCY_HF_THRESHOLD})"
                    result["action"] = "BORROW_HF_ABORT"
                    result["executed"] = True
                    _record_strategy_action(user_id, wallet_address,
                                            f"ABORT: post-borrow HF {post_borrow_hf:.4f} < EMERGENCY {EMERGENCY_HF_THRESHOLD}")
                    if DB_AVAILABLE:
                        database.record_wallet_action_v2(user_id, wallet_address, "BORROW_HF_ABORT",
                            {"hf": post_borrow_hf, "threshold": EMERGENCY_HF_THRESHOLD, "level": "emergency"},
                            details_summary=f"[SHIELD DEPLOYED] Post-borrow HF {post_borrow_hf:.4f} critically low — distribution aborted",
                            severity="critical")
                    return result
                elif post_borrow_hf > 0 and post_borrow_hf < _effective_path_min:
                    logger.warning(f"[Distribution] {wallet_address[:10]}... POST-BORROW HF {post_borrow_hf:.4f} < "
                                   f"PATH MIN {_effective_path_min} — ABORTING distribution, preserving state at 'borrowed' for recovery")
                    _save_execution_state(wallet_address, "borrowed", path_name, dist_serializable)
                    result["details"] = f"Post-borrow HF {post_borrow_hf:.4f} dropped below path minimum ({_effective_path_min})"
                    result["action"] = "BORROW_HF_ABORT"
                    result["executed"] = True
                    _record_strategy_action(user_id, wallet_address,
                                            f"ABORT: post-borrow HF {post_borrow_hf:.4f} < path_min {_effective_path_min}")
                    if DB_AVAILABLE:
                        database.record_wallet_action_v2(user_id, wallet_address, "BORROW_HF_ABORT",
                            {"hf": post_borrow_hf, "threshold": _effective_path_min, "level": "path_min"},
                            details_summary=f"[SHIELD DEPLOYED] Post-borrow HF {post_borrow_hf:.4f} below path minimum {_effective_path_min} — distribution aborted",
                            severity="warning")
                    return result

        usdt_amount = distribution['usdt_swap_supply']
        if "usdt_supplied" not in already_done and usdt_amount >= 0.50 and uniswap:
            _log_strategy(user_id, wallet_address, path_name, "STEP2_USDT_SWAP", live_hf,
                          details=f"Swap ${usdt_amount:.2f} DAI->USDT -> supply onBehalfOf")
            usdt_dai_wei = int(usdt_amount * 1e18)
            try:
                if not ensure_bot_dex_approval(DAI_ADDRESS, usdt_dai_wei):
                    raise Exception("BOT->DEX Router DAI approval failed")
                from delegation_client import _get_bot_account, _get_web3, ERC20_ABI
                w3 = _get_web3()
                acct = _get_bot_account()
                usdt_contract = w3.eth.contract(
                    address=w3.to_checksum_address(USDT_ADDRESS), abi=ERC20_ABI)
                usdt_before = usdt_contract.functions.balanceOf(acct.address).call()
                swap_result = uniswap.swap_dai_for_usdt_multihop(usdt_amount)
                if swap_result and swap_result.get('tx_hash'):
                    time.sleep(3)
                    usdt_after = usdt_contract.functions.balanceOf(acct.address).call()
                    usdt_received = usdt_after - usdt_before
                    if usdt_received > 0:
                        usdt_float = usdt_received / 1e6
                        supply_tx = delegated_supply_usdt_onbehalf(wallet_address, usdt_float)
                        if supply_tx:
                            _save_execution_state(wallet_address, "usdt_supplied", path_name, dist_serializable)
                            steps_completed.append("usdt_supplied")
                            time.sleep(2)
                        else:
                            logger.error(f"[Distribution] {wallet_address[:10]}... USDT supply failed. Returning {usdt_float:.2f} USDT to user.")
                            _forward_tokens_to_user(USDT_ADDRESS, usdt_received, wallet_address)
                            steps_failed.append("usdt_supply_to_aave")
                    else:
                        steps_failed.append("usdt_swap_zero_output")
                else:
                    raise Exception("DAI->USDT swap tx failed or reverted")
            except Exception as e:
                logger.error(f"[Distribution] {wallet_address[:10]}... USDT swap failed: {e}. Rolling back DAI to user.")
                _forward_tokens_to_user(DAI_ADDRESS, usdt_dai_wei, wallet_address)
                steps_failed.append("dai_to_usdt_swap_rollback")
        elif "usdt_supplied" in already_done:
            pass

        wbtc_amount = distribution['wbtc_swap_supply']
        if "wbtc_supplied" not in already_done and wbtc_amount >= 0.50 and uniswap:
            _log_strategy(user_id, wallet_address, path_name, "STEP3_WBTC_SWAP", live_hf,
                          details=f"Swap ${wbtc_amount:.2f} DAI->WBTC -> supply onBehalfOf")
            wbtc_dai_wei = int(wbtc_amount * 1e18)
            try:
                if not ensure_bot_dex_approval(DAI_ADDRESS, wbtc_dai_wei):
                    raise Exception("BOT->DEX Router DAI approval failed")
                from delegation_client import _get_bot_account, _get_web3, ERC20_ABI
                w3 = _get_web3()
                acct = _get_bot_account()
                wbtc_contract = w3.eth.contract(
                    address=w3.to_checksum_address(WBTC_TOKEN_ADDRESS), abi=ERC20_ABI)
                wbtc_before = wbtc_contract.functions.balanceOf(acct.address).call()
                swap_result = uniswap.swap_dai_for_wbtc(wbtc_amount)
                if swap_result and swap_result.get('tx_hash'):
                    time.sleep(3)
                    wbtc_after = wbtc_contract.functions.balanceOf(acct.address).call()
                    wbtc_received = wbtc_after - wbtc_before
                    if wbtc_received > 0:
                        wbtc_float = wbtc_received / 1e8
                        supply_tx = delegated_supply_wbtc_onbehalf(wallet_address, wbtc_float)
                        if supply_tx:
                            _save_execution_state(wallet_address, "wbtc_supplied", path_name, dist_serializable)
                            steps_completed.append("wbtc_supplied")
                            time.sleep(2)
                        else:
                            logger.error(f"[Distribution] {wallet_address[:10]}... WBTC supply failed. Returning {wbtc_float:.8f} WBTC to user.")
                            _forward_tokens_to_user(WBTC_TOKEN_ADDRESS, wbtc_received, wallet_address)
                            steps_failed.append("wbtc_supply_to_aave")
                    else:
                        steps_failed.append("wbtc_swap_zero_output")
                else:
                    raise Exception("DAI->WBTC swap tx failed or reverted")
            except Exception as e:
                logger.error(f"[Distribution] {wallet_address[:10]}... WBTC swap failed: {e}. Rolling back DAI to user.")
                _forward_tokens_to_user(DAI_ADDRESS, wbtc_dai_wei, wallet_address)
                steps_failed.append("dai_to_wbtc_swap_rollback")
        elif "wbtc_supplied" in already_done:
            pass

        weth_amount = distribution['weth_swap_supply']
        if "weth_supplied" not in already_done and weth_amount >= 0.50 and uniswap:
            _log_strategy(user_id, wallet_address, path_name, "STEP4_WETH_SWAP", live_hf,
                          details=f"Swap ${weth_amount:.2f} DAI->WETH -> supply onBehalfOf")
            weth_dai_wei = int(weth_amount * 1e18)
            try:
                if not ensure_bot_dex_approval(DAI_ADDRESS, weth_dai_wei):
                    raise Exception("BOT->DEX Router DAI approval failed")
                from delegation_client import _get_bot_account, _get_web3, ERC20_ABI
                w3 = _get_web3()
                acct = _get_bot_account()
                weth_contract = w3.eth.contract(
                    address=w3.to_checksum_address(WETH_ADDRESS), abi=ERC20_ABI)
                weth_before = weth_contract.functions.balanceOf(acct.address).call()
                swap_result = uniswap.swap_dai_for_weth(weth_amount)
                if swap_result and swap_result.get('tx_hash'):
                    time.sleep(3)
                    weth_after = weth_contract.functions.balanceOf(acct.address).call()
                    weth_received = weth_after - weth_before
                    if weth_received > 0:
                        weth_float = weth_received / 1e18
                        supply_tx = delegated_supply_weth_onbehalf(wallet_address, weth_float)
                        if supply_tx:
                            _save_execution_state(wallet_address, "weth_supplied", path_name, dist_serializable)
                            steps_completed.append("weth_supplied")
                            time.sleep(2)
                        else:
                            logger.error(f"[Distribution] {wallet_address[:10]}... WETH supply failed. Returning {weth_float:.8f} WETH to user.")
                            _forward_tokens_to_user(WETH_ADDRESS, weth_received, wallet_address)
                            steps_failed.append("weth_supply_to_aave")
                    else:
                        steps_failed.append("weth_swap_zero_output")
                else:
                    raise Exception("DAI->WETH swap tx failed or reverted")
            except Exception as e:
                logger.error(f"[Distribution] {wallet_address[:10]}... WETH swap failed: {e}. Rolling back DAI to user.")
                _forward_tokens_to_user(DAI_ADDRESS, weth_dai_wei, wallet_address)
                steps_failed.append("dai_to_weth_swap_rollback")
        elif "weth_supplied" in already_done:
            pass

        ETH_GAS_SKIM_PCT = 0.01
        ETH_GAS_MIN_USD = 1.50
        eth_amount = distribution['eth_gas_reserve']
        if "eth_converted" not in already_done and eth_amount >= ETH_GAS_MIN_USD and uniswap:
            _log_strategy(user_id, wallet_address, path_name, "STEP5_ETH_GAS", live_hf,
                          details=f"Swap ${eth_amount:.2f} DAI->WETH -> unwrap -> 1% skim -> send ETH to user")
            eth_dai_wei = int(eth_amount * 1e18)
            try:
                if not ensure_bot_dex_approval(DAI_ADDRESS, eth_dai_wei):
                    raise Exception("BOT->DEX Router DAI approval failed")
                from delegation_client import _get_bot_account, _get_web3, ERC20_ABI
                w3 = _get_web3()
                acct = _get_bot_account()
                weth_contract = w3.eth.contract(
                    address=w3.to_checksum_address(WETH_ADDRESS), abi=ERC20_ABI)
                weth_before = weth_contract.functions.balanceOf(acct.address).call()
                swap_result = uniswap.swap_dai_for_weth(eth_amount)
                if swap_result and swap_result.get('tx_hash'):
                    time.sleep(3)
                    weth_after = weth_contract.functions.balanceOf(acct.address).call()
                    weth_received = weth_after - weth_before
                    if weth_received > 0:
                        weth_float = weth_received / 1e18
                        skim_weth = weth_float * ETH_GAS_SKIM_PCT
                        user_weth = weth_float - skim_weth
                        logger.info(f"[GasSkim] {wallet_address[:10]}... WETH received: {weth_float:.8f}, "
                                   f"1% skim={skim_weth:.8f} WETH stays in bot wallet, "
                                   f"99% user={user_weth:.8f} WETH -> unwrap -> ETH")
                        unwrap_tx = unwrap_weth_to_eth(user_weth)
                        if unwrap_tx:
                            time.sleep(2)
                            send_tx = send_eth_to_address(wallet_address, user_weth * 0.995)
                            if send_tx:
                                _save_execution_state(wallet_address, "eth_converted", path_name, dist_serializable)
                                steps_completed.append("eth_converted")
                                logger.info(f"[ETH Gas] {wallet_address[:10]}... sent {user_weth * 0.995:.8f} ETH for gas")
                                time.sleep(2)
                            else:
                                logger.error(f"[ETH Gas] {wallet_address[:10]}... ETH send to user failed")
                                steps_failed.append("eth_send_to_user")
                        else:
                            logger.error(f"[ETH Gas] {wallet_address[:10]}... WETH unwrap failed, forwarding WETH to user instead")
                            _forward_tokens_to_user(WETH_ADDRESS, int(user_weth * 1e18), wallet_address)
                            _save_execution_state(wallet_address, "eth_converted", path_name, dist_serializable)
                            steps_completed.append("eth_converted")
                    else:
                        steps_failed.append("eth_swap_zero_weth")
                else:
                    raise Exception("DAI->WETH swap tx failed or reverted")
            except Exception as e:
                logger.error(f"[ETH Gas] {wallet_address[:10]}... DAI->ETH conversion failed: {e}. Rolling back DAI to user.")
                _forward_tokens_to_user(DAI_ADDRESS, eth_dai_wei, wallet_address)
                steps_failed.append("dai_to_eth_swap_rollback")
        elif "eth_converted" in already_done:
            pass
        elif eth_amount > 0 and eth_amount < ETH_GAS_MIN_USD:
            _log_strategy(user_id, wallet_address, path_name, "STEP5_ETH_GAS_SKIP", live_hf,
                          details=f"${eth_amount:.2f} DAI below ${ETH_GAS_MIN_USD} min for gas swap (4 txns uneconomical), DAI stays in user wallet")

        dai_transfer = distribution['dai_transfer']
        if "wallet_s_transferred" not in already_done and dai_transfer >= 0.50:
            wallet_s = os.getenv('WALLET_S_ADDRESS', '').strip()
            if wallet_s and len(wallet_s) == 42:
                _log_strategy(user_id, wallet_address, path_name, "STEP6_WALLET_S", live_hf,
                              details=f"Transfer ${dai_transfer:.2f} DAI to Wallet_S")
                dai_transfer_wei = int(dai_transfer * 1e18)
                xfer_tx = transfer_token_to_address(wallet_s, DAI_ADDRESS, dai_transfer_wei)
                if xfer_tx:
                    _save_execution_state(wallet_address, "wallet_s_transferred", path_name, dist_serializable)
                    steps_completed.append("wallet_s_transferred")
                    time.sleep(2)
                else:
                    steps_failed.append("wallet_s_transfer")
            else:
                logger.warning(f"[Distribution] WALLET_S_ADDRESS not set — skipping Wallet_S transfer")
                _save_execution_state(wallet_address, "wallet_s_transferred", path_name, dist_serializable)
                steps_completed.append("wallet_s_transferred")

        usdc_tax = distribution.get('usdc_tax', 0)
        if "usdc_taxed" not in already_done and usdc_tax >= 0.50 and uniswap:
            _log_strategy(user_id, wallet_address, path_name, "STEP7_USDC_TAX", live_hf,
                          details=f"Swap ${usdc_tax:.2f} DAI->USDC -> transfer USDC to user")
            usdc_dai_wei = int(usdc_tax * 1e18)
            try:
                if not ensure_bot_dex_approval(DAI_ADDRESS, usdc_dai_wei):
                    raise Exception("BOT->DEX Router DAI approval failed")
                from delegation_client import _get_bot_account, _get_web3, ERC20_ABI
                w3 = _get_web3()
                acct = _get_bot_account()
                usdc_contract = w3.eth.contract(
                    address=w3.to_checksum_address(USDC_ADDRESS), abi=ERC20_ABI)
                usdc_before = usdc_contract.functions.balanceOf(acct.address).call()
                swap_result = uniswap.swap_dai_for_usdc(usdc_tax)
                if swap_result and swap_result.get('tx_hash'):
                    time.sleep(3)
                    usdc_after = usdc_contract.functions.balanceOf(acct.address).call()
                    usdc_received = usdc_after - usdc_before
                    if usdc_received > 0:
                        xfer_tx = transfer_token_to_address(wallet_address, USDC_ADDRESS, usdc_received)
                        if xfer_tx:
                            _save_execution_state(wallet_address, "usdc_taxed", path_name, dist_serializable)
                            steps_completed.append("usdc_taxed")
                        else:
                            _forward_tokens_to_user(USDC_ADDRESS, usdc_received, wallet_address)
                            steps_failed.append("usdc_transfer_to_user")
                    else:
                        steps_failed.append("usdc_swap_zero_output")
                else:
                    raise Exception("DAI->USDC swap tx failed or reverted")
            except Exception as e:
                logger.error(f"[Distribution] {wallet_address[:10]}... USDC swap failed: {e}. Rolling back DAI to user.")
                _forward_tokens_to_user(DAI_ADDRESS, usdc_dai_wei, wallet_address)
                steps_failed.append("dai_to_usdc_swap_rollback")
        elif "usdc_taxed" in already_done:
            pass

        borrow_done = "borrowed" in steps_completed or "borrowed" in already_done
        final_step_done = DELEGATED_STEP_ORDER[-1] in steps_completed or DELEGATED_STEP_ORDER[-1] in already_done

        if borrow_done and not final_step_done and len(steps_failed) > 0:
            last_ok = steps_completed[-1] if steps_completed else "borrowed"
            logger.warning(f"[Distribution] {wallet_address[:10]}... borrow succeeded but {len(steps_failed)} "
                           f"steps failed, final step not reached — preserving state at '{last_ok}' for recovery next cycle")
            _save_execution_state(wallet_address, last_ok, path_name, dist_serializable)
        else:
            _clear_execution_state(wallet_address)

        post_data = get_user_account_data(wallet_address)
        post_hf = post_data.get("healthFactor", 0) if post_data else 0

        completed_count = len(steps_completed)
        failed_count = len(steps_failed)
        detail_str = f"{completed_count}/7 steps OK"
        if failed_count > 0:
            detail_str += f", {failed_count} failed: {', '.join(steps_failed)}"
        detail_str += f", HF {live_hf:.2f} -> {post_hf:.2f}"

        result["executed"] = completed_count >= 1
        result["action"] = "DISTRIBUTION_COMPLETE" if failed_count == 0 else "DISTRIBUTION_PARTIAL"
        result["details"] = detail_str
        result["steps_completed"] = steps_completed

        _log_strategy(user_id, wallet_address, path_name, result["action"], live_hf, hf_after=post_hf,
                      details=detail_str)
        _record_strategy_action(user_id, wallet_address, f"{path_name.upper()}: {detail_str}")

        if result["executed"] and DB_AVAILABLE:
            try:
                database.add_notification(
                    wallet_address=wallet_address,
                    title=f"{path_name.capitalize()} Distribution",
                    message=f"{path_name.capitalize()} distribution completed: {detail_str}",
                    priority="info" if failed_count == 0 else "warning",
                )
            except Exception:
                pass

        if DB_AVAILABLE:
            database.record_wallet_action(
                user_id=user_id, wallet_address=wallet_address,
                action_type=f'strategy_{path_name}_distribution',
                details={"distribution": dist_serializable, "steps_completed": steps_completed,
                         "steps_failed": steps_failed, "hf_before": live_hf, "hf_after": post_hf},
                tx_hash=None)

        return result

    except Exception as e:
        logger.error(f"[Distribution] {wallet_address[:10]}... {path_name} failed: {e}", exc_info=True)
        result["details"] = f"Distribution exception: {e}"
        result["action"] = "DISTRIBUTION_ERROR"
        _record_strategy_action(user_id, wallet_address, f"ERROR: {path_name} distribution exception — {e}")
        return result


def _execute_mock_short_entry(user_id, wallet_address, tier, short_size_usd, live_hf, entry_collateral):
    weth_amount = short_size_usd / 2000.0

    logger.info(
        f"🧪 [MOCK SHORT ENTRY] wallet={wallet_address[:10]}... tier={tier} "
        f"size=${short_size_usd:.2f} weth={weth_amount:.6f} entry_collateral=${entry_collateral:.2f} | "
        f"SIMULATION_MODE=True — no on-chain tx executed")

    _log_strategy(user_id, wallet_address, f"{tier}_short_entry", "MOCK_ENTRY", live_hf,
                  details=f"[SIM] {tier} short mock-opened. size=${short_size_usd:.2f}, weth={weth_amount:.6f}. No on-chain tx.")

    if DB_AVAILABLE:
        database.record_wallet_action(
            user_id=user_id, wallet_address=wallet_address,
            action_type=f'strategy_short_entry_mock_{tier}',
            details={"tier": tier, "short_size_usd": short_size_usd,
                     "weth_amount": weth_amount, "simulation": True})

    result = {
        "mode": f"{tier}_short_entry", "action": "MOCK_ENTRY_OK", "executed": True,
        "details": f"[SIM] {tier} short mock-opened at ${short_size_usd:.2f}",
        "tx_hash": None, "weth_borrowed": weth_amount,
    }
    _record_strategy_action(user_id, wallet_address, f"MOCK ENTRY: {tier} short ${short_size_usd:.2f} (simulation)")
    return result


def _execute_delegated_short_entry(user_id, wallet_address, agent, tier, short_size_usd, live_hf):
    """
    Delegated liability short entry:
      1. Borrow WETH via delegation (lands in user wallet)
      2. Pull WETH from user -> swap 40% to WBTC -> supply onBehalfOf
      3. Remaining WETH: swap 35% to USDT -> supply onBehalfOf
      4. Remaining 25% WETH -> supply onBehalfOf as WETH collateral
    """
    result = {"mode": f"{tier}_short", "action": "SHORT_ENTRY", "executed": False, "details": ""}

    uniswap = _get_bot_uniswap()
    if not uniswap:
        result["details"] = "uniswap_unavailable"
        return result

    try:
        from delegation_client import _get_web3
        w3 = _get_web3()
        if not w3:
            result["details"] = "web3_unavailable"
            return result

        eth_price = 2000.0
        try:
            oracle_addr = "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7"
            oracle_abi = [{"inputs": [{"name": "asset", "type": "address"}], "name": "getAssetPrice",
                           "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"}]
            oracle = w3.eth.contract(address=w3.to_checksum_address(oracle_addr), abi=oracle_abi)
            eth_price = oracle.functions.getAssetPrice(w3.to_checksum_address(WETH_ADDRESS)).call() / 1e8
        except Exception:
            pass

        weth_amount = short_size_usd / eth_price

        weth_allowance = check_borrow_allowance(wallet_address, "WETH") if DELEGATION_AVAILABLE else 0
        if weth_allowance == 0:
            logger.warning(f"[Strategy] wallet={wallet_address[:10]}... WETH credit delegation missing (borrowAllowance=0). Skipping short entry — pending on-chain submission.")
            result["details"] = "WETH credit delegation not active (borrowAllowance=0). Pending on-chain submission."
            result["action"] = "SHORT_SKIPPED_NO_DELEGATION"
            return result

        _log_strategy(user_id, wallet_address, f"{tier}_short", "SHORT_ENTRY", live_hf,
                      details=f"Borrowing {weth_amount:.6f} WETH (${short_size_usd:.2f}) via delegation (allowance={weth_allowance})")

        tx_hash = delegated_borrow_weth(wallet_address, weth_amount)
        if not tx_hash:
            result["details"] = f"WETH borrow failed for {weth_amount:.6f}"
            result["action"] = "SHORT_ENTRY_FAILED"
            return result

        time.sleep(3)

        wbtc_weth = weth_amount * SHORT_WBTC_PCT
        usdt_weth = weth_amount * SHORT_USDT_PCT
        hold_weth = weth_amount * SHORT_WETH_PCT

        wbtc_weth_wei = int(wbtc_weth * 1e18)
        try:
            if not ensure_bot_dex_approval(WETH_ADDRESS, wbtc_weth_wei):
                raise Exception("BOT->DEX Router WETH approval failed")
            swap_result = uniswap.swap_weth_for_wbtc(wbtc_weth)
            if swap_result and swap_result.get('tx_hash'):
                time.sleep(3)
                from delegation_client import _get_bot_account, ERC20_ABI
                acct = _get_bot_account()
                wbtc_contract = w3.eth.contract(address=w3.to_checksum_address(WBTC_TOKEN_ADDRESS), abi=ERC20_ABI)
                wbtc_bal = wbtc_contract.functions.balanceOf(acct.address).call()
                if wbtc_bal > 0:
                    delegated_supply_wbtc_onbehalf(wallet_address, wbtc_bal / 1e8)
                    time.sleep(2)
            else:
                raise Exception("WETH->WBTC swap tx failed or reverted")
        except Exception as e:
            logger.error(f"[Short Entry] {wallet_address[:10]}... WBTC swap failed: {e}. Rolling back WETH to user.")
            _forward_tokens_to_user(WETH_ADDRESS, wbtc_weth_wei, wallet_address)

        usdt_weth_wei = int(usdt_weth * 1e18)
        try:
            if not ensure_bot_dex_approval(WETH_ADDRESS, usdt_weth_wei):
                raise Exception("BOT->DEX Router WETH approval failed")
            swap_result = uniswap.swap_weth_for_usdt(usdt_weth)
            if swap_result and swap_result.get('tx_hash'):
                time.sleep(3)
                from delegation_client import _get_bot_account, ERC20_ABI
                acct = _get_bot_account()
                usdt_contract = w3.eth.contract(address=w3.to_checksum_address(USDT_ADDRESS), abi=ERC20_ABI)
                usdt_bal = usdt_contract.functions.balanceOf(acct.address).call()
                if usdt_bal > 0:
                    delegated_supply_usdt_onbehalf(wallet_address, usdt_bal / 1e6)
                    time.sleep(2)
            else:
                raise Exception("WETH->USDT swap tx failed or reverted")
        except Exception as e:
            logger.error(f"[Short Entry] {wallet_address[:10]}... USDT swap failed: {e}. Rolling back WETH to user.")
            _forward_tokens_to_user(WETH_ADDRESS, usdt_weth_wei, wallet_address)

        delegated_supply_weth_onbehalf(wallet_address, hold_weth)
        time.sleep(2)

        result["executed"] = True
        result["action"] = "SHORT_ENTRY_OK"
        result["details"] = f"{tier} short: {weth_amount:.6f} WETH (${short_size_usd:.2f}), ETH@${eth_price:.2f}"

        if DB_AVAILABLE:
            database.record_wallet_action(
                user_id=user_id, wallet_address=wallet_address,
                action_type=f'strategy_{tier}_short_entry',
                details={"weth_borrowed": weth_amount, "eth_price": eth_price,
                         "short_size_usd": short_size_usd, "hf": live_hf},
                tx_hash=tx_hash)
            try:
                database.add_notification(
                    wallet_address=wallet_address,
                    title=f"{tier.capitalize()} Short Activated",
                    message=f"DEFENSE ACTIVATED: {tier.capitalize()} short executed due to market volatility. Borrowed {weth_amount:.6f} WETH (${short_size_usd:.2f})",
                    priority="warning",
                )
            except Exception:
                pass

        _log_strategy(user_id, wallet_address, f"{tier}_short", "SHORT_ENTRY_OK", live_hf,
                      details=result["details"])
        _record_strategy_action(user_id, wallet_address, f"SHORT ENTRY: {result['details']}")
        return result

    except Exception as e:
        logger.error(f"[Short Entry] {wallet_address[:10]}... failed: {e}", exc_info=True)
        result["details"] = f"Short entry exception: {e}"
        result["action"] = "SHORT_ENTRY_ERROR"
        return result


SHORT_CLOSE_WALLET_S_PCT = 0.20
SHORT_CLOSE_USDC_PCT = 0.20
SHORT_CLOSE_WBTC_PCT = 0.30
SHORT_CLOSE_WETH_PCT = 0.20
SHORT_CLOSE_USDT_PCT = 0.10


def _log_short_close_slice(wallet_address, slice_name, pct, status, amount_in_weth, amount_out_token=0.0, reason=""):
    import json as _json
    entry = {
        "event": "short_close_slice",
        "wallet": wallet_address,
        "slice": slice_name,
        "percent_of_profit": int(pct * 100),
        "status": status,
        "amount_in_weth": round(amount_in_weth, 8),
        "amount_out_token": round(amount_out_token, 8),
        "reason": reason
    }
    logger.info(_json.dumps(entry))
    return entry


def _log_short_close_residual(wallet_address, amount_in_weth, amount_out_eth=0.0, status="OK", reason=""):
    import json as _json
    entry = {
        "event": "short_close_residual_sweep",
        "wallet": wallet_address,
        "token_in": "WETH",
        "amount_in_weth": round(amount_in_weth, 8),
        "amount_out_eth": round(amount_out_eth, 8),
        "status": status,
        "reason": reason
    }
    logger.info(_json.dumps(entry))
    return entry


def _check_usdt_allowance_to_bot(wallet_address):
    if not DELEGATION_AVAILABLE:
        return 0
    try:
        from delegation_client import _get_web3, _get_bot_account, ERC20_ABI as _ERC20
        w3 = _get_web3()
        acct = _get_bot_account()
        if not w3 or not acct:
            return 0
        usdt_c = w3.eth.contract(address=w3.to_checksum_address(USDT_ADDRESS), abi=_ERC20)
        return usdt_c.functions.allowance(
            w3.to_checksum_address(wallet_address), acct.address
        ).call()
    except Exception as e:
        logger.warning(f"[USDT Allowance Check] {wallet_address[:10]}... error: {e}")
        return 0


def _execute_mock_short_close(user_id, wallet_address, agent, live_hf, open_short):
    tier = open_short.get('tier', 'unknown')
    short_id = open_short['id']
    weth_borrowed = float(open_short.get('weth_borrowed', 0))
    entry_collateral = float(open_short.get('entry_collateral', 0))

    usdt_allowance = _check_usdt_allowance_to_bot(wallet_address)
    usdt_approved = usdt_allowance > 0

    logger.info(
        f"🧪 [MOCK SHORT CLOSE] wallet={wallet_address[:10]}... tier={tier} "
        f"weth_borrowed={weth_borrowed:.6f} entry_collateral=${entry_collateral:.2f} | "
        f"USDT allowance_to_bot={usdt_allowance} ({'APPROVED' if usdt_approved else 'NOT APPROVED — Step 5 needed'}) | "
        f"SIMULATION_MODE=True — no on-chain tx executed")

    _log_strategy(user_id, wallet_address, "short_close", "MOCK_CLOSE", live_hf,
                  details=f"[SIM] {tier} short mock-closed. weth_borrowed={weth_borrowed:.6f}, "
                          f"usdt_approved={usdt_approved}. No on-chain tx.")

    close_details = {
        "reason": "mock_close_simulation",
        "tier": tier,
        "weth_borrowed": weth_borrowed,
        "usdt_allowance_to_bot": usdt_allowance,
        "usdt_approved": usdt_approved,
        "simulation": True,
    }
    _close_short_position(short_id, tx_hash_close=None, close_details=close_details)

    if DB_AVAILABLE:
        database.record_wallet_action(
            user_id=user_id, wallet_address=wallet_address,
            action_type='strategy_short_close_mock',
            details=close_details)

    result = {
        "mode": "short_close", "action": "MOCK_CLOSE_OK", "executed": True,
        "details": f"[SIM] {tier} short mock-closed. USDT approved={usdt_approved}",
    }
    _record_strategy_action(user_id, wallet_address, f"MOCK CLOSE: {tier} short (simulation)")
    return result


def _execute_delegated_short_close(user_id, wallet_address, agent, live_hf):
    """
    Delegated liability short close with 20/20/30/20/10 profit distribution.

    Phase 1 — Close the short:
      1. Withdraw USDT collateral from Aave via delegation
      2. Pull USDT from user wallet -> swap USDT->WETH
      3. Repay WETH debt via delegation
      4. Remaining WETH in bot wallet = realized profit P

    Phase 2 — Distribute profit P (WETH remaining after repay):
      20% → Wallet_S (swap WETH->DAI, transfer DAI to Wallet_S)
      20% → USDC    (swap WETH->USDC, transfer USDC to user wallet)
      30% → WBTC    (swap WETH->WBTC, supply to Aave onBehalfOf user)
      20% → WETH    (keep as WETH, supply to Aave onBehalfOf user)
      10% → USDT    (swap WETH->USDT, supply to Aave onBehalfOf user)

    Residual: Any leftover WETH (from rounding/slippage/failures) is swapped
    to ETH and sent to the user wallet as gas/safety net.

    Each slice executes independently (best-effort). If one slice fails,
    the others still proceed. Nurse Mode will sweep any stray tokens later.

    Personal bot uses a different split (20/20/60 Wallet_S/Wallet_B/collateral).
    """
    result = {"mode": "short_close", "action": "SHORT_CLOSE", "executed": False, "details": "",
              "distribution": {}}

    uniswap = _get_bot_uniswap()
    if not uniswap:
        result["details"] = "uniswap_unavailable"
        return result

    try:
        from delegation_client import _get_web3, _get_bot_account, ERC20_ABI
        w3 = _get_web3()
        acct = _get_bot_account()
        if not w3 or not acct:
            result["details"] = "web3_or_account_unavailable"
            return result

        user_balances = get_multi_token_balances(wallet_address)
        usdt_balance = user_balances.get("USDT", {}).get("balance", 0) if user_balances else 0

        if usdt_balance < 1.0:
            result["details"] = f"USDT balance too low ({usdt_balance:.2f}) for short close"
            return result

        _log_strategy(user_id, wallet_address, "short_close", "STEP1_WITHDRAW_USDT", live_hf,
                      details=f"Withdrawing {usdt_balance:.2f} USDT from Aave")
        withdraw_tx = delegated_withdraw_usdt(wallet_address, usdt_balance)
        if not withdraw_tx:
            result["details"] = "USDT withdrawal from Aave failed"
            result["action"] = "SHORT_CLOSE_FAILED"
            return result
        time.sleep(3)

        usdt_available_raw = int(usdt_balance * 1e6)
        from delegation_client import _get_bot_account, _get_web3, ERC20_ABI as _ERC20_ABI
        _w3_sc = _get_web3()
        _acct_sc = _get_bot_account()
        if _w3_sc and _acct_sc:
            _usdt_c = _w3_sc.eth.contract(address=_w3_sc.to_checksum_address(USDT_ADDRESS), abi=_ERC20_ABI)
            _user_allowance_to_bot = _usdt_c.functions.allowance(
                _w3_sc.to_checksum_address(wallet_address), _acct_sc.address
            ).call()
            if _user_allowance_to_bot < usdt_available_raw:
                logger.warning(f"[Short Close] {wallet_address[:10]}... GATED: user USDT allowance to bot is {_user_allowance_to_bot} "
                               f"< needed {usdt_available_raw}. pull_token_from_user would fail. "
                               f"USDT remains in user wallet after Aave withdraw. Skipping short-close swap.")
                result["details"] = f"Short-close gated: user has not approved USDT to bot wallet. USDT ({usdt_balance:.2f}) stays in user wallet."
                result["action"] = "SHORT_CLOSE_GATED"
                _record_strategy_action(user_id, wallet_address, f"GATED: short-close skipped, user USDT->bot allowance=0")
                return result
        pull_tx = pull_token_from_user(wallet_address, USDT_ADDRESS, usdt_available_raw)
        if not pull_tx:
            result["details"] = "USDT pull from user failed — USDT stays in user wallet"
            result["action"] = "SHORT_CLOSE_FAILED"
            return result
        time.sleep(2)

        _log_strategy(user_id, wallet_address, "short_close", "STEP2_SWAP_USDT_WETH", live_hf,
                      details=f"Swapping {usdt_balance:.2f} USDT -> WETH")
        if not ensure_bot_dex_approval(USDT_ADDRESS, usdt_available_raw):
            logger.error(f"[Short Close] {wallet_address[:10]}... BOT->DEX USDT approval failed. Rolling back USDT to user.")
            _forward_tokens_to_user(USDT_ADDRESS, usdt_available_raw, wallet_address)
            result["details"] = "BOT->DEX USDT approval failed — USDT returned to user"
            result["action"] = "SHORT_CLOSE_FAILED"
            return result
        swap_result = uniswap.swap_usdt_for_weth(usdt_balance * 0.95)
        if not swap_result or 'tx_hash' not in swap_result:
            logger.error(f"[Short Close] {wallet_address[:10]}... USDT->WETH swap failed. Rolling back USDT to user.")
            _forward_tokens_to_user(USDT_ADDRESS, usdt_available_raw, wallet_address)
            result["details"] = "USDT->WETH swap failed — USDT returned to user"
            result["action"] = "SHORT_CLOSE_FAILED"
            return result
        time.sleep(3)

        weth_contract = w3.eth.contract(address=w3.to_checksum_address(WETH_ADDRESS), abi=ERC20_ABI)
        weth_received_raw = weth_contract.functions.balanceOf(acct.address).call()
        weth_received = weth_received_raw / 1e18

        if weth_received < 0.0001:
            result["details"] = "WETH received from swap too low"
            result["action"] = "SHORT_CLOSE_FAILED"
            return result

        _log_strategy(user_id, wallet_address, "short_close", "STEP3_REPAY_WETH", live_hf,
                      details=f"Repaying {weth_received:.8f} WETH debt via delegation")

        from delegation_client import _ensure_bot_approval, AAVE_POOL_ADDRESS
        _ensure_bot_approval(WETH_ADDRESS, AAVE_POOL_ADDRESS, weth_received_raw)

        repay_tx = delegated_repay_weth(wallet_address, weth_received * 0.999)
        if not repay_tx:
            result["details"] = "WETH repayment failed — WETH in bot wallet for recovery"
            result["action"] = "SHORT_CLOSE_FAILED"
            return result
        time.sleep(3)

        profit_weth_raw = weth_contract.functions.balanceOf(acct.address).call()
        profit_weth = profit_weth_raw / 1e18

        if profit_weth < 0.00001:
            _log_strategy(user_id, wallet_address, "short_close", "NO_PROFIT", live_hf,
                          details=f"No profit after repay (remaining WETH={profit_weth:.8f})")
            post_data = get_user_account_data(wallet_address)
            post_hf = post_data.get("healthFactor", 0) if post_data else 0
            result["executed"] = True
            result["action"] = "SHORT_CLOSE_OK"
            result["details"] = f"Short closed, no profit. HF {live_hf:.2f} -> {post_hf:.2f}"
            _record_strategy_action(user_id, wallet_address, f"SHORT CLOSE: no profit, HF {live_hf:.2f} -> {post_hf:.2f}")
            return result

        _log_strategy(user_id, wallet_address, "short_close", "STEP4_DISTRIBUTE_PROFIT", live_hf,
                      details=f"Profit = {profit_weth:.8f} WETH — distributing 20/20/30/20/10")

        weth_wallet_s = profit_weth * SHORT_CLOSE_WALLET_S_PCT
        weth_usdc     = profit_weth * SHORT_CLOSE_USDC_PCT
        weth_wbtc     = profit_weth * SHORT_CLOSE_WBTC_PCT
        weth_aave     = profit_weth * SHORT_CLOSE_WETH_PCT
        weth_usdt     = profit_weth * SHORT_CLOSE_USDT_PCT

        dist_log = (f"P={profit_weth:.8f} WETH: "
                    f"20% Wallet_S={weth_wallet_s:.8f}, "
                    f"20% USDC={weth_usdc:.8f}, "
                    f"30% WBTC={weth_wbtc:.8f}, "
                    f"20% WETH(supply)={weth_aave:.8f}, "
                    f"10% USDT={weth_usdt:.8f}")
        logger.info(f"[Short Close] {wallet_address[:10]}... {dist_log}")

        dist_results = {"wallet_s": "pending", "usdc": "pending",
                        "wbtc": "pending", "weth_supply": "pending", "usdt": "pending"}
        slice_logs = []

        wallet_s = os.getenv('WALLET_S_ADDRESS', '').strip()
        if wallet_s and len(wallet_s) == 42 and weth_wallet_s >= 0.00001:
            _log_strategy(user_id, wallet_address, "short_close", "DIST_WALLET_S", live_hf,
                          details=f"Swap {weth_wallet_s:.8f} WETH -> DAI -> Wallet_S")
            try:
                ensure_bot_dex_approval(WETH_ADDRESS, int(weth_wallet_s * 1e18))
                swap_res = uniswap.swap_weth_for_dai(weth_wallet_s)
                if swap_res and swap_res.get('tx_hash'):
                    time.sleep(3)
                    dai_contract = w3.eth.contract(address=w3.to_checksum_address(DAI_ADDRESS), abi=ERC20_ABI)
                    dai_bal = dai_contract.functions.balanceOf(acct.address).call()
                    if dai_bal > 0:
                        xfer_tx = transfer_token_to_address(wallet_s, DAI_ADDRESS, dai_bal)
                        if xfer_tx:
                            dai_out = dai_bal / 1e18
                            dist_results["wallet_s"] = f"OK ({dai_out:.4f} DAI)"
                            slice_logs.append(_log_short_close_slice(wallet_address, "Wallet_S", SHORT_CLOSE_WALLET_S_PCT, "OK", weth_wallet_s, dai_out))
                            time.sleep(2)
                        else:
                            dist_results["wallet_s"] = "transfer_failed"
                            slice_logs.append(_log_short_close_slice(wallet_address, "Wallet_S", SHORT_CLOSE_WALLET_S_PCT, "FAILED", weth_wallet_s, reason="DAI transfer to Wallet_S failed"))
                    else:
                        dist_results["wallet_s"] = "swap_zero_output"
                        slice_logs.append(_log_short_close_slice(wallet_address, "Wallet_S", SHORT_CLOSE_WALLET_S_PCT, "FAILED", weth_wallet_s, reason="swap returned zero DAI"))
                else:
                    dist_results["wallet_s"] = "swap_failed"
                    slice_logs.append(_log_short_close_slice(wallet_address, "Wallet_S", SHORT_CLOSE_WALLET_S_PCT, "FAILED", weth_wallet_s, reason="WETH->DAI swap failed"))
            except Exception as e:
                dist_results["wallet_s"] = f"error: {e}"
                slice_logs.append(_log_short_close_slice(wallet_address, "Wallet_S", SHORT_CLOSE_WALLET_S_PCT, "FAILED", weth_wallet_s, reason=str(e)))
                logger.error(f"[Short Close] Wallet_S distribution failed: {e}")
        elif not wallet_s or len(wallet_s) != 42:
            dist_results["wallet_s"] = "WALLET_S_ADDRESS_not_set"
            slice_logs.append(_log_short_close_slice(wallet_address, "Wallet_S", SHORT_CLOSE_WALLET_S_PCT, "FAILED", weth_wallet_s, reason="WALLET_S_ADDRESS not configured"))
        else:
            dist_results["wallet_s"] = "amount_too_small"
            slice_logs.append(_log_short_close_slice(wallet_address, "Wallet_S", SHORT_CLOSE_WALLET_S_PCT, "OK", weth_wallet_s, reason="amount below threshold, skipped"))

        if weth_usdc >= 0.00001:
            _log_strategy(user_id, wallet_address, "short_close", "DIST_USDC", live_hf,
                          details=f"Swap {weth_usdc:.8f} WETH -> USDC -> user wallet")
            try:
                ensure_bot_dex_approval(WETH_ADDRESS, int(weth_usdc * 1e18))
                usdc_swap = uniswap.swap_tokens(WETH_ADDRESS, USDC_ADDRESS, weth_usdc, fee=500)
                if usdc_swap and usdc_swap.get('tx_hash'):
                    time.sleep(3)
                    usdc_contract = w3.eth.contract(address=w3.to_checksum_address(USDC_ADDRESS), abi=ERC20_ABI)
                    usdc_bal = usdc_contract.functions.balanceOf(acct.address).call()
                    if usdc_bal > 0:
                        xfer_tx = transfer_token_to_address(wallet_address, USDC_ADDRESS, usdc_bal)
                        if xfer_tx:
                            usdc_out = usdc_bal / 1e6
                            dist_results["usdc"] = f"OK ({usdc_out:.2f} USDC)"
                            slice_logs.append(_log_short_close_slice(wallet_address, "USDC", SHORT_CLOSE_USDC_PCT, "OK", weth_usdc, usdc_out))
                            time.sleep(2)
                        else:
                            dist_results["usdc"] = "transfer_failed"
                            slice_logs.append(_log_short_close_slice(wallet_address, "USDC", SHORT_CLOSE_USDC_PCT, "FAILED", weth_usdc, reason="USDC transfer to user wallet failed"))
                    else:
                        dist_results["usdc"] = "swap_zero_output"
                        slice_logs.append(_log_short_close_slice(wallet_address, "USDC", SHORT_CLOSE_USDC_PCT, "FAILED", weth_usdc, reason="swap returned zero USDC"))
                else:
                    dist_results["usdc"] = "swap_failed"
                    slice_logs.append(_log_short_close_slice(wallet_address, "USDC", SHORT_CLOSE_USDC_PCT, "FAILED", weth_usdc, reason="WETH->USDC swap failed"))
            except Exception as e:
                dist_results["usdc"] = f"error: {e}"
                slice_logs.append(_log_short_close_slice(wallet_address, "USDC", SHORT_CLOSE_USDC_PCT, "FAILED", weth_usdc, reason=str(e)))
                logger.error(f"[Short Close] USDC distribution failed: {e}")
        else:
            dist_results["usdc"] = "amount_too_small"
            slice_logs.append(_log_short_close_slice(wallet_address, "USDC", SHORT_CLOSE_USDC_PCT, "OK", weth_usdc, reason="amount below threshold, skipped"))

        if weth_wbtc >= 0.00001:
            _log_strategy(user_id, wallet_address, "short_close", "DIST_WBTC", live_hf,
                          details=f"Swap {weth_wbtc:.8f} WETH -> WBTC -> Aave supply onBehalfOf user")
            try:
                ensure_bot_dex_approval(WETH_ADDRESS, int(weth_wbtc * 1e18))
                wbtc_swap = uniswap.swap_weth_for_wbtc(weth_wbtc)
                if wbtc_swap and wbtc_swap.get('tx_hash'):
                    time.sleep(3)
                    wbtc_contract = w3.eth.contract(address=w3.to_checksum_address(WBTC_TOKEN_ADDRESS), abi=ERC20_ABI)
                    wbtc_bal = wbtc_contract.functions.balanceOf(acct.address).call()
                    if wbtc_bal > 0:
                        wbtc_float = wbtc_bal / 1e8
                        supply_tx = delegated_supply_wbtc_onbehalf(wallet_address, wbtc_float)
                        if supply_tx:
                            dist_results["wbtc"] = f"OK ({wbtc_float:.8f} WBTC supplied)"
                            slice_logs.append(_log_short_close_slice(wallet_address, "WBTC", SHORT_CLOSE_WBTC_PCT, "OK", weth_wbtc, wbtc_float))
                            time.sleep(2)
                        else:
                            dist_results["wbtc"] = "aave_supply_failed"
                            slice_logs.append(_log_short_close_slice(wallet_address, "WBTC", SHORT_CLOSE_WBTC_PCT, "FAILED", weth_wbtc, wbtc_float, reason="Aave supply onBehalfOf failed"))
                    else:
                        dist_results["wbtc"] = "swap_zero_output"
                        slice_logs.append(_log_short_close_slice(wallet_address, "WBTC", SHORT_CLOSE_WBTC_PCT, "FAILED", weth_wbtc, reason="swap returned zero WBTC"))
                else:
                    dist_results["wbtc"] = "swap_failed"
                    slice_logs.append(_log_short_close_slice(wallet_address, "WBTC", SHORT_CLOSE_WBTC_PCT, "FAILED", weth_wbtc, reason="WETH->WBTC swap failed"))
            except Exception as e:
                dist_results["wbtc"] = f"error: {e}"
                slice_logs.append(_log_short_close_slice(wallet_address, "WBTC", SHORT_CLOSE_WBTC_PCT, "FAILED", weth_wbtc, reason=str(e)))
                logger.error(f"[Short Close] WBTC distribution failed: {e}")
        else:
            dist_results["wbtc"] = "amount_too_small"
            slice_logs.append(_log_short_close_slice(wallet_address, "WBTC", SHORT_CLOSE_WBTC_PCT, "OK", weth_wbtc, reason="amount below threshold, skipped"))

        if weth_aave >= 0.00001:
            _log_strategy(user_id, wallet_address, "short_close", "DIST_WETH_SUPPLY", live_hf,
                          details=f"Supply {weth_aave:.8f} WETH to Aave onBehalfOf user")
            try:
                supply_tx = delegated_supply_weth_onbehalf(wallet_address, weth_aave)
                if supply_tx:
                    dist_results["weth_supply"] = f"OK ({weth_aave:.8f} WETH supplied)"
                    slice_logs.append(_log_short_close_slice(wallet_address, "WETH", SHORT_CLOSE_WETH_PCT, "OK", weth_aave, weth_aave))
                    time.sleep(2)
                else:
                    dist_results["weth_supply"] = "aave_supply_failed"
                    slice_logs.append(_log_short_close_slice(wallet_address, "WETH", SHORT_CLOSE_WETH_PCT, "FAILED", weth_aave, reason="Aave supply WETH onBehalfOf failed"))
            except Exception as e:
                dist_results["weth_supply"] = f"error: {e}"
                slice_logs.append(_log_short_close_slice(wallet_address, "WETH", SHORT_CLOSE_WETH_PCT, "FAILED", weth_aave, reason=str(e)))
                logger.error(f"[Short Close] WETH supply distribution failed: {e}")
        else:
            dist_results["weth_supply"] = "amount_too_small"
            slice_logs.append(_log_short_close_slice(wallet_address, "WETH", SHORT_CLOSE_WETH_PCT, "OK", weth_aave, reason="amount below threshold, skipped"))

        if weth_usdt >= 0.00001:
            _log_strategy(user_id, wallet_address, "short_close", "DIST_USDT", live_hf,
                          details=f"Swap {weth_usdt:.8f} WETH -> USDT -> Aave supply onBehalfOf user")
            try:
                ensure_bot_dex_approval(WETH_ADDRESS, int(weth_usdt * 1e18))
                usdt_swap = uniswap.swap_weth_for_usdt(weth_usdt)
                if usdt_swap and usdt_swap.get('tx_hash'):
                    time.sleep(3)
                    usdt_contract = w3.eth.contract(address=w3.to_checksum_address(USDT_ADDRESS), abi=ERC20_ABI)
                    usdt_bal = usdt_contract.functions.balanceOf(acct.address).call()
                    if usdt_bal > 0:
                        usdt_float = usdt_bal / 1e6
                        supply_tx = delegated_supply_usdt_onbehalf(wallet_address, usdt_float)
                        if supply_tx:
                            dist_results["usdt"] = f"OK ({usdt_float:.2f} USDT supplied)"
                            slice_logs.append(_log_short_close_slice(wallet_address, "USDT", SHORT_CLOSE_USDT_PCT, "OK", weth_usdt, usdt_float))
                            time.sleep(2)
                        else:
                            dist_results["usdt"] = "aave_supply_failed"
                            slice_logs.append(_log_short_close_slice(wallet_address, "USDT", SHORT_CLOSE_USDT_PCT, "FAILED", weth_usdt, usdt_float, reason="Aave supply USDT onBehalfOf failed"))
                    else:
                        dist_results["usdt"] = "swap_zero_output"
                        slice_logs.append(_log_short_close_slice(wallet_address, "USDT", SHORT_CLOSE_USDT_PCT, "FAILED", weth_usdt, reason="swap returned zero USDT"))
                else:
                    dist_results["usdt"] = "swap_failed"
                    slice_logs.append(_log_short_close_slice(wallet_address, "USDT", SHORT_CLOSE_USDT_PCT, "FAILED", weth_usdt, reason="WETH->USDT swap failed"))
            except Exception as e:
                dist_results["usdt"] = f"error: {e}"
                slice_logs.append(_log_short_close_slice(wallet_address, "USDT", SHORT_CLOSE_USDT_PCT, "FAILED", weth_usdt, reason=str(e)))
                logger.error(f"[Short Close] USDT distribution failed: {e}")
        else:
            dist_results["usdt"] = "amount_too_small"
            slice_logs.append(_log_short_close_slice(wallet_address, "USDT", SHORT_CLOSE_USDT_PCT, "OK", weth_usdt, reason="amount below threshold, skipped"))

        ok_count = sum(1 for v in dist_results.values() if v.startswith("OK"))
        fail_count = sum(1 for v in dist_results.values() if not v.startswith("OK") and v != "amount_too_small")

        bot_leftover_weth_raw = weth_contract.functions.balanceOf(acct.address).call()
        bot_leftover_weth = bot_leftover_weth_raw / 1e18
        if bot_leftover_weth_raw > 0:
            try:
                xfer_tx = transfer_token_to_address(wallet_address, WETH_ADDRESS, bot_leftover_weth_raw)
                if xfer_tx:
                    _log_short_close_residual(wallet_address, bot_leftover_weth, bot_leftover_weth, status="OK")
                else:
                    _log_short_close_residual(wallet_address, bot_leftover_weth, status="FAILED", reason="WETH transfer to user wallet failed")
            except Exception as e:
                _log_short_close_residual(wallet_address, bot_leftover_weth, status="FAILED", reason=str(e))
                logger.error(f"[Short Close] Residual WETH sweep failed: {e}")

        post_data = get_user_account_data(wallet_address)
        post_hf = post_data.get("healthFactor", 0) if post_data else 0

        dist_summary = ", ".join([f"{k}={v}" for k, v in dist_results.items()])
        detail_str = (f"Profit {profit_weth:.8f} WETH distributed 20/20/30/20/10. "
                     f"{ok_count}/5 OK. HF {live_hf:.2f} -> {post_hf:.2f}. {dist_summary}")

        result["executed"] = True
        result["action"] = "SHORT_CLOSE_OK" if fail_count == 0 else "SHORT_CLOSE_PARTIAL"
        result["details"] = detail_str
        result["distribution"] = dist_results

        if DB_AVAILABLE:
            try:
                database.add_notification(
                    wallet_address=wallet_address,
                    title="Short Position Closed",
                    message=f"Short position closed: {detail_str}",
                    priority="info" if fail_count == 0 else "warning",
                )
            except Exception:
                pass

        _log_strategy(user_id, wallet_address, "short_close", result["action"], live_hf,
                      hf_after=post_hf,
                      details=f"20/20/30/20/10 split: {dist_summary}")
        _record_strategy_action(user_id, wallet_address,
                               f"SHORT CLOSE: profit={profit_weth:.8f} WETH, {ok_count}/5 dist OK, HF {live_hf:.2f} -> {post_hf:.2f}")

        if DB_AVAILABLE:
            database.record_wallet_action(
                user_id=user_id, wallet_address=wallet_address,
                action_type='strategy_short_close',
                details={"hf_before": live_hf, "hf_after": post_hf,
                         "profit_weth": profit_weth,
                         "split": "20/20/30/20/10",
                         "wallet_s_pct": 0.20, "usdc_pct": 0.20,
                         "wbtc_pct": 0.30, "weth_supply_pct": 0.20, "usdt_pct": 0.10,
                         "distribution_results": dist_results,
                         "slice_logs": slice_logs,
                         "residual_weth": bot_leftover_weth,
                         "note": "20% Wallet_S(DAI), 20% USDC(wallet), 30% WBTC(supplied), 20% WETH(supplied), 10% USDT(supplied)"},
                tx_hash=repay_tx)

        return result

    except Exception as e:
        logger.error(f"[Short Close] {wallet_address[:10]}... failed: {e}", exc_info=True)
        result["details"] = f"Short close exception: {e}"
        result["action"] = "SHORT_CLOSE_ERROR"
        return result


def run_delegated_nurse_sweep(user_id, wallet_address, agent):
    """
    Nurse Mode for delegated wallets.
    Reads user wallet balances for DAI/WETH/WBTC/USDT.
    Skips below $2 floor. NEVER touches USDC.
    Pulls via transferFrom -> supplies to Aave onBehalfOf user.

    IMPORTANT: Nurse must NOT sweep tokens if an active distribution is in progress.
    DAI is also skipped if the user has outstanding DAI debt, because that DAI
    likely came from a borrow and should go through the swap pipeline instead.
    """
    result = {"swept": False, "tokens_swept": [], "details": ""}

    if not DELEGATION_AVAILABLE:
        result["details"] = "delegation_client_unavailable"
        return result

    if has_active_distribution(wallet_address):
        result["details"] = "skipped_active_distribution"
        logger.info(f"[Nurse] {wallet_address[:10]}... SKIPPED — active distribution in progress, Nurse must not interfere")
        return result

    try:
        balances = get_multi_token_balances(wallet_address)
        if not balances:
            result["details"] = "Could not fetch user wallet balances"
            return result

        HARD_FLOOR_USD = 2.00

        from delegation_client import _get_web3
        w3 = _get_web3()
        eth_price = 2000.0
        btc_price = 67000.0
        if w3:
            try:
                oracle_addr = "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7"
                oracle_abi = [{"inputs": [{"name": "asset", "type": "address"}], "name": "getAssetPrice",
                               "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"}]
                oracle = w3.eth.contract(address=w3.to_checksum_address(oracle_addr), abi=oracle_abi)
                eth_price = oracle.functions.getAssetPrice(w3.to_checksum_address(WETH_ADDRESS)).call() / 1e8
                btc_price = oracle.functions.getAssetPrice(w3.to_checksum_address(WBTC_TOKEN_ADDRESS)).call() / 1e8
            except Exception:
                pass

        user_has_dai_debt = False
        try:
            dai_debt = _get_dai_debt_balance(wallet_address)
            if dai_debt >= 1.0:
                user_has_dai_debt = True
                logger.debug(f"[Nurse] {wallet_address[:10]}... DAI-specific debt: ${dai_debt:.2f}")
        except Exception:
            pass

        sweep_tokens = {
            "DAI": {"address": DAI_ADDRESS, "price": 1.0, "decimals": 18,
                    "supply_fn": delegated_supply_dai_onbehalf},
            "WETH": {"address": WETH_ADDRESS, "price": eth_price, "decimals": 18,
                     "supply_fn": delegated_supply_weth_onbehalf},
            "WBTC": {"address": WBTC_TOKEN_ADDRESS, "price": btc_price, "decimals": 8,
                     "supply_fn": delegated_supply_wbtc_onbehalf},
            "USDT": {"address": USDT_ADDRESS, "price": 1.0, "decimals": 6,
                     "supply_fn": delegated_supply_usdt_onbehalf},
        }

        GAS_REIMBURSEMENT_PCT = 0.02
        GAS_REIMBURSEMENT_MIN_USD = 5.00
        gas_reimbursed_total_usd = 0.0

        for token_name, config in sweep_tokens.items():
            if token_name == "DAI" and user_has_dai_debt:
                dai_data = balances.get("DAI", {})
                dai_bal = dai_data.get("balance", 0)
                if dai_bal > 0:
                    logger.info(f"[Nurse] {wallet_address[:10]}... DAI ${dai_bal:.2f} SKIPPED — user has DAI debt, DAI should go through swap pipeline")
                continue
            token_data = balances.get(token_name, {})
            balance = token_data.get("balance", 0)
            balance_raw = token_data.get("balance_raw", 0)
            usd_value = balance * config["price"]

            if balance <= 0 or balance_raw <= 0:
                continue

            if usd_value < HARD_FLOOR_USD:
                logger.info(f"[Nurse] {wallet_address[:10]}... {token_name} ${usd_value:.2f} below $2 floor — skip")
                continue

            logger.info(f"[Nurse] {wallet_address[:10]}... sweeping {balance:.8f} {token_name} (${usd_value:.2f})")

            reimbursement_raw = 0
            reimbursement_usd = usd_value * GAS_REIMBURSEMENT_PCT
            if reimbursement_usd >= GAS_REIMBURSEMENT_MIN_USD:
                reimbursement_raw = int(balance_raw * GAS_REIMBURSEMENT_PCT)
                try:
                    from delegation_client import _get_bot_account, _get_web3, ERC20_ABI as _ERC20_ABI_NR
                    _w3_nr = _get_web3()
                    _acct_nr = _get_bot_account()
                    _tok_nr = _w3_nr.eth.contract(address=_w3_nr.to_checksum_address(config["address"]), abi=_ERC20_ABI_NR)
                    _nr_allowance = _tok_nr.functions.allowance(
                        _w3_nr.to_checksum_address(wallet_address), _acct_nr.address
                    ).call()
                    if _nr_allowance < reimbursement_raw:
                        needed_amount = reimbursement_raw
                        reimbursement_raw = 0
                        logger.info(f"[GasReimburse] {wallet_address[:10]}... {token_name} GATED: user->bot allowance {_nr_allowance} < needed {needed_amount}. Supplying full amount to Aave instead.")
                except Exception as _nr_err:
                    reimbursement_raw = 0
                    logger.warning(f"[GasReimburse] {wallet_address[:10]}... {token_name} allowance check error: {_nr_err}. Supplying full amount.")
                if reimbursement_raw > 0:
                    pull_tx = pull_token_from_user(wallet_address, config["address"], reimbursement_raw)
                    if pull_tx:
                        gas_reimbursed_total_usd += reimbursement_usd
                        logger.info(f"[GasReimburse] {wallet_address[:10]}... {token_name} ${reimbursement_usd:.2f} (2%) -> bot operator | tx={pull_tx[:16]}...")
                    else:
                        reimbursement_raw = 0
                        logger.warning(f"[GasReimburse] {wallet_address[:10]}... {token_name} pull failed, supplying full amount")
                    time.sleep(1)

            supply_raw = int((balance_raw - reimbursement_raw) * 0.99)
            supply_tx = dm_execute_supply(wallet_address, config["address"], supply_raw)
            if supply_tx:
                result["swept"] = True
                result["tokens_swept"].append(f"{token_name}(${usd_value:.2f})")
                logger.info(f"[Nurse] {wallet_address[:10]}... {token_name} supplied to Aave via DM executeSupply")
                time.sleep(2)
            else:
                logger.warning(f"[Nurse] {wallet_address[:10]}... {token_name} DM executeSupply failed")

        usdc_data = balances.get("USDC", {})
        usdc_balance = usdc_data.get("balance", 0)
        if usdc_balance > 0:
            logger.info(f"[Nurse] {wallet_address[:10]}... USDC ${usdc_balance:.2f} — PROFIT TOKEN, never swept")

        if result["swept"]:
            gas_note = f", gas_reimburse=${gas_reimbursed_total_usd:.2f}" if gas_reimbursed_total_usd > 0 else ""
            result["details"] = f"Swept: {', '.join(result['tokens_swept'])}{gas_note}"
            result["gas_reimbursed_usd"] = gas_reimbursed_total_usd

            if DB_AVAILABLE:
                try:
                    database.add_notification(
                        wallet_address=wallet_address,
                        title="Nurse Sweep Complete",
                        message=f"Nurse sweep completed: {result['details']}",
                        priority="info",
                    )
                except Exception:
                    pass
        else:
            result["details"] = "No tokens above $2 floor to sweep"
            result["gas_reimbursed_usd"] = 0.0

        return result

    except Exception as e:
        logger.error(f"[Nurse] {wallet_address[:10]}... sweep failed: {e}", exc_info=True)
        result["details"] = f"Nurse sweep exception: {e}"
        return result


def run_delegated_strategy(user_id, wallet_address, agent, run_id, iteration, config):
    """
    Run the strategy engine for a single delegated wallet.
    Returns a dict: {"mode": str, "action": str, "executed": bool, "details": str}

    Priority order: Emergency > Growth (6-step) > Capacity (6-step) > Macro Short > Micro Short > Idle/Skip
    One action per call. Never multiple conflicting actions.

    USER WALLET: No Profit Bucket. Short profits stay 100% in user wallet.
    """
    result = {"mode": "idle", "action": "SKIP", "executed": False, "details": ""}

    if not DB_AVAILABLE:
        result["details"] = "database_unavailable"
        return result

    if not DELEGATION_AVAILABLE:
        result["details"] = "delegation_client_unavailable"
        return result

    position = database.get_defi_position(user_id, wallet_address)
    if not position or not position.get('has_active_position', False):
        result["details"] = "no_active_position"
        _log_strategy(user_id, wallet_address, "idle", "SKIP", 0, details="no active position")
        _record_strategy_action(user_id, wallet_address, "SKIP: no active position")
        return result

    hf = float(position.get('health_factor', 0))
    collateral_usd = float(position.get('total_collateral_usd', 0))
    debt_usd = float(position.get('total_debt_usd', 0))

    perms = get_delegation_permissions(wallet_address)
    if not perms.get("isActive"):
        result["details"] = "delegation_not_active_on_chain"
        _log_strategy(user_id, wallet_address, "idle", "SKIP", hf, details="delegation not active on-chain")
        _record_strategy_action(user_id, wallet_address, "SKIP: delegation not active on-chain")
        return result

    if PERMISSIONS_AVAILABLE:
        validation = validate_full_automation(perms)
        if not validation["valid"]:
            missing = validation["missing_flags"]
            result["mode"] = "error_permissions"
            result["action"] = "SKIP"
            result["details"] = f"Permission misconfiguration: {validation['details']}"
            _log_strategy(user_id, wallet_address, "error_permissions", "SKIP", hf,
                          details=f"PERMISSION ERROR: {validation['details']} — wallet marked misconfigured")
            _record_strategy_action(user_id, wallet_address, f"ERROR: permission misconfiguration — missing: {', '.join(missing)}")
            if DB_AVAILABLE:
                database.update_strategy_status_field(user_id, wallet_address, 'error_permissions')
            return result
    else:
        can_borrow = perms.get("allowBorrow", False)
        can_supply = perms.get("allowSupply", False)
        can_repay = perms.get("allowRepay", False)
        can_withdraw = perms.get("allowWithdraw", False)
        missing = []
        if not can_supply: missing.append("allowSupply")
        if not can_borrow: missing.append("allowBorrow")
        if not can_repay: missing.append("allowRepay")
        if not can_withdraw: missing.append("allowWithdraw")
        if missing:
            result["mode"] = "error_permissions"
            result["action"] = "SKIP"
            result["details"] = f"Permission misconfiguration: missing {', '.join(missing)}"
            _log_strategy(user_id, wallet_address, "error_permissions", "SKIP", hf,
                          details=f"PERMISSION ERROR: missing {', '.join(missing)} — wallet marked misconfigured")
            _record_strategy_action(user_id, wallet_address, f"ERROR: permission misconfiguration — missing: {', '.join(missing)}")
            if DB_AVAILABLE:
                database.update_strategy_status_field(user_id, wallet_address, 'error_permissions')
            return result

    try:
        logger.info(f"[Strategy] {wallet_address[:10]}... bootstrapping bot DEX approvals for all 5 tokens before strategy execution")
        dex_ok = ensure_bot_dex_approvals_all_tokens()
        if not dex_ok:
            result["details"] = "bot_dex_approval_bootstrap_failed"
            _log_strategy(user_id, wallet_address, "idle", "SKIP", hf, details="Failed to bootstrap bot DEX approvals for all 5 tokens")
            _record_strategy_action(user_id, wallet_address, "SKIP: bot DEX approval bootstrap failed")
            return result
    except Exception as bootstrap_err:
        logger.error(f"[Strategy] {wallet_address[:10]}... DEX approval bootstrap error: {bootstrap_err}")

    live_data = get_user_account_data(wallet_address)
    if not live_data:
        result["details"] = "aave_data_fetch_failed"
        _log_strategy(user_id, wallet_address, "idle", "SKIP", hf, details="could not fetch live Aave data")
        _record_strategy_action(user_id, wallet_address, "SKIP: Aave data fetch failed")
        return result

    available_borrows = live_data.get("availableBorrowsUSD", 0)
    live_hf = live_data.get("healthFactor", hf)
    live_collateral_now = live_data.get("totalCollateralUSD", collateral_usd)

    snap_count = 0
    vel_drop = 0.0
    if DB_AVAILABLE:
        snap_count = len(database.get_collateral_snapshots(wallet_address, MACRO_VELOCITY_WINDOW_MIN))
        vel_drop, _, _ = _compute_velocity_drop(wallet_address, MACRO_VELOCITY_WINDOW_MIN)
    open_short_now = _get_open_short(wallet_address)
    logger.info(
        f"📡 [SIM STATUS] wallet={wallet_address[:10]}... HF={live_hf:.4f} | "
        f"collateral=${live_collateral_now:.2f} | debt=${debt_usd:.2f} | "
        f"avail_borrow=${available_borrows:.2f} | velocity_drop=${vel_drop:.2f} in {MACRO_VELOCITY_WINDOW_MIN}min "
        f"({snap_count} snaps) | open_short={'YES '+open_short_now['tier'] if open_short_now else 'NONE'} | "
        f"thresholds: macro>=${MACRO_VELOCITY_DROP_USD} micro>={MICRO_VELOCITY_DROP_USD}")

    if live_hf < EMERGENCY_HF_THRESHOLD:
        result["mode"] = "emergency"
        result["action"] = "SKIP_HF_EMERGENCY"
        result["details"] = f"HF {live_hf:.4f} below emergency threshold {EMERGENCY_HF_THRESHOLD}"
        _log_strategy(user_id, wallet_address, "emergency", "ALERT", live_hf,
                      details=f"HF critically low! Collateral=${collateral_usd:.2f}, Debt=${debt_usd:.2f}")
        _record_strategy_action(user_id, wallet_address, f"ALERT: HF {live_hf:.4f} critically low")
        if DB_AVAILABLE:
            database.record_wallet_action_v2(user_id, wallet_address, "SKIP_HF_EMERGENCY",
                {"hf": live_hf, "threshold": EMERGENCY_HF_THRESHOLD},
                details_summary=f"All strategies skipped: HF critically low (HF={live_hf:.4f})",
                severity="critical")
        return result

    open_short = _get_open_short(wallet_address)
    if open_short:
        from datetime import datetime, timezone
        entry_time = open_short['entry_time']
        if hasattr(entry_time, 'tzinfo') and entry_time.tzinfo is None:
            entry_time = entry_time.replace(tzinfo=timezone.utc)
        age_minutes = (datetime.now(timezone.utc) - entry_time).total_seconds() / 60.0
        entry_collateral = float(open_short.get('entry_collateral', 0))
        live_collateral = live_data.get("totalCollateralUSD", collateral_usd)
        tier = open_short['tier']
        short_id = open_short['id']

        collateral_recovered = live_collateral >= entry_collateral
        hold_expired = age_minutes >= MAX_SHORT_HOLD_MINUTES

        logger.info(f"📊 [SHORT MONITOR] wallet={wallet_address[:10]}... tier={tier} age={age_minutes:.1f}min "
                     f"entry_collateral=${entry_collateral:.2f} current=${live_collateral:.2f} "
                     f"recovered={collateral_recovered} hold_expired={hold_expired} (max={MAX_SHORT_HOLD_MINUTES}min)")

        if collateral_recovered or hold_expired:
            close_reason = "collateral_recovered" if collateral_recovered else f"hold_expired_{age_minutes:.0f}min"
            logger.info(f"🔻 [SHORT CLOSE TRIGGER] wallet={wallet_address[:10]}... reason={close_reason}")
            _log_strategy(user_id, wallet_address, "short_close", "TRIGGER", live_hf,
                          details=f"Closing {tier} short: {close_reason}. Entry=${entry_collateral:.2f}, Current=${live_collateral:.2f}, Age={age_minutes:.1f}min")

            if SIMULATION_MODE:
                close_result = _execute_mock_short_close(user_id, wallet_address, agent, live_hf, open_short)
            else:
                close_result = _execute_delegated_short_close(user_id, wallet_address, agent, live_hf)

                close_details_data = {
                    "reason": close_reason,
                    "age_minutes": round(age_minutes, 1),
                    "entry_collateral": entry_collateral,
                    "close_collateral": live_collateral,
                    "close_hf": live_hf,
                    "close_action": close_result.get("action", "UNKNOWN"),
                }
                _close_short_position(short_id, close_result.get("tx_hash"), close_details_data)

            logger.info(f"✅ [SHORT CLOSED] wallet={wallet_address[:10]}... action={close_result.get('action')} "
                         f"details={close_result.get('details', '')}")
            return close_result
        else:
            logger.info(f"⏳ [SHORT HOLD] wallet={wallet_address[:10]}... {tier} short still open, "
                         f"waiting for recovery or timeout ({MAX_SHORT_HOLD_MINUTES - age_minutes:.1f}min remaining)")
            result["mode"] = f"{tier}_short_hold"
            result["action"] = "HOLDING"
            result["details"] = (f"{tier} short open {age_minutes:.1f}min. "
                                  f"Entry=${entry_collateral:.2f}, Current=${live_collateral:.2f}. "
                                  f"Closes on recovery or after {MAX_SHORT_HOLD_MINUTES}min")
            _log_strategy(user_id, wallet_address, f"{tier}_short_hold", "HOLDING", live_hf, details=result["details"])
            _record_strategy_action(user_id, wallet_address, f"HOLDING: {tier} short open {age_minutes:.1f}min")
            return result

    baseline = _get_wallet_baseline(user_id, wallet_address)
    if baseline <= 0:
        baseline = collateral_usd
        _update_wallet_baseline(user_id, wallet_address, baseline)

    absolute_growth = collateral_usd - baseline
    relative_growth = (absolute_growth / baseline) if baseline > 0 else 0

    growth_met = (
        live_hf >= GROWTH_HF_THRESHOLD and
        available_borrows >= GROWTH_MIN_CAPACITY_USD and
        (absolute_growth >= GROWTH_ABSOLUTE_TRIGGER_USD or relative_growth >= GROWTH_RELATIVE_TRIGGER_PCT)
    )

    if live_hf < GROWTH_HF_THRESHOLD and DB_AVAILABLE and (
            absolute_growth >= GROWTH_ABSOLUTE_TRIGGER_USD or relative_growth >= GROWTH_RELATIVE_TRIGGER_PCT):
        database.record_wallet_action_v2(user_id, wallet_address, "SKIP_HF_BELOW_MIN",
            {"hf": live_hf, "path_min_hf": GROWTH_HF_THRESHOLD, "strategy": "growth"},
            details_summary=f"Skipped GROWTH: HF below path minimum (HF={live_hf:.4f}, min={GROWTH_HF_THRESHOLD:.2f})",
            severity="warning")

    if growth_met:
        cooldown_ok, cooldown_remaining = _check_borrow_cooldown(wallet_address)
        if not cooldown_ok:
            result["mode"] = "growth"
            result["action"] = "SKIP"
            result["details"] = f"growth triggered but borrow cooldown active ({cooldown_remaining:.0f}s remaining)"
            _log_strategy(user_id, wallet_address, "growth", "SKIP", live_hf,
                          details=f"borrow cooldown: {cooldown_remaining:.0f}s remaining")
            _record_strategy_action(user_id, wallet_address, f"SKIP: growth cooldown ({cooldown_remaining:.0f}s)")
            return result

        borrow_amount = min(GROWTH_BORROW_USD, available_borrows * 0.9)
        if borrow_amount < 1.0:
            result["mode"] = "growth"
            result["action"] = "SKIP"
            result["details"] = f"growth triggered but borrow amount too small (${borrow_amount:.2f})"
            _log_strategy(user_id, wallet_address, "growth", "SKIP", live_hf,
                          details=f"borrow amount ${borrow_amount:.2f} too small")
            _record_strategy_action(user_id, wallet_address, f"SKIP: growth borrow too small (${borrow_amount:.2f})")
            return result

        result = _execute_delegated_distribution(user_id, wallet_address, agent, "growth", GROWTH_DISTRIBUTION, live_hf, path_min_hf=GROWTH_HF_THRESHOLD)
        if result.get("executed"):
            _update_wallet_baseline(user_id, wallet_address, collateral_usd)
        return result

    capacity_met = (
        live_hf >= CAPACITY_HF_THRESHOLD and
        available_borrows >= CAPACITY_MIN_CAPACITY_USD
    )

    if capacity_met:
        cooldown_ok, cooldown_remaining = _check_borrow_cooldown(wallet_address)
        if not cooldown_ok:
            result["mode"] = "capacity"
            result["action"] = "SKIP"
            result["details"] = f"capacity triggered but borrow cooldown active ({cooldown_remaining:.0f}s remaining)"
            _log_strategy(user_id, wallet_address, "capacity", "SKIP", live_hf,
                          details=f"borrow cooldown: {cooldown_remaining:.0f}s remaining")
            _record_strategy_action(user_id, wallet_address, f"SKIP: capacity cooldown ({cooldown_remaining:.0f}s)")
            return result

        borrow_amount = min(CAPACITY_BORROW_USD, available_borrows * 0.9)
        if borrow_amount < 1.0:
            result["mode"] = "capacity"
            result["action"] = "SKIP"
            result["details"] = f"capacity triggered but borrow amount too small (${borrow_amount:.2f})"
            _log_strategy(user_id, wallet_address, "capacity", "SKIP", live_hf,
                          details=f"borrow amount ${borrow_amount:.2f} too small")
            _record_strategy_action(user_id, wallet_address, f"SKIP: capacity borrow too small (${borrow_amount:.2f})")
            return result

        result = _execute_delegated_distribution(user_id, wallet_address, agent, "capacity", CAPACITY_DISTRIBUTION, live_hf, path_min_hf=CAPACITY_HF_THRESHOLD)
        return result

    macro_drop, macro_latest, macro_count = _compute_velocity_drop(wallet_address, MACRO_VELOCITY_WINDOW_MIN)
    micro_drop, micro_latest, micro_count = _compute_velocity_drop(wallet_address, MICRO_VELOCITY_WINDOW_MIN)

    logger.info(f"📉 [VELOCITY] wallet={wallet_address[:10]}... "
                f"macro_drop=${macro_drop:.2f}/{MACRO_VELOCITY_DROP_USD} in {MACRO_VELOCITY_WINDOW_MIN}min ({macro_count} snapshots) | "
                f"micro_drop=${micro_drop:.2f}/{MICRO_VELOCITY_DROP_USD} in {MICRO_VELOCITY_WINDOW_MIN}min ({micro_count} snapshots)")

    macro_triggered = (
        macro_drop >= MACRO_VELOCITY_DROP_USD and
        live_hf >= MACRO_HF_THRESHOLD and
        macro_count >= 2
    )

    if macro_triggered:
        logger.info(f"🚨 [MACRO SHORT TRIGGER] wallet={wallet_address[:10]}... "
                     f"drop=${macro_drop:.2f} >= ${MACRO_VELOCITY_DROP_USD} | HF={live_hf:.2f} >= {MACRO_HF_THRESHOLD}")
        _log_strategy(user_id, wallet_address, "macro_short", "TRIGGER", live_hf,
                      details=f"Collateral dropped ${macro_drop:.2f} in {MACRO_VELOCITY_WINDOW_MIN}min. Entering macro short hedge (${MACRO_SHORT_SIZE_USD})")

        if SIMULATION_MODE:
            entry_result = _execute_mock_short_entry(user_id, wallet_address, "macro", MACRO_SHORT_SIZE_USD, live_hf, macro_latest + macro_drop)
        else:
            entry_result = _execute_delegated_short_entry(user_id, wallet_address, agent, "macro", MACRO_SHORT_SIZE_USD, live_hf)
        if entry_result.get("executed"):
            _save_short_position(user_id, wallet_address, "macro",
                                 MACRO_SHORT_SIZE_USD / 2000.0,
                                 macro_latest + macro_drop,
                                 live_hf, entry_result.get("tx_hash"))
            logger.info(f"✅ [MACRO SHORT OPEN] wallet={wallet_address[:10]}... entry_collateral=${macro_latest + macro_drop:.2f}")
            if DB_AVAILABLE:
                database.record_wallet_action_v2(user_id, wallet_address, "MACRO_SHORT_ENTRY",
                    {"hf": live_hf, "drop_usd": macro_drop, "size_usd": MACRO_SHORT_SIZE_USD},
                    tx_hash=entry_result.get("tx_hash"),
                    details_summary="[SHIELD DEPLOYED] Macro hedge opened to defend HF",
                    severity="warning")
        return entry_result

    micro_triggered = (
        micro_drop >= MICRO_VELOCITY_DROP_USD and
        live_hf >= MICRO_HF_THRESHOLD and
        micro_count >= 2 and
        _check_micro_cooldown(wallet_address)
    )

    if micro_triggered:
        logger.info(f"⚡ [MICRO SHORT TRIGGER] wallet={wallet_address[:10]}... "
                     f"drop=${micro_drop:.2f} >= ${MICRO_VELOCITY_DROP_USD} | HF={live_hf:.2f} >= {MICRO_HF_THRESHOLD}")
        _log_strategy(user_id, wallet_address, "micro_short", "TRIGGER", live_hf,
                      details=f"Collateral dropped ${micro_drop:.2f} in {MICRO_VELOCITY_WINDOW_MIN}min. Entering micro short hedge (${MICRO_SHORT_SIZE_USD})")

        if SIMULATION_MODE:
            entry_result = _execute_mock_short_entry(user_id, wallet_address, "micro", MICRO_SHORT_SIZE_USD, live_hf, micro_latest + micro_drop)
        else:
            entry_result = _execute_delegated_short_entry(user_id, wallet_address, agent, "micro", MICRO_SHORT_SIZE_USD, live_hf)
        if entry_result.get("executed"):
            _save_short_position(user_id, wallet_address, "micro",
                                 MICRO_SHORT_SIZE_USD / 2000.0,
                                 micro_latest + micro_drop,
                                 live_hf, entry_result.get("tx_hash"))
            logger.info(f"✅ [MICRO SHORT OPEN] wallet={wallet_address[:10]}... entry_collateral=${micro_latest + micro_drop:.2f}")
            if DB_AVAILABLE:
                database.record_wallet_action_v2(user_id, wallet_address, "MICRO_SHORT_ENTRY",
                    {"hf": live_hf, "drop_usd": micro_drop, "size_usd": MICRO_SHORT_SIZE_USD},
                    tx_hash=entry_result.get("tx_hash"),
                    details_summary="[SHIELD DEPLOYED] Micro hedge adjusted to stabilize HF",
                    severity="warning")
        return entry_result

    skip_reasons = []
    if live_hf < GROWTH_HF_THRESHOLD:
        skip_reasons.append(f"HF {live_hf:.2f} < Growth threshold {GROWTH_HF_THRESHOLD}")
    elif absolute_growth < GROWTH_ABSOLUTE_TRIGGER_USD and relative_growth < GROWTH_RELATIVE_TRIGGER_PCT:
        skip_reasons.append(f"growth ${absolute_growth:+.2f} ({relative_growth*100:.1f}%) below triggers")
    if available_borrows < CAPACITY_MIN_CAPACITY_USD:
        skip_reasons.append(f"capacity ${available_borrows:.2f} < ${CAPACITY_MIN_CAPACITY_USD}")
    if macro_drop > 0 and macro_drop < MACRO_VELOCITY_DROP_USD:
        skip_reasons.append(f"velocity drop ${macro_drop:.2f} < macro ${MACRO_VELOCITY_DROP_USD}")

    reason_str = "; ".join(skip_reasons) if skip_reasons else f"HF {live_hf:.2f} within safe band, no triggers met"
    result["mode"] = "idle"
    result["action"] = "SKIP"
    result["details"] = reason_str
    _log_strategy(user_id, wallet_address, "idle", "SKIP", live_hf, details=reason_str)
    _record_strategy_action(user_id, wallet_address, f"SKIP: {reason_str}")
    return result


def get_strategy_status(user_id, wallet_address):
    """
    Determine the strategy status for a wallet.
    Returns one of: 'active', 'disabled', 'error_permissions'

    Full automation only — no monitoring_only mode.
    """
    if not DB_AVAILABLE:
        return "disabled"

    mw = database.get_managed_wallet(user_id, wallet_address)
    if not mw:
        return "disabled"

    if mw.get('delegation_status') != 'active':
        return "disabled"

    if not database.is_bot_enabled(user_id):
        return "disabled"

    position = database.get_defi_position(user_id, wallet_address)
    if not position or not position.get('has_active_position', False):
        return "disabled"

    if DELEGATION_AVAILABLE:
        try:
            perms = get_delegation_permissions(wallet_address)
            if not perms.get("isActive"):
                return "disabled"
            if PERMISSIONS_AVAILABLE:
                validation = validate_full_automation(perms)
                if validation["valid"]:
                    return "active"
                else:
                    return "error_permissions"
            else:
                required = ["allowSupply", "allowBorrow", "allowRepay", "allowWithdraw"]
                if all(perms.get(f, False) for f in required):
                    return "active"
                else:
                    return "error_permissions"
        except Exception:
            pass

    return "disabled"


def get_system_parameters():
    """
    Return all Black Box risk parameters for system analysis.
    These are hardcoded — users cannot customize them.
    """
    return {
        "hf_thresholds": {
            "growth": {"value": GROWTH_HF_THRESHOLD, "description": "Minimum HF to trigger Growth distribution"},
            "capacity": {"value": CAPACITY_HF_THRESHOLD, "description": "Minimum HF to trigger Capacity distribution"},
            "macro_short": {"value": MACRO_HF_THRESHOLD, "description": "Minimum HF to open Macro short hedge"},
            "micro_short": {"value": MICRO_HF_THRESHOLD, "description": "Minimum HF to open Micro short hedge"},
            "emergency": {"value": EMERGENCY_HF_THRESHOLD, "description": "Below this HF = critical alert, no actions taken"},
            "priority_order": "Emergency (< 2.20) > Growth (>= 2.60) > Capacity (>= 2.40) > Macro (>= 3.05) > Micro (>= 3.00) > Idle",
        },
        "growth_trigger": {
            "hf_minimum": GROWTH_HF_THRESHOLD,
            "min_available_borrows_usd": GROWTH_MIN_CAPACITY_USD,
            "absolute_collateral_growth_usd": GROWTH_ABSOLUTE_TRIGGER_USD,
            "relative_collateral_growth_pct": GROWTH_RELATIVE_TRIGGER_PCT * 100,
            "trigger_logic": "HF >= 2.60 AND available_borrows >= $13.20 AND (collateral_growth >= $50 OR collateral_growth >= 10%)",
            "borrow_amount_usd": GROWTH_BORROW_USD,
            "distribution": dict(GROWTH_DISTRIBUTION),
            "distribution_sequence": [
                "STEP1: Borrow $11.40 DAI from Aave (delegated)",
                "STEP2: Swap $2.75 DAI -> USDT, supply USDT to Aave onBehalfOf user",
                "STEP3: Swap $2.80 DAI -> WBTC, supply WBTC to Aave onBehalfOf user",
                "STEP4: Swap $2.45 DAI -> WETH, supply WETH to Aave onBehalfOf user",
                "STEP5: Swap $1.10 DAI -> WETH -> unwrap ETH (1% skim to bot as WETH, 99% ETH to user for gas). Min $1.50 to execute.",
                "STEP6: Pull $1.10 DAI -> transfer to Wallet_S (savings)",
                "STEP7: Swap $1.20 DAI -> USDC (stays in user wallet, profit accumulator)",
            ],
        },
        "capacity_trigger": {
            "hf_minimum": CAPACITY_HF_THRESHOLD,
            "min_available_borrows_usd": CAPACITY_MIN_CAPACITY_USD,
            "trigger_logic": "HF >= 2.40 AND available_borrows >= $8.20 (no collateral growth requirement)",
            "borrow_amount_usd": CAPACITY_BORROW_USD,
            "distribution": dict(CAPACITY_DISTRIBUTION),
            "distribution_sequence": [
                "STEP1: Borrow $6.70 DAI from Aave (delegated)",
                "STEP2: Swap $1.10 DAI -> USDT, supply USDT to Aave onBehalfOf user",
                "STEP3: Swap $1.10 DAI -> WBTC, supply WBTC to Aave onBehalfOf user",
                "STEP4: Swap $1.10 DAI -> WETH, supply WETH to Aave onBehalfOf user",
                "STEP5: Swap $1.10 DAI -> WETH -> unwrap ETH (1% skim to bot as WETH, 99% ETH to user for gas). Min $1.50 to execute.",
                "STEP6: Pull $1.10 DAI -> transfer to Wallet_S (savings)",
                "STEP7: Swap $1.20 DAI -> USDC (stays in user wallet, profit accumulator)",
            ],
        },
        "macro_short": {
            "hf_minimum": MACRO_HF_THRESHOLD,
            "velocity_drop_usd": MACRO_VELOCITY_DROP_USD,
            "velocity_window_minutes": MACRO_VELOCITY_WINDOW_MIN,
            "short_size_usd": MACRO_SHORT_SIZE_USD,
            "trigger_logic": f"Collateral drops >= ${MACRO_VELOCITY_DROP_USD} within {MACRO_VELOCITY_WINDOW_MIN} min AND HF >= {MACRO_HF_THRESHOLD}",
            "hedge_allocation": {
                "wbtc_pct": SHORT_WBTC_PCT * 100,
                "usdt_pct": SHORT_USDT_PCT * 100,
                "weth_pct": SHORT_WETH_PCT * 100,
            },
            "description": "Borrow WETH against collateral and diversify into WBTC/USDT/WETH to hedge downside",
            "max_hold_minutes": MAX_SHORT_HOLD_MINUTES,
            "close_trigger": f"Collateral recovers to entry level OR hold time > {MAX_SHORT_HOLD_MINUTES} min",
            "state_storage": "PostgreSQL short_positions table (persistent across restarts)",
        },
        "micro_short": {
            "hf_minimum": MICRO_HF_THRESHOLD,
            "velocity_drop_usd": MICRO_VELOCITY_DROP_USD,
            "velocity_window_minutes": MICRO_VELOCITY_WINDOW_MIN,
            "cooldown_hours": MICRO_COOLDOWN_HOURS,
            "short_size_usd": MICRO_SHORT_SIZE_USD,
            "trigger_logic": f"Collateral drops >= ${MICRO_VELOCITY_DROP_USD} within {MICRO_VELOCITY_WINDOW_MIN} min AND HF >= {MICRO_HF_THRESHOLD}, {MICRO_COOLDOWN_HOURS}h cooldown",
            "hedge_allocation": {
                "wbtc_pct": SHORT_WBTC_PCT * 100,
                "usdt_pct": SHORT_USDT_PCT * 100,
                "weth_pct": SHORT_WETH_PCT * 100,
            },
            "description": "Smaller hedge for moderate drops, 4-hour cooldown between triggers",
        },
        "nurse_mode": {
            "hard_floor_usd": 2.00,
            "gas_reimbursement_pct": 2.0,
            "gas_reimbursement_min_usd": 5.00,
            "protected_token": "USDC (never swept)",
            "sweep_tokens": ["DAI", "WETH", "WBTC", "USDT"],
            "dai_debt_guard": "DAI skipped if user has >= $1 outstanding DAI debt",
            "distribution_guard": "Nurse skipped entirely if active distribution in progress",
            "action": "Pull idle tokens from user wallet -> supply to Aave onBehalfOf user (raises HF)",
            "skim_logic": "2% of each swept token pulled to bot operator wallet IF token USD value >= $5. Below $5, full amount supplied.",
        },
        "execution_controls": {
            "borrow_cooldown_seconds": BORROW_COOLDOWN_SECONDS,
            "borrow_cooldown_minutes": BORROW_COOLDOWN_SECONDS / 60,
            "execution_state_ttl_hours": 24,
            "post_borrow_hf_recheck": True,
            "post_borrow_emergency_abort": f"If HF drops below {EMERGENCY_HF_THRESHOLD} after borrow, distribution aborts (state preserved for recovery)",
            "swap_failure_threshold": "If borrow succeeded but >= 3 swap steps failed with 0 successes, state preserved (not cleared) for resume",
            "step_order": list(DELEGATED_STEP_ORDER),
            "priority_order": "Resume (any HF) > Nurse (any HF) > Emergency (< 2.20) > Growth (>= 2.60) > Capacity (>= 2.40) > Macro > Micro > Idle",
        },
        "gas_economics": {
            "eth_gas_skim_pct": 1.0,
            "eth_gas_min_usd": 1.50,
            "skim_method": "Bot keeps 1% of WETH from DAI->WETH swap (no extra transaction). Remaining 99% unwrapped to ETH and sent to user.",
            "below_minimum": "If ETH gas reserve < $1.50, DAI stays in user wallet (4 txns uneconomical)",
            "send_buffer": "0.5% ETH send buffer (sends 99.5% of unwrapped ETH) to prevent dust rounding errors",
        },
        "revenue_streams": {
            "nurse_gas_reimbursement": "2% of swept tokens above $5 minimum",
            "distribution_eth_skim": "1% of WETH from ETH gas reserve swap (kept as WETH, no extra tx)",
        },
    }
