// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ISignatureVerifier } from "../cctp/interfaces/ISignatureVerifier.sol";

/// @notice Toggle-able verifier for unit tests. Default behavior: pass.
contract MockSignatureVerifier is ISignatureVerifier {
    bool public shouldRevert;
    string public revertReason = "MockVerifier: forced revert";

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function setRevertReason(string calldata r) external {
        revertReason = r;
    }

    function verify(bytes32 /*digest*/, bytes calldata /*attestation*/) external view override {
        if (shouldRevert) revert(revertReason);
    }
}
