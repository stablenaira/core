import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import StableNairaModule from "./StableNaira";
import MessageTransmitterModule from "./MessageTransmitter";

/**
 * Deploy TokenMessenger behind an ERC1967 UUPS proxy. Bound at init to the
 * local MessageTransmitter (for outbound dispatch + inbound handler) and to
 * StableNaira (mint on receive, burnFrom on send). Remote-router wiring,
 * fee config, and verifier swaps all flow through the queue/commit gate
 * post-deploy.
 *
 * Parameters:
 *   - owner               address   Ownable2Step owner
 *   - initialTimelock     uint256   0 -> contract floor (1h)
 *   - initialMinTimelock  uint256   0 -> contract floor (1h)
 */
export default buildModule("TokenMessenger", (m) => {
  const { stableNaira } = m.useModule(StableNairaModule);
  const { messageTransmitter, verifier, validatorRegistry } = m.useModule(MessageTransmitterModule);

  const owner = m.getParameter<string>("owner");
  const initialTimelock = m.getParameter<bigint>("initialTimelock", 0n);
  const initialMinTimelock = m.getParameter<bigint>("initialMinTimelock", 0n);

  const impl = m.contract("TokenMessenger", [], { id: "TokenMessengerImpl" });

  const initData = m.encodeFunctionCall(impl, "initialize", [
    messageTransmitter,
    stableNaira,
    owner,
    initialTimelock,
    initialMinTimelock,
  ]);

  const proxy = m.contract("ERC1967Proxy", [impl, initData], { id: "TokenMessengerProxy" });

  const tokenMessenger = m.contractAt("TokenMessenger", proxy, { id: "TokenMessengerAt" });

  return {
    tokenMessenger,
    tokenMessengerImpl: impl,
    tokenMessengerProxy: proxy,
    messageTransmitter,
    verifier,
    validatorRegistry,
    stableNaira,
  };
});
