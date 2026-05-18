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
///           - `burnFrom(account, amount)` on the source chain after the user
///             approves the `TokenMessenger` for `amount`.
///           - `addMinter(bridge)` is called once by governance per chain to
///             grant the local `TokenMessenger` `MINTER_ROLE`.
///
///         Both `mint` and `burnFrom` revert when the token is paused or
///         when the touched account is in the freeze list — the bridge must
///         treat both as transient errors and let the caller retry.
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
    /// @notice Mints `amount` tokens to `to`. Caller must hold `MINTER_ROLE`.
    function mint(address to, uint256 amount) external returns (bool);

    /// @notice Burns `amount` from `account`. Caller must hold `MINTER_ROLE`.
    ///         The token does **not** require a prior allowance — `MINTER_ROLE`
    ///         alone authorizes the burn. (This is per the deployed source.)
    function burnFrom(address account, uint256 amount) external;

    /* --------------------------- role admin ---------------------------- */
    /// @notice Grants `MINTER_ROLE` to `account`. Caller must hold
    ///         `DEFAULT_ADMIN_ROLE`.
    function addMinter(
        address account
    ) external;

    /// @notice Revokes `MINTER_ROLE` from `account`. Caller must hold
    ///         `DEFAULT_ADMIN_ROLE`.
    function removeMinter(
        address account
    ) external;

    function minters(
        address account
    ) external view returns (bool);

    /* --------------------------- introspection ------------------------- */
    function MINTER_ROLE() external view returns (bytes32);
    function paused() external view returns (bool);
    function frozen(
        address account
    ) external view returns (bool);
    function mintCap() external view returns (uint256);
}
