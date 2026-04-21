// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IMessageHandler
 * @notice Destination-side receiver for CCTP messages. The BridgeRouter on
 *         the destination chain implements this. Any other contract that
 *         wants to receive cross-chain messages via this CCTP network must
 *         also implement it and be registered with the MessageTransmitter.
 */
interface IMessageHandler {
    /**
     * @notice Called by the MessageTransmitter after a message has been
     *         successfully verified and replay-protected.
     * @param sourceDomain The source domain id.
     * @param sender       The sender on the source chain (bytes32).
     * @param body         Opaque body payload. Handler is responsible for
     *                     decoding and validating.
     * @return success     Must return true on success. If false or if the
     *                     call reverts, the MessageTransmitter reverts the
     *                     entire receive call and the nonce is NOT consumed.
     */
    function handleReceiveMessage(
        uint32 sourceDomain,
        bytes32 sender,
        bytes calldata body
    ) external returns (bool success);
}
