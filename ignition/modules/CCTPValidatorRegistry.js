const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

/**
 * Deploys the ValidatorRegistry UUPS proxy via StableNairaCCTPDeployer.
 */
module.exports = buildModule("CCTPValidatorRegistry", (m) => {
  const admin = m.getAccount(0);
  const adminAddress = m.getParameter("admin", admin);
  const governor = m.getParameter("governor", admin);
  const timelock = m.getParameter("timelock", 3600);
  const threshold = m.getParameter("threshold", 0);

  const factory = m.contract("StableNairaCCTPDeployer");
  const deployTx = m.call(
    factory,
    "deployValidatorRegistry",
    [adminAddress, governor, timelock, threshold],
    {
      id: "Registry_Deploy",
    },
  );

  const implementation = m.readEventArgument(deployTx, "Deployed", "implementation", {
    emitter: factory,
    id: "Registry_Implementation",
  });
  const registry = m.readEventArgument(deployTx, "Deployed", "proxy", {
    emitter: factory,
    id: "Registry_Proxy",
  });

  return { factory, registry, implementation };
});
