import { CompilerConfig } from "@ton/blueprint";

export const compile: CompilerConfig = {
  lang: "tact",
  target: "contracts/multisig_verifier.tact",
  options: { debug: true },
};
