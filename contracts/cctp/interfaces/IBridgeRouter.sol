// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IMessageHandler} from "./IMessageHandler.sol";

/**
 * @title IBridgeRouter
 * @notice User-facing entrypoint for StableNaira cross-chain transfers.
 *
 * The router burns StableNaira on the source side, forwards a standard
 * burn body through the MessageTransmitter, and mints StableNaira on the
 * destination side after the MessageTransmitter has verified the attestation.
 */
interface IBridgeRouter is IMessageHandler {
    event DepositForBurn(
        uint64 indexed nonce,
        address indexed burnToken,
        uint256 amount,
        address indexed depositor,
        bytes32 mintRecipient,
        uint32 destinationDomain
    );

    event MintReceived(
        uint32 indexed sourceDomain,
        bytes32 indexed sender,
        address indexed recipient,
        uint256 amount
    );

    event DomainMintCapUpdated(uint32 indexed domain, uint256 rollingWindowSec, uint256 maxMint);
    event GlobalMintCapUpdated(uint256 rollingWindowSec, uint256 maxMint);

    error ZeroAmount();
    error ZeroAddress();
    error UnsupportedDestination();
    error CapExceeded();
    error UnauthorizedCaller();

    /// @notice Local StableNaira token address (the token that gets burned/minted).
    function token() external view returns (address);

    /// @notice Local MessageTransmitter address.
    function transmitter() external view returns (address);

    /**
     * @notice Burn `amount` of StableNaira and request a mint on `destinationDomain`.
     * @return nonce Source nonce allocated by the MessageTransmitter.
     */
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient
    ) external returns (uint64 nonce);
}
