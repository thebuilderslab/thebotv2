import os

"""
Delegation Permissions Audit & Full-Automation Profile
======================================================
Derived from a full audit of the strategy engine, delegation client,
and auto-supply modules. Any new strategy or token MUST update these
tables.

On-chain contract: REAADelegationManager (Arbitrum mainnet)
  Address: Loaded from DELEGATION_MANAGER_ADDRESS env var
  Flags are WALLET-LEVEL (single set per wallet, not per-token).

Wallet Profiles:
  PERSONAL_BOT — the bot's own wallet. Executes all strategies directly.
    - Profit Bucket: ENABLED (USDC auto-flushes to Wallet_B at $22 threshold)
    - Liability Short close: 20/20/60 split (20% Wallet_S as DAI, 20% Wallet_B as USDC, 60% Aave collateral)

  USER_WALLET — delegated user wallets via REAADelegationManager.
    - Profit Bucket: DISABLED (USDC stays in user wallet, never flushed)
    - Liability Short close: 20/20/30/20/10 split — 20% Wallet_S (DAI), 20% USDC (user wallet),
      30% WBTC (supplied to Aave), 20% WETH (supplied to Aave), 10% USDT (supplied to Aave).
      Only Wallet_S and USDC are direct wallet transfers; WBTC/WETH/USDT are Aave supplies.
      Residual WETH → ETH sent to user wallet as gas/safety net.
      Each slice executes independently (best-effort); Nurse Mode cleans up leftovers.

These are the ONLY two intentional behavior differences. All other execution
logic (Growth 6-step, Capacity 6-step, Nurse Mode sweep, Short entry,
HF thresholds, distribution percentages) is identical.

Audit date: 2026-02-19
"""

WBTC_ADDRESS = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f"
DAI_ADDRESS  = "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"
WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
USDT_ADDRESS = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"

DELEGATION_MANAGER_ADDRESS = os.environ.get("DELEGATION_MANAGER_ADDRESS", "")
AAVE_POOL_ADDRESS = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
UNISWAP_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564"

TOKEN_PERMISSIONS = {
    "WBTC": {
        "address": WBTC_ADDRESS,
        "decimals": 8,
        "can_monitor": True,
        "can_supply": True,
        "can_borrow": False,
        "can_repay": False,
        "can_withdraw": False,
        "used_by": ["auto_supply", "growth_swap_supply", "capacity_swap_supply", "short_entry_swap_supply", "nurse_sweep"],
        "notes": "Primary collateral. Auto-supplied on delegation activation. Swap target for Growth/Capacity/Short entry.",
    },
    "DAI": {
        "address": DAI_ADDRESS,
        "decimals": 18,
        "can_monitor": True,
        "can_supply": True,
        "can_borrow": True,
        "can_repay": True,
        "can_withdraw": False,
        "used_by": ["growth", "capacity", "nurse_sweep", "wallet_s_transfer", "usdc_tax_swap"],
        "notes": "Borrowed by Growth/Capacity. Supplied to Aave. Swapped to WBTC/WETH/ETH/USDC. Transferred to Wallet_S.",
    },
    "WETH": {
        "address": WETH_ADDRESS,
        "decimals": 18,
        "can_monitor": True,
        "can_supply": True,
        "can_borrow": True,
        "can_repay": True,
        "can_withdraw": False,
        "used_by": ["macro_short", "micro_short", "growth_swap_supply", "capacity_swap_supply", "nurse_sweep"],
        "notes": "Borrowed for shorts. Swap target from Growth/Capacity DAI. Supplied to Aave as collateral.",
    },
    "USDT": {
        "address": USDT_ADDRESS,
        "decimals": 6,
        "can_monitor": True,
        "can_supply": True,
        "can_borrow": False,
        "can_repay": False,
        "can_withdraw": True,
        "used_by": ["short_entry_swap_supply", "short_close_withdraw", "nurse_sweep"],
        "notes": "Short entry collateral (WETH->USDT swap). Withdrawn on short close. Swept by Nurse Mode.",
    },
    "USDC": {
        "address": USDC_ADDRESS,
        "decimals": 6,
        "can_monitor": True,
        "can_supply": False,
        "can_borrow": False,
        "can_repay": False,
        "can_withdraw": False,
        "used_by": [],
        "notes": "Profit token. Stays in user wallet from Growth/Capacity USDC tax. NEVER swept by bot. No Profit Bucket for user wallets.",
    },
}

FULL_AUTOMATION = {
    "isActive": True,
    "allowSupply": True,
    "allowBorrow": True,
    "allowRepay": True,
    "allowWithdraw": True,
}

REQUIRED_FLAGS = ["allowSupply", "allowBorrow", "allowRepay", "allowWithdraw"]

REQUIRED_APPROVALS = {
    "description": "Users must grant infinite ERC20 approvals to exactly 3 contracts",
    "contracts": {
        "DelegationManager": DELEGATION_MANAGER_ADDRESS,
        "Aave Pool": AAVE_POOL_ADDRESS,
        "Uniswap Router": UNISWAP_ROUTER_ADDRESS,
    },
    "tokens": ["DAI", "WETH", "WBTC", "USDC", "USDT"],
    "notes": "Missing approvals = structured error, no partial execution.",
}

STRATEGY_MAP = {
    "growth": {
        "description": "Borrow DAI when collateral appreciates significantly. Full 6-step distribution.",
        "hf_threshold": 3.10,
        "borrow_usd": 11.40,
        "tokens": ["DAI", "WBTC", "WETH", "USDC"],
        "actions": ["borrow", "supply", "swap", "transfer"],
        "required_flags": ["allowBorrow", "allowSupply"],
        "steps": [
            "1. Borrow $11.40 DAI via delegation",
            "2. Pull $2.75 DAI -> supply to Aave onBehalfOf",
            "3. Pull $2.80 DAI -> swap DAI->WBTC -> supply onBehalfOf",
            "4. Pull $2.45 DAI -> swap DAI->WETH -> supply onBehalfOf",
            "5. $1.10 DAI stays in user wallet for gas",
            "6. Pull $1.10 DAI -> transfer to Wallet_S",
            "7. Pull $1.20 DAI -> swap DAI->USDC -> stays in user wallet",
        ],
    },
    "capacity": {
        "description": "Smaller DAI borrow to utilize idle borrowing capacity. Same 6-step engine.",
        "hf_threshold": 2.90,
        "borrow_usd": 6.70,
        "tokens": ["DAI", "WBTC", "WETH", "USDC"],
        "actions": ["borrow", "supply", "swap", "transfer"],
        "required_flags": ["allowBorrow", "allowSupply"],
        "steps": [
            "1. Borrow $6.70 DAI via delegation",
            "2. Pull $1.10 DAI -> supply to Aave onBehalfOf",
            "3. Pull $1.10 DAI -> swap DAI->WBTC -> supply onBehalfOf",
            "4. Pull $1.10 DAI -> swap DAI->WETH -> supply onBehalfOf",
            "5. $1.10 DAI stays in user wallet for gas",
            "6. Pull $1.10 DAI -> transfer to Wallet_S",
            "7. Pull $1.20 DAI -> swap DAI->USDC -> stays in user wallet",
        ],
    },
    "macro_short": {
        "description": "Hedge via WETH borrow against major market downturn ($50 velocity drop in 30 min)",
        "hf_threshold": 3.05,
        "short_size_usd": 15.0,
        "tokens": ["WETH", "WBTC", "USDT"],
        "actions": ["borrow", "swap", "supply"],
        "required_flags": ["allowBorrow", "allowSupply"],
        "entry_allocation": "40% WBTC, 35% USDT, 25% WETH collateral",
        "close_personal_bot": "20% Wallet_S (DAI), 20% Wallet_B (USDC), 60% Aave collateral",
        "close_user_wallet": "20% Wallet_S (DAI), 20% USDC (wallet), 30% WBTC (Aave supply), 20% WETH (Aave supply), 10% USDT (Aave supply). Residual WETH→ETH to user. Per-slice best-effort.",
    },
    "micro_short": {
        "description": "Smaller WETH hedge against minor market dip ($30 velocity drop in 20 min, 4h cooldown)",
        "hf_threshold": 3.00,
        "short_size_usd": 8.0,
        "tokens": ["WETH", "WBTC", "USDT"],
        "actions": ["borrow", "swap", "supply"],
        "required_flags": ["allowBorrow", "allowSupply"],
        "entry_allocation": "40% WBTC, 35% USDT, 25% WETH collateral",
        "close_personal_bot": "20% Wallet_S (DAI), 20% Wallet_B (USDC), 60% Aave collateral",
        "close_user_wallet": "20% Wallet_S (DAI), 20% USDC (wallet), 30% WBTC (Aave supply), 20% WETH (Aave supply), 10% USDT (Aave supply). Residual WETH→ETH to user. Per-slice best-effort.",
    },
    "auto_supply": {
        "description": "Auto-supply WBTC to Aave on delegation activation",
        "hf_threshold": None,
        "tokens": ["WBTC"],
        "actions": ["supply"],
        "required_flags": ["allowSupply"],
    },
    "nurse_sweep": {
        "description": "Sweep idle DAI/WETH/WBTC/USDT to Aave. $2 floor. NEVER touches USDC.",
        "hf_threshold": None,
        "tokens": ["DAI", "WETH", "WBTC", "USDT"],
        "actions": ["supply"],
        "required_flags": ["allowSupply"],
    },
    "emergency": {
        "description": "Alert when HF drops below emergency threshold",
        "hf_threshold": 2.50,
        "tokens": [],
        "actions": ["alert"],
        "required_flags": [],
    },
}

WALLET_PROFILES = {
    "PERSONAL_BOT": {
        "description": "Bot's own wallet. Direct execution.",
        "profit_bucket": True,
        "profit_bucket_threshold_usdc": 22.0,
        "profit_bucket_destination": "Wallet_B",
        "short_close_profit_split": {
            "wallet_s_pct": 0.20,
            "wallet_s_token": "DAI",
            "wallet_b_pct": 0.20,
            "wallet_b_token": "USDC",
            "collateral_pct": 0.60,
            "collateral_token": "USDT->Aave",
        },
        "growth_capacity_usdc_tax": "stays in bot wallet, flushed via Profit Bucket",
    },
    "USER_WALLET": {
        "description": "Delegated user wallets via REAADelegationManager.",
        "profit_bucket": False,
        "profit_bucket_threshold_usdc": None,
        "profit_bucket_destination": None,
        "short_close_profit_split": {
            "wallet_s_pct": 0.20,
            "wallet_s_token": "DAI",
            "wallet_s_destination": "Wallet_S (transfer)",
            "usdc_pct": 0.20,
            "usdc_destination": "user_wallet (transfer)",
            "wbtc_pct": 0.30,
            "wbtc_destination": "Aave supply onBehalfOf user",
            "weth_supply_pct": 0.20,
            "weth_destination": "Aave supply onBehalfOf user",
            "usdt_pct": 0.10,
            "usdt_destination": "Aave supply onBehalfOf user",
            "residual": "Any leftover WETH → ETH sent to user wallet as gas/safety net",
            "execution_model": "per-slice best-effort, not atomic; failures leave WETH for residual sweep",
            "nurse_mode_interaction": "Nurse Mode sweeps stray DAI/WETH/WBTC/USDT into Aave over time",
            "note": "20% Wallet_S (DAI), 20% USDC (wallet), 30% WBTC (supplied), 20% WETH (supplied), 10% USDT (supplied) = 100%",
        },
        "growth_capacity_usdc_tax": "stays in user wallet permanently (user claims manually)",
    },
}

PARITY_DIFFERENCES = {
    "count": 2,
    "description": "Two intentional behavior differences between personal bot and user wallets",
    "differences": [
        {
            "id": 1,
            "feature": "Profit Bucket",
            "personal_bot": "ENABLED — USDC accumulates, auto-flushes to Wallet_B at $22",
            "user_wallet": "DISABLED — USDC stays in user wallet permanently, never flushed",
        },
        {
            "id": 2,
            "feature": "Liability Short Close Profit Distribution",
            "personal_bot": "20/20/60 split — 20% Wallet_S (DAI), 20% Wallet_B (USDC), 60% Aave collateral (USDT)",
            "user_wallet": "20/20/30/20/10 split — 20% Wallet_S (DAI), 20% USDC (user wallet), 30% WBTC (Aave supply), 20% WETH (Aave supply), 10% USDT (Aave supply). Residual WETH→ETH to user wallet. Per-slice best-effort.",
        },
    ],
}


def validate_full_automation(on_chain_perms: dict) -> dict:
    """
    Compare on-chain permissions against the FULL_AUTOMATION profile.
    Returns {"valid": True/False, "missing_flags": [...], "details": str}
    """
    if not on_chain_perms.get("isActive"):
        return {
            "valid": False,
            "missing_flags": ["isActive"],
            "details": "Delegation not active on-chain",
        }

    missing = []
    for flag in REQUIRED_FLAGS:
        if not on_chain_perms.get(flag, False):
            missing.append(flag)

    if missing:
        return {
            "valid": False,
            "missing_flags": missing,
            "details": f"Missing permissions: {', '.join(missing)}",
        }

    return {"valid": True, "missing_flags": [], "details": "Full automation verified"}
