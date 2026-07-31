#!/usr/bin/env python3
"""
PnL Conversion Service for Autonomous DeFi Operations
Converts user-defined PnL targets into operational USD thresholds
"""

import json
import time
import logging
from typing import Dict, Optional, Tuple
from pathlib import Path

logger = logging.getLogger(__name__)

class PnLConverter:
    def __init__(self, config_file: str = "pnl_config.json"):
        """Initialize PnL converter with configuration file"""
        self.config_file = config_file
        self.config = self._load_config()
        
    def _load_config(self) -> Dict:
        """Load PnL configuration from JSON file"""
        try:
            if Path(self.config_file).exists():
                with open(self.config_file, 'r') as f:
                    config = json.load(f)
                logger.info(f"✅ PnL configuration loaded from {self.config_file}")
                return config
            else:
                logger.error(f"❌ Configuration file not found: {self.config_file}")
                return self._get_default_config()
        except Exception as e:
            logger.error(f"Error loading PnL config: {e}")
            return self._get_default_config()
    
    def _get_default_config(self) -> Dict:
        """Return default PnL configuration"""
        return {
            "pnl_targets": {
                "pnl_growth_target": 5.00,
                "pnl_capacity_target": 2.00,
                "pnl_debt_swap_target": 1.50
            },
            "operational_thresholds": {
                "growth_threshold_usd": 50.00,
                "capacity_threshold_usd": 25.00,
                "debt_swap_threshold_usd": 15.00
            },
            "system_parameters": {
                "health_factor_min": 1.5,
                "usd_to_pnl_rate": 0.10,
                "max_utilization_percent": 85,
                "re_leverage_percent": 15.0,
                "operation_cooldown_seconds": 300
            },
            "conversion_coefficients": {
                "growth_multiplier": 10.0,
                "capacity_multiplier": 12.5,
                "debt_swap_multiplier": 10.0
            }
        }
    
    def _save_config(self):
        """Save current configuration to file"""
        try:
            self.config["metadata"]["last_updated"] = time.time()
            with open(self.config_file, 'w') as f:
                json.dump(self.config, f, indent=2)
            logger.info(f"✅ PnL configuration saved to {self.config_file}")
        except Exception as e:
            logger.error(f"Error saving PnL config: {e}")
    
    def convert_pnl_to_usd_threshold(self, 
                                   target_pnl: float, 
                                   operation_type: str,
                                   market_conditions: Optional[Dict] = None) -> float:
        """
        Convert PnL target to operational USD threshold
        
        Args:
            target_pnl: Target PnL amount in USD
            operation_type: 'growth', 'capacity', or 'debt_swap'
            market_conditions: Optional market data for dynamic adjustment
            
        Returns:
            Operational USD threshold
        """
        try:
            # Get base conversion rate and multiplier
            base_rate = self.config["system_parameters"]["usd_to_pnl_rate"]
            
            # Get operation-specific multiplier
            multiplier_map = {
                "growth": self.config["conversion_coefficients"]["growth_multiplier"],
                "capacity": self.config["conversion_coefficients"]["capacity_multiplier"],
                "debt_swap": self.config["conversion_coefficients"]["debt_swap_multiplier"]
            }
            
            multiplier = multiplier_map.get(operation_type, 10.0)
            
            # Base calculation: PnL * (1/rate) * multiplier
            base_threshold = target_pnl * (1 / base_rate) * multiplier
            
            # Apply market conditions adjustment if provided
            market_adjustment = self._calculate_market_adjustment(market_conditions, operation_type)
            
            # Final threshold calculation
            operational_threshold = base_threshold * market_adjustment
            
            logger.info(f"🔄 PnL Conversion: {target_pnl}$ PnL → {operational_threshold:.2f}$ USD ({operation_type})")
            
            return round(operational_threshold, 2)
            
        except Exception as e:
            logger.error(f"Error in PnL conversion: {e}")
            # Return safe fallback based on operation type
            fallback_map = {
                "growth": 50.0,
                "capacity": 25.0,
                "debt_swap": 15.0
            }
            return fallback_map.get(operation_type, 25.0)
    
    def _calculate_market_adjustment(self, market_conditions: Optional[Dict], operation_type: str) -> float:
        """Calculate market-based adjustment factor"""
        if not market_conditions:
            return 1.0  # No adjustment if no market data
        
        try:
            # Extract market signals
            volatility = market_conditions.get("volatility", "medium")
            trend = market_conditions.get("trend", "neutral")
            health_factor = market_conditions.get("health_factor", 1.5)
            
            adjustment = 1.0
            
            # Volatility adjustment
            if volatility == "high":
                adjustment *= 1.2  # More conservative (higher thresholds)
            elif volatility == "low":
                adjustment *= 0.9  # More aggressive (lower thresholds)
            
            # Trend adjustment
            if trend == "bullish" and operation_type in ["growth", "capacity"]:
                adjustment *= 0.95  # Slightly more aggressive in bull markets
            elif trend == "bearish":
                adjustment *= 1.1  # More conservative in bear markets
            
            # Health factor safety adjustment
            if health_factor < 1.6:
                adjustment *= 1.15  # More conservative with lower health factor
            elif health_factor > 2.0:
                adjustment *= 0.92  # More aggressive with high health factor
            
            return max(0.5, min(2.0, adjustment))  # Clamp between 0.5x and 2.0x
            
        except Exception as e:
            logger.warning(f"Error calculating market adjustment: {e}")
            return 1.0  # Safe fallback
    
    def update_pnl_target(self, operation_type: str, new_pnl_target: float) -> Dict:
        """
        Update PnL target and recalculate operational threshold
        
        Returns:
            Updated configuration with new operational threshold
        """
        try:
            # Normalize operation_type to handle pre-prefixed field names
            # If operation_type is already formatted like "pnl_growth_target", use it directly
            # If it's a clean operation type like "growth", format it properly
            if operation_type.startswith("pnl_") and operation_type.endswith("_target"):
                pnl_key = operation_type  # Already properly formatted
                # Extract base operation type for threshold calculation
                base_operation_type = operation_type.replace("pnl_", "").replace("_target", "")
            else:
                pnl_key = f"pnl_{operation_type}_target"
                base_operation_type = operation_type
            
            # Update PnL target in config
            self.config["pnl_targets"][pnl_key] = new_pnl_target
            
            # Recalculate operational threshold using base operation type
            new_threshold = self.convert_pnl_to_usd_threshold(new_pnl_target, base_operation_type)
            threshold_key = f"{pnl_key}_threshold_usd"  # Use pnl_key + threshold_usd
            self.config["operational_thresholds"][threshold_key] = new_threshold
            
            # Save updated configuration
            self._save_config()
            
            logger.info(f"✅ Updated {base_operation_type}: PnL ${new_pnl_target} → USD ${new_threshold}")
            
            return {
                "operation_type": base_operation_type,
                "pnl_target": new_pnl_target,
                "operational_threshold_usd": new_threshold,
                "success": True,
                "timestamp": time.time()
            }
            
        except Exception as e:
            logger.error(f"Error updating PnL target: {e}")
            return {
                "success": False,
                "error": str(e),
                "timestamp": time.time()
            }
    
    def get_operational_thresholds(self) -> Dict:
        """Get current operational USD thresholds"""
        return self.config["operational_thresholds"].copy()
    
    def get_pnl_targets(self) -> Dict:
        """Get current PnL targets"""
        return self.config["pnl_targets"].copy()
    
    def get_system_parameters(self) -> Dict:
        """Get system parameters"""
        return self.config["system_parameters"].copy()
    
    def validate_pnl_target(self, operation_type: str, pnl_target: float) -> Tuple[bool, str]:
        """Validate PnL target value"""
        try:
            # Basic validation
            if pnl_target <= 0:
                return False, "PnL target must be positive"
            
            if pnl_target > 100:
                return False, "PnL target too high (max: $100)"
            
            # Operation-specific validation
            if operation_type == "growth" and pnl_target < 1.0:
                return False, "Growth PnL target should be at least $1.00"
            
            if operation_type == "capacity" and pnl_target < 0.5:
                return False, "Capacity PnL target should be at least $0.50"
            
            if operation_type == "debt_swap" and pnl_target < 0.5:
                return False, "Debt swap PnL target should be at least $0.50"
            
            return True, "Valid PnL target"
            
        except Exception as e:
            return False, f"Validation error: {e}"
    
    def get_conversion_summary(self) -> Dict:
        """Get summary of current PnL to USD conversions"""
        summary = {}
        
        for operation_type in ["growth", "capacity", "debt_swap"]:
            pnl_key = f"pnl_{operation_type}_target"
            threshold_key = f"{operation_type}_threshold_usd"
            
            pnl_target = self.config["pnl_targets"].get(pnl_key, 0)
            usd_threshold = self.config["operational_thresholds"].get(threshold_key, 0)
            
            summary[operation_type] = {
                "pnl_target": pnl_target,
                "operational_threshold_usd": usd_threshold,
                "conversion_ratio": usd_threshold / pnl_target if pnl_target > 0 else 0
            }
        
        return summary

# Global instance for easy access
pnl_converter = PnLConverter()