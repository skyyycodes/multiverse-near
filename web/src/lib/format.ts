// Money is bigint in 18-decimal units: the contract scales both WETH and USDC to 18 decimals internally, and wallet
// balances are scaled the same way before they reach a formatter. Nothing here uses floating point.

export const ONE = 10n ** 18n;

function groupThousands(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `x` (18 decimals) with `digits` fraction digits, rounded toward zero, thousands grouped. */
export function fmt(x: bigint, digits = 2): string {
  const neg = x < 0n;
  const v = neg ? -x : x;
  const whole = v / ONE;
  const scale = 10n ** BigInt(digits);
  const frac = ((v % ONE) * scale) / ONE;
  const fracStr = digits > 0 ? "." + frac.toString().padStart(digits, "0") : "";
  // A value that truncates to zero shows no sign: never "-0.00".
  return (neg && (whole > 0n || frac > 0n) ? "-" : "") + groupThousands(whole) + fracStr;
}

export const fmtUsd = (x: bigint) => (x < 0n && fmt(-x) !== "0.00" ? "-$" + fmt(-x) : "$" + fmt(x < 0n ? -x : x));
export const fmtWeth = (x: bigint) => fmt(x, 4);
/** Whole dollars, rounded down: grid cells are narrow; the order panel shows cents. */
export const wholeUsd = (x: bigint) => "$" + fmt(x, 0);

/**
 * Parse a human decimal into 18-decimal units; undefined unless it is a positive number. `decimals` is the token's
 * own precision (6 for USDC), so an amount the token cannot represent is rejected instead of silently rounded.
 */
export function parseAmount(s: string, decimals = 18): bigint | undefined {
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  const [w, f = ""] = t.split(".");
  if (f.length > Math.min(decimals, 18)) return undefined;
  const v = BigInt(w) * ONE + BigInt((f + "0".repeat(18)).slice(0, 18));
  return v > 0n ? v : undefined;
}

/** `part / whole` as a percentage with `digits` decimals, rounded half up; "—" when `whole` is 0. */
export function pct(part: bigint, whole: bigint, digits = 1): string {
  if (whole === 0n) return "—";
  const scale = 10n ** BigInt(digits);
  const v = (part * 100n * scale * 2n + whole) / (2n * whole);
  const s = v.toString().padStart(digits + 1, "0");
  return digits > 0 ? `${s.slice(0, -digits)}.${s.slice(-digits)}%` : `${s}%`;
}

/** Named accounts stay readable; only implicit (hex) accounts are cut in the middle. */
export function shortAccount(a: string): string {
  if (/^[0-9a-f]{64}$/.test(a) || /^0x[0-9a-fA-F]{40}$/.test(a)) return `${a.slice(0, 6)}…${a.slice(-4)}`;
  return a.length <= 22 ? a : `${a.slice(0, 20)}…`;
}

/** The shortest readable form of an account in tight rows: "ravi" for ravi.multiverse-lending.testnet. */
export function accountLabel(a: string, max = 20): string {
  if (/^[0-9a-f]{64}$/.test(a)) return `${a.slice(0, 6)}…${a.slice(-4)}`;
  if (a.length <= max) return a;
  // Keep both ends: the name and the account it lives under are what tell two makers apart.
  const dot = a.lastIndexOf(".");
  const tail = dot > 0 ? Math.min(8, a.length - dot) : 6;
  return `${a.slice(0, max - tail - 1)}…${a.slice(-tail)}`;
}

/** Seconds as m:ss, never negative. */
export function countdown(seconds: bigint): string {
  const s = seconds < 0n ? 0n : seconds;
  return `${s / 60n}:${String(s % 60n).padStart(2, "0")}`;
}

export function utcDate(ts: bigint | number): string {
  return new Date(Number(ts) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** Health factor in WAD; `null` means no debt. */
export function fmtHf(hf: bigint | null): string {
  return hf === null ? "∞" : fmt(hf, 2);
}

export type Tone = "ok" | "warn" | "bad";

export function hfTone(hf: bigint | null): Tone {
  if (hf === null || hf >= (15n * ONE) / 10n) return "ok";
  if (hf >= (11n * ONE) / 10n) return "warn";
  return "bad";
}

/** The input text for a "max" style button: the value with `digits` decimals and no grouping commas. */
export const inputText = (x: bigint, digits: number) => fmt(x, digits).replaceAll(",", "");
