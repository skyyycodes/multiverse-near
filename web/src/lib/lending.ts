// Borrow and lend screen maths. Every value is 18-decimal, so the units cancel in every product and quotient.
import type { Account, LiquidationState, Scenario } from "./domain";
import { isPossible } from "./domain";

export const WAD = 10n ** 18n;
const SECONDS_PER_YEAR = 31_536_000n;

/** Annual rate from a per-second rate (simple interest, as the contract accrues it). */
export const annualRate = (perSecond: bigint): bigint => perSecond * SECONDS_PER_YEAR;

/** Lowest collateral value over the possible worlds. */
export function worstValue(values: readonly bigint[], possible: number): bigint | undefined {
  let lowest: bigint | undefined;
  values.forEach((v, w) => {
    if (!isPossible(possible, w)) return;
    if (lowest === undefined || v < lowest) lowest = v;
  });
  return lowest;
}

export type BorrowMath = {
  lowest: bigint;
  capacity: bigint;
  /** The "max" button: 0.5% under HF 1. */
  room: bigint;
  liquidity: bigint;
  hfAfter: bigint | undefined;
};

export function borrowMath(v: Account, possible: number, borrow: bigint | undefined): BorrowMath {
  const lowest = worstValue(v.collateralValues, possible) ?? 0n;
  const capacity = (lowest * v.lltv) / WAD;
  const room = capacity > v.debt ? ((capacity - v.debt) * 995n) / 1000n : 0n;
  const liquidity = v.marketSupply > v.marketBorrow ? v.marketSupply - v.marketBorrow : 0n;
  const hfAfter = borrow && lowest > 0n ? (lowest * v.lltv) / (v.debt + borrow) : undefined;
  return { lowest, capacity, room, liquidity, hfAfter };
}

/** Collateral value at which the loan reaches HF 1 (the dashed line). */
export const neededValue = (debt: bigint, lltv: bigint): bigint => (debt === 0n || lltv === 0n ? 0n : (debt * WAD) / lltv);

/** Bar width in percent with one decimal. */
export const barWidth = (value: bigint, max: bigint): number => (max === 0n ? 0 : Number((value * 1000n) / max) / 10);
export const linePosition = (needed: bigint, max: bigint): number => Math.min(100, barWidth(needed, max));

/** The contract's liquidation status, computed with the exact checks `liquidate` makes; the screen only names the world. */
export function liquidationOf(v: Account, s: Scenario): { state: LiquidationState; unpricedLabel?: string } {
  const label = v.unpricedWorld !== null ? s.worlds[v.unpricedWorld]?.label : undefined;
  return label ? { state: v.liquidation, unpricedLabel: label } : { state: v.liquidation };
}

export const earnedOf = (v: Account): bigint => (v.supplied > v.supplyPrincipal ? v.supplied - v.supplyPrincipal : 0n);
export const marketLiquidity = (v: Account): bigint => (v.marketSupply > v.marketBorrow ? v.marketSupply - v.marketBorrow : 0n);
