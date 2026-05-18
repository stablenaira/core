// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ITokenMessenger
/// @notice App-layer that wraps `MessageTransmitter` for StableNaira
///         burn-and-mint cross-chain transfers. Each chain has exactly one
///         deployment with the local `MessageTransmitter` and `StableNaira`
///         addresses configured at init time.
interface ITokenMessenger {
    /* ----------------------------- events ----------------------------- */

    /// @notice Emitted on the source chain when a user initiates a transfer.
    event DepositForBurn(
        uint64 indexed nonce,
        address indexed burnToken,
        uint256 amount,
        address indexed depositor,
        bytes32 mintRecipient,
        uint32 destinationDomain,
        bytes32 destinationRouter,
        bytes32 destinationCaller
    );

    /// @notice Emitted on the destination chain when tokens are minted to
    ///         the recipient after a verified message arrives.
    event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken);

    event RemoteRouterUpdated(uint32 indexed domain, bytes32 previous, bytes32 current);
    event LocalTokenUpdated(address indexed previous, address indexed current);
    event MessageTransmitterUpdated(address indexed previous, address indexed current);
    event FeeConfigUpdated(
        uint256 previousFeeBps,
        uint256 currentFeeBps,
        address indexed previousFeeRecipient,
        address indexed currentFeeRecipient
    );

    /* ----------------------------- errors ----------------------------- */

    error OnlyMessageTransmitter(address caller);
    error UnregisteredRemoteRouter(uint32 domain);
    error InvalidRemoteSender(bytes32 expected, bytes32 actual);
    error UnsupportedBodyVersion(uint32 actual);
    error ZeroAmount();
    error ZeroMintRecipient();
    error InvalidBurnToken(address expected, address actual);
    error ZeroAddress();
    error FeeBpsTooHigh(uint256 actual, uint256 max);
    error InvalidFeeRecipient();

    /* ----------------------------- views ------------------------------ */

    function messageTransmitter() external view returns (address);
    function localToken() external view returns (address);
    function remoteRouter(
        uint32 domain
    ) external view returns (bytes32);
    function feeBps() external view returns (uint256);
    function feeRecipient() external view returns (address);
    function bodyVersion() external view returns (uint32);

    /* ----------------------------- writes ----------------------------- */

    /// @notice Burn `amount` of `burnToken` on this chain and dispatch a
    ///         cross-chain message that mints `amount - fee` to
    ///         `mintRecipient` on `destinationDomain`. Anyone can submit
    ///         the resulting attested message on the destination chain.
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken
    ) external returns (uint64 nonce);

    /// @notice Same as `depositForBurn` but pins which address may submit
    ///         the message on the destination chain.
    function depositForBurnWithCaller(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller
    ) external returns (uint64 nonce);
}
