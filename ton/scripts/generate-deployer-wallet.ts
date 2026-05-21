// One-off: generate a TON deployer wallet (mnemonic + keypair + testnet/mainnet address).
// Writes ONLY the public address to stdout; the mnemonic and secret hex are
// returned in JSON so the caller can persist them privately.
import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV5R1 } from "@ton/ton";

async function main() {
  const mnemonic = await mnemonicNew(24);
  const keys = await mnemonicToPrivateKey(mnemonic);
  const wallet = WalletContractV5R1.create({ workchain: 0, publicKey: keys.publicKey });
  // User-friendly, non-bounceable address (the form testnet faucets / explorers want).
  const testnetAddr = wallet.address.toString({ testOnly: true, urlSafe: true, bounceable: false });
  const mainnetAddr = wallet.address.toString({ testOnly: false, urlSafe: true, bounceable: false });
  const rawAddr = wallet.address.toRawString();
  const out = {
    mnemonic: mnemonic.join(" "),
    publicKeyHex: Buffer.from(keys.publicKey).toString("hex"),
    secretKeyHex: Buffer.from(keys.secretKey).toString("hex"),
    walletVersion: "v5R1",
    workchain: 0,
    addressTestnet: testnetAddr,
    addressMainnet: mainnetAddr,
    addressRaw: rawAddr,
  };
  console.log(JSON.stringify(out));
}

main().catch((e) => { console.error(e); process.exit(1); });
