import { CompilerConfig } from "@ton/blueprint";

export const compile: CompilerConfig = {
  lang: "tact",
  target: "contracts/spike_crypto.tact",
  options: {
    debug: true,
  },
};
