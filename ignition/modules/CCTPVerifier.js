const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

/**
 * Deploys the BLS12381Verifier UUPS proxy via StableNairaCCTPDeployer.
 */
module.exports = buildModule("CCTPVerifier", (m) => {
  const admin = m.getAccount(0);
  const adminAddress = m.getParameter("admin", admin);
  const cofactor = m.getParameter("g2Cofactor");
  const dst = m.getParameter(
    "hashToCurveDst",
    "0x535441424c454e414952415f434354505f424c53313233383147325f584d443a5348412d3235365f535357555f524f5f7631",
  );

  const factory = m.contract("StableNairaCCTPDeployer");
  const deployTx = m.call(factory, "deployVerifier", [adminAddress, cofactor, dst], {
    id: "Verifier_Deploy",
  });

  const implementation = m.readEventArgument(deployTx, "Deployed", "implementation", {
    emitter: factory,
    id: "Verifier_Implementation",
  });
  const verifier = m.readEventArgument(deployTx, "Deployed", "proxy", {
    emitter: factory,
    id: "Verifier_Proxy",
  });

  return { factory, verifier, implementation };
});
