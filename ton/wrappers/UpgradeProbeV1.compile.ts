import { CompilerConfig } from "@ton/blueprint";

export const compile: CompilerConfig = {
  lang: "tact",
  target: "contracts/upgrade_probe.tact",
  options: { debug: true },
};
