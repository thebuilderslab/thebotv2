#!/usr/bin/env python3
"""
BLOCK EVENT MONITOR WITH PREDICTIVE ANALYTICS
Real-time blockchain state monitoring with trigger prediction
"""

import time
import threading
from collections import deque
from datetime import datetime, timedelta
import statistics


class BlockEventMonitor:
    """Monitors blockchain blocks and predicts future trigger points"""
    
    def __init__(self, w3, callback_function=None):
        """
        Initialize block event monitor
        
        Args:
            w3: Web3 instance
            callback_function: Function to call on each new block (receives block_number, block_data)
        """
        self.w3 = w3
        self.callback = callback_function
        self.monitoring = False
        self.monitor_thread = None
        self.last_block = None
        
        # Metric history for predictions (stores last 100 blocks)
        self.collateral_history = deque(maxlen=100)
        self.capacity_history = deque(maxlen=100)
        self.health_factor_history = deque(maxlen=100)
        self.price_history = deque(maxlen=100)
        
        # Block timing data
        self.block_timestamps = deque(maxlen=50)
        self.avg_block_time = 0.25  # Arbitrum ~0.25 seconds per block
        
        print("📡 Block Event Monitor initialized")
    
    def start_monitoring(self):
        """Start monitoring new blocks"""
        if self.monitoring:
            print("⚠️ Block monitoring already active")
            return
        
        self.monitoring = True
        self.monitor_thread = threading.Thread(target=self._monitor_blocks, daemon=True)
        self.monitor_thread.start()
        print("🚀 Block event monitoring started")
    
    def stop_monitoring(self):
        """Stop monitoring blocks"""
        self.monitoring = False
        if self.monitor_thread:
            self.monitor_thread.join(timeout=5)
        print("⏸️ Block event monitoring stopped")
    
    def _monitor_blocks(self):
        """Monitor new blocks continuously"""
        print("🔍 Starting block listener...")
        
        try:
            # Get initial block
            self.last_block = self.w3.eth.block_number
            print(f"📊 Starting from block {self.last_block}")
            
            while self.monitoring:
                try:
                    current_block = self.w3.eth.block_number
                    
                    # Check if we have a new block
                    if current_block > self.last_block:
                        blocks_missed = current_block - self.last_block
                        
                        if blocks_missed > 1:
                            print(f"⚠️ Missed {blocks_missed - 1} blocks")
                        
                        # Get block data
                        block_data = self.w3.eth.get_block(current_block)
                        
                        # Track block timing
                        if hasattr(block_data, 'timestamp'):
                            self.block_timestamps.append({
                                'number': current_block,
                                'timestamp': block_data.timestamp,
                                'received_at': time.time()
                            })
                            
                            # Calculate average block time
                            if len(self.block_timestamps) >= 2:
                                time_diffs = []
                                for i in range(1, len(self.block_timestamps)):
                                    diff = (self.block_timestamps[i]['timestamp'] - 
                                           self.block_timestamps[i-1]['timestamp'])
                                    if diff > 0:
                                        time_diffs.append(diff)
                                
                                if time_diffs:
                                    self.avg_block_time = statistics.mean(time_diffs)
                        
                        # Update last block
                        self.last_block = current_block
                        
                        # Call callback if provided
                        if self.callback:
                            try:
                                self.callback(current_block, block_data)
                            except Exception as callback_err:
                                print(f"⚠️ Callback error: {callback_err}")
                        
                        # Small delay to avoid hammering RPC
                        time.sleep(0.1)
                    else:
                        # No new block yet, wait a bit
                        time.sleep(0.5)
                        
                except Exception as e:
                    print(f"⚠️ Block fetch error: {e}")
                    time.sleep(2)
                    
        except Exception as e:
            print(f"❌ Block monitoring failed: {e}")
            self.monitoring = False
    
    def record_metric(self, metric_type, value, block_number=None):
        """
        Record a metric value for historical tracking
        
        Args:
            metric_type: 'collateral', 'capacity', 'health_factor', or 'price'
            value: The metric value (USD or ratio)
            block_number: Optional block number (uses current if not provided)
        """
        if block_number is None:
            block_number = self.w3.eth.block_number
        
        metric_entry = {
            'block': block_number,
            'value': value,
            'timestamp': time.time()
        }
        
        if metric_type == 'collateral':
            self.collateral_history.append(metric_entry)
        elif metric_type == 'capacity':
            self.capacity_history.append(metric_entry)
        elif metric_type == 'health_factor':
            self.health_factor_history.append(metric_entry)
        elif metric_type == 'price':
            self.price_history.append(metric_entry)
    
    def calculate_rate_of_change(self, metric_type, lookback_blocks=20):
        """
        Calculate rate of change for a metric
        
        Args:
            metric_type: 'collateral', 'capacity', 'health_factor', or 'price'
            lookback_blocks: Number of recent blocks to analyze
        
        Returns:
            Rate of change per block (float), or None if insufficient data
        """
        # Get the appropriate history
        if metric_type == 'collateral':
            history = list(self.collateral_history)
        elif metric_type == 'capacity':
            history = list(self.capacity_history)
        elif metric_type == 'health_factor':
            history = list(self.health_factor_history)
        elif metric_type == 'price':
            history = list(self.price_history)
        else:
            return None
        
        if len(history) < 2:
            return None
        
        # Use most recent entries
        recent_history = history[-min(lookback_blocks, len(history)):]
        
        if len(recent_history) < 2:
            return None
        
        # Calculate linear regression slope (rate of change)
        first_entry = recent_history[0]
        last_entry = recent_history[-1]
        
        block_diff = last_entry['block'] - first_entry['block']
        value_diff = last_entry['value'] - first_entry['value']
        
        if block_diff == 0:
            return None
        
        rate_per_block = value_diff / block_diff
        return rate_per_block
    
    def predict_time_to_trigger(self, current_value, threshold, rate_of_change):
        """
        Predict time until threshold is reached
        
        Args:
            current_value: Current metric value
            threshold: Target threshold value
            rate_of_change: Rate of change per block
        
        Returns:
            Dictionary with predictions, or None if cannot predict
        """
        if rate_of_change is None or rate_of_change == 0:
            return None
        
        # Calculate blocks until trigger
        value_diff = threshold - current_value
        
        # If already past threshold
        if (rate_of_change > 0 and value_diff <= 0) or \
           (rate_of_change < 0 and value_diff >= 0):
            return {
                'status': 'triggered',
                'blocks_remaining': 0,
                'time_remaining_seconds': 0,
                'predicted_block': self.w3.eth.block_number,
                'predicted_time': datetime.now()
            }
        
        # If moving away from threshold
        if (rate_of_change > 0 and value_diff < 0) or \
           (rate_of_change < 0 and value_diff > 0):
            return None
        
        blocks_remaining = value_diff / rate_of_change
        
        # Only predict if reasonable (within 100,000 blocks ~ 7 hours on Arbitrum)
        if blocks_remaining < 0 or blocks_remaining > 100000:
            return None
        
        time_remaining_seconds = blocks_remaining * self.avg_block_time
        predicted_block = self.w3.eth.block_number + int(blocks_remaining)
        predicted_time = datetime.now() + timedelta(seconds=time_remaining_seconds)
        
        return {
            'status': 'approaching',
            'blocks_remaining': int(blocks_remaining),
            'time_remaining_seconds': time_remaining_seconds,
            'predicted_block': predicted_block,
            'predicted_time': predicted_time,
            'rate_per_block': rate_of_change,
            'rate_per_minute': rate_of_change / (self.avg_block_time / 60)
        }
    
    def get_trigger_prediction(self, metric_type, current_value, threshold, lookback_blocks=20):
        """
        Get complete trigger prediction for a metric
        
        Args:
            metric_type: Type of metric
            current_value: Current value
            threshold: Threshold to predict
            lookback_blocks: Blocks to analyze for rate calculation
        
        Returns:
            Prediction dictionary with all details
        """
        rate = self.calculate_rate_of_change(metric_type, lookback_blocks)
        prediction = self.predict_time_to_trigger(current_value, threshold, rate)
        
        return {
            'metric': metric_type,
            'current': current_value,
            'threshold': threshold,
            'rate_of_change': rate,
            'prediction': prediction,
            'data_points': len(self.collateral_history) if metric_type == 'collateral' else len(self.capacity_history)
        }
    
    def get_comprehensive_predictions(self, triggers_config):
        """
        Get predictions for all configured triggers
        
        Args:
            triggers_config: Dictionary with current values and thresholds
                {
                    'collateral': {'current': 192.85, 'threshold': 204.85},
                    'capacity': {'current': 108.27, 'threshold': 25.0},
                    'health_factor': {'current': 2.3, 'threshold': 2.1}
                }
        
        Returns:
            Dictionary with all predictions
        """
        predictions = {}
        
        for metric_type, config in triggers_config.items():
            if 'current' in config and 'threshold' in config:
                predictions[metric_type] = self.get_trigger_prediction(
                    metric_type,
                    config['current'],
                    config['threshold']
                )
        
        return predictions
    
    def format_prediction_display(self, prediction):
        """Format prediction for human-readable display"""
        if not prediction or not prediction.get('prediction'):
            return "Insufficient data for prediction"
        
        pred = prediction['prediction']
        metric = prediction['metric']
        current = prediction['current']
        threshold = prediction['threshold']
        
        if pred['status'] == 'triggered':
            return f"✅ {metric.upper()}: TRIGGERED (${current:.2f} vs ${threshold:.2f})"
        
        blocks = pred['blocks_remaining']
        seconds = pred['time_remaining_seconds']
        
        # Format time remaining
        if seconds < 60:
            time_str = f"{int(seconds)}s"
        elif seconds < 3600:
            time_str = f"{int(seconds/60)}m {int(seconds%60)}s"
        else:
            hours = int(seconds / 3600)
            mins = int((seconds % 3600) / 60)
            time_str = f"{hours}h {mins}m"
        
        predicted_time = pred['predicted_time'].strftime('%H:%M:%S')
        
        return (f"⏱️ {metric.upper()}: Predicted in {time_str} "
                f"(~{blocks} blocks, ~{predicted_time}) | "
                f"Current: ${current:.2f} → Target: ${threshold:.2f}")
    
    def get_status(self):
        """Get current monitoring status"""
        return {
            'monitoring': self.monitoring,
            'current_block': self.last_block,
            'avg_block_time': self.avg_block_time,
            'collateral_data_points': len(self.collateral_history),
            'capacity_data_points': len(self.capacity_history),
            'health_factor_data_points': len(self.health_factor_history),
            'price_data_points': len(self.price_history)
        }
