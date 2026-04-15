// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
  StableNaira — UUPS upgradeable fiat-backed NGN stablecoin (EVM)

  Deploy via StableNairaUUPSDeployer: users and integrations MUST use the ERC1967 proxy address.
  Upgrades: address with DEFAULT_ADMIN_ROLE calls upgradeToAndCall on the proxy.

  Model
  - 1:1 off-chain NGN reserves; mint / burn aligned with reserve movements.
  - AccessControlEnumerable roles; EIP-2612 permit; optional mintCap.
  - Pausable, freeze blocklist, seize (forced transfer).

  Validate storage layout before any upgrade (e.g. OpenZeppelin upgrades plugin).
*/

import {AccessControlEnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract StableNaira is
    Initializable,
    ERC20PermitUpgradeable,
    PausableUpgradeable,
    AccessControlEnumerableUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant FREEZER_ROLE = keccak256("FREEZER_ROLE");
    bytes32 public constant SEIZER_ROLE = keccak256("SEIZER_ROLE");

    uint8 private constant DECIMALS = 2;

    string public constant VERSION = "1.0";

    uint256 public mintCap;

    mapping(address => bool) public frozen;

    /// @dev Reserved for future storage variables; shrink only when appending new state.
    uint256[50] private __gap;

    error ZeroAddress();
    error AlreadyFrozen();
    error NotFrozen();
    error InsufficientBalance();
    error MintCapExceeded();
    error SingleAdminExpected();
    error NotAuthorizedCompliance();

    event MintCapUpdated(uint256 newCap);
    event RedeemRequested(address indexed account, uint256 amount, string offChainReference);
    event AccountFrozen(address indexed account);
    event AccountUnfrozen(address indexed account);
    event FundsSeized(address indexed from, address indexed to, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(string memory name_, string memory symbol_, address initialAdmin) public initializer {
        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __Pausable_init();
        __AccessControlEnumerable_init();
        __UUPSUpgradeable_init();

        if (initialAdmin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(MINTER_ROLE, initialAdmin);
        _grantRole(PAUSER_ROLE, initialAdmin);
        _grantRole(FREEZER_ROLE, initialAdmin);
        _grantRole(SEIZER_ROLE, initialAdmin);
    }

    modifier onlyPauserOrAdmin() {
        address s = _msgSender();
        if (!hasRole(PAUSER_ROLE, s) && !hasRole(DEFAULT_ADMIN_ROLE, s)) revert NotAuthorizedCompliance();
        _;
    }

    modifier onlyFreezerOrAdmin() {
        address s = _msgSender();
        if (!hasRole(FREEZER_ROLE, s) && !hasRole(DEFAULT_ADMIN_ROLE, s)) revert NotAuthorizedCompliance();
        _;
    }

    modifier onlySeizerOrAdmin() {
        address s = _msgSender();
        if (!hasRole(SEIZER_ROLE, s) && !hasRole(DEFAULT_ADMIN_ROLE, s)) revert NotAuthorizedCompliance();
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
        mintCap = newCap;
        emit MintCapUpdated(newCap);
    }

    function addMinter(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        grantRole(MINTER_ROLE, account);
    }

    function removeMinter(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(MINTER_ROLE, account);
    }

    function addPauser(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        grantRole(PAUSER_ROLE, account);
    }

    function removePauser(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(PAUSER_ROLE, account);
    }

    function addFreezer(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        grantRole(FREEZER_ROLE, account);
    }

    function removeFreezer(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(FREEZER_ROLE, account);
    }

    function addSeizer(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        grantRole(SEIZER_ROLE, account);
    }

    function removeSeizer(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(SEIZER_ROLE, account);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) whenNotPaused returns (bool) {
        if (to == address(0)) revert ZeroAddress();
        uint256 cap = mintCap;
        if (cap != 0 && totalSupply() + amount > cap) revert MintCapExceeded();
        _mint(to, amount);
        return true;
    }

    function burn(uint256 amount) external whenNotPaused {
        _burn(_msgSender(), amount);
    }

    function burnFrom(address account, uint256 amount) external onlyRole(MINTER_ROLE) whenNotPaused {
        _burn(account, amount);
    }

    function redeemRequest(uint256 amount, string calldata offChainReference) external whenNotPaused {
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

    function seizeFunds(address from, address to, uint256 amount) external onlySeizerOrAdmin {
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

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    function _forceTransfer(address from, address to, uint256 amount) internal {
        super._update(from, to, amount);
    }

    function _update(address from, address to, uint256 value) internal override whenNotPaused {
        if (from != address(0)) {
            if (frozen[from]) revert ERC20InvalidSender(from);
        }
        if (to != address(0)) {
            if (frozen[to]) revert ERC20InvalidReceiver(to);
        }
        super._update(from, to, value);
    }
}
