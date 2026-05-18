import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Deploys StableNaira behind an ERC1967 UUPS proxy via the on-chain factory
 * `StableNairaUUPSDeployer`. Atomic: implementation + proxy + initialize land
 * in one tx, so the proxy admin is always exactly the supplied `admin`.
 *
 * Use the `stableNaira` (proxy) address everywhere user-facing.
 *
 * Parameters:
 *   - tokenName    string   ERC20 name
 *   - tokenSymbol  string   ERC20 symbol
 *   - admin        address  initial DEFAULT_ADMIN_ROLE / MINTER_ROLE / etc.
 */
export default buildModule("StableNaira", (m) => {
  const tokenName = m.getParameter<string>("tokenName", "StableNaira");
  const tokenSymbol = m.getParameter<string>("tokenSymbol", "SNR");
  const admin = m.getParameter<string>("admin");

  const factory = m.contract("StableNairaUUPSDeployer", [], { id: "StableNairaDeployer" });
  const deployTx = m.call(factory, "deploy", [tokenName, tokenSymbol, admin]);

  const implementationAddress = m.readEventArgument(deployTx, "Deployed", "implementation", {
    emitter: factory,
  });
  const proxyAddress = m.readEventArgument(deployTx, "Deployed", "proxy", {
    emitter: factory,
  });

  const implementation = m.contractAt("StableNaira", implementationAddress, {
    id: "StableNairaImplementation",
  });
  const stableNaira = m.contractAt("StableNaira", proxyAddress, {
    id: "StableNairaProxy",
  });

  return { stableNaira, implementation, factory };
});
