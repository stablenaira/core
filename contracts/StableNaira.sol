// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
  StableNaira — UUPS upgradeable fiat-backed NGN stablecoin (EVM)

  Deploy via StableNairaUUPSDeployer: users and integrations MUST use the ERC1967 proxy address.

  Model
  - 1:1 off-chain NGN reserves; mint / burn aligned with reserve movements.
  - AccessControlEnumerable roles; EIP-2612 permit; optional mintCap.
  - Pausable, freeze blocklist, seize (forced transfer).
  - Sensitive admin operations pass through a queue/commit timelock
    (1-hour minimum, admin-adjustable upward; queued actions expire after
    ACTION_GRACE_PERIOD). Queue and commit are both admin-gated.

  TWO KINDS OF MINTING
  These are economically different operations and are deliberately separated.

  - Treasury issuance (MINTER_ROLE) creates NEW supply against a NEW fiat
    deposit. It is timelocked: `queueMint` then `commitMint`.

  - Bridge issuance (BRIDGE_ROLE) does NOT create new supply. It restores
    tokens that were already burned on a peer chain against the same reserve,
    so total supply across all chains is unchanged. It must settle in a single
    transaction — the user's tokens are already burned and a delayed mint would
    strand them — so `mint` is synchronous for BRIDGE_ROLE only.

    A synchronous mint path is exactly the risk a timelock exists to bound, so
    bridge issuance is capped by a per-bridge refilling rate limit. A
    compromised bridge can mint at most its remaining allowance rather than an
    unbounded amount, which leaves time for `pause` / `removeBridge` to engage.
    BRIDGE_ROLE is granted only through the timelocked `queueAddBridge` /
    `commitAddBridge` path, and revoked instantly via `removeBridge`.

    Note: "is the caller a TokenMessenger?" cannot be answered safely on-chain
    — ERC-165 support and code size are both trivially spoofed by an attacker
    contract. BRIDGE_ROLE *is* the governance-managed allowlist that such a
    check would need, expressed as a role.

  BURNS
  - `burnFrom` requires BRIDGE_ROLE and does NOT require an ERC20 allowance.
    This is deliberate: `depositForBurn` stays a single user transaction with
    no prior `approve`, which is the integration contract every deployed bridge
    and front-end already relies on.

    The consequence is that BRIDGE_ROLE can burn any holder's balance, so a
    separate refilling burn rate limit — not an allowance — is what bounds a
    compromised bridge. It refills independently of the mint bucket so heavy
    inbound traffic cannot throttle outbound transfers. This makes off-chain
    monitoring load-bearing: watch `BridgeBurned` against expected volume, and
    `removeBridge` (instant, open to PAUSER_ROLE) is the kill switch.
  - `seizeFunds` intentionally bypasses the freeze list and the pause guard
    (calls `super._update` via `_forceTransfer`) so compliance seizure works on
    frozen accounts and while paused. It rejects a frozen recipient, which
    would otherwise lock the seized funds permanently.

  STORAGE
  OpenZeppelin v5 bases use ERC-7201 namespaced storage and contribute no
  sequential slots, so the entire sequential layout is TimelockedUpgradeable
  (slots 0-49) followed by this contract (slot 50 onward). Reordering the OZ
  bases among themselves is therefore harmless — they occupy nothing.

  Two things are NOT harmless, because both shift every slot from 50 up and
  silently reinterpret `mintCap` and `frozen` on a live proxy:
    - inserting another non-namespaced base into the inheritance list;
    - adding state to TimelockedUpgradeable without shrinking `__tlGap`
      (this one hits every contract sharing the mixin at once).

  `npm run layout:check` enforces all of this against the committed baseline in
  storage-layout.json and runs in CI. Re-baseline only with `layout:accept`, and
  only when no proxy holding real state has been deployed.
*/

import {AccessControlEnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {TimelockedUpgradeable} from "./cctp/utils/TimelockedUpgradeable.sol";

contract StableNaira is
    Initializable,
    ERC20PermitUpgradeable,
    PausableUpgradeable,
    AccessControlEnumerableUpgradeable,
    UUPSUpgradeable,
    TimelockedUpgradeable
{
    /// @notice Treasury issuance against new fiat reserves. Timelocked.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    /// @notice Cross-chain issuance. Synchronous but rate-limited. Contracts only.
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant FREEZER_ROLE = keccak256("FREEZER_ROLE");
    bytes32 public constant SEIZER_ROLE = keccak256("SEIZER_ROLE");

    bytes32 private constant DOMAIN_MINT = keccak256("StableNaira.Mint.v1");
    bytes32 private constant DOMAIN_UPGRADE =
        keccak256("StableNaira.Upgrade.v1");
    bytes32 private constant DOMAIN_MINT_CAP =
        keccak256("StableNaira.SetMintCap.v1");
    bytes32 private constant DOMAIN_ADD_BRIDGE =
        keccak256("StableNaira.AddBridge.v1");
    bytes32 private constant DOMAIN_SET_MIN_TIMELOCK =
        keccak256("StableNaira.SetMinTimelock.v1");
    bytes32 private constant DOMAIN_SET_TIMELOCK =
        keccak256("StableNaira.SetTimelock.v1");

    uint8 private constant DECIMALS = 2;

    string public constant VERSION = "2.0";

    /// @notice Refilling allowances bounding how fast one bridge may move value.
    /// @dev Two independent buckets — minting in, burning out — each refilling
    ///      linearly toward `capacity` over `period`. `capacity == 0` disables
    ///      the bridge entirely. Packs into two storage slots.
    ///
    ///      `uint96` capacity is ~7.9e28 base units (7.9e26 NGN at 2 decimals),
    ///      about twelve orders of magnitude above Nigeria's entire money supply.
    struct BridgeLimit {
        uint96 capacity;
        uint48 period;
        uint48 lastMintRefill;
        uint48 lastBurnRefill;
        uint128 mintRemaining;
        uint128 burnRemaining;
    }

    uint256 public mintCap;

    mapping(address => bool) public frozen;

    /// @dev Set by `commitUpgrade` to authorize exactly one upgrade, and
    ///      cleared inside `_authorizeUpgrade` — i.e. before the new
    ///      implementation's initializer runs, so clearing it can never
    ///      overwrite V2 state that happens to occupy this slot.
    address private _authorizedImpl;

    mapping(address => BridgeLimit) private _bridgeLimits;

    /// @dev Reserved for future storage variables; shrink only when appending new state.
    uint256[48] private __gap;

    error ZeroAddress();
    error AlreadyFrozen();
    error NotFrozen();
    error FrozenRecipient(address account);
    error InsufficientBalance();
    error MintCapExceeded();
    error NotAuthorizedCompliance();
    error UpgradeNotAuthorized();
    error ZeroImpl();
    error LastAdminProtected();
    error BridgeMustBeContract(address account);
    error InvalidBridgeLimit();
    error BridgeRateLimitExceeded(uint256 requested, uint256 available);

    event MintCapUpdated(uint256 previous, uint256 current);
    event RedeemRequested(
        address indexed account,
        uint256 amount,
        string offChainReference
    );
    event AccountFrozen(address indexed account);
    event AccountUnfrozen(address indexed account);
    event FundsSeized(address indexed from, address indexed to, uint256 amount);
    event MintQueued(
        uint256 indexed actionId,
        address indexed to,
        uint256 amount
    );
    event MintCommitted(
        uint256 indexed actionId,
        address indexed to,
        uint256 amount
    );
    event MintCapChangeQueued(uint256 indexed actionId, uint256 newCap);
    event UpgradeQueued(uint256 indexed actionId, address indexed newImpl);
    event UpgradeCommitted(uint256 indexed actionId, address indexed newImpl);
    event BridgeChangeQueued(
        uint256 indexed actionId,
        address indexed bridge,
        uint96 capacity,
        uint48 period
    );
    event BridgeUpdated(
        address indexed bridge,
        uint96 capacity,
        uint48 period
    );
    event BridgeRemoved(address indexed bridge);
    event BridgeMinted(
        address indexed bridge,
        address indexed to,
        uint256 amount
    );
    event BridgeBurned(
        address indexed bridge,
        address indexed from,
        uint256 amount
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory name_,
        string memory symbol_,
        address initialAdmin
    ) public initializer {
        if (initialAdmin == address(0)) revert ZeroAddress();

        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __Pausable_init();
        __AccessControlEnumerable_init();
        __UUPSUpgradeable_init();
        // Both default to MIN_FLOOR_TIMELOCK (1 hour); admin raises via setTimelock.
        __Timelocked_init(0, 0);

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(MINTER_ROLE, initialAdmin);
        _grantRole(PAUSER_ROLE, initialAdmin);
        _grantRole(FREEZER_ROLE, initialAdmin);
        _grantRole(SEIZER_ROLE, initialAdmin);
        // BRIDGE_ROLE is deliberately NOT granted here. It carries a
        // synchronous mint path and is only ever held by a bridge contract,
        // added through the timelocked `queueAddBridge` / `commitAddBridge`.
    }

    modifier onlyPauserOrAdmin() {
        address s = _msgSender();
        if (!hasRole(PAUSER_ROLE, s) && !hasRole(DEFAULT_ADMIN_ROLE, s))
            revert NotAuthorizedCompliance();
        _;
    }

    modifier onlyFreezerOrAdmin() {
        address s = _msgSender();
        if (!hasRole(FREEZER_ROLE, s) && !hasRole(DEFAULT_ADMIN_ROLE, s))
            revert NotAuthorizedCompliance();
        _;
    }

    modifier onlySeizerOrAdmin() {
        address s = _msgSender();
        if (!hasRole(SEIZER_ROLE, s) && !hasRole(DEFAULT_ADMIN_ROLE, s))
            revert NotAuthorizedCompliance();
        _;
    }

    /* ------------------------------ views ------------------------------ */

    function minters(address account) external view returns (bool) {
        return hasRole(MINTER_ROLE, account);
    }

    function bridges(address account) external view returns (bool) {
        return hasRole(BRIDGE_ROLE, account);
    }

    function pausers(address account) external view returns (bool) {
        return hasRole(PAUSER_ROLE, account);
    }

    function freezers(address account) external view returns (bool) {
        return hasRole(FREEZER_ROLE, account);
    }

    function seizers(address account) external view returns (bool) {
        return hasRole(SEIZER_ROLE, account);
    }

    /// @notice The sole admin, or `address(0)` when there is not exactly one.
    /// @dev Returns rather than reverts: this is a getter that explorers,
    ///      indexers and monitoring probe, and it must stay callable during a
    ///      multi-admin handover.
    function owner() external view returns (address) {
        if (getRoleMemberCount(DEFAULT_ADMIN_ROLE) != 1) return address(0);
        return getRoleMember(DEFAULT_ADMIN_ROLE, 0);
    }

    function bridgeLimit(
        address bridge
    ) external view returns (BridgeLimit memory) {
        return _bridgeLimits[bridge];
    }

    /// @notice Tokens `bridge` may mint right now, after linear refill.
    function bridgeMintAvailable(
        address bridge
    ) external view returns (uint256) {
        return _availableToMint(bridge);
    }

    /// @notice Tokens `bridge` may burn right now, after linear refill.
    function bridgeBurnAvailable(
        address bridge
    ) external view returns (uint256) {
        return _availableToBurn(bridge);
    }

    /* --------------------------- role admin ---------------------------- */

    function addMinter(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        grantRole(MINTER_ROLE, account);
    }

    function removeMinter(
        address account
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(MINTER_ROLE, account);
    }

    function addPauser(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        grantRole(PAUSER_ROLE, account);
    }

    function removePauser(
        address account
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(PAUSER_ROLE, account);
    }

    function addFreezer(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        grantRole(FREEZER_ROLE, account);
    }

    function removeFreezer(
        address account
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(FREEZER_ROLE, account);
    }

    function addSeizer(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        grantRole(SEIZER_ROLE, account);
    }

    function removeSeizer(
        address account
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(SEIZER_ROLE, account);
    }

    /* --------------------- bridge registration -------------------------- */

    /// @notice Queue granting (or re-limiting) a bridge's synchronous mint allowance.
    /// @param capacity Maximum tokens mintable per `period`. Zero disables.
    /// @param period   Seconds for the allowance to refill from empty to full.
    function queueAddBridge(
        address bridge,
        uint96 capacity,
        uint48 period
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 actionId) {
        if (bridge == address(0)) revert ZeroAddress();
        // A synchronous minter must be a contract with its own authorization
        // logic — never an EOA, which would bypass the timelock entirely.
        if (bridge.code.length == 0) revert BridgeMustBeContract(bridge);
        if (capacity == 0 || period == 0) revert InvalidBridgeLimit();
        actionId = _queueAction(_hashAddBridge(bridge, capacity, period));
        emit BridgeChangeQueued(actionId, bridge, capacity, period);
    }

    function commitAddBridge(
        uint256 actionId,
        address bridge,
        uint96 capacity,
        uint48 period
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _consumeAction(actionId, _hashAddBridge(bridge, capacity, period));
        if (capacity == 0 || period == 0) revert InvalidBridgeLimit();

        _bridgeLimits[bridge] = BridgeLimit({
            capacity: capacity,
            period: period,
            lastMintRefill: uint48(block.timestamp),
            lastBurnRefill: uint48(block.timestamp),
            mintRemaining: capacity,
            burnRemaining: capacity
        });
        _grantRole(BRIDGE_ROLE, bridge);
        emit BridgeUpdated(bridge, capacity, period);
    }

    /// @notice Instantly revoke a bridge's mint authority.
    /// @dev Deliberately NOT timelocked and available to PAUSER_ROLE: killing a
    ///      compromised bridge is an emergency action. Restoring it is not, and
    ///      goes back through `queueAddBridge`.
    function removeBridge(address bridge) external onlyPauserOrAdmin {
        delete _bridgeLimits[bridge];
        _revokeRole(BRIDGE_ROLE, bridge);
        emit BridgeRemoved(bridge);
    }

    /* ------------------------ bridge issuance --------------------------- */

    /// @notice Synchronous cross-chain mint. BRIDGE_ROLE only, rate-limited.
    /// @dev Signature is deliberately unchanged from v1 so `IStableNaira` and
    ///      the deployed TokenMessenger keep working without modification.
    function mint(
        address to,
        uint256 amount
    ) external onlyRole(BRIDGE_ROLE) whenNotPaused returns (bool) {
        if (to == address(0)) revert ZeroAddress();
        _consumeBridgeAllowance(_msgSender(), amount);
        _checkMintCap(amount);
        _mint(to, amount);
        emit BridgeMinted(_msgSender(), to, amount);
        return true;
    }

    /* ----------------------- treasury issuance -------------------------- */

    /// @notice Queue new issuance against an off-chain reserve deposit.
    function queueMint(
        address to,
        uint256 amount
    ) external onlyRole(MINTER_ROLE) whenNotPaused returns (uint256 actionId) {
        if (to == address(0)) revert ZeroAddress();
        actionId = _queueAction(_hashMint(to, amount));
        emit MintQueued(actionId, to, amount);
    }

    /// @notice Commit a queued mint once the timelock has elapsed.
    /// @dev The supplied args must match the queued action hash exactly.
    function commitMint(
        uint256 actionId,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _consumeAction(actionId, _hashMint(to, amount));
        if (to == address(0)) revert ZeroAddress();
        _checkMintCap(amount);
        _mint(to, amount);
        emit MintCommitted(actionId, to, amount);
    }

    /* ------------------------------ burns ------------------------------ */

    function burn(uint256 amount) external whenNotPaused {
        _burn(_msgSender(), amount);
    }

    /// @notice Burn `amount` from `account`. BRIDGE_ROLE only, rate-limited.
    /// @dev No ERC20 allowance is required — deliberately. `depositForBurn` is
    ///      a single user transaction with no prior `approve`, which is the
    ///      integration contract every deployed bridge and front-end already
    ///      relies on.
    ///
    ///      The cost of that choice is that BRIDGE_ROLE can burn any holder's
    ///      balance, so the burn rate limit — not an allowance — is what bounds
    ///      a bridge compromise. It refills independently of the mint bucket, so
    ///      heavy inbound traffic cannot throttle outbound transfers. Size
    ///      `capacity` to plausible peak per-`period` volume, and pair it with
    ///      monitoring: `removeBridge` is instant and open to PAUSER_ROLE.
    function burnFrom(
        address account,
        uint256 amount
    ) external onlyRole(BRIDGE_ROLE) whenNotPaused {
        _consumeBridgeBurnAllowance(_msgSender(), amount);
        _burn(account, amount);
        emit BridgeBurned(_msgSender(), account, amount);
    }

    function redeemRequest(
        uint256 amount,
        string calldata offChainReference
    ) external whenNotPaused {
        _burn(_msgSender(), amount);
        emit RedeemRequested(_msgSender(), amount, offChainReference);
    }

    /* ---------------------------- compliance ---------------------------- */

    function freezeAddress(address account) external onlyFreezerOrAdmin {
        if (account == address(0)) revert ZeroAddress();
        if (frozen[account]) revert AlreadyFrozen();
        frozen[account] = true;
        emit AccountFrozen(account);
    }

    function unfreezeAddress(address account) external onlyFreezerOrAdmin {
        if (!frozen[account]) revert NotFrozen();
        frozen[account] = false;
        emit AccountUnfrozen(account);
    }

    /// @dev Intentionally bypasses pause and the freeze check on `from` via
    ///      `_forceTransfer`, so seizure works on a frozen account and while
    ///      paused. A frozen `to` is rejected: the freeze check is skipped on
    ///      both sides, and seizing into a frozen account would lock the funds.
    function seizeFunds(
        address from,
        address to,
        uint256 amount
    ) external onlySeizerOrAdmin {
        if (from == address(0) || to == address(0)) revert ZeroAddress();
        if (frozen[to]) revert FrozenRecipient(to);
        if (balanceOf(from) < amount) revert InsufficientBalance();
        _forceTransfer(from, to, amount);
        emit FundsSeized(from, to, amount);
    }

    function pause() external onlyPauserOrAdmin {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /* -------------------- queue/commit: mint cap ------------------------ */

    function queueSetMintCap(
        uint256 newCap
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 actionId) {
        actionId = _queueAction(_hashMintCap(newCap));
        emit MintCapChangeQueued(actionId, newCap);
    }

    function commitSetMintCap(
        uint256 actionId,
        uint256 newCap
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _consumeAction(actionId, _hashMintCap(newCap));
        emit MintCapUpdated(mintCap, newCap);
        mintCap = newCap;
    }

    /* ---------------------- queue/commit: UUPS upgrade ------------------- */

    function queueUpgrade(
        address newImpl,
        bytes calldata data
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 actionId) {
        if (newImpl == address(0)) revert ZeroImpl();
        actionId = _queueAction(_hashUpgrade(newImpl, data));
        emit UpgradeQueued(actionId, newImpl);
    }

    /// @dev Admin-gated: an unauthenticated commit would let anyone front-run
    ///      the admin's `cancelAction`, closing the cancellation window at
    ///      `eta` instead of at execution.
    function commitUpgrade(
        uint256 actionId,
        address newImpl,
        bytes calldata data
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _consumeAction(actionId, _hashUpgrade(newImpl, data));
        _authorizedImpl = newImpl;
        // `_authorizeUpgrade` consumes and clears the flag before `data` is
        // delegatecalled into the new implementation.
        upgradeToAndCall(newImpl, data);
        emit UpgradeCommitted(actionId, newImpl);
    }

    /* ---------------------- queue/commit: timelock ---------------------- */

    function setMinTimelock(
        uint256 newMin
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 actionId) {
        actionId = _queueAction(_hashSetMinTimelock(newMin));
    }

    function commitSetMinTimelock(
        uint256 actionId,
        uint256 newMin
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _consumeAction(actionId, _hashSetMinTimelock(newMin));
        _setMinTimelock(newMin);
    }

    function setTimelock(
        uint256 newTl
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 actionId) {
        actionId = _queueAction(_hashSetTimelock(newTl));
    }

    function commitSetTimelock(
        uint256 actionId,
        uint256 newTl
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _consumeAction(actionId, _hashSetTimelock(newTl));
        _setTimelock(newTl);
    }

    /* ----------------------------- cancel ------------------------------ */

    /// @notice Cancel any queued action, whatever its type.
    /// @dev One entry point rather than four look-alike wrappers: the previous
    ///      per-type `cancelX` functions all called the same untyped primitive,
    ///      implying a type safety that did not exist.
    function cancelAction(
        uint256 actionId
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _cancelAction(actionId);
    }

    /* ---------------------------- internals ---------------------------- */

    function _checkMintCap(uint256 amount) private view {
        uint256 cap = mintCap;
        if (cap != 0 && totalSupply() + amount > cap) revert MintCapExceeded();
    }

    /// @dev Linear refill of one bucket toward `capacity` over `period`.
    function _available(
        uint96 capacity,
        uint128 remaining,
        uint48 lastRefill,
        uint48 period
    ) private view returns (uint256) {
        if (capacity == 0 || period == 0) return 0;

        uint256 elapsed = block.timestamp - lastRefill;
        if (elapsed >= period) return capacity;

        uint256 refilled = uint256(remaining) +
            (uint256(capacity) * elapsed) /
            period;
        return refilled > capacity ? capacity : refilled;
    }

    function _availableToMint(address bridge) internal view returns (uint256) {
        BridgeLimit memory l = _bridgeLimits[bridge];
        return _available(l.capacity, l.mintRemaining, l.lastMintRefill, l.period);
    }

    function _availableToBurn(address bridge) internal view returns (uint256) {
        BridgeLimit memory l = _bridgeLimits[bridge];
        return _available(l.capacity, l.burnRemaining, l.lastBurnRefill, l.period);
    }

    function _consumeBridgeAllowance(address bridge, uint256 amount) private {
        uint256 available = _availableToMint(bridge);
        if (amount > available)
            revert BridgeRateLimitExceeded(amount, available);

        BridgeLimit storage l = _bridgeLimits[bridge];
        l.mintRemaining = uint128(available - amount);
        l.lastMintRefill = uint48(block.timestamp);
    }

    function _consumeBridgeBurnAllowance(
        address bridge,
        uint256 amount
    ) private {
        uint256 available = _availableToBurn(bridge);
        if (amount > available)
            revert BridgeRateLimitExceeded(amount, available);

        BridgeLimit storage l = _bridgeLimits[bridge];
        l.burnRemaining = uint128(available - amount);
        l.lastBurnRefill = uint48(block.timestamp);
    }

    function _hashMint(
        address to,
        uint256 amount
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_MINT, to, amount));
    }

    function _hashMintCap(uint256 newCap) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_MINT_CAP, newCap));
    }

    function _hashAddBridge(
        address bridge,
        uint96 capacity,
        uint48 period
    ) private pure returns (bytes32) {
        return
            keccak256(abi.encode(DOMAIN_ADD_BRIDGE, bridge, capacity, period));
    }

    function _hashSetMinTimelock(
        uint256 newMin
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_SET_MIN_TIMELOCK, newMin));
    }

    function _hashSetTimelock(uint256 newTl) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_SET_TIMELOCK, newTl));
    }

    function _hashUpgrade(
        address newImpl,
        bytes calldata data
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_UPGRADE, newImpl, keccak256(data)));
    }

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    /// @dev Authorized only when invoked indirectly via `commitUpgrade`. The
    ///      flag is cleared here — before `upgradeToAndCall` delegatecalls the
    ///      new implementation's initializer — so the clear can never zero out
    ///      V2 state that lands on this storage slot.
    function _authorizeUpgrade(address newImplementation) internal override {
        if (newImplementation != _authorizedImpl) revert UpgradeNotAuthorized();
        delete _authorizedImpl;
    }

    /// @dev Reject granting any role to the zero address at the lowest level,
    ///      so inherited `grantRole` is covered as well as the `addX` wrappers.
    function _grantRole(
        bytes32 role,
        address account
    ) internal override returns (bool) {
        if (account == address(0)) revert ZeroAddress();
        return super._grantRole(role, account);
    }

    /// @dev Refuse to remove the final admin. Without this, `renounceRole` or
    ///      `revokeRole` by the sole admin permanently bricks the token: no
    ///      unpause, no upgrade, no issuance and no way to grant any role.
    function _revokeRole(
        bytes32 role,
        address account
    ) internal override returns (bool) {
        if (
            role == DEFAULT_ADMIN_ROLE &&
            hasRole(DEFAULT_ADMIN_ROLE, account) &&
            getRoleMemberCount(DEFAULT_ADMIN_ROLE) == 1
        ) {
            revert LastAdminProtected();
        }
        return super._revokeRole(role, account);
    }

    function _forceTransfer(address from, address to, uint256 amount) internal {
        super._update(from, to, amount);
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override whenNotPaused {
        if (from != address(0)) {
            if (frozen[from]) revert ERC20InvalidSender(from);
        }
        if (to != address(0)) {
            if (frozen[to]) revert ERC20InvalidReceiver(to);
        }
        super._update(from, to, value);
    }
}
