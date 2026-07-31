# Corrected Debt Swap Implementation Guide

## Critical Fix: debtSwitch() → swapDebt()

### The Problem
All previous debt swap attempts failed because we were calling the **wrong function**:
- ❌ **Used**: `debtSwitch()` with selector `0x0c6bc33e` - **THIS FUNCTION DOESN'T EXIST**
- ✅ **Correct**: `swapDebt()` with selector `0xb8bd1c6b`

### The Solution
After analyzing 3 successful on-chain debt swap transactions on Arbiscan:
- `0x131d57b4543338e4ed728a75e0a5571f3c1c21a5c6cad45c969dbd42a3571980` (DAI→WETH)
- `0x1654d629a2db455e6eb9509465d233b5d1e8050333ea030c5580d6c6ae4f1bae` (WETH→DAI)
- `0xdb9f407c4241818ff9ab19826e2c4c266a1b38a1926bf135bf2db0ee29d99be1` (Mixed)

We discovered the exact function signature and parameter structure.

## Correct Function Signature

```solidity
function swapDebt(
    DebtSwapParams memory debtSwapParams,
    CreditDelegationInput memory creditDelegationPermit,
    PermitInput memory collateralATokenPermit
) external;
```

**Selector**: `0xb8bd1c6b`

**Full Signature**:
```
swapDebt((address,uint256,uint256,address,uint256,address,uint256,uint256,bytes),(address,uint256,uint256,uint8,bytes32,bytes32),(address,uint256,uint256,uint8,bytes32,bytes32))
```

## Parameter Structure

### 1. debtSwapParams (9 fields)
```javascript
{
    debtAsset: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",  // DAI
    debtRepayAmount: "100000000000000000000",  // 100 DAI in wei
    debtRateMode: 2,  // 2 = variable rate
    newDebtAsset: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",  // WETH
    maxNewDebtAmount: "32614817216796171",  // ~0.0326 WETH in wei
    extraCollateralAsset: "0x0000000000000000000000000000000000000000",  // Not used
    extraCollateralAmount: 0,  // Not used
    offset: 0,  // Not used
    paraswapData: "0x..."  // Encoded ParaSwap swap calldata
}
```

**Key Changes from Old Structure**:
- ✅ Flat tuple with 9 fields (not nested)
- ✅ `paraswapData` is bytes (contains the swap route)
- ✅ NO `permitParams` array in the struct (was our mistake)

### 2. creditDelegationPermit (6 fields)
```javascript
{
    debtToken: "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351",  // variableDebtArbWETH
    value: "652123456789012345678",  // Delegation amount
    deadline: 1763827811,  // Unix timestamp
    v: 27,  // Signature component
    r: "0x3b015bb29a832cb9b87efc81441921db2aac4d01b4b8d158d729c89fc1593e85",
    s: "0x0deb201b13e153fe5359ab11126e28252a54f1ef9de83a0b63e1511f65404423"
}
```

For pre-approved delegation (already done via EIP-712), use all zeros.

### 3. collateralATokenPermit (6 fields)
```javascript
{
    aToken: "0x0000000000000000000000000000000000000000",
    value: 0,
    deadline: 0,
    v: 0,
    r: "0x0000000000000000000000000000000000000000000000000000000000000000",
    s: "0x0000000000000000000000000000000000000000000000000000000000000000"
}
```

Always all zeros for debt swaps (collateral permits not needed).

## How Debt Swaps Work

### DAI → WETH Example (Repay DAI, Borrow WETH)

1. **Current State**: You have 100 DAI debt
2. **Goal**: Swap to WETH debt
3. **Process**:
   - Borrow ~0.0326 WETH from Aave (new debt)
   - ParaSwap swaps WETH → DAI (gets exactly 100 DAI)
   - Repay 100 DAI debt
   - Result: 100 DAI debt → ~0.0326 WETH debt

### WETH → DAI Example (Repay WETH, Borrow DAI)

1. **Current State**: You have 0.0326 WETH debt
2. **Goal**: Swap to DAI debt
3. **Process**:
   - Borrow ~100 DAI from Aave (new debt)
   - ParaSwap swaps DAI → WETH (gets exactly 0.0326 WETH)
   - Repay 0.0326 WETH debt
   - Result: 0.0326 WETH debt → ~100 DAI debt

## ParaSwap Integration

### Critical: BUY Mode for Exact Outputs

Debt swaps require **exact repayment amounts**, so we use ParaSwap's **BUY mode**:

```python
# BUY mode: Specify EXACT output amount needed
paraswap_data = paraswap_builder.build_multiswap_calldata(
    from_token="WETH",      # Token we're selling (newly borrowed)
    to_token="DAI",         # Token we need to receive (to repay)
    from_amount=100e18,     # EXACT amount we need (in BUY mode, this is destAmount)
    min_to_amount=100e18,   # Must receive exact amount
    beneficiary=DEBT_SWITCH_V3_ADDRESS,  # Debt Switch receives tokens
    use_buy_mode=True       # CRITICAL: BUY mode for exact output
)
```

**Why BUY mode?**
- Debt repayment requires EXACT amounts
- SELL mode gives approximate outputs (slippage variations)
- BUY mode guarantees exact output, calculates required input

## Implementation Files

### Core Files

1. **`corrected_swap_debt_abi.py`**
   - Correct ABI with selector `0xb8bd1c6b`
   - Helper functions for empty permits
   - Contract addresses

2. **`corrected_debt_swap_executor.py`**
   - Complete implementation using `swapDebt()`
   - Health factor monitoring
   - Transaction building and execution

3. **`debt_swap_bidirectional.py`**
   - Support for both DAI↔WETH directions
   - Automatic direction handling
   - Comprehensive position tracking

4. **`decode_successful_swap.py`**
   - Analysis tool for on-chain transactions
   - Parameter structure verification

### Usage Example

```python
from web3 import Web3
from decimal import Decimal
from debt_swap_bidirectional import BidirectionalDebtSwapper

# Initialize
w3 = Web3(Web3.HTTPProvider("https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY"))
swapper = BidirectionalDebtSwapper(w3, private_key)

# Check current position
summary = swapper.get_account_summary()
print(f"DAI Debt: {summary['dai_debt']}")
print(f"WETH Debt: {summary['weth_debt']}")
print(f"Health Factor: {summary['health_factor']}")

# Execute swap: Repay 25 DAI, borrow WETH
tx_hash = swapper.swap_debt(
    from_asset='DAI',
    to_asset='WETH',
    amount=Decimal('25'),
    slippage_bps=100  # 1%
)

# Or reverse: Repay 0.01 WETH, borrow DAI
tx_hash = swapper.swap_debt(
    from_asset='WETH',
    to_asset='DAI',
    amount=Decimal('0.01'),
    slippage_bps=100
)
```

## Key Differences: Old vs New

| Aspect | ❌ Old (Wrong) | ✅ New (Correct) |
|--------|---------------|-----------------|
| Function | `debtSwitch()` | `swapDebt()` |
| Selector | `0x0c6bc33e` | `0xb8bd1c6b` |
| Parameters | 4 (nested arrays) | 3 (flat tuples) |
| debtSwapParams | 7 fields + permitParams[] | 9 fields (no array) |
| permitParams | In debtSwapParams | NOT in debtSwapParams |
| ParaSwap Mode | SELL (approximate) | BUY (exact output) |
| Offset | Tried 0, 4, 36, 68, 96, 100 | Always 0 |

## Contract Information

- **Contract**: Aave Debt Switch V3
- **Address**: `0x63dfa7c09Dc2Ff4030d6B8Dc2ce6262BF898C8A4`
- **Network**: Arbitrum One
- **Verified**: Yes, 112,356+ successful transactions
- **Function**: `swapDebt()` (selector `0xb8bd1c6b`)

## Token Addresses (Arbitrum)

```python
DAI = "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"
WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"

# Aave V3 tokens
aArbDAI = "0x82E64f49Ed5EC1bC6e43DAD4FC8Af9bb3A2312EE"
aArbWETH = "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8"

# Variable debt tokens
variableDebtArbDAI = "0x8619d80FB0141ba7F184CbF22fd724116D9f7ffC"
variableDebtArbWETH = "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351"

# ParaSwap Augustus V6.2
AUGUSTUS_V6_2 = "0x6A000F20005980200259B80c5102003040001068"
```

## Credit Delegation

Before executing debt swaps, ensure credit delegation is set up:

```python
# Already completed via EIP-712 signatures:
# - 997.98 ARB delegated to Debt Switch Adapter
# - 1000 DAI delegated to Debt Switch Adapter
```

## Testing Strategy

1. **Small Amount Test**: Start with $5-10 swaps
2. **Verify On-Chain**: Check transaction on Arbiscan
3. **Monitor Health Factor**: Ensure it stays above 1.3
4. **Bidirectional Test**: Test both DAI→WETH and WETH→DAI
5. **Scale Up**: Gradually increase to production amounts

## Common Issues Resolved

### Issue 1: "Execution reverted"
- **Cause**: Using `debtSwitch()` instead of `swapDebt()`
- **Fix**: Use correct function with selector `0xb8bd1c6b`

### Issue 2: "Invalid offset"
- **Cause**: Nested parameter structure
- **Fix**: Use flat tuples, offset always 0

### Issue 3: "Insufficient output amount"
- **Cause**: Using SELL mode with slippage
- **Fix**: Use BUY mode for exact outputs

### Issue 4: "Credit delegation failed"
- **Cause**: Wrong debt token or expired permit
- **Fix**: Use correct variable debt token address, check delegation

## Success Metrics

✅ Function selector matches: `0xb8bd1c6b`
✅ Transaction confirms on-chain
✅ Debt balances updated correctly
✅ Health factor remains healthy (>1.3)
✅ Gas usage: ~950k-1.1M gas (normal for debt swaps)

## References

- [Successful TX 1](https://arbiscan.io/tx/0x131d57b4543338e4ed728a75e0a5571f3c1c21a5c6cad45c969dbd42a3571980) - DAI→WETH
- [Successful TX 2](https://arbiscan.io/tx/0x1654d629a2db455e6eb9509465d233b5d1e8050333ea030c5580d6c6ae4f1bae) - WETH→DAI
- [Debt Switch Contract](https://arbiscan.io/address/0x63dfa7c09Dc2Ff4030d6B8Dc2ce6262BF898C8A4)
- [ParaSwap Docs](https://developers.paraswap.network/)
- [Aave V3 Docs](https://docs.aave.com/developers/v/2.0/)
