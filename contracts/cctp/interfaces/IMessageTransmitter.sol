// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IMessageTransmitter
/// @notice Generic cross-chain message envelope: send on the source chain,
///         receive on the destination chain after an attestation is verified.
///         App contracts (e.g. `TokenMessenger`) build on top of this.
interface IMessageTransmitter {
    /* ----------------------------- events ----------------------------- */

    /// @notice Emitted on the source chain whenever a message is dispatched.
    ///         The full encoded envelope is included so attesters and
    ///         relayers can reconstruct it without an RPC round-trip.
    event MessageSent(bytes message);

    /// @notice Emitted on the destination chain after a message is verified
    ///         and successfully handed off to the recipient handler.
    event MessageReceived(
        address indexed caller, uint32 indexed sourceDomain, uint64 indexed nonce, bytes32 sender, bytes messageBody
    );

    event SignatureVerifierUpdated(address indexed previous, address indexed current);
    event MaxMessageBodySizeUpdated(uint256 previous, uint256 current);

    /* ----------------------------- errors ----------------------------- */

    error InvalidVersion(uint32 expected, uint32 actual);
    error InvalidDestinationDomain(uint32 expected, uint32 actual);
    error UnauthorizedCaller(bytes32 expectedCaller, address actualCaller);
    error NonceAlreadyUsed(uint32 sourceDomain, uint64 nonce);
    error MessageBodyTooLarge(uint256 size, uint256 max);
    error RecipientHandlerFailed();
    error InvalidVerifier();
    error InvalidLocalDomain();
    error LocalDestinationNotAllowed();

    /* ----------------------------- views ------------------------------ */

    function localDomain() external view returns (uint32);
    function version() external view returns (uint32);
    function nextAvailableNonce() external view returns (uint64);
    function isNonceUsed(uint32 sourceDomain, uint64 nonce) external view returns (bool);
    function signatureVerifier() external view returns (address);
    function maxMessageBodySize() external view returns (uint256);

    /* ----------------------------- writes ----------------------------- */

    /// @notice Send a message to `destinationDomain`. Anyone can call;
    ///         `msg.sender` is recorded as the envelope `sender`. The returned
    ///         `nonce` is monotonic per the local domain.
    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes calldata messageBody
    ) external returns (uint64 nonce);

    /// @notice Send a message that can only be `receiveMessage`-d by
    ///         `destinationCaller` on the destination chain.
    function sendMessageWithCaller(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32 destinationCaller,
        bytes calldata messageBody
    ) external returns (uint64 nonce);

    /// @notice Receive an attested message and dispatch to its recipient.
    ///         Permissionless — anyone with `(message, attestation)` can call.
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool success);
}
