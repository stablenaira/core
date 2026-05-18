import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { Wallet } from "ethers";

const ZERO = "0x0000000000000000000000000000000000000000";

describe("StableNairaPriceOracle", () => {
  // Reporters are explicit Wallet instances so we can sign and order by address deterministically.
  const r1 = new Wallet(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  );
  const r2 = new Wallet(
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
  );
  const r3 = new Wallet(
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
  );
  const stranger = new Wallet(
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
  );

  async function fixture() {
    const [owner, other] = await ethers.getSigners();
    const Oracle = await ethers.getContractFactory("StableNairaPriceOracle");
    const oracle = (await Oracle.deploy(8, [r1.address, r2.address, r3.address], 2)) as any;
    await oracle.waitForDeployment();
    return { oracle, owner, other };
  }

  async function signRound(
    wallet: Wallet,
    oracleAddr: string,
    chainId: bigint,
    roundId: bigint,
    price: bigint,
    timestamp: bigint
  ): Promise<string> {
    const reportHash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "uint256", "uint256", "uint256"],
      [chainId, oracleAddr, roundId, price, timestamp]
    );
    return wallet.signMessage(ethers.getBytes(reportHash));
  }

  function sortByAddress(sigs: { wallet: Wallet; sig: string }[]) {
    return [...sigs]
      .sort((a, b) => a.wallet.address.toLowerCase().localeCompare(b.wallet.address.toLowerCase()))
      .map((s) => s.sig);
  }

  describe("constructor", () => {
    it("seeds reporter set, decimals, quorum and emits events", async () => {
      const { oracle } = await loadFixture(fixture);
      expect(await oracle.decimals()).to.equal(8);
      expect(await oracle.quorum()).to.equal(2n);
      expect(await oracle.activeReporterCount()).to.equal(3n);
      expect(await oracle.maxStalenessSec()).to.equal(900n);
      expect(await oracle.maxDeviationPPB()).to.equal(20_000_000n);
      expect(await oracle.isReporter(r1.address)).to.equal(true);
      expect((await oracle.getReporters()).length).to.equal(3);
    });

    it("rejects zero quorum, zero reporter, quorum > active", async () => {
      const Oracle = await ethers.getContractFactory("StableNairaPriceOracle");
      await expect(Oracle.deploy(8, [r1.address], 0)).to.be.revertedWithCustomError(
        Oracle,
        "InvalidQuorum"
      );
      await expect(Oracle.deploy(8, [ZERO], 1)).to.be.revertedWithCustomError(Oracle, "ZeroReporter");
      await expect(Oracle.deploy(8, [r1.address], 5)).to.be.revertedWithCustomError(
        Oracle,
        "QuorumExceedsActive"
      );
    });
  });

  describe("submitReport", () => {
    it("accepts a quorum of correctly-ordered sigs and updates round", async () => {
      const { oracle } = await loadFixture(fixture);
      const oracleAddr = await oracle.getAddress();
      const network = await ethers.provider.getNetwork();
      const ts = BigInt(await time.latest());
      const sigs = sortByAddress([
        { wallet: r1, sig: await signRound(r1, oracleAddr, network.chainId, 1n, 1500_00000000n, ts) },
        { wallet: r2, sig: await signRound(r2, oracleAddr, network.chainId, 1n, 1500_00000000n, ts) },
      ]);
      await expect(oracle.submitReport(1n, 1500_00000000n, ts, sigs))
        .to.emit(oracle, "PriceSubmitted");
      const [price, ts2, roundId] = await oracle.getLatestPrice();
      expect(price).to.equal(1500_00000000n);
      expect(ts2).to.equal(ts);
      expect(roundId).to.equal(1n);
    });

    it("rejects under-quorum signatures", async () => {
      const { oracle } = await loadFixture(fixture);
      const oracleAddr = await oracle.getAddress();
      const network = await ethers.provider.getNetwork();
      const ts = BigInt(await time.latest());
      const sigs = [await signRound(r1, oracleAddr, network.chainId, 1n, 1n, ts)];
      await expect(oracle.submitReport(1n, 1n, ts, sigs)).to.be.revertedWithCustomError(
        oracle,
        "NotEnoughSigs"
      );
    });

    it("rejects unsorted sigs", async () => {
      const { oracle } = await loadFixture(fixture);
      const oracleAddr = await oracle.getAddress();
      const network = await ethers.provider.getNetwork();
      const ts = BigInt(await time.latest());
      const sigs = sortByAddress([
        { wallet: r1, sig: await signRound(r1, oracleAddr, network.chainId, 1n, 1n, ts) },
        { wallet: r2, sig: await signRound(r2, oracleAddr, network.chainId, 1n, 1n, ts) },
      ]);
      // Reverse to break ascending order.
      const reversed = [sigs[1], sigs[0]];
      await expect(oracle.submitReport(1n, 1n, ts, reversed)).to.be.revertedWithCustomError(
        oracle,
        "UnorderedSigs"
      );
    });

    it("rejects a sig from non-reporter", async () => {
      const { oracle } = await loadFixture(fixture);
      const oracleAddr = await oracle.getAddress();
      const network = await ethers.provider.getNetwork();
      const ts = BigInt(await time.latest());
      const sigs = sortByAddress([
        { wallet: r1, sig: await signRound(r1, oracleAddr, network.chainId, 1n, 1n, ts) },
        { wallet: stranger, sig: await signRound(stranger, oracleAddr, network.chainId, 1n, 1n, ts) },
      ]);
      await expect(oracle.submitReport(1n, 1n, ts, sigs)).to.be.revertedWithCustomError(
        oracle,
        "NotReporter"
      );
    });

    it("rejects stale or future timestamps", async () => {
      const { oracle } = await loadFixture(fixture);
      const oracleAddr = await oracle.getAddress();
      const network = await ethers.provider.getNetwork();
      const now = BigInt(await time.latest());

      // Future
      const tsFuture = now + 1000n;
      let sigs = sortByAddress([
        { wallet: r1, sig: await signRound(r1, oracleAddr, network.chainId, 1n, 1n, tsFuture) },
        { wallet: r2, sig: await signRound(r2, oracleAddr, network.chainId, 1n, 1n, tsFuture) },
      ]);
      await expect(oracle.submitReport(1n, 1n, tsFuture, sigs)).to.be.revertedWithCustomError(
        oracle,
        "StaleOrFuture"
      );

      // Stale (older than maxStalenessSec=900)
      const tsStale = now - 1000n;
      sigs = sortByAddress([
        { wallet: r1, sig: await signRound(r1, oracleAddr, network.chainId, 1n, 1n, tsStale) },
        { wallet: r2, sig: await signRound(r2, oracleAddr, network.chainId, 1n, 1n, tsStale) },
      ]);
      await expect(oracle.submitReport(1n, 1n, tsStale, sigs)).to.be.revertedWithCustomError(
        oracle,
        "StaleOrFuture"
      );
    });

    it("rejects deviation > maxDeviationPPB", async () => {
      const { oracle } = await loadFixture(fixture);
      const oracleAddr = await oracle.getAddress();
      const network = await ethers.provider.getNetwork();
      const ts = BigInt(await time.latest());
      // First report at price 1000.
      let sigs = sortByAddress([
        { wallet: r1, sig: await signRound(r1, oracleAddr, network.chainId, 1n, 1000n, ts) },
        { wallet: r2, sig: await signRound(r2, oracleAddr, network.chainId, 1n, 1000n, ts) },
      ]);
      await oracle.submitReport(1n, 1000n, ts, sigs);

      // Second report at 1500 (50% jump > 2% default cap).
      const ts2 = ts + 1n;
      sigs = sortByAddress([
        { wallet: r1, sig: await signRound(r1, oracleAddr, network.chainId, 2n, 1500n, ts2) },
        { wallet: r2, sig: await signRound(r2, oracleAddr, network.chainId, 2n, 1500n, ts2) },
      ]);
      await expect(oracle.submitReport(2n, 1500n, ts2, sigs)).to.be.revertedWithCustomError(
        oracle,
        "DeviationTooLarge"
      );
    });

    it("rejects roundId not strictly greater than latest", async () => {
      const { oracle } = await loadFixture(fixture);
      const oracleAddr = await oracle.getAddress();
      const network = await ethers.provider.getNetwork();
      const ts = BigInt(await time.latest());
      let sigs = sortByAddress([
        { wallet: r1, sig: await signRound(r1, oracleAddr, network.chainId, 5n, 1000n, ts) },
        { wallet: r2, sig: await signRound(r2, oracleAddr, network.chainId, 5n, 1000n, ts) },
      ]);
      await oracle.submitReport(5n, 1000n, ts, sigs);
      sigs = sortByAddress([
        { wallet: r1, sig: await signRound(r1, oracleAddr, network.chainId, 5n, 1000n, ts) },
        { wallet: r2, sig: await signRound(r2, oracleAddr, network.chainId, 5n, 1000n, ts) },
      ]);
      await expect(oracle.submitReport(5n, 1000n, ts, sigs)).to.be.revertedWithCustomError(
        oracle,
        "RoundOrder"
      );
    });

    it("rejects price 0", async () => {
      const { oracle } = await loadFixture(fixture);
      await expect(oracle.submitReport(1n, 0n, 1n, [])).to.be.revertedWithCustomError(
        oracle,
        "PriceZero"
      );
    });
  });

  describe("reporter management (Ownable2Step)", () => {
    it("addReporter / removeReporter / setQuorum gated to owner", async () => {
      const { oracle, owner, other } = await loadFixture(fixture);
      await expect(oracle.connect(other).addReporter(stranger.address)).to.be.revertedWithCustomError(
        oracle,
        "OwnableUnauthorizedAccount"
      );
      await oracle.connect(owner).addReporter(stranger.address);
      expect(await oracle.activeReporterCount()).to.equal(4n);

      await oracle.connect(owner).setQuorum(3n);
      expect(await oracle.quorum()).to.equal(3n);

      await expect(oracle.connect(owner).removeReporter(r1.address)).to.not.be.reverted;
      expect(await oracle.activeReporterCount()).to.equal(3n);
    });

    it("removeReporter blocked when it would drop below quorum", async () => {
      const { oracle, owner } = await loadFixture(fixture);
      // count=3, quorum=2. Drop to count=2, quorum=2 -> ok.
      await oracle.connect(owner).removeReporter(r1.address);
      // Drop to count=1, quorum=2 -> blocked.
      await expect(
        oracle.connect(owner).removeReporter(r2.address)
      ).to.be.revertedWithCustomError(oracle, "WouldDropBelowQuorum");
    });

    it("setMaxStaleness / setMaxDeviationPPB respect bounds", async () => {
      const { oracle, owner } = await loadFixture(fixture);
      await expect(
        oracle.connect(owner).setMaxStaleness(10n)
      ).to.be.revertedWithCustomError(oracle, "StalenessOutOfRange");
      await expect(
        oracle.connect(owner).setMaxStaleness(60 * 60 * 24)
      ).to.be.revertedWithCustomError(oracle, "StalenessOutOfRange");
      await oracle.connect(owner).setMaxStaleness(120);
      expect(await oracle.maxStalenessSec()).to.equal(120n);

      await expect(
        oracle.connect(owner).setMaxDeviationPPB(100n)
      ).to.be.revertedWithCustomError(oracle, "DeviationOutOfRange");
      await oracle.connect(owner).setMaxDeviationPPB(50_000_000n);
      expect(await oracle.maxDeviationPPB()).to.equal(50_000_000n);
    });
  });
});
