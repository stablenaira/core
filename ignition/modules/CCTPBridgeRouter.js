const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

/**
 * Deploys the BridgeRouter UUPS proxy via StableNairaCCTPDeployer.
 * Expects already deployed StableNaira + MessageTransmitter addresses.
 */
module.exports = buildModule("CCTPBridgeRouter", (m) => {
  const admin = m.getAccount(0);
  const adminAddress = m.getParameter("admin", admin);
  const governor = m.getParameter("governor", admin);
  const pauser = m.getParameter("pauser", admin);

  const stableNairaAddress = m.getParameter("stableNairaAddress");
  const transmitterAddress = m.getParameter("transmitterAddress");

  const factory = m.contract("StableNairaCCTPDeployer");
  const deployTx = m.call(
    factory,
    "deployBridgeRouter",
    [adminAddress, governor, pauser, stableNairaAddress, transmitterAddress],
    {
      id: "Router_Deploy",
    },
  );

  const implementation = m.readEventArgument(deployTx, "Deployed", "implementation", {
    emitter: factory,
    id: "Router_Implementation",
  });
  const router = m.readEventArgument(deployTx, "Deployed", "proxy", {
    emitter: factory,
    id: "Router_Proxy",
  });

  return { factory, router, implementation };
});
