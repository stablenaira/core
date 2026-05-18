// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import { TimelockedUpgradeable } from "./utils/TimelockedUpgradeable.sol";
import { IValidatorRegistry } from "./interfaces/IValidatorRegistry.sol";

/// @title ValidatorRegistry
/// @notice m-of-n validator set with on-chain rotation guarded by a timelock.
///         Verifiers (e.g. `MultisigVerifier`) read `threshold()` and
///         `isValidator(addr)` on every signature check.
///
///         All sensitive admin operations on this contract — validator-set
///         changes, threshold changes, AND UUPS upgrades — pass through the
///         shared `TimelockedUpgradeable` queue/commit gate. The owner can
///         queue and cancel; any caller can commit after `eta`.
///
///         Threshold invariant (enforced at `commit` and `init`):
///           1. `threshold >= 1`
///           2. `threshold <= validatorCount`
///           3. `2 * threshold > validatorCount` (strictly more than half)
///         If a queued removal would violate the invariant, queue (and commit)
///         a `setThreshold` change first.
contract ValidatorRegistry is
    TimelockedUpgradeable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    IValidatorRegistry
{
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @dev Per-kind details for a queued validator change. `actionId` from
    ///      the mixin keys into this map. The mixin separately stores the
    ///      `actionHash` and `eta`; on commit we re-derive the hash from the
    ///      typed details and let the mixin verify the match.
    struct ValidatorChange {
        ChangeKind kind;
        address target;
        address replacement;
        uint256 newThreshold;
    }

    /// @dev Domain separators for action hashes — guarantees that, for
    ///      example, an `AddValidator` queued action cannot be committed by
    ///      a `RemoveValidator` commit call (they hash different blobs).
    bytes32 private constant DOMAIN_VALIDATOR_CHANGE = keccak256("ValidatorRegistry.ValidatorChange.v1");
    bytes32 private constant DOMAIN_UPGRADE = keccak256("ValidatorRegistry.Upgrade.v1");

    EnumerableSet.AddressSet private _validators;

    /// @inheritdoc IValidatorRegistry
    uint256 public override threshold;

    /// @dev Action id → typed details. Lets us emit rich events on commit
    ///      and inspect pending changes by id.
    mapping(uint256 => ValidatorChange) private _changes;

    /// @dev Set transiently by `commitUpgrade` to authorize a single call
    ///      into `_authorizeUpgrade`. Cleared after the upgrade completes.
    address private _authorizedImpl;

    /// @dev Storage gap. 50 - 4 used = 46.
    uint256[46] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the registry.
    /// @param initialValidators  Set of validator addresses.
    /// @param initialThreshold   Quorum (must satisfy threshold invariant).
    /// @param owner_             Initial owner.
    /// @param initialTimelock    Active queue→commit delay. `0` → 1 hour default.
    /// @param initialMinTimelock Floor on `timelock`. `0` → 1 hour default.
    function initialize(
        address[] calldata initialValidators,
        uint256 initialThreshold,
        address owner_,
        uint256 initialTimelock,
        uint256 initialMinTimelock
    ) external initializer {
        __Ownable_init(owner_);
        __Timelocked_init(initialTimelock, initialMinTimelock);

        for (uint256 i = 0; i < initialValidators.length; i++) {
            _addValidator(initialValidators[i]);
        }
        _setThreshold(initialThreshold);
    }

    /* ------------------------ queue: validator changes ------------------------ */

    function queueAddValidator(
        address validator
    ) external onlyOwner returns (uint256 actionId) {
        if (validator == address(0)) revert ZeroAddressValidator();
        if (_validators.contains(validator)) revert ValidatorAlreadyExists(validator);
        return _queueValidatorChange(
            ValidatorChange(ChangeKind.AddValidator, validator, address(0), 0)
        );
    }

    function queueRemoveValidator(
        address validator
    ) external onlyOwner returns (uint256 actionId) {
        if (!_validators.contains(validator)) revert ValidatorNotFound(validator);
        return _queueValidatorChange(
            ValidatorChange(ChangeKind.RemoveValidator, validator, address(0), 0)
        );
    }

    function queueReplaceValidator(
        address oldValidator,
        address newValidator
    ) external onlyOwner returns (uint256 actionId) {
        if (newValidator == address(0)) revert ZeroAddressValidator();
        if (!_validators.contains(oldValidator)) revert ValidatorNotFound(oldValidator);
        if (_validators.contains(newValidator)) revert ValidatorAlreadyExists(newValidator);
        return _queueValidatorChange(
            ValidatorChange(ChangeKind.ReplaceValidator, oldValidator, newValidator, 0)
        );
    }

    function queueSetThreshold(
        uint256 newThreshold
    ) external onlyOwner returns (uint256 actionId) {
        // Threshold invariant is checked at commit time on the post-state.
        return _queueValidatorChange(
            ValidatorChange(ChangeKind.SetThreshold, address(0), address(0), newThreshold)
        );
    }

    /* ------------------------ commit: validator changes ----------------------- */

    /// @notice Permissionless commit of a previously-queued validator change.
    function commitValidatorChange(
        uint256 actionId
    ) external {
        ValidatorChange memory c = _changes[actionId];
        // Verify timing & hash match; mixin reverts on missing/early/mismatch.
        _consumeAction(actionId, _hashValidatorChange(c));
        delete _changes[actionId];

        if (c.kind == ChangeKind.AddValidator) {
            _addValidator(c.target);
        } else if (c.kind == ChangeKind.RemoveValidator) {
            _removeValidator(c.target);
            _validateThreshold(threshold);
        } else if (c.kind == ChangeKind.ReplaceValidator) {
            _removeValidator(c.target);
            _addValidator(c.replacement);
        } else {
            _setThreshold(c.newThreshold);
        }
        emit ChangeCommitted(actionId);
    }

    /* ------------------------ queue/commit: upgrades ------------------- */

    /// @notice Queue a UUPS upgrade. The exact `(newImpl, data)` pair is
    ///         hash-bound; callers MUST pass identical args to `commitUpgrade`.
    function queueUpgrade(
        address newImpl,
        bytes calldata data
    ) external onlyOwner returns (uint256 actionId) {
        if (newImpl == address(0)) revert ZeroImpl();
        actionId = _queueAction(_hashUpgrade(newImpl, data));
        emit UpgradeQueued(actionId, newImpl);
    }

    /// @notice Commit a previously queued upgrade. Permissionless after `eta`.
    function commitUpgrade(uint256 actionId, address newImpl, bytes calldata data) external {
        _consumeAction(actionId, _hashUpgrade(newImpl, data));
        _authorizedImpl = newImpl;
        // Calls back into `_authorizeUpgrade(newImpl)` which checks the flag.
        upgradeToAndCall(newImpl, data);
        delete _authorizedImpl;
        emit UpgradeCommitted(actionId, newImpl);
    }

    /* ----------------------------- cancel ----------------------------- */

    /// @notice Cancel any queued action (validator change or upgrade).
    ///         Permissioned to owner; clears both mixin and typed bookkeeping.
    function cancel(
        uint256 actionId
    ) external onlyOwner {
        // Safe: deleting an unset entry is a no-op.
        delete _changes[actionId];
        _cancelAction(actionId);
        emit ChangeCancelled(actionId);
    }

    /* ----------------------- timelock parameter setters ----------------------- */

    function setMinTimelock(
        uint256 newMin
    ) external onlyOwner {
        _setMinTimelock(newMin);
    }

    function setTimelock(
        uint256 newTl
    ) external onlyOwner {
        _setTimelock(newTl);
    }

    /* --------------------------------- views ---------------------------------- */

    /// @inheritdoc IValidatorRegistry
    function isValidator(
        address account
    ) external view override returns (bool) {
        return _validators.contains(account);
    }

    /// @inheritdoc IValidatorRegistry
    function validators() external view override returns (address[] memory) {
        return _validators.values();
    }

    /// @inheritdoc IValidatorRegistry
    function validatorCount() external view override returns (uint256) {
        return _validators.length();
    }

    /// @notice Inspect the typed details of a queued validator change.
    function pendingValidatorChange(
        uint256 actionId
    ) external view returns (ValidatorChange memory) {
        return _changes[actionId];
    }

    /* ------------------------------- internals -------------------------------- */

    function _queueValidatorChange(
        ValidatorChange memory c
    ) private returns (uint256 actionId) {
        bytes32 h = _hashValidatorChange(c);
        actionId = _queueAction(h);
        _changes[actionId] = c;
        emit ChangeQueued(
            actionId,
            c.kind,
            uint64(block.timestamp + timelock),
            c.target,
            c.replacement,
            c.newThreshold
        );
    }

    function _hashValidatorChange(
        ValidatorChange memory c
    ) private pure returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_VALIDATOR_CHANGE, c.kind, c.target, c.replacement, c.newThreshold)
        );
    }

    function _hashUpgrade(address newImpl, bytes calldata data) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_UPGRADE, newImpl, keccak256(data)));
    }

    function _addValidator(
        address validator
    ) private {
        if (validator == address(0)) revert ZeroAddressValidator();
        if (!_validators.add(validator)) revert ValidatorAlreadyExists(validator);
        emit ValidatorAdded(validator);
    }

    function _removeValidator(
        address validator
    ) private {
        if (!_validators.remove(validator)) revert ValidatorNotFound(validator);
        emit ValidatorRemoved(validator);
    }

    function _setThreshold(
        uint256 newThreshold
    ) private {
        _validateThreshold(newThreshold);
        emit ThresholdUpdated(threshold, newThreshold);
        threshold = newThreshold;
    }

    function _validateThreshold(
        uint256 t
    ) private view {
        uint256 n = _validators.length();
        if (t == 0 || t > n || 2 * t <= n) revert InvalidThreshold(t, n);
    }

    /* -------------------------------- upgrade --------------------------------- */

    /// @dev Only callable indirectly via `commitUpgrade`, which sets the
    ///      transient `_authorizedImpl` to the address being upgraded to.
    ///      Direct `upgradeToAndCall` calls fail because the flag is unset.
    error UpgradeNotAuthorized();
    error ZeroImpl();

    event UpgradeQueued(uint256 indexed actionId, address indexed newImpl);
    event UpgradeCommitted(uint256 indexed actionId, address indexed newImpl);

    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        if (newImplementation != _authorizedImpl) revert UpgradeNotAuthorized();
    }
}
