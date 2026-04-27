const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

/**
 * Deploys the StableNaira CCTP suite on this chain:
 *   BLS12381Verifier  (plain contract)
 *   ValidatorRegistry (UUPS proxy)
 *   MessageTransmitter (UUPS proxy, wired to registry + verifier)
 *   BridgeRouter (UUPS proxy, wired to token + transmitter)
 *
 * After deploy:
 *  - MessageTransmitter.setHandler(BridgeRouter)   [GOVERNOR_ROLE]
 *  - StableNaira.addMinter(BridgeRouter)           [DEFAULT_ADMIN_ROLE]
 *
 * Configure per-network values via Ignition parameters, e.g.:
 *   npx hardhat ignition deploy ignition/modules/StableNairaCCTP.js \
 *     --network testnet \
 *     --parameters '{"StableNairaCCTP":{"localDomain":0,"timelock":3600,"threshold":0,"stableNairaAddress":"0x.."}}'
 *
 * Requires `stableNairaAddress` to be set to an existing StableNaira proxy.
 */
module.exports = buildModule("StableNairaCCTP", (m) => {
  const admin = m.getAccount(0);
  const governor = m.getParameter("governor", admin);
  const pauser = m.getParameter("pauser", admin);

  const localDomain = m.getParameter("localDomain", 0);
  const timelock = m.getParameter("timelock", 3600);
  const threshold = m.getParameter("threshold", 0);

  const stableNairaAddress = m.getParameter("stableNairaAddress");

  // BLS12-381 G2 cofactor (big-endian, trimmed). 80 bytes is the canonical
  // length of h for BLS12-381 G2. This is a parameter so the verifier can
  // be redeployed with a corrected value (and upgraded in place via UUPS)
  // without touching the rest of the stack.
  //
  // Canonical value: 0x5d543a95414e7f10... (operators MUST verify against
  // RFC 9380 §8.8.2 / the BLS12-381 standard before mainnet).
  const cofactor = m.getParameter("g2Cofactor");

  // Must match `BLS_DST` in cctp-network/packages/crypto/src/bls.ts (off-chain signing).
  const dst = m.getParameter(
    "hashToCurveDst",
    "0x535441424c454e414952415f434354505f424c53313233383147325f584d443a5348412d3235365f535357555f524f5f7631",
  );

  const factory = m.contract("StableNairaCCTPDeployer");

  const deployVerifierTx = m.call(factory, "deployVerifier", [admin, cofactor, dst], {
    id: "CCTP_Verifier_Deploy",
  });
  const verifier = m.readEventArgument(deployVerifierTx, "Deployed", "proxy", {
    emitter: factory,
    id: "CCTP_Verifier_Address",
  });

  const deployRegistryTx = m.call(
    factory,
    "deployValidatorRegistry",
    [admin, governor, timelock, threshold],
    { id: "CCTP_Registry_Deploy" },
  );
  const registryProxy = m.readEventArgument(deployRegistryTx, "Deployed", "proxy", {
    emitter: factory,
    id: "CCTP_Registry_Proxy",
  });

  const deployTransmitterTx = m.call(
    factory,
    "deployMessageTransmitter",
    [admin, governor, pauser, localDomain, registryProxy, verifier],
    { id: "CCTP_Transmitter_Deploy", after: [deployRegistryTx] },
  );
  const transmitterProxy = m.readEventArgument(deployTransmitterTx, "Deployed", "proxy", {
    emitter: factory,
    id: "CCTP_Transmitter_Proxy",
  });

  const deployRouterTx = m.call(
    factory,
    "deployBridgeRouter",
    [admin, governor, pauser, stableNairaAddress, transmitterProxy],
    { id: "CCTP_Router_Deploy", after: [deployTransmitterTx] },
  );
  const routerProxy = m.readEventArgument(deployRouterTx, "Deployed", "proxy", {
    emitter: factory,
    id: "CCTP_Router_Proxy",
  });

  const transmitter = m.contractAt("MessageTransmitter", transmitterProxy, {
    id: "MessageTransmitter_At",
  });
  m.call(transmitter, "setHandler", [routerProxy], {
    id: "CCTP_Transmitter_SetHandler",
    after: [deployRouterTx],
  });

  return {
    factory,
    verifier,
    registry: registryProxy,
    transmitter: transmitterProxy,
    router: routerProxy,
  };
});
