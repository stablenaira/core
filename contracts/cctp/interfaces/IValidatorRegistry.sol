// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IValidatorRegistry
/// @notice External surface of the m-of-n validator set used by the active
///         `ISignatureVerifier`. Owner-authorized mutations to the validator
///         set, the threshold, AND the contract's UUPS upgrade pass through
///         the `TimelockedUpgradeable` queue/commit gate (1-hour minimum).
interface IValidatorRegistry {
    /// @notice Kinds of pending validator changes. Encoded into `ChangeQueued`
    ///         so off-chain indexers can decode without ABI guesswork.
    enum ChangeKind {
        AddValidator,
        RemoveValidator,
        ReplaceValidator,
        SetThreshold
    }

    /* --------------- typed events (in addition to mixin's ActionQueued/Committed/Cancelled) ---------------- */

    /// @notice Emitted on each effective add (after `commit` or at init).
    event ValidatorAdded(address indexed validator);
    /// @notice Emitted on each effective remove (after `commit`).
    event ValidatorRemoved(address indexed validator);
    /// @notice Emitted on each effective threshold change (after `commit` or at init).
    event ThresholdUpdated(uint256 previous, uint256 current);

    /// @notice Emitted alongside the mixin's `ActionQueued` for validator
    ///         changes. Carries typed details so a backend can render the
    ///         pending UI without a follow-up view call.
    event ChangeQueued(
        uint256 indexed actionId,
        ChangeKind kind,
        uint64 eta,
        address target,
        address replacement,
        uint256 newThreshold
    );
    /// @notice Emitted on successful `commitValidatorChange`. Mixin's
    ///         `ActionCommitted` is also emitted with the action hash.
    event ChangeCommitted(uint256 indexed actionId);
    /// @notice Emitted when the owner cancels a queued change. Mixin's
    ///         `ActionCancelled` is also emitted.
    event ChangeCancelled(uint256 indexed actionId);

    /* ------------------------------ errors ----------------------------- */

    /// @notice The post-state would have an invalid threshold.
    error InvalidThreshold(uint256 threshold, uint256 validatorCount);
    error ValidatorAlreadyExists(address validator);
    error ValidatorNotFound(address validator);
    error ZeroAddressValidator();

    /* ------------------------------ views ------------------------------ */

    function isValidator(
        address account
    ) external view returns (bool);
    function validators() external view returns (address[] memory);
    function validatorCount() external view returns (uint256);
    function threshold() external view returns (uint256);
}
