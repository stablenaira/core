// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControlEnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IValidatorRegistry} from "./interfaces/IValidatorRegistry.sol";

/**
 * @title ValidatorRegistry
 * @notice Timelocked registry of active CCTP validators and their BLS public keys.
 *
 * Design
 * ------
 * - Validators hold a slot index in the current epoch (used as the bit
 *   position in attestation bitmaps).
 * - Mutations are queued with `queueAdd`, `queueRemove`, `queueUpdateWeight`
 *   and committed after `timelock` seconds via `commit`.
 * - A committed change advances the epoch. Attesters MUST re-sync on epoch
 *   advance; in-flight proofs signed under the previous epoch remain valid
 *   only if accepted before the epoch bumps (MessageTransmitter reads epoch
 *   snapshot at receive time).
 *
 * Storage layout is append-only; reserved `__gap` at the end to allow safe
 * UUPS upgrades.
 */
contract ValidatorRegistry is
    Initializable,
    AccessControlEnumerableUpgradeable,
    UUPSUpgradeable,
    IValidatorRegistry
{
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    uint256 public constant MIN_TIMELOCK = 1 hours;
    uint256 public constant MAX_TIMELOCK = 30 days;

    uint64 public timelock;
    uint256 public override currentEpoch;
    uint256 public override totalWeight;
    uint256 public override threshold;

    /// @dev 1-indexed lookup (0 = "not present"), keyed by keccak256(publicKey).
    mapping(bytes32 => uint256) private _indexPlusOne;

    /// @dev Dense validator slots used in the current epoch.
    Validator[] private _validators;

    enum ChangeKind { Add, Remove, UpdateWeight, UpdateThreshold, UpdateIdentity }

    struct PendingChange {
        ChangeKind kind;
        bytes publicKey;
        uint256 weight;
        uint256 newThreshold;
        address identityAddress;
        uint64 effectiveAt;
        bool committed;
        bool cancelled;
    }

    PendingChange[] private _pending;

    uint256[40] private __gap;

    error InvalidPublicKey();
    error InvalidIdentityAddress();
    error ValidatorAlreadyActive();
    error ValidatorNotActive();
    error ChangeNotReady();
    error ChangeAlreadyApplied();
    error ThresholdOutOfRange();
    error TimelockOutOfRange();
    error BitmapOutOfRange();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address governor,
        uint64 initialTimelock,
        uint256 initialThreshold
    ) public initializer {
        __AccessControlEnumerable_init();
        __UUPSUpgradeable_init();

        if (admin == address(0) || governor == address(0)) revert InvalidPublicKey();
        if (initialTimelock < MIN_TIMELOCK || initialTimelock > MAX_TIMELOCK) revert TimelockOutOfRange();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, governor);

        timelock = initialTimelock;
        threshold = initialThreshold;
        currentEpoch = 1;
    }

    // ---- View ----

    function validatorCount() external view returns (uint256) {
        return _validators.length;
    }

    function validatorAt(uint256 index) external view returns (Validator memory) {
        return _validators[index];
    }

    function isActive(bytes calldata publicKey) external view returns (bool) {
        uint256 idx = _indexPlusOne[keccak256(publicKey)];
        if (idx == 0) return false;
        return _validators[idx - 1].active;
    }

    function resolveBitmap(bytes calldata signerBitmap)
        external
        view
        returns (uint256 weight, bytes[] memory publicKeys)
    {
        uint256 n = _validators.length;
        uint256 maxBits = signerBitmap.length * 8;
        // Count set bits first so we can size the return array exactly.
        uint256 setBits;
        for (uint256 i = 0; i < n; i++) {
            if (_isBitSet(signerBitmap, i)) setBits++;
        }
        // Any bit set beyond validator count is invalid.
        for (uint256 i = n; i < maxBits; i++) {
            if (_isBitSet(signerBitmap, i)) revert BitmapOutOfRange();
        }

        publicKeys = new bytes[](setBits);
        uint256 cursor;
        for (uint256 i = 0; i < n; i++) {
            if (!_isBitSet(signerBitmap, i)) continue;
            Validator storage v = _validators[i];
            if (!v.active) revert ValidatorNotActive();
            publicKeys[cursor++] = v.publicKey;
            weight += v.weight;
        }
    }

    // ---- Governance: queue changes ----

    function queueAdd(bytes calldata publicKey, uint256 weight, address identityAddress)
        external
        onlyRole(GOVERNOR_ROLE)
        returns (uint256 changeId)
    {
        if (publicKey.length != 128) revert InvalidPublicKey();
        if (identityAddress == address(0)) revert InvalidIdentityAddress();
        if (_indexPlusOne[keccak256(publicKey)] != 0) revert ValidatorAlreadyActive();
        changeId = _queue(PendingChange({
            kind: ChangeKind.Add,
            publicKey: publicKey,
            weight: weight,
            newThreshold: 0,
            identityAddress: identityAddress,
            effectiveAt: uint64(block.timestamp) + timelock,
            committed: false,
            cancelled: false
        }));
    }

    function queueRemove(bytes calldata publicKey)
        external
        onlyRole(GOVERNOR_ROLE)
        returns (uint256 changeId)
    {
        uint256 idx = _indexPlusOne[keccak256(publicKey)];
        if (idx == 0) revert ValidatorNotActive();
        changeId = _queue(PendingChange({
            kind: ChangeKind.Remove,
            publicKey: publicKey,
            weight: 0,
            newThreshold: 0,
            identityAddress: address(0),
            effectiveAt: uint64(block.timestamp) + timelock,
            committed: false,
            cancelled: false
        }));
    }

    function queueUpdateWeight(bytes calldata publicKey, uint256 newWeight)
        external
        onlyRole(GOVERNOR_ROLE)
        returns (uint256 changeId)
    {
        uint256 idx = _indexPlusOne[keccak256(publicKey)];
        if (idx == 0) revert ValidatorNotActive();
        changeId = _queue(PendingChange({
            kind: ChangeKind.UpdateWeight,
            publicKey: publicKey,
            weight: newWeight,
            newThreshold: 0,
            identityAddress: address(0),
            effectiveAt: uint64(block.timestamp) + timelock,
            committed: false,
            cancelled: false
        }));
    }

    function queueUpdateIdentity(bytes calldata publicKey, address newIdentityAddress)
        external
        onlyRole(GOVERNOR_ROLE)
        returns (uint256 changeId)
    {
        uint256 idx = _indexPlusOne[keccak256(publicKey)];
        if (idx == 0) revert ValidatorNotActive();
        if (newIdentityAddress == address(0)) revert InvalidIdentityAddress();
        changeId = _queue(PendingChange({
            kind: ChangeKind.UpdateIdentity,
            publicKey: publicKey,
            weight: 0,
            newThreshold: 0,
            identityAddress: newIdentityAddress,
            effectiveAt: uint64(block.timestamp) + timelock,
            committed: false,
            cancelled: false
        }));
    }

    function queueSetThreshold(uint256 newThreshold)
        external
        onlyRole(GOVERNOR_ROLE)
        returns (uint256 changeId)
    {
        changeId = _queue(PendingChange({
            kind: ChangeKind.UpdateThreshold,
            publicKey: "",
            weight: 0,
            newThreshold: newThreshold,
            identityAddress: address(0),
            effectiveAt: uint64(block.timestamp) + timelock,
            committed: false,
            cancelled: false
        }));
    }

    function cancelChange(uint256 changeId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        PendingChange storage c = _pending[changeId];
        if (c.committed || c.cancelled) revert ChangeAlreadyApplied();
        c.cancelled = true;
    }

    function setTimelock(uint64 newTimelock) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTimelock < MIN_TIMELOCK || newTimelock > MAX_TIMELOCK) revert TimelockOutOfRange();
        timelock = newTimelock;
    }

    // ---- Governance: commit ----

    function commit(uint256 changeId) external {
        PendingChange storage c = _pending[changeId];
        if (c.committed || c.cancelled) revert ChangeAlreadyApplied();
        if (block.timestamp < c.effectiveAt) revert ChangeNotReady();

        if (c.kind == ChangeKind.Add) {
            _validators.push(Validator({
                publicKey: c.publicKey,
                weight: c.weight,
                active: true,
                identityAddress: c.identityAddress
            }));
            _indexPlusOne[keccak256(c.publicKey)] = _validators.length;
            totalWeight += c.weight;
            emit ValidatorCommitted(changeId, c.publicKey, c.weight, c.identityAddress);
        } else if (c.kind == ChangeKind.Remove) {
            uint256 idx = _indexPlusOne[keccak256(c.publicKey)] - 1;
            Validator storage v = _validators[idx];
            totalWeight -= v.weight;
            v.active = false;
            v.weight = 0;
            v.identityAddress = address(0);
            delete _indexPlusOne[keccak256(c.publicKey)];
            emit ValidatorRemoved(c.publicKey);
        } else if (c.kind == ChangeKind.UpdateWeight) {
            uint256 idx = _indexPlusOne[keccak256(c.publicKey)] - 1;
            Validator storage v = _validators[idx];
            totalWeight = totalWeight - v.weight + c.weight;
            v.weight = c.weight;
            emit ValidatorCommitted(changeId, c.publicKey, c.weight, v.identityAddress);
        } else if (c.kind == ChangeKind.UpdateIdentity) {
            uint256 idx = _indexPlusOne[keccak256(c.publicKey)] - 1;
            Validator storage v = _validators[idx];
            address old = v.identityAddress;
            v.identityAddress = c.identityAddress;
            emit IdentityAddressUpdated(c.publicKey, old, c.identityAddress);
        } else {
            if (c.newThreshold > totalWeight && totalWeight != 0) revert ThresholdOutOfRange();
            uint256 old = threshold;
            threshold = c.newThreshold;
            emit ThresholdUpdated(old, c.newThreshold);
        }

        c.committed = true;
        currentEpoch += 1;
        emit EpochAdvanced(currentEpoch, totalWeight);
    }

    // ---- Internal ----

    function _queue(PendingChange memory change) internal returns (uint256 id) {
        id = _pending.length;
        _pending.push(change);
        emit ValidatorQueued(id, change.publicKey, change.weight, change.effectiveAt);
    }

    function _isBitSet(bytes calldata bitmap, uint256 index) internal pure returns (bool) {
        uint256 byteIndex = index / 8;
        if (byteIndex >= bitmap.length) return false;
        uint8 b = uint8(bitmap[byteIndex]);
        uint8 mask = uint8(1) << uint8(7 - (index % 8));
        return (b & mask) != 0;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
