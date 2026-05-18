// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title BurnMessage
/// @notice Encode and decode the token-transfer body that travels inside an
///         envelope's `body` field. Layout (big-endian):
///
///         |   0 |  4 | version       uint32  |
///         |   4 | 32 | burnToken     bytes32 |
///         |  36 | 32 | mintRecipient bytes32 |
///         |  68 | 32 | amount        uint256 |
///         | 100 | 32 | messageSender bytes32 |
///
///         Total = 132 bytes. Spec: docs/message-format.md.
library BurnMessage {
    /// @dev Total length of an encoded burn message.
    uint256 internal constant BODY_LEN = 132;

    uint256 private constant VERSION_OFFSET = 0;
    uint256 private constant BURN_TOKEN_OFFSET = 4;
    uint256 private constant MINT_RECIPIENT_OFFSET = 36;
    uint256 private constant AMOUNT_OFFSET = 68;
    uint256 private constant MESSAGE_SENDER_OFFSET = 100;

    /// @notice Decoded view of a burn message body.
    struct BurnView {
        uint32 version;
        bytes32 burnToken;
        bytes32 mintRecipient;
        uint256 amount;
        bytes32 messageSender;
    }

    /// @notice Provided body is not exactly `BODY_LEN` bytes.
    error InvalidBurnLength(uint256 length);

    /// @notice Build a packed burn body from the individual fields.
    function format(
        uint32 version,
        bytes32 burnToken,
        bytes32 mintRecipient,
        uint256 amount,
        bytes32 messageSender
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(version, burnToken, mintRecipient, amount, messageSender);
    }

    /// @notice Decode a burn body. Reverts if the input is not exactly
    ///         `BODY_LEN` bytes — burn bodies are fixed length, no trailing data.
    function decode(
        bytes calldata body
    ) internal pure returns (BurnView memory v) {
        if (body.length != BODY_LEN) revert InvalidBurnLength(body.length);
        v.version = uint32(bytes4(body[VERSION_OFFSET:VERSION_OFFSET + 4]));
        v.burnToken = bytes32(body[BURN_TOKEN_OFFSET:BURN_TOKEN_OFFSET + 32]);
        v.mintRecipient = bytes32(body[MINT_RECIPIENT_OFFSET:MINT_RECIPIENT_OFFSET + 32]);
        v.amount = uint256(bytes32(body[AMOUNT_OFFSET:AMOUNT_OFFSET + 32]));
        v.messageSender = bytes32(body[MESSAGE_SENDER_OFFSET:MESSAGE_SENDER_OFFSET + 32]);
    }
}
