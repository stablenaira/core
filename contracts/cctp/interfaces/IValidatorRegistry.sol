// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IValidatorRegistry
 * @notice Registry of active CCTP validators and their BLS public keys.
 *
 * Validators have:
 *  - A 48-byte compressed G1 BLS public key
 *  - A weight (uint256; unit-weighted by default, but prepared for stake-weighted)
 *  - An active flag per epoch
 *
 * The registry advances in **epochs**. Mutations (add/remove/rotate) are
 * queued and take effect only after the timelock expires. Callers that rely
 * on validator identity (notably the MessageTransmitter) read only committed
 * epoch data.
 */
interface IValidatorRegistry {
    struct Validator {
        bytes publicKey;          // 128 bytes, uncompressed G1 (x || y, each 64-byte left-padded Fp)
        uint256 weight;
        bool active;
        /**
         * EVM address holding the validator's off-chain identity key.
         * Used by the aggregator to authenticate signature submissions
         * (EIP-191 personal_sign over the submission payload). This key
         * is NOT used for any on-chain action and can be rotated quickly
         * without impacting BLS attestations.
         */
        address identityAddress;
    }

    event ValidatorQueued(uint256 indexed changeId, bytes publicKey, uint256 weight, uint64 effectiveAt);
    event ValidatorCommitted(uint256 indexed changeId, bytes publicKey, uint256 weight, address identityAddress);
    event ValidatorRemoved(bytes publicKey);
    event IdentityAddressUpdated(bytes publicKey, address oldAddress, address newAddress);
    event ThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event EpochAdvanced(uint256 indexed newEpoch, uint256 totalWeight);

    /// @notice Current epoch id. Increments whenever committed changes are applied.
    function currentEpoch() external view returns (uint256);

    /// @notice Sum of weights of all active validators in the current epoch.
    function totalWeight() external view returns (uint256);

    /// @notice Minimum aggregated signer weight required to accept a message.
    function threshold() external view returns (uint256);

    /// @notice Number of validator slots (bitmap width) in the current epoch.
    function validatorCount() external view returns (uint256);

    /// @notice Return the validator at a bitmap index in the current epoch.
    function validatorAt(uint256 index) external view returns (Validator memory);

    /// @notice True iff `publicKey` is an active validator in the current epoch.
    function isActive(bytes calldata publicKey) external view returns (bool);

    /// @notice Given a signer bitmap (1 bit per validator slot), return the
    ///         sum of signer weights and the list of selected public keys
    ///         in ascending index order. Reverts if any bit refers to an
    ///         inactive or out-of-range slot.
    function resolveBitmap(bytes calldata signerBitmap)
        external
        view
        returns (uint256 weight, bytes[] memory publicKeys);
}
