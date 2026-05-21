// One-shot initialization of the StableNaira Solana mainnet stack.
//
// Idempotent: each step checks whether the target PDA already exists before
// submitting. Re-running picks up wherever the last attempt stopped.
//
// Usage (after `solana config set --url <mainnet RPC>` and `bun install` here):
//   bun init-mainnet.ts            # do everything that isn't done yet
//   bun init-mainnet.ts --dry      # print plan, no broadcasts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, sendAndConfirmTransaction,
  Transaction, TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const SOLANA_ROOT = path.resolve(__dirname, "..");
const CORE_ROOT   = path.resolve(__dirname, "..", "..");

// --- chosen mainnet identity (PERMANENT) ----------------------------------
const PROGRAM_IDS = {
  crypto_parity:       new PublicKey("77dv5m4NUhEDX768Kt1bgkAu34nxaZ51sPhNzN6hamik"),
  message_transmitter: new PublicKey("6DV1hTBVf6Ks9mguQiVY82B5uGPQS2nHddzgL3GhFaWe"),
  stable_naira:        new PublicKey("7EXTBay4r4Ft3k5poXnhxMCQXe5s5yv2kfxMiA7babYD"),
  token_messenger:     new PublicKey("AcKeZENGFRMxm3rtQg3chAiwf24d992Ljj574i937jjv"),
  validator_registry:  new PublicKey("GGMoxtodCLEvPB3HuDJcS3kcS6JVpmfBQEHYfoUPe7kR"),
} as const;
const LOCAL_DOMAIN = 101;
const MAX_BODY_SIZE = 4096n;
const MINT_CAP = 0n; // 0 = uncapped, matches EVM
const FEE_BPS = 0;
const VALIDATOR_EVM = "0x2503Cba0edfEe3F790D14bA141b92B11816EC987";
const THRESHOLD = 1;
const ROLE_MINTER = 0;

// chain_id = the 32-byte message_transmitter program id as raw bytes.
// transmitter = last 20 bytes of keccak256(program_id_bytes).
// Both deterministic from the public on-chain artifact.
function deriveIdentity() {
  const programIdBytes = PROGRAM_IDS.message_transmitter.toBytes(); // 32 bytes
  const chainId = Buffer.from(programIdBytes);                       // [u8; 32]
  // keccak256 via web3.js? No — use built-in node:crypto sha3 if available.
  // anchor ships js-sha3 indirectly; simplest: use SHA-256 fallback? No — must
  // match EVM keccak256. Use the @noble/hashes/keccak256 that anchor pulls in.
  const { keccak_256 } = require("@noble/hashes/sha3");
  const h = keccak_256(programIdBytes);
  const transmitter = Buffer.from(h.slice(h.length - 20));            // [u8; 20]
  return { chainId, transmitter };
}

// --- argv ------------------------------------------------------------------
const DRY = process.argv.includes("--dry");

// --- setup -----------------------------------------------------------------
const cliConfig = path.join(os.homedir(), ".config/solana/cli/config.yml");
function readSolanaConfig(): { rpc: string; keypair: string } {
  const raw = fs.readFileSync(cliConfig, "utf8");
  const rpc = raw.match(/^json_rpc_url:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  const keypair = raw.match(/^keypair_path:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  if (!rpc || !keypair) throw new Error("Could not parse ~/.config/solana/cli/config.yml");
  return { rpc, keypair: keypair.replace(/^~/, os.homedir()) };
}
const { rpc, keypair: keypairPath } = readSolanaConfig();
if (!/mainnet/i.test(rpc)) {
  console.error(`SAFETY: configured RPC does not look like mainnet (${rpc}).`);
  console.error("Run `solana config set --url <mainnet RPC>` and retry.");
  process.exit(1);
}
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))));
const connection = new Connection(rpc, "confirmed");
const wallet = new anchor.Wallet(deployer);
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
anchor.setProvider(provider);

function loadIdl(name: keyof typeof PROGRAM_IDS): any {
  const p = path.join(SOLANA_ROOT, "target/idl", `${name}.json`);
  const idl = JSON.parse(fs.readFileSync(p, "utf8"));
  return idl;
}
function loadProgram(name: keyof typeof PROGRAM_IDS): anchor.Program {
  const idl = loadIdl(name);
  // Anchor 0.30+/1.0 IDL embeds the address. Override to be explicit.
  idl.address = PROGRAM_IDS[name].toBase58();
  return new anchor.Program(idl, provider);
}

const programs = {
  stable_naira:        loadProgram("stable_naira"),
  validator_registry:  loadProgram("validator_registry"),
  message_transmitter: loadProgram("message_transmitter"),
  token_messenger:     loadProgram("token_messenger"),
};

// --- PDAs ------------------------------------------------------------------
const [snConfig, snConfigBump]     = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_IDS.stable_naira);
const [vrRegistry, vrRegistryBump] = PublicKey.findProgramAddressSync([Buffer.from("registry")], PROGRAM_IDS.validator_registry);
const [mtConfig, mtConfigBump]     = PublicKey.findProgramAddressSync([Buffer.from("mt_config")], PROGRAM_IDS.message_transmitter);
const [tmConfig, tmConfigBump]     = PublicKey.findProgramAddressSync([Buffer.from("tm_config")], PROGRAM_IDS.token_messenger);
function rolePda(role: number, account: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("role"), Buffer.from([role]), account.toBuffer()],
    PROGRAM_IDS.stable_naira,
  )[0];
}

// --- helpers ---------------------------------------------------------------
async function exists(pubkey: PublicKey): Promise<boolean> {
  const info = await connection.getAccountInfo(pubkey, "confirmed");
  return info !== null && info.data.length > 0;
}
function hex(buf: Buffer | Uint8Array): string {
  return "0x" + Buffer.from(buf).toString("hex");
}

// --- steps -----------------------------------------------------------------

async function step1_stableNaira(): Promise<{ mint: PublicKey }> {
  console.log("\n[1/5] stable_naira.initialize");
  if (await exists(snConfig)) {
    console.log(`  config PDA already exists at ${snConfig.toBase58()} — skip`);
    // Recover the mint from the existing config account.
    const cfg = await programs.stable_naira.account.config.fetch(snConfig);
    console.log(`  recovered mint: ${(cfg.mint as PublicKey).toBase58()}`);
    return { mint: cfg.mint as PublicKey };
  }
  const mint = Keypair.generate();
  console.log(`  payer/admin: ${deployer.publicKey.toBase58()}`);
  console.log(`  new mint:    ${mint.publicKey.toBase58()}`);
  console.log(`  config PDA:  ${snConfig.toBase58()}`);
  console.log(`  mint_cap:    ${MINT_CAP} (uncapped)`);
  if (DRY) { console.log("  (dry-run, not broadcasting)"); return { mint: mint.publicKey }; }

  const sig = await programs.stable_naira.methods
    .initialize(new anchor.BN(MINT_CAP.toString()))
    .accounts({
      payer: deployer.publicKey,
      admin: deployer.publicKey,
      config: snConfig,
      mint: mint.publicKey,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([mint])
    .rpc({ commitment: "confirmed" });
  console.log(`  tx: ${sig}`);
  return { mint: mint.publicKey };
}

async function step2_validatorRegistry() {
  console.log("\n[2/5] validator_registry.initialize");
  if (await exists(vrRegistry)) {
    console.log(`  registry PDA already exists at ${vrRegistry.toBase58()} — skip`);
    return;
  }
  const validators = [Buffer.from(VALIDATOR_EVM.slice(2), "hex")]; // [u8; 20]
  console.log(`  owner:      ${deployer.publicKey.toBase58()}`);
  console.log(`  registry:   ${vrRegistry.toBase58()}`);
  console.log(`  validators: [${VALIDATOR_EVM}]`);
  console.log(`  threshold:  ${THRESHOLD}`);
  if (DRY) { console.log("  (dry-run, not broadcasting)"); return; }

  const sig = await programs.validator_registry.methods
    .initialize(validators, THRESHOLD)
    .accounts({
      owner: deployer.publicKey,
      registry: vrRegistry,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc({ commitment: "confirmed" });
  console.log(`  tx: ${sig}`);
}

async function step3_messageTransmitter() {
  console.log("\n[3/5] message_transmitter.initialize");
  if (await exists(mtConfig)) {
    console.log(`  config PDA already exists at ${mtConfig.toBase58()} — skip`);
    return;
  }
  const { chainId, transmitter } = deriveIdentity();
  console.log(`  owner:        ${deployer.publicKey.toBase58()}`);
  console.log(`  config:       ${mtConfig.toBase58()}`);
  console.log(`  local_domain: ${LOCAL_DOMAIN}`);
  console.log(`  chain_id:     ${hex(chainId)}`);
  console.log(`  transmitter:  ${hex(transmitter)}`);
  console.log(`  max_body:     ${MAX_BODY_SIZE}`);
  console.log(`  vr program:   ${PROGRAM_IDS.validator_registry.toBase58()}`);
  if (DRY) { console.log("  (dry-run, not broadcasting)"); return; }

  const sig = await programs.message_transmitter.methods
    .initialize(LOCAL_DOMAIN, Array.from(chainId), Array.from(transmitter), new anchor.BN(MAX_BODY_SIZE.toString()))
    .accounts({
      owner: deployer.publicKey,
      config: mtConfig,
      registryProgram: PROGRAM_IDS.validator_registry,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc({ commitment: "confirmed" });
  console.log(`  tx: ${sig}`);
}

async function step4_tokenMessenger(mint: PublicKey) {
  console.log("\n[4/5] token_messenger.initialize");
  if (await exists(tmConfig)) {
    console.log(`  config PDA already exists at ${tmConfig.toBase58()} — skip`);
    return;
  }
  console.log(`  owner:           ${deployer.publicKey.toBase58()}`);
  console.log(`  config:          ${tmConfig.toBase58()}`);
  console.log(`  mint:            ${mint.toBase58()}`);
  console.log(`  message_xmitter: ${PROGRAM_IDS.message_transmitter.toBase58()}`);
  console.log(`  stable_naira:    ${PROGRAM_IDS.stable_naira.toBase58()}`);
  console.log(`  fee_bps:         ${FEE_BPS}`);
  console.log(`  fee_recipient:   ${deployer.publicKey.toBase58()} (matches EVM 0x0 spirit: no separate recipient EOA)`);
  if (DRY) { console.log("  (dry-run, not broadcasting)"); return; }

  const sig = await programs.token_messenger.methods
    .initialize(FEE_BPS, deployer.publicKey)
    .accounts({
      owner: deployer.publicKey,
      config: tmConfig,
      mint,
      messageTransmitterProgram: PROGRAM_IDS.message_transmitter,
      stableNairaProgram: PROGRAM_IDS.stable_naira,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc({ commitment: "confirmed" });
  console.log(`  tx: ${sig}`);
}

async function step5_grantMinter() {
  console.log("\n[5/5] stable_naira.grant_role(MINTER, token_messenger config PDA)");
  const roleAcc = rolePda(ROLE_MINTER, tmConfig);
  if (await exists(roleAcc)) {
    console.log(`  role PDA already exists at ${roleAcc.toBase58()} — skip`);
    return;
  }
  console.log(`  admin:       ${deployer.publicKey.toBase58()}`);
  console.log(`  sn config:   ${snConfig.toBase58()}`);
  console.log(`  grantee PDA: ${tmConfig.toBase58()} (token_messenger config)`);
  console.log(`  role PDA:    ${roleAcc.toBase58()}`);
  if (DRY) { console.log("  (dry-run, not broadcasting)"); return; }

  const sig = await programs.stable_naira.methods
    .grantRole(ROLE_MINTER, tmConfig)
    .accounts({
      admin: deployer.publicKey,
      config: snConfig,
      payer: deployer.publicKey,
      roleAccount: roleAcc,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc({ commitment: "confirmed" });
  console.log(`  tx: ${sig}`);
}

// --- run -------------------------------------------------------------------
(async () => {
  console.log(`Network:  ${rpc}`);
  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);
  const bal = await connection.getBalance(deployer.publicKey, "confirmed");
  console.log(`Balance:  ${(bal / 1e9).toFixed(4)} SOL`);
  console.log(`Mode:     ${DRY ? "DRY-RUN" : "LIVE"}`);

  const { mint } = await step1_stableNaira();
  await step2_validatorRegistry();
  await step3_messageTransmitter();
  await step4_tokenMessenger(mint);
  await step5_grantMinter();

  console.log("\n=== summary ===");
  console.log(`SNR mint:                 ${mint.toBase58()}`);
  console.log(`stable_naira config:      ${snConfig.toBase58()}`);
  console.log(`validator_registry:       ${vrRegistry.toBase58()}`);
  console.log(`message_transmitter cfg:  ${mtConfig.toBase58()}`);
  console.log(`token_messenger cfg:      ${tmConfig.toBase58()}`);
  console.log(`MINTER role PDA:          ${rolePda(ROLE_MINTER, tmConfig).toBase58()}`);
})().catch((e) => { console.error(e); process.exit(1); });
