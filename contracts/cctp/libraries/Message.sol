// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Message
/// @notice Encode and decode the cross-chain envelope. Layout (big-endian):
///
///         |   0 |  4 | version           uint32  |
///         |   4 |  4 | sourceDomain      uint32  |
///         |   8 |  4 | destinationDomain uint32  |
///         |  12 |  8 | nonce             uint64  |
///         |  20 | 32 | sender            bytes32 |
///         |  52 | 32 | recipient         bytes32 |
///         |  84 | 32 | destinationCaller bytes32 |
///         | 116 |  N | body              bytes   |
///
///         Total fixed prefix = 116 bytes. Spec: docs/message-format.md.
library Message {
    /// @dev Length of the fixed-size envelope header. The total message length
    ///      is `HEADER_LEN + body.length`.
    uint256 internal constant HEADER_LEN = 116;

    uint256 private constant VERSION_OFFSET = 0;
    uint256 private constant SOURCE_DOMAIN_OFFSET = 4;
    uint256 private constant DEST_DOMAIN_OFFSET = 8;
    uint256 private constant NONCE_OFFSET = 12;
    uint256 private constant SENDER_OFFSET = 20;
    uint256 private constant RECIPIENT_OFFSET = 52;
    uint256 private constant DEST_CALLER_OFFSET = 84;
    uint256 private constant BODY_OFFSET = 116;

    /// @notice Decoded view of an envelope. `body` is a memory copy of the
    ///         calldata slice; for hot paths use `bodySlice`.
    struct EnvelopeView {
        uint32 version;
        uint32 sourceDomain;
        uint32 destinationDomain;
        uint64 nonce;
        bytes32 sender;
        bytes32 recipient;
        bytes32 destinationCaller;
        bytes body;
    }

    /// @notice The provided message is shorter than the fixed envelope header.
    error MessageTooShort(uint256 length);

    /// @notice Build a packed envelope from the individual fields.
    function format(
        uint32 version,
        uint32 sourceDomain,
        uint32 destinationDomain,
        uint64 nonce,
        bytes32 sender,
        bytes32 recipient,
        bytes32 destinationCaller,
        bytes memory body
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            version, sourceDomain, destinationDomain, nonce, sender, recipient, destinationCaller, body
        );
    }

    /// @notice Decode every field of the envelope into a struct. Reverts if
    ///         the input is shorter than the header.
    function decode(
        bytes calldata message
    ) internal pure returns (EnvelopeView memory v) {
        if (message.length < HEADER_LEN) revert MessageTooShort(message.length);
        v.version = uint32(bytes4(message[VERSION_OFFSET:VERSION_OFFSET + 4]));
        v.sourceDomain = uint32(bytes4(message[SOURCE_DOMAIN_OFFSET:SOURCE_DOMAIN_OFFSET + 4]));
        v.destinationDomain = uint32(bytes4(message[DEST_DOMAIN_OFFSET:DEST_DOMAIN_OFFSET + 4]));
        v.nonce = uint64(bytes8(message[NONCE_OFFSET:NONCE_OFFSET + 8]));
        v.sender = bytes32(message[SENDER_OFFSET:SENDER_OFFSET + 32]);
        v.recipient = bytes32(message[RECIPIENT_OFFSET:RECIPIENT_OFFSET + 32]);
        v.destinationCaller = bytes32(message[DEST_CALLER_OFFSET:DEST_CALLER_OFFSET + 32]);
        v.body = message[BODY_OFFSET:];
    }

    /// @notice Return the body as a calldata slice without copying. Reverts if
    ///         the input is shorter than the header.
    function bodySlice(
        bytes calldata message
    ) internal pure returns (bytes calldata) {
        if (message.length < HEADER_LEN) revert MessageTooShort(message.length);
        return message[BODY_OFFSET:];
    }

    /// @notice Raw envelope digest. Kept for backward compatibility / debugging.
    ///         Attestation signing should use `attestationDigest` instead.
    function digest(
        bytes calldata message
    ) internal pure returns (bytes32) {
        return keccak256(message);
    }

    /// @dev EIP-712-style domain typehash for cross-chain attestation digests.
    ///      The encoded fields commit attestations to a specific chain and
    ///      transmitter, preventing cross-protocol or cross-deployment replay
    ///      even if a validator key is reused elsewhere.
    bytes32 internal constant ATTESTATION_DOMAIN_TYPEHASH = keccak256(
        "StableNairaCCTPAttestation(bytes32 envelopeHash,uint256 chainId,address transmitter)"
    );

    /// @notice Domain-separated digest that attesters sign. Off-chain
    ///         attesters MUST compute the same value:
    ///         `keccak256(abi.encode(TYPEHASH, keccak256(envelope), chainId, transmitter))`.
    function attestationDigest(
        bytes calldata message,
        uint256 chainId,
        address transmitter
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(ATTESTATION_DOMAIN_TYPEHASH, keccak256(message), chainId, transmitter)
        );
    }
}
