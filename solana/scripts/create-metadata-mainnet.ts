// Create the Metaplex Token Metadata account for the SNR mint by calling
// `stable_naira.create_metadata`. One-shot: re-running on an already-populated
// metadata PDA will revert at the Metaplex level.
//
// Usage:
//   bun create-metadata-mainnet.ts          # send the tx
//   bun create-metadata-mainnet.ts --dry    # show the plan, no broadcast

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY,
  Transaction, TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const STABLE_NAIRA_PROGRAM = new PublicKey("7EXTBay4r4Ft3k5poXnhxMCQXe5s5yv2kfxMiA7babYD");
const SNR_MINT = new PublicKey("4zMkZY5ytjG5gLLEQL4FQcuFJfHdiDZLmKsaGGXNytt");
const METAPLEX_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

const CONFIG_SEED = Buffer.from("config");
const METADATA_SEED = Buffer.from("metadata");

// Anchor instruction discriminator = sha256("global:create_metadata")[..8]
function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update("global:" + name).digest().subarray(0, 8);
}

// String prefix-length encoding (Borsh): 4-byte LE length + bytes
function encodeString(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const out = Buffer.alloc(4 + b.length);
  out.writeUInt32LE(b.length, 0);
  b.copy(out, 4);
  return out;
}

const DRY = process.argv.includes("--dry");

// Args (must match canonical SNR identity)
const NAME = "StableNaira";
const SYMBOL = "SNR";
const URI = "https://raw.githubusercontent.com/stablenaira/branding/main/snr-token-metadata.json";

function readSolanaConfig(): { rpc: string; keypair: string } {
  const cli = path.join(os.homedir(), ".config/solana/cli/config.yml");
  const raw = fs.readFileSync(cli, "utf8");
  const rpc = raw.match(/^json_rpc_url:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  const keypair = raw.match(/^keypair_path:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  if (!rpc || !keypair) throw new Error("Could not parse ~/.config/solana/cli/config.yml");
  return { rpc, keypair: keypair.replace(/^~/, os.homedir()) };
}

const { rpc, keypair: keypairPath } = readSolanaConfig();
if (!/mainnet/i.test(rpc)) {
  console.error(`SAFETY: configured RPC does not look like mainnet (${rpc}).`);
  process.exit(1);
}
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))));
const connection = new Connection(rpc, "confirmed");

async function main() {
  console.log(`RPC:      ${rpc}`);
  console.log(`Admin:    ${deployer.publicKey.toBase58()}`);
  const bal = await connection.getBalance(deployer.publicKey);
  console.log(`Balance:  ${(bal / 1e9).toFixed(6)} SOL`);

  const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], STABLE_NAIRA_PROGRAM);
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [METADATA_SEED, METAPLEX_PROGRAM.toBuffer(), SNR_MINT.toBuffer()],
    METAPLEX_PROGRAM
  );

  console.log(`\nConfig PDA:   ${configPda.toBase58()}`);
  console.log(`Metadata PDA: ${metadataPda.toBase58()}`);

  const existing = await connection.getAccountInfo(metadataPda);
  if (existing) {
    console.log(`\n✓ Metadata PDA already exists (${existing.data.length} bytes). Nothing to do.`);
    return;
  }

  // Build instruction data: discriminator || borsh(name) || borsh(symbol) || borsh(uri)
  const data = Buffer.concat([
    anchorDiscriminator("create_metadata"),
    encodeString(NAME),
    encodeString(SYMBOL),
    encodeString(URI),
  ]);

  console.log(`\nname:   ${NAME}`);
  console.log(`symbol: ${SYMBOL}`);
  console.log(`uri:    ${URI}`);
  console.log(`(updateAuthority = config PDA; isMutable = true)`);

  if (DRY) {
    console.log(`\n--- DRY RUN: would send create_metadata tx ---`);
    return;
  }

  const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  const SYSVAR_INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");
  const ix = new TransactionInstruction({
    programId: STABLE_NAIRA_PROGRAM,
    keys: [
      { pubkey: deployer.publicKey,  isSigner: true,  isWritable: false }, // admin
      { pubkey: deployer.publicKey,  isSigner: true,  isWritable: true  }, // payer
      { pubkey: configPda,           isSigner: false, isWritable: false }, // config
      { pubkey: metadataPda,         isSigner: false, isWritable: true  }, // metadata
      { pubkey: SNR_MINT,            isSigner: false, isWritable: true  }, // mint (writable for CreateV1)
      { pubkey: TOKEN_2022,          isSigner: false, isWritable: false }, // token_program (Token-2022)
      { pubkey: METAPLEX_PROGRAM,    isSigner: false, isWritable: false }, // metadata_program
      { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false }, // sysvar_instructions
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = deployer.publicKey;
  tx.sign(deployer);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log(`\ntx sent: ${sig}`);
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`✓ confirmed`);

  const after = await connection.getAccountInfo(metadataPda);
  console.log(`\nMetadata PDA now has ${after?.data.length ?? 0} bytes of data.`);
  console.log(`Solana Explorer: https://explorer.solana.com/address/${SNR_MINT.toBase58()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
