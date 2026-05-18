import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import ValidatorRegistryModule from "./ValidatorRegistry";

/**
 * Non-upgradeable ECDSA m-of-n verifier. Reads `threshold()` and
 * `isValidator(addr)` from the supplied ValidatorRegistry on every call.
 * Swap by deploying a new verifier and queuing
 * `MessageTransmitter.queueSetSignatureVerifier`.
 */
export default buildModule("MultisigVerifier", (m) => {
  const { validatorRegistry } = m.useModule(ValidatorRegistryModule);

  const verifier = m.contract("MultisigVerifier", [validatorRegistry], {
    id: "MultisigVerifier",
  });

  return { verifier, validatorRegistry };
});
