// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import { TimelockedUpgradeable } from "./utils/TimelockedUpgradeable.sol";
import { Bytes32Address } from "./libraries/Bytes32Address.sol";
import { BurnMessage } from "./libraries/BurnMessage.sol";
import { ITokenMessenger } from "./interfaces/ITokenMessenger.sol";
import { IMessageTransmitter } from "./interfaces/IMessageTransmitter.sol";
import { IMessageHandler } from "./interfaces/IMessageHandler.sol";
import { IStableNaira } from "./interfaces/IStableNaira.sol";

/// @title TokenMessenger
/// @notice Burn-and-mint cross-chain transfers for StableNaira. One
///         deployment per chain. Each deployment:
///           - is registered as the `recipient` for messages from peer
///             TokenMessengers on other domains;
///           - holds `MINTER_ROLE` on the local `StableNaira`;
///           - knows the local `MessageTransmitter` it dispatches through.
///
///         All sensitive admin operations — UUPS upgrades, swapping the
///         underlying `localToken` or `messageTransmitter`, configuring
///         remote routers, and changing the fee config — pass through the
///         shared `TimelockedUpgradeable` queue/commit gate (1-hour minimum,
///         owner-adjustable upward). `pause` / `unpause` remain immediate.
///
///         The fee path is **present but inert**: `feeBps == 0` is the only
///         configuration permitted in v1 testnet. The setter caps `feeBps`
///         at `MAX_FEE_BPS` for forward compatibility.
contract TokenMessenger is
    TimelockedUpgradeable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ITokenMessenger,
    IMessageHandler
{
    using Bytes32Address for address;
    using Bytes32Address for bytes32;

    /// @notice Body version this contract emits and accepts. Bumped only on
    ///         a breaking change to `BurnMessage`.
    uint32 private constant BODY_VERSION = 1;

    /// @notice Hard cap on the fee in basis points. 100 = 1%.
    uint256 public constant MAX_FEE_BPS = 100;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    bytes32 private constant DOMAIN_UPGRADE = keccak256("TokenMessenger.Upgrade.v1");
    bytes32 private constant DOMAIN_LOCAL_TOKEN = keccak256("TokenMessenger.SetLocalToken.v1");
    bytes32 private constant DOMAIN_TRANSMITTER = keccak256("TokenMessenger.SetTransmitter.v1");
    bytes32 private constant DOMAIN_REMOTE_ROUTER = keccak256("TokenMessenger.SetRemoteRouter.v1");
    bytes32 private constant DOMAIN_FEE_CONFIG = keccak256("TokenMessenger.SetFeeConfig.v1");

    /// @inheritdoc ITokenMessenger
    address public override messageTransmitter;

    /// @inheritdoc ITokenMessenger
    address public override localToken;

    /// @inheritdoc ITokenMessenger
    uint256 public override feeBps;

    /// @inheritdoc ITokenMessenger
    address public override feeRecipient;

    /// @dev domain → bytes32 address of the peer TokenMessenger on that chain.
    mapping(uint32 => bytes32) private _remoteRouters;

    /// @dev Transient flag set by `commitUpgrade` to authorize one upgrade.
    address private _authorizedImpl;

    /// @dev Storage gap. 50 - 6 used = 44.
    uint256[44] private __gap;

    /* ------------------------------ events ----------------------------- */

    event UpgradeQueued(uint256 indexed actionId, address indexed newImpl);
    event UpgradeCommitted(uint256 indexed actionId, address indexed newImpl);
    event LocalTokenChangeQueued(uint256 indexed actionId, address indexed newToken);
    event MessageTransmitterChangeQueued(uint256 indexed actionId, address indexed newTransmitter);
    event RemoteRouterChangeQueued(uint256 indexed actionId, uint32 indexed domain, bytes32 router);
    event FeeConfigChangeQueued(
        uint256 indexed actionId, uint256 newFeeBps, address indexed newFeeRecipient
    );

    /* ------------------------------ errors ----------------------------- */

    error UpgradeNotAuthorized();
    error ZeroImpl();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address messageTransmitter_,
        address localToken_,
        address owner_,
        uint256 initialTimelock,
        uint256 initialMinTimelock
    ) external initializer {
        if (messageTransmitter_ == address(0)) revert ZeroAddress();
        if (localToken_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __Timelocked_init(initialTimelock, initialMinTimelock);

        messageTransmitter = messageTransmitter_;
        localToken = localToken_;

        emit MessageTransmitterUpdated(address(0), messageTransmitter_);
        emit LocalTokenUpdated(address(0), localToken_);
    }

    /* ----------------------------- views ------------------------------ */

    /// @inheritdoc ITokenMessenger
    function remoteRouter(
        uint32 domain
    ) external view override returns (bytes32) {
        return _remoteRouters[domain];
    }

    /// @inheritdoc ITokenMessenger
    function bodyVersion() external pure override returns (uint32) {
        return BODY_VERSION;
    }

    /* ----------------------------- deposit ----------------------------- */

    /// @inheritdoc ITokenMessenger
    /// @dev SECURITY NOTE: this calls `IStableNaira.burnFrom(msg.sender, amount)`,
    ///      which is gated only by `MINTER_ROLE` on the token (not by ERC20
    ///      allowance). The bridge holds that role; if it is compromised it
    ///      can burn any user's balance. Audit finding HIGH-03.
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken
    ) external override whenNotPaused returns (uint64) {
        return _depositForBurn(amount, destinationDomain, mintRecipient, burnToken, bytes32(0));
    }

    /// @inheritdoc ITokenMessenger
    function depositForBurnWithCaller(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller
    ) external override whenNotPaused returns (uint64) {
        return _depositForBurn(amount, destinationDomain, mintRecipient, burnToken, destinationCaller);
    }

    function _depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller
    ) private returns (uint64 nonce) {
        if (amount == 0) revert ZeroAmount();
        if (mintRecipient == bytes32(0)) revert ZeroMintRecipient();
        if (burnToken != localToken) revert InvalidBurnToken(localToken, burnToken);

        bytes32 destRouter = _remoteRouters[destinationDomain];
        if (destRouter == bytes32(0)) revert UnregisteredRemoteRouter(destinationDomain);

        IStableNaira(localToken).burnFrom(msg.sender, amount);

        uint256 amountAfterFee = _chargeFee(amount);

        bytes memory body = BurnMessage.format(
            BODY_VERSION, burnToken.toBytes32(), mintRecipient, amountAfterFee, msg.sender.toBytes32()
        );

        if (destinationCaller == bytes32(0)) {
            nonce = IMessageTransmitter(messageTransmitter).sendMessage(destinationDomain, destRouter, body);
        } else {
            nonce = IMessageTransmitter(messageTransmitter).sendMessageWithCaller(
                destinationDomain, destRouter, destinationCaller, body
            );
        }

        emit DepositForBurn(
            nonce, burnToken, amount, msg.sender, mintRecipient, destinationDomain, destRouter, destinationCaller
        );
    }

    function _chargeFee(
        uint256 amount
    ) private returns (uint256 amountAfterFee) {
        uint256 bps = feeBps;
        if (bps == 0) return amount;
        uint256 fee = (amount * bps) / BPS_DENOMINATOR;
        if (fee == 0) return amount;
        IStableNaira(localToken).mint(feeRecipient, fee);
        return amount - fee;
    }

    /* ----------------------------- receive ---------------------------- */

    /// @inheritdoc IMessageHandler
    function handleReceiveMessage(
        uint32 sourceDomain,
        bytes32 sender,
        bytes calldata messageBody
    ) external override whenNotPaused returns (bool) {
        if (msg.sender != messageTransmitter) revert OnlyMessageTransmitter(msg.sender);

        bytes32 expectedSender = _remoteRouters[sourceDomain];
        if (expectedSender == bytes32(0)) revert UnregisteredRemoteRouter(sourceDomain);
        if (sender != expectedSender) revert InvalidRemoteSender(expectedSender, sender);

        BurnMessage.BurnView memory v = BurnMessage.decode(messageBody);
        if (v.version != BODY_VERSION) revert UnsupportedBodyVersion(v.version);

        address recipient = v.mintRecipient.toAddressChecked();

        IStableNaira(localToken).mint(recipient, v.amount);

        emit MintAndWithdraw(recipient, v.amount, localToken);
        return true;
    }

    /* ---------------------- queue: sensitive admin --------------------- */

    function queueSetLocalToken(
        address newToken
    ) external onlyOwner returns (uint256 actionId) {
        if (newToken == address(0)) revert ZeroAddress();
        actionId = _queueAction(_hashLocalToken(newToken));
        emit LocalTokenChangeQueued(actionId, newToken);
    }

    function queueSetMessageTransmitter(
        address newTransmitter
    ) external onlyOwner returns (uint256 actionId) {
        if (newTransmitter == address(0)) revert ZeroAddress();
        actionId = _queueAction(_hashTransmitter(newTransmitter));
        emit MessageTransmitterChangeQueued(actionId, newTransmitter);
    }

    function queueSetRemoteRouter(
        uint32 domain,
        bytes32 router
    ) external onlyOwner returns (uint256 actionId) {
        actionId = _queueAction(_hashRemoteRouter(domain, router));
        emit RemoteRouterChangeQueued(actionId, domain, router);
    }

    function queueSetFeeConfig(
        uint256 newFeeBps,
        address newFeeRecipient
    ) external onlyOwner returns (uint256 actionId) {
        if (newFeeBps > MAX_FEE_BPS) revert FeeBpsTooHigh(newFeeBps, MAX_FEE_BPS);
        if (newFeeBps > 0 && newFeeRecipient == address(0)) revert InvalidFeeRecipient();
        actionId = _queueAction(_hashFeeConfig(newFeeBps, newFeeRecipient));
        emit FeeConfigChangeQueued(actionId, newFeeBps, newFeeRecipient);
    }

    function queueUpgrade(
        address newImpl,
        bytes calldata data
    ) external onlyOwner returns (uint256 actionId) {
        if (newImpl == address(0)) revert ZeroImpl();
        actionId = _queueAction(_hashUpgrade(newImpl, data));
        emit UpgradeQueued(actionId, newImpl);
    }

    /* --------------------- commit: sensitive admin --------------------- */

    function commitSetLocalToken(uint256 actionId, address newToken) external {
        _consumeAction(actionId, _hashLocalToken(newToken));
        emit LocalTokenUpdated(localToken, newToken);
        localToken = newToken;
    }

    function commitSetMessageTransmitter(uint256 actionId, address newTransmitter) external {
        _consumeAction(actionId, _hashTransmitter(newTransmitter));
        emit MessageTransmitterUpdated(messageTransmitter, newTransmitter);
        messageTransmitter = newTransmitter;
    }

    function commitSetRemoteRouter(uint256 actionId, uint32 domain, bytes32 router) external {
        _consumeAction(actionId, _hashRemoteRouter(domain, router));
        bytes32 previous = _remoteRouters[domain];
        _remoteRouters[domain] = router;
        emit RemoteRouterUpdated(domain, previous, router);
    }

    function commitSetFeeConfig(uint256 actionId, uint256 newFeeBps, address newFeeRecipient) external {
        _consumeAction(actionId, _hashFeeConfig(newFeeBps, newFeeRecipient));
        emit FeeConfigUpdated(feeBps, newFeeBps, feeRecipient, newFeeRecipient);
        feeBps = newFeeBps;
        feeRecipient = newFeeRecipient;
    }

    function commitUpgrade(uint256 actionId, address newImpl, bytes calldata data) external {
        _consumeAction(actionId, _hashUpgrade(newImpl, data));
        _authorizedImpl = newImpl;
        upgradeToAndCall(newImpl, data);
        delete _authorizedImpl;
        emit UpgradeCommitted(actionId, newImpl);
    }

    /* ----------------------------- cancel ----------------------------- */

    function cancel(
        uint256 actionId
    ) external onlyOwner {
        _cancelAction(actionId);
    }

    /* -------------------------- timelock setters ------------------------ */

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

    /* ---------------------------- immediate admin ----------------------- */

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /* ----------------------------- internals --------------------------- */

    function _hashUpgrade(address newImpl, bytes calldata data) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_UPGRADE, newImpl, keccak256(data)));
    }

    function _hashLocalToken(
        address newToken
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_LOCAL_TOKEN, newToken));
    }

    function _hashTransmitter(
        address newTransmitter
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TRANSMITTER, newTransmitter));
    }

    function _hashRemoteRouter(uint32 domain, bytes32 router) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_REMOTE_ROUTER, domain, router));
    }

    function _hashFeeConfig(uint256 newFeeBps, address newFeeRecipient) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_FEE_CONFIG, newFeeBps, newFeeRecipient));
    }

    /* ----------------------------- upgrade ---------------------------- */

    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        if (newImplementation != _authorizedImpl) revert UpgradeNotAuthorized();
    }
}
