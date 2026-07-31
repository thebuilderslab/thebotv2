
#!/usr/bin/env python3
"""
Autonomous Mainnet Agent Launcher
Runs the ArbitrumTestnetAgent in continuous autonomous mode on Arbitrum Mainnet
"""

import os
import sys
import time
import json
import asyncio
from datetime import datetime
import pytz
from arbitrum_testnet_agent import ArbitrumTestnetAgent
from config_constants import get_target_wallet, get_delegation_mode

try:
    from real_estate_tasks import check_and_run_scheduled_tasks
    RE_TASKS_AVAILABLE = True
except ImportError:
    RE_TASKS_AVAILABLE = False

try:
    from auto_supply import run_auto_supply_cycle
    AUTO_SUPPLY_AVAILABLE = True
except ImportError:
    AUTO_SUPPLY_AVAILABLE = False

try:
    from delegation_sig_processor import run_pending_delegation_submissions
    SIG_PROCESSOR_AVAILABLE = True
except ImportError:
    SIG_PROCESSOR_AVAILABLE = False

try:
    from strategy_engine import run_delegated_strategy, get_strategy_status, run_delegated_nurse_sweep, resume_incomplete_distribution, has_active_distribution
    STRATEGY_ENGINE_AVAILABLE = True
except ImportError:
    STRATEGY_ENGINE_AVAILABLE = False

try:
    import scheduler_bootstrap
    SCHEDULER_AVAILABLE = True
except ImportError:
    SCHEDULER_AVAILABLE = False

try:
    from delegation_client import check_user_wallet_approvals, get_delegation_permissions, validate_full_automation_ready
    APPROVAL_CHECK_AVAILABLE = True
except ImportError:
    APPROVAL_CHECK_AVAILABLE = False

try:
    import db as database
    DB_AVAILABLE = True
except ImportError:
    DB_AVAILABLE = False


MAX_HF = 999.99

def fetch_aave_position_for_wallet(wallet_address):
    """Fetch Aave V3 position data for any wallet (read-only, with RPC fallback).
    Returns None if no position. Caps HF to 999.99."""
    from web3 import Web3
    rpc_urls = [
        os.getenv("ALCHEMY_ARB_RPC", "https://arb-mainnet.g.alchemy.com/v2/demo"),
        os.getenv("ARBITRUM_RPC_URL", "https://arb1.arbitrum.io/rpc"),
        "https://arbitrum-one.publicnode.com",
    ]
    pool_addr = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
    pool_abi = [{
        "inputs": [{"name": "user", "type": "address"}],
        "name": "getUserAccountData",
        "outputs": [
            {"name": "totalCollateralBase", "type": "uint256"},
            {"name": "totalDebtBase", "type": "uint256"},
            {"name": "availableBorrowsBase", "type": "uint256"},
            {"name": "currentLiquidationThreshold", "type": "uint256"},
            {"name": "ltv", "type": "uint256"},
            {"name": "healthFactor", "type": "uint256"}
        ],
        "stateMutability": "view",
        "type": "function"
    }]
    last_err = None
    for rpc in rpc_urls:
        try:
            w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={'timeout': 10}))
            if not w3.is_connected():
                continue
            pool = w3.eth.contract(address=Web3.to_checksum_address(pool_addr), abi=pool_abi)
            data = pool.functions.getUserAccountData(Web3.to_checksum_address(wallet_address)).call()
            coll = round(data[0] / 1e8, 2)
            debt = round(data[1] / 1e8, 2)
            if coll < 0.01 and debt < 0.01:
                return None
            hf = data[5] / 1e18 if data[5] > 0 else 0
            if debt < 0.01 and coll >= 0.01:
                hf = MAX_HF
            elif hf > MAX_HF:
                hf = MAX_HF
            return {'health_factor': round(hf, 4), 'total_collateral_usd': coll,
                    'total_debt_usd': debt, 'net_worth_usd': round(coll - debt, 2)}
        except Exception as e:
            last_err = e
            continue
    log_agent_activity(f"⚠️ Aave position fetch failed for {wallet_address[:10]}...: {last_err}", "WARNING")
    return None


def refresh_defi_for_user(user_id, wallet_address):
    """Fetch on-chain Aave position and upsert to DB. Returns position dict or None.
    Uses consecutive_empty_count to avoid zeroing out a wallet on transient fetch failures.
    Only marks inactive after CONSECUTIVE_EMPTY_THRESHOLD consecutive zero-collateral fetches."""
    pos = fetch_aave_position_for_wallet(wallet_address)
    if pos:
        ok = database.upsert_defi_position(
            user_id=user_id,
            health_factor=pos['health_factor'],
            collateral=pos['total_collateral_usd'],
            debt=pos['total_debt_usd'],
            net_worth=pos['net_worth_usd'],
            wallet_address=wallet_address,
        )
        try:
            database.insert_collateral_snapshot(user_id, wallet_address, pos['total_collateral_usd'])
        except Exception as snap_err:
            logging.getLogger(__name__).warning(f"[Monitor] Collateral snapshot insert failed: {snap_err}")
        if ok:
            log_agent_activity(f"[Monitor] Refreshed position for user {user_id} ({wallet_address[:10]}...): "
                             f"collateral=${pos['total_collateral_usd']}, debt=${pos['total_debt_usd']}, HF={pos['health_factor']}")
        else:
            log_agent_activity(f"[Monitor] DB upsert FAILED for user {user_id} ({wallet_address[:10]}...) — data: {pos}", "ERROR")
        return pos
    else:
        empty_count = database.increment_empty_count(user_id, wallet_address)
        threshold = database.CONSECUTIVE_EMPTY_THRESHOLD
        if empty_count >= threshold:
            database.mark_position_inactive(user_id, wallet_address)
            database.reset_supplied_if_withdrawn(user_id, wallet_address)
            log_agent_activity(f"[Monitor] No on-chain position for user {user_id} ({wallet_address[:10]}...) — "
                             f"confirmed empty ({empty_count}/{threshold} consecutive), marked inactive")
        else:
            log_agent_activity(f"[Monitor] Empty fetch for user {user_id} ({wallet_address[:10]}...) — "
                             f"count={empty_count}/{threshold}, NOT marking inactive yet (may be transient)")
        return None


def run_strategies_for_user(user_id, wallet_address, agent, run_id, iteration, config):
    if DB_AVAILABLE and not database.is_bot_enabled(user_id):
        log_agent_activity(f"[Monitor] wallet={wallet_address[:10]}..., decision=SKIP (bot_disabled)")
        return None
    performance = agent.run_real_defi_task(run_id, iteration, config)
    return performance


RPC_DELAY_SECONDS = 0.5
MAX_CONCURRENT_WALLETS = 5


def _process_managed_wallet_sync(mw, agent, run_id, iteration, config, check_approvals):
    """Synchronous wallet processing — called via asyncio.to_thread().
    Contains all blocking Web3 RPC and on-chain transaction logic."""
    uid = mw['user_id']
    waddr = mw['wallet_address']
    result = {'user_id': uid, 'wallet': waddr, 'status': 'skipped', 'details': ''}

    try:
        pos = refresh_defi_for_user(uid, waddr)
        if not pos:
            result['status'] = 'no_position'
            log_agent_activity(f"[Monitor] wallet={waddr[:10]}..., mode=delegated, decision=SKIP (no position)")
            return result

        log_agent_activity(f"[Monitor] wallet={waddr[:10]}..., collateral=${pos['total_collateral_usd']}, "
                         f"debt=${pos['total_debt_usd']}, hf={pos['health_factor']}, mode=delegated")

        if check_approvals and APPROVAL_CHECK_AVAILABLE:
            try:
                approval_result = check_user_wallet_approvals(waddr)
                if not approval_result.get("all_approved"):
                    missing = approval_result.get("missing", [])
                    missing_str = "; ".join([f"{m['token']}->{m['spender']}" for m in missing[:3]])
                    log_agent_activity(f"[Approvals] wallet={waddr[:10]}..., MISSING: {missing_str}", "WARNING")
            except Exception as appr_err:
                log_agent_activity(f"[Approvals] wallet={waddr[:10]}..., check error: {appr_err}", "WARNING")

        if not STRATEGY_ENGINE_AVAILABLE:
            result['status'] = 'monitor_only'
            log_agent_activity(f"[Monitor] wallet={waddr[:10]}..., mode=delegated, decision=MONITOR (strategy engine not loaded)")
            return result

        defi_pos = database.get_defi_position(uid, waddr)
        has_active = defi_pos.get('has_active_position', False) if defi_pos else False

        if not (has_active and mw.get('delegation_status') == 'active'):
            result['status'] = 'inactive'
            log_agent_activity(f"[Monitor] wallet={waddr[:10]}..., strategy=SKIP (active_pos={has_active}, delegation={mw.get('delegation_status')})")
            return result

        distribution_resumed = False
        try:
            resume_result = resume_incomplete_distribution(uid, waddr, agent)
            if resume_result:
                distribution_resumed = True
                log_agent_activity(f"[Resume] wallet={waddr[:10]}..., COMPLETED incomplete distribution: "
                                 f"action={resume_result.get('action')}, details={resume_result.get('details')}")
        except Exception as resume_err:
            log_agent_activity(f"[Resume] wallet={waddr[:10]}..., error: {resume_err}", "WARNING")

        if not distribution_resumed and not has_active_distribution(waddr):
            try:
                nurse_result = run_delegated_nurse_sweep(uid, waddr, agent)
                if nurse_result.get("swept"):
                    log_agent_activity(f"[Nurse] wallet={waddr[:10]}..., {nurse_result['details']}")
            except Exception as nurse_err:
                log_agent_activity(f"[Nurse] wallet={waddr[:10]}..., error: {nurse_err}", "WARNING")
        elif not distribution_resumed:
            log_agent_activity(f"[Nurse] wallet={waddr[:10]}..., SKIPPED — active distribution detected")

        strategy_result = run_delegated_strategy(uid, waddr, agent, run_id, iteration, config)
        strat_status = get_strategy_status(uid, waddr)
        database.update_strategy_status_field(uid, waddr, strat_status)

        result['status'] = 'executed'
        result['details'] = f"mode={strategy_result['mode']}, action={strategy_result['action']}, status={strat_status}"
        log_agent_activity(f"[Strategy] wallet={waddr[:10]}..., {result['details']}")
        return result

    except Exception as mw_err:
        result['status'] = 'error'
        result['details'] = str(mw_err)
        log_agent_activity(f"[Monitor] wallet={waddr[:10]}..., mode=delegated, decision=ERROR ({mw_err})", "WARNING")
        return result


async def _process_all_wallets(deduped_wallets, agent, run_id, iteration, config, check_approvals):
    """Process all managed wallets concurrently using asyncio.gather with Semaphore(5) rate limiting.
    Creates the semaphore inside the running event loop to avoid cross-loop binding issues."""
    sem = asyncio.Semaphore(MAX_CONCURRENT_WALLETS)

    async def _run_one(mw):
        async with sem:
            await asyncio.sleep(RPC_DELAY_SECONDS)
            return await asyncio.to_thread(
                _process_managed_wallet_sync, mw, agent, run_id, iteration, config, check_approvals
            )

    tasks = [_run_one(mw) for mw in deduped_wallets]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            waddr = deduped_wallets[i]['wallet_address']
            log_agent_activity(f"[Async] wallet={waddr[:10]}..., EXCEPTION: {result}", "ERROR")
        elif isinstance(result, dict) and result.get('status') == 'error':
            log_agent_activity(f"[Async] wallet={result['wallet'][:10]}..., FAILED: {result['details']}", "WARNING")
    return results


def reconcile_delegation_state():
    if not DB_AVAILABLE or not APPROVAL_CHECK_AVAILABLE:
        return
    try:
        all_wallets = database.get_all_managed_wallets()
        for mw in all_wallets:
            uid = mw['user_id']
            waddr = mw['wallet_address']
            status = mw.get('delegation_status', 'none')
            strat = mw.get('strategy_status', 'disabled')

            if status not in ('revoked', 'none') and strat != 'error_permissions':
                continue

            perms = get_delegation_permissions(waddr)
            if not perms.get('isActive'):
                continue

            required = ['allowSupply', 'allowBorrow', 'allowRepay', 'allowWithdraw']
            if not all(perms.get(f, False) for f in required):
                continue

            validation = validate_full_automation_ready(waddr)
            if not validation.get('ready'):
                continue

            database.update_delegation_status(uid, waddr, 'active')
            database.update_strategy_status_field(uid, waddr, 'active')
            database.upsert_managed_wallet(uid, waddr, auto_supply_wbtc=True, delegation_mode='full_automation')
            database.set_bot_enabled(uid, True)
            log_agent_activity(f"[Monitor] Auto-recovered wallet {waddr[:10]}... — on-chain permissions valid, DB synced to active")
    except Exception as e:
        log_agent_activity(f"[Monitor] reconcile_delegation_state error: {e}", "WARNING")

if not os.getenv('NETWORK_MODE'):
    os.environ['NETWORK_MODE'] = 'mainnet'

def log_agent_activity(message, level="INFO"):
    """Log agent activity with timestamp"""
    eastern = pytz.timezone('US/Eastern')
    timestamp = datetime.now(eastern).strftime("%H:%M:%S EST")
    print(f"[{timestamp}] {level}: {message}")

def check_emergency_stop():
    """Check for emergency stop flag"""
    return os.path.exists("EMERGENCY_STOP_ACTIVE.flag")

def run_autonomous_mainnet_agent():
    """Run the autonomous agent on Arbitrum Mainnet"""
    target_wallet = get_target_wallet()
    delegation_label = get_delegation_mode()
    
    network_mode = os.getenv('NETWORK_MODE', 'mainnet')
    if network_mode == 'fork':
        network_label = "Tenderly Fork (Chain ID: 7357)"
    else:
        network_label = "Arbitrum Mainnet (Chain ID: 42161)"
    print("🚀 ARBITRUM MAINNET AUTONOMOUS AGENT")
    print("=" * 60)
    print(f"🌐 Network: {network_label}")
    print(f"🔑 Operation Mode: {delegation_label}")
    if target_wallet:
        print(f"👤 Target Wallet: {target_wallet}")
        print("📋 Delegation Required: User must approveBorrowAllowance for DAI + WETH")
    print("🤖 Mode: Continuous Autonomous Operation")
    print("🛑 Emergency Stop: Create 'EMERGENCY_STOP_ACTIVE.flag' to halt")
    print("=" * 60)
    
    try:
        # Initialize the agent for mainnet
        log_agent_activity("Initializing Arbitrum Mainnet Agent...")
        
        # Import the correct agent class
        try:
            from arbitrum_testnet_agent import ArbitrumTestnetAgent
            agent = ArbitrumTestnetAgent()
            
            # Ensure it's connected to mainnet
            if not agent or not hasattr(agent, 'w3'):
                raise Exception("Agent initialization failed - no web3 connection")
                
        except Exception as init_error:
            log_agent_activity(f"❌ Agent initialization failed: {init_error}")
            raise Exception(f"Failed to initialize agent: {init_error}")
        
        actual_chain_id = agent.w3.eth.chain_id
        network_mode = os.getenv('NETWORK_MODE', 'mainnet')
        expected_chain_ids = {
            'mainnet': 42161,
            'fork': 7357,
        }
        expected_id = expected_chain_ids.get(network_mode, 42161)
        if actual_chain_id != expected_id:
            raise Exception(f"❌ Expected Chain ID {expected_id} ({network_mode}), got {actual_chain_id}")
        
        log_agent_activity(f"✅ Connected to network (Chain ID: {actual_chain_id}, mode: {network_mode})")
        log_agent_activity(f"📍 Wallet Address: {agent.address}")
        
        # Initialize DeFi integrations
        log_agent_activity("🔄 Initializing DeFi integrations...")
        if not agent.initialize_integrations():
            raise Exception("❌ Failed to initialize DeFi integrations")
        log_agent_activity("✅ DeFi integrations initialized successfully")
        
        state_file = "execution_state.json"
        if os.path.exists(state_file):
            os.remove(state_file)
            log_agent_activity(f"🗑️ {state_file} deleted — forcing clean start")
        else:
            log_agent_activity(f"✅ {state_file} not found — already clean")
        
        # Initial status check
        log_agent_activity("📊 Performing initial status check...")
        eth_balance = agent.get_bot_eth_balance()
        log_agent_activity(f"💰 ETH Balance: {eth_balance:.6f} ETH")
        
        try:
            health_data = agent.health_monitor.get_current_health_factor()
            if health_data:
                hf = health_data.get('health_factor', 0)
                log_agent_activity(f"❤️ Initial Health Factor: {hf:.4f}")
            else:
                log_agent_activity("⚠️ Could not retrieve initial health factor")
        except Exception as e:
            log_agent_activity(f"⚠️ Health factor check error: {e}")
        
        log_agent_activity("✅ Clean start confirmed — no pending execution state")

        if DB_AVAILABLE:
            try:
                migrated = database.migrate_tmp_execution_states()
                if migrated > 0:
                    log_agent_activity(f"[Migration] Loaded {migrated} /tmp execution state file(s) into distribution_state table")
            except Exception as mig_err:
                log_agent_activity(f"[Migration] Execution state migration error: {mig_err}", "WARNING")

        print("\n" + "="*60)
        print("📋 PRE-FLIGHT AUDIT — USDC PAY YOURSELF FIRST MODE")
        print("="*60)
        print(f"   Operation Mode: {delegation_label}")
        if target_wallet:
            print(f"   Target Wallet: {target_wallet}")
        print(f"   HF Thresholds: Growth 3.10 / Macro 3.05 / Micro 3.00 / Capacity 2.90")
        print(f"   Slippage Tolerance: 1%")
        print(f"   State File: CLEARED (clean run)")
        print(f"   Growth Path: $11.40 DAI borrow ($2.80 WBTC / $2.45 WETH / $2.75 USDT / $1.10 gas / $1.10 WalletS / $1.20 Tax)")
        print(f"   Capacity Path: $6.70 DAI borrow ($1.10 each: WBTC/WETH/USDT/gas/WalletS + $1.20 Tax)")
        print(f"   Liability Short: Phase 2 Target Profit Engine (Round Trip)")
        print(f"   Macro Short: $10.90 WETH → 40% WBTC / 35% USDT / 25% WETH collateral")
        print(f"   Micro Short: $7.20 WETH → 40% WBTC / 35% USDT / 25% WETH collateral")
        print(f"   Short Flow: Borrow WETH → Split 40/35/25 → Supply → Hunt → Close → 20/20/60")
        print(f"   Velocity Monitor: 40min buffer | Micro: $30 drop in 20min (4h CD) | Macro: $50 drop in 30min (12h CD)")
        print(f"   USDC Tax: $1.20 per Growth/Capacity borrow → DAI→USDC → WALLET_B")
        print(f"   Nurse Mode: $2.00 hard floor, USDC whitelisted (profit)")
        print(f"   Force-Approve: All tokens on startup (Aave + Uniswap)")
        print(f"   Dust Guard: Active ($1.00 minimum swap)")
        print(f"   Per-Step Approvals: Active ($15 DAI threshold)")
        print(f"   Proportional Recovery: Enabled")
        print(f"   Max Recovery Attempts: 5")
        print(f"   🎯 Polling: Dynamic (90s Sentry / 15s Hunter Mode)")
        print("="*60 + "\n")

        if SCHEDULER_AVAILABLE:
            log_agent_activity("🎯 Starting APScheduler — Project 87 v5.2 autonomous jobs...")
            scheduler = scheduler_bootstrap.start(agent)
            log_agent_activity("✅ Scheduler started — core_engine(2min), nurse_sweep(5min), repay_deleverager(18min)")

            if AUTO_SUPPLY_AVAILABLE:
                try:
                    supply_count = run_auto_supply_cycle()
                    if supply_count > 0:
                        log_agent_activity(f"💰 Initial auto-supply: {supply_count} wallet(s) supplied WBTC")
                except Exception as supply_err:
                    log_agent_activity(f"⚠️ Initial auto-supply error: {supply_err}", "WARNING")

            if SIG_PROCESSOR_AVAILABLE:
                try:
                    sig_count = run_pending_delegation_submissions()
                    if sig_count > 0:
                        log_agent_activity(f"🔑 Initial delegation sigs: {sig_count} submitted")
                except Exception as sig_err:
                    log_agent_activity(f"⚠️ Initial sig processor error: {sig_err}", "WARNING")

            log_agent_activity("🔄 Keep-alive loop active — checking emergency stop every 30s")
            while True:
                if check_emergency_stop():
                    log_agent_activity("🛑 Emergency stop detected! Halting operations...", "EMERGENCY")
                    scheduler_bootstrap.shutdown()
                    break
                try:
                    agent._perform_safety_sweep()
                except Exception:
                    pass
                try:
                    agent._process_injection_trigger()
                except Exception:
                    pass
                try:
                    agent._check_profit_bucket()
                except Exception:
                    pass
                if DB_AVAILABLE and APPROVAL_CHECK_AVAILABLE:
                    try:
                        reconcile_delegation_state()
                    except Exception:
                        pass
                time.sleep(30)
        else:
            log_agent_activity("⚠️ APScheduler not available — falling back to legacy loop")
            run_id = 1
            iteration = 0
            while True:
                if check_emergency_stop():
                    log_agent_activity("🛑 Emergency stop detected!", "EMERGENCY")
                    break
                try:
                    agent._perform_safety_sweep()
                    if SIG_PROCESSOR_AVAILABLE:
                        run_pending_delegation_submissions()
                    if AUTO_SUPPLY_AVAILABLE:
                        run_auto_supply_cycle()
                    iteration += 1
                    if iteration >= 50:
                        run_id += 1
                        iteration = 0
                except Exception as e:
                    log_agent_activity(f"❌ Fallback loop error: {e}", "ERROR")
                time.sleep(45)
            
    except KeyboardInterrupt:
        log_agent_activity("👋 Autonomous agent stopped by user (Ctrl+C)", "INFO")
    except Exception as e:
        log_agent_activity(f"💥 Critical error: {e}", "CRITICAL")
        log_agent_activity("🛑 Agent halted due to critical error", "CRITICAL")

if __name__ == "__main__":
    if not os.environ.get('LAUNCHED_BY_RUN_BOTH'):
        lock_file = '/tmp/run_both.lock'
        if os.path.exists(lock_file):
            try:
                with open(lock_file, 'r') as f:
                    pid = int(f.read().strip())
                os.kill(pid, 0)
                print(f"⚡ Agent already managed by bot workflow (run_both.py PID {pid}). Exiting duplicate.")
                sys.exit(0)
            except (OSError, ValueError):
                pass

    if not os.getenv('NETWORK_MODE'):
        os.environ['NETWORK_MODE'] = 'mainnet'
    
    # Check for required secrets
    required_secrets = ['PRIVATE_KEY', 'COINMARKETCAP_API_KEY']
    missing_secrets = [secret for secret in required_secrets if not os.getenv(secret)]
    
    if missing_secrets:
        print(f"❌ Missing required secrets: {missing_secrets}")
        print("💡 Please add these to your Replit Secrets")
        sys.exit(1)
    
    run_autonomous_mainnet_agent()
