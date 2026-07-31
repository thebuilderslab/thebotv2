#!/usr/bin/env python3
"""
Debt Swap Profit Tracker
Monitors percentage success rate of DAI→ARB→DAI cycles in $10 increments
"""

import json
import os
import time
from datetime import datetime
from decimal import Decimal
from typing import Dict, List

class DebtSwapProfitTracker:
    def __init__(self):
        self.tracker_file = 'debt_swap_profit_log.json'
        self.summary_file = 'debt_swap_summary.json'
        self.active_swaps = {}  # Track ongoing swap cycles

    def start_swap_cycle(self, cycle_id: str, initial_dai_amount: float, 
                        arb_amount_received: float, arb_price_at_entry: float) -> Dict:
        """Start tracking a new DAI→ARB→DAI swap cycle"""
        cycle_data = {
            'cycle_id': cycle_id,
            'start_time': time.time(),
            'start_timestamp': datetime.now().isoformat(),
            'initial_dai_amount': initial_dai_amount,
            'arb_amount_received': arb_amount_received,
            'arb_price_at_entry': arb_price_at_entry,
            'expected_dai_value': initial_dai_amount,
            'status': 'DAI_TO_ARB_COMPLETE',
            'phase': 'waiting_for_arb_to_dai'
        }

        self.active_swaps[cycle_id] = cycle_data
        self._save_active_swaps()

        print(f"📊 Started tracking swap cycle: {cycle_id}")
        print(f"   Initial DAI: ${initial_dai_amount:.2f}")
        print(f"   ARB received: {arb_amount_received:.6f} ARB @ ${arb_price_at_entry:.4f}")

        return cycle_data

    def complete_swap_cycle(self, cycle_id: str, final_dai_amount: float, 
                           arb_price_at_exit: float) -> Dict:
        """Complete a swap cycle and calculate profit/loss"""
        if cycle_id not in self.active_swaps:
            print(f"❌ Cycle {cycle_id} not found in active swaps")
            return {}

        cycle_data = self.active_swaps[cycle_id]

        # Calculate profit/loss
        initial_dai = cycle_data['initial_dai_amount']
        profit_loss = final_dai_amount - initial_dai
        profit_percentage = (profit_loss / initial_dai) * 100

        # Complete the cycle data
        cycle_data.update({
            'end_time': time.time(),
            'end_timestamp': datetime.now().isoformat(),
            'final_dai_amount': final_dai_amount,
            'arb_price_at_exit': arb_price_at_exit,
            'profit_loss_usd': profit_loss,
            'profit_percentage': profit_percentage,
            'duration_seconds': cycle_data['start_time'] - time.time(),
            'status': 'COMPLETED',
            'success': profit_loss > 0
        })

        # Determine profit bracket
        profit_bracket = self._get_profit_bracket(profit_loss)
        cycle_data['profit_bracket'] = profit_bracket

        # Log completed cycle
        self._log_completed_cycle(cycle_data)

        # Remove from active swaps
        del self.active_swaps[cycle_id]
        self._save_active_swaps()

        # Update summary statistics
        self._update_summary_stats(cycle_data)

        print(f"✅ Completed swap cycle: {cycle_id}")
        print(f"   Profit/Loss: ${profit_loss:.2f} ({profit_percentage:.2f}%)")
        print(f"   Bracket: {profit_bracket}")

        return cycle_data

    def _get_profit_bracket(self, profit_loss: float) -> str:
        """Categorize profit into $10 increments"""
        if profit_loss >= 50:
            return "$50+"
        elif profit_loss >= 40:
            return "$40-49"
        elif profit_loss >= 30:
            return "$30-39"
        elif profit_loss >= 20:
            return "$20-29"
        elif profit_loss >= 10:
            return "$10-19"
        elif profit_loss >= 0:
            return "$0-9"
        elif profit_loss >= -10:
            return "$0-(-9)"
        elif profit_loss >= -20:
            return "$(-10)-(-19)"
        elif profit_loss >= -30:
            return "$(-20)-(-29)"
        else:
            return "$(-30)+"

    def _log_completed_cycle(self, cycle_data: Dict):
        """Log completed cycle to file"""
        if not os.path.exists(self.tracker_file):
            with open(self.tracker_file, 'w') as f:
                json.dump([], f)

        # Load existing data
        try:
            with open(self.tracker_file, 'r') as f:
                cycles = json.load(f)
        except:
            cycles = []

        cycles.append(cycle_data)

        # Save updated data
        with open(self.tracker_file, 'w') as f:
            json.dump(cycles, f, indent=2)

    def _update_summary_stats(self, latest_cycle: Dict):
        """Update summary statistics"""
        # Load existing cycles
        try:
            with open(self.tracker_file, 'r') as f:
                all_cycles = json.load(f)
        except:
            all_cycles = []

        # Calculate summary statistics
        total_cycles = len(all_cycles)
        successful_cycles = len([c for c in all_cycles if c.get('success', False)])
        total_profit = sum(c.get('profit_loss_usd', 0) for c in all_cycles)

        # Profit bracket analysis
        bracket_stats = {}
        for cycle in all_cycles:
            bracket = cycle.get('profit_bracket', 'Unknown')
            if bracket not in bracket_stats:
                bracket_stats[bracket] = {'count': 0, 'success_rate': 0}
            bracket_stats[bracket]['count'] += 1

        # Calculate success rates per bracket
        for bracket in bracket_stats:
            bracket_cycles = [c for c in all_cycles if c.get('profit_bracket') == bracket]
            successful_in_bracket = len([c for c in bracket_cycles if c.get('success', False)])
            bracket_stats[bracket]['success_rate'] = (
                (successful_in_bracket / len(bracket_cycles)) * 100 if bracket_cycles else 0
            )

        summary = {
            'last_updated': datetime.now().isoformat(),
            'total_cycles': total_cycles,
            'successful_cycles': successful_cycles,
            'overall_success_rate': (successful_cycles / total_cycles * 100) if total_cycles > 0 else 0,
            'total_profit_usd': total_profit,
            'average_profit_per_cycle': total_profit / total_cycles if total_cycles > 0 else 0,
            'profit_bracket_stats': bracket_stats,
            'recent_performance': {
                'last_10_cycles': all_cycles[-10:] if len(all_cycles) >= 10 else all_cycles,
                'last_10_success_rate': self._calculate_recent_success_rate(all_cycles[-10:])
            }
        }

        # Save summary
        with open(self.summary_file, 'w') as f:
            json.dump(summary, f, indent=2)

    def _calculate_recent_success_rate(self, recent_cycles: List[Dict]) -> float:
        """Calculate success rate for recent cycles"""
        if not recent_cycles:
            return 0
        successful = len([c for c in recent_cycles if c.get('success', False)])
        return (successful / len(recent_cycles)) * 100

    def get_performance_summary(self) -> Dict:
        """Get current performance summary"""
        try:
            with open(self.summary_file, 'r') as f:
                return json.load(f)
        except:
            return {
                'total_cycles': 0,
                'overall_success_rate': 0,
                'total_profit_usd': 0,
                'message': 'No cycles tracked yet'
            }

    def print_performance_report(self):
        """Print detailed performance report"""
        summary = self.get_performance_summary()

        print("\n📊 DEBT SWAP PROFIT TRACKER REPORT")
        print("=" * 50)
        print(f"Total Cycles: {summary.get('total_cycles', 0)}")
        print(f"Success Rate: {summary.get('overall_success_rate', 0):.1f}%")
        print(f"Total Profit: ${summary.get('total_profit_usd', 0):.2f}")
        print(f"Avg per Cycle: ${summary.get('average_profit_per_cycle', 0):.2f}")

        bracket_stats = summary.get('profit_bracket_stats', {})
        if bracket_stats:
            print("\n💰 PROFIT BRACKET ANALYSIS:")
            for bracket, stats in sorted(bracket_stats.items()):
                print(f"   {bracket}: {stats['count']} cycles, {stats['success_rate']:.1f}% success")

        recent = summary.get('recent_performance', {})
        if recent:
            print(f"\n📈 Recent Performance (Last 10): {recent.get('last_10_success_rate', 0):.1f}%")

    def _save_active_swaps(self):
        """Save active swaps to file"""
        with open('active_swaps.json', 'w') as f:
            json.dump(self.active_swaps, f, indent=2)

    def load_active_swaps(self):
        """Load active swaps from file"""
        try:
            with open('active_swaps.json', 'r') as f:
                self.active_swaps = json.load(f)
        except:
            self.active_swaps = {}

# Integration functions for the main agent
def create_cycle_id() -> str:
    """Create unique cycle ID"""
    return f"cycle_{int(time.time())}_{hash(time.time()) % 10000}"

def track_dai_to_arb_swap(dai_amount: float, arb_received: float, arb_price: float) -> str:
    """Start tracking a DAI→ARB swap"""
    tracker = DebtSwapProfitTracker()
    tracker.load_active_swaps()

    cycle_id = create_cycle_id()
    tracker.start_swap_cycle(cycle_id, dai_amount, arb_received, arb_price)

    return cycle_id

def track_arb_to_dai_swap(cycle_id: str, dai_received: float, arb_price: float):
    """Complete tracking an ARB→DAI swap"""
    tracker = DebtSwapProfitTracker()
    tracker.load_active_swaps()

    tracker.complete_swap_cycle(cycle_id, dai_received, arb_price)

if __name__ == "__main__":
    # Demo usage
    tracker = DebtSwapProfitTracker()
    tracker.print_performance_report()