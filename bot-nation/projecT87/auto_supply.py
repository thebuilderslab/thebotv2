import logging
import os
from datetime import datetime, timezone, timedelta
import db as database
from delegation_client import (
    is_contract_deployed,
    get_wbtc_balance_raw,
    get_wbtc_allowance_raw,
    compute_supply_amount_raw,
    dm_execute_supply,
    raw_to_wbtc,
    MIN_SUPPLY_RAW,
    _get_web3,
    DELEGATION_MANAGER_ADDRESS,
    WBTC_TOKEN_ADDRESS,
)

logger = logging.getLogger(__name__)

COOLDOWN_SECONDS = int(os.environ.get('AUTO_SUPPLY_COOLDOWN_SECONDS', '3600'))
COOLDOWN_PERIOD = timedelta(seconds=COOLDOWN_SECONDS)
WBTC_DECIMALS = 8
CHAIN_ID_ARBITRUM = 42161


def _get_chain_id():
    try:
        w3 = _get_web3()
        return w3.eth.chain_id
    except Exception:
        return None


def _check_active_distribution(wallet_address):
    try:
        from strategy_engine import has_active_distribution
        return has_active_distribution(wallet_address)
    except ImportError:
        return False


def auto_supply_wbtc_for_wallet(managed_wallet):
    user_id = managed_wallet['user_id']
    wallet = managed_wallet['wallet_address']
    chain_id = _get_chain_id()

    logger.info(f"[AutoSupply] === Evaluating wallet {wallet} (user={user_id}) ===")
    logger.info(f"[AutoSupply] chain_id={chain_id}, contract={DELEGATION_MANAGER_ADDRESS}")

    if _check_active_distribution(wallet):
        logger.info(f"[AutoSupply] status=skipped, reason=active_distribution, wallet={wallet}, "
                    f"decision=SKIP (distribution in progress, auto_supply must not interfere)")
        return False

    if chain_id and chain_id != CHAIN_ID_ARBITRUM:
        logger.error(f"[AutoSupply] status=error, reason=wrong_chain, chain_id={chain_id}, expected={CHAIN_ID_ARBITRUM}")
        return False

    if not managed_wallet.get('bot_enabled', False):
        logger.info(f"[AutoSupply] status=skipped, reason=bot_disabled, wallet={wallet}")
        return False

    if managed_wallet['delegation_status'] != 'active':
        logger.info(f"[AutoSupply] status=skipped, reason=delegation_not_active, delegation_status={managed_wallet['delegation_status']}, wallet={wallet}")
        return False
    if not managed_wallet.get('auto_supply_wbtc', False):
        logger.info(f"[AutoSupply] status=skipped, reason=auto_supply_disabled, wallet={wallet}")
        return False

    last_supply = managed_wallet.get('last_auto_supply_at')
    if last_supply is not None:
        if isinstance(last_supply, str):
            last_supply = datetime.fromisoformat(last_supply)
        if last_supply.tzinfo is None:
            last_supply = last_supply.replace(tzinfo=timezone.utc)
        elapsed = datetime.now(timezone.utc) - last_supply
        if elapsed < COOLDOWN_PERIOD:
            remaining = int((COOLDOWN_PERIOD - elapsed).total_seconds())
            logger.info(f"[AutoSupply] status=skipped, reason=cooldown_active, wallet={wallet}, "
                       f"last_supply={last_supply.isoformat()}, cooldown={COOLDOWN_SECONDS}s, remaining={remaining}s")
            return False
    else:
        logger.info(f"[AutoSupply] wallet={wallet}, first_run=true (no prior supply), cooldown_check=PASS")

    if not is_contract_deployed():
        logger.info(f"[AutoSupply] status=skipped, reason=contract_not_deployed, wallet={wallet}")
        database.record_wallet_action(
            user_id=user_id,
            wallet_address=wallet,
            action_type='auto_supply_skipped_contract',
            details={"reason": "delegation_manager_not_deployed", "chain_id": chain_id},
            tx_hash=None,
        )
        return False

    balance_raw = get_wbtc_balance_raw(wallet)
    allowance_raw = get_wbtc_allowance_raw(wallet)
    balance_wbtc = float(raw_to_wbtc(balance_raw))
    allowance_wbtc = float(raw_to_wbtc(allowance_raw)) if allowance_raw < 2**128 else "unlimited"
    threshold_wbtc = float(raw_to_wbtc(MIN_SUPPLY_RAW))

    amount_raw = compute_supply_amount_raw(balance_raw, allowance_raw)
    amount_wbtc = float(raw_to_wbtc(amount_raw)) if amount_raw > 0 else 0.0

    logger.info(
        f"[AutoSupply] wallet={wallet}, "
        f"balance_raw={balance_raw}, balance_wbtc={balance_wbtc}, "
        f"allowance_raw={allowance_raw}, allowance_wbtc={allowance_wbtc}, "
        f"threshold_raw={MIN_SUPPLY_RAW}, threshold_wbtc={threshold_wbtc}, "
        f"supply_amount_raw={amount_raw}, supply_amount_wbtc={amount_wbtc}, "
        f"chain_id={chain_id}"
    )

    if amount_raw <= 0:
        reason = "below_min_threshold" if balance_raw > 0 else "zero_balance"
        if allowance_raw <= 0:
            reason = "zero_allowance"
        logger.info(f"[AutoSupply] status=skipped, reason={reason}, wallet={wallet}, decision=SKIP")
        database.record_wallet_action(
            user_id=user_id,
            wallet_address=wallet,
            action_type='auto_supply_skipped_amount',
            details={
                "balance_raw": str(balance_raw),
                "balance_wbtc": balance_wbtc,
                "allowance_raw": str(allowance_raw),
                "computed_amount_raw": "0",
                "threshold_raw": str(MIN_SUPPLY_RAW),
                "threshold_wbtc": threshold_wbtc,
                "reason": reason,
                "chain_id": chain_id,
            },
            tx_hash=None,
        )
        return False

    if allowance_raw == 0:
        logger.error(f"[AutoSupply] User WBTC Allowance is 0 — wallet {wallet} has not approved "
                     f"WBTC spending for DelegationManager ({DELEGATION_MANAGER_ADDRESS}). "
                     f"Step 1 approval may not have been completed. Skipping transaction.")
        database.record_wallet_action(
            user_id=user_id,
            wallet_address=wallet,
            action_type='auto_supply_skipped_allowance',
            details={
                "reason": "user_wbtc_allowance_is_zero",
                "delegation_manager": DELEGATION_MANAGER_ADDRESS,
                "balance_raw": str(balance_raw),
                "chain_id": chain_id,
            },
            tx_hash=None,
        )
        return False

    logger.info(f"[AutoSupply] decision=SUPPLY, wallet={wallet}, amount={amount_wbtc} WBTC ({amount_raw} raw)")

    tx_hash = dm_execute_supply(wallet, WBTC_TOKEN_ADDRESS, amount_raw)

    if tx_hash is None:
        logger.warning(f"[AutoSupply] status=error, reason=tx_failed, wallet={wallet}, amount_raw={amount_raw}")
        database.record_wallet_action(
            user_id=user_id,
            wallet_address=wallet,
            action_type='auto_supply_failed',
            details={
                "amount_wbtc": amount_wbtc,
                "amount_raw": int(amount_raw),
                "balance_raw": str(balance_raw),
                "allowance_raw": str(allowance_raw),
                "reason": "tx_failed_or_not_submitted",
                "chain_id": chain_id,
            },
            tx_hash=None,
        )
        return False

    database.record_wallet_action(
        user_id=user_id,
        wallet_address=wallet,
        action_type='auto_supply_wbtc',
        details={
            "amount_raw": int(amount_raw),
            "amount_wbtc": amount_wbtc,
            "chain_id": chain_id,
        },
        tx_hash=tx_hash,
    )
    database.update_managed_wallet_supplied(user_id, wallet, amount_wbtc)

    logger.info(f"[AutoSupply] status=ok, wallet={wallet}, amount={amount_wbtc} WBTC, tx={tx_hash}, decision=SUPPLY")
    return True


def run_auto_supply_cycle():
    chain_id = _get_chain_id()
    logger.info(f"[AutoSupply] === Cycle start === chain_id={chain_id}, contract={DELEGATION_MANAGER_ADDRESS}")

    if not is_contract_deployed():
        logger.info("[AutoSupply] status=skipped, reason=contract_not_deployed, decision=SKIP")
        return 0

    wallets = database.get_active_managed_wallets()
    if not wallets:
        logger.info("[AutoSupply] status=skipped, reason=no_active_wallets, decision=SKIP")
        return 0

    logger.info(f"[AutoSupply] Found {len(wallets)} active wallet(s) to evaluate")
    supplied = 0
    for mw in wallets:
        try:
            if auto_supply_wbtc_for_wallet(mw):
                supplied += 1
        except Exception as e:
            logger.error(f"[AutoSupply] status=error, wallet={mw.get('wallet_address', '?')}, error={e}", exc_info=True)

    logger.info(f"[AutoSupply] === Cycle end === supplied={supplied}/{len(wallets)}")
    return supplied
