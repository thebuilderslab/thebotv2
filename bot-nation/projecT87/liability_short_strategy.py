#!/usr/bin/env python3
"""
Liability Short Strategy — Phase 2: Target Profit Engine

PROFIT-FIRST SYSTEM: Works backwards from a target profit to determine
the exact ETH price drop needed before entering a short position.

FLOW (Round Trip — Diversified Collateral 40/35/25):
  Step A (Setup):  Trigger fires → Borrow WETH → Split 40% WBTC / 35% USDT / 25% WETH → Supply all to Aave
  Step B (Hunt):   Poll every 15s → Wait for target_price OR stop-loss
  Step C (Close):  Unwind collateral → Repay loan → 20/20/60 profit distribution

REVERSE CALCULATOR:
  Goal: "I need $10.00 profit"
  Calculate: fees (0.3% entry + 0.3% exit + $0.50 gas) + profit target
  Result: "Market must drop -2.4% to $X price"
  Safety: Abort if required drop > 4% for Micro

COLLATERAL VELOCITY MONITOR (Panic Detection):
  Rolling 40-minute buffer of total collateral values (sampled every ~60s)
  Macro trigger: $50 collateral drop in 30 minutes → $10.90 WETH short (12h cooldown)
  Micro trigger: $30 collateral drop in 20 minutes → $7.20 WETH short (4h cooldown)
  Replaces static percentage-based drop triggers.

PROFIT DISTRIBUTION (Short Close):
  20% → USDT→WETH→DAI → Wallet S
  20% → USDT→USDC → Wallet B
  60% → USDT → Aave collateral

DYNAMIC POLLING:
  IDLE → 90s (Sentry Mode)
  SHORT_ACTIVE → 15s (Hunter Mode)
"""

import os
import json
import time
import logging
from decimal import Decimal
from typing import Dict, Optional, Tuple
from datetime import datetime

logger = logging.getLogger(__name__)

POSITIONS_FILE = "debt_swap_positions.json"

PROFIT_TARGETS = {
    'wallet_s': 2.00,
    'wallet_b': 2.00,
    'collateral': 6.00,
    'total': 10.00,
}

COST_ESTIMATES = {
    'swap_entry_fee_pct': 0.003,
    'swap_exit_fee_pct': 0.003,
    'gas_buffer_usd': 0.50,
}

MACRO_SHORT_SIZE_USD = 10.90
MICRO_SHORT_SIZE_USD = 7.20

VELOCITY_TRIGGERS = {
    'macro': {
        'drop_usd': 50.00,
        'window_minutes': 30,
        'min_health_factor': 3.05,
        'cooldown_seconds': 43200,
    },
    'micro': {
        'drop_usd': 30.00,
        'window_minutes': 20,
        'min_health_factor': 3.00,
        'cooldown_seconds': 14400,
    },
}

VELOCITY_BUFFER_MINUTES = 40
VELOCITY_SAMPLE_INTERVAL = 60

SAFETY_GATES = {
    'micro_max_required_drop_pct': 4.0,
    'macro_max_required_drop_pct': 8.0,
    'stop_loss_pct': 1.5,
}

POLLING_INTERVALS = {
    'IDLE': 90,
    'SHORT_ACTIVE': 15,
}

PHASE2_STEP_ORDER = [
    "weth_borrowed",
    "usdt_swapped",
    "usdt_supplied_as_collateral",
    "short_active",
    "usdt_withdrawn",
    "eth_repurchased",
    "loan_repaid",
    "profit_distributed",
]

SHORT_COOLDOWN_SECONDS = 600


class LiabilityShortStrategy:
    def __init__(self, agent):
        self.agent = agent
        self.positions = self._load_positions()
        self.last_collateral_snapshot = None
        self.last_collateral_snapshot_time = 0
        self.collateral_history = []
        self.max_history = 120
        self.last_macro_trigger_time = 0
        self.last_micro_trigger_time = 0
        logger.info("Liability Short Strategy Phase 2 (Target Profit Engine) initialized")
        logger.info(f"  Velocity Monitor: {VELOCITY_BUFFER_MINUTES}min buffer, sample every {VELOCITY_SAMPLE_INTERVAL}s")
        logger.info(f"  Micro: ${VELOCITY_TRIGGERS['micro']['drop_usd']} drop in {VELOCITY_TRIGGERS['micro']['window_minutes']}min → ${MICRO_SHORT_SIZE_USD} short (4h cooldown)")
        logger.info(f"  Macro: ${VELOCITY_TRIGGERS['macro']['drop_usd']} drop in {VELOCITY_TRIGGERS['macro']['window_minutes']}min → ${MACRO_SHORT_SIZE_USD} short (12h cooldown)")

    def _load_positions(self) -> Dict:
        try:
            if os.path.exists(POSITIONS_FILE):
                with open(POSITIONS_FILE, 'r') as f:
                    return json.load(f)
        except Exception as e:
            logger.error(f"Error loading positions: {e}")
        return {"positions": [], "active_position": None}

    def _save_positions(self):
        try:
            with open(POSITIONS_FILE, 'w') as f:
                json.dump(self.positions, f, indent=2)
        except Exception as e:
            logger.error(f"Error saving positions: {e}")

    def has_active_position(self) -> bool:
        return self.positions.get("active_position") is not None

    def has_partial_position(self) -> bool:
        active = self.positions.get("active_position")
        if active and active.get("status") == "partial":
            return True
        return False

    def get_active_position(self) -> Optional[Dict]:
        return self.positions.get("active_position")

    def get_position_status(self) -> str:
        active = self.get_active_position()
        if not active:
            return "IDLE"
        return active.get("status", "IDLE").upper()

    def get_polling_interval(self) -> int:
        status = self.get_position_status()
        if status == "SHORT_ACTIVE":
            return POLLING_INTERVALS['SHORT_ACTIVE']
        return POLLING_INTERVALS['IDLE']

    def get_eth_price(self) -> Optional[float]:
        try:
            if hasattr(self.agent, 'market_signal_strategy') and self.agent.market_signal_strategy:
                strategy = self.agent.market_signal_strategy
                if hasattr(strategy, 'enhanced_analyzer') and strategy.enhanced_analyzer:
                    analyzer = strategy.enhanced_analyzer
                    if hasattr(analyzer, 'get_market_summary'):
                        summary = analyzer.get_market_summary()
                        if summary and not summary.get('error'):
                            eth_analysis = summary.get('eth_analysis', {})
                            price = eth_analysis.get('price')
                            if price and price > 0:
                                return float(price)

            if hasattr(self.agent, 'get_eth_price_usd'):
                price = self.agent.get_eth_price_usd()
                if price and price > 0:
                    return float(price)

            if hasattr(self.agent, 'aave') and self.agent.aave:
                account_data = self.agent.aave.get_user_account_data()
                if account_data:
                    return None
        except Exception as e:
            logger.error(f"Error fetching ETH price: {e}")
        return None

    def _calculate_required_drop(self, short_size_usd: float, target_profit_usd: float) -> Dict:
        swap_entry_fee = short_size_usd * COST_ESTIMATES['swap_entry_fee_pct']
        swap_exit_fee = short_size_usd * COST_ESTIMATES['swap_exit_fee_pct']
        gas_buffer = COST_ESTIMATES['gas_buffer_usd']

        total_costs = swap_entry_fee + swap_exit_fee + gas_buffer
        gross_revenue_needed = target_profit_usd + total_costs
        required_drop_pct = (gross_revenue_needed / short_size_usd) * 100.0

        eth_price = self.get_eth_price()
        target_price = None
        if eth_price and eth_price > 0:
            target_price = eth_price * (1.0 - required_drop_pct / 100.0)

        stop_loss_price = None
        if eth_price and eth_price > 0:
            stop_loss_price = eth_price * (1.0 + SAFETY_GATES['stop_loss_pct'] / 100.0)

        return {
            'short_size_usd': short_size_usd,
            'target_profit_usd': target_profit_usd,
            'swap_entry_fee': round(swap_entry_fee, 4),
            'swap_exit_fee': round(swap_exit_fee, 4),
            'gas_buffer': gas_buffer,
            'total_costs': round(total_costs, 4),
            'gross_revenue_needed': round(gross_revenue_needed, 4),
            'required_drop_pct': round(required_drop_pct, 4),
            'entry_price': eth_price,
            'target_price': round(target_price, 2) if target_price else None,
            'stop_loss_price': round(stop_loss_price, 2) if stop_loss_price else None,
        }

    def validate_short_entry(self, tier: str, short_size_usd: float) -> Tuple[bool, str, Dict]:
        calc = self._calculate_required_drop(short_size_usd, PROFIT_TARGETS['total'])

        if calc['entry_price'] is None:
            return False, "Cannot determine ETH price — aborting", calc

        max_drop = SAFETY_GATES['micro_max_required_drop_pct'] if tier == "micro" else SAFETY_GATES['macro_max_required_drop_pct']
        if calc['required_drop_pct'] > max_drop:
            return False, f"SAFETY GATE: Required drop {calc['required_drop_pct']:.2f}% > {max_drop:.1f}% max for {tier} — unrealistic target, ABORT", calc

        print(f"\n📉 SHORT TRIGGERED: Target Net Profit ${PROFIT_TARGETS['total']:.2f}")
        print(f"🧮 CALCULATION: Market must drop -{calc['required_drop_pct']:.2f}% (${calc['entry_price']:.2f} → ${calc['target_price']:.2f}) to cover fees + profit")
        print(f"   Entry Fee:    ${calc['swap_entry_fee']:.4f} (0.3%)")
        print(f"   Exit Fee:     ${calc['swap_exit_fee']:.4f} (0.3%)")
        print(f"   Gas Buffer:   ${calc['gas_buffer']:.2f}")
        print(f"   Total Costs:  ${calc['total_costs']:.4f}")
        print(f"   Gross Needed: ${calc['gross_revenue_needed']:.4f}")
        print(f"   Stop Loss:    ${calc['stop_loss_price']:.2f} (+{SAFETY_GATES['stop_loss_pct']:.1f}%)")

        return True, f"Short validated: need -{calc['required_drop_pct']:.2f}% drop to ${calc['target_price']:.2f}", calc

    def record_collateral_snapshot(self, collateral_usd: float):
        now = time.time()
        if self.last_collateral_snapshot_time > 0:
            elapsed = now - self.last_collateral_snapshot_time
            if elapsed < VELOCITY_SAMPLE_INTERVAL * 0.8:
                return

        self.collateral_history.append({
            'value': collateral_usd,
            'timestamp': now
        })

        cutoff = now - (VELOCITY_BUFFER_MINUTES * 60)
        self.collateral_history = [s for s in self.collateral_history if s['timestamp'] >= cutoff]

        self.last_collateral_snapshot = collateral_usd
        self.last_collateral_snapshot_time = now

    def _get_value_at_offset(self, minutes_ago: int) -> Optional[float]:
        if not self.collateral_history:
            return None
        now = time.time()
        target_time = now - (minutes_ago * 60)
        closest = None
        closest_diff = float('inf')
        for snap in self.collateral_history:
            diff = abs(snap['timestamp'] - target_time)
            if diff < closest_diff:
                closest_diff = diff
                closest = snap
        if closest and closest_diff < 120:
            return closest['value']
        return None

    def check_collateral_velocity(self, current_collateral: float, health_factor: float) -> Dict:
        result = {
            'drop_20m': 0.0,
            'drop_30m': 0.0,
            'micro_triggered': False,
            'macro_triggered': False,
            'message': '',
            'buffer_size': len(self.collateral_history),
        }

        value_20m = self._get_value_at_offset(20)
        value_30m = self._get_value_at_offset(30)

        if value_20m is not None:
            result['drop_20m'] = max(0, value_20m - current_collateral)
        if value_30m is not None:
            result['drop_30m'] = max(0, value_30m - current_collateral)

        micro_cfg = VELOCITY_TRIGGERS['micro']
        macro_cfg = VELOCITY_TRIGGERS['macro']

        if result['drop_30m'] >= macro_cfg['drop_usd'] and health_factor >= macro_cfg['min_health_factor']:
            result['macro_triggered'] = True
            result['message'] = f"MACRO VELOCITY: ${result['drop_30m']:.2f} drop in 30min (threshold ${macro_cfg['drop_usd']:.2f}), HF {health_factor:.3f}"
        elif result['drop_20m'] >= micro_cfg['drop_usd'] and health_factor >= micro_cfg['min_health_factor']:
            result['micro_triggered'] = True
            result['message'] = f"MICRO VELOCITY: ${result['drop_20m']:.2f} drop in 20min (threshold ${micro_cfg['drop_usd']:.2f}), HF {health_factor:.3f}"
        else:
            parts = []
            if value_20m is not None:
                parts.append(f"20m drop: ${result['drop_20m']:.2f}/${micro_cfg['drop_usd']:.0f}")
            else:
                parts.append("20m: buffering")
            if value_30m is not None:
                parts.append(f"30m drop: ${result['drop_30m']:.2f}/${macro_cfg['drop_usd']:.0f}")
            else:
                parts.append("30m: buffering")
            result['message'] = f"Velocity OK — {', '.join(parts)} (buffer: {result['buffer_size']} samples)"

        return result

    def get_trigger_levels(self) -> Dict:
        return {
            "micro_trigger_drop_usd": VELOCITY_TRIGGERS['micro']['drop_usd'],
            "micro_window_min": VELOCITY_TRIGGERS['micro']['window_minutes'],
            "macro_trigger_drop_usd": VELOCITY_TRIGGERS['macro']['drop_usd'],
            "macro_window_min": VELOCITY_TRIGGERS['macro']['window_minutes'],
            "buffer_size": len(self.collateral_history),
            "buffer_max_minutes": VELOCITY_BUFFER_MINUTES,
        }

    def _is_macro_on_cooldown(self) -> bool:
        elapsed = time.time() - self.last_macro_trigger_time
        return elapsed < VELOCITY_TRIGGERS['macro']['cooldown_seconds']

    def _is_micro_on_cooldown(self) -> bool:
        elapsed = time.time() - self.last_micro_trigger_time
        return elapsed < VELOCITY_TRIGGERS['micro']['cooldown_seconds']

    def check_macro_entry(self, current_collateral: float, health_factor: float) -> Tuple[bool, str]:
        if self.has_active_position():
            return False, "Position already active — cannot open new entry"

        if self._is_macro_on_cooldown():
            remaining = VELOCITY_TRIGGERS['macro']['cooldown_seconds'] - (time.time() - self.last_macro_trigger_time)
            return False, f"Macro on cooldown ({remaining/3600:.1f}h remaining)"

        velocity = self.check_collateral_velocity(current_collateral, health_factor)
        if not velocity['macro_triggered']:
            return False, velocity['message']

        if health_factor < 2.90:
            return False, f"HF {health_factor:.3f} below absolute floor 2.90"

        self.last_macro_trigger_time = time.time()
        return True, velocity['message']

    def check_micro_entry(self, current_collateral: float, health_factor: float) -> Tuple[bool, str]:
        if self.has_active_position():
            return False, "Position already active — cannot open new entry"

        if self._is_micro_on_cooldown():
            remaining = VELOCITY_TRIGGERS['micro']['cooldown_seconds'] - (time.time() - self.last_micro_trigger_time)
            return False, f"Micro on cooldown ({remaining/3600:.1f}h remaining)"

        velocity = self.check_collateral_velocity(current_collateral, health_factor)
        if not velocity['micro_triggered']:
            return False, velocity['message']

        if health_factor < 2.90:
            return False, f"HF {health_factor:.3f} below absolute floor 2.90"

        self.last_micro_trigger_time = time.time()
        return True, velocity['message']

    def check_hunt_conditions(self) -> Tuple[str, str]:
        active = self.get_active_position()
        if not active or active.get("status") != "SHORT_ACTIVE":
            return "NONE", "No active short to hunt"

        target_price = active.get("target_price", 0)
        stop_loss_price = active.get("stop_loss_price", 0)
        entry_price = active.get("entry_eth_price", 0)

        current_eth = self.get_eth_price()
        if not current_eth:
            return "WAIT", "Cannot fetch ETH price — holding position"

        if current_eth <= target_price:
            drop_pct = ((entry_price - current_eth) / entry_price) * 100 if entry_price > 0 else 0
            return "WIN", f"TARGET HIT: ETH ${current_eth:.2f} <= ${target_price:.2f} (dropped {drop_pct:.1f}%)"

        if current_eth >= stop_loss_price:
            loss_pct = ((current_eth - entry_price) / entry_price) * 100 if entry_price > 0 else 0
            return "STOP_LOSS", f"STOP LOSS: ETH ${current_eth:.2f} >= ${stop_loss_price:.2f} (rose {loss_pct:.1f}%)"

        distance_to_target = ((current_eth - target_price) / current_eth) * 100 if current_eth > 0 else 0
        return "HUNTING", f"⏳ HUNTING: ETH ${current_eth:.2f} — target ${target_price:.2f} ({distance_to_target:.2f}% away) | stop-loss ${stop_loss_price:.2f}"

    def open_position(self, tier: str, entry_eth_price: float, short_size_usd: float, calc: Dict):
        position = {
            "id": f"ls_{int(time.time())}",
            "tier": tier,
            "status": "SHORT_ACTIVE",
            "entry_eth_price": entry_eth_price,
            "short_size_usd": short_size_usd,
            "target_price": calc.get('target_price'),
            "stop_loss_price": calc.get('stop_loss_price'),
            "target_profit_usd": calc.get('target_profit_usd'),
            "required_drop_pct": calc.get('required_drop_pct'),
            "total_costs": calc.get('total_costs'),
            "dai_collateral_amount": 0,  # Legacy field name — stores USDT collateral amount
            "weth_borrowed_amount": 0,
            "opened_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "opened_timestamp": time.time(),
            "closed_at": None,
            "exit_eth_price": None,
            "pnl_usd": None,
            "close_reason": None,
        }
        self.positions["active_position"] = position
        self.positions["positions"].append(position)
        self._save_positions()
        print(f"✅ Position opened: {tier.upper()} short at ETH ${entry_eth_price:.2f}")
        print(f"   Target: ${calc.get('target_price', 0):.2f} | Stop-Loss: ${calc.get('stop_loss_price', 0):.2f}")
        print(f"⏳ HUNTER MODE: Polling every {POLLING_INTERVALS['SHORT_ACTIVE']}s...")
        logger.info(f"Opened {tier} Phase 2 short at ETH ${entry_eth_price:.2f}, target ${calc.get('target_price', 0):.2f}")

    def update_position_amounts(self, dai_amount: float, weth_amount: float):
        active = self.positions.get("active_position")
        if active:
            active["dai_collateral_amount"] = dai_amount
            active["weth_borrowed_amount"] = weth_amount
            self._save_positions()

    def close_position(self, exit_eth_price: float, realized_profit: float, close_reason: str):
        active = self.positions.get("active_position")
        if not active:
            return

        active["status"] = "closed"
        active["closed_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        active["exit_eth_price"] = exit_eth_price
        active["pnl_usd"] = round(realized_profit, 4)
        active["close_reason"] = close_reason

        for p in self.positions["positions"]:
            if p.get("id") == active.get("id"):
                p.update(active)
                break

        self.positions["active_position"] = None
        self._save_positions()
        logger.info(f"Closed position: entry ${active.get('entry_eth_price', 0):.2f} → exit ${exit_eth_price:.2f}, P&L ${realized_profit:.4f}, reason: {close_reason}")

    def _is_on_cooldown(self) -> bool:
        last_op_time = getattr(self.agent, 'last_successful_operation_time', 0)
        elapsed = time.time() - last_op_time
        return elapsed < SHORT_COOLDOWN_SECONDS

    def get_status_summary(self) -> Dict:
        active = self.get_active_position()
        current_eth = self.get_eth_price()
        current_collateral = self.last_collateral_snapshot or 0

        levels = self.get_trigger_levels()
        velocity = self.check_collateral_velocity(current_collateral, 99.0) if current_collateral > 0 else {}

        summary = {
            "strategy_active": True,
            "phase": 2,
            "has_position": self.has_active_position(),
            "position_status": active.get("status") if active else "IDLE",
            "position_tier": active.get("tier") if active else None,
            "entry_eth_price": active.get("entry_eth_price") if active else None,
            "target_price": active.get("target_price") if active else None,
            "stop_loss_price": active.get("stop_loss_price") if active else None,
            "current_eth_price": current_eth,
            "velocity_drop_20m": velocity.get('drop_20m', 0),
            "velocity_drop_30m": velocity.get('drop_30m', 0),
            "velocity_buffer_size": levels.get("buffer_size", 0),
            "velocity_buffer_max_min": VELOCITY_BUFFER_MINUTES,
            "micro_trigger_drop_usd": levels.get("micro_trigger_drop_usd", 30),
            "macro_trigger_drop_usd": levels.get("macro_trigger_drop_usd", 50),
            "micro_on_cooldown": self._is_micro_on_cooldown(),
            "macro_on_cooldown": self._is_macro_on_cooldown(),
            "on_cooldown": self._is_on_cooldown(),
            "polling_interval": self.get_polling_interval(),
            "polling_mode": "HUNTER" if self.get_position_status() == "SHORT_ACTIVE" else "SENTRY",
            "total_positions_history": len(self.positions.get("positions", [])),
            "profit_targets": PROFIT_TARGETS,
            "velocity_message": velocity.get('message', 'Buffering...'),
        }

        if active and active.get("entry_eth_price") and current_eth:
            entry = active["entry_eth_price"]
            change_pct = ((current_eth - entry) / entry) * 100
            summary["eth_change_pct"] = round(change_pct, 2)
            target_p = active.get("target_price", 0)
            if target_p and current_eth > 0:
                distance = ((current_eth - target_p) / current_eth) * 100
                summary["distance_to_target_pct"] = round(distance, 2)

        return summary
