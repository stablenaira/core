/* eslint-disable no-console */
/**
 * Sci-fi flavoured CLI utility — ANSI colors + emojis + banners.
 * Zero deps so it runs everywhere `tsx` / `hardhat run` does.
 *
 * Color palette is loosely modelled on Aliens / The Expanse HUDs:
 *   electric cyan for active steps, neon magenta for headers, amber for waits,
 *   green-160 for confirmations, red for failures.
 */

const ESC = "\x1b[";

export const C = {
  reset: ESC + "0m",
  bold: ESC + "1m",
  dim: ESC + "2m",
  italic: ESC + "3m",
  underline: ESC + "4m",

  black: ESC + "30m",
  red: ESC + "31m",
  green: ESC + "32m",
  yellow: ESC + "33m",
  blue: ESC + "34m",
  magenta: ESC + "35m",
  cyan: ESC + "36m",
  white: ESC + "37m",
  gray: ESC + "90m",

  brightRed: ESC + "91m",
  brightGreen: ESC + "92m",
  brightYellow: ESC + "93m",
  brightBlue: ESC + "94m",
  brightMagenta: ESC + "95m",
  brightCyan: ESC + "96m",
  brightWhite: ESC + "97m",
};

export function paint(color: string, text: string): string {
  return color + text + C.reset;
}

export function bold(text: string) {
  return paint(C.bold, text);
}

export function cyan(text: string) {
  return paint(C.brightCyan, text);
}
export function magenta(text: string) {
  return paint(C.brightMagenta, text);
}
export function green(text: string) {
  return paint(C.brightGreen, text);
}
export function red(text: string) {
  return paint(C.brightRed, text);
}
export function yellow(text: string) {
  return paint(C.brightYellow, text);
}
export function gray(text: string) {
  return paint(C.gray, text);
}
export function dim(text: string) {
  return paint(C.dim, text);
}

const HBAR = "═";
const VBAR = "║";
const TL = "╔";
const TR = "╗";
const BL = "╚";
const BR = "╝";

export function banner(title: string, subtitle?: string) {
  const width = Math.max(title.length, subtitle?.length ?? 0) + 6;
  const top = TL + HBAR.repeat(width) + TR;
  const bot = BL + HBAR.repeat(width) + BR;
  console.log("");
  console.log(magenta(top));
  console.log(magenta(VBAR) + "  " + bold(cyan(title)).padEnd(width + 19, " ") + magenta(VBAR));
  if (subtitle) {
    console.log(magenta(VBAR) + "  " + dim(subtitle).padEnd(width + 11, " ") + magenta(VBAR));
  }
  console.log(magenta(bot));
}

export function header(title: string) {
  const line = HBAR.repeat(60);
  console.log("");
  console.log(cyan(line));
  console.log(bold(cyan("▶ " + title)));
  console.log(cyan(line));
}

export function step(emoji: string, label: string, detail?: string) {
  const lhs = `${emoji}  ${cyan(label)}`;
  if (detail) {
    console.log(`${lhs}  ${gray("» " + detail)}`);
  } else {
    console.log(lhs);
  }
}

export function ok(label: string, detail?: string) {
  step("✅", green(label), detail);
}

export function warn(label: string, detail?: string) {
  step("⚠️ ", yellow(label), detail);
}

export function fail(label: string, detail?: string) {
  step("❌", red(label), detail);
}

export function info(label: string, detail?: string) {
  step("🛰️ ", label, detail);
}

export function action(label: string, detail?: string) {
  step("⚙️ ", label, detail);
}

export function rocket(label: string, detail?: string) {
  step("🚀", magenta(label), detail);
}

export function chip(label: string) {
  return paint(C.bold + C.brightYellow, ` [${label}] `);
}

export function box(lines: string[]) {
  const w = lines.reduce((m, l) => Math.max(m, stripAnsi(l).length), 0) + 4;
  console.log(magenta("┌" + "─".repeat(w) + "┐"));
  for (const l of lines) {
    const pad = w - stripAnsi(l).length - 2;
    console.log(magenta("│ ") + l + " ".repeat(pad) + magenta(" │"));
  }
  console.log(magenta("└" + "─".repeat(w) + "┘"));
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Print a sci-fi style "scanning" loading bar that fills `width` cells over `durationMs`. */
export async function progress(
  label: string,
  durationMs: number,
  width = 40,
  ticks = 20
): Promise<void> {
  const start = Date.now();
  while (true) {
    const elapsed = Date.now() - start;
    const pct = Math.min(elapsed / durationMs, 1);
    const filled = Math.floor(pct * width);
    const empty = width - filled;
    const bar = green("█".repeat(filled)) + gray("░".repeat(empty));
    process.stdout.write(`\r${cyan("⏳")} ${label}  ${bar}  ${(pct * 100).toFixed(0)}%`);
    if (pct >= 1) break;
    await new Promise((r) => setTimeout(r, durationMs / ticks));
  }
  process.stdout.write("\n");
}

/** Live countdown — prints remaining minutes / seconds while we wait for a timelock. */
export async function countdown(label: string, totalSec: number): Promise<void> {
  const end = Date.now() + totalSec * 1000;
  while (true) {
    const now = Date.now();
    if (now >= end) break;
    const remain = Math.ceil((end - now) / 1000);
    const m = Math.floor(remain / 60);
    const s = remain % 60;
    const txt = `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    process.stdout.write(`\r${yellow("⌛")} ${label}  ${magenta("T-" + txt)}  ${gray("(holding for timelock)")}      `);
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write("\n");
  ok(`${label} elapsed — committing.`);
}

export const EMOJI = {
  rocket: "🚀",
  satellite: "🛰️ ",
  link: "🔗",
  shield: "🛡️ ",
  oracle: "🔮",
  lock: "🔒",
  unlock: "🔓",
  fire: "🔥",
  star: "⭐",
  alien: "👽",
  robot: "🤖",
  gear: "⚙️ ",
  wave: "📡",
  beacon: "📶",
  warp: "🌀",
  scan: "🔍",
};

/** Slow-print a string, char-by-char, for sci-fi flair. Use sparingly. */
export async function teleprint(text: string, msPerChar = 12): Promise<void> {
  for (const ch of text) {
    process.stdout.write(ch);
    await new Promise((r) => setTimeout(r, msPerChar));
  }
  process.stdout.write("\n");
}
