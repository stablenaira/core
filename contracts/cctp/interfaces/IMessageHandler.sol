// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IMessageHandler
/// @notice Implemented by any contract that wants to receive cross-chain
///         messages from a `MessageTransmitter`. The transmitter calls
///         `handleReceiveMessage` after the attestation is verified, the
///         destination domain matches, and the nonce is fresh.
///
///         Returning `false` causes the entire `receiveMessage` transaction
///         to revert — the nonce is **not** consumed and the message can be
///         retried later. Same applies if the implementation reverts.
interface IMessageHandler {
    function handleReceiveMessage(
        uint32 sourceDomain,
        bytes32 sender,
        bytes calldata messageBody
    ) external returns (bool success);
}
