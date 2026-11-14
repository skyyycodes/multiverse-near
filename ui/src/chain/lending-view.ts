// The lending, at-risk and portfolio screens' maths over the contract's own numbers (borrow_view, lending_tiers, the
// account's verse tokens): where a tier's collateral pays in each world, the NEAR price in each world at which a loan
// reaches health 1, the worst world as NEAR falls (a what-if), and an account's range of futures in a market.
// bigint in, bigint out (18 decimals, as the contract keeps them); a move of NEAR is in basis points.
import type { Tier } from "./domain";
import type { Asset } from "./types";
import { isPossible } from "./domain";

const WAD = 10n ** 18n;
const BPS = 10_000n;

/** Something with a world mask: a collateral piece (a real one has the root mask) or a verse token. */
export type Piece = { asset: Asset; mask: number; amount: bigint };

/** wNEAR and USDC paying in each world (index = world), zero in a world that can no longer happen. */
export type ByWorld = { near: bigint[]; usdc: bigint[] };

/** What the pieces pay in each possible world: a piece counts in every world of its mask. */
export function byWorld(pieces: readonly Piece[], worldCount: number, possible: number): ByWorld {
  const near = Array.from({ length: worldCount }, () => 0n);
  const usdc = Array.from({ length: worldCount }, () => 0n);
  for (const p of pieces) {
    for (let w = 0; w < worldCount; w++) {
      if (!isPossible(possible & p.mask, w)) continue;
      if (p.asset === "wnear") near[w] += p.amount;
      else usdc[w] += p.amount;
    }
  }
  return { near, usdc };
}

/** Two per-world tallies added together. */
export const addWorlds = (a: ByWorld, b: ByWorld): ByWorld => ({
  near: a.near.map((x, w) => x + (b.near[w] ?? 0n)),
  usdc: a.usdc.map((x, w) => x + (b.usdc[w] ?? 0n)),
});

export type LiqPrice =
  /** No loan. */
  | { kind: "none" }
  /** The dollars posted in this world cover the loan whatever NEAR does there. */
  | { kind: "never" }
  /** This world is already under the line. */
  | { kind: "now" }
  /** NEAR's price (USDC per NEAR) at which health reaches 1 here, the price collateral is valued at now, and the fall
   *  from one to the other as a share of one (WAD). */
  | { kind: "at"; price: bigint; now: bigint; drop: bigint };

/**
 * The NEAR price in one world at which a loan reaches health 1 there. `value` is the contract's collateral value in
 * that world (liquidation side: wNEAR at its 30-minute average, less any haircut, plus USDC); `near` and `usdc` are the
 * tier's pieces paying there. The contract liquidates when `value × lltv < debt` (all WAD), so the line sits where
 * `near × price + usdc = debt / lltv`.
 */
export function liquidationPrice(o: { value: bigint; near: bigint; usdc: bigint; debt: bigint; lltv: bigint }): LiqPrice {
  if (o.debt <= 0n) return { kind: "none" };
  if (o.lltv <= 0n || o.value * o.lltv < o.debt * WAD) return { kind: "now" };
  if (o.near === 0n) return { kind: "never" };
  const line = (o.debt * WAD * WAD) / o.lltv; // debt / lltv, scaled by WAD once more for the division by `near`
  const dollars = o.usdc * WAD;
  if (line <= dollars) return { kind: "never" };
  const price = (line - dollars + o.near - 1n) / o.near; // rounded up: at this price or lower, health is under 1
  const now = ((o.value > o.usdc ? o.value - o.usdc : 0n) * WAD) / o.near;
  if (now === 0n || price >= now) return { kind: "now" };
  return { kind: "at", price, now, drop: WAD - (price * WAD) / now };
}

/** One row per possible world: its liquidation price for a loan of `debt` in the tier these values and pieces are of. */
export function liquidationPrices(p: { values: readonly bigint[]; posted: ByWorld; possible: number; debt: bigint; lltv: bigint }): { world: number; liq: LiqPrice }[] {
  return p.values
    .map((value, world) => ({ world, value }))
    .filter(({ world }) => isPossible(p.possible, world))
    .map(({ world, value }) => ({ world, liq: liquidationPrice({ value, near: p.posted.near[world] ?? 0n, usdc: p.posted.usdc[world] ?? 0n, debt: p.debt, lltv: p.lltv }) }));
}

/** The world liquidated first: one already under the line, else the one with the smallest fall to it. */
export function bindingWorld(rows: readonly { world: number; liq: LiqPrice }[]): number | undefined {
  const now = rows.find((r) => r.liq.kind === "now");
  if (now) return now.world;
  let best: { world: number; drop: bigint } | undefined;
  for (const r of rows) if (r.liq.kind === "at" && (!best || r.liq.drop < best.drop)) best = { world: r.world, drop: r.liq.drop };
  return best?.world;
}

/**
 * A what-if: the worst world's collateral value if NEAR fell by `fallBps` in every world, as the tier holds it (the
 * USDC part stays) and, for comparison, with the same value held as NEAR in every world (all of it falls).
 */
export function worstAfterFall(values: readonly bigint[], posted: ByWorld, possible: number, fallBps: number): { held: bigint; allNear: bigint } {
  const keep = BPS - BigInt(Math.max(0, Math.min(10_000, Math.round(fallBps))));
  let held: bigint | undefined;
  let allNear: bigint | undefined;
  values.forEach((v, w) => {
    if (!isPossible(possible, w)) return;
    const usdc = posted.usdc[w] ?? 0n;
    const nearPart = v > usdc ? v - usdc : 0n;
    const h = (nearPart * keep) / BPS + (v > usdc ? usdc : v);
    const a = (v * keep) / BPS;
    if (held === undefined || h < held) held = h;
    if (allNear === undefined || a < allNear) allNear = a;
  });
  return { held: held ?? 0n, allNear: allNear ?? 0n };
}

/** The lowest value over the possible worlds (the contract's `c_min`), or 0 without any. */
export function worstOf(values: readonly bigint[], possible: number): bigint {
  let lowest: bigint | undefined;
  values.forEach((v, w) => {
    if (isPossible(possible, w) && (lowest === undefined || v < lowest)) lowest = v;
  });
  return lowest ?? 0n;
}

/** The borrow that brings a loan to `ltvBps` of its worst world (liquidation side), never below zero. */
export function amountForLtv(cMin: bigint, debt: bigint, ltvBps: number): bigint {
  const target = (cMin * BigInt(Math.max(0, Math.round(ltvBps)))) / BPS;
  return target > debt ? target - debt : 0n;
}

/** Loan over worst world, as a share of one (WAD); undefined without collateral. */
export const ltvOf = (debt: bigint, cMin: bigint): bigint | undefined => (cMin > 0n ? (debt * WAD) / cMin : undefined);

/**
 * What an account ends with in each world of a market: each world's wNEAR at that world's NEAR price, moved by
 * `moveBps` (a what-if, 0 for today), plus its USDC, less what it owes in the market. Zero in a world that can no longer
 * happen.
 */
export function worldWorth(h: ByWorld, prices: readonly bigint[], debt: bigint, possible: number, moveBps = 0): bigint[] {
  const scale = BPS + BigInt(Math.max(-10_000, Math.round(moveBps)));
  return h.near.map((near, w) => {
    if (!isPossible(possible, w)) return 0n;
    const price = ((prices[w] ?? 0n) * scale) / BPS;
    return (near * price) / WAD + (h.usdc[w] ?? 0n) - debt;
  });
}

/** The worst and the best possible world of per-world values (ties go to the lower index). */
export function futuresRange(values: readonly bigint[], possible: number): { worst: number; best: number } | undefined {
  let worst: number | undefined;
  let best: number | undefined;
  values.forEach((v, w) => {
    if (!isPossible(possible, w)) return;
    if (worst === undefined || v < values[worst]) worst = w;
    if (best === undefined || v > values[best]) best = w;
  });
  return worst === undefined || best === undefined ? undefined : { worst, best };
}

/** The chance-weighted value over the possible worlds (odds in WAD, as the market card has them); 0 without odds. */
export function oddsWeighted(values: readonly bigint[], odds: readonly bigint[], possible: number): bigint {
  let num = 0n;
  let den = 0n;
  values.forEach((v, w) => {
    if (!isPossible(possible, w)) return;
    const o = odds[w] ?? 0n;
    num += v * o;
    den += o;
  });
  return den > 0n ? num / den : 0n;
}

/** How a market's worlds hold up against NEAR: worlds holding any NEAR move with it, the rest are fixed in dollars. */
export function hedgeShape(h: ByWorld, possible: number): { moving: number; fixed: number; empty: number } {
  let moving = 0;
  let fixed = 0;
  let empty = 0;
  h.near.forEach((near, w) => {
    if (!isPossible(possible, w)) return;
    if (near > 0n) moving++;
    else if ((h.usdc[w] ?? 0n) > 0n) fixed++;
    else empty++;
  });
  return { moving, fixed, empty };
}

/** A loan, a supply or posted collateral in one tier of one market: what the portfolio lists. */
export type TierPosition = { sid: number; tier: Tier; debt: bigint; supplied: bigint; healthFactor: bigint | null; pieces: number };

/** The tiers of a market in which the account has anything, in display order. */
export function tierPositions(sid: number, tiers: readonly { tier: Tier; account: { debt: bigint; supplied: bigint; healthFactor: bigint | null; collateral: readonly unknown[] } | null }[]): TierPosition[] {
  return tiers
    .filter((t) => t.account && (t.account.debt > 0n || t.account.supplied > 0n || t.account.collateral.length > 0))
    .map((t) => ({ sid, tier: t.tier, debt: t.account!.debt, supplied: t.account!.supplied, healthFactor: t.account!.healthFactor, pieces: t.account!.collateral.length }));
}
