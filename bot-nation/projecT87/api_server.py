import logging
import os
import secrets
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.security import APIKeyHeader
from fastapi.middleware.wsgi import WSGIMiddleware
from pydantic import BaseModel, ConfigDict, Field

import db as database
from constants import AAVE_POOL, get_rpc_url

logger = logging.getLogger(__name__)

ALLOWED_BORROW_ASSETS = {"DAI", "USDC", "USDT"}

database.init_db()

class EnhancedWeb3CSPMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        nonce = secrets.token_urlsafe(16)
        if "state" not in scope:
            scope["state"] = {}
        scope["state"]["csp_nonce"] = nonce

        async def send_with_csp(message):
            if message["type"] == "http.response.start":
                headers = dict(
                    (k.lower(), v) for k, v in
                    [(h[0], h[1]) for h in message.get("headers", [])]
                )
                ct = headers.get(b"content-type", b"").decode("utf-8", errors="ignore")

                if "text/html" in ct:
                    csp = (
                        f"default-src 'self'; "
                        f"script-src 'self' 'nonce-{nonce}' 'unsafe-eval' https://*.replit.dev https://cdnjs.cloudflare.com; "
                        f"connect-src 'self' blob: "
                        f"https://arb1.arbitrum.io https://arbitrum.publicnode.com "
                        f"https://virtual.arbitrum.us-east.rpc.tenderly.co "
                        f"https://arb-mainnet.g.alchemy.com https://*.g.alchemy.com "
                        f"https://*.infura.io wss://*.infura.io "
                        f"https://gas.api.metamask.io https://token.api.metamask.io "
                        f"https://api.coinbase.com "
                        f"wss://relay.walletconnect.com https://verify.walletconnect.com "
                        f"https://explorer-api.walletconnect.com; "
                        f"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                        f"font-src 'self' https://fonts.gstatic.com; "
                        f"img-src 'self' data: blob: https:; "
                        f"object-src 'none';"
                    )
                    new_headers = [h for h in message.get("headers", [])
                                   if h[0].lower() != b"content-security-policy"]
                    new_headers.append([b"content-security-policy", csp.encode()])
                    message = {**message, "headers": new_headers}

            await send(message)

        await self.app(scope, receive, send_with_csp)

app = FastAPI(
    title="OpenClaw API",
    version="1.0.0",
    description="Multi-tenant DeFi Infrastructure-as-a-Service API",
)

app.add_middleware(EnhancedWeb3CSPMiddleware)

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def get_authenticated_wallet(api_key: str = Depends(api_key_header)) -> str:
    if not api_key:
        raise HTTPException(status_code=401, detail="Missing X-API-Key header")
    result = database.validate_api_key(api_key)
    if not result:
        raise HTTPException(status_code=401, detail="Invalid or revoked API key")
    wallet = result.get("wallet_address")
    if not wallet:
        raise HTTPException(status_code=401, detail="No wallet associated with this API key")
    return wallet


class BorrowRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    amount: float = Field(..., gt=0, le=10000, description="Amount to borrow in asset units")
    asset: str = Field(..., description="Asset to borrow (DAI, USDC, USDT)")


class HealthResponse(BaseModel):
    wallet_address: str
    health_factor: float
    total_collateral_usd: float
    total_debt_usd: float
    net_worth_usd: float
    available_borrows_usd: float


class BorrowResponse(BaseModel):
    wallet_address: str
    status: str
    mode: str
    action: str
    details: str


class NotificationItem(BaseModel):
    id: int
    title: str
    message: str
    priority: str
    created_at: str


@app.get("/api/v1/vault/health", response_model=HealthResponse)
def vault_health(wallet_address: str = Depends(get_authenticated_wallet)):
    from run_autonomous_mainnet import fetch_aave_position_for_wallet
    position = fetch_aave_position_for_wallet(wallet_address)

    if not position:
        logger.info(f"No live Aave position for {wallet_address[:10]}... — returning demo data")
        return HealthResponse(
            wallet_address=wallet_address,
            health_factor=3.42,
            total_collateral_usd=12480.55,
            total_debt_usd=3644.12,
            net_worth_usd=8836.43,
            available_borrows_usd=5120.00,
        )

    from web3 import Web3
    pool_addr = AAVE_POOL
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
    available_borrows = 0.0
    rpc_url = get_rpc_url()
    try:
        w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={'timeout': 10}))
        if w3.is_connected():
            pool = w3.eth.contract(address=Web3.to_checksum_address(pool_addr), abi=pool_abi)
            data = pool.functions.getUserAccountData(Web3.to_checksum_address(wallet_address)).call()
            available_borrows = round(data[2] / 1e8, 2)
    except Exception as e:
        logger.warning(f"Could not fetch available borrows: {e}")

    return HealthResponse(
        wallet_address=wallet_address,
        health_factor=position["health_factor"],
        total_collateral_usd=position["total_collateral_usd"],
        total_debt_usd=position["total_debt_usd"],
        net_worth_usd=position["net_worth_usd"],
        available_borrows_usd=available_borrows,
    )


@app.post("/api/v1/credit/borrow", response_model=BorrowResponse)
def credit_borrow(req: BorrowRequest, wallet_address: str = Depends(get_authenticated_wallet)):
    if req.asset.upper() not in ALLOWED_BORROW_ASSETS:
        raise HTTPException(
            status_code=422,
            detail=f"Asset '{req.asset}' not supported. Allowed: {', '.join(sorted(ALLOWED_BORROW_ASSETS))}"
        )

    user = database.get_user_by_wallet(wallet_address)
    if not user:
        raise HTTPException(status_code=404, detail="User not found for this wallet")

    user_id = user["id"]

    from run_autonomous_mainnet import fetch_aave_position_for_wallet
    position = fetch_aave_position_for_wallet(wallet_address)

    if not position:
        logger.info(f"No live Aave position for {wallet_address[:10]}... — running simulated borrow")
        try:
            database.add_notification(
                wallet_address=wallet_address,
                title="Simulated Trade Executed",
                message=f"Borrow {req.amount} {req.asset.upper()} — simulated execution (demo mode, no live position)",
                priority="critical",
            )
        except Exception as notif_err:
            logger.warning(f"Failed to log demo borrow notification: {notif_err}")
        return BorrowResponse(
            wallet_address=wallet_address,
            status="executed",
            mode="demo",
            action="SIMULATED_BORROW",
            details=f"Demo mode: simulated borrow of {req.amount} {req.asset.upper()} — no live Aave position detected",
        )

    hf = position.get("health_factor", 0)
    collateral = position.get("total_collateral_usd", 0)
    debt = position.get("total_debt_usd", 0)

    if hf < 2.40:
        return BorrowResponse(
            wallet_address=wallet_address,
            status="rejected",
            mode="risk_check",
            action="SKIP",
            details=f"Health factor {hf:.4f} below minimum threshold 2.40. Cannot borrow."
        )

    try:
        from strategy_engine import run_delegated_strategy, get_strategy_status
        status = get_strategy_status(user_id, wallet_address)
        if status != "active":
            return BorrowResponse(
                wallet_address=wallet_address,
                status="rejected",
                mode="delegation_check",
                action="SKIP",
                details=f"Delegation status is '{status}'. Must be 'active' to borrow."
            )

        result = run_delegated_strategy(
            user_id=user_id,
            wallet_address=wallet_address,
            agent=None,
            run_id="api_borrow",
            iteration=0,
            config={}
        )

        executed = result.get("executed", False)
        status = "executed" if executed else "skipped"

        if executed:
            try:
                database.add_notification(
                    wallet_address=wallet_address,
                    title="Simulated Trade Executed",
                    message=f"Borrow {req.amount} {req.asset.upper()} — strategy executed via API",
                    priority="critical",
                )
            except Exception as notif_err:
                logger.warning(f"Failed to log borrow notification: {notif_err}")

        return BorrowResponse(
            wallet_address=wallet_address,
            status=status,
            mode=result.get("mode", "unknown"),
            action=result.get("action", "UNKNOWN"),
            details=result.get("details", "")
        )

    except Exception as e:
        logger.error(f"Borrow endpoint error for {wallet_address[:10]}...: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Strategy execution error: {str(e)}")


@app.get("/api/v1/notifications", response_model=list[NotificationItem])
def get_notifications(
    wallet_address: str = Depends(get_authenticated_wallet),
    limit: int = Query(default=20, ge=1, le=100),
):
    rows = database.get_notifications_for_wallet(wallet_address, limit=limit)
    return [NotificationItem(**r) for r in rows]


@app.get("/api/v1/health")
def api_health_check():
    return {"status": "ok", "service": "openclaw-api", "version": "1.0.0"}


from web_dashboard import app as flask_app

class NoncePassingWSGIMiddleware:
    def __init__(self, wsgi_app):
        self.wsgi_app = wsgi_app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return

        nonce = (scope.get("state") or {}).get("csp_nonce", "")

        def nonce_injecting_app(environ, start_response):
            environ["HTTP_X_CSP_NONCE"] = nonce
            return self.wsgi_app(environ, start_response)

        bridge = WSGIMiddleware(nonce_injecting_app)
        await bridge(scope, receive, send)

app.mount("/", NoncePassingWSGIMiddleware(flask_app))


def start_server(host: str = "0.0.0.0", port: int = None):
    import uvicorn
    if port is None:
        port = int(os.environ.get("PORT", 5000))
    logger.info(f"🚀 OpenClaw API Server starting on {host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    start_server()
