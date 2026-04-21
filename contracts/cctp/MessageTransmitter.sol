// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControlEnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IMessageTransmitter} from "./interfaces/IMessageTransmitter.sol";
import {IMessageHandler} from "./interfaces/IMessageHandler.sol";
import {ISignatureVerifier} from "./interfaces/ISignatureVerifier.sol";
import {IValidatorRegistry} from "./interfaces/IValidatorRegistry.sol";
import {CCTPMessage} from "./libraries/CCTPMessage.sol";

/**
 * @title MessageTransmitter
 * @notice On-chain root of trust for inbound CCTP messages and origin of
 *         outbound messages. Verifies BLS attestations via the configured
 *         `ISignatureVerifier` against the current epoch of `IValidatorRegistry`.
 *
 * Outbound flow:
 *   sendMessage(...) -> allocate nonce -> emit MessageSent(...)
 *
 * Inbound flow:
 *   receiveMessage(raw, attestation)
 *     -> decode message, check version + destDomain + replay
 *     -> split attestation = (aggSig[96], signerBitmap[...])
 *     -> registry.resolveBitmap(bitmap) -> (weight, pks)
 *     -> require weight >= threshold
 *     -> verifier.verifyAggregated(digest, pks, aggSig)
 *     -> mark nonce used, emit MessageReceived
 *     -> dispatch to IMessageHandler
 */
contract MessageTransmitter is
    Initializable,
    AccessControlEnumerableUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    IMessageTransmitter
{
    using CCTPMessage for CCTPMessage.Message;

    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint32 public override localDomain;
    uint64 public override nextNonce;

    IValidatorRegistry public registry;
    ISignatureVerifier public verifier;
    IMessageHandler public handler;

    /// @dev sourceDomain => nonce => consumed?
    mapping(uint32 => mapping(uint64 => bool)) public override usedNonces;

    uint256[45] private __gap;

    error AttestationTooShort();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address governor,
        address pauser,
        uint32 localDomain_,
        address registry_,
        address verifier_
    ) public initializer {
        __AccessControlEnumerable_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, governor);
        _grantRole(PAUSER_ROLE, pauser);

        localDomain = localDomain_;
        registry = IValidatorRegistry(registry_);
        verifier = ISignatureVerifier(verifier_);
    }

    // ---- Governance ----

    function setHandler(address newHandler) external onlyRole(GOVERNOR_ROLE) {
        address old = address(handler);
        handler = IMessageHandler(newHandler);
        emit HandlerUpdated(old, newHandler);
    }

    function setRegistry(address newRegistry) external onlyRole(GOVERNOR_ROLE) {
        registry = IValidatorRegistry(newRegistry);
    }

    function setVerifier(address newVerifier) external onlyRole(GOVERNOR_ROLE) {
        verifier = ISignatureVerifier(newVerifier);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
        emit PausedChanged(true);
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
        emit PausedChanged(false);
    }

    // ---- Send ----

    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes calldata body
    ) external whenNotPaused returns (uint64 nonce) {
        if (destinationDomain == localDomain) revert InvalidDestinationDomain();

        nonce = nextNonce++;

        CCTPMessage.Message memory m = CCTPMessage.Message({
            version: CCTPMessage.VERSION,
            sourceDomain: localDomain,
            destinationDomain: destinationDomain,
            nonce: nonce,
            sender: _addressToBytes32(msg.sender),
            recipient: recipient,
            body: body
        });

        bytes memory encoded = CCTPMessage.encode(m);

        emit MessageSent(
            localDomain,
            destinationDomain,
            nonce,
            m.sender,
            recipient,
            encoded
        );
    }

    // ---- Receive ----

    /// @dev Size of an uncompressed G2 aggregated signature.
    uint256 private constant AGG_SIG_SIZE = 256;

    function receiveMessage(bytes calldata rawMessage, bytes calldata attestation)
        external
        whenNotPaused
        returns (bool)
    {
        if (address(handler) == address(0)) revert HandlerNotSet();
        if (attestation.length < AGG_SIG_SIZE) revert AttestationTooShort();

        CCTPMessage.Message memory m = CCTPMessage.decode(rawMessage);
        CCTPMessage.requireSupportedVersion(m.version);

        if (m.destinationDomain != localDomain) revert InvalidDestinationDomain();
        if (m.sourceDomain == localDomain) revert InvalidSourceDomain();
        if (usedNonces[m.sourceDomain][m.nonce]) revert NonceAlreadyUsed();

        // Split attestation = aggSig(256 uncompressed G2) || signerBitmap(remaining)
        bytes calldata aggSig = attestation[0:AGG_SIG_SIZE];
        bytes calldata signerBitmap = attestation[AGG_SIG_SIZE:];

        (uint256 weight, bytes[] memory pks) = registry.resolveBitmap(signerBitmap);
        if (weight < registry.threshold()) revert ThresholdNotMet();

        bytes32 digest = CCTPMessage.digest(rawMessage);
        // The digest above includes the prefix since rawMessage is already
        // the encoded message; `CCTPMessage.digest` prepends the prefix before
        // hashing. See the library for details.

        bool ok = verifier.verifyAggregated(digest, pks, aggSig);
        if (!ok) revert InvalidAttestation();

        usedNonces[m.sourceDomain][m.nonce] = true;

        emit MessageReceived(m.sourceDomain, m.nonce, m.sender, m.recipient, digest);

        bool handled = handler.handleReceiveMessage(m.sourceDomain, m.sender, m.body);
        if (!handled) revert HandlerRejected();

        return true;
    }

    // ---- Internal ----

    function _addressToBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
