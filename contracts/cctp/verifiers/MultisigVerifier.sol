// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import { ISignatureVerifier } from "../interfaces/ISignatureVerifier.sol";
import { IValidatorRegistry } from "../interfaces/IValidatorRegistry.sol";

/// @title MultisigVerifier
/// @notice ECDSA m-of-n verifier. Reads `threshold()` and `isValidator(addr)`
///         from a `ValidatorRegistry` on every call.
///
///         Attestation layout: concatenation of `threshold` 65-byte
///         `(r ‖ s ‖ v)` signatures, **sorted ascending by signer address**.
///         Sorting is a hard requirement — it lets us detect duplicates in
///         O(t) without an auxiliary set.
///
///         The OZ `ECDSA` library is used to recover signers; it enforces
///         EIP-2 (low-s) and rejects malleable signatures.
///
///         This contract is **not** upgradeable. To change verification
///         behaviour, deploy a new verifier and swap it in via
///         `MessageTransmitter.setSignatureVerifier`.
contract MultisigVerifier is ISignatureVerifier {
    /// @notice Length of a single ECDSA signature (`r ‖ s ‖ v`).
    uint256 internal constant SIG_LENGTH = 65;

    /// @notice Validator set + threshold this verifier delegates to.
    IValidatorRegistry public immutable registry;

    error ZeroRegistry();
    error InvalidAttestationLength(uint256 actual, uint256 expected);
    error SignatureRecoveryFailed(uint256 index);
    error SignerNotValidator(address signer);
    error SignersNotStrictlyAscending(address previous, address current);

    constructor(
        IValidatorRegistry registry_
    ) {
        if (address(registry_) == address(0)) revert ZeroRegistry();
        registry = registry_;
    }

    /// @inheritdoc ISignatureVerifier
    /// @dev `view` despite the interface declaring non-view — Solidity allows
    ///      a more restrictive override. Calls land via STATICCALL when the
    ///      caller knows the implementation is view (otherwise plain CALL,
    ///      which still works on a view function).
    function verify(bytes32 digest, bytes calldata attestation) external view override {
        uint256 t = registry.threshold();
        uint256 expectedLen = t * SIG_LENGTH;
        if (attestation.length != expectedLen) {
            revert InvalidAttestationLength(attestation.length, expectedLen);
        }

        address previous = address(0);
        for (uint256 i = 0; i < t; i++) {
            uint256 offset = i * SIG_LENGTH;

            bytes32 r = bytes32(attestation[offset:offset + 32]);
            bytes32 s = bytes32(attestation[offset + 32:offset + 64]);
            uint8 v = uint8(attestation[offset + 64]);

            (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, v, r, s);
            if (err != ECDSA.RecoverError.NoError || signer == address(0)) {
                revert SignatureRecoveryFailed(i);
            }
            if (signer <= previous) revert SignersNotStrictlyAscending(previous, signer);
            if (!registry.isValidator(signer)) revert SignerNotValidator(signer);

            previous = signer;
        }
    }
}
