"""
Configuration Constants for Arbitrum DeFi Agent
Centralized configuration management — USDC Tax Mode (Pay Yourself First → WALLET_B)
"""

# Minimum ETH requirements for operations
MIN_ETH_FOR_OPERATIONS = 0.001
MIN_ETH_FOR_GAS_BUFFER = 0.0005

# Health factor thresholds — Conservative USDC Tax Mode
MIN_HEALTH_FACTOR = 2.90
TARGET_HEALTH_FACTOR = 3.10
SAFE_HEALTH_FACTOR = 3.10
HEALTH_FACTOR_THRESHOLD = 2.90
MIN_HEALTH_FACTOR_GROWTH = 3.10
MIN_HEALTH_FACTOR_MACRO = 3.05
MIN_HEALTH_FACTOR_MICRO = 3.00
MIN_HEALTH_FACTOR_CAPACITY = 2.90

# Operational limits
MAX_CONSECUTIVE_FAILURES = 3
OPERATION_COOLDOWN = 130
OPERATION_COOLDOWN_SECONDS = 130
MONITORING_CYCLE_SECONDS = 45

# Gas optimization settings
DEFAULT_GAS_LIMIT = 200000
DEFAULT_GAS_PRICE = 100000000  # 0.1 gwei in wei
DEFAULT_GAS_PRICE_GWEI = 0.1
DEFAULT_GAS_MULTIPLIER = 1.2
EMERGENCY_GAS_MULTIPLIER = 2.0

# Borrowing parameters
MIN_BORROW_AMOUNT = 0.5
MIN_BORROW_AMOUNT_USD = 0.5
MAX_BORROW_AMOUNT = 100.0
MAX_BORROW_AMOUNT_USD = 100.0
MAX_BORROW_PERCENTAGE = 0.8
GROWTH_TRIGGER_THRESHOLD = 12.0
GROWTH_TRIGGER_THRESHOLD_USD = 12.0
COOLDOWN_PERIOD = 130

# Fixed-value distribution amounts (canonical values in config.py DISTRIBUTIONS)
from config import DISTRIBUTIONS
GROWTH_BORROW_AMOUNT = DISTRIBUTIONS["GROWTH"]["borrow_amount"]
CAPACITY_BORROW_AMOUNT = DISTRIBUTIONS["CAPACITY"]["borrow_amount"]
GROWTH_MIN_CAPACITY = 13.0
CAPACITY_MIN_CAPACITY = 8.0

# USDC Tax — extra $1.20 added to every borrow, swapped to USDC and sent to WALLET_B
USDC_TAX_AMOUNT = 1.20
USDC_HARVEST_TARGET = 22.00

# Slippage
MAX_SLIPPAGE_PERCENT = 2.0

# Network configuration
ARBITRUM_MAINNET_CHAIN_ID = 42161
ARBITRUM_SEPOLIA_CHAIN_ID = 421614

# Aave Oracle (primary price source)
AAVE_ORACLE_ADDRESS = "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7"

# Token allocation for swaps (percentages) - Growth path
GROWTH_DAI_SUPPLY = 3.00
GROWTH_WBTC_SWAP_SUPPLY = 3.00
GROWTH_WETH_SWAP_SUPPLY = 2.00
GROWTH_ETH_GAS_RESERVE = 1.10
GROWTH_DAI_TRANSFER = 1.10

# Token allocation for swaps - Capacity path
CAPACITY_DAI_SUPPLY = 1.10
CAPACITY_WBTC_SWAP_SUPPLY = 1.10
CAPACITY_WETH_SWAP_SUPPLY = 1.10
CAPACITY_ETH_GAS_RESERVE = 1.10
CAPACITY_DAI_TRANSFER = 1.10

# Validation thresholds
MIN_COLLATERAL_USD = 10.0
MAX_DEBT_RATIO = 0.75

# RPC settings
RPC_TIMEOUT_SECONDS = 30
MAX_RPC_RETRIES = 3
MAX_RETRIES = 3
RETRY_DELAY = 2

# API configuration
REQUEST_TIMEOUT = 10
PRICE_CACHE_DURATION = 300

# USDT Collateral — used as collateral in Liability Short (replaces DAI collateral)
USDT_ADDRESS = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"
USDT_DECIMALS = 6
DAI_DECIMALS = 18
WETH_DECIMALS = 18

# USDC Whitelist — Nurse/restore_health must NEVER sweep USDC (sent to WALLET_B)
USDC_WHITELIST = True

# Delegation Mode — Dynamic Target Wallet
import os

def get_target_wallet():
    """
    Determine the target wallet for monitoring and operations.
    
    Reads TARGET_WALLET_ADDRESS from environment variables.
    - If set: Delegation Mode — bot operates on behalf of that wallet
    - If not set: Self-Trade Mode — bot uses its own wallet
    
    Returns:
        str or None: Checksummed target wallet address, or None for Self-Trade
    """
    target = os.getenv('TARGET_WALLET_ADDRESS', '').strip()
    if target and len(target) == 42 and target.startswith('0x'):
        try:
            from web3 import Web3
            return Web3.to_checksum_address(target)
        except Exception:
            return target
    return None

def get_delegation_mode():
    """Return current delegation mode label."""
    target = get_target_wallet()
    if target:
        return f"DELEGATION MODE (target: {target[:10]}...{target[-4:]})"
    return "SELF-TRADE MODE (private key)"

print("✅ Configuration constants loaded successfully")
