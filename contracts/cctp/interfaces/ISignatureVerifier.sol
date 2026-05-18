// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ISignatureVerifier
/// @notice Pluggable verifier interface used by `MessageTransmitter` to check
///         attestations on incoming cross-chain messages.
///
///         Implementations MUST revert with a descriptive error on any
///         failure rather than returning a boolean — the failure reason
///         propagates to the caller so off-chain tooling can diagnose.
///
///         v1 implementation: ECDSA m-of-n multisig over the validator set
///         in `ValidatorRegistry`. v2 will add an aggregated BLS12-381
///         variant behind the same interface.
interface ISignatureVerifier {
    function verify(bytes32 digest, bytes calldata attestation) external;
}
