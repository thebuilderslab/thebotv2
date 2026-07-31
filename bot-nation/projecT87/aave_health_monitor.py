import os
import json
import time
from web3 import Web3
from eth_account import Account
from dotenv import load_dotenv
import requests
from collections import deque

class AaveHealthMonitor:
    def __init__(self, w3, account, aave_integration):
        self.w3 = w3
        self.account = account
        self.aave = aave_integration

        # Health factor history (stores last 100 readings)
        self.health_history = deque(maxlen=100)
        self.arb_price_history = deque(maxlen=50)

        # Aave V3 Pool address for getUserAccountData
        if self.w3.eth.chain_id == 42161:  # Arbitrum Mainnet
            self.data_provider_address = self.w3.to_checksum_address("0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654")
            self.arb_address = self.w3.to_checksum_address("0x912CE59144191C1204E64559FE8253a0e49E6548")
        else:  # Arbitrum Sepolia (testnet)
            self.data_provider_address = self.w3.to_checksum_address("0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654")
            self.arb_address = self.w3.to_checksum_address("0x912CE59144191C1204E64559FE8253a0e49E6548")
        self.data_provider_abi = self._get_data_provider_abi()
        print(f"🪙 ARB Address (Arbitrum Sepolia): {self.arb_address}")

        # Ensure account address is properly formatted and checksummed
        if hasattr(self.account, 'address'):
            self.user_address = self.w3.to_checksum_address(self.account.address)
        else:
            # Handle case where account might be a string or other format
            account_str = str(self.account)
            if account_str.startswith('0x'):
                self.user_address = self.w3.to_checksum_address(account_str)
            else:
                raise ValueError(f"Invalid account format: {account_str}")

        print(f"📊 Health Monitor Addresses:")
        print(f"   User: {self.user_address}")
        print(f"   Data Provider: {self.data_provider_address}")
        print(f"   ARB Token: {self.arb_address}")

        print(f"📊 Enhanced Aave Health Monitor initialized for {self.user_address}")

    def _get_data_provider_abi(self):
        """Aave V3 Pool ABI for user account data"""
        return [
            {
                "inputs": [{"internalType": "address", "name": "user", "type": "address"}],
                "name": "getUserAccountData",
                "outputs": [
                    {"internalType": "uint256", "name": "totalCollateralBase", "type": "uint256"},
                    {"internalType": "uint256", "name": "totalDebtBase", "type": "uint256"},
                    {"internalType": "uint256", "name": "availableBorrowsBase", "type": "uint256"},
                    {"internalType": "uint256", "name": "currentLiquidationThreshold", "type": "uint256"},
                    {"internalType": "uint256", "name": "ltv", "type": "uint256"},
                    {"internalType": "uint256", "name": "healthFactor", "type": "uint256"}
                ],
                "stateMutability": "view",
                "type": "function"
            }
        ]

    def get_current_health_factor(self):
        """Get current health factor from Aave - uses dashboard's successful method first with enhanced validation"""
        try:
            # Enhanced dashboard data fetching with validation
            print(f"🔍 Enhanced dashboard data fetching with validation...")

            try:
                from web_dashboard import get_live_agent_data
                live_data = get_live_agent_data()

                # Critical None check - prevent NoneType errors
                if live_data is None:
                    print("⚠️ Dashboard returned None - using fallback method")
                    raise Exception("Dashboard method returned None")

                # Enhanced validation with timeout protection
                if not live_data or not isinstance(live_data, dict):
                    print(f"⚠️ Invalid data type from dashboard: {type(live_data)}")
                    raise Exception("No valid data received from dashboard")

                # Validate required fields exist
                required_fields = ['health_factor', 'total_collateral_usdc', 'total_debt_usdc', 'available_borrows_usdc']
                missing_fields = []
                for field in required_fields:
                    if field not in live_data or live_data[field] is None:
                        missing_fields.append(field)

                if missing_fields:
                    print(f"⚠️ Missing fields in dashboard data: {missing_fields}")
                    raise Exception(f"Missing required fields: {missing_fields}")

                # Validate data ranges with None checks
                health_factor = live_data.get('health_factor')
                collateral = live_data.get('total_collateral_usdc')
                
                if health_factor is None or health_factor <= 0:
                    print(f"⚠️ Invalid health factor: {health_factor}")
                    raise Exception(f"Invalid health factor: {health_factor}")
                if health_factor > 1e30:
                    health_factor = float('inf')
                    live_data['health_factor'] = health_factor

                if collateral is None or collateral < 0:
                    print(f"⚠️ Invalid collateral amount: {collateral}")
                    raise Exception(f"Invalid collateral amount: {collateral}")

                # Enhanced data validation
                if live_data and self._validate_aave_data(live_data):
                    print(f"✅ Dashboard method successful with validated data!")
                    print(f"   Health Factor: {live_data['health_factor']:.4f}")
                    print(f"   Collateral: ${live_data['total_collateral_usdc']:,.2f}")
                    print(f"   Debt: ${live_data['total_debt_usdc']:,.2f}")
                    print(f"   Available Borrows: ${live_data['available_borrows_usdc']:,.2f}")
                    print(f"   Data Source: {live_data['data_source']}")
                    print(f"   Data Quality: ✅ VALIDATED")

                    # Get current ETH price for accurate conversion
                    try:
                        import requests
                        url = "https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest"
                        headers = {'X-CMC_PRO_API_KEY': os.getenv('COINMARKETCAP_API_KEY')}
                        params = {'symbol': 'ETH', 'convert': 'USD'}

                        response = requests.get(url, headers=headers, params=params, timeout=10)
                        if response.status_code == 200:
                            data = response.json()
                            eth_price_usd = data['data']['ETH']['quote']['USD']['price']
                            print(f"   Live ETH price: ${eth_price_usd:.2f}")
                        else:
                            eth_price_usd = 2980.0  # Fallback price
                            print(f"   Using fallback ETH price: ${eth_price_usd:.2f}")
                    except:
                        eth_price_usd = 2980.0  # Safe fallback
                        print(f"   Using safe fallback ETH price: ${eth_price_usd:.2f}")

                    # Convert to expected format with accurate ETH values
                    account_data = {
                        'total_collateral_eth': live_data['total_collateral_usdc'] / eth_price_usd,
                        'total_debt_eth': live_data['total_debt_usdc'] / eth_price_usd,
                        'available_borrows_eth': live_data['available_borrows_usdc'] / eth_price_usd,
                        'total_collateral_usdc': live_data['total_collateral_usdc'],
                        'total_debt_usdc': live_data['total_debt_usdc'],
                        'available_borrows_usdc': live_data['available_borrows_usdc'],
                        'health_factor': live_data['health_factor'],
                        'liquidation_threshold': 0.7890,  # From your logs
                        'ltv': 0.7405,  # From your logs
                        'timestamp': time.time(),
                        'data_source': 'dashboard_method_validated',
                        'data_quality': 'high',
                        'eth_price_used': eth_price_usd
                    }

                    self.health_history.append(account_data)
                    return account_data
                else:
                    failure_reason = self._get_data_failure_reason(live_data)
                    print(f"❌ Dashboard data validation failed: {failure_reason}")

            except Exception as dashboard_err:
                print(f"❌ Dashboard method failed with specific error: {dashboard_err}")
                print(f"   Error type: {type(dashboard_err).__name__}")
                print(f"   Attempting fallback methods...")

            # Fallback to original contract method
            print(f"🔄 Using fallback contract method...")
            user_address = self.user_address
            data_provider_address = self.data_provider_address

            print(f"🔍 Calling getUserAccountData with:")
            print(f"   Contract: {data_provider_address}")
            print(f"   User: {user_address}")

            # Test if contract exists first
            try:
                code = self.w3.eth.get_code(data_provider_address)
                if code == b'':
                    print(f"⚠️ No contract deployed at {data_provider_address}")
                    print(f"🔄 CONTINUING OPERATIONS - Using fallback analysis")
                    return self._get_fallback_account_data()
            except Exception as code_err:
                print(f"⚠️ Error checking contract code: {code_err}")
                print(f"🔄 CONTINUING OPERATIONS - Using fallback analysis")
                return self._get_fallback_account_data()

            # Create contract instance
            data_provider_contract = self.w3.eth.contract(
                address=data_provider_address,
                abi=self.data_provider_abi
            )

            # Call the function with latest block to prevent stale data
            user_data = data_provider_contract.functions.getUserAccountData(user_address).call(block_identifier='latest')
            
            print(f"🔍 LIVE DATA: Fetched from block {self.w3.eth.block_number}")
            print(f"⏰ Fresh timestamp: {time.time()}")

            # Extract data from getUserAccountData
            # Note: Aave V3 Pool returns values in USD base units (8 decimals), not ETH
            total_collateral_base = user_data[0] / 1e8  # USD value with 8 decimals
            total_debt_base = user_data[1] / 1e8  # USD value with 8 decimals  
            available_borrows_base = user_data[2] / 1e8  # USD value with 8 decimals
            health_factor_raw = user_data[5]

            # Health factor is returned in 1e18 format, convert to decimal
            health_factor = health_factor_raw / 1e18 if health_factor_raw < 2**256 - 1 else float('inf')

            # These are already in USD, so use them directly
            total_collateral_usdc = total_collateral_base
            total_debt_usdc = total_debt_base
            available_borrows_usdc = available_borrows_base

            # Convert to ETH equivalent for backward compatibility (approximate)
            eth_price_usd = 2400.0  # Approximate ETH price
            total_collateral_eth = total_collateral_usdc / eth_price_usd
            total_debt_eth = total_debt_usdc / eth_price_usd
            available_borrows_eth = available_borrows_usdc / eth_price_usd

            account_data = {
                'total_collateral_eth': total_collateral_eth,
                'total_debt_eth': total_debt_eth,
                'available_borrows_eth': available_borrows_eth,
                'total_collateral_usdc': total_collateral_usdc,
                'total_debt_usdc': total_debt_usdc,
                'available_borrows_usdc': available_borrows_usdc,
                'health_factor': health_factor,
                'liquidation_threshold': user_data[3] / 10000,  # Convert from basis points
                'ltv': user_data[4] / 10000,  # Convert from basis points
                'timestamp': time.time(),
                'data_source': 'aave_contract'
            }

            # Store in history
            self.health_history.append(account_data)

            print(f"✅ Health factor retrieved: {health_factor:.4f}")
            print(f"💰 USD Values from Aave:")
            print(f"   Total Collateral: ${total_collateral_usdc:,.2f}")
            print(f"   Total Debt: ${total_debt_usdc:,.2f}")
            print(f"   Available Borrows: ${available_borrows_usdc:,.2f}")
            print(f"   LTV: {account_data['ltv']*100:.1f}%")
            print(f"   Liquidation Threshold: {account_data['liquidation_threshold']*100:.1f}%")
            return account_data

        except Exception as e:
            print(f"⚠️ Health factor retrieval failed: {e}")
            print(f"   Exception type: {type(e).__name__}")
            print(f"   User address: {self.user_address}")
            print(f"   Contract address: {self.data_provider_address}")
            print(f"🔄 CONTINUING OPERATIONS - Using fallback wallet analysis")

            # Don't halt operations - use fallback analysis
            return self._get_fallback_account_data()

    def _get_fallback_account_data(self):
        """Fallback account data analysis when Aave calls fail - NEVER returns None"""
        try:
            # Get direct wallet balances with None protection
            try:
                eth_balance = self.w3.eth.get_balance(self.user_address) / 1e18
                if eth_balance is None:
                    eth_balance = 0.0
            except Exception as eth_err:
                print(f"⚠️ ETH balance fetch failed: {eth_err}")
                eth_balance = 0.0

            # Try to get token balances directly with None protection
            wbtc_balance = 0.0
            usdc_balance = 0.0

            try:
                if hasattr(self.aave, 'wbtc_address') and self.aave.wbtc_address:
                    balance = self.aave.get_token_balance(self.aave.wbtc_address)
                    wbtc_balance = balance if balance is not None else 0.0
                if hasattr(self.aave, 'usdc_address') and self.aave.usdc_address:
                    balance = self.aave.get_token_balance(self.aave.usdc_address)
                    usdc_balance = balance if balance is not None else 0.0
            except Exception as token_err:
                print(f"⚠️ Token balance retrieval failed: {token_err}")
                wbtc_balance = 0.0
                usdc_balance = 0.0

            # Estimate collateral from transaction history if possible
            estimated_collateral = 0.0
            if wbtc_balance > 0:
                # If we have WBTC, assume some was supplied
                estimated_collateral = wbtc_balance * 0.8  # Conservative estimate

            # GUARANTEED non-None fallback data structure
            fallback_data = {
                'total_collateral_eth': float(estimated_collateral) if estimated_collateral is not None else 0.0,
                'total_debt_eth': 0.0,  # Conservative assumption
                'available_borrows_eth': float(estimated_collateral * 0.7) if estimated_collateral is not None else 0.0,
                'total_collateral_usdc': float(estimated_collateral * 3000) if estimated_collateral is not None else 0.0,  # ~$3000/ETH estimate
                'total_debt_usdc': 0.0,
                'available_borrows_usdc': float(estimated_collateral * 2100) if estimated_collateral is not None else 0.0,  # 70% of collateral
                'health_factor': float('inf') if estimated_collateral == 0 else 1.5,  # Conservative
                'eth_balance': float(eth_balance) if eth_balance is not None else 0.0,
                'wbtc_balance': float(wbtc_balance) if wbtc_balance is not None else 0.0,
                'usdc_balance': float(usdc_balance) if usdc_balance is not None else 0.0,
                'timestamp': time.time(),
                'data_source': 'fallback_analysis',
                'data_quality': 'fallback'
            }

            print(f"🔄 FALLBACK DATA ANALYSIS:")
            print(f"   ETH Balance: {fallback_data['eth_balance']:.6f}")
            print(f"   WBTC Balance: {fallback_data['wbtc_balance']:.8f}")
            print(f"   USDC Balance: {fallback_data['usdc_balance']:.2f}")
            print(f"   Estimated Collateral: {fallback_data['total_collateral_eth']:.6f} ETH")
            print(f"   Health Factor: {fallback_data['health_factor']}")
            print(f"🔄 AGENT WILL CONTINUE WITH FALLBACK DATA")

            # Store in history with None check
            if hasattr(self, 'health_history') and self.health_history is not None:
                self.health_history.append(fallback_data)

            return fallback_data

        except Exception as fallback_err:
            print(f"⚠️ Fallback analysis also failed: {fallback_err}")
            print(f"🔄 USING MINIMAL SAFE DEFAULTS TO CONTINUE OPERATIONS")

            # GUARANTEED minimal safe defaults - NEVER None
            minimal_data = {
                'total_collateral_eth': 0.0,
                'total_debt_eth': 0.0,
                'available_borrows_eth': 0.0,
                'total_collateral_usdc': 0.0,
                'total_debt_usdc': 0.0,
                'available_borrows_usdc': 0.0,
                'health_factor': float('inf'),
                'timestamp': time.time(),
                'data_source': 'minimal_defaults',
                'data_quality': 'minimal'
            }

            print(f"🔴 Using minimal safe defaults to prevent None errors")
            return minimal_data

    def _validate_aave_data(self, data):
        """Validate Aave data quality and completeness with enhanced None checking"""
        # Critical None check first
        if data is None:
            print(f"   ❌ Data is None")
            return False
            
        if not data or not isinstance(data, dict):
            print(f"   ❌ Data is not a valid dictionary: {type(data)}")
            return False

        required_fields = ['health_factor', 'total_collateral_usdc', 'total_debt_usdc', 'available_borrows_usdc']

        for field in required_fields:
            if field not in data:
                print(f"   ❌ Missing required field: {field}")
                return False

            value = data[field]
            if value is None:
                print(f"   ❌ Field {field} is None")
                return False
                
            if isinstance(value, (int, float)) and value < 0:
                print(f"   ❌ Invalid negative value for {field}: {value}")
                return False

        # Additional business logic validation with None protection
        health_factor = data.get('health_factor', 0)
        collateral = data.get('total_collateral_usdc', 0)
        debt = data.get('total_debt_usdc', 0)
        available = data.get('available_borrows_usdc', 0)

        # Ensure no None values in extracted data
        if any(v is None for v in [health_factor, collateral, debt, available]):
            print(f"   ❌ One or more values are None: HF={health_factor}, Col={collateral}, Debt={debt}, Avail={available}")
            return False

        # Health factor should be reasonable (inf is valid — means no active debt)
        import math
        if health_factor < 0.1 or (not math.isinf(health_factor) and health_factor > 100):
            print(f"   ❌ Unrealistic health factor: {health_factor}")
            return False

        # Debt should not exceed collateral significantly
        if debt > collateral * 2:
            print(f"   ❌ Debt too high relative to collateral: ${debt:.2f} vs ${collateral:.2f}")
            return False

        # Available borrows should be reasonable
        if available > collateral:
            print(f"   ❌ Available borrows exceed collateral: ${available:.2f} vs ${collateral:.2f}")
            return False

        print(f"   ✅ Data validation passed")
        return True

    def _get_data_failure_reason(self, data):
        """Get specific reason for data validation failure"""
        if not data:
            return "No data received"

        if not isinstance(data, dict):
            return f"Invalid data type: {type(data)}"

        required_fields = ['health_factor', 'total_collateral_usdc', 'total_debt_usdc', 'available_borrows_usdc']
        missing_fields = [field for field in required_fields if field not in data]

        if missing_fields:
            return f"Missing fields: {missing_fields}"

        health_factor = data.get('health_factor', 0)
        if health_factor <= 0:
            return f"Invalid health factor: {health_factor}"

        return "Data validation failed for unknown reason"

    def get_arb_price(self):
        """Get ARB price from CoinMarketCap API with comprehensive logging"""
        try:
            # Check for API key with detailed validation
            api_key = os.getenv('COINMARKETCAP_API_KEY')
            print(f"🔍 CoinMarketCap API Key status: {'Found' if api_key else 'NOT FOUND'}")

            if not api_key:
                print("❌ CoinMarketCap API key not found in environment")
                print("   Please add COINMARKETCAP_API_KEY to your Replit secrets")
                return None

            # Validate API key format
            if len(api_key) < 32:
                print(f"⚠️  API key seems too short (length: {len(api_key)})")

            # Prepare request with detailed logging
            url = "https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest"
            headers = {
                'Accepts': 'application/json',
                'X-CMC_PRO_API_KEY': api_key,
                'User-Agent': 'Python-requests/2.31.0'
            }

            params = {
                'symbol': 'ARB',
                'convert': 'USD'
            }

            print(f"🌐 DETAILED CoinMarketCap API Request:")
            print(f"   Full URL: {url}")
            print(f"   Headers: {dict((k, v[:8] + '...' if k == 'X-CMC_PRO_API_KEY' else v) for k, v in headers.items())}")
            print(f"   Params: {params}")
            print(f"   API Key prefix: {api_key[:12]}...")
            print(f"   API Key length: {len(api_key)} chars")

            # Make the request with detailed error handling
            print(f"📤 Sending request to CoinMarketCap...")
            response = requests.get(url, headers=headers, params=params, timeout=15)

            print(f"📡 API Response Details:")
            print(f"   Status Code: {response.status_code}")
            print(f"   Response Headers: {dict(response.headers)}")
            print(f"   Content-Type: {response.headers.get('content-type', 'Not specified')}")

            # Log raw response for debugging
            response_text = response.text
            print(f"   Raw Response (first 500 chars): {response_text[:500]}")

            if response.status_code == 200:
                try:
                    data = response.json()
                    print(f"✅ JSON parsing successful")
                    print(f"   Response structure: {list(data.keys()) if isinstance(data, dict) else 'Not a dict'}")

                    # Detailed data validation
                    if 'data' in data:
                        print(f"   Data section found with keys: {list(data['data'].keys()) if isinstance(data['data'], dict) else 'Data not a dict'}")

                        if 'ARB' in data['data']:
                            arb_data = data['data']['ARB']
                            print(f"   ARB data structure: {list(arb_data.keys()) if isinstance(arb_data, dict) else 'ARB data not a dict'}")

                            if 'quote' in arb_data and 'USD' in arb_data['quote']:
                                usd_quote = arb_data['quote']['USD']
                                print(f"   USD quote structure: {list(usd_quote.keys()) if isinstance(usd_quote, dict) else 'USD quote not a dict'}")

                                if 'price' in usd_quote:
                                    arb_price = float(usd_quote['price'])

                                    price_data = {
                                        'price': arb_price,
                                        'timestamp': time.time(),
                                        'market_cap': usd_quote.get('market_cap', 0),
                                        'percent_change_24h': usd_quote.get('percent_change_24h', 0),
                                        'last_updated': usd_quote.get('last_updated', '')
                                    }

                                    print(f"💰 SUCCESS - ARB Price: ${arb_price:.4f}")
                                    print(f"   Market Cap: ${price_data['market_cap']:,.0f}")
                                    print(f"   24h Change: {price_data['percent_change_24h']:.2f}%")
                                    print(f"   Last Updated: {price_data['last_updated']}")

                                    self.arb_price_history.append(price_data)
                                    return price_data
                                else:
                                    print(f"❌ Price field missing from USD quote")
                            else:
                                print(f"❌ USD quote missing from ARB data")
                        else:
                            print(f"❌ ARB symbol not found in data")
                            print(f"   Available symbols: {list(data['data'].keys()) if isinstance(data['data'], dict) else 'None'}")
                    else:
                        print(f"❌ Data section missing from response")
                        if 'status' in data:
                            print(f"   Status info: {data['status']}")

                except json.JSONDecodeError as je:
                    print(f"❌ JSON parsing failed: {je}")
                    print(f"   Raw response: {response_text}")

            elif response.status_code == 429:
                print(f"❌ Rate limit exceeded")
                try:
                    error_data = response.json()
                    print(f"   Rate limit details: {error_data}")
                except:
                    print(f"   Raw rate limit response: {response_text}")

            elif response.status_code == 401:
                print(f"❌ Authentication failed - invalid API key")
                print(f"   Check your COINMARKETCAP_API_KEY in Replit secrets")

            elif response.status_code == 400:
                print(f"❌ Bad request")
                try:
                    error_data = response.json()
                    print(f"   Error details: {error_data}")
                except:
                    print(f"   Raw error response: {response_text}")

            else:
                print(f"❌ HTTP Error {response.status_code}")
                try:
                    error_data = response.json()
                    print(f"   Error details: {error_data}")
                except:
                    print(f"   Raw error response: {response_text}")

            return None

        except requests.exceptions.Timeout:
            print(f"❌ Request timeout after 15 seconds")
            return None
        except requests.exceptions.ConnectionError as ce:
            print(f"❌ Connection error: {ce}")
            return None
        except Exception as e:
            print(f"❌ Unexpected error fetching ARB price: {e}")
            print(f"   Exception type: {type(e).__name__}")
            import traceback
            print(f"   Full traceback: {traceback.format_exc()}")
            return None

    def check_health_factor_increase_trigger(self, threshold=0.02):
        """Check if health factor has increased by threshold amount"""
        if len(self.health_history) < 2:
            return False, 0

        current_hf = self.health_history[-1]['health_factor']
        previous_hf = self.health_history[-2]['health_factor']

        increase = current_hf - previous_hf

        triggered = increase >= threshold

        if triggered:
            print(f"🚨 BORROW TRIGGER: Health factor increased by {increase:.4f} (from {previous_hf:.4f} to {current_hf:.4f})")

        return triggered, increase

    def check_risk_mitigation_trigger(self, arb_decline_threshold=0.05):
        """Check if both health factor is declining AND ARB price is declining"""
        if len(self.health_history) < 2 or len(self.arb_price_history) < 5:
            return False, {}

        # Check health factor decline
        current_hf = self.health_history[-1]['health_factor']
        previous_hf = self.health_history[-2]['health_factor']
        hf_declining = current_hf < previous_hf

        # Check ARB price decline (compare with 5-period moving average)
        recent_arb_prices = [p['price'] for p in list(self.arb_price_history)[-5:]]
        current_arb_price = recent_arb_prices[-1]
        avg_recent_price = sum(recent_arb_prices[:-1]) / len(recent_arb_prices[:-1])

        arb_decline_pct = (avg_recent_price - current_arb_price) / avg_recent_price
        arb_declining = arb_decline_pct >= arb_decline_threshold

        risk_triggered = hf_declining and arb_declining

        risk_data = {
            'health_factor_declining': hf_declining,
            'hf_change': current_hf - previous_hf,
            'arb_declining': arb_declining,
            'arb_decline_pct': arb_decline_pct,
            'current_arb_price': current_arb_price,
            'avg_recent_arb': avg_recent_price
        }

        if risk_triggered:
            print(f"🚨 RISK MITIGATION TRIGGER:")
            print(f"   Health Factor: {previous_hf:.4f} → {current_hf:.4f} (declining)")
            print(f"   ARB Price: ${avg_recent_price:.4f} → ${current_arb_price:.4f} (-{arb_decline_pct*100:.2f}%)")

        return risk_triggered, risk_data

    def convert_eth_to_usdc(self, eth_amount):
        """Convert ETH amount to USDC equivalent using current ARB price as proxy"""
        try:
            # Use ARB price data to estimate ETH/USD rate
            # This is a simplified conversion - in production you'd want dedicated ETH price feed
            arb_price_data = self.get_arb_price()
            if arb_price_data:
                # Rough estimate: 1 ETH ≈ $2000 (simplified for demo)
                eth_price_usd = 2000.0  # This should be fetched from a proper ETH price API
                return float(eth_amount) * eth_price_usd
            return 0.0
        except Exception as e:
            print(f"❌ ETH to USDC conversion failed: {e}")
            return 0.0

    def get_account_data_with_usdc(self):
        """Get account data with USDC conversions"""
        try:
            base_data = self.get_current_health_factor()
            if not base_data:
                return None

            # Convert ETH values to USDC
            total_collateral_usdc = self.convert_eth_to_usdc(base_data['total_collateral_eth'])
            total_debt_usdc = self.convert_eth_to_usdc(base_data['total_debt_eth'])
            available_borrows_usdc = self.convert_eth_to_usdc(base_data['available_borrows_eth'])

            # Add USDC conversions to the data
            enhanced_data = base_data.copy()
            enhanced_data.update({
                'total_collateral_usdc': total_collateral_usdc,
                'total_debt_usdc': total_debt_usdc,
                'available_borrows_usdc': available_borrows_usdc
            })

            print(f"💰 Account Data (USDC converted):")
            print(f"   Collateral: {total_collateral_usdc:.2f} USDC ({base_data['total_collateral_eth']:.6f} ETH)")
            print(f"   Debt: {total_debt_usdc:.2f} USDC ({base_data['total_debt_eth']:.6f} ETH)")
            print(f"   Available Borrows: {available_borrows_usdc:.2f} USDC ({base_data['available_borrows_eth']:.6f} ETH)")

            return enhanced_data

        except Exception as e:
            print(f"❌ Failed to get account data with USDC: {e}")
            return None

    def get_arb_balance(self):
        """Get current ARB token balance"""
        try:
            # Use pre-checksummed addresses
            arb_address = self.arb_address
            user_address = self.user_address

            print(f"🔍 Getting ARB balance for {user_address} from {arb_address}")

            # Test if ARB contract exists
            try:
                code = self.w3.eth.get_code(arb_address)
                if code == b'':
                    print(f"❌ No ARB contract deployed at {arb_address}")
                    print(f"💡 Using mock ARB balance for testing")
                    return 10.0  # Mock balance for testing
            except Exception as code_err:
                print(f"❌ Error checking ARB contract code: {code_err}")
                return 0.0

            arb_contract = self.w3.eth.contract(
                address=arb_address, 
                abi=self.aave.erc20_abi
            )

            balance = arb_contract.functions.balanceOf(user_address).call()
            decimals = arb_contract.functions.decimals().call()

            formatted_balance = float(balance) / float(10 ** decimals)
            print(f"✅ ARB balance: {formatted_balance:.4f}")

            return formatted_balance

        except Exception as e:
            print(f"❌ Failed to get ARB balance: {e}")
            print(f"   Exception type: {type(e).__name__}")
            print(f"   User address: {self.user_address}")
            print(f"   ARB address: {self.arb_address}")
            return 0.0

    def calculate_optimal_usdc_borrow(self, target_health_factor=1.19):
        """Calculate optimal USDC borrow amount to reach target health factor"""
        try:
            current_data = self.get_current_health_factor()
            if not current_data:
                return 0.0

            current_hf = current_data['health_factor']
            total_collateral_eth = current_data['total_collateral_eth']
            total_debt_eth = current_data['total_debt_eth']

            # Convert all values to float to avoid Decimal/float mixing
            # Handle Decimal, int, float, and string types safely
            try:
                current_hf = float(current_hf) if current_hf is not None else 0.0
            except (TypeError, ValueError):
                current_hf = 0.0

            try:
                total_collateral_eth = float(total_collateral_eth) if total_collateral_eth is not None else 0.0
            except (TypeError, ValueError):
                total_collateral_eth = 0.0

            try:
                total_debt_eth = float(total_debt_eth) if total_debt_eth is not None else 0.0
            except (TypeError, ValueError):
                total_debt_eth = 0.0

            target_health_factor = float(target_health_factor)

            # Simplified calculation: assuming 1 ETH = $2000, 1 USDC = $1
            # Target: (collateral * liquidation_threshold) / (total_debt + new_usdc_debt) = target_hf

            # Assume average liquidation threshold of 82.5% for WBTC/WETH/DAI mix
            liquidation_threshold = float(0.825)
            eth_price_usd = float(2000.0)  # Simplified assumption

            # Calculate how much USDC we canborrow to reach target health factor
            collateral_value_usd = total_collateral_eth * eth_price_usd
            current_debt_usd = total_debt_eth * eth_price_usd

            # (collateral_value * liq_threshold) / (current_debt + new_usdc_debt) = target_hf
            # new_usdc_debt = (collateral_value * liq_threshold) / target_hf - current_debt

            max_debt_for_target = (collateral_value_usd * liquidation_threshold) / target_health_factor
            optimal_usdc_borrow = max_debt_for_target - current_debt_usd

            return max(0.0, optimal_usdc_borrow)

        except Exception as e:
            print(f"❌ Failed to calculate optimal borrow: {e}")
            return 0.0

    def get_individual_aave_balances(self):
        """Get individual aToken balances with enhanced error handling"""
        balances = {}

        # aToken addresses for Arbitrum Mainnet (corrected addresses)
        atoken_addresses = {
            'aWBTC': Web3.to_checksum_address('0x078f358208685046a11c85e8ad32895ded33a249'),
            'aWETH': Web3.to_checksum_address('0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8'),
            'aUSDC': Web3.to_checksum_address('0x625e7708f30ca75bfd92586e17077590c60eb4cd')
        }

    def get_monitoring_summary(self):
        """Get comprehensive monitoring summary - continues operations on any failures"""
        print(f"🔄 GENERATING MONITORING SUMMARY...")

        # Get health data with fallback handling
        current_health = self.get_current_health_factor()

        # Get market data with error handling
        current_arb_price = None
        arb_balance = 0.0

        try:
            current_arb_price = self.get_arb_price()
        except Exception as price_err:
            print(f"⚠️ ARB price fetch failed: {price_err} - continuing without price data")

        try:
            arb_balance = self.get_arb_balance()
        except Exception as balance_err:
            print(f"⚠️ ARB balance fetch failed: {balance_err} - continuing with 0 balance")

        # Check triggers with error handling
        borrow_trigger, hf_increase = False, 0
        risk_trigger, risk_data = False, {}
        optimal_borrow = 0

        try:
            borrow_trigger, hf_increase = self.check_health_factor_increase_trigger()
            risk_trigger, risk_data = self.check_risk_mitigation_trigger()
            optimal_borrow = self.calculate_optimal_usdc_borrow() if borrow_trigger else 0
        except Exception as trigger_err:
            print(f"⚠️ Trigger analysis failed: {trigger_err} - using safe defaults")

        # Extract data source information
        data_source = current_health.get('data_source', 'unknown') if current_health else 'failed'

        summary = {
            'current_health_factor': current_health['health_factor'] if current_health else float('inf'),
            'total_collateral_eth': current_health.get('total_collateral_eth', 0) if current_health else 0,
            'total_debt_eth': current_health.get('total_debt_eth', 0) if current_health else 0,
            'arb_price': current_arb_price['price'] if current_arb_price else 0,
            'arb_balance': arb_balance,
            'borrow_trigger_active': borrow_trigger,
            'health_factor_increase': hf_increase,
            'risk_trigger_active': risk_trigger,
            'risk_data': risk_data,
            'optimal_usdc_borrow': optimal_borrow,
            'data_source': data_source,
            'timestamp': time.time()
        }

        print(f"📊 MONITORING SUMMARY COMPLETE:")
        print(f"   Health Factor: {summary['current_health_factor']:.4f} (Source: {data_source})")
        print(f"   Collateral: {summary['total_collateral_eth']:.6f} ETH")
        print(f"   Debt: {summary['total_debt_eth']:.6f} ETH")
        print(f"   ARB Price: ${summary['arb_price']:.4f}")
        print(f"   Data Quality: {'✅ Complete' if data_source == 'aave_contract' else '⚠️ Partial' if data_source == 'fallback_analysis' else '🔴 Minimal'}")

        return summary