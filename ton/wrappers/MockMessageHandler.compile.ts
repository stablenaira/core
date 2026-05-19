import { CompilerConfig } from "@ton/blueprint";

export const compile: CompilerConfig = {
  lang: "tact",
  target: "contracts/mock_message_handler.tact",
  options: { debug: true },
};
