// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {StableNaira} from "./StableNaira.sol";

/// @notice One-shot deploy of implementation + ERC1967 proxy with `initialize` (atomic, correct admin).
contract StableNairaUUPSDeployer {
    event Deployed(address indexed implementation, address indexed proxy);

    function deploy(
        string memory name_,
        string memory symbol_,
        address initialAdmin
    ) external returns (address implementation, address proxy) {
        StableNaira impl = new StableNaira();
        bytes memory data = abi.encodeCall(StableNaira.initialize, (name_, symbol_, initialAdmin));
        proxy = address(new ERC1967Proxy(address(impl), data));
        implementation = address(impl);
        emit Deployed(implementation, proxy);
    }
}
