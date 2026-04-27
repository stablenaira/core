const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

/**
 * Deploys the MessageTransmitter UUPS proxy via StableNairaCCTPDeployer.
 * Expects already deployed registry + verifier addresses.
 */
module.exports = buildModule("CCTPMessageTransmitter", (m) => {
  const admin = m.getAccount(0);
  const adminAddress = m.getParameter("admin", admin);
  const governor = m.getParameter("governor", admin);
  const pauser = m.getParameter("pauser", admin);
  const localDomain = m.getParameter("localDomain", 0);

  const registryAddress = m.getParameter("registryAddress");
  const verifierAddress = m.getParameter("verifierAddress");

  const factory = m.contract("StableNairaCCTPDeployer");
  const deployTx = m.call(
    factory,
    "deployMessageTransmitter",
    [adminAddress, governor, pauser, localDomain, registryAddress, verifierAddress],
    {
      id: "Transmitter_Deploy",
    },
  );

  const implementation = m.readEventArgument(deployTx, "Deployed", "implementation", {
    emitter: factory,
    id: "Transmitter_Implementation",
  });
  const transmitter = m.readEventArgument(deployTx, "Deployed", "proxy", {
    emitter: factory,
    id: "Transmitter_Proxy",
  });

  return { factory, transmitter, implementation };
});
