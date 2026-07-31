# Autonomous Debt Swap Allocation Strategy

## Overview
This document describes the complete allocation strategy for the autonomous DeFi arbitrage system, including trigger orchestration, asset allocation, and execution flow.

---

## Allocation Configuration

### Network-Aware Allocation

#### **Mainnet (Arbitrum One)**
```
WETH: 30% - Supply to Aave as collateral
WBTC: 50% - Supply to Aave as collateral
DAI:  10% - Supply to Aave as collateral
GHO:   5% - Hold in wallet (not supplied)
ETH:   5% - Hold in wallet (not supplied)
───────────
Total: 100%
```

#### **Testnet (Arbitrum Sepolia)**
```
WETH: 30% - Supply to Aave as collateral
WBTC: 50% - Supply to Aave as collateral
DAI:  15% - Supply to Aave as collateral (includes redistributed GHO 5%)
ETH:   5% - Hold in wallet (not supplied)
───────────
Total: 100%
```

**Note**: GHO is only available on Arbitrum mainnet. On testnet, the 5% GHO allocation is redistributed to DAI.

---

## Trigger Orchestration Flow

### Complete Data Flow
```
┌──────────────────────────────────────────────────────────────┐
│                     BlockEventMonitor                         │
│  - Monitors Web3 blocks for triggers                         │
│  - Evaluates capacity and growth conditions                  │
└──────────────┬───────────────────────────────────────────────┘
               │
               v
┌──────────────────────────────────────────────────────────────┐
│              Trigger Detection & Validation                   │
│  Capacity Trigger:                                           │
│    - Supply utilization > 85% threshold                      │
│    - Health factor safe (>1.5 minimum)                       │
│                                                              │
│  Growth Trigger:                                             │
│    - Compound growth opportunities detected                  │
│    - Collateral expansion profitable                         │
└──────────────┬───────────────────────────────────────────────┘
               │
               v
┌──────────────────────────────────────────────────────────────┐
│                  Borrow Calculation                          │
│  - Calculate max safe borrow amount                          │
│  - Ensure health factor ≥ 1.5                               │
│  - Account for gas costs and slippage                        │
└──────────────┬───────────────────────────────────────────────┘
               │
               v
┌──────────────────────────────────────────────────────────────┐
│                  Borrow DAI from Aave                        │
│  - Execute borrow transaction                                │
│  - Receive DAI into wallet                                   │
└──────────────┬───────────────────────────────────────────────┘
               │
               v
┌──────────────────────────────────────────────────────────────┐
│            Execute Complete DeFi Sequence                     │
│  (see detailed flow below)                                   │
└──────────────────────────────────────────────────────────────┘
```

### Detailed Allocation Sequence

```
START: Total DAI Amount = 100%
│
├─► [30%] DAI → WETH
│   ├─ Swap via Uniswap
│   └─ Supply WETH to Aave
│
├─► [50%] DAI → WBTC
│   ├─ Swap via Uniswap
│   └─ Supply WBTC to Aave
│
├─► [5%] DAI → GHO (Mainnet only)
│   ├─ Swap via Uniswap
│   └─ Hold GHO in wallet (NOT supplied to Aave)
│
├─► [5%] DAI → WETH → ETH
│   ├─ Swap DAI → WETH via Uniswap
│   ├─ Unwrap WETH → ETH
│   └─ Hold ETH in wallet (NOT supplied to Aave)
│
└─► [10%/15%] DAI Direct Supply
    └─ Supply DAI directly to Aave (no swap needed)

═══════════════════════════════════════════════
RESULT:
✅ Collateral assets in Aave: WETH, WBTC, DAI
✅ Liquid assets in wallet: GHO (mainnet), ETH
✅ Health factor maintained ≥ 1.5
═══════════════════════════════════════════════
```

---

## Atomic Execution Guarantee

### All-or-Nothing Principle
The system enforces atomic execution with NO skip paths:

1. **Tracking**: Every step tracked with `sequence_successful` flag
2. **Error Propagation**: Any failed step sets flag to False
3. **Rollback**: If any step fails, entire sequence marked as failed
4. **No Partial Execution**: System NEVER completes with partial allocation
5. **Status Reporting**: Final status clearly indicates success or failure

### Example Execution Log
```
══════════════════════════════════════════════════
🚀 STARTING ATOMIC ALLOCATION SEQUENCE
   Total DAI: 1000.00
   Network: mainnet
   Health Factor Before: 2.15
══════════════════════════════════════════════════

Step 1/5: WETH Allocation (30%)
🔄 Swapping 300.00 DAI → WETH via Uniswap...
✅ WETH swap successful: 0xabc...123
🏦 Supplying 0.15 WETH to Aave...
✅ WETH supplied successfully

Step 2/5: WBTC Allocation (50%)
🔄 Swapping 500.00 DAI → WBTC via Uniswap...
✅ WBTC swap successful: 0xdef...456
🏦 Supplying 0.008 WBTC to Aave...
✅ WBTC supplied successfully

Step 3/5: GHO Allocation (5%)
🔄 Swapping 50.00 DAI → GHO via Uniswap...
✅ GHO swap successful: 0xghi...789
💼 Holding GHO in wallet (not supplied to Aave)

Step 4/5: ETH Allocation (5%)
🔄 Swapping 50.00 DAI → WETH → ETH...
✅ ETH unwrapped successfully
💼 Holding ETH in wallet (not supplied to Aave)

Step 5/5: DAI Direct Supply (10%)
🏦 Resupplying 100.00 DAI to Aave...
✅ DAI resupply completed

══════════════════════════════════════════════════
✅ ATOMIC ALLOCATION SEQUENCE COMPLETE
   Supplied to Aave: WETH, WBTC, DAI
   Held in wallet: GHO, ETH
   Health Factor After: 2.28
══════════════════════════════════════════════════
```

---

## Configuration Management

### How to Modify Allocation

The allocation strategy is configured in `arbitrum_testnet_agent.py` via the `ALLOCATION_CONFIG` dictionary:

```python
# Example: Mainnet Configuration
self.ALLOCATION_CONFIG = {
    'WETH': {
        'percentage': 0.30,
        'action': 'supply',
        'description': 'Swap to WETH and supply as collateral'
    },
    'WBTC': {
        'percentage': 0.50,
        'action': 'supply',
        'description': 'Swap to WBTC and supply as collateral'
    },
    'DAI': {
        'percentage': 0.10,
        'action': 'supply',
        'description': 'Resupply DAI directly (no swap)'
    },
    'GHO': {
        'percentage': 0.05,
        'action': 'hold',
        'description': 'Swap to GHO and hold in wallet'
    },
    'ETH': {
        'percentage': 0.05,
        'action': 'hold',
        'description': 'Swap to ETH and hold in wallet'
    }
}
```

### Modification Rules

1. **Percentage Sum**: All percentages MUST sum to 1.0 (100%)
   - System validates on startup
   - Will raise error if sum ≠ 1.0

2. **Action Types**:
   - `supply`: Asset supplied to Aave as collateral
   - `hold`: Asset held in wallet (not supplied)

3. **Network Awareness**:
   - Check token availability on target network
   - GHO only on mainnet
   - Testnet should exclude unavailable tokens

4. **Asset Support**:
   - Currently supports: WETH, WBTC, DAI, GHO, ETH
   - To add new assets, implement swap/supply methods

---

## Health Factor Management

### Minimum Health Factor: 1.5

The system maintains a universal minimum health factor of 1.5 across all operations:

1. **Pre-Check**: Before borrow calculation
2. **Borrow Limit**: Max borrow keeps HF ≥ 1.5
3. **Post-Execution**: Verify HF after sequence
4. **Abort Condition**: Cancel if HF would drop below 1.5

### Safety Buffer
```
Health Factor Scale:
  < 1.0  = Liquidation Risk (DANGER)
  1.0-1.5 = Unsafe Zone (AVOID)
  ≥ 1.5  = Safe Operating Zone ✓
  ≥ 2.0  = Conservative (IDEAL)
```

---

## Token Addresses

### Mainnet (Arbitrum One)
```
WBTC: 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f
WETH: 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
DAI:  0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1
GHO:  0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33 (Official Arbitrum One GHO)
ARB:  0x912CE59144191C1204E64559FE8253a0e49E6548
```

**Note**: GHO official addresses:
- Arbitrum One: 0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33 (used by this system)
- Ethereum Mainnet: 0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f (reference only)

### Testnet (Arbitrum Sepolia)
```
WBTC: 0xA2d460Bc966F6C4D5527a6ba35C6cB57c15c8F96
WETH: 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73
DAI:  0x5f6bB460B6d0bdA2CCaDdd7A19B5F6E7b5b8E1DB
GHO:  Not Available (None)
ARB:  0x1b20e6a3B2a86618C32A37ffcD5E98C0d20a6E42
```

---

## System Architecture

### Key Components

1. **BlockEventMonitor** (`block_event_monitor.py`)
   - Real-time Web3 block monitoring
   - Trigger detection and evaluation
   - Event-driven architecture

2. **ArbitrumTestnetAgent** (`arbitrum_testnet_agent.py`)
   - Core agent logic
   - Allocation configuration
   - Execution sequences
   - Helper methods

3. **Uniswap Integration** (`uniswap_integration.py`)
   - Token swaps (DAI → WETH, WBTC, GHO)
   - Slippage protection
   - Gas optimization

4. **Aave Integration** (`aave_integration.py`)
   - Supply/borrow operations
   - Health factor calculations
   - Collateral management

5. **Config Management** (`config.py`, `config_constants.py`)
   - Token addresses
   - Network configuration
   - System parameters

### Data Flow Summary
```
Trigger → Validation → Calculation → Borrow → Allocation → Verification
   ↑                                                           ↓
   └─────────────────── Continuous Monitoring ←───────────────┘
```

---

## Testing Strategy

### Pre-Production Validation

Before production deployment, the system should be tested for:

1. **Mainnet Simulation**:
   - All 5 assets (WETH, WBTC, DAI, GHO, ETH)
   - Verify GHO swap execution
   - Confirm health factor maintained

2. **Testnet Simulation**:
   - 4 assets (WETH, WBTC, DAI, ETH)
   - Verify GHO step skipped
   - Confirm DAI gets 15% allocation

3. **Edge Cases**:
   - Swap failures (should abort sequence)
   - Supply failures (should abort sequence)
   - Insufficient liquidity (should abort sequence)
   - Network issues (should retry or abort)

4. **Health Factor Scenarios**:
   - Pre-execution HF = 1.4 (should abort)
   - Pre-execution HF = 1.6 (should proceed)
   - Post-execution HF < 1.5 (should rollback)

### Monitoring Metrics

Monitor these key metrics in production:

- Trigger frequency (capacity vs growth)
- Execution success rate
- Average health factor maintained
- Gas costs per execution
- Asset distribution accuracy
- Failed transaction reasons

---

## Maintenance & Updates

### Regular Maintenance Tasks

1. **Weekly**:
   - Review execution logs
   - Monitor health factor trends
   - Check gas cost efficiency

2. **Monthly**:
   - Evaluate allocation performance
   - Consider allocation adjustments
   - Review token address changes

3. **Quarterly**:
   - System architecture review
   - Performance optimization
   - Security audit

### Emergency Procedures

If issues detected:

1. **Stop System**: Halt autonomous execution
2. **Assess Impact**: Check current positions
3. **Manual Intervention**: Rebalance if needed
4. **Root Cause**: Analyze logs and transactions
5. **Fix & Test**: Implement fix, test thoroughly
6. **Resume**: Restart with monitoring

---

## Trigger System Optimizations

### **Independent Trigger Architecture** ✅

The system uses **fully decoupled triggers** optimized for wallets of all sizes:

#### **Growth Trigger (Independent)**
Activates on collateral growth - **NO capacity requirement!**

**Trigger Conditions:**
- ✅ Health Factor ≥ 1.5 **AND**
- ✅ **EITHER:**
  - **Absolute**: $50 growth from baseline **OR**
  - **Relative**: 10% growth from baseline

**Example:** If baseline is $100, triggers at either:
- $150 total ($50 absolute growth) OR
- $110 total (10% relative growth)

**Small Wallet Benefit**: 10% threshold enables frequent operations even with small positions!

#### **Capacity Trigger (Independent)**
Activates on available borrowing capacity - **NO growth requirement!**

**Trigger Conditions:**
- ✅ Health Factor ≥ 1.5 **AND**
- ✅ Available borrows ≥ $10 (minimum) **AND**
- ✅ Available borrows ≥ $15 (activation threshold)

**Small Wallet Benefit**: $15 threshold (vs previous $50) makes it accessible!

### **Key Improvements Implemented:**

| Feature | Before | After | Benefit |
|---------|--------|-------|---------|
| Growth Dependency | Required $25+ capacity | **NO capacity required** | Small wallets can trigger |
| Growth Threshold | Only $50 absolute | **$50 OR 10% relative** | Scales with wallet size |
| Capacity Threshold | $50 required | **$15 required** | 70% more accessible |
| Trigger Independence | Coupled triggers | **Fully independent** | Both can activate |

### **Execution Guarantees:**

1. ✅ **Atomic Operations**: All supply/borrow operations complete or fail together
2. ✅ **Health Factor Safety**: Universal 1.5 minimum maintained
3. ✅ **Independent Activation**: Triggers don't block each other
4. ✅ **Small Wallet Support**: 10% relative growth + $15 capacity threshold
5. ✅ **ETH Gas Protection**: Requires 0.001 ETH minimum for operations

---

## Future Enhancements

### Potential Improvements

1. **Dynamic Allocation**:
   - Adjust percentages based on market conditions
   - Optimize for highest yields

2. **Additional Assets**:
   - Add more collateral types
   - Support new DeFi protocols

3. **Advanced Strategies**:
   - Multi-protocol arbitrage
   - Flash loan integration
   - MEV protection

4. **Risk Management**:
   - Dynamic health factor targets
   - Volatility-based adjustments
   - Circuit breakers

---

## Conclusion

This allocation strategy provides:

✅ **Configurable**: Easy to modify asset allocations
✅ **Network-Aware**: Handles mainnet/testnet differences
✅ **Atomic**: All-or-nothing execution guarantee
✅ **Safe**: Universal 1.5 health factor minimum
✅ **Monitored**: Complete trigger orchestration flow
✅ **Documented**: Comprehensive implementation details

The system is designed for autonomous operation with minimal manual intervention while maintaining safety and transparency throughout all operations.

---

**Last Updated**: October 3, 2025
**Version**: 2.0
**Status**: Optimized & Production Ready
**Key Features**: Independent triggers, 10% relative growth, $15 capacity threshold, small wallet support
