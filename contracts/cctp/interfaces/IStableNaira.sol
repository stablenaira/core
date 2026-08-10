// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IStableNaira
/// @notice Subset of the live `StableNaira` surface that the bridge needs.
///         Source: `stablenaira/core/contracts/StableNaira.sol`. Verified
///         against deployed bytecode on ETH Sepolia, BSC Testnet, and Base
///         Sepolia (see `docs/token-integration.md`).
///
///         The bridge interacts via:
///           - `mint(to, amount)` on the destination chain after attestation.
///             Requires `BRIDGE_ROLE` and consumes the caller's refilling
///             rate-limit allowance.
///           - `burnFrom(account, amount)` on the source chain. Requires
///             `BRIDGE_ROLE` and burn rate-limit headroom. No `approve` step —
///             `depositForBurn` is a single user transaction.
///           - `queueAddBridge(bridge, capacity, period)` then
///             `commitAddBridge(...)` is called once by governance per chain to
///             grant the local `TokenMessenger` `BRIDGE_ROLE` and set its rate
///             limit. This passes through the token's timelock.
///
///         Both `mint` and `burnFrom` revert when the token is paused or
///         when the touched account is in the freeze list — the bridge must
///         treat both as transient errors and let the caller retry.
///         `mint` additionally reverts with `BridgeRateLimitExceeded` when the
///         allowance is exhausted; that too is transient and refills with time.
interface IStableNaira {
    /* ------------------------------ ERC20 ------------------------------ */
    function totalSupply() external view returns (uint256);
    function balanceOf(
        address account
    ) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function decimals() external view returns (uint8);

    /* ------------------------- bridge mint / burn ---------------------- */
    /// @notice Mints `amount` tokens to `to`. Caller must hold `BRIDGE_ROLE`
    ///         and have at least `amount` of its rate-limit allowance left.
    function mint(address to, uint256 amount) external returns (bool);

    /// @notice Burns `amount` from `account`. Caller must hold `BRIDGE_ROLE`
    ///         and have at least `amount` of its burn rate-limit allowance left.
    ///         No ERC20 allowance is required — `depositForBurn` stays a single
    ///         user transaction with no prior `approve`. The burn rate limit is
    ///         therefore the bound on what a compromised bridge can destroy.
    function burnFrom(address account, uint256 amount) external;

    /* --------------------------- role admin ---------------------------- */
    /// @notice Queues granting `BRIDGE_ROLE` to `bridge` with a rate limit of
    ///         `capacity` tokens per `period` seconds. Caller must hold
    ///         `DEFAULT_ADMIN_ROLE`; commit after the timelock elapses.
    function queueAddBridge(
        address bridge,
        uint128 capacity,
        uint48 period
    ) external returns (uint256 actionId);

    /// @notice Commits a queued `queueAddBridge`. Args must match exactly.
    function commitAddBridge(
        uint256 actionId,
        address bridge,
        uint128 capacity,
        uint48 period
    ) external;

    /// @notice Immediately revokes `BRIDGE_ROLE` and zeroes the rate limit.
    ///         Caller must hold `PAUSER_ROLE` or `DEFAULT_ADMIN_ROLE`.
    function removeBridge(
        address bridge
    ) external;

    function bridges(
        address account
    ) external view returns (bool);

    /* --------------------------- introspection ------------------------- */
    function BRIDGE_ROLE() external view returns (bytes32);
    function paused() external view returns (bool);
    function frozen(
        address account
    ) external view returns (bool);
    function mintCap() external view returns (uint256);

    /// @notice Tokens `bridge` may mint right now, after linear refill.
    function bridgeMintAvailable(
        address bridge
    ) external view returns (uint256);

    /// @notice Tokens `bridge` may burn right now, after linear refill.
    function bridgeBurnAvailable(
        address bridge
    ) external view returns (uint256);
}
