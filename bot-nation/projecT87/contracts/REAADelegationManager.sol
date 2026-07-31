// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IAavePool {
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external;

    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        uint16 referralCode,
        address onBehalfOf
    ) external;

    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external returns (uint256);

    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external returns (uint256);
}

contract REAADelegationManager {

    struct DelegationConfig {
        bool isActive;
        address wallet;
        uint256 approvedAt;
        uint256 revokedAt;
        uint256 maxSupplyPerTx;
        uint256 dailySupplyLimit;
        uint256 dailySupplyUsed;
        uint256 lastResetTimestamp;
        bool allowSupply;
        bool allowBorrow;
        bool allowRepay;
        bool allowWithdraw;
    }

    mapping(address => DelegationConfig) public delegations;

    address public owner;
    address public botOperator;
    bool public paused;

    uint256 private _reentrancyStatus;
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    address public constant WBTC = 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f;
    address public constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;

    uint256 public constant WBTC_DECIMALS = 8;
    uint256 public constant MIN_SUPPLY_AMOUNT = 10_000;
    uint256 public constant MAX_SUPPLY_RATIO_NUM = 4;
    uint256 public constant MAX_SUPPLY_RATIO_DEN = 5;
    uint256 public constant DAY = 86400;

    event DelegationApproved(address indexed user, uint256 maxSupplyPerTx, uint256 dailyLimit);
    event DelegationRevoked(address indexed user, uint256 timestamp);
    event WBTCAutoSupplied(address indexed user, uint256 amount, uint256 timestamp);
    event StrategyExecuted(address indexed user, string action, address asset, uint256 amount);
    event DailyLimitReached(address indexed user, uint256 used, uint256 limit);
    event EmergencyPause(address indexed triggeredBy);
    event EmergencyUnpause(address indexed triggeredBy);
    event BotOperatorUpdated(address indexed oldBot, address indexed newBot);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event BorrowAndTransferExecuted(address indexed asset, uint256 amount, address indexed user);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    modifier onlyBot() {
        require(msg.sender == botOperator, "Only bot operator");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Contract is paused");
        _;
    }

    modifier onlyActiveDelegation(address user) {
        require(delegations[user].isActive, "Delegation not active");
        _;
    }

    modifier nonReentrant() {
        require(_reentrancyStatus != _ENTERED, "ReentrancyGuard: reentrant call");
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    constructor(address _botOperator) {
        require(_botOperator != address(0), "Invalid bot operator");
        owner = msg.sender;
        botOperator = _botOperator;
        paused = false;
        _reentrancyStatus = _NOT_ENTERED;

        IERC20(WBTC).approve(AAVE_POOL, type(uint256).max);
    }

    function approveWBTCDelegation(uint256 maxAmount) external whenNotPaused {
        require(maxAmount > 0, "maxAmount must be > 0");
        DelegationConfig storage config = delegations[msg.sender];
        config.isActive = true;
        config.wallet = msg.sender;
        config.approvedAt = block.timestamp;
        config.revokedAt = 0;
        config.maxSupplyPerTx = maxAmount;
        config.dailySupplyLimit = maxAmount;
        config.dailySupplyUsed = 0;
        config.lastResetTimestamp = block.timestamp;
        config.allowSupply = true;
        config.allowBorrow = false;
        config.allowRepay = false;
        config.allowWithdraw = false;

        emit DelegationApproved(msg.sender, config.maxSupplyPerTx, config.dailySupplyLimit);
    }

    function approveDelegation(
        uint256 maxSupplyPerTx,
        uint256 dailySupplyLimit,
        bool allowSupply,
        bool allowBorrow,
        bool allowRepay,
        bool allowWithdraw
    ) external whenNotPaused {
        require(maxSupplyPerTx > 0, "maxSupplyPerTx must be > 0");
        require(dailySupplyLimit >= maxSupplyPerTx, "dailyLimit must be >= perTxLimit");
        DelegationConfig storage config = delegations[msg.sender];
        config.isActive = true;
        config.wallet = msg.sender;
        config.approvedAt = block.timestamp;
        config.revokedAt = 0;
        config.maxSupplyPerTx = maxSupplyPerTx;
        config.dailySupplyLimit = dailySupplyLimit;
        config.dailySupplyUsed = 0;
        config.lastResetTimestamp = block.timestamp;
        config.allowSupply = allowSupply;
        config.allowBorrow = allowBorrow;
        config.allowRepay = allowRepay;
        config.allowWithdraw = allowWithdraw;

        emit DelegationApproved(msg.sender, maxSupplyPerTx, dailySupplyLimit);
    }

    function revokeWBTCDelegation() external {
        _revoke(msg.sender);
    }

    function revokeDelegation() external {
        _revoke(msg.sender);
    }

    function _revoke(address user) internal {
        DelegationConfig storage config = delegations[user];
        require(config.isActive || config.approvedAt > 0, "No delegation exists");
        config.isActive = false;
        config.revokedAt = block.timestamp;
        emit DelegationRevoked(user, block.timestamp);
    }

    function autoSupplyWBTC(
        address user,
        uint256 amount
    ) external onlyBot whenNotPaused onlyActiveDelegation(user) nonReentrant {
        DelegationConfig storage config = delegations[user];
        require(config.allowSupply, "Supply not permitted");
        require(amount > 0, "Amount must be > 0");
        require(amount >= MIN_SUPPLY_AMOUNT, "Below minimum supply (0.0001 WBTC)");
        require(amount <= config.maxSupplyPerTx, "Exceeds per-tx limit");

        _resetDailyIfNeeded(config);

        if (config.dailySupplyUsed + amount > config.dailySupplyLimit) {
            emit DailyLimitReached(user, config.dailySupplyUsed, config.dailySupplyLimit);
            revert("Daily supply limit reached");
        }

        uint256 userBalance = IERC20(WBTC).balanceOf(user);
        uint256 maxAllowed = (userBalance * MAX_SUPPLY_RATIO_NUM) / MAX_SUPPLY_RATIO_DEN;
        require(amount <= maxAllowed, "Exceeds 80% of user balance");

        uint256 userAllowance = IERC20(WBTC).allowance(user, address(this));
        require(amount <= userAllowance, "Insufficient WBTC allowance");

        config.dailySupplyUsed += amount;

        bool success = IERC20(WBTC).transferFrom(user, address(this), amount);
        require(success, "WBTC transferFrom failed");

        IAavePool(AAVE_POOL).supply(WBTC, amount, user, 0);

        emit WBTCAutoSupplied(user, amount, block.timestamp);
        emit StrategyExecuted(user, "supply", WBTC, amount);
    }

    function executeSupply(
        address user,
        address asset,
        uint256 amount
    ) external onlyBot whenNotPaused onlyActiveDelegation(user) nonReentrant {
        DelegationConfig storage config = delegations[user];
        require(config.allowSupply, "Supply not permitted");
        require(amount > 0, "Amount must be > 0");
        require(amount <= config.maxSupplyPerTx, "Exceeds per-tx limit");

        _resetDailyIfNeeded(config);

        if (config.dailySupplyUsed + amount > config.dailySupplyLimit) {
            emit DailyLimitReached(user, config.dailySupplyUsed, config.dailySupplyLimit);
            revert("Daily limit reached");
        }

        uint256 assetAllowance = IERC20(asset).allowance(user, address(this));
        require(amount <= assetAllowance, "Insufficient allowance");

        config.dailySupplyUsed += amount;

        bool success = IERC20(asset).transferFrom(user, address(this), amount);
        require(success, "transferFrom failed");

        IERC20(asset).approve(AAVE_POOL, amount);
        IAavePool(AAVE_POOL).supply(asset, amount, user, 0);

        emit StrategyExecuted(user, "supply", asset, amount);
    }

    function executeBorrow(
        address user,
        address asset,
        uint256 amount,
        uint256 interestRateMode
    ) external onlyBot whenNotPaused onlyActiveDelegation(user) nonReentrant {
        DelegationConfig storage config = delegations[user];
        require(config.allowBorrow, "Borrow not permitted");
        require(amount > 0, "Amount must be > 0");

        IAavePool(AAVE_POOL).borrow(asset, amount, interestRateMode, 0, user);
        IERC20(asset).transfer(user, amount);

        emit StrategyExecuted(user, "borrow", asset, amount);
    }

    /**
     * @notice Borrows an asset on behalf of a user and immediately transfers it to their wallet.
     * @dev Aave assigns debt to 'user' but sends tokens to msg.sender (this DM contract).
     *      This function atomically forwards the borrowed tokens to the user's wallet.
     * @param asset The address of the underlying asset to borrow.
     * @param amount The amount to borrow.
     * @param interestRateMode 1 for Stable, 2 for Variable.
     * @param user The address of the user who delegated borrowing power (receives debt and tokens).
     */
    function executeBorrowAndTransfer(
        address user,
        address asset,
        uint256 amount,
        uint256 interestRateMode
    ) external onlyBot whenNotPaused onlyActiveDelegation(user) nonReentrant {
        DelegationConfig storage config = delegations[user];
        require(config.allowBorrow, "Borrow not permitted");
        require(amount > 0, "Amount must be > 0");

        IAavePool(AAVE_POOL).borrow(asset, amount, interestRateMode, 0, user);

        bool success = IERC20(asset).transfer(user, amount);
        require(success, "Token transfer to user failed");

        emit BorrowAndTransferExecuted(asset, amount, user);
    }

    function executeRepay(
        address user,
        address asset,
        uint256 amount,
        uint256 interestRateMode
    ) external onlyBot whenNotPaused onlyActiveDelegation(user) nonReentrant {
        DelegationConfig storage config = delegations[user];
        require(config.allowRepay, "Repay not permitted");
        require(amount > 0, "Amount must be > 0");

        uint256 assetAllowance = IERC20(asset).allowance(user, address(this));
        require(amount <= assetAllowance, "Insufficient allowance");

        bool success = IERC20(asset).transferFrom(user, address(this), amount);
        require(success, "transferFrom failed");

        IERC20(asset).approve(AAVE_POOL, amount);
        IAavePool(AAVE_POOL).repay(asset, amount, interestRateMode, user);

        emit StrategyExecuted(user, "repay", asset, amount);
    }

    function executeWithdraw(
        address user,
        address asset,
        uint256 amount
    ) external onlyBot whenNotPaused onlyActiveDelegation(user) nonReentrant {
        DelegationConfig storage config = delegations[user];
        require(config.allowWithdraw, "Withdraw not permitted");
        require(amount > 0, "Amount must be > 0");

        IAavePool(AAVE_POOL).withdraw(asset, amount, address(this));
        IERC20(asset).transfer(user, amount);

        emit StrategyExecuted(user, "withdraw", asset, amount);
    }

    function _resetDailyIfNeeded(DelegationConfig storage config) internal {
        if (block.timestamp >= config.lastResetTimestamp + DAY) {
            config.dailySupplyUsed = 0;
            config.lastResetTimestamp = block.timestamp;
        }
    }

    function getDelegation(address user) external view returns (
        bool isActive,
        uint256 approvedAt,
        uint256 revokedAt,
        uint256 maxSupplyPerTx,
        uint256 dailySupplyLimit,
        uint256 dailySupplyUsed,
        bool allowSupply,
        bool allowBorrow,
        bool allowRepay,
        bool allowWithdraw
    ) {
        DelegationConfig storage config = delegations[user];
        return (
            config.isActive,
            config.approvedAt,
            config.revokedAt,
            config.maxSupplyPerTx,
            config.dailySupplyLimit,
            config.dailySupplyUsed,
            config.allowSupply,
            config.allowBorrow,
            config.allowRepay,
            config.allowWithdraw
        );
    }

    function getDailyUsage(address user) external view returns (uint256 used, uint256 limit, uint256 resetsAt) {
        DelegationConfig storage config = delegations[user];
        return (config.dailySupplyUsed, config.dailySupplyLimit, config.lastResetTimestamp + DAY);
    }

    function pause() external onlyOwner {
        paused = true;
        emit EmergencyPause(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit EmergencyUnpause(msg.sender);
    }

    function updateBotOperator(address newBot) external onlyOwner {
        require(newBot != address(0), "Invalid bot operator");
        emit BotOperatorUpdated(botOperator, newBot);
        botOperator = newBot;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function emergencyRevokeUser(address user) external onlyOwner {
        _revoke(user);
    }

    function emergencyWithdrawToken(address token, uint256 amount) external onlyOwner {
        bool success = IERC20(token).transfer(owner, amount);
        require(success, "Emergency transfer failed");
    }
}
