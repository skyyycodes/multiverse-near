// The price maker: brings a market's implied NEAR spot back to the outside NEAR/USD reference by
// moving every world pool by the same factor with real swaps, so drift never reaches the contract's
// borrowing band (`max_deviation`, 10%). Planning only, integers only; the callers send: the
// one-shot seed step (seed-staging.ts --phase maker) and the keeper round (keeper.ts), which signs
// as the maker account. All amounts are the contract's 18-decimal internal units.

import { planSpotMove } from "./demo.ts";
import { WAD } from "./units.ts";

const PIPS = 1_000_000n;

export interface MakerOptions {
  /** Move only when the implied spot is at least this far from the reference. */
  thresholdBps: number;
  /** Further than this is not drift (a bad reference, a broken pool): leave it to a person. */
  maxBps: number;
  /** min_out of each swap: the quoted output less this. */
  slippageBps: number;
}

/** 4% leaves room under the 10% band and above what a demo trade or a parallel tester moves. */
export const MAKER_DEFAULTS: MakerOptions = { thresholdBps: 400, maxBps: 2_500, slippageBps: 100 };

/** A world pool as the planner needs it (token0 is the world's wNEAR, token1 its USDC). */
export interface MakerPool {
  id: number;
  world: number;
  wnearToken: string;
  usdcToken: string;
  wnearReserve: bigint;
  usdcReserve: bigint;
  /** USDC per wNEAR, WAD. */
  price: bigint;
  /** The fee the pool's next swap pays. */
  feePips: number;
}

export interface MakerMove {
  poolId: number;
  world: number;
  wnearIn: boolean;
  /** The verse token paid in (NEP-245 id, e.g. "1:usdc:4"). */
  tokenIn: string;
  amountIn: bigint;
  minOut: bigint;
  from: bigint;
  to: bigint;
}

export type MakerPlan =
  | { kind: "within"; offBps: number }
  | { kind: "too_far"; offBps: number }
  | { kind: "move"; offBps: number; factor: bigint; moves: MakerMove[] };

/** The `pools_of` rows the planner reads (protocol.ts PoolView has them all). */
export interface PoolRow {
  id: number;
  kind: string;
  world: number | null;
  token0: string;
  token1: string;
  wnear_reserve: string | null;
  usdc_reserve: string | null;
  price: string;
  fee_pips: number;
}

/** The world pools of a `pools_of` answer. */
export function makerPools(rows: readonly PoolRow[]): MakerPool[] {
  const out: MakerPool[] = [];
  for (const r of rows) {
    if (r.kind !== "within" || r.world === null || r.wnear_reserve === null || r.usdc_reserve === null) continue;
    if (!r.token0.includes(":wnear:") || !r.token1.includes(":usdc:")) throw new Error(`pool ${r.id}: token0 ${r.token0} / token1 ${r.token1} is not wNEAR / USDC`);
    out.push({
      id: r.id,
      world: r.world,
      wnearToken: r.token0,
      usdcToken: r.token1,
      wnearReserve: BigInt(r.wnear_reserve),
      usdcReserve: BigInt(r.usdc_reserve),
      price: BigInt(r.price),
      feePips: r.fee_pips,
    });
  }
  return out;
}

/** |reference / implied - 1| in basis points, rounded down. */
export function offBps(reference: bigint, implied: bigint): number {
  if (implied <= 0n) throw new Error("implied spot unknown");
  const d = reference > implied ? reference - implied : implied - reference;
  return Number((d * 10_000n) / implied);
}

/** The contract's exact-input output (cpmm.rs quote_exact_in): the fee stays out of the reserves. */
export function swapOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feePips: number): bigint {
  const afterFee = (amountIn * (PIPS - BigInt(feePips))) / PIPS;
  return (reserveOut * afterFee) / (reserveIn + afterFee);
}

/**
 * The swaps that move every world pool by f = reference / implied, so the implied spot (sum of
 * odds x world price) lands on the reference, or why nothing moves.
 */
export function planMaker(reference: bigint, implied: bigint, pools: readonly MakerPool[], o: MakerOptions = MAKER_DEFAULTS): MakerPlan {
  const off = offBps(reference, implied);
  if (off < o.thresholdBps) return { kind: "within", offBps: off };
  if (off > o.maxBps) return { kind: "too_far", offBps: off };
  const factor = (reference * WAD) / implied;
  const moves: MakerMove[] = [];
  for (const p of pools) {
    const to = (p.price * factor) / WAD;
    const s = planSpotMove(p.wnearReserve, p.usdcReserve, to, BigInt(p.feePips));
    if (!s) continue;
    const out = s.wnearIn ? swapOut(p.wnearReserve, p.usdcReserve, s.amountIn, p.feePips) : swapOut(p.usdcReserve, p.wnearReserve, s.amountIn, p.feePips);
    moves.push({
      poolId: p.id,
      world: p.world,
      wnearIn: s.wnearIn,
      tokenIn: s.wnearIn ? p.wnearToken : p.usdcToken,
      amountIn: s.amountIn,
      minOut: (out * BigInt(10_000 - o.slippageBps)) / 10_000n,
      from: p.price,
      to,
    });
  }
  return { kind: "move", offBps: off, factor, moves };
}

/**
 * What one split of each asset into every world must add so each move can pay its input: the
 * largest shortfall over the moves after what `have` already holds of that verse token, plus
 * `marginBps`. Zero where the balances cover it.
 */
export function splitNeed(moves: readonly MakerMove[], have: (tokenId: string) => bigint = () => 0n, marginBps = 200): { wnear: bigint; usdc: bigint } {
  const need = { wnear: 0n, usdc: 0n };
  for (const m of moves) {
    const short = m.amountIn - have(m.tokenIn);
    const asset = m.wnearIn ? "wnear" : "usdc";
    if (short > need[asset]) need[asset] = short;
  }
  const pad = (x: bigint): bigint => (x === 0n ? 0n : (x * BigInt(10_000 + marginBps) + 9_999n) / 10_000n);
  return { wnear: pad(need.wnear), usdc: pad(need.usdc) };
}
