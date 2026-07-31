"""Uniswap V3 integration for Arbitrum mainnet/testnet.
DAI-based swaps: DAI → WBTC, DAI → WETH, DAI → USDC (direct stablecoin swap).
"""

import os
import time
import logging
from web3 import Web3
from eth_account import Account
from delegation_client import get_tx_broadcast_lock, acquire_nonce, confirm_nonce, reset_nonce

logger = logging.getLogger(__name__)

class UniswapIntegration:
    def __init__(self, w3, account):
        self.w3 = w3
        self.account = account
        self.address = account.address

        # Determine network based on chain ID
        chain_id = self.w3.eth.chain_id

        if chain_id == 42161:  # Arbitrum Mainnet
            print(f"🌐 Initializing Uniswap for Arbitrum Mainnet (Chain ID: {chain_id})")
            self.router_address = self.w3.to_checksum_address("0xE592427A0AEce92De3Edee1F18E0157C05861564")  # SwapRouter (original V3)
            self.factory_address = self.w3.to_checksum_address("0x1F98431c8aD98523631AE4a59f267346ea31F984")  # V3 Factory
            self.quoter_address = self.w3.to_checksum_address("0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6")   # Quoter V2

            # Mainnet token addresses - Fixed duplicates and added ARB
            self.weth_address = self.w3.to_checksum_address("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1")
            self.dai_address = self.w3.to_checksum_address("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1")
            self.wbtc_address = self.w3.to_checksum_address("0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f")
            self.usdt_address = self.w3.to_checksum_address("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9")
            self.arb_address = self.w3.to_checksum_address("0x912CE59144191C1204E64559FE8253a0e49E6548")
        else:  # Arbitrum Sepolia Testnet
            print(f"🧪 Initializing Uniswap for Arbitrum Sepolia Testnet (Chain ID: {chain_id})")
            # Uniswap V3 Arbitrum Sepolia addresses
            self.router_address = self.w3.to_checksum_address("0x101F443B4d1b059569D643917553c771E1b9663E")  # SwapRouter
            self.factory_address = self.w3.to_checksum_address("0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e")  # V3 Factory
            self.quoter_address = self.w3.to_checksum_address("0x2779a0CC1c3e0E44D2542EC3637094d26349e68e")   # Quoter V2

            # Testnet token addresses - Fixed duplicates and added ARB
            self.weth_address = self.w3.to_checksum_address("0x980B62Da83eFf3D4576C647993b0c1D7faf17c73")
            self.dai_address = self.w3.to_checksum_address("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d")
            self.wbtc_address = self.w3.to_checksum_address("0x078f358208685046a11C85e8ad32895DED33A249")
            self.usdt_address = None
            self.arb_address = self.w3.to_checksum_address("0x1b20e6a3B2a86618C32A37ffcD5E98C0d20a6E42")

        self.router_abi = self._get_router_abi()
        self.erc20_abi = self._get_erc20_abi()

        self.router_contract = self.w3.eth.contract(
            address=self.router_address, 
            abi=self.router_abi
        )

        print(f"🔄 Uniswap V3 integration initialized")

    def _sign_and_send(self, tx_dict):
        with get_tx_broadcast_lock():
            nonce = acquire_nonce(self.w3, self.address)
            tx_dict['nonce'] = nonce
            try:
                signed = self.w3.eth.account.sign_transaction(tx_dict, self.account.key)
                tx_hash = self.w3.eth.send_raw_transaction(signed.rawTransaction)
                confirm_nonce()
                return tx_hash
            except Exception as e:
                err_msg = str(e).lower()
                if "nonce too low" in err_msg or "already known" in err_msg or "replacement transaction" in err_msg:
                    reset_nonce()
                raise

    def _get_router_abi(self):
        """Uniswap V3 SwapRouter (original) ABI — deadline IS in the struct"""
        return [
            {
                "inputs": [
                    {
                        "components": [
                            {"internalType": "address", "name": "tokenIn", "type": "address"},
                            {"internalType": "address", "name": "tokenOut", "type": "address"},
                            {"internalType": "uint24", "name": "fee", "type": "uint24"},
                            {"internalType": "address", "name": "recipient", "type": "address"},
                            {"internalType": "uint256", "name": "deadline", "type": "uint256"},
                            {"internalType": "uint256", "name": "amountIn", "type": "uint256"},
                            {"internalType": "uint256", "name": "amountOutMinimum", "type": "uint256"},
                            {"internalType": "uint160", "name": "sqrtPriceLimitX96", "type": "uint160"}
                        ],
                        "internalType": "struct ISwapRouter.ExactInputSingleParams",
                        "name": "params",
                        "type": "tuple"
                    }
                ],
                "name": "exactInputSingle",
                "outputs": [{"internalType": "uint256", "name": "amountOut", "type": "uint256"}],
                "stateMutability": "payable",
                "type": "function"
            },
            {
                "inputs": [
                    {
                        "components": [
                            {"internalType": "bytes", "name": "path", "type": "bytes"},
                            {"internalType": "address", "name": "recipient", "type": "address"},
                            {"internalType": "uint256", "name": "deadline", "type": "uint256"},
                            {"internalType": "uint256", "name": "amountIn", "type": "uint256"},
                            {"internalType": "uint256", "name": "amountOutMinimum", "type": "uint256"}
                        ],
                        "internalType": "struct ISwapRouter.ExactInputParams",
                        "name": "params",
                        "type": "tuple"
                    }
                ],
                "name": "exactInput",
                "outputs": [{"internalType": "uint256", "name": "amountOut", "type": "uint256"}],
                "stateMutability": "payable",
                "type": "function"
            }
        ]

    def _get_erc20_abi(self):
        """Complete ERC20 ABI with all required functions for swap validation"""
        return [
            {
                "inputs": [
                    {"internalType": "address", "name": "spender", "type": "address"},
                    {"internalType": "uint256", "name": "amount", "type": "uint256"}
                ],
                "name": "approve",
                "outputs": [{"internalType": "bool", "name": "", "type": "bool"}],
                "stateMutability": "nonpayable",
                "type": "function"
            },
            {
                "inputs": [{"internalType": "address", "name": "account", "type": "address"}],
                "name": "balanceOf",
                "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
                "stateMutability": "view",
                "type": "function"
            },
            {
                "inputs": [],
                "name": "decimals",
                "outputs": [{"internalType": "uint8", "name": "", "type": "uint8"}],
                "stateMutability": "view",
                "type": "function"
            },
            {
                "inputs": [
                    {"internalType": "address", "name": "owner", "type": "address"},
                    {"internalType": "address", "name": "spender", "type": "address"}
                ],
                "name": "allowance",
                "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
                "stateMutability": "view",
                "type": "function"
            },
            {
                "inputs": [],
                "name": "symbol",
                "outputs": [{"internalType": "string", "name": "", "type": "string"}],
                "stateMutability": "view",
                "type": "function"
            },
            {
                "inputs": [],
                "name": "name",
                "outputs": [{"internalType": "string", "name": "", "type": "string"}],
                "stateMutability": "view",
                "type": "function"
            },
            {
                "inputs": [],
                "name": "totalSupply",
                "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
                "stateMutability": "view",
                "type": "function"
            }
        ]

    def _convert_to_wei(self, token_address, amount):
        """Convert amount to wei based on token decimals"""
        try:
            token_contract = self.w3.eth.contract(address=token_address, abi=self.erc20_abi)
            decimals = token_contract.functions.decimals().call()
        except:
            # Fallback decimals if contract call fails
            token_address_lower = token_address.lower()
            if token_address_lower == "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1":  # DAI
                decimals = 18
            elif token_address_lower == "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f":  # WBTC
                decimals = 8
            elif token_address_lower == "0x912ce59144191c1204e64559fe8253a0e49e6548":  # ARB
                decimals = 18
            elif token_address_lower == "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9":  # USDT
                decimals = 6
            elif token_address_lower == "0xaf88d065e77c8cc2239327c5edb3a432268e5831":  # USDC
                decimals = 6
            else:
                decimals = 18
        return int(amount * (10 ** decimals))


    def swap_tokens(self, token_in, token_out, amount_in, fee=3000):
        """Execute token swap on Uniswap V3 with enhanced validation and error handling - DAI-ONLY ENFORCEMENT"""
        try:
            # CRITICAL: Enforce DAI-only swap policy
            dai_address_lower = self.dai_address.lower()
            wbtc_address_lower = self.wbtc_address.lower()
            weth_address_lower = self.weth_address.lower()

            token_in_lower = token_in.lower()
            token_out_lower = token_out.lower()

            # Validate allowed swap combinations including ARB and USDC
            arb_address = "0x912CE59144191C1204E64559FE8253a0e49E6548"
            arb_address_lower = arb_address.lower()
            usdc_address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"  # USDC on Arbitrum
            usdc_address_lower = usdc_address.lower()

            usdt_address = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"
            usdt_address_lower = usdt_address.lower()

            allowed_swaps = [
                (dai_address_lower, wbtc_address_lower),  # DAI → WBTC
                (dai_address_lower, weth_address_lower),  # DAI → WETH
                (dai_address_lower, arb_address_lower),   # DAI → ARB
                (arb_address_lower, dai_address_lower),   # ARB → DAI
                (dai_address_lower, usdc_address_lower),  # DAI → USDC
                (weth_address_lower, wbtc_address_lower), # WETH → WBTC (Liability Short)
                (weth_address_lower, dai_address_lower),  # WETH → DAI (Liability Short)
                (weth_address_lower, usdc_address_lower), # WETH → USDC
                (weth_address_lower, usdt_address_lower), # WETH → USDT (Liability Short collateral)
                (usdt_address_lower, weth_address_lower), # USDT → WETH (Short close)
                (usdt_address_lower, usdc_address_lower), # USDT → USDC (Short profit → Wallet B)
                (dai_address_lower, usdt_address_lower),  # DAI → USDT (Nurse/Capacity conversion)
            ]

            current_swap = (token_in_lower, token_out_lower)
            if current_swap not in allowed_swaps:
                print(f"❌ FORBIDDEN SWAP: {token_in} → {token_out}")
                print(f"🚫 Only DAI → WBTC and DAI → WETH swaps are allowed")
                print(f"🎯 Current swap pair not in allowlist: {current_swap}")
                return None

            if token_out_lower == wbtc_address_lower:
                token_out_name = "WBTC"
            elif token_out_lower == weth_address_lower:
                token_out_name = "WETH"
            elif token_out_lower == arb_address_lower:
                token_out_name = "ARB"
            elif token_out_lower == usdc_address_lower:
                token_out_name = "USDC"
            elif token_out_lower == usdt_address_lower:
                token_out_name = "USDT"
            elif token_in_lower == arb_address_lower:
                token_out_name = "DAI (from ARB)"
            elif token_in_lower == weth_address_lower and token_out_lower == dai_address_lower:
                token_out_name = "DAI (from WETH)"
            elif token_in_lower == usdt_address_lower and token_out_lower == weth_address_lower:
                token_out_name = "WETH (from USDT)"
            else:
                token_out_name = "UNKNOWN"

            print(f"✅ APPROVED SWAP: {token_in_lower.split('x')[1][:6]}... → {token_out_name}")

            # Enhanced contract validation
            for token_addr in [token_in, token_out]:
                if token_addr != "0x0000000000000000000000000000000000000000":
                    try:
                        checksummed_addr = self.w3.to_checksum_address(token_addr)
                        code = self.w3.eth.get_code(checksummed_addr)
                        if code == b'':
                            print(f"❌ No contract found at {token_addr}")
                            return None

                        # Verify it's a valid ERC20 token
                        token_contract = self.w3.eth.contract(address=checksummed_addr, abi=self.erc20_abi)
                        symbol = token_contract.functions.symbol().call()
                        decimals = token_contract.functions.decimals().call()

                        print(f"✅ Token validated: {symbol} (decimals: {decimals}) at {checksummed_addr}")

                    except Exception as contract_error:
                        print(f"❌ Token contract validation failed for {token_addr}: {contract_error}")
                        return None

            # Continue with swap execution logic here
            return self._execute_validated_swap(token_in, token_out, amount_in, fee)

        except Exception as e:
            print(f"❌ Token swap failed: {e}")
            return None

    def _execute_validated_swap(self, token_in, token_out, amount_in, fee):
        """Execute validated exactInputSingle swap with proper retry loop.
        - Fresh on-chain quote before each attempt
        - Dynamic slippage tolerance based on USD value
        - Rebuilt transaction bytecode on every retry
        - Standardized max-uint256 approval via _ensure_token_approval_for_router
        """
        try:
            print(f"🔄 Executing validated swap: {amount_in} tokens")

            amount_in_wei = self._convert_to_wei(token_in, amount_in)
            print(f"🔄 Converting {amount_in} to {amount_in_wei} wei")

            if amount_in_wei <= 0:
                print(f"❌ Invalid wei conversion result: {amount_in_wei}")
                return None

            eth_balance = self.w3.eth.get_balance(self.address)
            min_eth_needed = self.w3.to_wei(0.0002, 'ether')
            if eth_balance < min_eth_needed:
                print(f"❌ Insufficient ETH for gas: {self.w3.from_wei(eth_balance, 'ether'):.6f} ETH")
                return None

            if token_in != "0x0000000000000000000000000000000000000000":
                token_contract = self.w3.eth.contract(address=token_in, abi=self.erc20_abi)
                current_balance = token_contract.functions.balanceOf(self.address).call()
                decimals = token_contract.functions.decimals().call()
                readable_balance = current_balance / (10 ** decimals)
                if readable_balance < amount_in:
                    print(f"❌ Insufficient balance: {readable_balance:.6f} < {amount_in:.6f}")
                    return None
                print(f"✅ Balance check: {readable_balance:.6f} >= {amount_in:.6f}")

                if not self._ensure_token_approval_for_router(token_in, amount_in_wei):
                    print("❌ Router approval failed — cannot swap")
                    return None

            chain_id = self.w3.eth.chain_id
            is_eth_in = (token_in == "0x0000000000000000000000000000000000000000")
            usd_value = amount_in  # DAI-based system: amount_in ≈ USD value (1 DAI ≈ $1)
            slippage_multiplier = self._get_slippage_tolerance(usd_value)
            slippage_pct = round((1 - slippage_multiplier) * 100, 1)

            fee_tiers_to_try = [fee, 500, 3000, 10000]
            seen = set()
            fee_tiers_unique = []
            for f in fee_tiers_to_try:
                if f not in seen:
                    seen.add(f)
                    fee_tiers_unique.append(f)

            best_fee = fee
            best_quote = 0
            for test_fee in fee_tiers_unique:
                quote = self._get_fresh_quote(token_in, token_out, test_fee, amount_in_wei)
                if quote > best_quote:
                    best_quote = quote
                    best_fee = test_fee
                    print(f"💡 Best quote so far — fee {test_fee}: {quote}")

            if best_quote > 0:
                fee = best_fee
                print(f"✅ Using fee tier {fee}, quote {best_quote}, slippage {slippage_pct}%")

            max_attempts = 3
            for attempt in range(max_attempts):
                print(f"\n🔄 Swap attempt {attempt + 1}/{max_attempts}")

                fresh_quote = self._get_fresh_quote(token_in, token_out, fee, amount_in_wei)
                if fresh_quote > 0:
                    min_output = max(1, int(fresh_quote * slippage_multiplier))
                    print(f"📊 Fresh quote: {fresh_quote}, min output ({slippage_pct}% slippage): {min_output}")
                else:
                    min_output = 1
                    print(f"⚠️ No quote available, using amountOutMinimum = 1")

                swap_params = {
                    'tokenIn': self.w3.to_checksum_address(token_in),
                    'tokenOut': self.w3.to_checksum_address(token_out),
                    'fee': fee,
                    'recipient': self.w3.to_checksum_address(self.address),
                    'deadline': int(time.time()) + 600,
                    'amountIn': amount_in_wei,
                    'amountOutMinimum': min_output,
                    'sqrtPriceLimitX96': 0
                }

                base_gas_price = self.w3.eth.gas_price
                swap_gas_price = int(base_gas_price * 2.5) if chain_id == 42161 else int(base_gas_price * 1.5)
                gas_limit = 500000

                swap_tx = self.router_contract.functions.exactInputSingle(
                    swap_params
                ).build_transaction({
                    'from': self.address,
                    'chainId': chain_id,
                    'gas': gas_limit,
                    'gasPrice': swap_gas_price,
                    'nonce': 0,
                    'value': amount_in_wei if is_eth_in else 0
                })

                print(f"⛽ Gas: {self.w3.from_wei(swap_gas_price, 'gwei'):.4f} gwei, limit: {gas_limit}")

                try:
                    estimated_gas = self.w3.eth.estimate_gas(swap_tx)
                    swap_tx['gas'] = min(int(estimated_gas * 1.8), 800000)
                    print(f"💰 Gas estimate: {estimated_gas} → using {swap_tx['gas']}")
                except Exception as gas_err:
                    err_str = str(gas_err)
                    if 'STF' in err_str or 'Too little received' in err_str:
                        print(f"❌ Gas estimation reverted: {err_str}")
                        if attempt < max_attempts - 1:
                            slippage_multiplier = max(0.90, slippage_multiplier - 0.02)
                            slippage_pct = round((1 - slippage_multiplier) * 100, 1)
                            print(f"🔄 Widening slippage to {slippage_pct}% and retrying with fresh quote...")
                            time.sleep(2)
                            continue
                        else:
                            print("❌ All attempts exhausted — skipping this swap")
                            return None
                    elif 'execution reverted' in str(gas_err).lower():
                        print(f"❌ Gas estimation reverted: {gas_err} — skipping (would waste gas)")
                        return None
                    elif 'insufficient funds' in str(gas_err).lower():
                        print("❌ Insufficient ETH for gas fees")
                        return None
                    else:
                        print(f"⚠️ Gas estimation failed: {gas_err}, using fallback {gas_limit}")

                try:
                    tx_hash = self._sign_and_send(swap_tx)
                    print(f"✅ Swap sent: {tx_hash.hex()}")

                    receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
                    if receipt.status == 1:
                        print(f"✅ Swap confirmed on-chain!")
                        return tx_hash.hex()
                    else:
                        print(f"❌ Swap reverted on-chain (attempt {attempt + 1})")
                        if attempt < max_attempts - 1:
                            slippage_multiplier = max(0.90, slippage_multiplier - 0.02)
                            slippage_pct = round((1 - slippage_multiplier) * 100, 1)
                            print(f"🔄 Widening slippage to {slippage_pct}% and retrying with fresh quote...")
                            time.sleep(3)
                            continue
                        return None

                except ValueError as send_err:
                    err_msg = str(send_err)
                    if 'nonce too low' in err_msg and attempt < max_attempts - 1:
                        print(f"⚠️ Nonce conflict, retrying...")
                        time.sleep(1)
                        continue
                    else:
                        raise

            print("❌ All swap attempts exhausted")
            return None

        except Exception as e:
            print(f"❌ Swap failed with error: {e}")
            import traceback
            print(f"🔍 Full traceback: {traceback.format_exc()}")
            return None

    def optimize_collateral_via_swap(self, aave_integration, current_collateral_amount):
        """Swap borrowed DAI assets to optimize collateral position - STRICT DAI-ONLY OPERATIONS"""
        try:
            print("🔄 Optimizing collateral through strategic DAI swapping...")
            print("🎯 STRICT MODE: Only DAI → WBTC and DAI → WETH swaps allowed")

            # Enforce DAI-only policy - reject any DAI operations
            if hasattr(aave_integration, 'dai_address'):
                print("⚠️ DAI contract detected but will NOT be used in swaps")
                print("🚫 System configured for DAI-only swap operations")

            # Check DAI balance instead of DAI
            dai_balance = aave_integration.get_token_balance(aave_integration.dai_address)

            if dai_balance > 5.0:  # If we have more than $5 DAI
                # Swap portion of DAI to WETH for diversification
                swap_amount = min(dai_balance * 0.4, 20.0)  # Max $20 or 40% of balance

                print(f"🔄 Swapping {swap_amount:.2f} DAI to WETH for collateral optimization")

                swap_tx = self.swap_tokens(
                    aave_integration.dai_address,   # DAI in
                    aave_integration.weth_address,  # WETH out
                    swap_amount,
                    500  # 0.05% fee (lower fee tier for stablecoin->ETH)
                )

                if swap_tx:
                    print("✅ DAI → WETH collateral optimization swap completed")
                    return True
                else:
                    print("❌ DAI → WETH swap failed")

            # Also check for WBTC diversification
            if dai_balance > 10.0:  # If we have substantial DAI
                wbtc_swap_amount = min(dai_balance * 0.2, 15.0)  # Max $15 or 20% to WBTC

                print(f"🔄 Swapping {wbtc_swap_amount:.2f} DAI to WBTC for collateral diversification")

                wbtc_swap_tx = self.swap_tokens(
                    aave_integration.dai_address,   # DAI in
                    aave_integration.wbtc_address,  # WBTC out
                    wbtc_swap_amount,
                    500  # 0.05% fee
                )

                if wbtc_swap_tx:
                    print("✅ DAI → WBTC collateral diversification swap completed")
                    return True

            return False

        except Exception as e:
            print(f"❌ Collateral optimization failed: {e}")
            import traceback
            print(f"🔍 Full error: {traceback.format_exc()}")
            return False

    def _encode_path(self, tokens, fees):
        """Encode multi-hop path for Uniswap V3 exactInput
        Path format: token0 (20 bytes) + fee (3 bytes) + token1 (20 bytes) + fee (3 bytes) + token2 (20 bytes)
        """
        path = b''
        for i, token in enumerate(tokens):
            path += bytes.fromhex(token[2:])
            if i < len(fees):
                path += fees[i].to_bytes(3, 'big')
        return path

    def _audit_path(self, path_bytes, token_names, fees):
        """Pre-flight byte-level audit of encoded path — prints hex, length, and decoded fees"""
        print("=" * 60)
        print("🔍 PRE-FLIGHT PATH AUDIT (abi.encodePacked)")
        print(f"   Full hex: 0x{path_bytes.hex()}")
        expected_len = 20 * len(token_names) + 3 * len(fees)
        print(f"   Length:   {len(path_bytes)} bytes (expected {expected_len} for {len(token_names)}-token path)")
        offset = 0
        for i, name in enumerate(token_names):
            addr = path_bytes[offset:offset+20]
            print(f"   {name} addr: {addr.hex()} ({len(addr)} bytes)")
            offset += 20
            if i < len(fees):
                fee_bytes = path_bytes[offset:offset+3]
                fee_val = int.from_bytes(fee_bytes, 'big')
                pct = fee_val / 1_000_000 * 100
                print(f"   Fee tier:  0x{fee_bytes.hex()} = {fee_val} ({pct:.2f}%)")
                offset += 3
        valid = len(path_bytes) == (20 * len(token_names) + 3 * len(fees))
        print(f"   AUDIT: {'✅ PASS' if valid else '❌ FAIL — unexpected byte length'}")
        print("=" * 60)

    def _get_slippage_tolerance(self, usd_value):
        """Dynamic slippage tolerance based on swap size.
        < $50: 5% slippage (prioritize success over precision)
        >= $50: 1% slippage (standard safety)
        Returns the multiplier to apply to expected_output (e.g. 0.95 = 5% slippage).
        """
        if usd_value < 50:
            return 0.95
        return 0.99

    def _get_fresh_quote(self, token_in, token_out, fee, amount_in_wei):
        """Fetch a fresh on-chain quote from Uniswap V3 Quoter. Returns expected output in wei or 0 on failure."""
        try:
            quoter_contract = self.w3.eth.contract(
                address=self.quoter_address,
                abi=[{
                    "inputs": [
                        {"name": "tokenIn", "type": "address"},
                        {"name": "tokenOut", "type": "address"},
                        {"name": "fee", "type": "uint24"},
                        {"name": "amountIn", "type": "uint256"},
                        {"name": "sqrtPriceLimitX96", "type": "uint160"}
                    ],
                    "name": "quoteExactInputSingle",
                    "outputs": [{"name": "amountOut", "type": "uint256"}],
                    "stateMutability": "view",
                    "type": "function"
                }]
            )
            return quoter_contract.functions.quoteExactInputSingle(
                self.w3.to_checksum_address(token_in),
                self.w3.to_checksum_address(token_out),
                fee, amount_in_wei, 0
            ).call()
        except Exception as e:
            print(f"⚠️ Quote failed (fee {fee}): {e}")
            return 0

    def _ensure_token_approval_for_router(self, token_address, amount_in_wei):
        """Ensure token is approved for Uniswap Router with max allowance. Waits for on-chain confirmation."""
        try:
            token_contract = self.w3.eth.contract(address=token_address, abi=self.erc20_abi)
            current_allowance = token_contract.functions.allowance(self.address, self.router_address).call()
            if current_allowance >= amount_in_wei:
                print(f"✅ Router allowance sufficient: {current_allowance}")
                return True

            max_uint256 = 2**256 - 1
            base_gas_price = self.w3.eth.gas_price
            chain_id = self.w3.eth.chain_id
            gas_price = int(base_gas_price * 2.5) if chain_id == 42161 else int(base_gas_price * 1.3)
            approve_tx = token_contract.functions.approve(
                self.router_address, max_uint256
            ).build_transaction({
                'from': self.address,
                'chainId': chain_id, 'gas': 100000,
                'gasPrice': gas_price, 'nonce': 0,
            })
            approve_hash = self._sign_and_send(approve_tx)
            print(f"🔐 Router approval sent: {approve_hash.hex()}")
            receipt = self.w3.eth.wait_for_transaction_receipt(approve_hash, timeout=60)
            if receipt.status == 1:
                print(f"✅ Router approval confirmed on-chain")
                return True
            else:
                print(f"❌ Router approval reverted on-chain")
                return False
        except Exception as e:
            print(f"❌ Router approval error: {e}")
            return False

    def _execute_multihop_swap(self, path_bytes, amount_in, amount_in_wei, token_in, description):
        """Execute a multi-hop swap using exactInput"""
        try:
            print(f"🔄 Multi-hop swap: {description}")

            eth_balance = self.w3.eth.get_balance(self.address)
            min_eth_needed = self.w3.to_wei(0.0002, 'ether')
            if eth_balance < min_eth_needed:
                print(f"❌ Insufficient ETH for gas: {self.w3.from_wei(eth_balance, 'ether'):.6f} ETH")
                return None

            if token_in != "0x0000000000000000000000000000000000000000":
                if not self._ensure_token_approval_for_router(token_in, amount_in_wei):
                    print(f"❌ Cannot proceed without token approval for Router")
                    return None

            base_gas_price = self.w3.eth.gas_price
            chain_id = self.w3.eth.chain_id
            swap_gas_price = int(base_gas_price * 2.5) if chain_id == 42161 else int(base_gas_price * 1.5)
            gas_limit = 600000

            swap_params = {
                'path': path_bytes,
                'recipient': self.w3.to_checksum_address(self.address),
                'deadline': int(time.time()) + 600,
                'amountIn': amount_in_wei,
                'amountOutMinimum': 1
            }

            swap_tx = self.router_contract.functions.exactInput(
                swap_params
            ).build_transaction({
                'from': self.address,
                'chainId': chain_id,
                'gas': gas_limit,
                'gasPrice': swap_gas_price,
                'nonce': 0,
                'value': 0
            })

            print(f"⛽ Multi-hop gas: {self.w3.from_wei(swap_gas_price, 'gwei'):.4f} gwei, limit: {gas_limit}")

            try:
                estimated_gas = self.w3.eth.estimate_gas(swap_tx)
                swap_tx['gas'] = min(int(estimated_gas * 1.8), 800000)
                print(f"💰 Multi-hop gas estimate: {estimated_gas} → using {swap_tx['gas']}")
            except Exception as gas_err:
                err_str = str(gas_err)
                if 'STF' in err_str or 'execution reverted' in err_str:
                    print(f"❌ Gas estimation reverted ({err_str}) — skipping this route (would waste gas)")
                    return None
                print(f"⚠️ Multi-hop gas estimation failed: {gas_err}, using {gas_limit}")

            tx_hash = self._sign_and_send(swap_tx)
            print(f"✅ Multi-hop swap sent: {tx_hash.hex()}")

            receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
            if receipt.status == 1:
                print(f"✅ Multi-hop swap confirmed!")
                return tx_hash.hex()
            else:
                print(f"❌ Multi-hop swap reverted on-chain")
                return None

        except Exception as e:
            print(f"❌ Multi-hop swap error: {e}")
            import traceback
            traceback.print_exc()
            return None

    def swap_dai_for_wbtc(self, dai_amount):
        """Swap DAI for WBTC on Uniswap V3 — uses multi-hop DAI→WETH→WBTC for better liquidity"""
        try:
            print(f"🔄 Swapping {dai_amount:.6f} DAI for WBTC (multi-hop via WETH)...")

            if dai_amount <= 0:
                print("❌ Invalid DAI amount for swap")
                return False

            amount_in_wei = int(dai_amount * 1e18)

            fees_attempt1 = [500, 500]
            path_bytes = self._encode_path(
                [self.dai_address, self.weth_address, self.wbtc_address],
                fees_attempt1
            )
            self._audit_path(path_bytes, ["DAI", "WETH", "WBTC"], fees_attempt1)

            swap_result = self._execute_multihop_swap(
                path_bytes, dai_amount, amount_in_wei,
                self.dai_address, f"{dai_amount:.4f} DAI → WETH → WBTC"
            )

            if not swap_result:
                print("⚠️ Multi-hop 500/500 failed, trying 3000/500 fee tiers...")
                fees_attempt2 = [3000, 500]
                path_bytes = self._encode_path(
                    [self.dai_address, self.weth_address, self.wbtc_address],
                    fees_attempt2
                )
                self._audit_path(path_bytes, ["DAI", "WETH", "WBTC"], fees_attempt2)
                swap_result = self._execute_multihop_swap(
                    path_bytes, dai_amount, amount_in_wei,
                    self.dai_address, f"{dai_amount:.4f} DAI →(3000)→ WETH →(500)→ WBTC"
                )

            if not swap_result:
                print("⚠️ Multi-hop failed, trying direct DAI→WBTC single-hop...")
                swap_result_direct = self._execute_swap(
                    self.dai_address, self.wbtc_address, dai_amount, "DAI", "WBTC"
                )
                if swap_result_direct and isinstance(swap_result_direct, str):
                    swap_result = swap_result_direct

            if swap_result and isinstance(swap_result, str):
                return {
                    'success': True,
                    'tx_hash': swap_result,
                    'amount_in': dai_amount,
                    'token_in': 'DAI',
                    'token_out': 'WBTC'
                }
            else:
                print("❌ All WBTC swap attempts failed")
                return False

        except Exception as e:
            print(f"❌ DAI to WBTC swap failed: {e}")
            return False

    def swap_dai_for_usdc(self, dai_amount):
        """Swap DAI for USDC via FORCED multi-hop: DAI → WETH → USDC.
        Direct DAI→USDC pools have no liquidity on Arbitrum (bridged DAI vs native USDC).
        Both legs use fee tier 500 (0.05%) where deep liquidity exists.
        Slippage: 5% for multi-hop safety (two hops + small amounts).
        """
        try:
            usdc_address = self.w3.to_checksum_address("0xaf88d065e77c8cC2239327C5EDb3A432268e5831")

            if dai_amount <= 0:
                print("❌ Invalid DAI amount for USDC swap")
                return False

            amount_in_wei = int(dai_amount * 1e18)

            print(f"🔄 MULTI-HOP: Swapping {dai_amount:.6f} DAI → WETH → USDC")
            print(f"   Route: DAI -[500]→ WETH -[500]→ USDC (forced multi-hop)")

            if not self._ensure_token_approval_for_router(self.dai_address, amount_in_wei):
                print("❌ DAI approval for Router failed — cannot swap")
                return False

            tokens = [
                self.w3.to_checksum_address(self.dai_address),
                self.w3.to_checksum_address(self.weth_address),
                usdc_address
            ]
            fees = [500, 500]

            path_bytes = self._encode_path(tokens, fees)
            self._audit_path(path_bytes, ["DAI", "WETH", "USDC"], fees)

            usdc_decimals = 6
            expected_usdc_out = dai_amount * (10 ** usdc_decimals)
            min_output = max(1, int(expected_usdc_out * 0.95))

            chain_id = self.w3.eth.chain_id
            base_gas_price = self.w3.eth.gas_price
            swap_gas_price = int(base_gas_price * 2.5) if chain_id == 42161 else int(base_gas_price * 1.5)

            swap_params = {
                'path': path_bytes,
                'recipient': self.w3.to_checksum_address(self.address),
                'deadline': int(time.time()) + 600,
                'amountIn': amount_in_wei,
                'amountOutMinimum': min_output
            }

            swap_tx = self.router_contract.functions.exactInput(
                swap_params
            ).build_transaction({
                'from': self.address,
                'chainId': chain_id,
                'gas': 600000,
                'gasPrice': swap_gas_price,
                'nonce': 0,
                'value': 0
            })

            print(f"⛽ Gas price: {self.w3.from_wei(swap_gas_price, 'gwei'):.4f} gwei (2.5x buffer)")

            try:
                estimated_gas = self.w3.eth.estimate_gas(swap_tx)
                swap_tx['gas'] = min(int(estimated_gas * 1.8), 800000)
                print(f"💰 Gas estimate: {estimated_gas} → using {swap_tx['gas']}")
            except Exception as gas_err:
                err_str = str(gas_err)
                if 'STF' in err_str or 'execution reverted' in err_str.lower():
                    print(f"❌ Multi-hop route unavailable: {err_str}")
                    return False
                print(f"⚠️ Gas estimation failed: {gas_err}, using fallback 600000")

            tx_hash = self._sign_and_send(swap_tx)
            tx_hash_hex = tx_hash.hex()
            print(f"✅ DAI→WETH→USDC swap sent: {tx_hash_hex}")

            receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
            if receipt.status == 1:
                print(f"✅ DAI→WETH→USDC swap confirmed on-chain!")
                return {
                    'success': True,
                    'tx_hash': tx_hash_hex,
                    'amount_in': dai_amount,
                    'token_in': 'DAI',
                    'token_out': 'USDC'
                }
            else:
                print(f"❌ DAI→WETH→USDC swap reverted on-chain")
                return False

        except Exception as e:
            print(f"❌ DAI→WETH→USDC swap failed: {e}")
            import traceback
            traceback.print_exc()
            return False

    def swap_usdc_for_dai(self, usdc_amount):
        """Swap USDC for DAI via FORCED multi-hop: USDC → WETH → DAI.
        Direct USDC→DAI pools have no liquidity on Arbitrum (bridged DAI vs native USDC).
        Both legs use fee tier 500 (0.05%) where deep liquidity exists.
        USDC has 6 decimals; DAI has 18 decimals.
        Slippage: 5% for multi-hop safety (two hops + small amounts).
        """
        try:
            usdc_address = self.w3.to_checksum_address("0xaf88d065e77c8cC2239327C5EDb3A432268e5831")

            if usdc_amount <= 0:
                logger.error("[swap_usdc_for_dai] Invalid USDC amount")
                return False

            amount_in_wei = int(usdc_amount * 10**6)

            logger.info(f"[swap_usdc_for_dai] MULTI-HOP: {usdc_amount:.6f} USDC → WETH → DAI")

            if not self._ensure_token_approval_for_router(usdc_address, amount_in_wei):
                logger.error("[swap_usdc_for_dai] USDC approval for Router failed")
                return False

            tokens = [
                usdc_address,
                self.w3.to_checksum_address(self.weth_address),
                self.w3.to_checksum_address(self.dai_address),
            ]
            fees = [500, 500]

            path_bytes = self._encode_path(tokens, fees)
            self._audit_path(path_bytes, ["USDC", "WETH", "DAI"], fees)

            if usdc_amount < 10.0:
                min_output = 1
                logger.info(f"[swap_usdc_for_dai] Small swap (${usdc_amount:.2f}) — amountOutMinimum=1")
            else:
                expected_dai_out = usdc_amount * 10**18
                min_output = max(1, int(expected_dai_out * 0.95))

            chain_id = self.w3.eth.chain_id
            base_gas_price = self.w3.eth.gas_price
            swap_gas_price = int(base_gas_price * 2.5) if chain_id == 42161 else int(base_gas_price * 1.5)

            swap_params = {
                'path': path_bytes,
                'recipient': self.w3.to_checksum_address(self.address),
                'deadline': int(time.time()) + 600,
                'amountIn': amount_in_wei,
                'amountOutMinimum': min_output,
            }

            swap_tx = self.router_contract.functions.exactInput(
                swap_params
            ).build_transaction({
                'from': self.address,
                'chainId': chain_id,
                'gas': 600000,
                'gasPrice': swap_gas_price,
                'nonce': 0,
                'value': 0,
            })

            try:
                estimated_gas = self.w3.eth.estimate_gas(swap_tx)
                swap_tx['gas'] = min(int(estimated_gas * 1.8), 800000)
                logger.info(f"[swap_usdc_for_dai] Gas estimate: {estimated_gas} → using {swap_tx['gas']}")
            except Exception as gas_err:
                err_str = str(gas_err)
                if 'STF' in err_str or 'execution reverted' in err_str.lower():
                    logger.error(f"[swap_usdc_for_dai] Multi-hop route unavailable: {err_str}")
                    return False
                logger.warning(f"[swap_usdc_for_dai] Gas estimation failed: {gas_err}, using fallback 800000")
                swap_tx['gas'] = 800000

            tx_hash = self._sign_and_send(swap_tx)
            tx_hash_hex = tx_hash.hex()
            logger.info(f"[swap_usdc_for_dai] USDC→WETH→DAI swap sent: {tx_hash_hex}")

            receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
            if receipt.status == 1:
                logger.info("[swap_usdc_for_dai] USDC→WETH→DAI swap confirmed on-chain")
                return {
                    'success': True,
                    'tx_hash': tx_hash_hex,
                    'amount_in': usdc_amount,
                    'token_in': 'USDC',
                    'token_out': 'DAI',
                }
            else:
                logger.error(f"[swap_usdc_for_dai] USDC→WETH→DAI swap reverted on-chain")
                return False

        except Exception as e:
            logger.error(f"[swap_usdc_for_dai] Swap failed: {e}", exc_info=True)
            return False

    def swap_dai_for_weth(self, dai_amount):
        """Swap DAI for WETH on Uniswap V3 — prefers 500 fee tier (most liquid on Arbitrum)"""
        try:
            print(f"🔄 Swapping {dai_amount:.6f} DAI for WETH...")

            if dai_amount <= 0:
                print("❌ Invalid DAI amount for swap")
                return False

            swap_result = self._execute_swap(
                self.dai_address,
                self.weth_address, 
                dai_amount,
                "DAI",
                "WETH"
            )

            if swap_result and isinstance(swap_result, str):
                return {
                    'success': True,
                    'tx_hash': swap_result,
                    'amount_in': dai_amount,
                    'token_in': 'DAI',
                    'token_out': 'WETH'
                }
            else:
                return False

        except Exception as e:
            print(f"❌ DAI to WETH swap failed: {e}")
            return False

    def swap_weth_for_wbtc(self, weth_amount):
        """Swap WETH for WBTC on Uniswap V3 — direct swap (most liquid pair on Arbitrum)"""
        try:
            print(f"🔄 Swapping {weth_amount:.8f} WETH for WBTC...")

            if weth_amount <= 0:
                print("❌ Invalid WETH amount for swap")
                return False

            swap_result = self._execute_swap(
                self.weth_address,
                self.wbtc_address,
                weth_amount,
                "WETH",
                "WBTC"
            )

            if swap_result and isinstance(swap_result, str):
                return {
                    'success': True,
                    'tx_hash': swap_result,
                    'amount_in': weth_amount,
                    'token_in': 'WETH',
                    'token_out': 'WBTC'
                }
            else:
                return False

        except Exception as e:
            print(f"❌ WETH to WBTC swap failed: {e}")
            return False

    def swap_weth_for_dai(self, weth_amount):
        """Swap WETH for DAI on Uniswap V3 — prefers 500 fee tier"""
        try:
            print(f"🔄 Swapping {weth_amount:.8f} WETH for DAI...")

            if weth_amount <= 0:
                print("❌ Invalid WETH amount for swap")
                return False

            swap_result = self._execute_swap(
                self.weth_address,
                self.dai_address,
                weth_amount,
                "WETH",
                "DAI"
            )

            if swap_result and isinstance(swap_result, str):
                return {
                    'success': True,
                    'tx_hash': swap_result,
                    'amount_in': weth_amount,
                    'token_in': 'WETH',
                    'token_out': 'DAI'
                }
            else:
                return False

        except Exception as e:
            print(f"❌ WETH to DAI swap failed: {e}")
            return False

    def swap_weth_for_usdt(self, weth_amount):
        """Swap WETH for USDT on Uniswap V3 — direct pool (WETH/USDT is liquid on Arbitrum)"""
        try:
            print(f"🔄 Swapping {weth_amount:.8f} WETH for USDT...")

            if weth_amount <= 0:
                print("❌ Invalid WETH amount for swap")
                return False

            if not self.usdt_address:
                print("❌ USDT address not configured")
                return False

            swap_result = self._execute_swap(
                self.weth_address,
                self.usdt_address,
                weth_amount,
                "WETH",
                "USDT"
            )

            if swap_result and isinstance(swap_result, str):
                return {
                    'success': True,
                    'tx_hash': swap_result,
                    'amount_in': weth_amount,
                    'token_in': 'WETH',
                    'token_out': 'USDT'
                }
            else:
                return False

        except Exception as e:
            print(f"❌ WETH to USDT swap failed: {e}")
            return False

    def swap_usdt_for_weth(self, usdt_amount):
        """Swap USDT for WETH on Uniswap V3 — direct pool (WETH/USDT is liquid on Arbitrum)
        IMPORTANT: USDT has 6 decimals — amount_in must use 10**6 not 10**18"""
        try:
            print(f"🔄 Swapping {usdt_amount:.6f} USDT for WETH...")

            if usdt_amount <= 0:
                print("❌ Invalid USDT amount for swap")
                return False

            if not self.usdt_address:
                print("❌ USDT address not configured")
                return False

            amount_in_wei = int(usdt_amount * 10**6)

            if not self._ensure_token_approval_for_router(self.usdt_address, amount_in_wei):
                print("❌ Cannot proceed without USDT approval for Router")
                return False

            base_gas_price = self.w3.eth.gas_price
            chain_id = self.w3.eth.chain_id
            swap_gas_price = int(base_gas_price * 2.5) if chain_id == 42161 else int(base_gas_price * 1.5)
            gas_limit = 300000

            fee_tiers = [500, 3000]
            for fee in fee_tiers:
                try:
                    swap_params = (
                        self.usdt_address,
                        self.weth_address,
                        fee,
                        self.w3.to_checksum_address(self.address),
                        int(time.time()) + 600,
                        amount_in_wei,
                        1,
                        0
                    )

                    swap_tx = self.router_contract.functions.exactInputSingle(
                        swap_params
                    ).build_transaction({
                        'from': self.address,
                        'chainId': chain_id,
                        'gas': gas_limit,
                        'gasPrice': swap_gas_price,
                        'nonce': 0,
                        'value': 0
                    })

                    try:
                        estimated_gas = self.w3.eth.estimate_gas(swap_tx)
                        swap_tx['gas'] = min(int(estimated_gas * 1.5), 500000)
                    except Exception as gas_err:
                        err_str = str(gas_err)
                        if 'STF' in err_str or 'execution reverted' in err_str:
                            print(f"⚠️ Fee tier {fee} reverted, trying next...")
                            continue
                        print(f"⚠️ Gas estimation failed for fee {fee}: {gas_err}")

                    tx_hash = self._sign_and_send(swap_tx)
                    print(f"✅ USDT→WETH swap sent (fee {fee}): {tx_hash.hex()}")

                    receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
                    if receipt.status == 1:
                        print(f"✅ USDT→WETH swap confirmed!")
                        return {
                            'success': True,
                            'tx_hash': tx_hash.hex(),
                            'amount_in': usdt_amount,
                            'token_in': 'USDT',
                            'token_out': 'WETH'
                        }
                    else:
                        print(f"❌ USDT→WETH swap reverted on-chain (fee {fee})")
                        continue

                except Exception as tier_err:
                    print(f"⚠️ Fee tier {fee} failed: {tier_err}")
                    continue

            print("❌ USDT→WETH swap failed on all fee tiers")
            return False

        except Exception as e:
            print(f"❌ USDT to WETH swap failed: {e}")
            import traceback
            traceback.print_exc()
            return False

    def swap_usdt_for_usdc(self, usdt_amount):
        """Swap USDT for USDC via direct single-hop (both 6 decimals, good Arbitrum liquidity).
        Falls back to multi-hop USDT→WETH→USDC if direct pool fails."""
        try:
            usdc_address = self.w3.to_checksum_address("0xaf88d065e77c8cC2239327C5EDb3A432268e5831")

            if usdt_amount <= 0 or not self.usdt_address:
                print("❌ Invalid USDT amount or USDT not configured")
                return False

            print(f"🔄 Swapping {usdt_amount:.6f} USDT → USDC (direct)...")

            swap_result = self._execute_swap(
                self.usdt_address,
                usdc_address,
                usdt_amount,
                "USDT",
                "USDC"
            )

            if swap_result and isinstance(swap_result, str):
                return {
                    'success': True,
                    'tx_hash': swap_result,
                    'amount_in': usdt_amount,
                    'token_in': 'USDT',
                    'token_out': 'USDC'
                }

            print("⚠️ Direct USDT→USDC failed, trying multi-hop USDT→WETH→USDC...")
            amount_in_wei = int(usdt_amount * 10**6)
            fees_attempt = [500, 500]
            path_bytes = self._encode_path(
                [self.usdt_address, self.weth_address, usdc_address],
                fees_attempt
            )
            self._audit_path(path_bytes, ["USDT", "WETH", "USDC"], fees_attempt)

            swap_result = self._execute_multihop_swap(
                path_bytes, usdt_amount, amount_in_wei,
                self.usdt_address, f"{usdt_amount:.4f} USDT → WETH → USDC"
            )

            if swap_result and isinstance(swap_result, str):
                return {
                    'success': True,
                    'tx_hash': swap_result,
                    'amount_in': usdt_amount,
                    'token_in': 'USDT',
                    'token_out': 'USDC'
                }
            else:
                print("❌ USDT→USDC swap failed on all attempts")
                return False

        except Exception as e:
            print(f"❌ USDT→USDC swap error: {e}")
            import traceback
            traceback.print_exc()
            return False

    def swap_dai_for_usdt_multihop(self, dai_amount):
        """Swap DAI for USDT via multi-hop: DAI → WETH → USDT
        Direct DAI/USDT pool has thin liquidity — multi-hop is safer"""
        try:
            print(f"🔄 Swapping {dai_amount:.6f} DAI → WETH → USDT (multi-hop)...")

            if dai_amount <= 0 or not self.usdt_address:
                print("❌ Invalid DAI amount or USDT not configured")
                return False

            amount_in_wei = int(dai_amount * 10**18)

            fees_attempt1 = [500, 500]
            path_bytes = self._encode_path(
                [self.dai_address, self.weth_address, self.usdt_address],
                fees_attempt1
            )
            self._audit_path(path_bytes, ["DAI", "WETH", "USDT"], fees_attempt1)

            swap_result = self._execute_multihop_swap(
                path_bytes, dai_amount, amount_in_wei,
                self.dai_address, f"{dai_amount:.4f} DAI → WETH → USDT"
            )

            if not swap_result:
                print("⚠️ Multi-hop 500/500 failed, trying 3000/500 fee tiers...")
                fees_attempt2 = [3000, 500]
                path_bytes = self._encode_path(
                    [self.dai_address, self.weth_address, self.usdt_address],
                    fees_attempt2
                )
                self._audit_path(path_bytes, ["DAI", "WETH", "USDT"], fees_attempt2)
                swap_result = self._execute_multihop_swap(
                    path_bytes, dai_amount, amount_in_wei,
                    self.dai_address, f"{dai_amount:.4f} DAI →(3000)→ WETH →(500)→ USDT"
                )

            if swap_result and isinstance(swap_result, str):
                return {
                    'success': True,
                    'tx_hash': swap_result,
                    'amount_in': dai_amount,
                    'token_in': 'DAI',
                    'token_out': 'USDT'
                }
            else:
                print("❌ DAI→USDT multi-hop swap failed on all fee tier attempts")
                return False

        except Exception as e:
            print(f"❌ DAI→USDT multi-hop swap error: {e}")
            import traceback
            traceback.print_exc()
            return False

    def swap_dai_for_arb(self, dai_amount):
        """Swap DAI for ARB on Uniswap V3 - Extended for ARB token swaps with profit tracking"""
        try:
            print(f"🔄 Swapping {dai_amount:.6f} DAI for ARB...")

            # DAI compliance check
            if dai_amount <= 0:
                print("❌ Invalid DAI amount for swap")
                return False

            # Get ARB price before swap for tracking
            arb_price = 0.41  # Default, should be fetched from price oracle
            try:
                # Try to get real ARB price if market analyzer is available
                if hasattr(self, '_get_arb_price'):
                    arb_price = self._get_arb_price()
            except:
                pass

            # ARB token address for Arbitrum Mainnet
            arb_address = "0x912CE59144191C1204E64559FE8253a0e49E6548"

            swap_result = self._execute_swap(
                self.dai_address,
                arb_address, 
                dai_amount,
                "DAI",
                "ARB"
            )

            if swap_result and isinstance(swap_result, str):
                # Calculate ARB received (estimate)
                arb_received = dai_amount / arb_price

                # Start profit tracking
                try:
                    from debt_swap_profit_tracker import track_dai_to_arb_swap
                    cycle_id = track_dai_to_arb_swap(dai_amount, arb_received, arb_price)
                    print(f"📊 Profit tracking started: {cycle_id}")
                except Exception as track_error:
                    print(f"⚠️ Profit tracking failed: {track_error}")
                    cycle_id = None

                return {
                    'success': True,
                    'tx_hash': swap_result,
                    'amount_in': dai_amount,
                    'token_in': 'DAI',
                    'token_out': 'ARB',
                    'arb_received': arb_received,
                    'arb_price': arb_price,
                    'cycle_id': cycle_id
                }
            else:
                return False

        except Exception as e:
            print(f"❌ DAI to ARB swap failed: {e}")
            return False

    def swap_arb_for_dai(self, arb_amount, cycle_id=None):
        """Swap ARB for DAI on Uniswap V3 - Reverse swap functionality with profit tracking"""
        try:
            print(f"🔄 Swapping {arb_amount:.6f} ARB for DAI...")

            # ARB compliance check
            if arb_amount <= 0:
                print("❌ Invalid ARB amount for swap")
                return False

            # Get ARB price for tracking
            arb_price = 0.41  # Default, should be fetched from price oracle
            try:
                if hasattr(self, '_get_arb_price'):
                    arb_price = self._get_arb_price()
            except:
                pass

            # ARB token address for Arbitrum Mainnet
            arb_address = "0x912CE59144191C1204E64559FE8253a0e49E6548"

            swap_result = self._execute_swap(
                arb_address,
                self.dai_address, 
                arb_amount,
                "ARB",
                "DAI"
            )

            if swap_result and isinstance(swap_result, str):
                # Calculate DAI received (estimate)
                dai_received = arb_amount * arb_price

                # Complete profit tracking if cycle_id provided
                if cycle_id:
                    try:
                        from debt_swap_profit_tracker import track_arb_to_dai_swap
                        track_arb_to_dai_swap(cycle_id, dai_received, arb_price)
                        print(f"📊 Profit tracking completed for cycle: {cycle_id}")
                    except Exception as track_error:
                        print(f"⚠️ Profit tracking completion failed: {track_error}")

                return {
                    'success': True,
                    'tx_hash': swap_result,
                    'amount_in': arb_amount,
                    'token_in': 'ARB',
                    'token_out': 'DAI',
                    'dai_received': dai_received,
                    'arb_price': arb_price
                }
            else:
                return False

        except Exception as e:
            print(f"❌ ARB to DAI swap failed: {e}")
            return False

    def _execute_swap(self, token_in, token_out, amount, token_in_name, token_out_name):
        """Executes the token swap on Uniswap V3 and returns transaction hash"""
        try:
            # Validate input
            if amount <= 0:
                print(f"❌ Invalid amount for {token_in_name} to {token_out_name} swap")
                return False

            print(f"🔄 Executing swap: {amount:.6f} {token_in_name} -> {token_out_name}")
            swap_tx = self.swap_tokens(token_in, token_out, amount)

            if not swap_tx:
                print(f"❌ Swap {token_in_name} to {token_out_name} transaction failed")
                return False

            # Handle different return types from swap_tokens
            if isinstance(swap_tx, str):
                tx_hash_str = swap_tx
            else:
                try:
                    tx_hash = self.w3.to_bytes(hexstr=swap_tx)
                    tx_hash_str = tx_hash.hex()
                except:
                    tx_hash_str = str(swap_tx)

            # Wait for confirmation
            try:
                receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash_str, timeout=120)
                if receipt.status == 1:
                    print(f"✅ {token_in_name} to {token_out_name} swap successful!")
                    print(f"🔗 Transaction Hash: {tx_hash_str}")
                    return tx_hash_str
                else:
                    print(f"❌ Swap transaction failed in execution")
                    return False
            except Exception as receipt_error:
                print(f"⚠️ Could not verify transaction receipt: {receipt_error}")
                print(f"🔗 Transaction Hash: {tx_hash_str}")
                return tx_hash_str  # Return hash even if receipt check fails

        except Exception as e:
            print(f"❌ Error in _execute_swap: {e}")
            import traceback
            traceback.print_exc()
            return False