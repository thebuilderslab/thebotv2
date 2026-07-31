import logging
import time as _time

logger = logging.getLogger(__name__)

MAX_RETRIES = 3
_retry_counts = {}


def run_pending_delegation_submissions():
    try:
        import db as database
        from delegation_client import (
            submit_delegation_with_sig,
            get_bot_wallet_address,
            VARIABLE_DEBT_TOKENS,
            VARIABLE_DEBT_TOKEN_ABI,
            _get_web3,
        )
        from web3 import Web3
    except ImportError as e:
        logger.warning(f"[DelegationSigProcessor] Import error, skipping: {e}")
        return 0

    pending = database.get_wallets_pending_delegation_submit()
    if not pending:
        return 0

    bot_wallet = get_bot_wallet_address()
    if not bot_wallet:
        logger.error("[DelegationSigProcessor] Bot wallet not available, skipping")
        return 0

    w3 = _get_web3()
    if not w3:
        logger.error("[DelegationSigProcessor] Web3 not available, skipping")
        return 0

    bot_cs = Web3.to_checksum_address(bot_wallet)
    submitted_count = 0

    logger.info(f"[DelegationSigProcessor] Found {len(pending)} wallet(s) with pending credit delegation submissions")

    for mw in pending:
        user_id = mw['user_id']
        wallet = mw['wallet_address']
        wallet_cs = Web3.to_checksum_address(wallet)
        deadline = mw.get('delegation_sig_deadline')

        if not deadline:
            logger.warning(f"[DelegationSigProcessor] wallet={wallet[:10]}... no deadline stored, skipping")
            continue

        retry_key = f"{wallet}"
        current_retries = _retry_counts.get(retry_key, 0)
        if current_retries >= MAX_RETRIES:
            logger.warning(f"[DelegationSigProcessor] wallet={wallet[:10]}... max retries ({MAX_RETRIES}) reached, skipping")
            continue

        if int(deadline) < int(_time.time()):
            logger.warning(f"[DelegationSigProcessor] wallet={wallet[:10]}... signature expired (deadline={deadline}), skipping — user must re-sign")
            continue

        dai_sig = mw.get('delegation_sig')
        dai_submitted = mw.get('delegation_sig_submitted', False)
        weth_sig = mw.get('delegation_sig_weth')
        weth_submitted = mw.get('delegation_sig_weth_submitted', False)

        if dai_sig and not dai_submitted:
            dai_debt_addr = VARIABLE_DEBT_TOKENS.get("DAI")
            if dai_debt_addr:
                try:
                    debt_token = w3.eth.contract(
                        address=Web3.to_checksum_address(dai_debt_addr),
                        abi=VARIABLE_DEBT_TOKEN_ABI
                    )
                    existing_allowance = debt_token.functions.borrowAllowance(wallet_cs, bot_cs).call()
                    if existing_allowance > 0:
                        logger.info(f"[DelegationSigProcessor] wallet={wallet[:10]}... DAI borrowAllowance already {existing_allowance} > 0, marking submitted")
                        database.mark_delegation_sig_submitted(user_id, wallet, token="DAI")
                        dai_submitted = True
                    else:
                        logger.info(f"[DelegationSigProcessor] wallet={wallet[:10]}... submitting DAI delegationWithSig on-chain (attempt {current_retries + 1}/{MAX_RETRIES})")
                        tx_hash = submit_delegation_with_sig(wallet, dai_sig, int(deadline), debt_token_symbol="DAI")
                        if tx_hash:
                            database.mark_delegation_sig_submitted(user_id, wallet, token="DAI")
                            dai_submitted = True
                            submitted_count += 1
                            logger.info(f"[DelegationSigProcessor] DAI credit delegation submitted: tx={tx_hash}, wallet={wallet[:10]}...")
                        else:
                            _retry_counts[retry_key] = current_retries + 1
                            logger.error(f"[DelegationSigProcessor] DAI delegationWithSig failed for {wallet[:10]}... (attempt {current_retries + 1})")
                except Exception as e:
                    _retry_counts[retry_key] = current_retries + 1
                    logger.error(f"[DelegationSigProcessor] DAI sig submit error for {wallet[:10]}...: {e}", exc_info=True)

        if weth_sig and not weth_submitted:
            weth_debt_addr = VARIABLE_DEBT_TOKENS.get("WETH")
            if weth_debt_addr:
                try:
                    debt_token = w3.eth.contract(
                        address=Web3.to_checksum_address(weth_debt_addr),
                        abi=VARIABLE_DEBT_TOKEN_ABI
                    )
                    existing_allowance = debt_token.functions.borrowAllowance(wallet_cs, bot_cs).call()
                    if existing_allowance > 0:
                        logger.info(f"[DelegationSigProcessor] wallet={wallet[:10]}... WETH borrowAllowance already {existing_allowance} > 0, marking submitted")
                        database.mark_delegation_sig_submitted(user_id, wallet, token="WETH")
                        weth_submitted = True
                    else:
                        logger.info(f"[DelegationSigProcessor] wallet={wallet[:10]}... submitting WETH delegationWithSig on-chain (attempt {current_retries + 1}/{MAX_RETRIES})")
                        tx_hash = submit_delegation_with_sig(wallet, weth_sig, int(deadline), debt_token_symbol="WETH")
                        if tx_hash:
                            database.mark_delegation_sig_submitted(user_id, wallet, token="WETH")
                            weth_submitted = True
                            submitted_count += 1
                            logger.info(f"[DelegationSigProcessor] WETH credit delegation submitted: tx={tx_hash}, wallet={wallet[:10]}...")
                        else:
                            _retry_counts[retry_key] = current_retries + 1
                            logger.error(f"[DelegationSigProcessor] WETH delegationWithSig failed for {wallet[:10]}... (attempt {current_retries + 1})")
                except Exception as e:
                    _retry_counts[retry_key] = current_retries + 1
                    logger.error(f"[DelegationSigProcessor] WETH sig submit error for {wallet[:10]}...: {e}", exc_info=True)

        if dai_submitted and weth_submitted:
            database.update_strategy_status_field(user_id, wallet, 'active')
            logger.info(f"[DelegationSigProcessor] wallet={wallet[:10]}... both DAI+WETH delegations confirmed on-chain. Strategy status: active")
            if retry_key in _retry_counts:
                del _retry_counts[retry_key]

    return submitted_count
