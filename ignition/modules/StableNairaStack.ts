import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import TokenMessengerModule from "./TokenMessenger";

/**
 * Top-level deploy module for one chain. Composes:
 *   - StableNaira (UUPS proxy + impl + factory) via StableNairaModule
 *   - ValidatorRegistry (UUPS) -> MultisigVerifier -> MessageTransmitter (UUPS)
 *   - TokenMessenger (UUPS) bound to StableNaira + MessageTransmitter
 *
 * After this module returns, the deploy script is responsible for the
 * non-static post-deploy steps:
 *   1. addMinter(tokenMessenger) on StableNaira (immediate, role grant)
 *   2. queueSetRemoteRouter for each peer chain on TokenMessenger (timelocked)
 *   3. commitSetRemoteRouter after `>= timelock` seconds
 *
 * Oracle deploy is handled out-of-band on BSC chains by `StableNairaPriceOracle.ts`.
 */
export default buildModule("StableNairaStack", (m) => {
  const stack = m.useModule(TokenMessengerModule);
  return stack;
});
