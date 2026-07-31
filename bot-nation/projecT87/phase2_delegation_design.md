# Phase 2 — Delegated DeFi Execution Design Doc

## Overview

Phase 2 extends REAA from read-only monitoring to active DeFi management. Users approve a Delegation Manager smart contract that allows the REAA bot to execute Aave V3 strategies (macro, micro, growth, capacity) on their behalf based on health factor thresholds.

---

## 1. Delegation Manager Contract (Solidity)

### Contract: `REAADelegationManager.sol`
**Network:** Arbitrum Mainnet (Chain ID: 42161)

### Storage

```solidity
struct DelegationConfig {
    bool isActive;
    address wallet;
    uint256 approvedAt;
    uint256 revokedAt;
    uint256 maxBorrowPerTx;      // max DAI/WETH borrow per single tx (wei)
    uint256 dailyBorrowLimit;     // rolling 24h limit (wei)
    uint256 dailyBorrowUsed;      // tracking field
    uint256 lastResetTimestamp;   // 24h rolling window
    bool allowSupply;
    bool allowBorrow;
    bool allowRepay;
    bool allowWithdraw;
}

mapping(address => DelegationConfig) public delegations;
address public botOperator;      // REAA bot address
address public owner;            // admin/deployer
address public aavePool;         // Aave V3 Pool on Arbitrum
```

### Methods

```solidity
// User calls this to grant delegation
function approveDelegation(
    uint256 maxBorrowPerTx,
    uint256 dailyBorrowLimit,
    bool allowSupply,
    bool allowBorrow,
    bool allowRepay,
    bool allowWithdraw
) external;

// User calls this to revoke (immediate)
function revokeDelegation() external;

// Bot calls these (only botOperator, only if delegation active)
function executeSupply(address user, address asset, uint256 amount) external onlyBot;
function executeBorrow(address user, address asset, uint256 amount, uint256 interestRateMode) external onlyBot;
function executeRepay(address user, address asset, uint256 amount, uint256 interestRateMode) external onlyBot;
function executeWithdraw(address user, address asset, uint256 amount) external onlyBot;

// Admin
function updateBotOperator(address newBot) external onlyOwner;
function pause() external onlyOwner;
function unpause() external onlyOwner;
```

### Events

```solidity
event DelegationApproved(address indexed user, uint256 maxBorrowPerTx, uint256 dailyLimit);
event DelegationRevoked(address indexed user, uint256 timestamp);
event StrategyExecuted(address indexed user, string action, address asset, uint256 amount);
event DailyLimitReached(address indexed user, uint256 used, uint256 limit);
event EmergencyPause(address indexed triggeredBy);
```

### Safety Mechanisms

1. **Per-tx limits**: `maxBorrowPerTx` prevents excessive single-transaction borrows
2. **Daily rolling limit**: `dailyBorrowLimit` caps total borrows in any 24h window
3. **Granular permissions**: Users choose which actions to allow (supply/borrow/repay/withdraw)
4. **Instant revoke**: `revokeDelegation()` is immediate, no timelock
5. **Pausable**: Owner can emergency-pause the entire contract
6. **Bot-only**: Only the registered `botOperator` can call execute functions
7. **On-chain tracking**: All actions emit events for full auditability

### Aave V3 Integration

The Delegation Manager interacts with Aave V3 via credit delegation:
- User calls `approveBorrowAllowance` on each Aave debt token (variableDebtDAI, variableDebtWETH) to allow the DelegationManager contract to borrow on their behalf
- For supply/withdraw, user approves the DelegationManager to manage their aTokens
- The DelegationManager then calls Aave Pool's `supply()`, `borrow()`, `repay()`, `withdraw()` with `onBehalfOf = user`

---

## 2. Database Schema

### Table: `managed_wallets`

```sql
CREATE TABLE managed_wallets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    wallet_address VARCHAR(42) NOT NULL,
    delegation_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        -- pending | active | revoked | paused
    delegation_tx_hash VARCHAR(66),
    approved_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    max_borrow_per_tx NUMERIC(30,18) DEFAULT 50,
    daily_borrow_limit NUMERIC(30,18) DEFAULT 200,
    allowed_strategies TEXT[] DEFAULT '{macro,micro,growth,capacity}',
    hf_target NUMERIC(10,4) DEFAULT 3.10,
    hf_floor NUMERIC(10,4) DEFAULT 2.00,
    current_strategy VARCHAR(20),
    last_strategy_run TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, wallet_address)
);

CREATE INDEX idx_managed_wallets_active ON managed_wallets(delegation_status)
    WHERE delegation_status = 'active';
```

### Table: `wallet_actions`

```sql
CREATE TABLE wallet_actions (
    id SERIAL PRIMARY KEY,
    managed_wallet_id INTEGER NOT NULL REFERENCES managed_wallets(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    action_type VARCHAR(20) NOT NULL,
        -- supply | borrow | repay | withdraw | swap
    strategy VARCHAR(20) NOT NULL,
        -- macro | micro | growth | capacity
    asset_symbol VARCHAR(10) NOT NULL,
    asset_address VARCHAR(42) NOT NULL,
    amount NUMERIC(30,18) NOT NULL,
    amount_usd NUMERIC(20,2),
    tx_hash VARCHAR(66),
    tx_status VARCHAR(20) DEFAULT 'pending',
        -- pending | confirmed | failed | reverted
    hf_before NUMERIC(10,4),
    hf_after NUMERIC(10,4),
    gas_used NUMERIC(30,0),
    gas_price_gwei NUMERIC(20,4),
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wallet_actions_user ON wallet_actions(user_id, created_at DESC);
CREATE INDEX idx_wallet_actions_managed ON wallet_actions(managed_wallet_id, created_at DESC);
```

---

## 3. Step-by-Step Implementation Plan

### Step 1: Smart Contract Development & Deployment

1. Write `REAADelegationManager.sol` with all methods/events/safety
2. Write unit tests (Hardhat/Foundry) covering:
   - Approve/revoke lifecycle
   - Per-tx and daily limits enforcement
   - Bot-only access control
   - Pause/unpause
   - Aave credit delegation integration
3. Deploy to Arbitrum testnet (Sepolia) for testing
4. Audit contract logic (internal review + external if budget allows)
5. Deploy to Arbitrum Mainnet
6. Store contract address in env var: `DELEGATION_MANAGER_ADDRESS`

### Step 2: Database Migration

1. Run `managed_wallets` and `wallet_actions` CREATE TABLE statements
2. Add db.py helpers:
   - `create_managed_wallet(user_id, wallet_address)`
   - `update_delegation_status(wallet_id, status, tx_hash)`
   - `get_active_managed_wallets()` — returns all active delegations
   - `log_wallet_action(managed_wallet_id, user_id, action_type, strategy, ...)`
   - `get_wallet_actions(user_id, limit=20)`
   - `get_managed_wallet_by_user(user_id)`

### Step 3: Bot Integration (Multi-Wallet Agent Loop)

1. Modify `run_autonomous_mainnet.py` main loop:
   ```python
   # In the main while True loop:
   active_wallets = database.get_active_managed_wallets()
   for mw in active_wallets:
       if not database.is_bot_enabled(mw['user_id']):
           continue
       run_strategies_for_user(
           user_id=mw['user_id'],
           wallet_address=mw['wallet_address'],
           agent=agent,
           run_id=run_id,
           iteration=iteration,
           config={
               'health_factor_target': float(mw['hf_target']),
               'hf_floor': float(mw['hf_floor']),
               'allowed_strategies': mw['allowed_strategies'],
               'max_borrow_per_tx': float(mw['max_borrow_per_tx']),
               'daily_borrow_limit': float(mw['daily_borrow_limit']),
           }
       )
   ```
2. Update `run_strategies_for_user` to:
   - Fetch Aave position for the user's wallet
   - Determine strategy based on health factor thresholds
   - Execute via DelegationManager contract (not direct wallet)
   - Log every action to `wallet_actions`
   - Update `managed_wallets.current_strategy` and `last_strategy_run`

### Step 4: Consumer Dashboard UX

1. **Post-Connect Delegation Flow:**
   - After wallet connect, show a "Manage DeFi Strategy" section
   - User clicks "Approve REAA" → prompts MetaMask to:
     a. Call `approveBorrowAllowance` on Aave debt tokens (DAI, WETH)
     b. Call `DelegationManager.approveDelegation()` with their chosen limits
   - Show clear permissions summary: "REAA can borrow up to $50/tx, $200/day"
   - Show revoke info: "You can revoke access anytime"

2. **Active Management View:**
   - Strategy status badge: "Macro Active" / "Growth Mode" / "Monitoring"
   - Recent actions feed: timestamp, action type, asset, amount, HF before/after
   - Daily usage bar: "$45 / $200 daily limit used"
   - Health factor chart (sparkline of HF over last 24h)

3. **Revoke Flow:**
   - "Revoke REAA Access" button → MetaMask call to `revokeDelegation()`
   - Confirmation modal: "This will stop all automated strategies. Your positions remain open."
   - Updates `managed_wallets.delegation_status = 'revoked'`

### Step 5: Safety & Monitoring

1. Per-wallet emergency stop (separate from global emergency stop)
2. Health factor floor: bot never borrows if HF would drop below `hf_floor`
3. Slippage protection: 1% max slippage on all swaps
4. Gas price guard: skip execution if gas > 0.5 gwei on Arbitrum
5. Daily summary email/notification (future)
6. Admin dashboard: view all managed wallets, their status, and action history

---

## 4. Risk Considerations

| Risk | Mitigation |
|------|-----------|
| Smart contract bug | Thorough testing + audit, pausable contract |
| Bot private key compromise | Hardware wallet for bot operator, key rotation capability |
| Flash loan attack | No flash loan entry points, all actions are bot-initiated |
| User loses funds | Per-tx limits, daily caps, HF floor, instant revoke |
| Gas spike | Gas price guard, skip cycle if gas too high |
| Aave protocol risk | Health factor monitoring, emergency stop |

---

## 5. Phase 2 Dependencies

- [ ] Solidity contract finalized and audited
- [ ] Arbitrum testnet deployment + integration tests
- [ ] MetaMask signing flow tested in consumer dashboard
- [ ] Multi-wallet agent loop stress tested (10+ wallets)
- [ ] Monitoring/alerting for managed wallets
- [ ] Legal review of managing user funds (if applicable)
