import os

CHAIN_NAME = "Arbitrum One"
# --- Network Configuration ---
CHAIN_ID = 42161
NETWORK_NAME = "Arbitrum Mainnet"

AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
AAVE_POOL_DATA_PROVIDER = "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654"

WBTC_TOKEN = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f"
USDC_TOKEN = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
DAI_TOKEN = "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"
WETH_TOKEN = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
USDT_TOKEN = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"
ARB_TOKEN = "0x912CE59144191C1204E64559FE8253a0e49E6548"

UNISWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564"

TOKEN_DECIMALS = {
    WBTC_TOKEN: 8,
    DAI_TOKEN: 18,
    WETH_TOKEN: 18,
    USDT_TOKEN: 6,
    USDC_TOKEN: 6,
}

TOKEN_NAMES = {
    WBTC_TOKEN: "WBTC",
    DAI_TOKEN: "DAI",
    WETH_TOKEN: "WETH",
    USDT_TOKEN: "USDT",
    USDC_TOKEN: "USDC",
}

DEFAULT_GAS_PRICE_GWEI = 0.1

ARBITRUM_PUBLIC_RPCS = [
    "https://arbitrum-one.public.blastapi.io",
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum-one.publicnode.com",
]


def get_rpc_url() -> str:
    return (
        os.getenv("ARBITRUM_RPC_URL")
        or os.getenv("ALCHEMY_ARB_RPC")
        or os.getenv("ARB_RPC_URL")
        or os.getenv("TENDERLY_RPC_URL")
        or ARBITRUM_PUBLIC_RPCS[0]
    )


print("Configuration constants loaded successfully")
