import { CompilerConfig } from "@ton/blueprint";

export const compile: CompilerConfig = {
  lang: "tact",
  target: "contracts/stable_naira_jetton.tact",
  options: {
    debug: true,
  },
};
