// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import { TimelockedUpgradeable } from "./utils/TimelockedUpgradeable.sol";
import { Bytes32Address } from "./libraries/Bytes32Address.sol";
import { Message } from "./libraries/Message.sol";
import { IMessageTransmitter } from "./interfaces/IMessageTransmitter.sol";
import { IMessageHandler } from "./interfaces/IMessageHandler.sol";
import { ISignatureVerifier } from "./interfaces/ISignatureVerifier.sol";

/// @title MessageTransmitter
/// @notice Generic cross-chain message envelope. App contracts (e.g.
///         `TokenMessenger`) wrap `sendMessage` and implement `IMessageHandler`
///         to receive on the destination chain.
///
///         Sensitive admin operations — UUPS upgrades and `setSignatureVerifier`
///         — flow through the shared `TimelockedUpgradeable` queue/commit gate
///         (1-hour minimum, owner-adjustable upward). Lower-impact operations
///         (`setMaxMessageBodySize`, `pause`/`unpause`) remain immediate.
contract MessageTransmitter is
    TimelockedUpgradeable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    IMessageTransmitter
{
    using Bytes32Address for address;
    using Bytes32Address for bytes32;

    /// @dev Envelope version this transmitter accepts. Bumped only on a
    ///      breaking layout change to `Message`.
    uint32 private constant ENVELOPE_VERSION = 1;

    /// @dev Floor on `maxMessageBodySize` so a misconfigured value cannot
    ///      brick the burn path. 132 = `BurnMessage.BODY_LEN`.
    uint256 public constant MIN_MAX_BODY_SIZE = 132;

    bytes32 private constant DOMAIN_UPGRADE = keccak256("MessageTransmitter.Upgrade.v1");
    bytes32 private constant DOMAIN_SET_VERIFIER = keccak256("MessageTransmitter.SetVerifier.v1");

    /// @inheritdoc IMessageTransmitter
    uint32 public override localDomain;

    /// @dev Next nonce allocated by `sendMessage` on this chain.
    uint64 private _nextNonce;

    /// @inheritdoc IMessageTransmitter
    address public override signatureVerifier;

    /// @inheritdoc IMessageTransmitter
    uint256 public override maxMessageBodySize;

    /// @dev `usedNonces[sourceDomain][nonce] == true` once received here.
    mapping(uint32 => mapping(uint64 => bool)) private _usedNonces;

    /// @dev Transient flag set by `commitUpgrade` to authorize one upgrade.
    address private _authorizedImpl;

    /// @dev Storage gap. 50 - 4 used = 46.
    uint256[46] private __gap;

    /* ------------------------------ events ----------------------------- */

    event UpgradeQueued(uint256 indexed actionId, address indexed newImpl);
    event UpgradeCommitted(uint256 indexed actionId, address indexed newImpl);
    event VerifierChangeQueued(uint256 indexed actionId, address indexed newVerifier);
    event VerifierChangeCommitted(uint256 indexed actionId, address indexed newVerifier);

    /* ------------------------------ errors ----------------------------- */

    error UpgradeNotAuthorized();
    error ZeroImpl();
    error MaxBodySizeTooSmall(uint256 attempted, uint256 floor);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        uint32 localDomain_,
        address signatureVerifier_,
        uint256 maxMessageBodySize_,
        address owner_,
        uint256 initialTimelock,
        uint256 initialMinTimelock
    ) external initializer {
        if (localDomain_ == 0) revert InvalidLocalDomain();
        if (signatureVerifier_ == address(0)) revert InvalidVerifier();
        if (maxMessageBodySize_ < MIN_MAX_BODY_SIZE) {
            revert MaxBodySizeTooSmall(maxMessageBodySize_, MIN_MAX_BODY_SIZE);
        }

        __Ownable_init(owner_);
        __Pausable_init();
        __Timelocked_init(initialTimelock, initialMinTimelock);

        localDomain = localDomain_;
        signatureVerifier = signatureVerifier_;
        maxMessageBodySize = maxMessageBodySize_;

        emit SignatureVerifierUpdated(address(0), signatureVerifier_);
        emit MaxMessageBodySizeUpdated(0, maxMessageBodySize_);
    }

    /* ------------------------------ views ------------------------------ */

    /// @inheritdoc IMessageTransmitter
    function version() external pure override returns (uint32) {
        return ENVELOPE_VERSION;
    }

    /// @inheritdoc IMessageTransmitter
    function nextAvailableNonce() external view override returns (uint64) {
        return _nextNonce;
    }

    /// @inheritdoc IMessageTransmitter
    function isNonceUsed(uint32 sourceDomain, uint64 nonce) external view override returns (bool) {
        return _usedNonces[sourceDomain][nonce];
    }

    /* ------------------------------- send ------------------------------ */

    /// @inheritdoc IMessageTransmitter
    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes calldata messageBody
    ) external override whenNotPaused returns (uint64 nonce) {
        return _sendMessage(destinationDomain, recipient, bytes32(0), messageBody);
    }

    /// @inheritdoc IMessageTransmitter
    function sendMessageWithCaller(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32 destinationCaller,
        bytes calldata messageBody
    ) external override whenNotPaused returns (uint64 nonce) {
        return _sendMessage(destinationDomain, recipient, destinationCaller, messageBody);
    }

    function _sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32 destinationCaller,
        bytes calldata messageBody
    ) private returns (uint64 nonce) {
        if (destinationDomain == localDomain) revert LocalDestinationNotAllowed();
        if (messageBody.length > maxMessageBodySize) {
            revert MessageBodyTooLarge(messageBody.length, maxMessageBodySize);
        }

        nonce = _nextNonce++;

        bytes memory encoded = Message.format(
            ENVELOPE_VERSION,
            localDomain,
            destinationDomain,
            nonce,
            msg.sender.toBytes32(),
            recipient,
            destinationCaller,
            messageBody
        );

        emit MessageSent(encoded);
    }

    /* ----------------------------- receive ----------------------------- */

    /// @inheritdoc IMessageTransmitter
    function receiveMessage(
        bytes calldata message,
        bytes calldata attestation
    ) external override whenNotPaused returns (bool) {
        // 1. Verify attestation FIRST — cheapest reject for invalid messages.
        ISignatureVerifier(signatureVerifier).verify(
            Message.attestationDigest(message, block.chainid, address(this)),
            attestation
        );

        // 2. Decode envelope (this also enforces minimum length).
        Message.EnvelopeView memory v = Message.decode(message);

        // 3. Envelope sanity.
        if (v.version != ENVELOPE_VERSION) revert InvalidVersion(ENVELOPE_VERSION, v.version);
        if (v.destinationDomain != localDomain) revert InvalidDestinationDomain(localDomain, v.destinationDomain);
        if (v.destinationCaller != bytes32(0) && v.destinationCaller != msg.sender.toBytes32()) {
            revert UnauthorizedCaller(v.destinationCaller, msg.sender);
        }

        // 4. Replay protection — mark BEFORE handler so a re-entrant retry
        //    of the same message fails fast. If the handler reverts, the
        //    whole tx reverts and the mark is rolled back.
        if (_usedNonces[v.sourceDomain][v.nonce]) revert NonceAlreadyUsed(v.sourceDomain, v.nonce);
        _usedNonces[v.sourceDomain][v.nonce] = true;

        // 5. Hand off to the recipient. The recipient must be EVM-shaped
        //    (high 12 bytes zero) on this chain.
        address recipient = v.recipient.toAddressChecked();
        bool ok = IMessageHandler(recipient).handleReceiveMessage(v.sourceDomain, v.sender, v.body);
        if (!ok) revert RecipientHandlerFailed();

        emit MessageReceived(msg.sender, v.sourceDomain, v.nonce, v.sender, v.body);
        return true;
    }

    /* ----------------- queue/commit: signature verifier ---------------- */

    /// @notice Queue a verifier swap. Hash-bound to `newVerifier`.
    function queueSetSignatureVerifier(
        address newVerifier
    ) external onlyOwner returns (uint256 actionId) {
        if (newVerifier == address(0)) revert InvalidVerifier();
        actionId = _queueAction(_hashSetVerifier(newVerifier));
        emit VerifierChangeQueued(actionId, newVerifier);
    }

    /// @notice Permissionless commit after eta. Caller must pass identical args.
    function commitSetSignatureVerifier(uint256 actionId, address newVerifier) external {
        _consumeAction(actionId, _hashSetVerifier(newVerifier));
        emit SignatureVerifierUpdated(signatureVerifier, newVerifier);
        signatureVerifier = newVerifier;
        emit VerifierChangeCommitted(actionId, newVerifier);
    }

    /* --------------------- queue/commit: UUPS upgrade ------------------- */

    function queueUpgrade(
        address newImpl,
        bytes calldata data
    ) external onlyOwner returns (uint256 actionId) {
        if (newImpl == address(0)) revert ZeroImpl();
        actionId = _queueAction(_hashUpgrade(newImpl, data));
        emit UpgradeQueued(actionId, newImpl);
    }

    function commitUpgrade(uint256 actionId, address newImpl, bytes calldata data) external {
        _consumeAction(actionId, _hashUpgrade(newImpl, data));
        _authorizedImpl = newImpl;
        upgradeToAndCall(newImpl, data);
        delete _authorizedImpl;
        emit UpgradeCommitted(actionId, newImpl);
    }

    /* -------------------------- cancel any action ----------------------- */

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

    function setMaxMessageBodySize(
        uint256 newMax
    ) external onlyOwner {
        if (newMax < MIN_MAX_BODY_SIZE) revert MaxBodySizeTooSmall(newMax, MIN_MAX_BODY_SIZE);
        emit MaxMessageBodySizeUpdated(maxMessageBodySize, newMax);
        maxMessageBodySize = newMax;
    }

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

    function _hashSetVerifier(
        address newVerifier
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_SET_VERIFIER, newVerifier));
    }

    /* ----------------------------- upgrade ----------------------------- */

    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        if (newImplementation != _authorizedImpl) revert UpgradeNotAuthorized();
    }
}
