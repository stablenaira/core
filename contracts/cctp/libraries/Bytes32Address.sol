// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Bytes32Address
/// @notice Conversions between EVM `address` (20 bytes) and the `bytes32` form
///         used in cross-chain message payloads. Non-EVM chains (Solana, Cosmos)
///         use the full 32-byte width directly.
library Bytes32Address {
    /// @notice The high 12 bytes of `value` are non-zero, so it cannot be
    ///         narrowed to a 20-byte EVM address without data loss.
    error NotEvmAddress(bytes32 value);

    /// @notice Left-pad an EVM address with zeros to produce a 32-byte value.
    function toBytes32(
        address account
    ) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }

    /// @notice Narrow a 32-byte value to an EVM address, **reverting** if the
    ///         high 12 bytes are non-zero. Use this whenever the value is
    ///         expected to refer to an EVM account.
    function toAddressChecked(
        bytes32 value
    ) internal pure returns (address) {
        if (uint256(value) >> 160 != 0) revert NotEvmAddress(value);
        return address(uint160(uint256(value)));
    }

    /// @notice Narrow a 32-byte value to an EVM address by truncation. Does
    ///         not revert. Use only when truncation is intentional (e.g.
    ///         debugging or display) — never for authority or recipient checks.
    function toAddressUnchecked(
        bytes32 value
    ) internal pure returns (address) {
        return address(uint160(uint256(value)));
    }
}
