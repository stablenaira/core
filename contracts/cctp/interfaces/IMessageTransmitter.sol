// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IMessageTransmitter
 * @notice The only on-chain trust boundary for cross-chain messages in the
 *         StableNaira CCTP network. Emits outbound messages on the source
 *         side and verifies + dispatches inbound messages on the destination
 *         side.
 *
 * Threat-model highlights:
 *  - Nonces are per-source-domain and strictly monotonic.
 *  - Replay protection: (sourceDomain, nonce) consumed exactly once per chain.
 *  - Signature verification uses the current-epoch validator set from
 *    `IValidatorRegistry`.
 */
interface IMessageTransmitter {
    event MessageSent(
        uint32 indexed sourceDomain,
        uint32 indexed destinationDomain,
        uint64 indexed nonce,
        bytes32 sender,
        bytes32 recipient,
        bytes message
    );

    event MessageReceived(
        uint32 indexed sourceDomain,
        uint64 indexed nonce,
        bytes32 sender,
        bytes32 recipient,
        bytes32 messageHash
    );

    event HandlerUpdated(address indexed oldHandler, address indexed newHandler);
    event PausedChanged(bool paused);

    error InvalidDestinationDomain();
    error InvalidSourceDomain();
    error NonceAlreadyUsed();
    error InvalidAttestation();
    error ThresholdNotMet();
    error HandlerRejected();
    error HandlerNotSet();
    error NotPaused();

    /// @notice This chain's local CCTP domain id.
    function localDomain() external view returns (uint32);

    /// @notice Monotonic nonce counter for outbound messages originating here.
    function nextNonce() external view returns (uint64);

    /// @notice True if (sourceDomain, nonce) has already been consumed locally.
    function usedNonces(uint32 sourceDomain, uint64 nonce) external view returns (bool);

    /**
     * @notice Emit a cross-chain message.
     * @param destinationDomain Destination domain id.
     * @param recipient         Destination recipient (bytes32).
     * @param body              Opaque payload forwarded to the destination handler.
     * @return nonce            The newly allocated source nonce.
     */
    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes calldata body
    ) external returns (uint64 nonce);

    /**
     * @notice Verify an attestation and deliver the message to the local handler.
     * @param message     The canonical CCTP message bytes (see CCTPMessage layout).
     * @param attestation Aggregated BLS signature (96 bytes) concatenated with
     *                    the signer bitmap.
     * @return ok True if accepted and handler succeeded.
     */
    function receiveMessage(bytes calldata message, bytes calldata attestation)
        external
        returns (bool ok);
}
