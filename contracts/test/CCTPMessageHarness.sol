// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {CCTPMessage} from "../cctp/libraries/CCTPMessage.sol";

/**
 * @dev Test-only harness exposing the internal functions of `CCTPMessage`.
 *      Not intended for deployment outside Hardhat test runs.
 */
contract CCTPMessageHarness {
    function encode(CCTPMessage.Message calldata m) external pure returns (bytes memory) {
        // Struct is in calldata; copy into memory for the library call.
        CCTPMessage.Message memory mem = CCTPMessage.Message({
            version: m.version,
            sourceDomain: m.sourceDomain,
            destinationDomain: m.destinationDomain,
            nonce: m.nonce,
            sender: m.sender,
            recipient: m.recipient,
            body: m.body
        });
        return CCTPMessage.encode(mem);
    }

    function decode(bytes calldata raw) external pure returns (CCTPMessage.Message memory) {
        return CCTPMessage.decode(raw);
    }

    function digest(bytes calldata encoded) external pure returns (bytes32) {
        return CCTPMessage.digest(encoded);
    }

    function hashOf(CCTPMessage.Message calldata m) external pure returns (bytes32) {
        CCTPMessage.Message memory mem = CCTPMessage.Message({
            version: m.version,
            sourceDomain: m.sourceDomain,
            destinationDomain: m.destinationDomain,
            nonce: m.nonce,
            sender: m.sender,
            recipient: m.recipient,
            body: m.body
        });
        return CCTPMessage.hash(mem);
    }

    function version() external pure returns (uint32) {
        return CCTPMessage.VERSION;
    }
}
