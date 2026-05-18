// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title TimelockedUpgradeable
/// @notice Reusable mixin: a queue → commit pattern for sensitive admin
///         operations, gated by a configurable delay with an immutable
///         `MIN_FLOOR_TIMELOCK = 1 hour` lower bound.
///
///         The floor is a hardcoded constant — even a compromised owner
///         cannot drop the timelock below 1 hour. This is the security
///         boundary. `setMinTimelock` and `setTimelock` are direct (no
///         queue/commit) per design, but bounded by the floor and by
///         `MAX_TIMELOCK = 365 days` to prevent uint64 truncation in `eta`.
///
///         Inheritors:
///           1. Call `__Timelocked_init(initialTimelock, initialMinTimelock)`
///              from their own `initialize`. Pass `0` for either arg to use
///              the 1-hour default.
///           2. Wrap `_queueAction(hash)` in their own `queueX` functions
///              keyed on a content-addressed action hash. Store any extra
///              typed details in their own mappings if needed for events.
///           3. Wrap `_consumeAction(actionId, hash)` in their own `commitX`
///              functions; the hash MUST match exactly what was queued.
///           4. Wrap `_cancelAction(actionId)` for owner-only cancel paths.
///           5. Wrap `_setMinTimelock` / `_setTimelock` with their own
///              authorization (typically `onlyOwner`).
abstract contract TimelockedUpgradeable is Initializable {
    /// @notice Hardcoded floor — `minTimelock` cannot be set below this.
    uint256 public constant MIN_FLOOR_TIMELOCK = 1 hours;

    /// @notice Hardcoded ceiling — prevents `block.timestamp + timelock`
    ///         from overflowing the `uint64 eta` field, and bounds operator
    ///         mistakes (e.g. setting a 100-year delay).
    uint256 public constant MAX_TIMELOCK = 365 days;

    struct PendingAction {
        bytes32 actionHash;
        uint64 eta;
    }

    /// @notice Active queue → commit delay for actions queued from now on.
    ///         Existing queued actions keep the `eta` they were stamped with.
    uint256 public timelock;

    /// @notice Floor on `timelock`. Constrained by `MIN_FLOOR_TIMELOCK <= minTimelock <= MAX_TIMELOCK`.
    uint256 public minTimelock;

    /// @dev Monotonic id assigned by `_queueAction`. Starts at `1`; `0` is
    ///      reserved as a "no entry" sentinel via `eta == 0`.
    uint256 private _nextActionId;

    mapping(uint256 => PendingAction) private _actions;

    /// @dev Storage gap. 50 - 4 used = 46.
    uint256[46] private __tlGap;

    /* ------------------------------ events ------------------------------ */

    event ActionQueued(uint256 indexed actionId, bytes32 indexed actionHash, uint64 eta);
    event ActionCommitted(uint256 indexed actionId, bytes32 indexed actionHash);
    event ActionCancelled(uint256 indexed actionId, bytes32 indexed actionHash);
    event TimelockUpdated(uint256 previous, uint256 current);
    event MinTimelockUpdated(uint256 previous, uint256 current);

    /* ------------------------------ errors ------------------------------ */

    /// @notice `minTimelock` cannot be below `MIN_FLOOR_TIMELOCK`.
    error TimelockBelowFloor(uint256 attempted, uint256 floor);
    /// @notice `timelock` cannot be below `minTimelock`.
    error TimelockBelowMin(uint256 attempted, uint256 min);
    /// @notice `timelock` / `minTimelock` cannot exceed `MAX_TIMELOCK`.
    error TimelockAboveMax(uint256 attempted, uint256 max);
    /// @notice Action id was never queued, was already committed, or was cancelled.
    error ActionNotFound(uint256 actionId);
    /// @notice `commit` was called before `eta`.
    error ActionNotReady(uint256 actionId, uint64 eta, uint64 nowTs);
    /// @notice Hash supplied at `commit` does not match the hash queued.
    ///         Caller passed wrong arguments to the commit-side function.
    error ActionMismatch(uint256 actionId, bytes32 expected, bytes32 actual);

    /* ------------------------------ init ------------------------------ */

    function __Timelocked_init(
        uint256 initialTimelock,
        uint256 initialMinTimelock
    ) internal onlyInitializing {
        uint256 mt = initialMinTimelock == 0 ? MIN_FLOOR_TIMELOCK : initialMinTimelock;
        uint256 tl = initialTimelock == 0 ? MIN_FLOOR_TIMELOCK : initialTimelock;
        _validateMinTimelock(mt);
        _validateTimelock(tl, mt);
        minTimelock = mt;
        timelock = tl;
        _nextActionId = 1;
        emit MinTimelockUpdated(0, mt);
        emit TimelockUpdated(0, tl);
    }

    /* ----------------- internal: queue/commit primitives ---------------- */

    /// @dev Inheritors call this from `onlyOwner`-gated `queueX` functions.
    function _queueAction(
        bytes32 actionHash
    ) internal returns (uint256 actionId) {
        actionId = _nextActionId++;
        // Safe: `timelock <= MAX_TIMELOCK` (365 days) and `block.timestamp`
        // fits in uint64 until year 2554, so the sum cannot truncate.
        uint64 eta = uint64(block.timestamp + timelock);
        _actions[actionId] = PendingAction(actionHash, eta);
        emit ActionQueued(actionId, actionHash, eta);
    }

    /// @dev Inheritors call this from their `commitX` functions. Reverts if
    ///      the action is missing, not yet executable, or its stored hash
    ///      doesn't match `expectedHash` (signalling caller-side arg drift).
    function _consumeAction(uint256 actionId, bytes32 expectedHash) internal {
        PendingAction memory a = _actions[actionId];
        if (a.eta == 0) revert ActionNotFound(actionId);
        if (block.timestamp < a.eta) {
            revert ActionNotReady(actionId, a.eta, uint64(block.timestamp));
        }
        if (a.actionHash != expectedHash) {
            revert ActionMismatch(actionId, a.actionHash, expectedHash);
        }
        delete _actions[actionId];
        emit ActionCommitted(actionId, expectedHash);
    }

    /// @dev Inheritors call this from `onlyOwner`-gated `cancelX` functions.
    function _cancelAction(
        uint256 actionId
    ) internal {
        bytes32 h = _actions[actionId].actionHash;
        if (_actions[actionId].eta == 0) revert ActionNotFound(actionId);
        delete _actions[actionId];
        emit ActionCancelled(actionId, h);
    }

    /* --------------- internal: timelock setters (unguarded) ------------- */
    /* Inheritors wrap these with `onlyOwner` / role check.                  */

    function _setMinTimelock(
        uint256 newMin
    ) internal {
        _validateMinTimelock(newMin);
        emit MinTimelockUpdated(minTimelock, newMin);
        minTimelock = newMin;
        if (timelock < newMin) {
            emit TimelockUpdated(timelock, newMin);
            timelock = newMin;
        }
    }

    function _setTimelock(
        uint256 newTl
    ) internal {
        _validateTimelock(newTl, minTimelock);
        emit TimelockUpdated(timelock, newTl);
        timelock = newTl;
    }

    /* ------------------------------ views ------------------------------ */

    function pendingAction(
        uint256 actionId
    ) external view returns (PendingAction memory) {
        return _actions[actionId];
    }

    /* ------------------------ private validators ----------------------- */

    function _validateMinTimelock(
        uint256 mt
    ) private pure {
        if (mt < MIN_FLOOR_TIMELOCK) revert TimelockBelowFloor(mt, MIN_FLOOR_TIMELOCK);
        if (mt > MAX_TIMELOCK) revert TimelockAboveMax(mt, MAX_TIMELOCK);
    }

    function _validateTimelock(uint256 tl, uint256 minTl) private pure {
        if (tl < minTl) revert TimelockBelowMin(tl, minTl);
        if (tl > MAX_TIMELOCK) revert TimelockAboveMax(tl, MAX_TIMELOCK);
    }
}
