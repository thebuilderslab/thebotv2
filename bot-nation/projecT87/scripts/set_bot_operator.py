#!/usr/bin/env python3
"""
ONE-TIME SETUP — run from deployer wallet only.
Sets the bot wallet as botOperator on REAADelegationManager.
Required before any user borrow/repay/withdraw can execute.

Usage:
  DEPLOYER_PRIVATE_KEY=<key> python scripts/set_bot_operator.py

OR if running in Replit with env vars set:
  python scripts/set_bot_operator.py
"""

import os
import sys
from web3 import Web3
from eth_account import Account

RPC_URL = os.environ.get("ALCHEMY_RPC_URL") or os.environ.get("RPC_URL")
if not RPC_URL:
    print("ERROR: No RPC_URL or ALCHEMY_RPC_URL set")
    sys.exit(1)

w3 = Web3(Web3.HTTPProvider(RPC_URL))
if not w3.is_connected():
    print("ERROR: Cannot connect to RPC")
    sys.exit(1)

CONTRACT_ADDRESS = "0x7427370Ab4C311B090446544078c819b3946E59d"

BOT_PRIVATE_KEY = os.environ.get("BOT_PRIVATE_KEY") or os.environ.get("PRIVATE_KEY")
DEPLOYER_PRIVATE_KEY = os.environ.get("DEPLOYER_PRIVATE_KEY")

if not BOT_PRIVATE_KEY:
    print("ERROR: BOT_PRIVATE_KEY not set")
    sys.exit(1)

bot_wallet = Account.from_key(BOT_PRIVATE_KEY).address

ABI = [
    {"inputs": [], "name": "botOperator", "outputs": [{"internalType": "address", "type": "address"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "owner", "outputs": [{"internalType": "address", "type": "address"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"internalType": "address", "name": "newBot", "type": "address"}], "name": "updateBotOperator", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
]

contract = w3.eth.contract(address=CONTRACT_ADDRESS, abi=ABI)

current_operator = contract.functions.botOperator().call()
owner = contract.functions.owner().call()

print("=== PRE-FLIGHT ===")
print(f"Contract owner      : {owner}")
print(f"Current botOperator : {current_operator}")
print(f"Target bot wallet   : {bot_wallet}")
print()

if current_operator.lower() == bot_wallet.lower():
    print("botOperator is already correctly set. No action needed.")
    sys.exit(0)

if not DEPLOYER_PRIVATE_KEY:
    print("DEPLOYER_PRIVATE_KEY not set in environment.")
    print()
    print("To fix this, either:")
    print(f"  1. Run: DEPLOYER_PRIVATE_KEY=<key> python scripts/set_bot_operator.py")
    print(f"  2. Or call updateBotOperator({bot_wallet}) via Arbiscan Write Contract")
    print(f"     at https://arbiscan.io/address/{CONTRACT_ADDRESS}#writeContract")
    sys.exit(1)

deployer = Account.from_key(DEPLOYER_PRIVATE_KEY)
print(f"Deployer wallet     : {deployer.address}")
print()

assert owner.lower() == deployer.address.lower(), (
    f"ABORT: Deployer {deployer.address} is NOT the contract owner {owner}. "
    f"Only the owner can call updateBotOperator."
)

print("Building updateBotOperator transaction...")
tx = contract.functions.updateBotOperator(bot_wallet).build_transaction({
    "from": deployer.address,
    "nonce": w3.eth.get_transaction_count(deployer.address),
    "gas": 100000,
    "gasPrice": w3.eth.gas_price,
    "chainId": 42161,
})

signed = w3.eth.account.sign_transaction(tx, DEPLOYER_PRIVATE_KEY)
tx_hash = w3.eth.send_raw_transaction(signed.rawTransaction)
print(f"Transaction sent    : {tx_hash.hex()}")
print(f"Arbiscan            : https://arbiscan.io/tx/{tx_hash.hex()}")

receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
print()
print("=== RESULT ===")
print(f"Status  : {'SUCCESS' if receipt.status == 1 else 'FAILED'}")
print(f"Block   : {receipt.blockNumber}")
print(f"Gas used: {receipt.gasUsed}")

confirmed = contract.functions.botOperator().call()
print(f"New botOperator     : {confirmed}")
print(f"Correctly set       : {confirmed.lower() == bot_wallet.lower()}")
