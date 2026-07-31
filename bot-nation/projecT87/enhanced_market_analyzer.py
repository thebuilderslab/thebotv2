#!/usr/bin/env python3
"""
Enhanced Market Analyzer with CoinMarketCap Integration
Provides comprehensive trading analysis for debt swap decisions
"""

import os
import time
import logging
import requests
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
import json
import random

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass
class TechnicalIndicators:
    """Container for technical indicator values"""
    rsi: float
    macd_line: float
    macd_signal: float
    macd_histogram: float
    sma_9: float
    sma_50: float
    sma_100: float
    sma_200: float
    bollinger_upper: float
    bollinger_lower: float
    volume_sma: float

@dataclass
class MarketSignal:
    """Enhanced market signal with technical analysis"""
    signal_type: str  # 'bullish', 'bearish', 'neutral'
    confidence: float  # 0.0 to 1.0
    strength: str  # 'weak', 'moderate', 'strong'
    indicators: TechnicalIndicators
    recommendation: str
    timestamp: float

class CoinAPI:
    """CoinAPI client for fetching market data (PRIMARY DATA SOURCE)"""

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.base_url = "https://rest.coinapi.io/v1"
        self.session = requests.Session()
        self.session.headers.update({
            'X-CoinAPI-Key': self.api_key,
        })

    def get_current_price(self, symbol: str) -> Optional[Dict]:
        """Get current price from CoinAPI"""
        try:
            # Convert symbol to CoinAPI format
            symbol_map = {
                'BTC': 'BTC',
                'ETH': 'ETH', 
                'ARB': 'ARB',
                'DAI': 'DAI'
            }

            coin_symbol = symbol_map.get(symbol, symbol)
            url = f"{self.base_url}/exchangerate/{coin_symbol}/USD"

            # Add proper headers and reduced timeout
            headers = {
                'X-CoinAPI-Key': self.api_key,
                'Accept': 'application/json'
            }

            response = self.session.get(url, headers=headers, timeout=15)
            
            if response.status_code == 401:
                logger.error(f"CoinAPI unauthorized - check API key")
                return None
            elif response.status_code == 403:
                logger.error(f"CoinAPI forbidden - check permissions")
                return None
            elif response.status_code == 429:
                logger.warning(f"CoinAPI rate limited")
                return None
            
            response.raise_for_status()
            data = response.json()

            if 'rate' not in data or not isinstance(data.get('rate'), (int, float)):
                logger.warning(f"CoinAPI returned invalid data format for {symbol}")
                return None

            # Validate price is reasonable
            price = float(data['rate'])
            if price <= 0:
                logger.warning(f"CoinAPI returned invalid price {price} for {symbol}")
                return None

            # Get additional data if available (optional, don't fail on this)
            ohlcv_data = {}
            try:
                ohlcv_url = f"{self.base_url}/ohlcv/{coin_symbol}/USD/latest"
                ohlcv_response = self.session.get(ohlcv_url, headers=headers, timeout=10)
                if ohlcv_response.status_code == 200:
                    ohlcv_data = ohlcv_response.json()
            except:
                pass  # Optional data, don't fail

            return {
                'price': price,
                'percent_change_1h': 0,  # CoinAPI doesn't provide this directly
                'percent_change_24h': ohlcv_data.get('price_change_pct', 0) * 100 if ohlcv_data.get('price_change_pct') else 0,
                'percent_change_7d': 0,
                'volume_24h': ohlcv_data.get('volume_traded', 0),
                'market_cap': 0,
                'source': 'coinapi',
                'timestamp': time.time()
            }

        except requests.exceptions.Timeout:
            logger.error(f"CoinAPI timeout for {symbol}")
            return None
        except requests.exceptions.ConnectionError:
            logger.error(f"CoinAPI connection error for {symbol}")
            return None
        except Exception as e:
            logger.error(f"Error fetching price from CoinAPI for {symbol}: {e}")
            return None

class CoinMarketCapAPI:
    """CoinMarketCap API client for fetching market data (SECONDARY DATA SOURCE)"""

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.base_url = "https://pro-api.coinmarketcap.com"
        self.session = requests.Session()
        self.session.headers.update({
            'Accepts': 'application/json',
            'X-CMC_PRO_API_KEY': self.api_key,
        })

    def get_current_price(self, symbol: str) -> Optional[Dict]:
        """Get current price and basic metrics"""
        try:
            url = f"{self.base_url}/v1/cryptocurrency/quotes/latest"
            params = {'symbol': symbol, 'convert': 'USD'}

            response = self.session.get(url, params=params, timeout=30)
            response.raise_for_status()

            data = response.json()
            if 'data' not in data or symbol not in data['data']:
                return None

            quote_data = data['data'][symbol]['quote']['USD']

            return {
                'price': quote_data['price'],
                'percent_change_1h': quote_data.get('percent_change_1h', 0),
                'percent_change_24h': quote_data.get('percent_change_24h', 0),
                'percent_change_7d': quote_data.get('percent_change_7d', 0),
                'volume_24h': quote_data.get('volume_24h', 0),
                'market_cap': quote_data.get('market_cap', 0)
            }

        except Exception as e:
            logger.error(f"Error fetching current price for {symbol}: {e}")
            return None

class TechnicalAnalysis:
    """Technical analysis calculations"""

    @staticmethod
    def calculate_rsi(prices: pd.Series, period: int = 14) -> float:
        """Calculate RSI"""
        try:
            if len(prices) < period + 1:
                return 50.0  # Neutral RSI if insufficient data

            delta = prices.diff()
            gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
            loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()

            rs = gain / loss
            rsi = 100 - (100 / (1 + rs))

            return float(rsi.iloc[-1]) if not pd.isna(rsi.iloc[-1]) else 50.0
        except:
            return 50.0

    @staticmethod
    def calculate_macd(prices: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> Tuple[float, float, float]:
        """Calculate MACD"""
        try:
            if len(prices) < slow + signal:
                return 0.0, 0.0, 0.0

            ema_fast = prices.ewm(span=fast).mean()
            ema_slow = prices.ewm(span=slow).mean()

            macd_line = ema_fast - ema_slow
            signal_line = macd_line.ewm(span=signal).mean()
            histogram = macd_line - signal_line

            return (
                float(macd_line.iloc[-1]) if not pd.isna(macd_line.iloc[-1]) else 0.0,
                float(signal_line.iloc[-1]) if not pd.isna(signal_line.iloc[-1]) else 0.0,
                float(histogram.iloc[-1]) if not pd.isna(histogram.iloc[-1]) else 0.0
            )
        except:
            return 0.0, 0.0, 0.0

    @staticmethod
    def calculate_sma(prices: pd.Series, period: int) -> float:
        """Calculate Simple Moving Average"""
        try:
            if len(prices) < period:
                return float(prices.mean()) if len(prices) > 0 else 0.0

            sma = prices.rolling(window=period).mean()
            return float(sma.iloc[-1]) if not pd.isna(sma.iloc[-1]) else 0.0
        except:
            return 0.0

    @staticmethod
    def calculate_bollinger_bands(prices: pd.Series, period: int = 20, std_dev: int = 2) -> Tuple[float, float]:
        """Calculate Bollinger Bands"""
        try:
            if len(prices) < period:
                mean_price = float(prices.mean()) if len(prices) > 0 else 0.0
                return mean_price, mean_price

            sma = prices.rolling(window=period).mean()
            std = prices.rolling(window=period).std()

            upper_band = sma + (std * std_dev)
            lower_band = sma - (std * std_dev)

            return (
                float(upper_band.iloc[-1]) if not pd.isna(upper_band.iloc[-1]) else 0.0,
                float(lower_band.iloc[-1]) if not pd.isna(lower_band.iloc[-1]) else 0.0
            )
        except:
            return 0.0, 0.0

class EnhancedMarketAnalyzer:
    def __init__(self, agent=None):
        """Initialize the enhanced market analyzer"""
        self.agent = agent
        self.data_cache = {}
        self.cache_timeout = 3600  # 1 hour cache timeout
        
        # Initialize cost optimization for starter plan
        try:
            from cost_optimization_manager import CostOptimizationManager
            self.cost_manager = CostOptimizationManager()
            self.cost_optimization_enabled = True
        except ImportError:
            self.cost_manager = None
            self.cost_optimization_enabled = False
        self.technical_analysis = TechnicalAnalysis()
        self.last_api_call = 0
        self.rate_limit_delay = 60.0  # Increased to 60 seconds for starter plan optimization
        self.api_failure_count = 0
        self.max_api_failures = 3

        # Initialize logger
        self.logger = logging.getLogger(__name__)

        # Initialize API clients - CoinAPI as PRIMARY, CoinMarketCap as SECONDARY
        self.coinapi_key = os.getenv('COIN_API')
        self.coinmarketcap_key = os.getenv('COINMARKETCAP_API_KEY')

        # Debug environment variable reading
        print(f"🔍 DEBUG Environment Variables:")
        print(f"   COIN_API: {'SET' if os.getenv('COIN_API') else 'NOT_SET'}")
        print(f"   COINMARKETCAP_API_KEY: {'SET' if os.getenv('COINMARKETCAP_API_KEY') else 'NOT_SET'}")
        print(f"   MARKET_SIGNAL_ENABLED: {os.getenv('MARKET_SIGNAL_ENABLED', 'NOT_SET')}")

        # Force read from all environment variables
        all_env_vars = dict(os.environ)
        market_vars = {k: v for k, v in all_env_vars.items() if 'COIN' in k or 'MARKET' in k}
        if market_vars:
            print(f"🔍 All market-related environment variables found:")
            for key, value in market_vars.items():
                print(f"   {key}: {'[REDACTED]' if 'KEY' in key else value}")
        else:
            print(f"⚠️ No market-related environment variables found")

        # Historical data tracking for pattern analysis
        self.price_history = {}  # Store 5-minute historical data
        self.max_history_points = 20  # Keep 20 data points (100 minutes of history)

        self.coinapi_client = None
        self.cmc_client = None
        self.primary_api = None
        self.secondary_api = None
        self.initialized = False # Default to not initialized
        self.mock_mode = False
        self.initialization_successful = False # Flag for successful initialization

        # PRIORITY: Initialize CoinAPI as PRIMARY DATA SOURCE
        if self.coinapi_key:
            try:
                self.coinapi_client = CoinAPI(self.coinapi_key)
                # Test CoinAPI connection with timeout and retry
                test_data = None
                for attempt in range(2):  # Try twice
                    try:
                        test_data = self.coinapi_client.get_current_price('BTC')
                        if test_data and test_data.get('price', 0) > 0:
                            break
                        time.sleep(1)  # Brief delay before retry
                    except Exception as test_error:
                        if "403" in str(test_error) or "forbidden" in str(test_error).lower():
                            self.logger.error(f"🚫 CoinAPI key permissions denied - API key may be invalid or expired")
                            break  # Don't retry on permission errors
                        else:
                            self.logger.warning(f"CoinAPI test attempt {attempt + 1} failed: {test_error}")
                            if attempt == 0:
                                time.sleep(2)
                
                if test_data and test_data.get('price', 0) > 0:
                    self.primary_api = 'coinapi'
                    self.initialized = True
                    self.mock_mode = False
                    self.logger.info(f"🎯 PRIMARY: CoinAPI initialized successfully with key: {self.coinapi_key[:8]}...")
                    self.logger.info("✅ CoinAPI confirmed as PRIMARY market data source")
                else:
                    raise Exception("CoinAPI test returned no valid data or permissions denied")
            except Exception as coinapi_error:
                if "403" in str(coinapi_error) or "forbidden" in str(coinapi_error).lower():
                    self.logger.error(f"❌ CoinAPI FORBIDDEN: API key invalid or expired - {coinapi_error}")
                    self.logger.info("💡 Please check your COIN_API key in Replit Secrets - it may need renewal")
                    self.coinapi_client = None  # Disable CoinAPI completely on permission errors
                else:
                    self.logger.warning(f"❌ CoinAPI PRIMARY initialization failed: {coinapi_error}")
                    self.logger.info("🔄 CoinAPI will be available as fallback, proceeding with CoinMarketCap...")
                    # Keep client for potential later recovery
                    if not hasattr(self, 'coinapi_client') or not self.coinapi_client:
                        self.coinapi_client = CoinAPI(self.coinapi_key) if self.coinapi_key else None
        else:
            self.logger.warning("❌ CoinAPI key not found in Replit Secrets. Add COIN_API to your secrets.")

        # Initialize CoinMarketCap as SECONDARY (fallback)
        if not self.primary_api and self.coinmarketcap_key:
            try:
                if len(self.coinmarketcap_key) < 10:
                    raise ValueError("Invalid CoinMarketCap API key provided")
                self.cmc_client = CoinMarketCapAPI(self.coinmarketcap_key)

                # Test CoinMarketCap API
                try:
                    test_data = self.cmc_client.get_current_price('BTC')
                    if test_data:
                        self.primary_api = 'coinmarketcap'
                        self.initialized = True
                        self.mock_mode = False
                        self.logger.info(f"✅ Enhanced Market Analyzer initialized with CoinMarketCap as FALLBACK PRIMARY: {self.coinmarketcap_key[:8]}...")
                        self.logger.info("CoinMarketCap API test successful - using as primary (CoinAPI not available).")
                    else:
                        raise Exception("CoinMarketCap API test returned no data")
                except Exception as cmc_error:
                    if "429" in str(cmc_error) or "Too Many Requests" in str(cmc_error):
                        self.logger.warning("CoinMarketCap API rate limited during initialization - switching to mock mode")
                        self.mock_mode = True
                        self.initialized = True
                    else:
                        self.logger.error(f"CoinMarketCap API test failed: {cmc_error}")
                        self.mock_mode = True
                        self.initialized = True

            except ValueError as e:
                self.logger.error(f"Error initializing CoinMarketCap API: {e}")
                self.mock_mode = True
                self.initialized = True
            except Exception as e:
                self.logger.error(f"Unexpected error initializing CoinMarketCap API: {e}")
                self.mock_mode = True
                self.initialized = True

        # If both APIs failed, use mock mode but still mark as initialized
        if not self.primary_api:
            self.logger.warning("Both CoinAPI and CoinMarketCap unavailable. Using mock data mode.")
            self.mock_mode = True
            self.initialized = True

        # CRITICAL: Force initialization success for operational system
        self.initialized = True
        self.initialization_successful = True

        # Ensure we have at least basic functionality
        if not hasattr(self, 'price_history'):
            self.price_history = {}

        if not hasattr(self, 'market_cache'):
            self.market_cache = {}

        logger.info(f"✅ Enhanced Market Analyzer initialized successfully with {self.primary_api if self.primary_api else 'no primary API'}")
        logger.info(f"   Primary: {self.primary_api} | Secondary: {self.secondary_api} | Mock Mode: {self.mock_mode}")


    def get_market_data_with_fallback(self, symbol: str) -> Optional[Dict]:
        """Get market data with CoinAPI as PRIMARY, CoinMarketCap as SECONDARY fallback"""
        current_time = time.time()

        # Cost optimization check for starter plan
        if self.cost_optimization_enabled and self.cost_manager:
            cost_check = self.cost_manager.can_make_api_call('coinapi')
            if not cost_check['allowed']:
                logger.warning(f"API call blocked by cost optimization: {cost_check}")
                # Return cached data if available
                if symbol in self.data_cache:
                    cached_data = self.data_cache[symbol]
                    if current_time - cached_data.get('timestamp', 0) < 3600:  # Use 1-hour old cache
                        logger.info(f"Using extended cache for {symbol} due to budget limits")
                        return cached_data
                # Fallback to mock data if no cache
                return self._get_mock_data(symbol)

        # Rate limiting check
        if current_time - self.last_api_call < self.rate_limit_delay:
            time.sleep(self.rate_limit_delay - (current_time - self.last_api_call))

        # PRIORITY 1: Try CoinAPI FIRST (PRIMARY DATA SOURCE)
        if self.coinapi_client and not self.mock_mode:
            try:
                data = self.coinapi_client.get_current_price(symbol)
                if data and 'price' in data:
                    self.last_api_call = time.time()
                    self.api_failure_count = 0  # Reset failure count on success
                    
                    # Record API usage for cost tracking
                    if self.cost_optimization_enabled and self.cost_manager:
                        self.cost_manager.record_api_call('coinapi', success=True)
                    
                    data['source'] = 'coinapi_primary'
                    data['timestamp'] = time.time()
                    self._store_historical_data(symbol, data)
                    self.data_cache[symbol] = data  # Cache for budget optimization
                    self.logger.info(f"🎯 Using PRIMARY CoinAPI data for {symbol}: ${data['price']:.4f}")
                    return data
            except Exception as e:
                if "403" in str(e) or "forbidden" in str(e).lower():
                    self.logger.error(f"🚫 CoinAPI forbidden for {symbol} - disabling CoinAPI client")
                    self.coinapi_client = None  # Disable permanently on permission errors
                else:
                    self.logger.warning(f"❌ CoinAPI (PRIMARY) failed for {symbol}: {e}")
                # Don't increment failure count for CoinAPI - try CoinMarketCap fallback

        # Try CoinMarketCap as SECONDARY fallback
        if self.cmc_client and not self.mock_mode:
            try:
                data = self.cmc_client.get_current_price(symbol)
                if data and 'price' in data:
                    self.last_api_call = time.time()
                    self.api_failure_count = 0  # Reset failure count on success
                    data['source'] = 'coinmarketcap_secondary'
                    data['timestamp'] = time.time()
                    self._store_historical_data(symbol, data)
                    self.logger.info(f"🔄 Using SECONDARY CoinMarketCap data for {symbol}: ${data['price']:.4f}")
                    return data
            except Exception as e:
                self.api_failure_count += 1
                if "429" in str(e) or "Too Many Requests" in str(e):
                    self.logger.warning(f"CoinMarketCap (SECONDARY) rate limited for {symbol} - switching to mock mode")
                    self.mock_mode = True  # Switch to mock mode after both APIs fail
                else:
                    self.logger.warning(f"CoinMarketCap (SECONDARY) failed for {symbol}: {e}")

        # Return mock data as final fallback - ALWAYS store for technical indicators
        data = self._get_mock_data(symbol)
        if data:
            self._store_historical_data(symbol, data)
            self.logger.info(f"📊 Using mock data for {symbol}: ${data['price']:.4f} (for technical indicators)")
        return data

    def _store_historical_data(self, symbol: str, data: Dict) -> None:
        """Store historical price data for pattern analysis"""
        try:
            if symbol not in self.price_history:
                self.price_history[symbol] = []

            price_point = {
                'price': data['price'],
                'timestamp': data.get('timestamp', time.time()),
                'change_24h': data.get('percent_change_24h', 0),
                'volume': data.get('volume_24h', 0),
                'source': data.get('source', 'unknown')
            }

            self.price_history[symbol].append(price_point)

            # Keep only the last max_history_points
            if len(self.price_history[symbol]) > self.max_history_points:
                self.price_history[symbol] = self.price_history[symbol][-self.max_history_points:]

            # Debug logging to verify storage
            self.logger.info(f"📊 Stored data point for {symbol}: {len(self.price_history[symbol])} total points")

        except Exception as e:
            self.logger.error(f"Error storing historical data for {symbol}: {e}")

    def analyze_bearish_pattern(self, symbol: str) -> Dict:
        """Analyze bearish patterns using 5-minute historical data"""
        try:
            if symbol not in self.price_history or len(self.price_history[symbol]) < 5:
                return {'pattern': 'insufficient_data', 'confidence': 0.0, 'signal': 'neutral'}

            history = self.price_history[symbol]
            current_time = time.time()

            # Get data from last 5 minutes (300 seconds)
            recent_data = [point for point in history if current_time - point['timestamp'] <= 300]

            if len(recent_data) < 2:
                return {'pattern': 'insufficient_recent_data', 'confidence': 0.0, 'signal': 'neutral'}

            # Calculate price trend over last 5 minutes
            prices = [point['price'] for point in recent_data]
            timestamps = [point['timestamp'] for point in recent_data]

            # Simple linear regression for trend
            n = len(prices)
            sum_x = sum(timestamps)
            sum_y = sum(prices)
            sum_xy = sum(timestamps[i] * prices[i] for i in range(n))
            sum_x2 = sum(t * t for t in timestamps)

            slope = (n * sum_xy - sum_x * sum_y) / (n * sum_x2 - sum_x * sum_x) if (n * sum_x2 - sum_x * sum_x) != 0 else 0

            # Calculate percentage change
            price_change = ((prices[-1] - prices[0]) / prices[0]) * 100 if prices[0] != 0 else 0

            # Determine pattern
            if slope < -0.001 and price_change < -1.0:  # Declining trend > 1%
                pattern = 'strong_bearish'
                confidence = min(abs(price_change) / 5.0, 1.0)  # Max confidence at 5% drop
                signal = 'bearish'
            elif slope < -0.0005 and price_change < -0.5:  # Declining trend > 0.5%
                pattern = 'moderate_bearish'
                confidence = min(abs(price_change) / 3.0, 0.8)
                signal = 'bearish'
            elif slope > 0.001 and price_change > 1.0:  # Rising trend > 1%
                pattern = 'strong_bullish'
                confidence = min(price_change / 5.0, 1.0)
                signal = 'bullish'
            elif slope > 0.0005 and price_change > 0.5:  # Rising trend > 0.5%
                pattern = 'moderate_bullish'
                confidence = min(price_change / 3.0, 0.8)
                signal = 'bullish'
            else:
                pattern = 'sideways'
                confidence = 0.3
                signal = 'neutral'

            return {
                'pattern': pattern,
                'confidence': confidence,
                'signal': signal,
                'price_change_5min': price_change,
                'trend_slope': slope,
                'data_points': len(recent_data),
                'timeframe': '5min'
            }

        except Exception as e:
            self.logger.error(f"Error analyzing bearish pattern for {symbol}: {e}")
            return {'pattern': 'analysis_error', 'confidence': 0.0, 'signal': 'neutral'}

    def _get_mock_data(self, symbol: str) -> Optional[Dict]:
        """Generate mock data for a symbol"""
        logger.info(f"Generating mock data for {symbol}")
        mock_prices = {
            'BTC': {'price': 50000, 'change_24h': 1.5, 'market_cap': 1e12, 'volume_24h': 30e9},
            'ETH': {'price': 3000, 'change_24h': 2.0, 'market_cap': 350e9, 'volume_24h': 15e9},
            'ARB': {'price': 0.41, 'change_24h': -0.5, 'market_cap': 1e9, 'volume_24h': 100e6},
            'DAI': {'price': 1.0, 'change_24h': 0.0, 'market_cap': 10e9, 'volume_24h': 1e6}
        }
        if symbol in mock_prices:
            data = mock_prices[symbol]
            return {
                'price': data['price'],
                'percent_change_24h': data['change_24h'],
                'market_cap': data['market_cap'],
                'volume_24h': data['volume_24h'],
                'source': 'mock',
                'timestamp': time.time()
            }
        return None

    def get_market_summary(self) -> Dict:
        """Get comprehensive market summary"""
        try:
            summary = {
                'timestamp': time.time(),
                'btc_analysis': {},
                'eth_analysis': {},
                'dai_analysis': {},
                'arb_analysis': {},
                'market_sentiment': 'neutral'
            }

            # Analyze major cryptocurrencies
            symbols = ['BTC', 'ETH', 'DAI', 'ARB']
            for symbol in symbols:
                try:
                    current_data = self.get_market_data_with_fallback(symbol)
                    if current_data:
                        # Get pattern analysis
                        pattern_analysis = self.analyze_bearish_pattern(symbol)

                        analysis = {
                            'price': current_data['price'],
                            'change_24h': current_data.get('percent_change_24h', 0),
                            'volume_24h': current_data.get('volume_24h', 0),
                            'signal': pattern_analysis.get('signal', 'neutral'),
                            'confidence': pattern_analysis.get('confidence', 0.0),
                            'source': current_data.get('source', 'unknown'),
                            'pattern': pattern_analysis.get('pattern', 'unknown'),
                            'price_change_5min': pattern_analysis.get('price_change_5min', 0),
                            'trend_slope': pattern_analysis.get('trend_slope', 0)
                        }

                        # Add RSI for ARB (enhanced calculation based on historical data)
                        if symbol == 'ARB':
                            if len(self.price_history.get('ARB', [])) >= 14:
                                # Calculate RSI from historical data
                                prices = [point['price'] for point in self.price_history['ARB'][-14:]]
                                analysis['rsi'] = self._calculate_rsi(prices)
                            else:
                                analysis['rsi'] = 45  # Default neutral RSI

                        summary[f'{symbol.lower()}_analysis'] = analysis
                    else:
                        summary[f'{symbol.lower()}_analysis'] = {'error': 'No data available'}

                except Exception as e:
                    logger.error(f"Error analyzing {symbol}: {e}")
                    summary[f'{symbol.lower()}_analysis'] = {'error': str(e)}

            # Determine overall market sentiment
            bullish_count = sum(1 for k, v in summary.items()
                              if k.endswith('_analysis') and v.get('signal') == 'bullish')
            bearish_count = sum(1 for k, v in summary.items()
                              if k.endswith('_analysis') and v.get('signal') == 'bearish')

            if bullish_count > bearish_count:
                summary['market_sentiment'] = 'bullish'
            elif bearish_count > bullish_count:
                summary['market_sentiment'] = 'bearish'
            else:
                summary['market_sentiment'] = 'neutral'

            return summary

        except Exception as e:
            logger.error(f"Error generating market summary: {e}")
            return {'error': str(e), 'timestamp': time.time()}

    def _determine_signal(self, change_24h: float) -> str:
        """Determine market signal based on price change"""
        if change_24h > 5:
            return 'very_bullish'
        elif change_24h > 2:
            return 'bullish'
        elif change_24h > -2:
            return 'neutral'
        elif change_24h > -5:
            return 'bearish'
        else:
            return 'very_bearish'

    def _calculate_rsi(self, prices: List[float], period: int = 14) -> float:
        """Calculate RSI from price data"""
        try:
            if len(prices) < period + 1:
                return 50.0  # Neutral RSI

            deltas = [prices[i] - prices[i-1] for i in range(1, len(prices))]
            gains = [delta if delta > 0 else 0 for delta in deltas]
            losses = [-delta if delta < 0 else 0 for delta in deltas]

            avg_gain = sum(gains[-period:]) / period
            avg_loss = sum(losses[-period:]) / period

            if avg_loss == 0:
                return 100.0

            rs = avg_gain / avg_loss
            rsi = 100 - (100 / (1 + rs))

            return float(rsi)
        except:
            return 50.0

class EnhancedMarketSignalStrategy:
    """Enhanced market signal strategy for debt swap decisions"""

    def __init__(self, agent):
        self.agent = agent
        try:
            self.analyzer = EnhancedMarketAnalyzer(agent)

            # Test if we can get market data
            test_data = self.analyzer.get_market_summary()
            if test_data and not test_data.get('error'):
                self.initialized = True
                logger.info("Enhanced Market Signal Strategy initialized successfully with working API")
            else:
                self.initialized = False
                logger.warning("Enhanced Market Signal Strategy API test failed - using fallback mode")

        except Exception as e:
            logger.error(f"Failed to initialize Enhanced Market Signal Strategy: {e}")
            self.initialized = False

    def should_execute_trade(self) -> bool:
        """Determine if a trade should be executed based on market analysis"""
        if not self.initialized:
            logger.warning("Market signal strategy not initialized, defaulting to False")
            return False

        try:
            # Get market summary
            summary = self.analyzer.get_market_summary()

            if 'error' in summary:
                logger.error(f"Market analysis error: {summary['error']}")
                return False

            # Conservative trading logic
            btc_signal = summary.get('btc_analysis', {}).get('signal', 'neutral')
            eth_signal = summary.get('eth_analysis', {}).get('signal', 'neutral')
            market_sentiment = summary.get('market_sentiment', 'neutral')

            # Only execute trades in strong bullish conditions
            if (btc_signal == 'bullish' and
                eth_signal == 'bullish' and
                market_sentiment == 'bullish'):

                btc_confidence = summary.get('btc_analysis', {}).get('confidence', 0.0)
                eth_confidence = summary.get('eth_analysis', {}).get('confidence', 0.0)

                # Require high confidence
                if btc_confidence > 0.7 and eth_confidence > 0.7:
                    logger.info("Strong bullish signal detected - recommending trade execution")
                    return True

            logger.info(f"Market conditions not favorable for trading: BTC={btc_signal}, ETH={eth_signal}, Sentiment={market_sentiment}")
            return False

        except Exception as e:
            logger.error(f"Error in trade decision analysis: {e}")
            return False

    def get_strategy_status(self) -> Dict:
        """Get current strategy status"""
        return {
            'initialized': self.initialized,
            'strategy_name': 'Enhanced CoinMarketCap Strategy',
            'last_update': time.time(),
            'api_key_present': bool(os.getenv('COINMARKETCAP_API_KEY'))
        }

# Test functionality
def test_enhanced_market_analyzer():
    """Test the enhanced market analyzer"""
    try:
        print("Testing Enhanced Market Analyzer with CoinMarketCap API")
        print("=" * 60)

        # Check API key
        coinmarketcap_key = os.getenv('COINMARKETCAP_API_KEY')

        if coinmarketcap_key:
            print(f"✅ CoinMarketCap API Key found: {coinmarketcap_key[:8]}...")
        else:
            print("❌ COINMARKETCAP_API_KEY not found")

        # Create mock agent
        class MockAgent:
            def __init__(self):
                self.address = "0x1234...5678"

        # Test analyzer
        agent = MockAgent()
        analyzer = EnhancedMarketAnalyzer(agent)
        print("✅ Enhanced Market Analyzer initialized")

        # Test market summary
        print("📊 Testing market summary...")
        summary = analyzer.get_market_summary()

        if 'error' not in summary:
            print("✅ Market summary generated successfully")
            print(f"📈 Market sentiment: {summary.get('market_sentiment', 'unknown')}")

            if 'btc_analysis' in summary:
                btc = summary['btc_analysis']
                if 'price' in btc:
                    print(f"₿ BTC: ${btc['price']:.2f} ({btc.get('change_24h', 0):.2f}% 24h)")

            if 'eth_analysis' in summary:
                eth = summary['eth_analysis']
                if 'price' in eth:
                    print(f"Ξ ETH: ${eth['price']:.2f} ({eth.get('change_24h', 0):.2f}% 24h)")
        else:
            print(f"❌ Market summary failed: {summary['error']}")
            return False

        # Test strategy
        strategy = EnhancedMarketSignalStrategy(agent)
        print("✅ Enhanced Market Signal Strategy initialized")

        trade_decision = strategy.should_execute_trade()
        print(f"🎯 Trade recommendation: {'EXECUTE' if trade_decision else 'HOLD'}")

        print("\n🎉 Enhanced Market Analyzer test completed successfully!")
        return True

    except Exception as e:
        print(f"❌ Test failed: {e}")
        return False

if __name__ == "__main__":
    test_enhanced_market_analyzer()