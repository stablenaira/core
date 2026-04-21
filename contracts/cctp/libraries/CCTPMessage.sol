// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CCTPMessage
 * @notice Binary message format + digest for the StableNaira CCTP protocol.
 *
 * Binary layout (big-endian), matches the off-chain encoder in
 * `cctp-network/packages/protocol/src/hash.ts`:
 *
 *   offset  size  field
 *   0       4     version            (uint32)
 *   4       4     sourceDomain       (uint32)
 *   8       4     destinationDomain  (uint32)
 *   12      8     nonce              (uint64)
 *   20      32    sender             (bytes32)
 *   52      32    recipient          (bytes32)
 *   84      4     bodyLength         (uint32)
 *   88      N     body               (bytes)
 *
 * Digest: keccak256( MESSAGE_HASH_PREFIX || encode(m) )
 * where MESSAGE_HASH_PREFIX = "StableNairaCCTP:v1".
 */
library CCTPMessage {
    /// Minimum message size when body is empty.
    uint256 internal constant HEADER_SIZE = 88;

    /// Protocol version supported by this deployment.
    uint32 internal constant VERSION = 1;

    /// Domain-separation prefix mixed into the digest.
    bytes internal constant HASH_PREFIX = bytes("StableNairaCCTP:v1");

    error InvalidMessageLength();
    error UnsupportedVersion(uint32 got, uint32 expected);

    struct Message {
        uint32 version;
        uint32 sourceDomain;
        uint32 destinationDomain;
        uint64 nonce;
        bytes32 sender;
        bytes32 recipient;
        bytes body;
    }

    function encode(Message memory m) internal pure returns (bytes memory out) {
        out = abi.encodePacked(
            m.version,
            m.sourceDomain,
            m.destinationDomain,
            m.nonce,
            m.sender,
            m.recipient,
            uint32(m.body.length),
            m.body
        );
    }

    function decode(bytes calldata raw) internal pure returns (Message memory m) {
        if (raw.length < HEADER_SIZE) revert InvalidMessageLength();

        m.version = uint32(bytes4(raw[0:4]));
        m.sourceDomain = uint32(bytes4(raw[4:8]));
        m.destinationDomain = uint32(bytes4(raw[8:12]));
        m.nonce = uint64(bytes8(raw[12:20]));
        m.sender = bytes32(raw[20:52]);
        m.recipient = bytes32(raw[52:84]);

        uint32 bodyLen = uint32(bytes4(raw[84:88]));
        if (raw.length != HEADER_SIZE + bodyLen) revert InvalidMessageLength();
        m.body = raw[88:88 + bodyLen];
    }

    /// @notice Compute the digest signed by attesters.
    function digest(bytes memory encoded) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(HASH_PREFIX, encoded));
    }

    /// @notice Convenience: hash directly from a Message struct.
    function hash(Message memory m) internal pure returns (bytes32) {
        return digest(encode(m));
    }

    function requireSupportedVersion(uint32 version) internal pure {
        if (version != VERSION) revert UnsupportedVersion(version, VERSION);
    }
}
