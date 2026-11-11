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
  key: "glam" | "fed" | "pastFed";
  question: string;
  outcomeNames: [string, string];
  rule: string;
  deadlineSec: number;
}

export const DEMO_EVENTS: readonly EventSpec[] = [
  {
    key: "glam",
    question: "Will Glamsterdam ship on mainnet by Dec 31, 2026?",
    outcomeNames: ["SHIPS", "DELAYED"],
    rule:
      "SHIPS if the Glamsterdam upgrade is active on Ethereum mainnet before 2027-01-01 00:00 UTC; otherwise DELAYED. " +
      "During the hackathon this event is resolved from a team-controlled API (demo).",
    deadlineSec: 1798761599,
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

export interface WorldSeed {
  price: bigint;
  depth: bigint;
}

/** Within-world pools: USDC per WETH and WETH depth per world. DELAYED·HOLDS is the thin one. */
export const SEED_2X2: readonly WorldSeed[] = [
  { price: e18(3700n), depth: e18(100n) },
  { price: e18(3000n), depth: e18(100n) },
  { price: e18(3300n), depth: e18(100n) },
  { price: e18(2500n), depth: e18(40n) },
];
export const SEED_BINARY: readonly WorldSeed[] = [
  { price: e18(3400n), depth: e18(100n) },
  { price: e18(2800n), depth: e18(100n) },
];

export const ODDS_POOL_DEPTH = e18(1_000_000n);
export const SPOT_DEPTH = e18(100n);
export const BOB_SUPPLY = e18(100_000n);
export const ALICE_WETH = e18(2n);
export const ALICE_USDC = e18(50n);
export const RAVI_DISCOUNT_BPS = 200n;
export const RAVI_BID_WETH = WAD;
export const RAVI_EXPIRY_SEC = 30 * 24 * 3600;
export const SALE_WETH = e18(2n);
export const BORROW_USDC = e18(3000n);
export const ODDS_SHIPS_BPS = 6667;
export const ODDS_CUTS_FALLBACK_BPS = 100;

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
  /** True when WETH goes in (the price falls). */
  wethIn: boolean;
  amountIn: bigint;
}

/**
 * What the owner must pay in for `move_spot_to(target)` on a pool holding `wethReserve` and
 * `usdcReserve`: constant product, fee on the input. Null when the price is already there. Used
 * only to deposit enough beforehand; the contract computes the exact swap itself.
 */
export function planSpotMove(wethReserve: bigint, usdcReserve: bigint, target: bigint): SpotMovePlan | null {
  if (wethReserve === 0n || usdcReserve === 0n || target === 0n) throw new Error("empty pool or zero price");
  const k = wethReserve * usdcReserve;
  const current = (usdcReserve * WAD) / wethReserve;
  if (current === target) return null;
  const grossUp = (net: bigint): bigint => (net * PIPS + (PIPS - SPOT_FEE_PIPS) - 1n) / (PIPS - SPOT_FEE_PIPS);
  if (target < current) {
    const wethAfter = isqrt((k * WAD) / target);
    return wethAfter <= wethReserve ? null : { wethIn: true, amountIn: grossUp(wethAfter - wethReserve) };
  }
  const usdcAfter = isqrt((k * target) / WAD);
  return usdcAfter <= usdcReserve ? null : { wethIn: false, amountIn: grossUp(usdcAfter - usdcReserve) };
}

/** Integer part, a dot and two decimals rounded down: the EVM scripts' `_fmt`. */
export function fmt2(x: bigint): string {
  const negative = x < 0n;
  const abs = negative ? -x : x;
  const cents = abs / 10n ** 16n;
  const text = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  return negative && cents > 0n ? `-${text}` : text;
}

/** WAD odds as a percentage rounded to the nearest hundredth. */
export const fmtOdds = (q: bigint): string => `${fmt2(q * 100n + 5n * 10n ** 15n)}%`;

/** Signed difference, "0.00" when it is under a cent. */
export function fmtDiff(a: bigint, b: bigint): string {
  const d = a - b;
  const abs = d < 0n ? -d : d;
  if (abs < 10n ** 16n) return "0.00";
  return `${d < 0n ? "-" : "+"}${fmt2(abs)}`;
}

/** HF as two decimals; null (no debt) is infinite. */
export const fmtHf = (hf: bigint | null): string => (hf === null ? "inf" : fmt2(hf));
