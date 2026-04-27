const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");
const CCTPVerifier = require("./CCTPVerifier");
const CCTPValidatorRegistry = require("./CCTPValidatorRegistry");

/**
 * Deploys the complete CCTP stack in dependency order:
 * verifier -> registry -> transmitter -> router, then wires handler/minter.
 */
module.exports = buildModule("CCTPFullStack", (m) => {
  const admin = m.getAccount(0);
  const governor = m.getParameter("governor", admin);
  const pauser = m.getParameter("pauser", admin);
  const localDomain = m.getParameter("localDomain", 0);
  const stableNairaAddress = m.getParameter("stableNairaAddress");

  const { verifier } = m.useModule(CCTPVerifier);
  const { registry } = m.useModule(CCTPValidatorRegistry);

  const factory = m.contract("StableNairaCCTPDeployer");

  const deployTransmitterTx = m.call(
    factory,
    "deployMessageTransmitter",
    [admin, governor, pauser, localDomain, registry, verifier],
    {
      id: "FullStack_Transmitter_Deploy",
    },
  );
  const transmitter = m.readEventArgument(deployTransmitterTx, "Deployed", "proxy", {
    emitter: factory,
    id: "FullStack_Transmitter_Proxy",
  });

  const deployRouterTx = m.call(
    factory,
    "deployBridgeRouter",
    [admin, governor, pauser, stableNairaAddress, transmitter],
    {
      id: "FullStack_Router_Deploy",
      after: [deployTransmitterTx],
    },
  );
  const router = m.readEventArgument(deployRouterTx, "Deployed", "proxy", {
    emitter: factory,
    id: "FullStack_Router_Proxy",
  });

  const transmitterAt = m.contractAt("MessageTransmitter", transmitter, {
    id: "FullStack_MessageTransmitter_At",
  });
  m.call(transmitterAt, "setHandler", [router], {
    id: "FullStack_SetHandler",
    after: [deployRouterTx],
  });

  const tokenAt = m.contractAt("StableNaira", stableNairaAddress, {
    id: "FullStack_StableNaira_At",
  });
  m.call(tokenAt, "addMinter", [router], {
    id: "FullStack_AddMinter",
    after: [deployRouterTx],
  });

  return {
    factory,
    verifier,
    registry,
    transmitter,
    router,
  };
});
