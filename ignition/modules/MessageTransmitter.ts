import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import MultisigVerifierModule from "./MultisigVerifier";

/**
 * Deploy MessageTransmitter behind an ERC1967 UUPS proxy. The verifier is
 * supplied at init via the MultisigVerifier sub-module; later swaps go
 * through `queueSetSignatureVerifier` -> `commitSetSignatureVerifier`.
 *
 * Parameters:
 *   - localDomain          uint32   application-defined chain id (must be > 0)
 *   - maxMessageBodySize   uint256  >= 132 (BurnMessage.BODY_LEN)
 *   - owner                address  Ownable2Step owner
 *   - initialTimelock      uint256  0 -> contract floor (1h)
 *   - initialMinTimelock   uint256  0 -> contract floor (1h)
 */
export default buildModule("MessageTransmitter", (m) => {
  const { verifier, validatorRegistry } = m.useModule(MultisigVerifierModule);

  const localDomain = m.getParameter<bigint>("localDomain");
  const maxMessageBodySize = m.getParameter<bigint>("maxMessageBodySize", 4096n);
  const owner = m.getParameter<string>("owner");
  const initialTimelock = m.getParameter<bigint>("initialTimelock", 0n);
  const initialMinTimelock = m.getParameter<bigint>("initialMinTimelock", 0n);

  const impl = m.contract("MessageTransmitter", [], { id: "MessageTransmitterImpl" });

  const initData = m.encodeFunctionCall(impl, "initialize", [
    localDomain,
    verifier,
    maxMessageBodySize,
    owner,
    initialTimelock,
    initialMinTimelock,
  ]);

  const proxy = m.contract("ERC1967Proxy", [impl, initData], { id: "MessageTransmitterProxy" });

  const messageTransmitter = m.contractAt("MessageTransmitter", proxy, {
    id: "MessageTransmitterAt",
  });

  return {
    messageTransmitter,
    messageTransmitterImpl: impl,
    messageTransmitterProxy: proxy,
    verifier,
    validatorRegistry,
  };
});
