// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BurnBody
 * @notice Standard burn body used by the BridgeRouter. Layout matches the
 *         off-chain `BurnBody` type in `cctp-network/packages/protocol`.
 *
 *   offset  size  field
 *   0       32    burnToken       (bytes32) destination token address
 *   32      32    mintRecipient   (bytes32) recipient of minted tokens
 *   64      32    amount          (uint256)
 *   96      32    messageSender   (bytes32) optional authorized-minter tag
 */
library BurnBody {
    uint256 internal constant SIZE = 128;

    error InvalidBodyLength();

    struct Body {
        bytes32 burnToken;
        bytes32 mintRecipient;
        uint256 amount;
        bytes32 messageSender;
    }

    function encode(Body memory b) internal pure returns (bytes memory) {
        return abi.encodePacked(b.burnToken, b.mintRecipient, b.amount, b.messageSender);
    }

    function decode(bytes calldata raw) internal pure returns (Body memory b) {
        if (raw.length != SIZE) revert InvalidBodyLength();
        b.burnToken = bytes32(raw[0:32]);
        b.mintRecipient = bytes32(raw[32:64]);
        b.amount = uint256(bytes32(raw[64:96]));
        b.messageSender = bytes32(raw[96:128]);
    }

    /// @notice Convert a bytes32 (left-padded EVM address) to address.
    function toAddress(bytes32 b) internal pure returns (address a) {
        a = address(uint160(uint256(b)));
    }

    /// @notice Convert an EVM address to bytes32 (left-padded with zeros).
    function toBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
