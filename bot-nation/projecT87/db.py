import os
import json
import secrets
import hashlib
import psycopg2
from psycopg2.extras import RealDictCursor
from contextlib import contextmanager
from datetime import datetime, timezone

DATABASE_URL = os.environ.get("DATABASE_URL")

@contextmanager
def get_conn():
    conn = psycopg2.connect(DATABASE_URL)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

@contextmanager
def get_cursor(commit=True):
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        try:
            yield cur
        finally:
            cur.close()

def init_db():
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            wallet_address VARCHAR(42) UNIQUE NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            last_seen TIMESTAMPTZ DEFAULT NOW(),
            bot_enabled BOOLEAN NOT NULL DEFAULT true
        );
        ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN NOT NULL DEFAULT true;

        CREATE TABLE IF NOT EXISTS towns (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) UNIQUE NOT NULL,
            code VARCHAR(20) NOT NULL,
            base_url TEXT NOT NULL,
            state VARCHAR(2) DEFAULT 'CT',
            county VARCHAR(50) DEFAULT 'Hartford'
        );

        CREATE TABLE IF NOT EXISTS user_towns (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            town_id INTEGER REFERENCES towns(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(user_id, town_id)
        );

        CREATE TABLE IF NOT EXISTS filings (
            id SERIAL PRIMARY KEY,
            town_id INTEGER REFERENCES towns(id) ON DELETE CASCADE,
            property_address TEXT,
            seller TEXT,
            lender TEXT,
            recording_date DATE,
            book_page VARCHAR(100),
            original_mortgage TEXT,
            court_case_number VARCHAR(100),
            debt_amount VARCHAR(100),
            return_date VARCHAR(100),
            status VARCHAR(50) DEFAULT 'PENDING',
            source TEXT NOT NULL DEFAULT 'searchiqs',
            raw_data JSONB DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        ALTER TABLE filings ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'searchiqs';
        ALTER TABLE towns ADD COLUMN IF NOT EXISTS last_scrape_status TEXT DEFAULT NULL;
        ALTER TABLE towns ADD COLUMN IF NOT EXISTS last_scrape_at TIMESTAMPTZ DEFAULT NULL;

        CREATE TABLE IF NOT EXISTS defi_positions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            wallet_address VARCHAR(42),
            health_factor NUMERIC(20,4),
            total_collateral_usd NUMERIC(14,2),
            total_debt_usd NUMERIC(14,2),
            net_worth_usd NUMERIC(14,2),
            has_active_position BOOLEAN NOT NULL DEFAULT false,
            consecutive_empty_count INTEGER NOT NULL DEFAULT 0,
            positions JSONB DEFAULT '{}',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        ALTER TABLE defi_positions ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(42);
        ALTER TABLE defi_positions ADD COLUMN IF NOT EXISTS consecutive_empty_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE defi_positions ADD COLUMN IF NOT EXISTS has_active_position BOOLEAN NOT NULL DEFAULT false;
        DROP INDEX IF EXISTS idx_defi_positions_user_unique;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_defi_positions_user_wallet ON defi_positions (user_id, wallet_address);

        CREATE TABLE IF NOT EXISTS income_events (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            event_type VARCHAR(50) NOT NULL,
            amount_usd NUMERIC(14,4),
            token VARCHAR(20),
            tx_hash VARCHAR(66),
            description TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS lead_notes (
            id SERIAL PRIMARY KEY,
            filing_id INTEGER REFERENCES filings(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            note_type VARCHAR(50) DEFAULT 'analysis',
            content TEXT NOT NULL,
            priority VARCHAR(20) DEFAULT 'medium',
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS pipeline_runs (
            id SERIAL PRIMARY KEY,
            run_type VARCHAR(50) NOT NULL,
            started_at TIMESTAMPTZ DEFAULT NOW(),
            completed_at TIMESTAMPTZ,
            towns_scraped INTEGER DEFAULT 0,
            filings_found INTEGER DEFAULT 0,
            status VARCHAR(20) DEFAULT 'running',
            details JSONB DEFAULT '{}',
            error_message TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_filings_town ON filings(town_id);
        CREATE INDEX IF NOT EXISTS idx_filings_date ON filings(recording_date);
        CREATE INDEX IF NOT EXISTS idx_filings_status ON filings(status);
        CREATE INDEX IF NOT EXISTS idx_user_towns_user ON user_towns(user_id);
        CREATE INDEX IF NOT EXISTS idx_lead_notes_filing ON lead_notes(filing_id);
        ALTER TABLE income_events ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(42);
        CREATE INDEX IF NOT EXISTS idx_income_events_user ON income_events(user_id);
        CREATE INDEX IF NOT EXISTS idx_income_events_wallet ON income_events(wallet_address);
        CREATE INDEX IF NOT EXISTS idx_defi_positions_user ON defi_positions(user_id);

        CREATE TABLE IF NOT EXISTS managed_wallets (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            wallet_address TEXT NOT NULL,
            delegation_status TEXT NOT NULL DEFAULT 'none',
            auto_supply_wbtc BOOLEAN NOT NULL DEFAULT false,
            supplied_wbtc_amount NUMERIC DEFAULT 0,
            last_auto_supply_at TIMESTAMPTZ,
            last_strategy_action TEXT,
            last_strategy_at TIMESTAMPTZ,
            strategy_status VARCHAR(20) NOT NULL DEFAULT 'disabled',
            last_collateral_baseline NUMERIC(14,2) DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(user_id, wallet_address)
        );
        ALTER TABLE managed_wallets ADD COLUMN IF NOT EXISTS last_strategy_action TEXT;
        ALTER TABLE managed_wallets ADD COLUMN IF NOT EXISTS last_strategy_at TIMESTAMPTZ;
        ALTER TABLE managed_wallets ADD COLUMN IF NOT EXISTS strategy_status VARCHAR(20) NOT NULL DEFAULT 'disabled';
        ALTER TABLE managed_wallets ADD COLUMN IF NOT EXISTS last_collateral_baseline NUMERIC(14,2) DEFAULT 0;
        ALTER TABLE managed_wallets ADD COLUMN IF NOT EXISTS delegation_mode VARCHAR(30) DEFAULT NULL;
        ALTER TABLE managed_wallets ADD COLUMN IF NOT EXISTS is_test_wallet BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE managed_wallets ADD COLUMN IF NOT EXISTS delegation_sig TEXT;
        ALTER TABLE managed_wallets ADD COLUMN IF NOT EXISTS delegation_sig_weth TEXT;
        ALTER TABLE managed_wallets ADD COLUMN IF NOT EXISTS delegation_sig_deadline BIGINT;
        ALTER TABLE managed_wallets ADD COLUMN IF NOT EXISTS delegation_sig_submitted BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE managed_wallets ADD COLUMN IF NOT EXISTS delegation_sig_weth_submitted BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE managed_wallets ADD COLUMN IF NOT EXISTS activation_step INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE managed_wallets ADD COLUMN IF NOT EXISTS usdc_vault_approved BOOLEAN NOT NULL DEFAULT false;

        CREATE TABLE IF NOT EXISTS wallet_actions (
            id BIGSERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            wallet_address TEXT NOT NULL,
            action_type TEXT NOT NULL,
            details JSONB NOT NULL DEFAULT '{}',
            tx_hash TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_managed_wallets_active
            ON managed_wallets(delegation_status) WHERE delegation_status = 'active';
        CREATE INDEX IF NOT EXISTS idx_wallet_actions_user
            ON wallet_actions(user_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS api_keys (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            key_hash VARCHAR(128) NOT NULL UNIQUE,
            key_prefix VARCHAR(8),
            label VARCHAR(100) DEFAULT '',
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            last_used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
        CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE status = 'active';

        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            title VARCHAR(200) DEFAULT '',
            message TEXT NOT NULL,
            priority VARCHAR(20) NOT NULL DEFAULT 'info',
            wallet_address TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);

        CREATE TABLE IF NOT EXISTS collateral_snapshots (
            id BIGSERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            wallet_address TEXT NOT NULL,
            collateral_usd NUMERIC(14,2) NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_collateral_snapshots_wallet_time
            ON collateral_snapshots(wallet_address, created_at DESC);

        CREATE TABLE IF NOT EXISTS short_positions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            wallet_address TEXT NOT NULL,
            tier VARCHAR(10) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'open',
            weth_borrowed NUMERIC(20,8) NOT NULL DEFAULT 0,
            entry_collateral NUMERIC(14,2) NOT NULL DEFAULT 0,
            entry_hf NUMERIC(20,4) NOT NULL DEFAULT 0,
            entry_time TIMESTAMPTZ DEFAULT NOW(),
            close_time TIMESTAMPTZ,
            close_details JSONB DEFAULT '{}',
            tx_hash_entry TEXT,
            tx_hash_close TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_short_positions_open
            ON short_positions(wallet_address, status) WHERE status = 'open';

        -- v5.2 new tables
        CREATE TABLE IF NOT EXISTS hf_ledger (
            id BIGSERIAL PRIMARY KEY,
            wallet_address TEXT NOT NULL,
            health_factor NUMERIC(20,4) NOT NULL,
            total_collateral_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
            total_debt_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
            recorded_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_hf_ledger_wallet_time
            ON hf_ledger(wallet_address, recorded_at DESC);

        CREATE TABLE IF NOT EXISTS usdc_balance_ledger (
            id BIGSERIAL PRIMARY KEY,
            wallet_address TEXT NOT NULL,
            wallet_role TEXT NOT NULL DEFAULT 'user',
            usdc_balance NUMERIC(14,6) NOT NULL DEFAULT 0,
            recorded_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_usdc_balance_ledger_wallet_time
            ON usdc_balance_ledger(wallet_address, recorded_at DESC);

        CREATE TABLE IF NOT EXISTS withdrawal_events (
            id BIGSERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            wallet_address TEXT NOT NULL,
            amount_usdc NUMERIC(14,6) NOT NULL DEFAULT 0,
            tx_hash TEXT,
            event_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS repay_events (
            id BIGSERIAL PRIMARY KEY,
            wallet_address TEXT NOT NULL,
            executed_by TEXT NOT NULL,
            usdc_used NUMERIC(14,6) NOT NULL DEFAULT 0,
            dai_received NUMERIC(14,6) NOT NULL DEFAULT 0,
            tx_hash_swap TEXT,
            tx_hash_repay TEXT,
            daily_cap_remaining_before NUMERIC(14,6) NOT NULL DEFAULT 0,
            executed_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_repay_events_wallet_time
            ON repay_events(wallet_address, executed_at DESC);

        CREATE TABLE IF NOT EXISTS usdc_milestones (
            id BIGSERIAL PRIMARY KEY,
            target_usdc NUMERIC(14,2) NOT NULL,
            current_usdc NUMERIC(14,6) NOT NULL DEFAULT 0,
            required_executions INTEGER NOT NULL DEFAULT 0,
            target_timestamp TIMESTAMPTZ,
            percentage_complete NUMERIC(5,2) NOT NULL DEFAULT 0,
            computed_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_usdc_milestones_target
            ON usdc_milestones(target_usdc, computed_at DESC);

        CREATE TABLE IF NOT EXISTS growth_likelihood (
            id BIGSERIAL PRIMARY KEY,
            wallet_address TEXT NOT NULL,
            growth_likelihood_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
            computed_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_growth_likelihood_wallet_time
            ON growth_likelihood(wallet_address, computed_at DESC);

        CREATE TABLE IF NOT EXISTS distribution_state (
            wallet_address TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'idle',
            path_name TEXT,
            step_reached TEXT,
            distribution_json JSONB DEFAULT '{}',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS wallet_cooldowns (
            wallet_address TEXT PRIMARY KEY,
            next_allowed_growth_at TIMESTAMPTZ,
            next_allowed_capacity_at TIMESTAMPTZ,
            next_allowed_macro_short_at TIMESTAMPTZ,
            next_allowed_micro_short_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS hf_repay_deltas (
            id BIGSERIAL PRIMARY KEY,
            wallet_address TEXT NOT NULL,
            repay_event_id BIGINT REFERENCES repay_events(id),
            hf_1h_before NUMERIC(20,4),
            hf_1h_after NUMERIC(20,4),
            delta_hf NUMERIC(20,4),
            computed_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_hf_repay_deltas_wallet
            ON hf_repay_deltas(wallet_address, computed_at DESC);

        -- v5.2 column additions
        ALTER TABLE managed_wallets ADD COLUMN IF NOT EXISTS shield_status_last VARCHAR(8) DEFAULT 'ACTIVE';
        ALTER TABLE wallet_actions ADD COLUMN IF NOT EXISTS details_summary TEXT;
        ALTER TABLE wallet_actions ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'info';
        """)
        cur.close()

def seed_towns():
    towns = [
        ("Hartford", "CTHAR", "https://www.searchiqs.com/CTHAR"),
        ("East Hartford", "CTEHA", "https://www.searchiqs.com/CTEHA"),
        ("Windsor", "CTWIN", "https://www.searchiqs.com/CTWIN"),
        ("Berlin", "CTBER", "https://www.searchiqs.com/CTBER"),
        ("Rocky Hill", "CTROC", "https://www.searchiqs.com/CTROC"),
    ]
    with get_conn() as conn:
        cur = conn.cursor()
        for name, code, base_url in towns:
            cur.execute("""
                INSERT INTO towns (name, code, base_url)
                VALUES (%s, %s, %s)
                ON CONFLICT (name) DO UPDATE SET code=EXCLUDED.code, base_url=EXCLUDED.base_url
            """, (name, code, base_url))
        cur.close()


def upsert_user(wallet_address):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            INSERT INTO users (wallet_address, last_seen)
            VALUES (%s, NOW())
            ON CONFLICT (wallet_address) DO UPDATE SET last_seen = NOW()
            RETURNING id, wallet_address, created_at, last_seen
        """, (wallet_address,))
        user = cur.fetchone()
        cur.close()
        return dict(user)


def get_user_by_wallet(wallet_address):
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT * FROM users WHERE wallet_address = %s", (wallet_address.lower().strip(),))
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else None


def get_user_by_id(user_id):
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else None


def set_bot_enabled(user_id, enabled: bool):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET bot_enabled = %s WHERE id = %s",
                (enabled, user_id),
            )


def is_bot_enabled(user_id) -> bool:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT bot_enabled FROM users WHERE id = %s",
                (user_id,)
            )
            row = cur.fetchone()
            return bool(row[0]) if row else False


def get_all_bot_enabled_users():
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT id, wallet_address FROM users WHERE bot_enabled = true AND wallet_address IS NOT NULL")
        rows = cur.fetchall()
        cur.close()
        return [dict(r) for r in rows]


def get_towns():
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT t.*, COALESCE(fc.cnt, 0) AS filing_count
            FROM towns t
            LEFT JOIN (SELECT town_id, COUNT(*) AS cnt FROM filings GROUP BY town_id) fc
            ON t.id = fc.town_id
            ORDER BY t.name
        """)
        rows = cur.fetchall()
        cur.close()
        result = []
        for r in rows:
            d = dict(r)
            if d.get("last_scrape_at"):
                d["last_scrape_at"] = d["last_scrape_at"].isoformat()
            result.append(d)
        return result


def get_user_towns(user_id):
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT t.* FROM towns t
            JOIN user_towns ut ON ut.town_id = t.id
            WHERE ut.user_id = %s ORDER BY t.name
        """, (user_id,))
        rows = cur.fetchall()
        cur.close()
        return [dict(r) for r in rows]


def set_user_towns(user_id, town_ids):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM user_towns WHERE user_id = %s", (user_id,))
        for tid in town_ids:
            cur.execute("INSERT INTO user_towns (user_id, town_id) VALUES (%s, %s) ON CONFLICT DO NOTHING", (user_id, tid))
        cur.close()


def insert_filing(town_id, data, source="searchiqs"):
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        rec_date = data.get("recording_date") or data.get("recording_date_detail")
        parsed_date = None
        if rec_date:
            for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m-%d-%Y"):
                try:
                    parsed_date = datetime.strptime(rec_date.strip(), fmt).date()
                    break
                except (ValueError, AttributeError):
                    continue
        cur.execute("""
            INSERT INTO filings (town_id, property_address, seller, lender, recording_date,
                book_page, original_mortgage, court_case_number, debt_amount, return_date, status, source, raw_data)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (
            town_id,
            data.get("property_address") or data.get("property_description", "SEE DEED"),
            data.get("seller") or data.get("party1_seller", ""),
            data.get("lender") or data.get("party2_lender", ""),
            parsed_date,
            data.get("book_page", ""),
            data.get("original_mortgage") or data.get("additional_description", ""),
            data.get("court_case_number", ""),
            data.get("debt_amount", ""),
            data.get("return_date", ""),
            data.get("status", "PENDING"),
            source,
            psycopg2.extras.Json(data),
        ))
        row = cur.fetchone()
        cur.close()
        return row["id"]


def get_filings(town_id=None, date_from=None, date_to=None, status=None, page=1, per_page=50):
    conditions = []
    params = []
    if town_id:
        conditions.append("f.town_id = %s")
        params.append(town_id)
    if date_from:
        conditions.append("f.recording_date >= %s")
        params.append(date_from)
    if date_to:
        conditions.append("f.recording_date <= %s")
        params.append(date_to)
    if status:
        conditions.append("f.status = %s")
        params.append(status)

    where = "WHERE " + " AND ".join(conditions) if conditions else ""
    offset = (page - 1) * per_page

    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute(f"SELECT COUNT(*) as total FROM filings f {where}", params)
        total = cur.fetchone()["total"]

        cur.execute(f"""
            SELECT f.*, t.name as town_name
            FROM filings f
            JOIN towns t ON t.id = f.town_id
            {where}
            ORDER BY f.recording_date DESC NULLS LAST, f.id DESC
            LIMIT %s OFFSET %s
        """, params + [per_page, offset])
        rows = cur.fetchall()
        cur.close()

        result = []
        for r in rows:
            d = dict(r)
            if d.get("recording_date"):
                d["recording_date"] = d["recording_date"].isoformat()
            if d.get("created_at"):
                d["created_at"] = d["created_at"].isoformat()
            if d.get("updated_at"):
                d["updated_at"] = d["updated_at"].isoformat()
            result.append(d)

        return {"filings": result, "total": total, "page": page, "per_page": per_page, "pages": (total + per_page - 1) // per_page}


def get_filing_stats():
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT t.id as town_id, t.name as town_name, COUNT(f.id) as filing_count,
                MAX(f.recording_date) as latest_filing
            FROM towns t
            LEFT JOIN filings f ON f.town_id = t.id
            GROUP BY t.id, t.name
            ORDER BY t.name
        """)
        rows = cur.fetchall()
        cur.close()
        result = []
        for r in rows:
            d = dict(r)
            if d.get("latest_filing"):
                d["latest_filing"] = d["latest_filing"].isoformat()
            result.append(d)
        return result


def upsert_defi_position(user_id, health_factor, collateral, debt, net_worth, positions=None, wallet_address=None):
    import logging
    logger = logging.getLogger(__name__)
    if not wallet_address:
        logger.error(f"[DB] upsert_defi_position REJECTED: wallet_address is required (user_id={user_id})")
        return False
    try:
        if health_factor is not None and health_factor > 999.99:
            health_factor = 999.99
        has_active = bool(collateral is not None and float(collateral) >= 0.01)
        if wallet_address:
            wallet_address = wallet_address.lower().strip()
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO defi_positions (user_id, wallet_address, health_factor, total_collateral_usd, total_debt_usd, net_worth_usd, has_active_position, positions, consecutive_empty_count, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0, NOW())
                ON CONFLICT (user_id, wallet_address) DO UPDATE SET
                    health_factor = EXCLUDED.health_factor,
                    total_collateral_usd = EXCLUDED.total_collateral_usd,
                    total_debt_usd = EXCLUDED.total_debt_usd,
                    net_worth_usd = EXCLUDED.net_worth_usd,
                    has_active_position = EXCLUDED.has_active_position,
                    positions = EXCLUDED.positions,
                    consecutive_empty_count = 0,
                    updated_at = NOW()
            """, (user_id, wallet_address, health_factor, collateral, debt, net_worth, has_active, psycopg2.extras.Json(positions or {})))
            cur.close()
        logger.info(f"[DB] upsert_defi_position OK for user {user_id} wallet={wallet_address}: HF={health_factor}, collateral={collateral}, debt={debt}, active={has_active}")
        return True
    except Exception as e:
        logger.error(f"[DB] upsert_defi_position FAILED for user {user_id} wallet={wallet_address}: {e} (HF={health_factor}, collateral={collateral}, debt={debt})")
        return False


CONSECUTIVE_EMPTY_THRESHOLD = 3

def increment_empty_count(user_id, wallet_address=None):
    import logging
    logger = logging.getLogger(__name__)
    if wallet_address:
        wallet_address = wallet_address.lower().strip()
    try:
        with get_conn() as conn:
            cur = conn.cursor()
            if wallet_address:
                cur.execute("""
                    UPDATE defi_positions
                    SET consecutive_empty_count = consecutive_empty_count + 1, updated_at = NOW()
                    WHERE user_id = %s AND wallet_address = %s
                    RETURNING consecutive_empty_count
                """, (user_id, wallet_address))
            else:
                cur.execute("""
                    UPDATE defi_positions
                    SET consecutive_empty_count = consecutive_empty_count + 1, updated_at = NOW()
                    WHERE user_id = %s AND wallet_address IS NULL
                    RETURNING consecutive_empty_count
                """, (user_id,))
            row = cur.fetchone()
            cur.close()
        count = row[0] if row else 0
        logger.info(f"[DB] increment_empty_count for user {user_id} wallet={wallet_address}: count={count}")
        return count
    except Exception as e:
        logger.error(f"[DB] increment_empty_count FAILED for user {user_id} wallet={wallet_address}: {e}")
        return 0


def mark_position_inactive(user_id, wallet_address=None):
    import logging
    logger = logging.getLogger(__name__)
    if wallet_address:
        wallet_address = wallet_address.lower().strip()
    try:
        with get_conn() as conn:
            cur = conn.cursor()
            if wallet_address:
                cur.execute("""
                    UPDATE defi_positions
                    SET has_active_position = false, health_factor = 0, total_collateral_usd = 0,
                        total_debt_usd = 0, net_worth_usd = 0, updated_at = NOW()
                    WHERE user_id = %s AND wallet_address = %s
                """, (user_id, wallet_address))
            else:
                cur.execute("""
                    UPDATE defi_positions
                    SET has_active_position = false, health_factor = 0, total_collateral_usd = 0,
                        total_debt_usd = 0, net_worth_usd = 0, updated_at = NOW()
                    WHERE user_id = %s AND wallet_address IS NULL
                """, (user_id,))
            cur.close()
        logger.info(f"[DB] Marked position inactive for user {user_id} wallet={wallet_address}")
        return True
    except Exception as e:
        logger.error(f"[DB] mark_position_inactive FAILED for user {user_id} wallet={wallet_address}: {e}")
        return False


def reset_supplied_if_withdrawn(user_id, wallet_address):
    import logging
    logger = logging.getLogger(__name__)
    wallet_address = wallet_address.lower().strip()
    try:
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE managed_wallets
                SET supplied_wbtc_amount = 0, updated_at = NOW()
                WHERE user_id = %s AND wallet_address = %s AND supplied_wbtc_amount > 0
            """, (user_id, wallet_address))
            rows = cur.rowcount
            cur.close()
        if rows > 0:
            logger.info(f"[DB] Reset supplied_wbtc_amount to 0 for user {user_id} ({wallet_address[:10]}...) — on-chain withdrawn")
        return rows > 0
    except Exception as e:
        logger.error(f"[DB] reset_supplied_if_withdrawn FAILED for user {user_id}: {e}")
        return False


def update_strategy_status(user_id, wallet_address, action_text):
    import logging
    logger = logging.getLogger(__name__)
    wallet_address = wallet_address.lower().strip()
    try:
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE managed_wallets
                SET last_strategy_action = %s, last_strategy_at = NOW(), updated_at = NOW()
                WHERE user_id = %s AND wallet_address = %s
            """, (action_text, user_id, wallet_address))
            cur.close()
        return True
    except Exception as e:
        logger.error(f"[DB] update_strategy_status FAILED for user {user_id}: {e}")
        return False


def update_strategy_status_field(user_id, wallet_address, status):
    import logging
    logger = logging.getLogger(__name__)
    wallet_address = wallet_address.lower().strip()
    try:
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE managed_wallets
                SET strategy_status = %s, updated_at = NOW()
                WHERE user_id = %s AND wallet_address = %s
            """, (status, user_id, wallet_address))
            cur.close()
        return True
    except Exception as e:
        logger.error(f"[DB] update_strategy_status_field FAILED for user {user_id}: {e}")
        return False


def update_collateral_baseline(user_id, wallet_address, baseline):
    import logging
    logger = logging.getLogger(__name__)
    wallet_address = wallet_address.lower().strip()
    try:
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE managed_wallets
                SET last_collateral_baseline = %s, updated_at = NOW()
                WHERE user_id = %s AND wallet_address = %s
            """, (baseline, user_id, wallet_address))
            cur.close()
        return True
    except Exception as e:
        logger.error(f"[DB] update_collateral_baseline FAILED for user {user_id}: {e}")
        return False


def get_defi_position(user_id, wallet_address=None):
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        if wallet_address:
            wallet_address = wallet_address.lower().strip()
            cur.execute("SELECT * FROM defi_positions WHERE user_id = %s AND wallet_address = %s", (user_id, wallet_address))
        else:
            cur.execute("SELECT * FROM defi_positions WHERE user_id = %s ORDER BY updated_at DESC NULLS LAST LIMIT 1", (user_id,))
        row = cur.fetchone()
        cur.close()
        if row:
            d = dict(row)
            if d.get("updated_at"):
                d["updated_at"] = d["updated_at"].isoformat()
            return d
        return None


def get_all_defi_positions_for_user(user_id):
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT * FROM defi_positions WHERE user_id = %s ORDER BY total_collateral_usd DESC NULLS LAST", (user_id,))
        rows = cur.fetchall()
        cur.close()
        result = []
        for row in rows:
            d = dict(row)
            if d.get("updated_at"):
                d["updated_at"] = d["updated_at"].isoformat()
            result.append(d)
        return result


def add_income_event(user_id, event_type, amount_usd, token=None, tx_hash=None, description=None):
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            INSERT INTO income_events (user_id, event_type, amount_usd, token, tx_hash, description)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (user_id, event_type, amount_usd, token, tx_hash, description))
        row = cur.fetchone()
        cur.close()
        return row["id"]


def get_income_events(user_id, limit=50):
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT * FROM income_events WHERE user_id = %s
            ORDER BY created_at DESC LIMIT %s
        """, (user_id, limit))
        rows = cur.fetchall()
        cur.close()
        result = []
        for r in rows:
            d = dict(r)
            if d.get("created_at"):
                d["created_at"] = d["created_at"].isoformat()
            result.append(d)
        return result


def add_lead_note(filing_id, content, note_type="analysis", priority="medium", user_id=None):
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            INSERT INTO lead_notes (filing_id, user_id, note_type, content, priority)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
        """, (filing_id, user_id, note_type, content, priority))
        row = cur.fetchone()
        cur.close()
        return row["id"]


def get_lead_notes(filing_id):
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT * FROM lead_notes WHERE filing_id = %s ORDER BY created_at DESC", (filing_id,))
        rows = cur.fetchall()
        cur.close()
        result = []
        for r in rows:
            d = dict(r)
            if d.get("created_at"):
                d["created_at"] = d["created_at"].isoformat()
            result.append(d)
        return result


def create_pipeline_run(run_type):
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            INSERT INTO pipeline_runs (run_type) VALUES (%s) RETURNING id
        """, (run_type,))
        row = cur.fetchone()
        cur.close()
        return row["id"]


def complete_pipeline_run(run_id, towns_scraped, filings_found, status="completed", details=None, error=None):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE pipeline_runs SET completed_at = NOW(), towns_scraped = %s, filings_found = %s,
                status = %s, details = %s, error_message = %s
            WHERE id = %s
        """, (towns_scraped, filings_found, status, psycopg2.extras.Json(details or {}), error, run_id))
        cur.close()


def get_latest_pipeline_run():
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT 1")
        row = cur.fetchone()
        cur.close()
        if row:
            d = dict(row)
            for k in ("started_at", "completed_at"):
                if d.get(k):
                    d[k] = d[k].isoformat()
            return d
        return None


def clear_filings_for_town(town_id):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM filings WHERE town_id = %s", (town_id,))
        cur.close()


def replace_filings_for_town(town_id, filings_list):
    import logging
    logger = logging.getLogger(__name__)
    if not filings_list:
        logger.warning(f"[DB] replace_filings_for_town: 0 filings for town_id={town_id}, preserving existing rows")
        return 0
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM filings WHERE town_id = %s AND source = 'searchiqs'", (town_id,))
        deleted = cur.rowcount
        inserted = 0
        for data in filings_list:
            rec_date = data.get("recording_date") or data.get("recording_date_detail")
            parsed_date = None
            if rec_date:
                for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m-%d-%Y"):
                    try:
                        parsed_date = datetime.strptime(rec_date.strip(), fmt).date()
                        break
                    except (ValueError, AttributeError):
                        continue
            cur.execute("""
                INSERT INTO filings (town_id, property_address, seller, lender, recording_date,
                    book_page, original_mortgage, court_case_number, debt_amount, return_date, status, source, raw_data)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'searchiqs', %s)
            """, (
                town_id,
                data.get("property_address") or data.get("property_description", "SEE DEED"),
                data.get("seller") or data.get("party1_seller", ""),
                data.get("lender") or data.get("party2_lender", ""),
                parsed_date,
                data.get("book_page", ""),
                data.get("original_mortgage") or data.get("additional_description", ""),
                data.get("court_case_number", ""),
                data.get("debt_amount", ""),
                data.get("return_date", ""),
                data.get("status", "PENDING"),
                psycopg2.extras.Json(data),
            ))
            inserted += 1
        cur.close()
        logger.info(f"[DB] replace_filings_for_town: town_id={town_id}, deleted={deleted} searchiqs rows, inserted={inserted}, manual rows preserved")
        return inserted


def get_leads_summary():
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT
                COUNT(*) as total_filings,
                COUNT(CASE WHEN ln.priority = 'high' THEN 1 END) as high_priority,
                COUNT(CASE WHEN ln.priority = 'medium' THEN 1 END) as medium_priority,
                COUNT(CASE WHEN ln.priority = 'low' THEN 1 END) as low_priority,
                COUNT(DISTINCT ln.filing_id) as filings_with_notes
            FROM filings f
            LEFT JOIN lead_notes ln ON ln.filing_id = f.id
        """)
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else {}


def get_income_summary(user_id):
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT
                COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN amount_usd ELSE 0 END), 0) AS total_30d,
                COUNT(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 END) AS count_30d,
                COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '60 days' AND created_at < NOW() - INTERVAL '30 days' THEN amount_usd ELSE 0 END), 0) AS total_prev_30d
            FROM income_events WHERE user_id = %s
        """, (user_id,))
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else {"total_30d": 0, "count_30d": 0, "total_prev_30d": 0}


def get_recent_filings_for_towns(town_ids, limit=5):
    if not town_ids:
        return []
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        placeholders = ','.join(['%s'] * len(town_ids))
        cur.execute(f"""
            SELECT f.property_address, f.seller, f.recording_date, t.name as town_name
            FROM filings f JOIN towns t ON t.id = f.town_id
            WHERE f.town_id IN ({placeholders})
            ORDER BY f.recording_date DESC NULLS LAST, f.id DESC
            LIMIT %s
        """, town_ids + [limit])
        rows = cur.fetchall()
        cur.close()
        result = []
        for r in rows:
            d = dict(r)
            if d.get("recording_date"):
                d["recording_date"] = d["recording_date"].isoformat()
            result.append(d)
        return result


def get_filings_last_n_days(days=7, limit=20):
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT f.id, f.property_address, f.seller, f.lender, f.recording_date,
                   f.debt_amount, f.status, f.court_case_number, f.source,
                   t.name as town_name, t.id as town_id
            FROM filings f JOIN towns t ON t.id = f.town_id
            WHERE f.recording_date >= CURRENT_DATE - %s
            ORDER BY f.recording_date DESC NULLS LAST, f.id DESC
            LIMIT %s
        """, (days, limit))
        rows = cur.fetchall()
        cur.close()
        result = []
        for r in rows:
            d = dict(r)
            if d.get("recording_date"):
                d["recording_date"] = d["recording_date"].isoformat()
            result.append(d)
        return result


def count_filings_by_period(days_recent=7, days_total=30):
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT
                COUNT(*) FILTER (WHERE recording_date >= CURRENT_DATE - %s) as recent_count,
                COUNT(*) FILTER (WHERE recording_date >= CURRENT_DATE - %s) as total_count,
                COUNT(*) as all_count
            FROM filings
        """, (days_recent, days_total))
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else {"recent_count": 0, "total_count": 0, "all_count": 0}


def update_town_scrape_status(town_id, status, scrape_at=None):
    if scrape_at is None:
        scrape_at = datetime.now(timezone.utc)
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE towns SET last_scrape_status = %s, last_scrape_at = %s WHERE id = %s
        """, (status, scrape_at, town_id))
        cur.close()


def get_towns_scrape_status():
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT id, name, last_scrape_status, last_scrape_at FROM towns ORDER BY name
        """)
        rows = cur.fetchall()
        cur.close()
        result = []
        for r in rows:
            d = dict(r)
            if d.get("last_scrape_at"):
                d["last_scrape_at"] = d["last_scrape_at"].isoformat()
            result.append(d)
        return result


def upsert_managed_wallet(user_id, wallet_address, auto_supply_wbtc=False, delegation_mode=None):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            INSERT INTO managed_wallets (user_id, wallet_address, delegation_status, auto_supply_wbtc, delegation_mode)
            VALUES (%s, %s, 'none', %s, %s)
            ON CONFLICT (user_id, wallet_address) DO UPDATE SET
                auto_supply_wbtc = EXCLUDED.auto_supply_wbtc,
                delegation_mode = EXCLUDED.delegation_mode,
                updated_at = NOW()
            RETURNING *
        """, (user_id, wallet_address, auto_supply_wbtc, delegation_mode))
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else None


def update_delegation_status(user_id, wallet_address, status):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE managed_wallets
            SET delegation_status = %s, updated_at = NOW()
            WHERE user_id = %s AND wallet_address = %s
        """, (status, user_id, wallet_address))
        cur.close()


def record_wallet_action(user_id, wallet_address, action_type, details, tx_hash=None):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            INSERT INTO wallet_actions (user_id, wallet_address, action_type, details, tx_hash)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING *
        """, (user_id, wallet_address, action_type, json.dumps(details), tx_hash))
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else None


def get_managed_wallet(user_id, wallet_address):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT * FROM managed_wallets
            WHERE user_id = %s AND wallet_address = %s
        """, (user_id, wallet_address))
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else None


def get_active_managed_wallets():
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT mw.*, u.bot_enabled
            FROM managed_wallets mw
            JOIN users u ON u.id = mw.user_id
            WHERE mw.delegation_status = 'active'
              AND mw.auto_supply_wbtc = true
              AND u.bot_enabled = true
              AND mw.is_test_wallet = false
        """)
        rows = cur.fetchall()
        cur.close()
        return [dict(r) for r in rows]


def get_all_managed_wallets():
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT mw.*, u.bot_enabled
            FROM managed_wallets mw
            JOIN users u ON u.id = mw.user_id
            WHERE mw.is_test_wallet = false
        """)
        rows = cur.fetchall()
        cur.close()
        return [dict(r) for r in rows]


def store_delegation_signature(user_id, wallet_address, signature, deadline, step=4):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        if step == 5:
            cur.execute("""
                UPDATE managed_wallets
                SET delegation_sig_weth = %s,
                    delegation_sig_deadline = %s,
                    activation_step = %s,
                    updated_at = NOW()
                WHERE user_id = %s AND wallet_address = %s
                RETURNING *
            """, (signature, deadline, step, user_id, wallet_address))
        else:
            cur.execute("""
                UPDATE managed_wallets
                SET delegation_sig = %s,
                    delegation_sig_deadline = %s,
                    activation_step = %s,
                    updated_at = NOW()
                WHERE user_id = %s AND wallet_address = %s
                RETURNING *
            """, (signature, deadline, step, user_id, wallet_address))
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else None


def mark_delegation_sig_submitted(user_id, wallet_address, token="DAI"):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor()
        if token == "WETH":
            cur.execute("""
                UPDATE managed_wallets
                SET delegation_sig_weth_submitted = true, updated_at = NOW()
                WHERE user_id = %s AND wallet_address = %s
            """, (user_id, wallet_address))
        else:
            cur.execute("""
                UPDATE managed_wallets
                SET delegation_sig_submitted = true, updated_at = NOW()
                WHERE user_id = %s AND wallet_address = %s
            """, (user_id, wallet_address))
        cur.close()


def reset_delegation_submitted_flags(user_id, wallet_address):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE managed_wallets
            SET delegation_sig_submitted = false,
                delegation_sig_weth_submitted = false,
                updated_at = NOW()
            WHERE user_id = %s AND wallet_address = %s
        """, (user_id, wallet_address))
        cur.close()


def update_activation_step(user_id, wallet_address, step):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE managed_wallets
            SET activation_step = %s, updated_at = NOW()
            WHERE user_id = %s AND wallet_address = %s
        """, (step, user_id, wallet_address))
        cur.close()


def get_wallets_pending_delegation_submit():
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT mw.*, u.bot_enabled
            FROM managed_wallets mw
            JOIN users u ON u.id = mw.user_id
            WHERE mw.delegation_status = 'active'
              AND mw.activation_step >= 4
              AND (
                (mw.delegation_sig IS NOT NULL AND mw.delegation_sig_submitted = false)
                OR
                (mw.delegation_sig_weth IS NOT NULL AND mw.delegation_sig_weth_submitted = false)
              )
        """)
        rows = cur.fetchall()
        cur.close()
        return [dict(r) for r in rows]


def update_managed_wallet_supplied(user_id, wallet_address, amount_wbtc):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE managed_wallets
            SET supplied_wbtc_amount = supplied_wbtc_amount + %s,
                last_auto_supply_at = NOW(),
                updated_at = NOW()
            WHERE user_id = %s AND wallet_address = %s
        """, (amount_wbtc, user_id, wallet_address))
        cur.close()


def get_last_wallet_action(user_id, wallet_address, action_type=None):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        if action_type:
            cur.execute("""
                SELECT * FROM wallet_actions
                WHERE user_id = %s AND wallet_address = %s AND action_type = %s
                ORDER BY created_at DESC LIMIT 1
            """, (user_id, wallet_address, action_type))
        else:
            cur.execute("""
                SELECT * FROM wallet_actions
                WHERE user_id = %s AND wallet_address = %s
                ORDER BY created_at DESC LIMIT 1
            """, (user_id, wallet_address))
        row = cur.fetchone()
        cur.close()
        if row:
            d = dict(row)
            if d.get('created_at'):
                d['created_at'] = d['created_at'].isoformat()
            return d
        return None


MAX_API_KEYS_PER_USER = 2


def _hash_api_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode()).hexdigest()


def count_active_keys(user_id: int) -> int:
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT COUNT(*) FROM api_keys WHERE user_id = %s AND status = 'active'",
            (user_id,),
        )
        count = cur.fetchone()[0]
        cur.close()
        return count


def generate_api_key(user_id: int, label: str = "") -> dict:
    active_count = count_active_keys(user_id)
    if active_count >= MAX_API_KEYS_PER_USER:
        return {"error": f"Maximum {MAX_API_KEYS_PER_USER} active API keys allowed. Revoke an existing key first."}

    raw_key = "oc_" + secrets.token_urlsafe(32)
    key_hash = _hash_api_key(raw_key)
    key_prefix = raw_key[:8]

    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            INSERT INTO api_keys (user_id, key_hash, key_prefix, label, status)
            VALUES (%s, %s, %s, %s, 'active')
            RETURNING id, key_prefix, label, status, created_at
        """, (user_id, key_hash, key_prefix, label))
        row = cur.fetchone()
        cur.close()
        result = dict(row)
        result['raw_key'] = raw_key
        if result.get('created_at'):
            result['created_at'] = result['created_at'].isoformat()
        return result


def validate_api_key(raw_key: str) -> dict:
    key_hash = _hash_api_key(raw_key)
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT ak.id as key_id, ak.user_id, ak.status, u.wallet_address
            FROM api_keys ak
            JOIN users u ON u.id = ak.user_id
            WHERE ak.key_hash = %s AND ak.status = 'active'
        """, (key_hash,))
        row = cur.fetchone()
        if row:
            cur.execute(
                "UPDATE api_keys SET last_used_at = NOW() WHERE id = %s",
                (row['key_id'],),
            )
        cur.close()
        if not row:
            return None
        return dict(row)


def revoke_api_key(key_id: int, user_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE api_keys SET status = 'revoked' WHERE id = %s AND user_id = %s AND status = 'active'",
            (key_id, user_id),
        )
        affected = cur.rowcount
        cur.close()
        return affected > 0


def revoke_all_user_keys(user_id: int) -> int:
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE api_keys SET status = 'revoked' WHERE user_id = %s AND status = 'active'",
            (user_id,),
        )
        affected = cur.rowcount
        cur.close()
        return affected


def list_user_keys(user_id: int) -> list:
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT id, key_prefix, label, status, last_used_at, created_at
            FROM api_keys
            WHERE user_id = %s
            ORDER BY created_at DESC
        """, (user_id,))
        rows = cur.fetchall()
        cur.close()
        result = []
        for r in rows:
            d = dict(r)
            if d.get('created_at'):
                d['created_at'] = d['created_at'].isoformat()
            if d.get('last_used_at'):
                d['last_used_at'] = d['last_used_at'].isoformat()
            result.append(d)
        return result


def create_notification(title: str, message: str, priority: str = "info") -> dict:
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            INSERT INTO notifications (title, message, priority)
            VALUES (%s, %s, %s)
            RETURNING id, title, message, priority, created_at
        """, (title, message, priority))
        row = cur.fetchone()
        cur.close()
        d = dict(row)
        if d.get('created_at'):
            d['created_at'] = d['created_at'].isoformat()
        return d


def add_notification(wallet_address: str, message: str, priority: str = "info", title: str = "") -> dict:
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            INSERT INTO notifications (wallet_address, title, message, priority)
            VALUES (%s, %s, %s, %s)
            RETURNING id, title, message, priority, wallet_address, created_at
        """, (wallet_address.lower(), title, message, priority))
        row = cur.fetchone()
        cur.close()
        d = dict(row)
        if d.get('created_at'):
            d['created_at'] = d['created_at'].isoformat()
        return d


def get_notifications_for_wallet(wallet_address: str, limit: int = 20) -> list:
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT id, title, message, priority, created_at
            FROM notifications
            WHERE wallet_address = %s
            ORDER BY created_at DESC
            LIMIT %s
        """, (wallet_address.lower(), limit))
        rows = cur.fetchall()
        cur.close()
        result = []
        for r in rows:
            d = dict(r)
            if d.get('created_at'):
                d['created_at'] = d['created_at'].isoformat()
            result.append(d)
        return result


def get_notifications(limit: int = 50, since_id: int = None) -> list:
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        if since_id:
            cur.execute("""
                SELECT id, title, message, priority, created_at
                FROM notifications
                WHERE id > %s
                ORDER BY created_at DESC
                LIMIT %s
            """, (since_id, limit))
        else:
            cur.execute("""
                SELECT id, title, message, priority, created_at
                FROM notifications
                ORDER BY created_at DESC
                LIMIT %s
            """, (limit,))
        rows = cur.fetchall()
        cur.close()
        result = []
        for r in rows:
            d = dict(r)
            if d.get('created_at'):
                d['created_at'] = d['created_at'].isoformat()
            result.append(d)
        return result


def get_active_delegated_wallets() -> list:
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT mw.user_id, mw.wallet_address, mw.delegation_status,
                   mw.strategy_status, mw.last_strategy_action, mw.last_strategy_at,
                   u.bot_enabled
            FROM managed_wallets mw
            JOIN users u ON u.id = mw.user_id
            WHERE mw.delegation_status = 'active'
              AND u.bot_enabled = true
            ORDER BY mw.user_id
        """)
        rows = cur.fetchall()
        cur.close()
        result = []
        for r in rows:
            d = dict(r)
            if d.get('last_strategy_at'):
                d['last_strategy_at'] = d['last_strategy_at'].isoformat()
            result.append(d)
        return result


def hard_reset_wallet(user_id: int, wallet_address: str) -> dict:
    results = {"deleted": {}, "errors": []}
    with get_conn() as conn:
        cur = conn.cursor()
        try:
            cur.execute("DELETE FROM wallet_actions WHERE user_id = %s AND wallet_address = %s", (user_id, wallet_address))
            results["deleted"]["wallet_actions"] = cur.rowcount

            cur.execute("DELETE FROM api_keys WHERE user_id = %s", (user_id,))
            results["deleted"]["api_keys"] = cur.rowcount

            cur.execute("DELETE FROM notifications WHERE wallet_address = %s", (wallet_address,))
            results["deleted"]["notifications"] = cur.rowcount

            cur.execute("DELETE FROM defi_positions WHERE user_id = %s AND wallet_address = %s", (user_id, wallet_address))
            results["deleted"]["defi_positions"] = cur.rowcount

            cur.execute("DELETE FROM income_events WHERE user_id = %s", (user_id,))
            results["deleted"]["income_events"] = cur.rowcount

            cur.execute("DELETE FROM collateral_snapshots WHERE user_id = %s AND wallet_address = %s", (user_id, wallet_address))
            results["deleted"]["collateral_snapshots"] = cur.rowcount

            cur.execute("DELETE FROM short_positions WHERE user_id = %s AND wallet_address = %s", (user_id, wallet_address))
            results["deleted"]["short_positions"] = cur.rowcount

            cur.execute("DELETE FROM managed_wallets WHERE user_id = %s AND wallet_address = %s", (user_id, wallet_address))
            results["deleted"]["managed_wallets"] = cur.rowcount

            cur.execute("DELETE FROM repay_events WHERE wallet_address = %s", (wallet_address,))
            results["deleted"]["repay_events"] = cur.rowcount

            cur.execute("DELETE FROM growth_likelihood WHERE wallet_address = %s", (wallet_address,))
            results["deleted"]["growth_likelihood"] = cur.rowcount

            cur.execute("DELETE FROM distribution_state WHERE wallet_address = %s", (wallet_address,))
            results["deleted"]["distribution_state"] = cur.rowcount

            cur.execute("DELETE FROM usdc_milestones")
            results["deleted"]["usdc_milestones"] = cur.rowcount

            cur.close()
            results["success"] = True
        except Exception as e:
            results["errors"].append(str(e))
            results["success"] = False
            cur.close()
    return results


def insert_collateral_snapshot(user_id: int, wallet_address: str, collateral_usd: float):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO collateral_snapshots (user_id, wallet_address, collateral_usd)
            VALUES (%s, %s, %s)
        """, (user_id, wallet_address, collateral_usd))
        cur.close()


def get_collateral_snapshots(wallet_address: str, window_minutes: int = 5) -> list:
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT collateral_usd, created_at
            FROM collateral_snapshots
            WHERE wallet_address = %s
              AND created_at >= NOW() - make_interval(mins => %s)
            ORDER BY created_at ASC
        """, (wallet_address, window_minutes))
        rows = cur.fetchall()
        cur.close()
        return [dict(r) for r in rows]


def prune_collateral_snapshots(max_age_minutes: int = 60):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            DELETE FROM collateral_snapshots
            WHERE created_at < NOW() - make_interval(mins => %s)
        """, (max_age_minutes,))
        deleted = cur.rowcount
        cur.close()
        return deleted


def save_short_position(user_id: int, wallet_address: str, tier: str,
                        weth_borrowed: float, entry_collateral: float,
                        entry_hf: float, tx_hash_entry: str = None) -> int:
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO short_positions
                (user_id, wallet_address, tier, status, weth_borrowed,
                 entry_collateral, entry_hf, tx_hash_entry)
            VALUES (%s, %s, %s, 'open', %s, %s, %s, %s)
            RETURNING id
        """, (user_id, wallet_address, tier, weth_borrowed,
              entry_collateral, entry_hf, tx_hash_entry))
        row = cur.fetchone()
        cur.close()
        return row[0] if row else None


def get_open_short(wallet_address: str) -> dict:
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT * FROM short_positions
            WHERE wallet_address = %s AND status = 'open'
            ORDER BY entry_time DESC
            LIMIT 1
        """, (wallet_address,))
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else None


def close_short_position(short_id: int, tx_hash_close: str = None,
                         close_details: dict = None):
    import json
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE short_positions
            SET status = 'closed', close_time = NOW(),
                tx_hash_close = %s, close_details = %s
            WHERE id = %s
        """, (tx_hash_close, json.dumps(close_details or {}), short_id))
        cur.close()


def get_last_closed_short(wallet_address: str) -> dict:
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT * FROM short_positions
            WHERE wallet_address = %s AND status = 'closed'
            ORDER BY close_time DESC
            LIMIT 1
        """, (wallet_address,))
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else None


def insert_hf_ledger(wallet_address, health_factor, total_collateral_usd=0, total_debt_usd=0):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO hf_ledger (wallet_address, health_factor, total_collateral_usd, total_debt_usd)
            VALUES (%s, %s, %s, %s)
        """, (wallet_address, health_factor, total_collateral_usd, total_debt_usd))
        cur.close()


def insert_usdc_balance_snapshot(wallet_address, usdc_balance, wallet_role='user'):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO usdc_balance_ledger (wallet_address, wallet_role, usdc_balance)
            VALUES (%s, %s, %s)
        """, (wallet_address, wallet_role, usdc_balance))
        cur.close()


def upsert_distribution_state(wallet_address, status, path_name=None, step_reached=None, distribution_json=None):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO distribution_state (wallet_address, status, path_name, step_reached, distribution_json, updated_at)
            VALUES (%s, %s, %s, %s, %s, NOW())
            ON CONFLICT (wallet_address) DO UPDATE SET
                status = EXCLUDED.status,
                path_name = EXCLUDED.path_name,
                step_reached = EXCLUDED.step_reached,
                distribution_json = EXCLUDED.distribution_json,
                updated_at = NOW()
        """, (wallet_address, status, path_name, step_reached, json.dumps(distribution_json or {})))
        cur.close()


def get_distribution_state(wallet_address):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT * FROM distribution_state WHERE wallet_address = %s", (wallet_address,))
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else None


def upsert_wallet_cooldowns(wallet_address, **kwargs):
    wallet_address = wallet_address.lower().strip()
    allowed = {'next_allowed_growth_at', 'next_allowed_capacity_at',
               'next_allowed_macro_short_at', 'next_allowed_micro_short_at'}
    updates = {k: v for k, v in kwargs.items() if k in allowed}
    if not updates:
        return
    col_names = list(updates.keys())
    col_values = list(updates.values())
    set_clauses = ', '.join(f"{k} = %s" for k in col_names)
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(f"""
            INSERT INTO wallet_cooldowns (wallet_address, {', '.join(col_names)}, updated_at)
            VALUES (%s, {', '.join(['%s'] * len(col_names))}, NOW())
            ON CONFLICT (wallet_address) DO UPDATE SET
                {set_clauses},
                updated_at = NOW()
        """, [wallet_address] + col_values + col_values)
        cur.close()


def get_wallet_cooldowns(wallet_address):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT * FROM wallet_cooldowns WHERE wallet_address = %s", (wallet_address,))
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else None


def insert_repay_event(wallet_address, executed_by, usdc_used, dai_received=0,
                       tx_hash_swap=None, tx_hash_repay=None, daily_cap_remaining_before=0):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            INSERT INTO repay_events
                (wallet_address, executed_by, usdc_used, dai_received, tx_hash_swap, tx_hash_repay, daily_cap_remaining_before)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (wallet_address, executed_by, usdc_used, dai_received, tx_hash_swap, tx_hash_repay, daily_cap_remaining_before))
        row = cur.fetchone()
        cur.close()
        return dict(row)['id'] if row else None


def insert_hf_repay_delta(wallet_address, repay_event_id, hf_1h_before=None, hf_1h_after=None):
    wallet_address = wallet_address.lower().strip()
    delta_hf = None
    if hf_1h_before is not None and hf_1h_after is not None:
        delta_hf = float(hf_1h_after) - float(hf_1h_before)
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO hf_repay_deltas (wallet_address, repay_event_id, hf_1h_before, hf_1h_after, delta_hf)
            VALUES (%s, %s, %s, %s, %s)
        """, (wallet_address, repay_event_id, hf_1h_before, hf_1h_after, delta_hf))
        cur.close()


def get_repaid_last_24h(wallet_address):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT COALESCE(SUM(usdc_used), 0)
            FROM repay_events
            WHERE wallet_address = %s
              AND executed_at >= NOW() - INTERVAL '24 hours'
        """, (wallet_address,))
        row = cur.fetchone()
        cur.close()
        return float(row[0]) if row else 0.0


def upsert_usdc_milestone(target_usdc, current_usdc, required_executions, target_timestamp=None, percentage_complete=0):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO usdc_milestones
                (target_usdc, current_usdc, required_executions, target_timestamp, percentage_complete)
            VALUES (%s, %s, %s, %s, %s)
        """, (target_usdc, current_usdc, required_executions, target_timestamp, percentage_complete))
        cur.close()


def get_latest_usdc_milestones():
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT DISTINCT ON (target_usdc) *
            FROM usdc_milestones
            ORDER BY target_usdc, computed_at DESC
        """)
        rows = cur.fetchall()
        cur.close()
        return [dict(r) for r in rows]


def insert_growth_likelihood(wallet_address, growth_likelihood_pct):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO growth_likelihood (wallet_address, growth_likelihood_pct)
            VALUES (%s, %s)
        """, (wallet_address, growth_likelihood_pct))
        cur.close()


def get_latest_growth_likelihood(wallet_address):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT growth_likelihood_pct, computed_at
            FROM growth_likelihood
            WHERE wallet_address = %s
            ORDER BY computed_at DESC LIMIT 1
        """, (wallet_address,))
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else None


def get_hf_history(wallet_address, hours=8):
    wallet_address = wallet_address.lower().strip()
    hours = min(int(hours), 48)
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT health_factor, total_collateral_usd, recorded_at
            FROM hf_ledger
            WHERE wallet_address = %s
              AND recorded_at >= NOW() - INTERVAL '%s hours'
            ORDER BY recorded_at ASC
        """, (wallet_address, hours))
        rows = cur.fetchall()
        cur.close()
        return [dict(r) for r in rows]


def get_hf_at_time(wallet_address, target_time):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            SELECT health_factor, recorded_at
            FROM hf_ledger
            WHERE wallet_address = %s
              AND recorded_at <= %s
            ORDER BY recorded_at DESC LIMIT 1
        """, (wallet_address, target_time))
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else None


def get_equilibrium_metrics(wallet_address: str) -> dict:
    CAPACITY_HF_FLOOR = 3.40
    LT = 0.75
    try:
        wallet_address = wallet_address.lower().strip()
        with get_conn() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("""
                SELECT health_factor, total_collateral_usd, total_debt_usd, recorded_at
                FROM hf_ledger
                WHERE wallet_address = %s
                ORDER BY recorded_at DESC
                LIMIT 30
            """, (wallet_address,))
            rows = [dict(r) for r in cur.fetchall()]
            cur.close()

        if not rows:
            return {}

        current_hf   = float(rows[0]['health_factor'])
        current_col  = float(rows[0]['total_collateral_usd'])
        current_debt = float(rows[0]['total_debt_usd'])

        ordered = list(reversed(rows))
        drops = []
        for i in range(1, len(ordered)):
            delta = float(ordered[i-1]['health_factor']) - float(ordered[i]['health_factor'])
            if delta > 0:
                drops.append(delta)

        avg_drop = sum(drops) / len(drops) if drops else 0.012

        status = "IN_EQUILIBRIUM" if current_hf <= CAPACITY_HF_FLOOR else "ACTIVE"

        cycles_to_floor = None
        time_to_floor_min = None
        if avg_drop > 0 and status == "ACTIVE":
            raw = (current_hf - CAPACITY_HF_FLOOR) / avg_drop
            cycles_to_floor   = round(max(0.0, raw), 1)
            time_to_floor_min = round(cycles_to_floor * 2)

        col_gap_usd = round(max(0.0, current_debt * (CAPACITY_HF_FLOOR / LT) - current_col), 2)
        pct_needed  = round(col_gap_usd / current_col * 100, 2) if current_col > 0 else None

        return {
            "status":                  status,
            "current_hf":              round(current_hf, 4),
            "current_col_usd":         round(current_col, 2),
            "current_debt_usd":        round(current_debt, 2),
            "avg_hf_drop_per_tick":    round(avg_drop, 6),
            "cycles_to_floor":         cycles_to_floor,
            "time_to_floor_min":       time_to_floor_min,
            "col_gap_usd":             col_gap_usd,
            "pct_appreciation_needed": pct_needed,
            "data_points_used":        len(rows),
        }
    except Exception:
        return {}


def get_cycle_pnl_history(wallet_address: str) -> dict:
    try:
        wallet_address = wallet_address.lower().strip()
        with get_conn() as conn:
            cur = conn.cursor(cursor_factory=RealDictCursor)

            cur.execute("""
                SELECT COALESCE(SUM(amount_usd), 0) AS gross,
                       COUNT(*)                      AS event_count
                FROM income_events
                WHERE wallet_address = %s
                  AND event_type     = 'usdc_tax'
                  AND created_at    >= NOW() - INTERVAL '24 hours'
            """, (wallet_address,))
            r24 = dict(cur.fetchone())

            cur.execute("""
                SELECT COALESCE(SUM(usdc_used), 0) AS repaid,
                       COUNT(*)                    AS repay_count
                FROM repay_events
                WHERE wallet_address = %s
                  AND executed_at   >= NOW() - INTERVAL '24 hours'
            """, (wallet_address,))
            p24 = dict(cur.fetchone())

            gross_24h  = float(r24['gross'])
            repaid_24h = float(p24['repaid'])
            events_24h = int(r24['event_count'])
            repays_24h = int(p24['repay_count'])

            cur.execute("""
                SELECT created_at
                FROM income_events
                WHERE wallet_address = %s AND event_type = 'usdc_tax'
                ORDER BY created_at DESC
                LIMIT 20
            """, (wallet_address,))
            recent_events = [dict(r) for r in cur.fetchall()]
            cur.close()

        avg_usdc_per_event = 1.20
        avg_repay_fraction = 0.91
        avg_min_per_event  = 6.0
        last_cycle = None

        if recent_events:
            cycle_from = recent_events[-1]['created_at']
            cycle_to   = recent_events[0]['created_at']
            elapsed_sec = (cycle_to - cycle_from).total_seconds()
            elapsed_min = round(elapsed_sec / 60, 1)
            n_events    = len(recent_events)

            with get_conn() as conn:
                cur = conn.cursor(cursor_factory=RealDictCursor)
                cur.execute("""
                    SELECT COALESCE(SUM(amount_usd), 0) AS gross, COUNT(*) AS cnt
                    FROM income_events
                    WHERE wallet_address = %s
                      AND event_type     = 'usdc_tax'
                      AND created_at    >= %s AND created_at <= %s
                """, (wallet_address, cycle_from, cycle_to))
                ci = dict(cur.fetchone())

                cur.execute("""
                    SELECT COALESCE(SUM(usdc_used), 0) AS repaid, COUNT(*) AS cnt
                    FROM repay_events
                    WHERE wallet_address = %s
                      AND executed_at   >= %s AND executed_at <= %s
                """, (wallet_address, cycle_from, cycle_to))
                cr = dict(cur.fetchone())
                cur.close()

            cyc_gross  = float(ci['gross'])
            cyc_repaid = float(cr['repaid'])
            cyc_events = int(ci['cnt'])
            cyc_repays = int(cr['cnt'])

            last_cycle = {
                "from":        cycle_from.isoformat(),
                "to":          cycle_to.isoformat(),
                "gross_usdc":  round(cyc_gross, 4),
                "repaid_usdc": round(cyc_repaid, 4),
                "net_usdc":    round(cyc_gross - cyc_repaid, 4),
                "events":      cyc_events,
                "repays":      cyc_repays,
                "elapsed_min": elapsed_min,
            }

            if cyc_gross > 0 and cyc_events > 0:
                avg_usdc_per_event = cyc_gross / cyc_events
                avg_repay_fraction = cyc_repaid / cyc_gross
            elif gross_24h > 0 and events_24h > 0:
                avg_usdc_per_event = gross_24h / events_24h
                avg_repay_fraction = repaid_24h / gross_24h if gross_24h > 0 else 0.91

            if n_events >= 2 and elapsed_min > 0:
                avg_min_per_event = round(elapsed_min / (n_events - 1), 2)
            elif events_24h >= 2:
                avg_min_per_event = round(24 * 60 / events_24h, 2)

        fc_gross  = round(10 * avg_usdc_per_event, 2)
        fc_repaid = round(fc_gross * avg_repay_fraction, 2)
        fc_net    = round(fc_gross - fc_repaid, 2)
        fc_time   = round(10 * avg_min_per_event, 1)

        return {
            "gross_usdc_24h":    round(gross_24h, 4),
            "repaid_usdc_24h":   round(repaid_24h, 4),
            "net_usdc_24h":      round(gross_24h - repaid_24h, 4),
            "events_24h":        events_24h,
            "repays_24h":        repays_24h,
            "last_cycle":        last_cycle,
            "forecast_10_events": {
                "gross":    fc_gross,
                "repaid":   fc_repaid,
                "net":      fc_net,
                "time_min": fc_time,
            },
        }
    except Exception:
        return {}


def update_shield_status_last(wallet_address, shield_status):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            UPDATE managed_wallets
            SET shield_status_last = %s, updated_at = NOW()
            WHERE wallet_address = %s
        """, (shield_status, wallet_address))
        cur.close()


def record_wallet_action_v2(user_id, wallet_address, action_type, details, tx_hash=None,
                             details_summary=None, severity='info'):
    wallet_address = wallet_address.lower().strip()
    with get_conn() as conn:
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("""
            INSERT INTO wallet_actions (user_id, wallet_address, action_type, details, tx_hash, details_summary, severity)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        """, (user_id, wallet_address, action_type, json.dumps(details), tx_hash, details_summary, severity))
        row = cur.fetchone()
        cur.close()
        return dict(row) if row else None


def migrate_tmp_execution_states():
    import glob as _glob
    state_files = _glob.glob('/tmp/*_execution_state.json')
    migrated = 0
    for fpath in state_files:
        try:
            with open(fpath, 'r') as f:
                data = json.load(f)
            wallet_address = data.get('wallet_address', '')
            if not wallet_address:
                fname = fpath.replace('/tmp/', '').replace('_execution_state.json', '')
                wallet_address = fname
            status = data.get('status', 'in_progress')
            path_name = data.get('path_name')
            step_reached = data.get('step_reached') or data.get('status')
            upsert_distribution_state(wallet_address, status, path_name, step_reached, data)
            import os as _os
            _os.remove(fpath)
            migrated += 1
        except Exception:
            pass
    return migrated


if __name__ == "__main__":
    print("Initializing database...")
    init_db()
    print("Seeding towns...")
    seed_towns()
    print("Database ready.")
