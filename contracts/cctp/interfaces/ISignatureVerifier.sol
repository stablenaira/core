// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ISignatureVerifier
 * @notice Abstract BLS12-381 signature verifier.
 *
 * A concrete implementation on each chain will dispatch to the fastest
 * available path (EIP-2537 precompiles where live, custom precompiles on
 * chains that provide them, or a pure-Solidity fallback).
 *
 * Key layout: min-pk (G1 public keys, G2 signatures), **uncompressed** for
 * on-chain efficiency. Decompression is performed by the attester before
 * submission to avoid expensive in-contract point decompression.
 *
 *  - publicKey:   128 bytes uncompressed G1 (x||y, each Fp left-padded to 64 bytes)
 *  - signature:   256 bytes uncompressed G2 (x||y, each Fp2 left-padded to 128 bytes)
 */
interface ISignatureVerifier {
    /**
     * @notice Verify an aggregated BLS signature produced by a set of signers
     *         over `messageDigest`. Implementations MUST aggregate the given
     *         public keys internally (G1 addition) and then perform the
     *         pairing check, so callers cannot smuggle a forged aggregated
     *         pubkey.
     *
     * @param messageDigest        32-byte keccak256 digest of the CCTP message.
     * @param publicKeys           Array of 128-byte uncompressed G1 public keys
     *                             corresponding to signers in the attestation.
     * @param aggregatedSignature  256-byte uncompressed G2 aggregated signature.
     * @return ok True iff aggregation + pairing check succeed.
     */
    function verifyAggregated(
        bytes32 messageDigest,
        bytes[] calldata publicKeys,
        bytes calldata aggregatedSignature
    ) external view returns (bool ok);
}
