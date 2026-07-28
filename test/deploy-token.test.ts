import { expect } from "chai";
import { buildProxyVerificationArgs } from "../scripts/deploy-token";

describe("buildProxyVerificationArgs", function () {
  it("returns the implementation address and init data for proxy verification", function () {
    const implementationAddress = "0x1111111111111111111111111111111111111111";
    const initData = "0x1234";

    expect(
      buildProxyVerificationArgs(implementationAddress, initData),
    ).to.deep.equal([implementationAddress, initData]);
  });
});
