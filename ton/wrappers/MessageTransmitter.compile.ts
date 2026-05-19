import { CompilerConfig } from "@ton/blueprint";

export const compile: CompilerConfig = {
  lang: "tact",
  target: "contracts/message_transmitter.tact",
  options: { debug: true },
};
