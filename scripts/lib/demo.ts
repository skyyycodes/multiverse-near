// The demo's numbers and the integer maths behind them: odds from basis points, the reserves that
// price an odds pool, order escrow, the spot move, and the report formatting. All amounts are the
// contract's 18-decimal internal units.

import { WAD } from "./units.ts";

export const MASK_L_SHAPE = 0xe;
export const MASK_DELAYED_HOLDS = 0x8;
export const MASK_BIN_DELAYED = 0x2;
export const MASK_SHIPS_CUTS = 0x1;

export const SPOT_FEE_PIPS = 3000n;
const PIPS = 1_000_000n;

export interface EventSpec {
  key: "spice" | "fed" | "pastFed";
  question: string;
  outcomeNames: [string, string];
  rule: string;
  deadlineSec: number;
}

export const DEMO_EVENTS: readonly EventSpec[] = [
  {
    key: "spice",
    question: "Will SPICE ship on NEAR mainnet by Mar 31, 2027?",
    outcomeNames: ["SHIPS", "DELAYED"],
    rule:
      "SHIPS if SPICE, NEAR's separation of consensus and execution, is active on NEAR mainnet before " +
      "2027-04-01 00:00 UTC; otherwise DELAYED. During the hackathon this event is resolved from a " +
      "team-controlled outcomes file (demo).",
    deadlineSec: 1806537599,
  },
  {
    key: "fed",
    question: "Will the Fed cut at its December meeting?",
    outcomeNames: ["CUTS", "HOLDS"],
    rule:
      "CUTS if and only if the upper limit of the federal funds target range (FRED DFEDTARU) after the Dec 8-9, 2026 " +
      "FOMC meeting is lower than before it; otherwise HOLDS (a hike resolves HOLDS).",
    deadlineSec: 1796842800,
  },
  {
    key: "pastFed",
    question: "Did the Fed cut at its October 27-28, 2026 meeting?",
    outcomeNames: ["CUTS", "HOLDS"],
    rule:
      "CUTS if and only if both limits of the federal funds target range (FRED DFEDTARU and DFEDTARL) are lower on " +
      "2026-10-29 than on 2026-10-27; HOLDS if neither is; if they disagree, nothing is reported.",
    deadlineSec: 1793210400,
  },
];

const e18 = (n: bigint): bigint => n * WAD;
/** A price in USDC per NEAR, given in cents: `cents(370n)` is 3.70. */
const cents = (n: bigint): bigint => (n * WAD) / 100n;

export interface WorldSeed {
  price: bigint;
  depth: bigint;
}

/** Within-world pools: USDC per NEAR and NEAR depth per world. DELAYED·HOLDS is the thin one. */
export const SEED_2X2: readonly WorldSeed[] = [
  { price: cents(370n), depth: e18(100_000n) },
  { price: cents(300n), depth: e18(100_000n) },
  { price: cents(330n), depth: e18(100_000n) },
  { price: cents(250n), depth: e18(40_000n) },
];
export const SEED_BINARY: readonly WorldSeed[] = [
  { price: cents(340n), depth: e18(100_000n) },
  { price: cents(280n), depth: e18(100_000n) },
];

export const ODDS_POOL_DEPTH = e18(1_000_000n);
export const SPOT_DEPTH = e18(100_000n);
export const BOB_SUPPLY = e18(100_000n);
export const ALICE_WNEAR = e18(2_000n);
export const ALICE_USDC = e18(50n);
export const RAVI_DISCOUNT_BPS = 200n;
export const RAVI_BID_WNEAR = e18(1_000n);
export const RAVI_EXPIRY_SEC = 30 * 24 * 3600;
export const SALE_WNEAR = e18(2_000n);
export const BORROW_USDC = e18(3_000n);
export const ODDS_SHIPS_BPS = 6667;
export const ODDS_CUTS_FALLBACK_BPS = 100;

/** The end-to-end flow's order book in SHIPS·CUTS: Ravi asks 3.75 and bids 3.60, 1,000 NEAR each. */
export const BOOK_ASK_PRICE = cents(375n);
export const BOOK_BID_PRICE = cents(360n);
export const BOOK_SIZE_WNEAR = e18(1_000n);
/** Uma's Root LP deposit, Carl's unhedged collateral and the owner's push on DELAYED·HOLDS. */
export const UMA_WNEAR = e18(5_000n);
export const UMA_USDC = e18(20_000n);
export const CARL_WNEAR = e18(1_000n);
export const PUSH_WNEAR = e18(3_000n);

export const wmul = (a: bigint, b: bigint): bigint => (a * b) / WAD;

/** Single-world masks of a scenario with `worldCount` worlds. */
export const singles = (worldCount: number): number[] => Array.from({ length: worldCount }, (_, w) => 1 << w);

export function checkBps(bps: number, name: string): void {
  if (!Number.isInteger(bps) || bps <= 0 || bps >= 10_000) throw new Error(`${name} must be between 1 and 9999`);
}

/**
 * Odds of independent events from basis points, WAD per world (world = ships digit + 2 x fed digit),
 * summing to exactly 1e18.
 */
export function independentOdds(worldCount: 2 | 4, shipsBps: number, cutsBps: number): bigint[] {
  const s = BigInt(shipsBps);
  const c = BigInt(cutsBps);
  if (worldCount === 2) return [s * 10n ** 14n, (10_000n - s) * 10n ** 14n];
  const k = 10n ** 10n;
  return [s * c * k, (10_000n - s) * c * k, s * (10_000n - c) * k, (10_000n - s) * (10_000n - c) * k];
}

/** Sibling pairs of the odds tree, parents first (the contract's order). */
export function oddsPairs(worldCount: number): [number, number][] {
  if (worldCount === 2) return [[0x1, 0x2]];
  if (worldCount === 4) return [[0x3, 0xc], [0x1, 0x2], [0x4, 0x8]];
  return [];
}

export const sumOver = (q: readonly bigint[], mask: number): bigint =>
  q.reduce((sum, v, w) => (mask & (1 << w) ? sum + v : sum), 0n);

/**
 * Reserves pricing an odds pool at `qx : qy`: the less likely side gets `depth`, the likelier one
 * `floor(depth * q_less / q_more)` (reserves are inversely proportional to odds).
 */
export function seedReserves(qx: bigint, qy: bigint, depth: bigint): [bigint, bigint] {
  if (qx === 0n && qy === 0n) throw new Error("both odds are zero");
  return qx <= qy ? [depth, (depth * qx) / qy] : [(depth * qy) / qx, depth];
}

/** USDC escrow of a bid: `ceil(amount * price / 1e18)`. */
export const orderCost = (amount: bigint, price: bigint): bigint => (amount * price + WAD - 1n) / WAD;

export const raviBidPrice = (poolPrice: bigint): bigint => (poolPrice * (10_000n - RAVI_DISCOUNT_BPS)) / 10_000n;

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("square root of a negative number");
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

export interface SpotMovePlan {
  /** True when NEAR goes in (the price falls). */
  wnearIn: boolean;
  amountIn: bigint;
}

/**
 * What the owner must pay in for `move_spot_to(target)` on a pool holding `wnearReserve` and
 * `usdcReserve`: constant product, fee on the input. Null when the price is already there. Used
 * only to deposit enough beforehand; the contract computes the exact swap itself.
 */
export function planSpotMove(wnearReserve: bigint, usdcReserve: bigint, target: bigint): SpotMovePlan | null {
  if (wnearReserve === 0n || usdcReserve === 0n || target === 0n) throw new Error("empty pool or zero price");
  const k = wnearReserve * usdcReserve;
  const current = (usdcReserve * WAD) / wnearReserve;
  if (current === target) return null;
  const grossUp = (net: bigint): bigint => (net * PIPS + (PIPS - SPOT_FEE_PIPS) - 1n) / (PIPS - SPOT_FEE_PIPS);
  if (target < current) {
    const wnearAfter = isqrt((k * WAD) / target);
    return wnearAfter <= wnearReserve ? null : { wnearIn: true, amountIn: grossUp(wnearAfter - wnearReserve) };
  }
  const usdcAfter = isqrt((k * target) / WAD);
  return usdcAfter <= usdcReserve ? null : { wnearIn: false, amountIn: grossUp(usdcAfter - usdcReserve) };
}

/** Integer part, a dot and `digits` decimals rounded down; never a negative zero. */
export function fmtFixed(x: bigint, digits: number): string {
  if (!Number.isInteger(digits) || digits < 0 || digits > 18) throw new Error(`invalid digits: ${digits}`);
  const negative = x < 0n;
  const abs = negative ? -x : x;
  const unit = 10n ** BigInt(18 - digits);
  const kept = abs / unit;
  const base = 10n ** BigInt(digits);
  const text = digits === 0 ? `${kept}` : `${kept / base}.${(kept % base).toString().padStart(digits, "0")}`;
  return negative && kept > 0n ? `-${text}` : text;
}

/** Two decimals rounded down: amounts, USD values, HF and pool prices. */
export const fmt2 = (x: bigint): string => fmtFixed(x, 2);

/**
 * Four decimals rounded down like `fmt2` and the web app, for a NEAR price where a difference would
 * vanish at two: actual vs implied spot, order prices, average sale prices, TWAP prices.
 */
export const fmt4 = (x: bigint): string => fmtFixed(x, 4);

/** WAD odds as a percentage rounded to the nearest hundredth. */
export const fmtOdds = (q: bigint): string => `${fmt2(q * 100n + 5n * 10n ** 15n)}%`;

/** Signed difference at `digits` decimals, zero when it is under the last digit. */
export function fmtDiff(a: bigint, b: bigint, digits = 2): string {
  const d = a - b;
  const abs = d < 0n ? -d : d;
  const zero = fmtFixed(0n, digits);
  if (abs < 10n ** BigInt(18 - digits)) return zero;
  return `${d < 0n ? "-" : "+"}${fmtFixed(abs, digits)}`;
}

/** HF as two decimals; null (no debt) is infinite. */
export const fmtHf = (hf: bigint | null): string => (hf === null ? "inf" : fmt2(hf));
