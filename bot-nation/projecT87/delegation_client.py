import os
import json
import logging
import threading
from decimal import Decimal
from web3 import Web3

logger = logging.getLogger(__name__)

_tx_broadcast_lock = threading.Lock()
_local_nonce = None

DELEGATION_MANAGER_ADDRESS = os.environ.get("DELEGATION_MANAGER_ADDRESS", "")

from constants import (
    WBTC_TOKEN as WBTC_TOKEN_ADDRESS,
    AAVE_POOL as AAVE_POOL_ADDRESS,
    DAI_TOKEN as DAI_ADDRESS,
    WETH_TOKEN as WETH_ADDRESS,
    USDT_TOKEN as USDT_ADDRESS,
    USDC_TOKEN as USDC_ADDRESS,
    UNISWAP_ROUTER as UNISWAP_ROUTER_ADDRESS,
    TOKEN_DECIMALS,
    TOKEN_NAMES,
    ARBITRUM_PUBLIC_RPCS as ARBITRUM_RPCS,
    get_rpc_url,
)

WBTC_DECIMALS = 8
WBTC_UNIT = Decimal(10) ** WBTC_DECIMALS
MIN_SUPPLY_RAW = int(Decimal("0.0001") * WBTC_UNIT)
MAX_SUPPLY_RATIO_NUM = 4
MAX_SUPPLY_RATIO_DEN = 5


ERC20_ABI = [
    {"constant": True, "inputs": [{"name": "_owner", "type": "address"}], "name": "balanceOf", "outputs": [{"name": "balance", "type": "uint256"}], "type": "function"},
    {"constant": True, "inputs": [{"name": "_owner", "type": "address"}, {"name": "_spender", "type": "address"}], "name": "allowance", "outputs": [{"name": "remaining", "type": "uint256"}], "type": "function"},
    {"constant": False, "inputs": [{"name": "_from", "type": "address"}, {"name": "_to", "type": "address"}, {"name": "_value", "type": "uint256"}], "name": "transferFrom", "outputs": [{"name": "success", "type": "bool"}], "type": "function"},
    {"constant": False, "inputs": [{"name": "_spender", "type": "address"}, {"name": "_value", "type": "uint256"}], "name": "approve", "outputs": [{"name": "success", "type": "bool"}], "type": "function"},
    {"constant": False, "inputs": [{"name": "_to", "type": "address"}, {"name": "_value", "type": "uint256"}], "name": "transfer", "outputs": [{"name": "success", "type": "bool"}], "type": "function"},
]

def _load_dm_abi():
    abi_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dm_abi.json")
    if os.path.exists(abi_path):
        with open(abi_path, "r") as f:
            return json.load(f)
    logger.warning("dm_abi.json not found, using inline fallback ABI")
    return [
        {"inputs": [{"name": "maxAmount", "type": "uint256"}], "name": "approveWBTCDelegation", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
        {"inputs": [{"name": "maxSupplyPerTx", "type": "uint256"}, {"name": "dailySupplyLimit", "type": "uint256"}, {"name": "allowSupply", "type": "bool"}, {"name": "allowBorrow", "type": "bool"}, {"name": "allowRepay", "type": "bool"}, {"name": "allowWithdraw", "type": "bool"}], "name": "approveDelegation", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
        {"inputs": [], "name": "revokeDelegation", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
        {"inputs": [{"name": "user", "type": "address"}, {"name": "asset", "type": "address"}, {"name": "amount", "type": "uint256"}], "name": "executeSupply", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
        {"inputs": [{"name": "user", "type": "address"}, {"name": "asset", "type": "address"}, {"name": "amount", "type": "uint256"}, {"name": "interestRateMode", "type": "uint256"}], "name": "executeBorrowAndTransfer", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
        {"inputs": [{"name": "user", "type": "address"}, {"name": "asset", "type": "address"}, {"name": "amount", "type": "uint256"}, {"name": "interestRateMode", "type": "uint256"}], "name": "executeRepay", "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "nonpayable", "type": "function"},
        {"inputs": [{"name": "user", "type": "address"}, {"name": "asset", "type": "address"}, {"name": "amount", "type": "uint256"}], "name": "executeWithdraw", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
        {"inputs": [{"name": "token", "type": "address"}, {"name": "amount", "type": "uint256"}], "name": "emergencyWithdrawToken", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
        {"inputs": [{"name": "user", "type": "address"}], "name": "getDelegation", "outputs": [{"name": "isActive", "type": "bool"}, {"name": "approvedAt", "type": "uint256"}, {"name": "revokedAt", "type": "uint256"}, {"name": "maxSupplyPerTx", "type": "uint256"}, {"name": "dailySupplyLimit", "type": "uint256"}, {"name": "dailySupplyUsed", "type": "uint256"}, {"name": "allowSupply", "type": "bool"}, {"name": "allowBorrow", "type": "bool"}, {"name": "allowRepay", "type": "bool"}, {"name": "allowWithdraw", "type": "bool"}], "stateMutability": "view", "type": "function"},
        {"inputs": [], "name": "paused", "outputs": [{"name": "", "type": "bool"}], "stateMutability": "view", "type": "function"},
        {"inputs": [], "name": "botOperator", "outputs": [{"name": "", "type": "address"}], "stateMutability": "view", "type": "function"},
        {"inputs": [], "name": "owner", "outputs": [{"name": "", "type": "address"}], "stateMutability": "view", "type": "function"},
    ]

DELEGATION_MANAGER_ABI = _load_dm_abi()

AAVE_POOL_SUPPLY_ABI = [
    {"inputs": [{"name": "asset", "type": "address"}, {"name": "amount", "type": "uint256"}, {"name": "onBehalfOf", "type": "address"}, {"name": "referralCode", "type": "uint16"}], "name": "supply", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
]

VARIABLE_DEBT_TOKENS = {
    "DAI":  "0x8619d80FB0141ba7F184CbF22fd724116D9f7ffC",
    "WETH": "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351",
}

VARIABLE_DEBT_TOKEN_ABI = [
    {"inputs": [{"internalType": "address", "name": "fromUser", "type": "address"}, {"internalType": "address", "name": "toUser", "type": "address"}], "name": "borrowAllowance", "outputs": [{"internalType": "uint256", "type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"internalType": "address", "name": "delegatee", "type": "address"}, {"internalType": "uint256", "name": "amount", "type": "uint256"}], "name": "approveDelegation", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"internalType": "address", "name": "delegator", "type": "address"}, {"internalType": "address", "name": "delegatee", "type": "address"}, {"internalType": "uint256", "name": "value", "type": "uint256"}, {"internalType": "uint256", "name": "deadline", "type": "uint256"}, {"internalType": "uint8", "name": "v", "type": "uint8"}, {"internalType": "bytes32", "name": "r", "type": "bytes32"}, {"internalType": "bytes32", "name": "s", "type": "bytes32"}], "name": "delegationWithSig", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"internalType": "address", "name": "owner", "type": "address"}], "name": "nonces", "outputs": [{"internalType": "uint256", "type": "uint256"}], "stateMutability": "view", "type": "function"},
]

_w3_instance = None
_bot_account = None


def _get_web3():
    global _w3_instance
    if _w3_instance and _w3_instance.is_connected():
        return _w3_instance
    from constants import CHAIN_ID
    network_mode = os.getenv("NETWORK_MODE", "mainnet")
    expected_chain_id = CHAIN_ID if network_mode == "fork" else 42161
    rpcs = []
    if network_mode == "fork":
        tenderly_rpc = os.getenv("TENDERLY_RPC_URL")
        if tenderly_rpc:
            rpcs.append(tenderly_rpc)
    alchemy = os.getenv("ALCHEMY_RPC_URL") or os.getenv("ARBITRUM_RPC_URL")
    if alchemy:
        rpcs.append(alchemy)
    rpcs.extend(ARBITRUM_RPCS)
    for url in rpcs:
        try:
            w3 = Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 10}))
            if w3.is_connected() and w3.eth.chain_id == expected_chain_id:
                _w3_instance = w3
                logger.info(f"delegation_client: connected via {url}")
                return w3
        except Exception:
            continue
    logger.error("delegation_client: all Arbitrum RPCs failed")
    return None


def _get_bot_account():
    global _bot_account
    if _bot_account:
        return _bot_account
    pk = os.getenv("BOT_PRIVATE_KEY") or os.getenv("PRIVATE_KEY") or os.getenv("Wallet_PRIVATE_KEY")
    if not pk:
        logger.error("delegation_client: no BOT_PRIVATE_KEY / PRIVATE_KEY found")
        return None
    w3 = _get_web3()
    if not w3:
        return None
    try:
        _bot_account = w3.eth.account.from_key(pk)
        logger.info(f"delegation_client: bot wallet {_bot_account.address}")
        return _bot_account
    except Exception as e:
        logger.error(f"delegation_client: invalid private key: {e}")
        return None


def get_bot_wallet_address():
    acct = _get_bot_account()
    return acct.address if acct else None


def is_contract_deployed() -> bool:
    if not DELEGATION_MANAGER_ADDRESS or not DELEGATION_MANAGER_ADDRESS.startswith("0x") or len(DELEGATION_MANAGER_ADDRESS) != 42:
        return False
    w3 = _get_web3()
    if not w3:
        return False
    try:
        code = w3.eth.get_code(Web3.to_checksum_address(DELEGATION_MANAGER_ADDRESS))
        deployed = code not in (b"", b"0x", "0x")
        if not deployed:
            logger.info(f"DELEGATION_MANAGER_ADDRESS {DELEGATION_MANAGER_ADDRESS} has no bytecode on-chain")
        return deployed
    except Exception as e:
        logger.error(f"is_contract_deployed check failed: {e}")
        return False


def get_wbtc_balance_raw(wallet_address: str) -> int:
    w3 = _get_web3()
    if not w3:
        logger.warning("No Web3 — returning 0 balance")
        return 0
    try:
        wbtc = w3.eth.contract(address=Web3.to_checksum_address(WBTC_TOKEN_ADDRESS), abi=ERC20_ABI)
        balance = wbtc.functions.balanceOf(Web3.to_checksum_address(wallet_address)).call()
        logger.info(f"WBTC balanceOf({wallet_address}): {balance} raw ({raw_to_wbtc(balance)} WBTC)")
        return balance
    except Exception as e:
        logger.error(f"get_wbtc_balance_raw failed for {wallet_address}: {e}")
        return 0


def get_wbtc_allowance_raw(wallet_address: str) -> int:
    if not is_contract_deployed():
        logger.info("Contract not deployed — returning 0 allowance")
        return 0
    w3 = _get_web3()
    if not w3:
        return 0
    try:
        dm_addr = Web3.to_checksum_address(DELEGATION_MANAGER_ADDRESS)
        wbtc = w3.eth.contract(address=Web3.to_checksum_address(WBTC_TOKEN_ADDRESS), abi=ERC20_ABI)
        allowance = wbtc.functions.allowance(Web3.to_checksum_address(wallet_address), dm_addr).call()
        logger.info(f"WBTC allowance({wallet_address} -> {dm_addr}): {allowance} raw ({raw_to_wbtc(allowance)} WBTC)")
        return allowance
    except Exception as e:
        logger.error(f"get_wbtc_allowance_raw failed for {wallet_address}: {e}")
        return 0


def compute_supply_amount_raw(balance_raw: int, allowance_raw: int) -> int:
    if balance_raw <= 0 or allowance_raw <= 0:
        return 0
    eighty_pct_raw = (balance_raw * MAX_SUPPLY_RATIO_NUM) // MAX_SUPPLY_RATIO_DEN
    amount_raw = min(eighty_pct_raw, allowance_raw)
    if amount_raw < MIN_SUPPLY_RAW:
        logger.info(f"Computed supply {amount_raw} raw < minimum {MIN_SUPPLY_RAW} raw — skip")
        return 0
    return amount_raw


def raw_to_wbtc(raw_amount):
    return Decimal(raw_amount) / WBTC_UNIT


def wbtc_to_raw(wbtc_amount):
    return int(Decimal(str(wbtc_amount)) * WBTC_UNIT)


def build_approve_tx(user_address: str, max_amount_raw: int) -> dict:
    if not is_contract_deployed():
        return {"error": "Delegation Manager contract not deployed"}
    w3 = _get_web3()
    if not w3:
        return {"error": "No Web3 connection"}
    dm_addr = Web3.to_checksum_address(DELEGATION_MANAGER_ADDRESS)
    wbtc = w3.eth.contract(address=Web3.to_checksum_address(WBTC_TOKEN_ADDRESS), abi=ERC20_ABI)
    user_cs = Web3.to_checksum_address(user_address)
    try:
        tx_data = wbtc.functions.approve(dm_addr, max_amount_raw).build_transaction({
            "from": user_cs,
            "gas": 60000,
            "gasPrice": w3.eth.gas_price,
            "nonce": w3.eth.get_transaction_count(user_cs),
            "chainId": 42161,
        })
        return tx_data
    except Exception as e:
        logger.error(f"build_approve_tx failed: {e}")
        return {"error": str(e)}


def call_auto_supply_wbtc(user_address: str, amount_raw: int):
    if not is_contract_deployed():
        logger.error("call_auto_supply_wbtc: contract not deployed")
        return None
    w3 = _get_web3()
    if not w3:
        logger.error("call_auto_supply_wbtc: missing Web3")
        return None

    dm_addr = Web3.to_checksum_address(DELEGATION_MANAGER_ADDRESS)
    user_cs = Web3.to_checksum_address(user_address)
    dm = w3.eth.contract(address=dm_addr, abi=DELEGATION_MANAGER_ABI)

    try:
        result = _send_bot_tx(dm.functions.autoSupplyWBTC(user_cs, amount_raw))
        if result:
            logger.info(f"autoSupplyWBTC confirmed: {result}")
        return result
    except Exception as e:
        logger.error(f"call_auto_supply_wbtc failed for {user_address}: {e}", exc_info=True)
        return None


def get_delegation_permissions(wallet_address: str) -> dict:
    w3 = _get_web3()
    if not w3 or not is_contract_deployed():
        return {"isActive": False, "allowSupply": False, "allowBorrow": False, "allowRepay": False, "allowWithdraw": False}
    try:
        dm = w3.eth.contract(address=Web3.to_checksum_address(DELEGATION_MANAGER_ADDRESS), abi=DELEGATION_MANAGER_ABI)
        result = dm.functions.getDelegation(Web3.to_checksum_address(wallet_address)).call()
        perms = {
            "isActive": result[0],
            "approvedAt": result[1],
            "revokedAt": result[2],
            "maxSupplyPerTx": result[3],
            "dailySupplyLimit": result[4],
            "dailySupplyUsed": result[5],
            "allowSupply": result[6],
            "allowBorrow": result[7],
            "allowRepay": result[8],
            "allowWithdraw": result[9],
        }
        logger.info(f"getDelegation({wallet_address[:10]}...): active={perms['isActive']}, borrow={perms['allowBorrow']}, repay={perms['allowRepay']}, withdraw={perms['allowWithdraw']}")
        return perms
    except Exception as e:
        logger.error(f"get_delegation_permissions failed for {wallet_address}: {e}")
        return {"isActive": False, "allowSupply": False, "allowBorrow": False, "allowRepay": False, "allowWithdraw": False}


AAVE_POOL_ABI = [
    {"inputs": [{"name": "asset", "type": "address"}, {"name": "amount", "type": "uint256"}, {"name": "onBehalfOf", "type": "address"}, {"name": "referralCode", "type": "uint16"}], "name": "supply", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "asset", "type": "address"}, {"name": "amount", "type": "uint256"}, {"name": "interestRateMode", "type": "uint256"}, {"name": "referralCode", "type": "uint16"}, {"name": "onBehalfOf", "type": "address"}], "name": "borrow", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "asset", "type": "address"}, {"name": "amount", "type": "uint256"}, {"name": "interestRateMode", "type": "uint256"}, {"name": "onBehalfOf", "type": "address"}], "name": "repay", "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "asset", "type": "address"}, {"name": "amount", "type": "uint256"}, {"name": "to", "type": "address"}], "name": "withdraw", "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "user", "type": "address"}], "name": "getUserAccountData", "outputs": [
        {"name": "totalCollateralBase", "type": "uint256"}, {"name": "totalDebtBase", "type": "uint256"},
        {"name": "availableBorrowsBase", "type": "uint256"}, {"name": "currentLiquidationThreshold", "type": "uint256"},
        {"name": "ltv", "type": "uint256"}, {"name": "healthFactor", "type": "uint256"}
    ], "stateMutability": "view", "type": "function"},
]


REQUIRED_APPROVAL_CONTRACTS = {
    "DelegationManager": DELEGATION_MANAGER_ADDRESS,
    "BotWallet": get_bot_wallet_address(),
    "Uniswap Router": UNISWAP_ROUTER_ADDRESS,
}

REQUIRED_APPROVAL_TOKENS = [DAI_ADDRESS, WETH_ADDRESS, WBTC_TOKEN_ADDRESS, USDC_ADDRESS, USDT_ADDRESS]

MIN_REQUIRED_ALLOWANCE = 10 ** 18


def get_erc20_allowance(token_address, owner_address, spender_address):
    w3 = _get_web3()
    if not w3:
        return 0
    try:
        token = w3.eth.contract(address=Web3.to_checksum_address(token_address), abi=ERC20_ABI)
        allowance = token.functions.allowance(
            Web3.to_checksum_address(owner_address),
            Web3.to_checksum_address(spender_address)
        ).call()
        return allowance
    except Exception as e:
        logger.error(f"get_erc20_allowance failed: token={token_address[:10]}... owner={owner_address[:10]}... spender={spender_address[:10]}...: {e}")
        return 0


def validate_full_automation_ready(wallet_address):
    blockers = []
    results = {
        "wallet": wallet_address,
        "delegation_flags": {},
        "bot_dex_approvals": [],
        "ready": False,
    }

    perms = get_delegation_permissions(wallet_address)
    results["delegation_flags"] = {
        "isActive": perms.get("isActive", False),
        "allowSupply": perms.get("allowSupply", False),
        "allowBorrow": perms.get("allowBorrow", False),
        "allowRepay": perms.get("allowRepay", False),
        "allowWithdraw": perms.get("allowWithdraw", False),
    }

    required_flags = ["allowSupply", "allowBorrow", "allowRepay", "allowWithdraw"]
    missing_flags = [f for f in required_flags if not perms.get(f, False)]
    if not perms.get("isActive", False):
        missing_flags.insert(0, "isActive")
    if missing_flags:
        blockers.append({"type": "delegation_flags", "missing": missing_flags})

    bot_wallet = get_bot_wallet_address()
    bot_dex_tokens = [DAI_ADDRESS, WETH_ADDRESS, WBTC_TOKEN_ADDRESS, USDC_ADDRESS, USDT_ADDRESS]
    bot_dex_token_names = ["DAI", "WETH", "WBTC", "USDC", "USDT"]
    for token_addr, token_name in zip(bot_dex_tokens, bot_dex_token_names):
        if bot_wallet and UNISWAP_ROUTER_ADDRESS:
            bot_allowance = get_erc20_allowance(token_addr, bot_wallet, UNISWAP_ROUTER_ADDRESS)
            bot_status = "OK" if bot_allowance >= MIN_REQUIRED_ALLOWANCE else "NEEDS_APPROVAL"
            results["bot_dex_approvals"].append({
                "token": token_name,
                "spender": "Uniswap Router",
                "allowance": str(bot_allowance),
                "status": bot_status,
            })

    w3 = _get_web3()
    bot_cs = Web3.to_checksum_address(bot_wallet) if bot_wallet else None
    credit_delegation_results = []
    if w3 and bot_cs:
        wallet_cs = Web3.to_checksum_address(wallet_address)
        for symbol, debt_token_addr in VARIABLE_DEBT_TOKENS.items():
            try:
                debt_token = w3.eth.contract(
                    address=Web3.to_checksum_address(debt_token_addr),
                    abi=VARIABLE_DEBT_TOKEN_ABI
                )
                credit_allowance = debt_token.functions.borrowAllowance(
                    wallet_cs, bot_cs
                ).call()
                status = "OK" if credit_allowance > 0 else "MISSING"
                credit_delegation_results.append({
                    "token": symbol,
                    "debt_token_address": debt_token_addr,
                    "delegatee": bot_wallet,
                    "allowance": str(credit_allowance),
                    "status": status,
                })
                if credit_allowance == 0:
                    blockers.append({
                        "type": "aave_credit_delegation",
                        "token": symbol,
                        "debt_token_address": debt_token_addr,
                        "message": f"Missing Aave credit delegation for {symbol} to bot wallet ({bot_cs}). User must sign EIP-712 delegationWithSig.",
                    })
            except Exception as e:
                logger.warning(f"[Validation] Could not check credit delegation for {symbol}: {e}")
                credit_delegation_results.append({
                    "token": symbol,
                    "debt_token_address": debt_token_addr,
                    "allowance": "error",
                    "status": "ERROR",
                })
    results["credit_delegations"] = credit_delegation_results

    results["ready"] = len(blockers) == 0
    results["blockers"] = blockers

    if results["ready"]:
        logger.info(f"[Validation] Wallet {wallet_address[:10]}... fully validated — DM flags OK, WBTC->DM OK, credit delegation to bot wallet OK")
    else:
        logger.warning(f"[Validation] Wallet {wallet_address[:10]}... NOT ready — {len(blockers)} blocker(s): {[b['type'] + ':' + str(b.get('missing', b.get('token', ''))) for b in blockers]}")

    return results


def ensure_bot_dex_approvals_all_tokens():
    all_ok = True
    tokens = [
        (DAI_ADDRESS, "DAI"),
        (WETH_ADDRESS, "WETH"),
        (WBTC_TOKEN_ADDRESS, "WBTC"),
        (USDC_ADDRESS, "USDC"),
        (USDT_ADDRESS, "USDT"),
    ]
    max_uint = 2 ** 256 - 1
    for token_addr, token_name in tokens:
        ok = _ensure_bot_approval(token_addr, UNISWAP_ROUTER_ADDRESS, max_uint)
        if ok:
            logger.info(f"[BotApproval] {token_name} -> Uniswap Router: OK")
        else:
            logger.error(f"[BotApproval] {token_name} -> Uniswap Router: FAILED")
            all_ok = False
    return all_ok


def _send_bot_tx(func_call, gas_estimate_fallback=400000, max_retries=2):
    global _local_nonce
    w3 = _get_web3()
    acct = _get_bot_account()
    if not w3 or not acct:
        logger.error("_send_bot_tx: missing Web3 or bot account")
        return None

    eth_bal = w3.eth.get_balance(acct.address)
    if eth_bal < w3.to_wei(0.0002, "ether"):
        logger.error(f"Bot ETH too low for gas: {w3.from_wei(eth_bal, 'ether')} ETH")
        return None

    try:
        est = func_call.estimate_gas({"from": acct.address})
        gas_limit = int(est * 1.3)
    except Exception as ge:
        logger.warning(f"Gas estimate failed ({ge}), using {gas_estimate_fallback}")
        gas_limit = gas_estimate_fallback

    for attempt in range(max_retries + 1):
        with _tx_broadcast_lock:
            try:
                if _local_nonce is None:
                    nonce = w3.eth.get_transaction_count(acct.address, "pending")
                    logger.info(f"[NonceMgr] Fetched fresh nonce from RPC: {nonce}")
                else:
                    nonce = _local_nonce
                    logger.info(f"[NonceMgr] Using local nonce: {nonce}")

                base_gas = w3.eth.gas_price
                gas_price = int(base_gas * 2.5)
                tx = func_call.build_transaction({
                    "from": acct.address,
                    "gas": gas_limit,
                    "gasPrice": gas_price,
                    "nonce": nonce,
                    "chainId": 42161,
                })
                signed = w3.eth.account.sign_transaction(tx, acct.key)
                tx_hash = w3.eth.send_raw_transaction(signed.rawTransaction)
                _local_nonce = nonce + 1
                logger.info(f"Tx sent: {tx_hash.hex()} (nonce={nonce}, next_nonce={_local_nonce})")
            except Exception as e:
                err_msg = str(e).lower()
                if "nonce too low" in err_msg or "already known" in err_msg or "replacement transaction" in err_msg:
                    _local_nonce = None
                    logger.warning(f"[NonceMgr] Nonce error (attempt {attempt+1}/{max_retries+1}), reset local nonce: {e}")
                    if attempt < max_retries:
                        import time
                        time.sleep(1)
                        continue
                logger.error(f"_send_bot_tx failed: {e}", exc_info=True)
                return None

        try:
            receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
            if receipt.status == 1:
                final_hash = receipt.transactionHash.hex()
                logger.info(f"Tx confirmed: {final_hash} (gas={receipt.gasUsed})")
                return final_hash
            else:
                logger.error(f"Tx reverted: {tx_hash.hex()}")
                return None
        except Exception as e:
            logger.error(f"_send_bot_tx receipt wait failed: {e}", exc_info=True)
            return None
    return None


def _send_bot_raw_tx(tx_dict, max_retries=2):
    """Send a raw transaction dict (e.g. ETH transfer) through the locked nonce manager.
    Caller provides everything except 'nonce' — nonce is injected by the manager."""
    global _local_nonce
    w3 = _get_web3()
    acct = _get_bot_account()
    if not w3 or not acct:
        logger.error("_send_bot_raw_tx: missing Web3 or bot account")
        return None

    for attempt in range(max_retries + 1):
        with _tx_broadcast_lock:
            try:
                if _local_nonce is None:
                    nonce = w3.eth.get_transaction_count(acct.address, "pending")
                    logger.info(f"[NonceMgr] Fetched fresh nonce from RPC: {nonce}")
                else:
                    nonce = _local_nonce
                    logger.info(f"[NonceMgr] Using local nonce: {nonce}")

                tx_dict["nonce"] = nonce
                signed = w3.eth.account.sign_transaction(tx_dict, acct.key)
                tx_hash = w3.eth.send_raw_transaction(signed.rawTransaction)
                _local_nonce = nonce + 1
                logger.info(f"Raw tx sent: {tx_hash.hex()} (nonce={nonce}, next_nonce={_local_nonce})")
            except Exception as e:
                err_msg = str(e).lower()
                if "nonce too low" in err_msg or "already known" in err_msg or "replacement transaction" in err_msg:
                    _local_nonce = None
                    logger.warning(f"[NonceMgr] Nonce error (attempt {attempt+1}/{max_retries+1}), reset local nonce: {e}")
                    if attempt < max_retries:
                        import time
                        time.sleep(1)
                        continue
                logger.error(f"_send_bot_raw_tx failed: {e}", exc_info=True)
                return None

        try:
            receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
            if receipt.status == 1:
                final_hash = receipt.transactionHash.hex()
                logger.info(f"Raw tx confirmed: {final_hash} (gas={receipt.gasUsed})")
                return final_hash
            else:
                logger.error(f"Raw tx reverted: {tx_hash.hex()}")
                return None
        except Exception as e:
            logger.error(f"_send_bot_raw_tx receipt wait failed: {e}", exc_info=True)
            return None
    return None


def get_tx_broadcast_lock():
    """Return the global transaction broadcast lock for use by other modules
    (aave_integration, uniswap_integration) that also sign from the bot operator wallet."""
    return _tx_broadcast_lock


def acquire_nonce(w3, address):
    """Acquire the next nonce inside an already-held _tx_broadcast_lock.
    Returns the nonce to use. Caller MUST hold _tx_broadcast_lock before calling.
    After successful send_raw_transaction, caller MUST call confirm_nonce().
    On nonce-related errors, caller MUST call reset_nonce()."""
    global _local_nonce
    if _local_nonce is None:
        _local_nonce = w3.eth.get_transaction_count(address, "pending")
        logger.info(f"[NonceMgr] Fetched fresh nonce from RPC: {_local_nonce}")
    else:
        logger.info(f"[NonceMgr] Using local nonce: {_local_nonce}")
    return _local_nonce


def confirm_nonce():
    """Increment local nonce after successful send_raw_transaction.
    Caller MUST hold _tx_broadcast_lock."""
    global _local_nonce
    if _local_nonce is not None:
        _local_nonce += 1
        logger.info(f"[NonceMgr] Nonce incremented to {_local_nonce}")


def reset_nonce():
    """Reset local nonce on nonce-related errors, forcing a fresh RPC fetch next time.
    Caller MUST hold _tx_broadcast_lock."""
    global _local_nonce
    _local_nonce = None
    logger.info(f"[NonceMgr] Nonce reset — next tx will fetch from RPC")


def _rescue_tokens_from_dm(asset_address: str, amount_wei: int) -> bool:
    w3 = _get_web3()
    acct = _get_bot_account()
    if not w3 or not acct:
        logger.error("_rescue_tokens_from_dm: missing Web3 or bot account")
        return False
    dm_addr = Web3.to_checksum_address(DELEGATION_MANAGER_ADDRESS)
    asset_cs = Web3.to_checksum_address(asset_address)
    dm = w3.eth.contract(address=dm_addr, abi=DELEGATION_MANAGER_ABI)
    logger.info(f"_rescue_tokens_from_dm: withdrawing {amount_wei} from DM to bot wallet")
    withdraw_hash = _send_bot_tx(dm.functions.emergencyWithdrawToken(asset_cs, amount_wei))
    if not withdraw_hash:
        logger.error(f"_rescue_tokens_from_dm: emergencyWithdrawToken failed")
        return False
    logger.info(f"_rescue_tokens_from_dm: OK — {amount_wei} rescued to bot wallet")
    return True


def _forward_tokens_to_user(asset_address: str, amount_wei: int, user_address: str) -> bool:
    w3 = _get_web3()
    if not w3:
        return False
    asset_cs = Web3.to_checksum_address(asset_address)
    user_cs = Web3.to_checksum_address(user_address)
    token = w3.eth.contract(address=asset_cs, abi=ERC20_ABI)
    logger.info(f"_forward_tokens_to_user: transferring {amount_wei} to {user_address[:10]}...")
    transfer_hash = _send_bot_tx(token.functions.transfer(user_cs, amount_wei))
    if not transfer_hash:
        logger.error(f"_forward_tokens_to_user: transfer to user failed")
        return False
    logger.info(f"_forward_tokens_to_user: OK — {amount_wei} sent to {user_address[:10]}...")
    return True


def delegated_borrow(user_address: str, asset_address: str, amount_wei: int, interest_rate_mode: int = 2) -> str:
    """
    Borrow tokens on behalf of user via DelegationManager.
    Uses executeBorrowAndTransfer for atomic borrow+transfer to user wallet.
    Tokens MUST end in the USER wallet, never the BOT wallet.
    """
    w3 = _get_web3()
    if not w3 or not is_contract_deployed():
        return None
    perms = get_delegation_permissions(user_address)
    if not perms.get("isActive"):
        logger.error(f"delegated_borrow: delegation not active for {user_address[:10]}...")
        return None
    if not perms.get("allowBorrow"):
        logger.error(f"delegated_borrow: borrow not permitted for {user_address[:10]}...")
        return None

    user_cs = Web3.to_checksum_address(user_address)
    asset_cs = Web3.to_checksum_address(asset_address)
    logger.info(f"delegated_borrow: user={user_address[:10]}..., asset={asset_address[:10]}..., amount_wei={amount_wei}")

    dm = w3.eth.contract(address=Web3.to_checksum_address(DELEGATION_MANAGER_ADDRESS), abi=DELEGATION_MANAGER_ABI)
    borrow_hash = _send_bot_tx(dm.functions.executeBorrowAndTransfer(user_cs, asset_cs, amount_wei, interest_rate_mode))
    if borrow_hash:
        logger.info(f"delegated_borrow: OK — atomic borrow+transfer to user {user_address[:10]}...")
    return borrow_hash


def check_borrow_allowance(user_address: str, debt_token_symbol: str) -> int:
    w3 = _get_web3()
    bot_wallet = get_bot_wallet_address()
    if not w3 or not bot_wallet:
        return 0
    debt_token_addr = VARIABLE_DEBT_TOKENS.get(debt_token_symbol)
    if not debt_token_addr:
        return 0
    try:
        debt_contract = w3.eth.contract(
            address=Web3.to_checksum_address(debt_token_addr),
            abi=VARIABLE_DEBT_TOKEN_ABI
        )
        allowance = debt_contract.functions.borrowAllowance(
            Web3.to_checksum_address(user_address),
            Web3.to_checksum_address(bot_wallet)
        ).call()
        return allowance
    except Exception as e:
        logger.error(f"check_borrow_allowance: error for {debt_token_symbol} user={user_address[:10]}...: {e}")
        return 0


def delegated_borrow_to_bot(user_address: str, asset_address: str, amount_wei: int, interest_rate_mode: int = 2) -> str:
    """
    Borrow tokens on behalf of user by calling Aave Pool.borrow() directly.
    The user has delegated credit to the bot wallet via EIP-712 signatures,
    so the bot can call borrow(onBehalfOf=user) and Aave sends tokens to
    msg.sender (the bot wallet). No pull_token_from_user step needed.
    """
    w3 = _get_web3()
    acct = _get_bot_account()
    if not w3 or not acct:
        logger.error("delegated_borrow_to_bot: missing Web3 or bot account")
        return None

    user_cs = Web3.to_checksum_address(user_address)
    asset_cs = Web3.to_checksum_address(asset_address)
    logger.info(f"delegated_borrow_to_bot: user={user_address[:10]}..., asset={asset_address[:10]}..., amount_wei={amount_wei}, bot={acct.address[:10]}...")

    pool = w3.eth.contract(address=Web3.to_checksum_address(AAVE_POOL_ADDRESS), abi=AAVE_POOL_ABI)
    borrow_hash = _send_bot_tx(pool.functions.borrow(asset_cs, amount_wei, interest_rate_mode, 0, user_cs))
    if borrow_hash:
        logger.info(f"delegated_borrow_to_bot: OK — borrowed {amount_wei} of {asset_address[:10]}... onBehalfOf {user_address[:10]}... -> bot wallet")
    return borrow_hash


def delegated_borrow_dai(user_address: str, amount_dai: float) -> str:
    amount_wei = int(amount_dai * 10**18)
    logger.info(f"delegated_borrow_dai: user={user_address[:10]}..., amount=${amount_dai:.2f}")
    return delegated_borrow_to_bot(user_address, DAI_ADDRESS, amount_wei, interest_rate_mode=2)


def delegated_borrow_weth(user_address: str, amount_weth: float) -> str:
    amount_wei = int(amount_weth * 10**18)
    logger.info(f"delegated_borrow_weth: user={user_address[:10]}..., amount={amount_weth:.6f} WETH")
    return delegated_borrow_to_bot(user_address, WETH_ADDRESS, amount_wei, interest_rate_mode=2)


def delegated_repay(user_address: str, asset_address: str, amount_wei: int, interest_rate_mode: int = 2) -> str:
    w3 = _get_web3()
    if not w3 or not is_contract_deployed():
        return None
    perms = get_delegation_permissions(user_address)
    if not perms.get("isActive") or not perms.get("allowRepay"):
        logger.error(f"delegated_repay: not permitted for {user_address[:10]}...")
        return None
    dm = w3.eth.contract(address=Web3.to_checksum_address(DELEGATION_MANAGER_ADDRESS), abi=DELEGATION_MANAGER_ABI)
    user_cs = Web3.to_checksum_address(user_address)
    asset_cs = Web3.to_checksum_address(asset_address)
    logger.info(f"delegated_repay: user={user_address[:10]}..., asset={asset_address[:10]}..., amount_wei={amount_wei}")
    return _send_bot_tx(dm.functions.executeRepay(user_cs, asset_cs, amount_wei, interest_rate_mode))


def delegated_repay_dai(user_address: str, amount_dai: float) -> str:
    amount_wei = int(amount_dai * 10**18)
    logger.info(f"delegated_repay_dai: user={user_address[:10]}..., amount=${amount_dai:.2f}")
    return delegated_repay(user_address, DAI_ADDRESS, amount_wei, interest_rate_mode=2)


def delegated_repay_dai_onbehalf(user_address: str, amount_dai: float) -> str:
    """Repay DAI debt on behalf of user via DelegationManager.
    Ensures DM contract is approved to pull DAI from the bot wallet before repaying.
    """
    amount_wei = int(amount_dai * 10**18)
    logger.info(f"delegated_repay_dai_onbehalf: user={user_address[:10]}..., amount=${amount_dai:.4f}")
    dm_addr = DELEGATION_MANAGER_ADDRESS
    if dm_addr:
        approved = _ensure_bot_approval(DAI_ADDRESS, dm_addr, amount_wei)
        if not approved:
            logger.error(f"delegated_repay_dai_onbehalf: DAI→DM approval failed for {user_address[:10]}")
            return None
    return delegated_repay_dai(user_address, amount_dai)


def delegated_withdraw(user_address: str, asset_address: str, amount_wei: int) -> str:
    w3 = _get_web3()
    if not w3 or not is_contract_deployed():
        return None
    perms = get_delegation_permissions(user_address)
    if not perms.get("isActive") or not perms.get("allowWithdraw"):
        logger.error(f"delegated_withdraw: not permitted for {user_address[:10]}...")
        return None
    dm = w3.eth.contract(address=Web3.to_checksum_address(DELEGATION_MANAGER_ADDRESS), abi=DELEGATION_MANAGER_ABI)
    user_cs = Web3.to_checksum_address(user_address)
    asset_cs = Web3.to_checksum_address(asset_address)
    logger.info(f"delegated_withdraw: user={user_address[:10]}..., asset={asset_address[:10]}..., amount_wei={amount_wei}")
    withdraw_hash = _send_bot_tx(dm.functions.executeWithdraw(user_cs, asset_cs, amount_wei))
    if withdraw_hash:
        logger.info(f"delegated_withdraw: OK — tokens transferred to user {user_address[:10]}... atomically by DM contract")
    return withdraw_hash


def get_user_account_data(wallet_address: str) -> dict:
    w3 = _get_web3()
    if not w3:
        return None
    try:
        pool = w3.eth.contract(address=Web3.to_checksum_address(AAVE_POOL_ADDRESS), abi=AAVE_POOL_ABI)
        data = pool.functions.getUserAccountData(Web3.to_checksum_address(wallet_address)).call()
        collateral_usd = data[0] / 1e8
        debt_usd = data[1] / 1e8
        available_borrows_usd = data[2] / 1e8
        hf = data[5] / 1e18 if data[5] > 0 else 0
        if hf > 999.99:
            hf = 999.99
        return {
            "totalCollateralUSD": round(collateral_usd, 2),
            "totalDebtUSD": round(debt_usd, 2),
            "availableBorrowsUSD": round(available_borrows_usd, 2),
            "healthFactor": round(hf, 4),
            "ltv": data[4],
        }
    except Exception as e:
        logger.error(f"get_user_account_data failed for {wallet_address}: {e}")
        return None


def approve_delegation(wallet_address: str):
    if not is_contract_deployed():
        logger.warning("Contract not deployed — cannot approve delegation on-chain")
        return None
    return Web3.to_checksum_address(DELEGATION_MANAGER_ADDRESS)


def revoke_delegation(wallet_address: str):
    if not is_contract_deployed():
        logger.warning("Contract not deployed — cannot revoke delegation on-chain")
        return None
    return Web3.to_checksum_address(DELEGATION_MANAGER_ADDRESS)


INFINITE_ALLOWANCE = 2 ** 128


def get_token_balance_raw(wallet_address: str, token_address: str) -> int:
    w3 = _get_web3()
    if not w3:
        logger.warning("No Web3 — returning 0 balance")
        return 0
    try:
        token = w3.eth.contract(address=Web3.to_checksum_address(token_address), abi=ERC20_ABI)
        balance = token.functions.balanceOf(Web3.to_checksum_address(wallet_address)).call()
        logger.info(f"balanceOf({wallet_address[:10]}..., token={token_address[:10]}...): {balance} raw")
        return balance
    except Exception as e:
        logger.error(f"get_token_balance_raw failed for {wallet_address}, token {token_address}: {e}")
        return 0


def get_token_balance(wallet_address: str, token_address: str) -> float:
    raw = get_token_balance_raw(wallet_address, token_address)
    decimals = TOKEN_DECIMALS.get(Web3.to_checksum_address(token_address), 18)
    balance = raw / (10 ** decimals)
    logger.info(f"get_token_balance({wallet_address[:10]}..., token={token_address[:10]}...): {balance}")
    return balance


def get_multi_token_balances(wallet_address: str) -> dict:
    results = {}
    for addr, name in TOKEN_NAMES.items():
        try:
            balance_raw = get_token_balance_raw(wallet_address, addr)
            decimals = TOKEN_DECIMALS.get(addr, 18)
            balance = balance_raw / (10 ** decimals)
            results[name] = {
                "address": addr,
                "balance": balance,
                "balance_raw": balance_raw,
            }
        except Exception as e:
            logger.error(f"get_multi_token_balances: error for {name}: {e}")
            results[name] = {
                "address": addr,
                "balance": 0.0,
                "balance_raw": 0,
            }
    logger.info(f"get_multi_token_balances({wallet_address[:10]}...): {len(results)} tokens fetched")
    return results


def check_user_wallet_approvals(wallet_address: str) -> dict:
    w3 = _get_web3()
    if not w3:
        logger.error("check_user_wallet_approvals: no Web3 connection")
        return {"all_approved": False, "missing": [], "approved": []}
    missing = []
    approved = []
    user_cs = Web3.to_checksum_address(wallet_address)
    for token_addr in REQUIRED_APPROVAL_TOKENS:
        token_cs = Web3.to_checksum_address(token_addr)
        token_name = TOKEN_NAMES.get(token_cs, token_cs[:10])
        token_contract = w3.eth.contract(address=token_cs, abi=ERC20_ABI)
        for spender_name, spender_addr in REQUIRED_APPROVAL_CONTRACTS.items():
            if not spender_addr or not spender_addr.startswith("0x") or len(spender_addr) != 42:
                continue
            try:
                spender_cs = Web3.to_checksum_address(spender_addr)
                allowance = token_contract.functions.allowance(user_cs, spender_cs).call()
                if allowance >= INFINITE_ALLOWANCE:
                    approved.append({
                        "token": token_name,
                        "spender": spender_name,
                        "allowance": allowance,
                    })
                else:
                    missing.append({
                        "token": token_name,
                        "token_address": token_addr,
                        "spender": spender_name,
                        "spender_address": spender_addr,
                        "current_allowance": allowance,
                    })
            except Exception as e:
                logger.error(f"check_user_wallet_approvals: error checking {token_name} -> {spender_name}: {e}")
                missing.append({
                    "token": token_name,
                    "token_address": token_addr,
                    "spender": spender_name,
                    "spender_address": spender_addr,
                    "current_allowance": 0,
                })
    all_approved = len(missing) == 0
    logger.info(f"check_user_wallet_approvals({wallet_address[:10]}...): all_approved={all_approved}, missing={len(missing)}, approved={len(approved)}")
    return {"all_approved": all_approved, "missing": missing, "approved": approved}


def _ensure_bot_approval(token_address: str, spender_address: str, amount_raw: int) -> bool:
    w3 = _get_web3()
    acct = _get_bot_account()
    if not w3 or not acct:
        logger.error("_ensure_bot_approval: missing Web3 or bot account")
        return False
    try:
        token_cs = Web3.to_checksum_address(token_address)
        spender_cs = Web3.to_checksum_address(spender_address)
        token_contract = w3.eth.contract(address=token_cs, abi=ERC20_ABI)
        current_allowance = token_contract.functions.allowance(acct.address, spender_cs).call()
        if current_allowance >= amount_raw:
            logger.info(f"_ensure_bot_approval: already approved {current_allowance} >= {amount_raw}")
            return True
        max_approval = 2 ** 256 - 1
        logger.info(f"_ensure_bot_approval: approving {token_address[:10]}... for spender {spender_address[:10]}...")
        result = _send_bot_tx(token_contract.functions.approve(spender_cs, max_approval), gas_estimate_fallback=100000)
        if result:
            logger.info(f"_ensure_bot_approval: approval tx confirmed: {result}")
            return True
        else:
            logger.error("_ensure_bot_approval: approval tx failed")
            return False
    except Exception as e:
        logger.error(f"_ensure_bot_approval failed: {e}", exc_info=True)
        return False


def ensure_bot_dex_approval(token_address: str, amount_raw: int) -> bool:
    """
    Ensure BOT wallet has approved the DEX Router (Uniswap V3) to spend tokens.
    Must be called before any swap. Uses max approval to avoid repeated approvals.
    """
    return _ensure_bot_approval(token_address, UNISWAP_ROUTER_ADDRESS, amount_raw)


def delegated_supply_onbehalf(user_address: str, asset_address: str, amount_wei: int) -> str:
    w3 = _get_web3()
    if not w3 or not is_contract_deployed():
        return None
    perms = get_delegation_permissions(user_address)
    if not perms.get("isActive"):
        logger.error(f"delegated_supply_onbehalf: delegation not active for {user_address[:10]}...")
        return None
    if not perms.get("allowSupply"):
        logger.error(f"delegated_supply_onbehalf: supply not permitted for {user_address[:10]}...")
        return None
    acct = _get_bot_account()
    if not acct:
        logger.error("delegated_supply_onbehalf: no bot account")
        return None
    token_cs = Web3.to_checksum_address(asset_address)
    bot_balance = get_token_balance_raw(acct.address, token_cs)
    if bot_balance < amount_wei:
        logger.error(f"delegated_supply_onbehalf: bot balance {bot_balance} < required {amount_wei}")
        return None
    pool_addr = Web3.to_checksum_address(AAVE_POOL_ADDRESS)
    if not _ensure_bot_approval(asset_address, AAVE_POOL_ADDRESS, amount_wei):
        logger.error("delegated_supply_onbehalf: failed to approve Aave Pool")
        return None
    pool = w3.eth.contract(address=pool_addr, abi=AAVE_POOL_ABI)
    user_cs = Web3.to_checksum_address(user_address)
    logger.info(f"delegated_supply_onbehalf: user={user_address[:10]}..., asset={asset_address[:10]}..., amount_wei={amount_wei}")
    return _send_bot_tx(pool.functions.supply(token_cs, amount_wei, user_cs, 0))


def delegated_supply_dai_onbehalf(user_address: str, amount_dai: float) -> str:
    amount_wei = int(amount_dai * 10**18)
    logger.info(f"delegated_supply_dai_onbehalf: user={user_address[:10]}..., amount={amount_dai:.4f} DAI")
    return delegated_supply_onbehalf(user_address, DAI_ADDRESS, amount_wei)


def delegated_supply_wbtc_onbehalf(user_address: str, amount_wbtc: float) -> str:
    amount_raw = int(amount_wbtc * 10**8)
    logger.info(f"delegated_supply_wbtc_onbehalf: user={user_address[:10]}..., amount={amount_wbtc:.8f} WBTC")
    return delegated_supply_onbehalf(user_address, WBTC_TOKEN_ADDRESS, amount_raw)


def delegated_supply_weth_onbehalf(user_address: str, amount_weth: float) -> str:
    amount_wei = int(amount_weth * 10**18)
    logger.info(f"delegated_supply_weth_onbehalf: user={user_address[:10]}..., amount={amount_weth:.6f} WETH")
    return delegated_supply_onbehalf(user_address, WETH_ADDRESS, amount_wei)


def delegated_supply_usdt_onbehalf(user_address: str, amount_usdt: float) -> str:
    amount_raw = int(amount_usdt * 10**6)
    logger.info(f"delegated_supply_usdt_onbehalf: user={user_address[:10]}..., amount={amount_usdt:.2f} USDT")
    return delegated_supply_onbehalf(user_address, USDT_ADDRESS, amount_raw)


def dm_execute_supply(user_address: str, asset_address: str, amount_raw: int) -> str:
    """Call DelegationManager.executeSupply() — pulls tokens from user wallet via DM
    (user approved DM, not bot) and supplies to Aave onBehalfOf user atomically."""
    w3 = _get_web3()
    if not w3 or not is_contract_deployed():
        return None
    perms = get_delegation_permissions(user_address)
    if not perms.get("isActive"):
        logger.error(f"dm_execute_supply: delegation not active for {user_address[:10]}...")
        return None
    if not perms.get("allowSupply"):
        logger.error(f"dm_execute_supply: supply not permitted for {user_address[:10]}...")
        return None
    acct = _get_bot_account()
    if not acct:
        return None
    dm_addr = Web3.to_checksum_address(DELEGATION_MANAGER_ADDRESS)
    dm = w3.eth.contract(address=dm_addr, abi=DELEGATION_MANAGER_ABI)
    user_cs = Web3.to_checksum_address(user_address)
    asset_cs = Web3.to_checksum_address(asset_address)
    logger.info(f"dm_execute_supply: user={user_address[:10]}..., asset={asset_address[:10]}..., amount_raw={amount_raw}")
    return _send_bot_tx(dm.functions.executeSupply(user_cs, asset_cs, amount_raw))


def submit_delegation_with_sig(user_address: str, raw_signature: str, deadline: int, debt_token_symbol: str = "DAI") -> str:
    """Submit a user's off-chain EIP-712 delegationWithSig signature on-chain.
    The bot pays gas. This unlocks credit delegation for the specified debt token."""
    w3 = _get_web3()
    acct = _get_bot_account()
    if not w3 or not acct:
        logger.error("submit_delegation_with_sig: missing Web3 or bot account")
        return None

    debt_token_addr = VARIABLE_DEBT_TOKENS.get(debt_token_symbol)
    if not debt_token_addr:
        logger.error(f"submit_delegation_with_sig: unknown debt token symbol {debt_token_symbol}")
        return None

    try:
        import time as _time
        if deadline < int(_time.time()):
            logger.error(f"submit_delegation_with_sig: signature expired (deadline={deadline}, now={int(_time.time())})")
            return None

        sig_bytes = w3.to_bytes(hexstr=raw_signature)
        if len(sig_bytes) != 65:
            logger.error(f"submit_delegation_with_sig: invalid signature length {len(sig_bytes)}")
            return None

        r = sig_bytes[0:32]
        s = sig_bytes[32:64]
        v = sig_bytes[64]
        if v < 27:
            v += 27

        debt_contract = w3.eth.contract(
            address=Web3.to_checksum_address(debt_token_addr),
            abi=VARIABLE_DEBT_TOKEN_ABI
        )
        user_cs = Web3.to_checksum_address(user_address)
        bot_wallet = get_bot_wallet_address()
        if not bot_wallet:
            logger.error("submit_delegation_with_sig: bot wallet not available")
            return None
        delegatee = Web3.to_checksum_address(bot_wallet)
        max_uint = 2**256 - 1

        logger.info(f"submit_delegation_with_sig: delegator={user_address[:10]}..., delegatee={bot_wallet[:10]}... (bot), token={debt_token_symbol}, deadline={deadline}")

        tx_hash = _send_bot_tx(
            debt_contract.functions.delegationWithSig(
                user_cs, delegatee, max_uint, deadline, v, r, s
            ),
            gas_estimate_fallback=200000
        )

        if tx_hash:
            logger.info(f"submit_delegation_with_sig: SUCCESS tx={tx_hash}")
        else:
            logger.error("submit_delegation_with_sig: transaction failed or reverted")

        return tx_hash
    except Exception as e:
        logger.error(f"submit_delegation_with_sig failed: {e}", exc_info=True)
        return None


def pull_token_from_user(user_address: str, token_address: str, amount_raw: int) -> str:
    w3 = _get_web3()
    acct = _get_bot_account()
    if not w3 or not acct:
        logger.error("pull_token_from_user: missing Web3 or bot account")
        return None
    try:
        token_cs = Web3.to_checksum_address(token_address)
        user_cs = Web3.to_checksum_address(user_address)
        token_contract = w3.eth.contract(address=token_cs, abi=ERC20_ABI)
        logger.info(f"pull_token_from_user: from={user_address[:10]}..., token={token_address[:10]}..., amount_raw={amount_raw}")
        return _send_bot_tx(token_contract.functions.transferFrom(user_cs, acct.address, amount_raw))
    except Exception as e:
        logger.error(f"pull_token_from_user failed: {e}", exc_info=True)
        return None


def transfer_token_to_address(to_address: str, token_address: str, amount_raw: int) -> str:
    w3 = _get_web3()
    acct = _get_bot_account()
    if not w3 or not acct:
        logger.error("transfer_token_to_address: missing Web3 or bot account")
        return None
    try:
        token_cs = Web3.to_checksum_address(token_address)
        to_cs = Web3.to_checksum_address(to_address)
        token_contract = w3.eth.contract(address=token_cs, abi=ERC20_ABI)
        logger.info(f"transfer_token_to_address: to={to_address[:10]}..., token={token_address[:10]}..., amount_raw={amount_raw}")
        return _send_bot_tx(token_contract.functions.transfer(to_cs, amount_raw))
    except Exception as e:
        logger.error(f"transfer_token_to_address failed: {e}", exc_info=True)
        return None


WETH_ABI_WITHDRAW = [
    {"constant": False, "inputs": [{"name": "wad", "type": "uint256"}],
     "name": "withdraw", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"constant": False, "inputs": [], "name": "deposit", "outputs": [],
     "stateMutability": "payable", "type": "function"},
]



def unwrap_weth_to_eth(amount_weth: float) -> str:
    """Unwrap WETH to native ETH in the bot operator's wallet."""
    w3 = _get_web3()
    acct = _get_bot_account()
    if not w3 or not acct:
        logger.error("unwrap_weth_to_eth: missing Web3 or bot account")
        return None
    try:
        weth_wei = int(amount_weth * 1e18)
        weth_contract = w3.eth.contract(
            address=Web3.to_checksum_address(WETH_ADDRESS), abi=WETH_ABI_WITHDRAW)
        logger.info(f"unwrap_weth_to_eth: unwrapping {amount_weth:.8f} WETH -> ETH")
        return _send_bot_tx(weth_contract.functions.withdraw(weth_wei), gas_estimate_fallback=60000)
    except Exception as e:
        logger.error(f"unwrap_weth_to_eth failed: {e}", exc_info=True)
        return None


def send_eth_to_address(to_address: str, amount_eth: float) -> str:
    """Send native ETH from bot operator wallet to any address.
    Routes through _send_bot_raw_tx for nonce-safe broadcasting."""
    w3 = _get_web3()
    acct = _get_bot_account()
    if not w3 or not acct:
        logger.error("send_eth_to_address: missing Web3 or bot account")
        return None
    try:
        to_cs = Web3.to_checksum_address(to_address)
        amount_wei = int(amount_eth * 1e18)
        base_gas = w3.eth.gas_price
        gas_price = int(base_gas * 2.5)
        tx = {
            "from": acct.address,
            "to": to_cs,
            "value": amount_wei,
            "gas": 21000,
            "gasPrice": gas_price,
            "chainId": 42161,
        }
        logger.info(f"send_eth_to_address: {amount_eth:.8f} ETH -> {to_address[:10]}...")
        return _send_bot_raw_tx(tx)
    except Exception as e:
        logger.error(f"send_eth_to_address failed: {e}", exc_info=True)
        return None


def delegated_repay_weth(user_address: str, amount_weth: float) -> str:
    amount_wei = int(amount_weth * 10**18)
    logger.info(f"delegated_repay_weth: user={user_address[:10]}..., amount={amount_weth:.6f} WETH")
    return delegated_repay(user_address, WETH_ADDRESS, amount_wei, interest_rate_mode=2)


def delegated_withdraw_usdt(user_address: str, amount_usdt: float) -> str:
    amount_raw = int(amount_usdt * 10**6)
    logger.info(f"delegated_withdraw_usdt: user={user_address[:10]}..., amount={amount_usdt:.2f} USDT")
    return delegated_withdraw(user_address, USDT_ADDRESS, amount_raw)
