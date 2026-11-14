// Money is bigint in 18-decimal units: the contract keeps both wNEAR and USDC in 18 decimals internally, and wallet
// balances are scaled the same way before they reach a formatter. Nothing here uses floating point.
//
// A NEAR price is a few dollars, so it never shows in whole dollars: 2 decimals by default ($3.70), 4 where a
// difference would otherwise vanish (actual against implied spot, fair price, cost per NEAR, order prices).

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

function signedUsd(x: bigint, digits: number): string {
  const abs = x < 0n ? -x : x;
  const body = fmt(abs, digits);
  return x < 0n && /[1-9]/.test(body) ? "-$" + body : "$" + body;
}

/** Dollars with cents: USDC amounts, and a NEAR price where cents tell the worlds apart ("$3.70"). */
export const fmtUsd = (x: bigint) => signedUsd(x, 2);
/** A NEAR price to four decimals, where cents would hide the difference ("$3.0377", "$2.4500"). */
export const fmtPrice = (x: bigint) => signedUsd(x, 4);
/** A NEAR amount: thousands grouped, two decimals ("2,000.00"). */
export const fmtNear = (x: bigint) => fmt(x, 2);
/** A token amount in a list that mixes both assets: NEAR as above, USDC with four decimals. */
export const fmtAsset = (asset: "wnear" | "usdc", x: bigint) => (asset === "wnear" ? fmtNear(x) : fmt(x, 4));

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
  if (/^[0-9a-f]{64}$/.test(a)) return `${a.slice(0, 6)}…${a.slice(-4)}`;
  return a.length <= 22 ? a : `${a.slice(0, 20)}…`;
}

/** The shortest readable form of an account in tight rows: "ravi" for ravi.multiverse-near.testnet. */
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

/** `x` (18 decimals) as a percentage of one (WAD), half up: fmtPct(0.4e18, 1) = "40.0%". */
export const fmtPct = (x: bigint, digits = 1): string => pct(x, ONE, digits);

/** Basis points as a percentage, at most two decimals, no trailing zeros: 6700 → "67%", 6931 → "69.31%", 12100 → "121%". */
export function fmtBps(bps: number): string {
  const sign = bps < 0 ? "-" : "";
  const v = Math.abs(Math.trunc(bps));
  const whole = Math.floor(v / 100);
  const frac = String(v % 100).padStart(2, "0").replace(/0+$/, "");
  return `${sign}${whole}${frac ? `.${frac}` : ""}%`;
}

/**
 * Dollars in a card's tight space, truncated toward zero like `fmt`: "$950", "$999.99", "$1.0k", "$42.1k", "$999.9k",
 * "$1.00M", "$1.25M", "$2.50B".
 */
export function fmtCompactUsd(x: bigint): string {
  const neg = x < 0n;
  const v = neg ? -x : x;
  const sign = neg && v >= ONE / 100n ? "-" : "";
  let body: string;
  if (v < 1_000n * ONE) body = fmt(v, 2).replace(/\.00$/, "");
  else if (v < 1_000_000n * ONE) body = `${fmt(v / 1_000n, 1)}k`;
  else if (v < 1_000_000_000n * ONE) body = `${fmt(v / 1_000_000n, 2)}M`;
  else body = `${fmt(v / 1_000_000_000n, 2)}B`;
  return `${sign}$${body}`;
}

/** Seconds from now as words: "in 5 d", "in 3 h", "in 12 min", "in 40 s", "now", "2 min ago" (truncated). */
export function relTime(deltaSec: number | bigint): string {
  const d = Number(deltaSec);
  if (d === 0) return "now";
  const a = Math.abs(d);
  const span = a < 60 ? `${Math.floor(a)} s` : a < 3_600 ? `${Math.floor(a / 60)} min` : a < 86_400 ? `${Math.floor(a / 3_600)} h` : `${Math.floor(a / 86_400)} d`;
  return d > 0 ? `in ${span}` : `${span} ago`;
}

/** UTF-8 length of a text, as the contract counts its limits (question 280 B, rule 1024 B…). */
export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** Unix seconds as a `datetime-local` value read as UTC ("2027-06-30T23:59"). */
export function utcInputValue(sec: number | bigint): string {
  return new Date(Number(sec) * 1000).toISOString().slice(0, 16);
}

/** A `datetime-local` value read as UTC, in unix seconds; undefined unless it is a full date and time. */
export function parseUtcInput(v: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? "0"));
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 16) !== `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`) return undefined;
  return Math.floor(ms / 1000);
}
