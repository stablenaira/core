import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Deploy ValidatorRegistry behind an ERC1967 UUPS proxy. The implementation
 * disables initializers in its constructor; the proxy ctor calls `initialize`
 * atomically with the params from the deploy template.
 *
 * Parameters (all required at module-instantiation):
 *   - validators        address[]  initial validator set (1+ entries)
 *   - threshold         uint256    must satisfy 2*threshold > validators.length
 *   - owner             address    initial Ownable2Step owner
 *   - initialTimelock   uint256    0 -> contract floor (1h)
 *   - initialMinTimelock uint256   0 -> contract floor (1h)
 */
export default buildModule("ValidatorRegistry", (m) => {
  const validators = m.getParameter<string[]>("validators");
  const threshold = m.getParameter<bigint>("threshold");
  const owner = m.getParameter<string>("owner");
  const initialTimelock = m.getParameter<bigint>("initialTimelock", 0n);
  const initialMinTimelock = m.getParameter<bigint>("initialMinTimelock", 0n);

  const impl = m.contract("ValidatorRegistry", [], { id: "ValidatorRegistryImpl" });

  const initData = m.encodeFunctionCall(impl, "initialize", [
    validators,
    threshold,
    owner,
    initialTimelock,
    initialMinTimelock,
  ]);

  const proxy = m.contract("ERC1967Proxy", [impl, initData], { id: "ValidatorRegistryProxy" });

  const validatorRegistry = m.contractAt("ValidatorRegistry", proxy, {
    id: "ValidatorRegistryAt",
  });

  return { validatorRegistry, validatorRegistryImpl: impl, validatorRegistryProxy: proxy };
});
