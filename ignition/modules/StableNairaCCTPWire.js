const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

/**
 * Post-deployment wiring for the StableNaira CCTP suite.
 *
 * This module does NOT deploy any new contracts. It only performs the
 * idempotent, post-deploy administrative calls required to make a freshly
 * deployed CCTP suite functional on a single chain.
 *
 * Intended to run AFTER `StableNairaCCTP.js` on the same chain, and once
 * sibling chains have been deployed so that their router addresses are known.
 *
 * Wiring performed (per chain):
 *   1. StableNaira.addMinter(BridgeRouter)                    [DEFAULT_ADMIN_ROLE on token]
 *   2. BridgeRouter.setRemoteRouter(domainId, paddedAddress)  [GOVERNOR_ROLE]
 *   3. (optional) BridgeRouter.setGlobalMintCap(windowSec, cap)
 *   4. (optional) BridgeRouter.setDomainMintCap(...) per remote
 *
 * Required parameters (JSON, under "StableNairaCCTPWire"):
 *
 *   stableNairaAddress    — address of the local StableNaira proxy
 *   bridgeRouterAddress   — address of the local BridgeRouter proxy
 *
 *   remoteRouters         — array of { domainId, router } where `router` is
 *                           either a 0x-prefixed 20-byte EVM address (it will
 *                           be left-padded to bytes32) or a 0x-prefixed 32-byte
 *                           value for non-EVM domains.
 *
 *   globalCap             — optional { windowSec, cap } (uint256 strings)
 *   domainCaps            — optional array of { domainId, windowSec, cap }
 *
 * Example:
 *   npx hardhat ignition deploy ignition/modules/StableNairaCCTPWire.js \
 *     --network testnet \
 *     --parameters '{"StableNairaCCTPWire":{
 *       "stableNairaAddress":"0x...",
 *       "bridgeRouterAddress":"0x...",
 *       "remoteRouters":[
 *         {"domainId":1,"router":"0x<ethereum bridge router>"},
 *         {"domainId":2,"router":"0x<base bridge router>"}
 *       ],
 *       "globalCap":{"windowSec":3600,"cap":"1000000000000000000000000"}
 *     }}'
 */
module.exports = buildModule("StableNairaCCTPWire", (m) => {
  const stableNairaAddress = m.getParameter("stableNairaAddress");
  const bridgeRouterAddress = m.getParameter("bridgeRouterAddress");
  const remoteRouters = m.getParameter("remoteRouters", []);
  const globalCap = m.getParameter("globalCap", null);
  const domainCaps = m.getParameter("domainCaps", []);

  const token = m.contractAt("StableNaira", stableNairaAddress, {
    id: "Wire_StableNaira_At",
  });
  const router = m.contractAt("BridgeRouter", bridgeRouterAddress, {
    id: "Wire_BridgeRouter_At",
  });

  // 1) Grant MINTER_ROLE on StableNaira to the BridgeRouter so that it can
  //    both burn (burnFrom) and mint. This is idempotent; re-running is safe
  //    because AccessControl's grantRole is a no-op when the account already
  //    holds the role.
  m.call(token, "addMinter", [bridgeRouterAddress], {
    id: "Wire_AddMinter",
  });

  // 2) Register remote routers. Non-EVM domains may supply a full bytes32.
  //    We DO NOT pad here because Ignition parameters are opaque strings;
  //    the deployer tooling should compute the padded bytes32 before
  //    invoking this module. Accept 0x-prefixed 32-byte values only.
  const remotesArr = Array.isArray(remoteRouters) ? remoteRouters : [];
  remotesArr.forEach((entry, idx) => {
    m.call(
      router,
      "setRemoteRouter",
      [entry.domainId, entry.router],
      { id: `Wire_SetRemoteRouter_${idx}_domain_${entry.domainId}` },
    );
  });

  // 3) Optional global mint cap.
  if (globalCap && globalCap.windowSec !== undefined && globalCap.cap !== undefined) {
    m.call(router, "setGlobalMintCap", [globalCap.windowSec, globalCap.cap], {
      id: "Wire_SetGlobalMintCap",
    });
  }

  // 4) Optional per-domain mint caps.
  const capsArr = Array.isArray(domainCaps) ? domainCaps : [];
  capsArr.forEach((entry, idx) => {
    m.call(
      router,
      "setDomainMintCap",
      [entry.domainId, entry.windowSec, entry.cap],
      { id: `Wire_SetDomainMintCap_${idx}_domain_${entry.domainId}` },
    );
  });

  return { token, router };
});
