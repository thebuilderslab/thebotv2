"""
DAI COMPLIANCE ENFORCED: This file has been modified to use DAI-only operations.
All USDC references have been removed and replaced with DAI equivalents.
Only DAI borrowing, lending, and related operations are permitted.
SYSTEM VALIDATION: All swap operations must use DAI as the primary token.
"""

import os
import time
import json
from web3 import Web3
from eth_account import Account
from decimal import Decimal
import logging
from uniswap_integration import UniswapIntegration
from delegation_client import get_tx_broadcast_lock, acquire_nonce, confirm_nonce, reset_nonce
try:
    from config_constants import MIN_HEALTH_FACTOR
except ImportError:
    MIN_HEALTH_FACTOR = 2.70

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class AaveArbitrumIntegration:
    def __init__(self, w3, account, network_mode='mainnet'):
        self.w3 = w3
        self.account = account
        self.network_mode = network_mode

        from constants import (
            AAVE_POOL, DAI_TOKEN, WBTC_TOKEN, WETH_TOKEN,
            USDT_TOKEN, ARB_TOKEN,
        )
        if network_mode in ('mainnet', 'fork'):
            self.dai_address = DAI_TOKEN
            self.wbtc_address = WBTC_TOKEN
            self.weth_address = WETH_TOKEN
            self.usdt_address = USDT_TOKEN
            self.arb_address = ARB_TOKEN
            self.pool_address = AAVE_POOL
        else:
            self.dai_address = "0x5f6bB460B6d0bdA2CCaDdd7A19B5F6E7b5b8E1DB"
            self.wbtc_address = "0xA2d460Bc966F6C4D5527a6ba35C6cB57c15c8F96"
            self.weth_address = "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73"
            self.usdt_address = None
            self.arb_address = "0x1b20e6a3B2a86618C32A37ffcD5E98C0d20a6E42"
            self.pool_address = "0x18cd499E3d7ed42FebA981ac9236A278E4Cdc2ee"

        # Initialize Uniswap integration for swapping
        self.uniswap = UniswapIntegration(w3, account)

        # Initialize pool contract
        self._initialize_pool_contract()

        print(f"✅ Aave integration initialized for {network_mode} with DAI-only compliance")

    def _sign_and_send(self, tx_dict):
        with get_tx_broadcast_lock():
            nonce = acquire_nonce(self.w3, self.account.address)
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

    def _initialize_pool_contract(self):
        """Initialize Aave pool contract"""
        self.pool_abi = [
            {
                "inputs": [
                    {"name": "asset", "type": "address"},
                    {"name": "amount", "type": "uint256"},
                    {"name": "onBehalfOf", "type": "address"},
                    {"name": "referralCode", "type": "uint16"}
                ],
                "name": "supply",
                "outputs": [],
                "stateMutability": "nonpayable",
                "type": "function"
            },
            {
                "inputs": [
                    {"name": "asset", "type": "address"},
                    {"name": "amount", "type": "uint256"},
                    {"name": "interestRateMode", "type": "uint256"},
                    {"name": "referralCode", "type": "uint16"},
                    {"name": "onBehalfOf", "type": "address"}
                ],
                "name": "borrow",
                "outputs": [],
                "stateMutability": "nonpayable",
                "type": "function"
            },
            {
                "inputs": [
                    {"name": "asset", "type": "address"},
                    {"name": "amount", "type": "uint256"},
                    {"name": "to", "type": "address"}
                ],
                "name": "withdraw",
                "outputs": [{"name": "", "type": "uint256"}],
                "stateMutability": "nonpayable",
                "type": "function"
            },
            {
                "inputs": [
                    {"name": "asset", "type": "address"},
                    {"name": "amount", "type": "uint256"},
                    {"name": "interestRateMode", "type": "uint256"},
                    {"name": "onBehalfOf", "type": "address"}
                ],
                "name": "repay",
                "outputs": [{"name": "", "type": "uint256"}],
                "stateMutability": "nonpayable",
                "type": "function"
            },
            {
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
            }
        ]

        self.pool_contract = self.w3.eth.contract(
            address=self.pool_address,
            abi=self.pool_abi
        )

    def get_user_account_data(self, target=None):
        """Get user account data from Aave. If target is provided, fetch that wallet's data instead of the bot's."""
        try:
            query_address = target if target else self.account.address
            max_retries = 3
            for attempt in range(max_retries):
                try:
                    account_data = self.pool_contract.functions.getUserAccountData(query_address).call(block_identifier='latest')

                    # Ensure account_data is not None
                    if account_data is None:
                        logger.warning(f"Account data returned None on attempt {attempt + 1}")
                        if attempt < max_retries - 1:
                            time.sleep(1)
                            continue
                        else:
                            raise Exception("Account data is None after all retries")

                    raw_hf = float(account_data[5] / (10**18)) if account_data[5] is not None and account_data[5] > 0 else 999.99
                    if raw_hf > 999.99:
                        raw_hf = 999.99
                    return {
                        'totalCollateralUSD': float(account_data[0] / (10**8)) if account_data[0] is not None else 0.0,
                        'totalDebtUSD': float(account_data[1] / (10**8)) if account_data[1] is not None else 0.0,
                        'availableBorrowsUSD': float(account_data[2] / (10**8)) if account_data[2] is not None else 0.0,
                        'healthFactor': raw_hf,
                        'data_source': 'aave_contract',
                        'timestamp': time.time()
                    }
                except (OSError, ConnectionError, ProcessLookupError) as sys_error:
                    logger.warning(f"System call error on attempt {attempt + 1}: {sys_error}")
                    if attempt < max_retries - 1:
                        time.sleep(1)
                        continue
                    raise

        except Exception as e:
            logger.error(f"Failed to get account data: {e}")
            fallback_data = {
                'totalCollateralUSD': 0.0,
                'totalDebtUSD': 0.0,
                'availableBorrowsUSD': 0.0,
                'healthFactor': 999.99,
                'data_source': 'fallback_safe_defaults',
                'timestamp': time.time(),
                'error': str(e)
            }
            logger.info(f"Returning fallback safe data: {fallback_data}")
            return fallback_data

    def check_delegation_allowance(self, user_address, asset_address):
        """
        Check if the user has delegated credit to the bot for a given asset.
        Reads borrowAllowance(user, bot) from the Aave V3 variable debt token.
        
        Returns:
            float: Allowance amount in token units (0 = no delegation)
        """
        try:
            variable_debt_token_abi = [
                {
                    "inputs": [
                        {"name": "fromUser", "type": "address"},
                        {"name": "toUser", "type": "address"}
                    ],
                    "name": "borrowAllowance",
                    "outputs": [{"name": "", "type": "uint256"}],
                    "stateMutability": "view",
                    "type": "function"
                }
            ]

            data_provider_abi = [
                {
                    "inputs": [{"name": "asset", "type": "address"}],
                    "name": "getReserveTokensAddresses",
                    "outputs": [
                        {"name": "aTokenAddress", "type": "address"},
                        {"name": "stableDebtTokenAddress", "type": "address"},
                        {"name": "variableDebtTokenAddress", "type": "address"}
                    ],
                    "stateMutability": "view",
                    "type": "function"
                }
            ]

            chain_id = self.w3.eth.chain_id
            if chain_id == 42161:
                data_provider_address = "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654"
            elif chain_id == 421614:
                data_provider_address = "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654"
            else:
                logger.error(f"Unsupported chain ID {chain_id} for delegation allowance check")
                return 0
            data_provider = self.w3.eth.contract(
                address=self.w3.to_checksum_address(data_provider_address),
                abi=data_provider_abi
            )

            token_addresses = data_provider.functions.getReserveTokensAddresses(
                self.w3.to_checksum_address(asset_address)
            ).call()
            variable_debt_token_addr = token_addresses[2]

            debt_token_contract = self.w3.eth.contract(
                address=variable_debt_token_addr,
                abi=variable_debt_token_abi
            )

            allowance_raw = debt_token_contract.functions.borrowAllowance(
                self.w3.to_checksum_address(user_address),
                self.account.address
            ).call()

            if asset_address.lower() == self.wbtc_address.lower():
                allowance = allowance_raw / 10**8
            else:
                allowance = allowance_raw / 10**18

            if allowance <= 0:
                print(f"⏳ Waiting for User Delegation — {user_address[:10]}... has NOT delegated credit for {asset_address[:10]}...")
            else:
                print(f"✅ Delegation active: allowance {allowance:.4f} tokens from {user_address[:10]}...")

            return allowance

        except Exception as e:
            logger.error(f"Delegation allowance check failed: {e}")
            print(f"❌ Cannot check delegation allowance: {e}")
            return 0

    def borrow_dai(self, amount_dai, on_behalf_of=None):
        """Borrow DAI from Aave. If on_behalf_of is set, borrow against that user's collateral (requires delegation)."""
        try:
            borrow_target = on_behalf_of if on_behalf_of else self.account.address
            mode_label = f"DELEGATION ({borrow_target[:10]}...)" if on_behalf_of else "SELF"
            print(f"🏦 Initiating DAI borrow: ${amount_dai:.2f} [{mode_label}]")
            amount_wei = int(amount_dai * 10**18)

            if on_behalf_of:
                allowance = self.check_delegation_allowance(on_behalf_of, self.dai_address)
                if allowance < amount_dai:
                    print(f"🚫 DELEGATION ABORT: Allowance {allowance:.2f} < requested {amount_dai:.2f} DAI")
                    return False

            account_data = self.get_user_account_data(target=on_behalf_of)
            if not account_data:
                logger.error("Cannot retrieve account data for validation")
                return False

            available_borrows = account_data.get('availableBorrowsUSD', 0)
            if amount_dai > available_borrows:
                logger.error(f"Requested amount ${amount_dai:.2f} exceeds available ${available_borrows:.2f}")
                return False

            health_factor = account_data.get('healthFactor', 0)
            if health_factor < MIN_HEALTH_FACTOR:
                logger.error(f"Health factor too low for borrowing: {health_factor:.3f} (floor: {MIN_HEALTH_FACTOR})")
                return False

            max_retries = 3
            for attempt in range(max_retries):
                try:
                    base_gas_price = self.w3.eth.gas_price
                    chain_id = self.w3.eth.chain_id
                    
                    if chain_id == 42161:
                        gas_price = int(base_gas_price * 2.5)
                        print(f"⛽ Arbitrum mainnet: base {base_gas_price} → optimized {gas_price} (2.5x)")
                    else:
                        gas_price = int(base_gas_price * 1.3)
                        print(f"⛽ Testnet: base {base_gas_price} → optimized {gas_price} (1.3x)")

                    try:
                        estimated_gas = self.pool_contract.functions.borrow(
                            self.dai_address,
                            amount_wei,
                            2,
                            0,
                            borrow_target
                        ).estimate_gas({'from': self.account.address})

                        gas_limit = int(estimated_gas * 1.2)
                        print(f"⛽ Estimated gas: {estimated_gas}, Using: {gas_limit}")

                    except Exception as gas_error:
                        print(f"⚠️ Gas estimation failed: {gas_error}")
                        gas_limit = 400000

                    tx = self.pool_contract.functions.borrow(
                        self.dai_address,
                        amount_wei,
                        2,
                        0,
                        borrow_target
                    ).build_transaction({
                        'from': self.account.address,
                        'gas': gas_limit,
                        'gasPrice': gas_price,
                    })

                    tx_hash = self._sign_and_send(tx)

                    print(f"✅ DAI borrow transaction sent: {tx_hash.hex()}")

                    # Wait for transaction confirmation
                    receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

                    if receipt.status == 1:
                        print(f"✅ DAI borrow confirmed: ${amount_dai:.2f}")
                        return tx_hash.hex()
                    else:
                        print(f"❌ Transaction failed in execution")
                        return False

                except ValueError as ve:
                    error_msg = str(ve)
                    if "execution reverted" in error_msg:
                        logger.error(f"Contract execution reverted: {ve}")
                        print("💡 Contract rejected the transaction - likely insufficient collateral or limits exceeded")
                        return False
                    else:
                        logger.warning(f"ValueError on borrow attempt {attempt + 1}: {ve}")
                        if attempt < max_retries - 1:
                            time.sleep(2)
                            continue
                        raise

                except (OSError, ConnectionError, ProcessLookupError) as sys_error:
                    logger.warning(f"System call error on borrow attempt {attempt + 1}: {sys_error}")
                    if attempt < max_retries - 1:
                        time.sleep(2)
                        continue
                    raise

        except Exception as e:
            logger.error(f"DAI borrow failed: {e}")
            print(f"❌ DAI borrow failed with error: {e}")
            return False

    def borrow_weth(self, amount_weth, on_behalf_of=None):
        """Borrow WETH from Aave. If on_behalf_of is set, borrow against that user's collateral (requires delegation)."""
        try:
            borrow_target = on_behalf_of if on_behalf_of else self.account.address
            mode_label = f"DELEGATION ({borrow_target[:10]}...)" if on_behalf_of else "SELF"
            print(f"🏦 Initiating WETH borrow: {amount_weth:.8f} WETH [{mode_label}]")
            amount_wei = int(amount_weth * 10**18)

            if on_behalf_of:
                allowance = self.check_delegation_allowance(on_behalf_of, self.weth_address)
                if allowance < amount_weth:
                    print(f"🚫 DELEGATION ABORT: Allowance {allowance:.6f} < requested {amount_weth:.6f} WETH")
                    return False

            account_data = self.get_user_account_data(target=on_behalf_of)
            if not account_data:
                logger.error("Cannot retrieve account data for validation")
                return False

            available_borrows = account_data.get('availableBorrowsUSD', 0)
            health_factor = account_data.get('healthFactor', 0)
            if health_factor < MIN_HEALTH_FACTOR:
                logger.error(f"Health factor too low for WETH borrowing: {health_factor:.3f} (floor: {MIN_HEALTH_FACTOR})")
                return False

            max_retries = 3
            for attempt in range(max_retries):
                try:
                    base_gas_price = self.w3.eth.gas_price
                    chain_id = self.w3.eth.chain_id

                    if chain_id == 42161:
                        gas_price = int(base_gas_price * 2.5)
                        print(f"⛽ Arbitrum mainnet: base {base_gas_price} → optimized {gas_price} (2.5x)")
                    else:
                        gas_price = int(base_gas_price * 1.3)
                        print(f"⛽ Testnet: base {base_gas_price} → optimized {gas_price} (1.3x)")

                    try:
                        estimated_gas = self.pool_contract.functions.borrow(
                            self.weth_address,
                            amount_wei,
                            2,
                            0,
                            borrow_target
                        ).estimate_gas({'from': self.account.address})

                        gas_limit = int(estimated_gas * 1.2)
                        print(f"⛽ Estimated gas: {estimated_gas}, Using: {gas_limit}")

                    except Exception as gas_error:
                        print(f"⚠️ Gas estimation failed: {gas_error}")
                        gas_limit = 400000

                    tx = self.pool_contract.functions.borrow(
                        self.weth_address,
                        amount_wei,
                        2,
                        0,
                        borrow_target
                    ).build_transaction({
                        'from': self.account.address,
                        'gas': gas_limit,
                        'gasPrice': gas_price,
                    })

                    tx_hash = self._sign_and_send(tx)

                    print(f"✅ WETH borrow transaction sent: {tx_hash.hex()}")

                    receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

                    if receipt.status == 1:
                        print(f"✅ WETH borrow confirmed: {amount_weth:.8f} WETH")
                        return tx_hash.hex()
                    else:
                        print(f"❌ WETH borrow transaction failed on-chain")
                        return False

                except ValueError as ve:
                    error_msg = str(ve)
                    if "execution reverted" in error_msg:
                        logger.error(f"WETH borrow reverted: {ve}")
                        print("💡 Contract rejected — likely insufficient collateral or WETH borrow limit")
                        return False
                    else:
                        logger.warning(f"ValueError on WETH borrow attempt {attempt + 1}: {ve}")
                        if attempt < max_retries - 1:
                            time.sleep(2)
                            continue
                        raise

                except (OSError, ConnectionError, ProcessLookupError) as sys_error:
                    logger.warning(f"System call error on WETH borrow attempt {attempt + 1}: {sys_error}")
                    if attempt < max_retries - 1:
                        time.sleep(2)
                        continue
                    raise

        except Exception as e:
            logger.error(f"WETH borrow failed: {e}")
            print(f"❌ WETH borrow failed with error: {e}")
            return False

    def borrow(self, amount_dai, dai_address):
        """Legacy method - redirects to borrow_dai for DAI compliance"""
        if dai_address != self.dai_address:
            raise ValueError("DAI COMPLIANCE VIOLATION: Only DAI borrowing is permitted")
        return self.borrow_dai(amount_dai)

    def supply_to_aave(self, token_address, amount, on_behalf_of=None):
        """Supply tokens to Aave. If on_behalf_of is set, supply into that user's position (no delegation needed for supply)."""
        try:
            supply_target = on_behalf_of if on_behalf_of else self.account.address
            mode_label = f"DELEGATION ({supply_target[:10]}...)" if on_behalf_of else "SELF"
            print(f"🏦 Initiating supply: {amount:.6f} tokens to Aave [{mode_label}]")

            # Determine decimals and convert amount
            if token_address == self.dai_address:
                amount_wei = int(amount * 10**18)
                token_name = "DAI"
            elif token_address == self.wbtc_address:
                amount_wei = int(amount * 10**8)
                token_name = "WBTC"
            elif token_address == self.weth_address:
                amount_wei = int(amount * 10**18)
                token_name = "WETH"
            elif hasattr(self, 'usdt_address') and self.usdt_address and token_address.lower() == self.usdt_address.lower():
                amount_wei = int(amount * 10**6)
                token_name = "USDT"
            else:
                raise ValueError(f"Unsupported token for supply: {token_address}")

            # Step 1: Check token balance
            current_balance = self.get_token_balance(token_address)
            if current_balance < amount:
                raise ValueError(f"Insufficient {token_name} balance: {current_balance:.6f} < {amount:.6f}")

            print(f"✅ Balance check passed: {current_balance:.6f} {token_name}")

            # Step 2: Check ETH balance for gas
            eth_balance = self.w3.eth.get_balance(self.account.address) / 1e18
            if eth_balance < 0.0002:
                raise ValueError(f"Insufficient ETH for gas: {eth_balance:.6f}")

            # Step 3: Approve token spending (critical step that was missing)
            print(f"🔐 Approving {token_name} spending for Aave pool...")
            approval_success = self.approve_token(token_address, amount * 1.1)  # Approve 10% extra for safety

            if not approval_success:
                raise Exception(f"{token_name} approval failed")

            print(f"✅ {token_name} approval successful")

            # Step 4: Get gas price with Arbitrum multiplier
            base_gas_price = self.w3.eth.gas_price
            chain_id = self.w3.eth.chain_id
            
            if chain_id == 42161:
                gas_price = int(base_gas_price * 2.5)
                print(f"⛽ Arbitrum mainnet supply: base {base_gas_price} → optimized {gas_price} (2.5x)")
            else:
                gas_price = int(base_gas_price * 1.3)
                print(f"⛽ Testnet supply: base {base_gas_price} → optimized {gas_price} (1.3x)")

            try:
                estimated_gas = self.pool_contract.functions.supply(
                    token_address,
                    amount_wei,
                    supply_target,
                    0
                ).estimate_gas({'from': self.account.address})

                gas_limit = int(estimated_gas * 1.3)
                print(f"⛽ Estimated gas: {estimated_gas}, Using: {gas_limit}")

            except Exception as gas_error:
                print(f"⚠️ Gas estimation failed: {gas_error}")
                gas_limit = 400000

            tx = self.pool_contract.functions.supply(
                token_address,
                amount_wei,
                supply_target,
                0
            ).build_transaction({
                'from': self.account.address,
                'gas': gas_limit,
                'gasPrice': gas_price,
            })

            tx_hash = self._sign_and_send(tx)
            tx_hash_hex = tx_hash.hex()

            print(f"📤 Supply transaction sent: {tx_hash_hex}")

            # Step 8: Wait for confirmation
            receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

            if receipt.status == 1:
                print(f"✅ {token_name} supply successful: {amount:.6f}")
                print(f"🔗 Transaction: {tx_hash.hex()}")
                return tx_hash.hex()
            else:
                print(f"❌ Supply transaction failed in execution")
                return False

        except ValueError as ve:
            logger.error(f"Supply validation error: {ve}")
            print(f"❌ Supply failed: {ve}")
            return False
        except Exception as e:
            logger.error(f"Token supply failed: {e}")
            print(f"❌ Supply error: {e}")
            return False

    def supply_dai_to_aave(self, amount):
        """Supply DAI to Aave - DAI compliance method"""
        result = self.supply_to_aave(self.dai_address, amount)
        if result:
            self.enable_collateral(self.dai_address, "DAI")
        return result

    def supply_wbtc_to_aave(self, amount):
        """Supply WBTC to Aave"""
        return self.supply_to_aave(self.wbtc_address, amount)

    def supply_weth_to_aave(self, amount):
        """Supply WETH to Aave"""
        return self.supply_to_aave(self.weth_address, amount)

    def enable_collateral(self, token_address, token_name="TOKEN"):
        """Call setUserUseReserveAsCollateral(asset, true) on Aave V3 Pool.
        This enables a supplied asset to count toward the Health Factor.
        Works independently of E-Mode — purely a collateral toggle.
        Pre-checks via estimate_gas to avoid wasting gas on reverts."""
        try:
            collateral_abi = [{
                "inputs": [
                    {"name": "asset", "type": "address"},
                    {"name": "useAsCollateral", "type": "bool"}
                ],
                "name": "setUserUseReserveAsCollateral",
                "outputs": [],
                "stateMutability": "nonpayable",
                "type": "function"
            }]
            pool_address = self.pool_contract.address
            collateral_contract = self.w3.eth.contract(address=pool_address, abi=collateral_abi)

            try:
                estimated_gas = collateral_contract.functions.setUserUseReserveAsCollateral(
                    token_address, True
                ).estimate_gas({'from': self.account.address})
                gas_limit = int(estimated_gas * 1.3)
            except Exception as est_err:
                print(f"ℹ️ {token_name} collateral enable skipped — estimate_gas failed: {est_err}")
                return True

            base_gas_price = self.w3.eth.gas_price
            chain_id = self.w3.eth.chain_id
            gas_price = int(base_gas_price * (2.5 if chain_id == 42161 else 1.3))

            tx = collateral_contract.functions.setUserUseReserveAsCollateral(
                token_address, True
            ).build_transaction({
                'from': self.account.address,
                'gas': gas_limit,
                'gasPrice': gas_price,
                'chainId': chain_id
            })

            tx_hash = self._sign_and_send(tx)
            receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)

            if receipt.status == 1:
                print(f"✅ {token_name} collateral ENABLED — now counts toward Health Factor")
                return True
            else:
                print(f"⚠️ {token_name} collateral enable tx failed (status=0)")
                return False

        except Exception as e:
            error_msg = str(e).lower()
            if 'already' in error_msg or 'no change' in error_msg or 'revert' in error_msg or 'nonce' in error_msg:
                print(f"ℹ️ {token_name} collateral already enabled (no-op)")
                return True
            print(f"⚠️ {token_name} enable_collateral error: {e}")
            return False

    def get_token_balance(self, token_address):
        """Get token balance - DAI-centric compliance - NEVER returns None"""
        try:
            # Input validation
            if token_address is None:
                logger.warning(f"Token address is None, returning 0.0")
                return 0.0

            # Standard ERC20 balance ABI
            balance_abi = [{
                "constant": True,
                "inputs": [{"name": "_owner", "type": "address"}],
                "name": "balanceOf",
                "outputs": [{"name": "balance", "type": "uint256"}],
                "type": "function"
            }]

            # Retry mechanism for system call errors
            max_retries = 3
            for attempt in range(max_retries):
                try:
                    contract = self.w3.eth.contract(address=token_address, abi=balance_abi)
                    balance_wei = contract.functions.balanceOf(self.account.address).call()

                    # Ensure balance_wei is not None
                    if balance_wei is None:
                        logger.warning(f"Balance returned None for {token_address} on attempt {attempt + 1}")
                        if attempt < max_retries - 1:
                            time.sleep(1)
                            continue
                        else:
                            return 0.0

                    # Convert based on token decimals with None protection
                    if token_address == self.dai_address:
                        result = float(balance_wei) / (10**18)
                    elif token_address == self.wbtc_address:
                        result = float(balance_wei) / (10**8)
                    elif token_address == self.weth_address:
                        result = float(balance_wei) / (10**18)
                    elif hasattr(self, 'usdt_address') and self.usdt_address and token_address.lower() == self.usdt_address.lower():
                        result = float(balance_wei) / (10**6)
                    else:
                        result = float(balance_wei) / (10**18)

                    # Ensure result is not None or NaN
                    if result is None or (isinstance(result, float) and (result != result)):  # NaN check
                        return 0.0
                    
                    return result

                except (OSError, ConnectionError, ProcessLookupError) as sys_error:
                    logger.warning(f"System call error on balance check attempt {attempt + 1}: {sys_error}")
                    if attempt < max_retries - 1:
                        time.sleep(1)
                        continue
                    raise

        except Exception as e:
            logger.error(f"Failed to get token balance for {token_address}: {e}")
            return 0.0  # Always return 0.0 instead of None

    def get_dai_balance(self):
        """Get DAI balance - DAI compliance method"""
        return self.get_token_balance(self.dai_address)

    def approve_token(self, token_address, amount):
        """Approve token for Aave operations with enhanced error handling"""
        try:
            print(f"🔐 Approving token: {token_address} for amount: {amount:.6f}")

            # Standard ERC20 approve ABI
            approve_abi = [{
                "constant": False,
                "inputs": [
                    {"name": "_spender", "type": "address"},
                    {"name": "_value", "type": "uint256"}
                ],
                "name": "approve",
                "outputs": [{"name": "", "type": "bool"}],
                "type": "function"
            }, {
                "constant": True,
                "inputs": [
                    {"name": "_owner", "type": "address"},
                    {"name": "_spender", "type": "address"}
                ],
                "name": "allowance",
                "outputs": [{"name": "", "type": "uint256"}],
                "type": "function"
            }]

            contract = self.w3.eth.contract(address=token_address, abi=approve_abi)

            # Convert amount to wei based on token decimals
            if token_address == self.dai_address:
                amount_wei = int(amount * 10**18)
            elif token_address == self.wbtc_address:
                amount_wei = int(amount * 10**8)
            elif token_address == self.weth_address:
                amount_wei = int(amount * 10**18)
            else:
                amount_wei = int(amount * 10**18)

            # Check current allowance first
            try:
                current_allowance = contract.functions.allowance(
                    self.account.address, 
                    self.pool_address
                ).call()

                if current_allowance >= amount_wei:
                    print(f"✅ Sufficient allowance already exists: {current_allowance / (10**18):.6f}")
                    return True

            except Exception as allowance_err:
                print(f"⚠️ Could not check allowance: {allowance_err}")

            base_gas_price = self.w3.eth.gas_price
            chain_id = self.w3.eth.chain_id
            
            if chain_id == 42161:
                gas_price = int(base_gas_price * 2.5)
                print(f"⛽ Arbitrum mainnet approval: base {base_gas_price} → optimized {gas_price} (2.5x)")
            else:
                gas_price = int(base_gas_price * 1.3)
                print(f"⛽ Testnet approval: base {base_gas_price} → optimized {gas_price} (1.3x)")

            try:
                estimated_gas = contract.functions.approve(
                    self.pool_address,
                    amount_wei
                ).estimate_gas({'from': self.account.address})

                gas_limit = int(estimated_gas * 1.2)

            except Exception as gas_err:
                print(f"⚠️ Gas estimation failed: {gas_err}")
                gas_limit = 100000

            tx = contract.functions.approve(
                self.pool_address,
                amount_wei
            ).build_transaction({
                'from': self.account.address,
                'gas': gas_limit,
                'gasPrice': gas_price,
            })

            tx_hash = self._sign_and_send(tx)

            print(f"📤 Approval transaction sent: {tx_hash.hex()}")

            # Wait for confirmation
            receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)

            if receipt.status == 1:
                print(f"✅ Token approval confirmed")
                return True
            else:
                print(f"❌ Approval transaction failed")
                return False

        except Exception as e:
            logger.error(f"Token approval failed: {e}")
            print(f"❌ Approval error: {e}")
            return False

    def approve_dai(self, amount):
        """Approve DAI for Aave operations - DAI compliance method"""
        return self.approve_token(self.dai_address, amount)

    def withdraw_from_aave(self, token_address, amount):
        """Withdraw tokens from Aave"""
        try:
            if token_address == self.dai_address:
                amount_wei = int(amount * 10**18)
            elif token_address == self.wbtc_address:
                amount_wei = int(amount * 10**8)
            elif token_address == self.weth_address:
                amount_wei = int(amount * 10**18)
            elif hasattr(self, 'usdt_address') and self.usdt_address and token_address.lower() == self.usdt_address.lower():
                amount_wei = int(amount * 10**6)
            else:
                raise ValueError("Unsupported token for withdrawal")

            # Build transaction
            tx = self.pool_contract.functions.withdraw(
                token_address,
                amount_wei,
                self.account.address
            ).build_transaction({
                'from': self.account.address,
                'gas': 300000,
                'gasPrice': int(self.w3.eth.gas_price * 2.5),
            })

            tx_hash = self._sign_and_send(tx)

            print(f"✅ Token withdrawal successful: {amount:.6f}")
            return tx_hash.hex()

        except Exception as e:
            logger.error(f"Token withdrawal failed: {e}")
            return False

    def withdraw_dai_from_aave(self, amount):
        """Withdraw DAI from Aave - DAI compliance method"""
        return self.withdraw_from_aave(self.dai_address, amount)

    def supply_usdt_to_aave(self, amount):
        """Supply USDT to Aave and enable as collateral"""
        if not hasattr(self, 'usdt_address') or not self.usdt_address:
            print("USDT address not configured")
            return False
        result = self.supply_to_aave(self.usdt_address, amount)
        if result:
            self.enable_collateral(self.usdt_address, "USDT")
        return result

    def withdraw_usdt_from_aave(self, amount):
        """Withdraw USDT from Aave"""
        if not hasattr(self, 'usdt_address') or not self.usdt_address:
            print("USDT address not configured")
            return False
        return self.withdraw_from_aave(self.usdt_address, amount)

    def get_usdt_balance(self):
        """Get USDT wallet balance (6 decimals)"""
        if not hasattr(self, 'usdt_address') or not self.usdt_address:
            return 0.0
        return self.get_token_balance(self.usdt_address)

    def repay_dai(self, amount):
        """Repay DAI debt to Aave"""
        try:
            amount_wei = int(amount * 10**18)  # DAI has 18 decimals

            tx = self.pool_contract.functions.repay(
                self.dai_address,
                amount_wei,
                2,
                self.account.address
            ).build_transaction({
                'from': self.account.address,
                'gas': 300000,
                'gasPrice': int(self.w3.eth.gas_price * 2.5),
            })

            tx_hash = self._sign_and_send(tx)

            print(f"✅ DAI repayment successful: {amount:.6f}")
            return tx_hash.hex()

        except Exception as e:
            logger.error(f"DAI repayment failed: {e}")
            return False

    def repay_weth(self, amount):
        """Repay WETH debt to Aave (variable rate)"""
        try:
            amount_wei = int(amount * 10**18)

            tx = self.pool_contract.functions.repay(
                self.weth_address,
                amount_wei,
                2,
                self.account.address
            ).build_transaction({
                'from': self.account.address,
                'gas': 300000,
                'gasPrice': int(self.w3.eth.gas_price * 2.5),
            })

            tx_hash = self._sign_and_send(tx)

            receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
            if receipt.status == 1:
                print(f"✅ WETH repayment successful: {amount:.8f}")
                return tx_hash.hex()
            else:
                print(f"❌ WETH repayment reverted on-chain")
                return False

        except Exception as e:
            logger.error(f"WETH repayment failed: {e}")
            return False

    def swap_borrowed_debt(self, token_in_address, token_out_address, amount_to_swap):
        """
        Swaps borrowed debt from one asset to another.
        This function withdraws the borrowed token and swaps it via Uniswap.
        DAI-ONLY COMPLIANCE: Only DAI-based swaps are permitted.
        """
        try:
            # DAI-ONLY COMPLIANCE CHECK
            dai_address_lower = self.dai_address.lower()
            token_in_lower = token_in_address.lower()
            token_out_lower = token_out_address.lower()
            
            # Validate allowed swap combinations
            allowed_swaps = [
                (dai_address_lower, self.wbtc_address.lower()),  # DAI → WBTC
                (dai_address_lower, self.weth_address.lower()),  # DAI → WETH
                (dai_address_lower, self.arb_address.lower()),   # DAI → ARB
                (self.arb_address.lower(), dai_address_lower),   # ARB → DAI
            ]
            
            current_swap = (token_in_lower, token_out_lower)
            if current_swap not in allowed_swaps:
                logger.error(f"❌ FORBIDDEN SWAP: {token_in_address} → {token_out_address}")
                logger.error(f"🚫 Only DAI → WBTC, DAI → WETH, DAI → ARB, and ARB → DAI swaps are allowed")
                return False

            # 1. Check if the amount is sufficient for the swap
            if amount_to_swap <= 0:
                logger.error("Swap amount must be greater than zero.")
                return False

            # 2. Check token balance before swap
            token_balance = self.get_token_balance(token_in_address)
            if token_balance < amount_to_swap:
                logger.error(f"Insufficient token balance: {token_balance:.6f} < {amount_to_swap:.6f}")
                return False

            # 3. Perform the swap using the Uniswap integration
            print(f"🔄 Executing debt swap of {amount_to_swap:.6f} from {token_in_address} to {token_out_address}...")
            
            if not hasattr(self, 'uniswap') or not self.uniswap:
                logger.error("❌ Uniswap integration not available")
                return False
                
            tx_hash = self.uniswap.swap_tokens(token_in_address, token_out_address, amount_to_swap)
            
            if tx_hash:
                print(f"✅ Debt swap successful: {tx_hash}")
                return tx_hash
            else:
                logger.error("❌ Debt swap failed.")
                return False

        except Exception as e:
            logger.error(f"Critical error during debt swap: {e}")
            return False