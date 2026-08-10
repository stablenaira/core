/* eslint-disable no-console */
/**
 * Storage-layout guard for the UUPS proxies.
 *
 * Every contract in TRACKED sits behind an ERC1967 proxy, so its storage
 * layout is part of its ABI in the strictest sense: a variable that moves
 * slot, changes type, or disappears does not fail loudly — it silently
 * reinterprets live state. `mintCap` becoming `frozen`'s mapping base is not
 * a compile error, it is a solvency incident.
 *
 * This compares the compiled layout against a committed baseline
 * (storage-layout.json) and enforces three rules:
 *
 *   1. Every non-gap variable in the baseline must still exist at the same
 *      slot and offset with the same fully-expanded type. Catches reordering
 *      the inheritance list, inserting a variable mid-struct, retyping, and
 *      deletion.
 *
 *   2. The total footprint must not grow. Appending a variable is only safe
 *      when it is carved out of an existing gap, so a footprint increase
 *      means someone added state without shrinking `__gap`.
 *
 *   3. Struct and array types are compared fully expanded, so reordering the
 *      members of a struct stored in a mapping is caught even though the
 *      mapping's own type label is unchanged.
 *
 * Usage:
 *   npm run layout:check     verify against the baseline (CI)
 *   npm run layout:accept    rewrite the baseline after an intentional change
 */
import fs from "fs";
import path from "path";

/** Contracts deployed behind a proxy. Non-upgradeable contracts need no guard. */
const TRACKED = [
  "StableNaira",
  "TokenMessenger",
  "MessageTransmitter",
  "ValidatorRegistry",
];

const ROOT = path.resolve(__dirname, "..");
const BUILD_INFO_DIR = path.join(ROOT, "artifacts", "build-info");
const BASELINE_PATH = path.join(ROOT, "storage-layout.json");

const ACCEPT = process.argv.includes("--accept");

interface Entry {
  label: string;
  slot: number;
  offset: number;
  type: string;
  bytes: number;
}
type Layout = Record<string, Entry[]>;

/** A gap exists to be consumed; it is the one variable allowed to shrink. */
function isGap(label: string): boolean {
  return /gap/i.test(label);
}

/**
 * Expands a solc type id into a canonical string, recursing through struct
 * members and array/mapping element types. Two layouts with identical
 * canonical strings are byte-for-byte storage compatible.
 */
function canonicalType(typeId: string, types: any, seen: Set<string> = new Set()): string {
  const t = types[typeId];
  if (!t) return typeId;

  // Recursive struct (e.g. a linked list) — stop and use the label.
  if (seen.has(typeId)) return t.label;
  seen.add(typeId);

  const size = t.numberOfBytes;
  if (t.members) {
    const members = t.members
      .map(
        (m: any) =>
          `${m.label}@${m.slot}+${m.offset}:${canonicalType(m.type, types, seen)}`
      )
      .join(",");
    return `${t.label}{${members}}[${size}]`;
  }
  if (t.value) {
    // mapping(K => V)
    return `mapping(${canonicalType(t.key, types, seen)}=>${canonicalType(
      t.value,
      types,
      seen
    )})[${size}]`;
  }
  if (t.base) {
    return `${canonicalType(t.base, types, seen)}[][${size}]`;
  }
  return `${t.label}[${size}]`;
}

/** Reads the newest compiled layout for each tracked contract. */
function readLayouts(): Layout {
  if (!fs.existsSync(BUILD_INFO_DIR)) {
    throw new Error(
      `No build info at ${BUILD_INFO_DIR} — run \`npx hardhat compile\` first.`
    );
  }

  const files = fs
    .readdirSync(BUILD_INFO_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(BUILD_INFO_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const out: Layout = {};

  for (const { f } of files) {
    const bi = JSON.parse(fs.readFileSync(path.join(BUILD_INFO_DIR, f), "utf8"));
    const contracts = bi?.output?.contracts;
    if (!contracts) continue;

    for (const source of Object.keys(contracts)) {
      // Only our own sources; skip node_modules bases.
      if (!source.startsWith("contracts/")) continue;

      for (const name of Object.keys(contracts[source])) {
        if (!TRACKED.includes(name)) continue;
        if (out[name]) continue; // newest build-info wins

        const sl = contracts[source][name].storageLayout;
        if (!sl?.storage) continue;

        out[name] = sl.storage.map((s: any) => ({
          label: s.label,
          slot: Number(s.slot),
          offset: Number(s.offset),
          type: canonicalType(s.type, sl.types),
          bytes: Number(sl.types[s.type]?.numberOfBytes ?? 0),
        }));
      }
    }
  }

  const missing = TRACKED.filter((c) => !out[c]);
  if (missing.length) {
    throw new Error(
      `No storageLayout found for: ${missing.join(", ")}.\n` +
        `Ensure hardhat.config.ts requests "storageLayout" in solidity.settings.outputSelection, ` +
        `then run \`npx hardhat compile --force\`.`
    );
  }
  return out;
}

/** Highest slot touched, +1 — i.e. how many slots the contract reserves. */
function footprint(entries: Entry[]): number {
  return entries.reduce(
    (max, e) => Math.max(max, e.slot + Math.max(1, Math.ceil(e.bytes / 32))),
    0
  );
}

function compare(name: string, base: Entry[], next: Entry[]): string[] {
  const errors: string[] = [];
  const byLabel = new Map(next.map((e) => [e.label, e]));

  for (const b of base) {
    if (isGap(b.label)) continue; // gaps are allowed to shrink

    const n = byLabel.get(b.label);
    if (!n) {
      errors.push(
        `  ${name}.${b.label} — REMOVED (was slot ${b.slot}). ` +
          `Deleting a variable shifts everything after it.`
      );
      continue;
    }
    if (n.slot !== b.slot || n.offset !== b.offset) {
      errors.push(
        `  ${name}.${b.label} — MOVED slot ${b.slot}+${b.offset} → ${n.slot}+${n.offset}. ` +
          `Live proxies would read this variable from the wrong slot.`
      );
    }
    if (n.type !== b.type) {
      errors.push(
        `  ${name}.${b.label} — TYPE CHANGED at slot ${b.slot}\n` +
          `      was: ${b.type}\n` +
          `      now: ${n.type}`
      );
    }
  }

  const baseEnd = footprint(base);
  const nextEnd = footprint(next);
  if (nextEnd > baseEnd) {
    errors.push(
      `  ${name} — FOOTPRINT GREW ${baseEnd} → ${nextEnd} slots. ` +
        `New state must be carved out of __gap, not appended past it ` +
        `(shrink the gap by the number of slots you added).`
    );
  }

  return errors;
}

function main() {
  const current = readLayouts();

  if (ACCEPT || !fs.existsSync(BASELINE_PATH)) {
    const why = ACCEPT ? "Accepted" : "No baseline found — created";
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + "\n");
    console.log(`${why} storage-layout baseline at storage-layout.json`);
    for (const name of TRACKED) {
      console.log(`  ${name.padEnd(20)} ${current[name].length} vars, ${footprint(current[name])} slots`);
    }
    if (!ACCEPT) {
      console.log(`\nCommit this file. Future changes are checked against it.`);
    }
    return;
  }

  const baseline: Layout = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  const allErrors: string[] = [];
  const added: string[] = [];

  for (const name of TRACKED) {
    if (!baseline[name]) {
      console.log(`! ${name} is new — run \`npm run layout:accept\` to record it.`);
      continue;
    }
    allErrors.push(...compare(name, baseline[name], current[name]));

    const knownLabels = new Set(baseline[name].map((e) => e.label));
    for (const e of current[name]) {
      if (!knownLabels.has(e.label)) {
        added.push(`  ${name}.${e.label} at slot ${e.slot} (${e.type})`);
      }
    }
  }

  if (added.length) {
    console.log("New storage variables (allowed — carved from the gap):");
    console.log(added.join("\n"));
    console.log("");
  }

  if (allErrors.length) {
    console.error("STORAGE LAYOUT INCOMPATIBLE — upgrading a live proxy would corrupt state:\n");
    console.error(allErrors.join("\n"));
    console.error(
      `\nIf this change is intentional AND no proxy has been deployed yet, ` +
        `re-baseline with:\n  npm run layout:accept\n`
    );
    process.exitCode = 1;
    return;
  }

  console.log("Storage layout compatible with baseline.");
  for (const name of TRACKED) {
    const f = footprint(current[name]);
    console.log(`  ${name.padEnd(20)} ${current[name].length} vars, ${f} slots`);
  }
}

try {
  main();
} catch (e: any) {
  console.error(e?.message ?? String(e));
  process.exitCode = 1;
}
