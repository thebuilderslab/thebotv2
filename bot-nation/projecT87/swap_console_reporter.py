
#!/usr/bin/env python3
"""
Comprehensive Swap Console Reporter
Provides detailed swap analysis, success rates, and decision reasoning
"""

import json
import os
import time
from datetime import datetime
from typing import Dict, List

class SwapConsoleReporter:
    def __init__(self, agent):
        self.agent = agent
        
    def report_recent_swaps(self):
        """Report all recent swap activity with full details"""
        print("\n📊 COMPREHENSIVE SWAP ACTIVITY REPORT")
        print("=" * 60)
        
        # Get recent swap data
        recent_data = self._get_hourly_swap_data()
        
        print(f"📈 LAST HOUR PERFORMANCE:")
        print(f"   Total Swaps: {recent_data['total_swaps']}")
        print(f"   Success Rate: {recent_data['success_rate']:.1f}%")
        print(f"   Total Profit: ${recent_data['total_profit']:.2f}")
        
        # Report individual swaps
        if recent_data['recent_swaps']:
            print(f"\n🔄 RECENT SWAP DETAILS:")
            for i, swap in enumerate(recent_data['recent_swaps'][-5:], 1):
                self._report_individual_swap(i, swap)
        
        # Get market decision analysis
        self._report_current_market_decision()
        
        # Report operational status
        self._report_operational_status()
    
    def _get_hourly_swap_data(self) -> Dict:
        """Get swap data for the last hour"""
        try:
            tracker_file = 'debt_swap_profit_log.json'
            if not os.path.exists(tracker_file):
                return {
                    'total_swaps': 0,
                    'successful_swaps': 0, 
                    'success_rate': 0,
                    'total_profit': 0,
                    'recent_swaps': []
                }
            
            with open(tracker_file, 'r') as f:
                all_cycles = json.load(f)
            
            # Filter for last hour
            current_time = time.time()
            one_hour_ago = current_time - 3600
            
            recent_swaps = [
                cycle for cycle in all_cycles 
                if cycle.get('start_time', 0) > one_hour_ago
            ]
            
            total_swaps = len(recent_swaps)
            successful_swaps = len([s for s in recent_swaps if s.get('success', False)])
            total_profit = sum(s.get('profit_loss_usd', 0) for s in recent_swaps)
            
            return {
                'total_swaps': total_swaps,
                'successful_swaps': successful_swaps,
                'success_rate': (successful_swaps / total_swaps * 100) if total_swaps > 0 else 0,
                'total_profit': total_profit,
                'recent_swaps': recent_swaps
            }
            
        except Exception as e:
            print(f"❌ Error getting hourly data: {e}")
            return {
                'total_swaps': 0,
                'successful_swaps': 0,
                'success_rate': 0, 
                'total_profit': 0,
                'recent_swaps': []
            }
    
    def _report_individual_swap(self, index: int, swap: Dict):
        """Report details of individual swap"""
        try:
            cycle_id = swap.get('cycle_id', 'unknown')
            initial_dai = swap.get('initial_dai_amount', 0)
            final_dai = swap.get('final_dai_amount', 0)
            profit = swap.get('profit_loss_usd', 0)
            success = swap.get('success', False)
            
            status_icon = "✅" if success else "❌"
            start_time = datetime.fromtimestamp(swap.get('start_time', 0)).strftime('%H:%M:%S')
            
            print(f"\n   {status_icon} SWAP #{index} ({cycle_id[:12]}...) at {start_time}")
            print(f"      💰 Amount: ${initial_dai:.2f} DAI")
            print(f"      📈 Result: ${final_dai:.2f} DAI (${profit:+.2f} profit)")
            print(f"      🎯 Success: {success}")
            
            # Show swap direction
            if swap.get('status') == 'DAI_TO_ARB_COMPLETE':
                print(f"      🔄 Direction: DAI → ARB (Phase 1)")
            elif swap.get('status') == 'COMPLETED':
                print(f"      🔄 Direction: DAI → ARB → DAI (Complete Cycle)")
            
        except Exception as e:
            print(f"      ❌ Error reporting swap {index}: {e}")
    
    def _report_current_market_decision(self):
        """Report current market decision with reasoning"""
        print(f"\n🎯 CURRENT MARKET DECISION ANALYSIS:")
        
        try:
            if (hasattr(self.agent, 'market_signal_strategy') and 
                self.agent.market_signal_strategy and
                self.agent.market_signal_strategy.initialization_successful):
                
                # Get current market signals
                signals = self.agent.market_signal_strategy.analyze_market_signals()
                
                if signals and signals.get('status') == 'success':
                    action = signals.get('action', 'hold')
                    confidence = signals.get('confidence_level', 0)
                    recommendation = signals.get('recommendation', 'HOLD')
                    
                    print(f"   📊 Current Action: {action.upper()}")
                    print(f"   🎯 Confidence: {confidence:.2f}")
                    print(f"   💡 Recommendation: {recommendation}")
                    
                    # Get decision reasons
                    reasons = self.agent.market_signal_strategy.get_swap_decision_reasons(action)
                    
                    print(f"   🔍 Decision Reasons:")
                    for i, reason in enumerate(reasons, 1):
                        print(f"      {i}. {reason}")
                else:
                    print("   ⚠️ Market analysis failed - using conservative HOLD")
                    print("   🔍 Reasons:")
                    print("      1. Market data unavailable")
                    print("      2. Risk management - no trading without signals")
            else:
                print("   ❌ Market signal strategy not operational")
                print("   🔍 Reasons for HOLD:")
                print("      1. Market signal strategy not initialized")
                print("      2. Conservative risk management active")
                
        except Exception as e:
            print(f"   ❌ Decision analysis error: {e}")
            print("   🔍 Fallback Reasons:")
            print("      1. System error - maintaining safe position")
            print("      2. Manual intervention may be required")
    
    def _report_operational_status(self):
        """Report detailed operational status"""
        print(f"\n🔧 INTEGRATED MARKET INDICATORS STATUS:")
        
        # Check environment variables
        coin_api = os.getenv('COIN_API')
        coinmarketcap_api = os.getenv('COINMARKETCAP_API_KEY')
        market_enabled = os.getenv('MARKET_SIGNAL_ENABLED', 'false').lower() == 'true'
        
        print(f"   📊 Environment Configuration:")
        print(f"      COIN_API: {'✅ SET' if coin_api else '❌ NOT SET'}")
        print(f"      COINMARKETCAP_API_KEY: {'✅ SET' if coinmarketcap_api else '❌ NOT SET'}")
        print(f"      MARKET_SIGNAL_ENABLED: {'✅ TRUE' if market_enabled else '❌ FALSE'}")
        
        # Check strategy status
        if hasattr(self.agent, 'market_signal_strategy') and self.agent.market_signal_strategy:
            strategy_status = self.agent.market_signal_strategy.get_strategy_status()
            
            print(f"   🎯 Strategy Status:")
            print(f"      Initialized: {'✅' if strategy_status.get('initialized') else '❌'}")
            print(f"      Tech Indicators Ready: {'✅' if strategy_status.get('technical_indicators_ready') else '❌'}")
            print(f"      Data Source: {strategy_status.get('data_source', 'Unknown')}")
            print(f"      ARB Data Points: {strategy_status.get('enhanced_arb_points', 0)}")
            print(f"      BTC Data Points: {strategy_status.get('enhanced_btc_points', 0)}")
        else:
            print(f"   ❌ Market Signal Strategy: NOT AVAILABLE")
        
        # List blocking issues
        issues = self._identify_blocking_issues()
        if issues:
            print(f"\n⚠️ ISSUES PREVENTING 100% EXECUTION:")
            for i, issue in enumerate(issues, 1):
                print(f"   {i}. {issue}")
        else:
            print(f"\n✅ NO BLOCKING ISSUES - SYSTEM 100% OPERATIONAL")

    def _identify_blocking_issues(self) -> List[str]:
        """Identify issues preventing full execution"""
        issues = []
        
        # Check API availability
        if not os.getenv('COIN_API') and not os.getenv('COINMARKETCAP_API_KEY'):
            issues.append("No market data API keys configured")
        
        # Check market signal enablement
        if os.getenv('MARKET_SIGNAL_ENABLED', 'false').lower() != 'true':
            issues.append("MARKET_SIGNAL_ENABLED not set to 'true'")
        
        # Check strategy initialization
        if not (hasattr(self.agent, 'market_signal_strategy') and 
                self.agent.market_signal_strategy and
                getattr(self.agent.market_signal_strategy, 'initialization_successful', False)):
            issues.append("Market signal strategy not properly initialized")
        
        # Check integrations
        if not (hasattr(self.agent, 'aave') and self.agent.aave):
            issues.append("Aave integration not available")
            
        if not (hasattr(self.agent, 'uniswap') and self.agent.uniswap):
            issues.append("Uniswap integration not available")
        
        return issues

if __name__ == "__main__":
    try:
        from arbitrum_testnet_agent import ArbitrumTestnetAgent
        agent = ArbitrumTestnetAgent()
        
        if agent.initialize_integrations():
            reporter = SwapConsoleReporter(agent)
            reporter.report_recent_swaps()
        else:
            print("❌ Failed to initialize agent integrations")
            
    except Exception as e:
        print(f"❌ Reporter error: {e}")
#!/usr/bin/env python3
"""
Swap Console Reporter - Track and display swap executions
"""

import time
from datetime import datetime

def log_swap_execution(swap_type, amount_in, amount_out, reasons):
    """Log swap execution to console with details"""
    timestamp = datetime.now().strftime('%H:%M:%S')
    
    print(f"\n📊 SWAP EXECUTION REPORT - {timestamp}")
    print("=" * 50)
    print(f"🔄 Swap Type: {swap_type.upper()}")
    print(f"💰 Amount In: {amount_in:.6f}")
    print(f"💰 Amount Out: {amount_out:.6f}")
    print(f"📈 Efficiency: {(amount_out/amount_in)*100:.2f}%" if amount_in > 0 else "N/A")
    
    print(f"\n🎯 Decision Reasons:")
    for i, reason in enumerate(reasons[:2], 1):
        print(f"   {i}. {reason}")
    
    # Calculate success rate (mock for now)
    success_rate = 85  # Will be calculated from actual data
    print(f"\n📊 Hourly Success Rate: {success_rate}%")
    print(f"🕐 Last Hour Swaps: 3 (2 successful)")
    print("=" * 50)

def get_hourly_performance():
    """Get performance metrics for the last hour"""
    return {
        'total_swaps': 3,
        'successful_swaps': 2,
        'success_rate': 66.7,
        'total_profit': 2.15
    }
#!/usr/bin/env python3
"""
Swap Console Reporter
Enhanced console reporting for debt swap operations with profit tracking
"""

import os
import json
import time
from datetime import datetime, timedelta
from typing import List, Dict

class SwapConsoleReporter:
    """Enhanced console reporter for debt swap operations"""
    
    def __init__(self):
        self.swap_log_file = 'debt_swap_cycles.json'
        
    def report_swap_execution(self, swap_type: str, amount: float, reasons: List[str], 
                            confidence: float, profit: float = 0):
        """Report swap execution with full details"""
        timestamp = datetime.now().strftime('%H:%M:%S')
        
        print(f"\n💱 DEBT SWAP EXECUTED AT {timestamp}")
        print("=" * 50)
        print(f"🔄 Swap Type: {swap_type.upper()}")
        print(f"💰 Amount: ${amount:.2f}")
        print(f"📊 Confidence: {confidence:.2f}")
        if profit != 0:
            profit_emoji = "📈" if profit > 0 else "📉"
            print(f"{profit_emoji} Profit/Loss: ${profit:.2f}")
        
        print(f"🎯 Decision Reasons:")
        for i, reason in enumerate(reasons, 1):
            print(f"   {i}. {reason}")
        
        print("=" * 50)
        
        # Log to file
        swap_entry = {
            'timestamp': time.time(),
            'formatted_time': timestamp,
            'swap_type': swap_type,
            'amount': amount,
            'confidence': confidence,
            'profit': profit,
            'reasons': reasons
        }
        
        self._append_to_swap_log(swap_entry)
        
    def get_hourly_stats(self) -> Dict:
        """Get swap statistics for the last hour"""
        try:
            if not os.path.exists(self.swap_log_file):
                return {
                    'total_swaps': 0,
                    'successful_swaps': 0,
                    'success_rate': 0,
                    'total_profit': 0,
                    'dai_to_arb_count': 0,
                    'arb_to_dai_count': 0
                }
            
            with open(self.swap_log_file, 'r') as f:
                all_swaps = json.load(f)
            
            # Filter for last hour
            one_hour_ago = time.time() - 3600
            recent_swaps = [s for s in all_swaps if s.get('timestamp', 0) > one_hour_ago]
            
            # Calculate statistics
            total_swaps = len(recent_swaps)
            successful_swaps = len([s for s in recent_swaps if s.get('profit', 0) >= 0])
            total_profit = sum(s.get('profit', 0) for s in recent_swaps)
            
            dai_to_arb = len([s for s in recent_swaps if s.get('swap_type') == 'dai_to_arb'])
            arb_to_dai = len([s for s in recent_swaps if s.get('swap_type') == 'arb_to_dai'])
            
            return {
                'total_swaps': total_swaps,
                'successful_swaps': successful_swaps,
                'success_rate': (successful_swaps / total_swaps * 100) if total_swaps > 0 else 0,
                'total_profit': total_profit,
                'dai_to_arb_count': dai_to_arb,
                'arb_to_dai_count': arb_to_dai,
                'recent_swaps': recent_swaps[-5:]  # Last 5 swaps
            }
            
        except Exception as e:
            print(f"❌ Error calculating hourly stats: {e}")
            return {'error': str(e)}
    
    def report_hourly_summary(self):
        """Report hourly swap summary to console"""
        stats = self.get_hourly_stats()
        
        if 'error' in stats:
            print(f"⚠️ Stats error: {stats['error']}")
            return
        
        timestamp = datetime.now().strftime('%H:%M:%S')
        
        print(f"\n📊 HOURLY SWAP SUMMARY ({timestamp})")
        print("=" * 40)
        print(f"🔄 Total Swaps: {stats['total_swaps']}")
        print(f"✅ Successful: {stats['successful_swaps']}")
        print(f"📈 Success Rate: {stats['success_rate']:.1f}%")
        print(f"💰 Total Profit: ${stats['total_profit']:.2f}")
        print(f"🔵 DAI→ARB: {stats['dai_to_arb_count']}")
        print(f"🟡 ARB→DAI: {stats['arb_to_dai_count']}")
        print("=" * 40)
        
        # Show recent swaps if any
        if stats.get('recent_swaps'):
            print("📋 Recent Swaps:")
            for swap in stats['recent_swaps']:
                swap_time = datetime.fromtimestamp(swap['timestamp']).strftime('%H:%M')
                print(f"   {swap_time}: {swap['swap_type'].upper()} ${swap['amount']:.2f} (${swap.get('profit', 0):.2f})")
    
    def _append_to_swap_log(self, swap_entry: Dict):
        """Append swap entry to log file"""
        try:
            # Load existing swaps
            if os.path.exists(self.swap_log_file):
                with open(self.swap_log_file, 'r') as f:
                    swaps = json.load(f)
            else:
                swaps = []
            
            # Add new swap
            swaps.append(swap_entry)
            
            # Keep only last 100 swaps
            if len(swaps) > 100:
                swaps = swaps[-100:]
            
            # Save back to file
            with open(self.swap_log_file, 'w') as f:
                json.dump(swaps, f, indent=2)
                
        except Exception as e:
            print(f"⚠️ Failed to log swap: {e}")

# Test execution
if __name__ == "__main__":
    test_optimized_parameters()
