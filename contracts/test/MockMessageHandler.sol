// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IMessageHandler } from "../cctp/interfaces/IMessageHandler.sol";

/// @notice Records every call made by a MessageTransmitter to its handler.
///         Lets unit tests inspect the values the transmitter forwarded
///         without parsing raw events.
contract MockMessageHandler is IMessageHandler {
    bool public shouldReturnFalse;
    bool public shouldRevert;

    uint32 public lastSourceDomain;
    bytes32 public lastSender;
    bytes public lastBody;
    uint256 public callCount;

    function setShouldReturnFalse(bool v) external {
        shouldReturnFalse = v;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function handleReceiveMessage(
        uint32 sourceDomain,
        bytes32 sender,
        bytes calldata messageBody
    ) external override returns (bool) {
        if (shouldRevert) revert("MockHandler: forced revert");
        lastSourceDomain = sourceDomain;
        lastSender = sender;
        lastBody = messageBody;
        callCount += 1;
        return !shouldReturnFalse;
    }
}
