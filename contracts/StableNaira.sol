// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
  StableNaira — UUPS upgradeable fiat-backed NGN stablecoin (EVM)

  Deploy via StableNairaUUPSDeployer: users and integrations MUST use the ERC1967 proxy address.
  Upgrades: address with DEFAULT_ADMIN_ROLE queues the upgrade, anyone commits after the timelock.

  Model
  - 1:1 off-chain NGN reserves; mint / burn aligned with reserve movements.
  - AccessControlEnumerable roles; EIP-2612 permit; optional mintCap.
  - Pausable, freeze blocklist, seize (forced transfer).
  - UUPS upgrades pass through a queue/commit timelock (1-hour minimum, admin-adjustable upward).
  - Sensitive admin mint operations may also be queued and committed after the same timelock.

  SECURITY NOTES (audit findings — see contract-audit reports for details)
  - HIGH-03: `burnFrom(account, amount)` is gated only by MINTER_ROLE. It does NOT
    require an ERC20 allowance from `account`. Holders of MINTER_ROLE can burn any
    user's balance. The CCTP TokenMessenger relies on this. Operationally, MINTER_ROLE
    must only be held by the bridge (no EOAs), and the admin must be a multisig.
  - LOW-07: `seizeFunds` intentionally bypasses the freeze list and the pause guard
    (calls `super._update` directly via `_forceTransfer`). This lets compliance seizure
    work even when the source account is frozen or the contract is paused. Seize is
    governance-only via SEIZER_ROLE / DEFAULT_ADMIN_ROLE.

  Validate storage layout before any upgrade (e.g. OpenZeppelin upgrades plugin).
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
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant FREEZER_ROLE = keccak256("FREEZER_ROLE");
    bytes32 public constant SEIZER_ROLE = keccak256("SEIZER_ROLE");

    bytes32 private constant DOMAIN_MINT = keccak256("StableNaira.Mint.v1");
    bytes32 private constant DOMAIN_UPGRADE =
        keccak256("StableNaira.Upgrade.v1");

    uint8 private constant DECIMALS = 2;

    string public constant VERSION = "1.0";

    uint256 public mintCap;

    mapping(address => bool) public frozen;

    /// @dev Transient flag set by `commitUpgrade` to authorize one upgrade.
    address private _authorizedImpl;

    /// @dev Reserved for future storage variables; shrink only when appending new state.
    uint256[49] private __gap;

    error ZeroAddress();
    error AlreadyFrozen();
    error NotFrozen();
    error InsufficientBalance();
    error MintCapExceeded();
    error SingleAdminExpected();
    error NotAuthorizedCompliance();
    error UpgradeNotAuthorized();
    error ZeroImpl();

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
    event UpgradeQueued(uint256 indexed actionId, address indexed newImpl);
    event UpgradeCommitted(uint256 indexed actionId, address indexed newImpl);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory name_,
        string memory symbol_,
        address initialAdmin
    ) public initializer {
        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __Pausable_init();
        __AccessControlEnumerable_init();
        __UUPSUpgradeable_init();
        // Default 1-minute timelock applied to upgrades; admin can raise via setTimelock.
        __Timelocked_init(0, 0);

        if (initialAdmin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(MINTER_ROLE, initialAdmin);
        _grantRole(PAUSER_ROLE, initialAdmin);
        _grantRole(FREEZER_ROLE, initialAdmin);
        _grantRole(SEIZER_ROLE, initialAdmin);
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

    function minters(address account) external view returns (bool) {
        return hasRole(MINTER_ROLE, account);
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

    function owner() external view returns (address) {
        uint256 n = getRoleMemberCount(DEFAULT_ADMIN_ROLE);
        if (n != 1) revert SingleAdminExpected();
        return getRoleMember(DEFAULT_ADMIN_ROLE, 0);
    }

    function setMintCap(uint256 newCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit MintCapUpdated(mintCap, newCap);
        mintCap = newCap;
    }

    function addMinter(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        grantRole(MINTER_ROLE, account);
    }

    function removeMinter(
        address account
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(MINTER_ROLE, account);
    }

    function addPauser(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        grantRole(PAUSER_ROLE, account);
    }

    function removePauser(
        address account
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(PAUSER_ROLE, account);
    }

    function addFreezer(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        grantRole(FREEZER_ROLE, account);
    }

    function removeFreezer(
        address account
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(FREEZER_ROLE, account);
    }

    function addSeizer(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        grantRole(SEIZER_ROLE, account);
    }

    function removeSeizer(
        address account
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(SEIZER_ROLE, account);
    }

    // function mint(
    //     address to,
    //     uint256 amount
    // ) external onlyRole(MINTER_ROLE) whenNotPaused returns (bool) {
    //     if (to == address(0)) revert ZeroAddress();
    //     uint256 cap = mintCap;
    //     if (cap != 0 && totalSupply() + amount > cap) revert MintCapExceeded();
    //     _mint(to, amount);
    //     return true;
    // }

    /// @notice Queue a sensitive mint operation keyed by recipient and amount.
    /// @dev Caller must be admin; action can be committed after the configured timelock.
    function mint(
        address to,
        uint256 amount
    ) external onlyRole(MINTER_ROLE) returns (uint256 actionId) {
        if (to == address(0)) revert ZeroAddress();
        actionId = _queueAction(_hashMint(to, amount));
        emit MintQueued(actionId, to, amount);
    }

    /// @notice Commit a previously queued mint after the timelock has elapsed.
    /// @dev The supplied args must match the queued action hash exactly.
    function commitMint(uint256 actionId, address to, uint256 amount) onlyRole(DEFAULT_ADMIN_ROLE) external {
        _consumeAction(actionId, _hashMint(to, amount));
        if (to == address(0)) revert ZeroAddress();
        uint256 cap = mintCap;
        if (cap != 0 && totalSupply() + amount > cap) revert MintCapExceeded();
        _mint(to, amount);
        emit MintCommitted(actionId, to, amount);
    }

    /// @notice Cancel a queued mint action before it is committed.
    function cancelMint(
        uint256 actionId
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _cancelAction(actionId);
    }

    function burn(uint256 amount) external whenNotPaused {
        _burn(_msgSender(), amount);
    }

    /// @dev SECURITY: gated by MINTER_ROLE only (no allowance check). See HIGH-03 above.
    function burnFrom(
        address account,
        uint256 amount
    ) external onlyRole(MINTER_ROLE) whenNotPaused {
        _burn(account, amount);
    }

    function redeemRequest(
        uint256 amount,
        string calldata offChainReference
    ) external whenNotPaused {
        _burn(_msgSender(), amount);
        emit RedeemRequested(_msgSender(), amount, offChainReference);
    }

    function freezeAddress(address account) external onlyFreezerOrAdmin {
        if (frozen[account]) revert AlreadyFrozen();
        frozen[account] = true;
        emit AccountFrozen(account);
    }

    function unfreezeAddress(address account) external onlyFreezerOrAdmin {
        if (!frozen[account]) revert NotFrozen();
        frozen[account] = false;
        emit AccountUnfrozen(account);
    }

    /// @dev SECURITY: intentionally bypasses pause and freeze via `_forceTransfer`.
    ///      See LOW-07 in contract docs. Compliance seizure must work on frozen
    ///      accounts and during pause.
    function seizeFunds(
        address from,
        address to,
        uint256 amount
    ) external onlySeizerOrAdmin {
        if (from == address(0) || to == address(0)) revert ZeroAddress();
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

    /* ---------------------- queue/commit: UUPS upgrade ------------------- */

    function queueUpgrade(
        address newImpl,
        bytes calldata data
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 actionId) {
        if (newImpl == address(0)) revert ZeroImpl();
        actionId = _queueAction(_hashUpgrade(newImpl, data));
        emit UpgradeQueued(actionId, newImpl);
    }

    function commitUpgrade(
        uint256 actionId,
        address newImpl,
        bytes calldata data
    ) external {
        _consumeAction(actionId, _hashUpgrade(newImpl, data));
        _authorizedImpl = newImpl;
        upgradeToAndCall(newImpl, data);
        delete _authorizedImpl;
        emit UpgradeCommitted(actionId, newImpl);
    }

    function cancelUpgrade(
        uint256 actionId
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _cancelAction(actionId);
    }

    function setMinTimelock(
        uint256 newMin
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 actionId) {
        actionId = _queueAction(_hashSetMinTimelock(newMin));
    }

    function commitSetMinTimelock(uint256 actionId, uint256 newMin) external {
        _consumeAction(actionId, _hashSetMinTimelock(newMin));
        _setMinTimelock(newMin);
    }

    function cancelSetMinTimelock(
        uint256 actionId
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _cancelAction(actionId);
    }

    function setTimelock(
        uint256 newTl
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 actionId) {
        actionId = _queueAction(_hashSetTimelock(newTl));
    }

    function commitSetTimelock(uint256 actionId, uint256 newTl) external {
        _consumeAction(actionId, _hashSetTimelock(newTl));
        _setTimelock(newTl);
    }

    function cancelSetTimelock(
        uint256 actionId
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _cancelAction(actionId);
    }

    /* ---------------------------- internals ---------------------------- */

    function _hashMint(
        address to,
        uint256 amount
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_MINT, to, amount));
    }

    function _hashSetMinTimelock(
        uint256 newMin
    ) private pure returns (bytes32) {
        return keccak256(abi.encode("StableNaira.SetMinTimelock.v1", newMin));
    }

    function _hashSetTimelock(uint256 newTl) private pure returns (bytes32) {
        return keccak256(abi.encode("StableNaira.SetTimelock.v1", newTl));
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

    /// @dev Authorized only when invoked indirectly via `commitUpgrade`.
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        if (newImplementation != _authorizedImpl) revert UpgradeNotAuthorized();
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
