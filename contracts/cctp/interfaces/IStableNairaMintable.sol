// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IStableNairaMintable
 * @notice Minimal surface of StableNaira consumed by the BridgeRouter.
 *         Matches the existing `StableNaira` contract in this repo.
 */
interface IStableNairaMintable {
    function mint(address to, uint256 amount) external returns (bool);
    function burnFrom(address account, uint256 amount) external;
}
