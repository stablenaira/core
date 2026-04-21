// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {ValidatorRegistry} from "./ValidatorRegistry.sol";
import {MessageTransmitter} from "./MessageTransmitter.sol";
import {BridgeRouter} from "./BridgeRouter.sol";
import {BLS12381Verifier} from "./verifiers/BLS12381Verifier.sol";

/**
 * @title StableNairaCCTPDeployer
 * @notice Atomic UUPS deployment helper for the CCTP suite. Mirrors the
 *         pattern used by `StableNairaUUPSDeployer`: deploys an implementation,
 *         wraps it in an ERC1967Proxy with `initialize` called in the same tx,
 *         and emits a `Deployed` event with both addresses.
 */
contract StableNairaCCTPDeployer {
    event Deployed(bytes32 indexed kind, address indexed implementation, address indexed proxy);

    bytes32 public constant KIND_REGISTRY = keccak256("ValidatorRegistry");
    bytes32 public constant KIND_TRANSMITTER = keccak256("MessageTransmitter");
    bytes32 public constant KIND_ROUTER = keccak256("BridgeRouter");
    bytes32 public constant KIND_VERIFIER = keccak256("BLS12381Verifier");

    function deployValidatorRegistry(
        address admin,
        address governor,
        uint64 timelock,
        uint256 threshold
    ) external returns (address implementation, address proxy) {
        ValidatorRegistry impl = new ValidatorRegistry();
        bytes memory data = abi.encodeCall(ValidatorRegistry.initialize, (admin, governor, timelock, threshold));
        proxy = address(new ERC1967Proxy(address(impl), data));
        implementation = address(impl);
        emit Deployed(KIND_REGISTRY, implementation, proxy);
    }

    function deployMessageTransmitter(
        address admin,
        address governor,
        address pauser,
        uint32 localDomain,
        address registry,
        address verifier
    ) external returns (address implementation, address proxy) {
        MessageTransmitter impl = new MessageTransmitter();
        bytes memory data = abi.encodeCall(
            MessageTransmitter.initialize,
            (admin, governor, pauser, localDomain, registry, verifier)
        );
        proxy = address(new ERC1967Proxy(address(impl), data));
        implementation = address(impl);
        emit Deployed(KIND_TRANSMITTER, implementation, proxy);
    }

    function deployBridgeRouter(
        address admin,
        address governor,
        address pauser,
        address token,
        address transmitter
    ) external returns (address implementation, address proxy) {
        BridgeRouter impl = new BridgeRouter();
        bytes memory data = abi.encodeCall(
            BridgeRouter.initialize,
            (admin, governor, pauser, token, transmitter)
        );
        proxy = address(new ERC1967Proxy(address(impl), data));
        implementation = address(impl);
        emit Deployed(KIND_ROUTER, implementation, proxy);
    }

    function deployVerifier(
        address admin,
        bytes calldata cofactor,
        bytes calldata dst
    ) external returns (address implementation, address proxy) {
        BLS12381Verifier impl = new BLS12381Verifier();
        bytes memory data = abi.encodeCall(BLS12381Verifier.initialize, (admin, cofactor, dst));
        proxy = address(new ERC1967Proxy(address(impl), data));
        implementation = address(impl);
        emit Deployed(KIND_VERIFIER, implementation, proxy);
    }
}
