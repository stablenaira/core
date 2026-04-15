const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

/**
 * Deploys StableNaira behind an ERC1967 UUPS proxy (atomic via factory).
 * Use `stableNaira` as the token address everywhere; `implementation` is logic-only.
 */
module.exports = buildModule("StableNaira", (m) => {
  const admin = m.getAccount(0);
  const factory = m.contract("StableNairaUUPSDeployer");
  const deployTx = m.call(factory, "deploy", ["StableNaira", "SNR", admin]);

  const implementation = m.readEventArgument(deployTx, "Deployed", "implementation", {
    emitter: factory,
  });
  const stableNaira = m.readEventArgument(deployTx, "Deployed", "proxy", {
    emitter: factory,
  });

  return { stableNaira, implementation, factory };
});
