
import os

MIN_ETH_FOR_OPERATIONS = 0.001
MIN_ETH_FOR_GAS_BUFFER = 0.0005

MIN_HEALTH_FACTOR = 1.5
TARGET_HEALTH_FACTOR = 1.5
EMERGENCY_HEALTH_FACTOR = 1.5

COLLATERAL_GROWTH_TRIGGER_USD = 13.0
MAIN_TRIGGER_THRESHOLD = 13.0

MAX_BORROW_PERCENTAGE = 0.8
MAX_RETRY_ATTEMPTS = 3

DEFAULT_GAS_PRICE_GWEI = 0.1
GAS_PRICE_MULTIPLIER = 1.2

MIN_ETH_GAS_THRESHOLD = 0.005

OPERATION_COOLDOWN = 130
EMERGENCY_COOLDOWN = 300

DEFAULT_TIMEOUT = 30
MAX_RETRIES = 3

DISTRIBUTIONS = {
    "GROWTH": {
        "borrow_amount": 11.40,
        "tax_usdc": 1.20,
        "gas_reserve_eth": 1.10,
        "wallet_s_dai": 1.10,
        "collateral_wbtc": 2.80,
        "collateral_weth": 2.45,
        "collateral_usdt": 2.75,
    },
    "CAPACITY": {
        "borrow_amount": 6.70,
        "tax_usdc": 1.20,
        "gas_reserve_eth": 1.10,
        "wallet_s_dai": 1.10,
        "collateral_wbtc": 1.10,
        "collateral_weth": 1.10,
        "collateral_usdt": 1.10,
    },
}

SHORT_CONFIG = {
    "MACRO": {
        "borrow_amount": 10.90,
        "allocation": {
            "wbtc": 0.40,
            "usdt": 0.35,
            "weth": 0.25,
        },
    },
    "MICRO": {
        "borrow_amount": 7.20,
        "allocation": {
            "wbtc": 0.40,
            "usdt": 0.35,
            "weth": 0.25,
        },
    },
}

SHORT_CLOSE_SPLIT = {
    "wallet_s_dai_pct": 0.20,
    "wallet_b_usdc_pct": 0.20,
    "collateral_usdt_pct": 0.60,
}

VELOCITY_CONFIG = {
    "buffer_minutes": 40,
    "sample_interval_seconds": 60,
    "micro": {
        "drop_usd": 30.00,
        "window_minutes": 20,
        "cooldown_seconds": 14400,
    },
    "macro": {
        "drop_usd": 50.00,
        "window_minutes": 30,
        "cooldown_seconds": 43200,
    },
}

REAL_ESTATE_CONFIG = {
    "schedule_timezone": "US/Eastern",
    "tasks": {
        "searchiqs_ingest": {"hour": 7, "minute": 0},
        "analysis": {"hour": 7, "minute": 30},
        "reviews": {"hour": 8, "minute": 0},
        "outreach": {"hour": 8, "minute": 30},
    },
    "towns": {
        "Hartford": {
            "code": "CTHAR",
            "base_url": "https://www.searchiqs.com/CTHAR",
            "county": "Hartford",
            "analysis_doc_id": "1TVvVZevNXYZv2Ziw2rxvSIWzTTzwRBQmw4VGZidRJQY",
        },
        "East Hartford": {
            "code": "CTEHART",
            "base_url": "https://www.searchiqs.com/CTEHART",
            "county": "Hartford",
            "analysis_doc_id": "1VRbmvEl4jNceaztihhgXOEDE2LMYZVbpx6zKRyfZJPM",
        },
        "Windsor": {
            "code": "CTWSR",
            "base_url": "https://www.searchiqs.com/CTWSR",
            "county": "Hartford",
            "analysis_doc_id": "1EbXMPnIJ_F9VwUEkn9If_qWwipLNcS-0v6eN45p63WI",
        },
        "Berlin": {
            "code": "CTBER",
            "base_url": "https://www.searchiqs.com/CTBER",
            "county": "Hartford",
            "analysis_doc_id": "1y1crqKFU8_5e7xUOQTKiwa3WP5bI2DULNMNglsW-U88",
        },
        "Rocky Hill": {
            "code": "CTROCK",
            "base_url": "https://www.searchiqs.com/CTROCK",
            "county": "Hartford",
            "analysis_doc_id": "1hnB67ElPvqE4xpKoalORIGMGvejLWBut0AePsOWIMm0",
        },
    },
    "lookback_days": 30,
    "google_drive_folder_id": "128JqjJpDrSkV9ZyylFIICT-MJK5tBxOg",
    "raw_data_sheet_id": "1mxQKY-AgXPXoJyFJBJHFUat-PwxYXzy4XVqqGZPPn0o",
    "logic_doc_id": "1wl8giSw0S-6LvzUz24cbO61JKNuuDO7Kd9kA9aE5URA",
    "review_template_doc_id": os.getenv("GOOGLE_REVIEW_TEMPLATE_ID", "1loKYjBFEUjfhlfYFwjdZ4SODiU9fMxwcg3N17bIfkIY"),
    "equity_thresholds": {
        "high": 50000,
        "medium": 20000,
    },
    "rehab_cost_pct": 0.05,
    "closing_costs": 10000,
}

PERPLEXITY_CONFIG = {
    "api_url": "https://api.perplexity.ai/chat/completions",
    "model": "llama-3.1-sonar-small-128k-online",
    "max_tokens": 2048,
    "temperature": 0.2,
}


def to_token_amount(usd_amount: float, price: float, decimals: int) -> int:
    raw = usd_amount / price * (10 ** decimals)
    return int(raw)


print("✅ Config module loaded successfully (canonical)")
