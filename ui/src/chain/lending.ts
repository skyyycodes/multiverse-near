// Borrow and lend screen maths (web design 7.1-7.3). Every value is 18-decimal, so the units cancel in every product
// and quotient; rates are WAD per second, as the contract keeps them.
import type { Account, LendingMarket, LiquidationState, Scenario, TierConfig } from "./domain";
import { isPossible } from "./domain";
import { humanError } from "./errors";
import { fmtUsd, pct } from "./format";

export const WAD = 10n ** 18n;
export const SECONDS_PER_YEAR = 31_536_000n;

/** Annual rate from a per-second rate (simple interest, as the contract accrues it). */
export const annualRate = (perSecond: bigint): bigint => perSecond * SECONDS_PER_YEAR;

/** Borrowed over supplied, capped at 1 (`irm::utilization`). */
export function utilizationOf(tba: bigint, tsa: bigint): bigint {
  if (tba === 0n) return 0n;
  if (tba >= tsa) return WAD;
  return (tba * WAD) / tsa;
}

/** The kinked borrow rate per second at utilization `u` (`irm::borrow_rate`, every division down). */
export function borrowRate(u: bigint, c: Pick<TierConfig, "rateBase" | "rateSlope1" | "rateSlope2" | "rateKink">): bigint {
  const x = u > WAD ? WAD : u;
  if (x <= c.rateKink) return c.rateBase + (c.rateSlope1 * x) / c.rateKink;
  return c.rateBase + c.rateSlope1 + (c.rateSlope2 * (x - c.rateKink)) / (WAD - c.rateKink);
}

/** What a supplied unit earns per second (`irm::supply_rate`): `floor(floor(rate × (1 − rf)) × tba / tsa)`. */
export function supplyRate(rate: bigint, tsa: bigint, tba: bigint, reserveFactor: bigint): bigint {
  if (tsa === 0n) return 0n;
  return (((rate * (WAD - reserveFactor)) / WAD) * tba) / tsa;
}

export type CurvePoint = { u: bigint; borrow: bigint; supply: bigint };

/** `n` points of the tier's rate curve from 0 to 100% utilization (borrow and supply APR per second). */
export function curvePoints(c: TierConfig, n = 21): CurvePoint[] {
  return Array.from({ length: n }, (_, i) => {
    const u = (WAD * BigInt(i)) / BigInt(n - 1);
    const borrow = borrowRate(u, c);
    return { u, borrow, supply: supplyRate(borrow, WAD, u, c.reserveFactor) };
  });
}

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
  /** The view's borrow limit: worst world on the borrow side × borrow LTV. */
  limit: bigint;
  /** The "max" button: 0.5% under what the view says may be borrowed. */
  room: bigint;
  /** Worst world on the liquidation side. */
  cMinLiq: bigint;
  hfAfter: bigint | undefined;
  limitUsedAfter: bigint | undefined;
  aprAfter: bigint | undefined;
  belowMinLoan: boolean;
};

/** What Max and "Can borrow" offer: 99.5% of the contract's `max_borrow`, which a loan's rounding can still fit in. */
export const borrowRoom = (v: Pick<Account, "maxBorrow">): bigint => (v.maxBorrow * 995n) / 1000n;

/** web design 7.1. `market` (the tier's `market_state`) is needed for the APR after the loan. */
export function borrowMath(v: Account, possible: number, amount: bigint | undefined, market?: LendingMarket): BorrowMath {
  const cMinLiq = worstValue(v.collateralValues, possible) ?? 0n;
  const a = amount ?? 0n;
  const after = v.debt + a;
  const hfAfter = a > 0n && cMinLiq > 0n ? (cMinLiq * v.lltv) / after : undefined;
  const limitUsedAfter = a > 0n && v.borrowLimit > 0n ? (after * WAD) / v.borrowLimit : undefined;
  const aprAfter = a > 0n && market ? annualRate(borrowRate(utilizationOf(market.totalBorrow + a, market.totalSupply), market.config)) : undefined;
  return {
    limit: v.borrowLimit,
    room: borrowRoom(v),
    cMinLiq,
    hfAfter,
    limitUsedAfter,
    aprAfter,
    belowMinLoan: a > 0n && after > 0n && after < v.minLoan,
  };
}

/** How far collateral can fall from the borrow limit before liquidation: `1 − borrow_ltv / lltv` (WAD). */
export const cushion = (c: Pick<TierConfig, "lltv" | "borrowLtv">): bigint => (c.lltv === 0n ? 0n : WAD - (c.borrowLtv * WAD) / c.lltv);

/**
 * Why a borrow cannot go now, in the contract's order (SPEC 3.6.4); the pause flag is the TxButton's. Undefined when
 * it can.
 */
export function borrowBlocker(p: {
  halted: boolean;
  account: Account;
  market: LendingMarket;
  amount: bigint | undefined;
  tierLabel: string;
}): string | undefined {
  const { account: v, market: m, amount } = p;
  if (p.halted) return "Paused while a result is pending";
  if (m.frozen || v.frozen) return `The ${p.tierLabel} tier is frozen: no new loans`;
  if (v.borrowBlock) return humanError(v.borrowBlock);
  if (!amount) return "Enter an amount";
  if (amount > m.liquid) return `Only ${fmtUsd(m.liquid)} to lend in the ${p.tierLabel} tier`;
  const after = m.totalBorrow + amount;
  if (after > (m.config.maxUtilization * m.totalSupply) / WAD) return `This tier lends at most ${pct(m.config.maxUtilization, WAD, 0)} of its cash; try a smaller amount`;
  if (m.config.borrowCap !== null && after > m.config.borrowCap) return `This tier's borrowing cap is ${fmtUsd(m.config.borrowCap)}`;
  if (v.debt + amount < v.minLoan) return `The minimum loan is ${fmtUsd(v.minLoan)}`;
  // The contract rounds a new loan's debt up by a few wei, so borrowing the whole limit fails its health check
  // (Unhealthy): stop at the same room Max and "Can borrow" show.
  const room = borrowRoom(v);
  if (v.debt + amount > v.borrowLimit || amount > room) return `Over your borrow limit: at most ${fmtUsd(room)} now`;
  return undefined;
}

/** A partial repayment may not leave a debt under the minimum loan (`DustDebtLeft`). */
export function repayBlocker(debt: bigint, amount: bigint | undefined, all: boolean, wallet: bigint, minLoan: bigint): string | undefined {
  if (debt === 0n) return "No debt";
  if (all) return wallet === 0n ? "Not enough USDC" : undefined;
  if (!amount) return "Enter an amount";
  if (amount > wallet) return "Not enough USDC";
  const left = amount >= debt ? 0n : debt - amount;
  if (left > 0n && left < minLoan) return `Leaves ${fmtUsd(left)}: repay all, or leave at least ${fmtUsd(minLoan)}`;
  return undefined;
}

/** Repay-all attaches the debt plus 0.1% (interest accrues before it lands), never more than the wallet holds. */
export const repayAllSend = (debt: bigint, wallet: bigint): bigint => {
  const want = debt + debt / 1000n;
  return want > wallet ? wallet : want;
};

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

/** A loan whose collateral is worth nothing in a possible world: what is left can be written off by anyone. */
export const writeOffShown = (v: Pick<Account, "writeOffReady" | "debt">): boolean => v.writeOffReady && v.debt > 0n;

export const earnedOf = (v: Account): bigint => (v.supplied > v.supplyPrincipal ? v.supplied - v.supplyPrincipal : 0n);
export const marketLiquidity = (v: Account): bigint => (v.marketSupply > v.marketBorrow ? v.marketSupply - v.marketBorrow : 0n);
/** Bad debt the tier has written off so far, by insurance and by lenders. */
export const badDebtOf = (m: Pick<LendingMarket, "badDebtCovered" | "badDebtSocialized">): bigint => m.badDebtCovered + m.badDebtSocialized;

export type BorrowBanner = "liquidatable" | "grace" | "paused" | "paused_halted" | "paused_reference" | "paused_no_price" | "write_off";

/**
 * The one banner the Borrow screen shows, in web 6.5's priority: liquidatable, the grace after an unpause (for a
 * loan under HF 1), a liquidation pause of any kind, then a loan ready to be written off.
 */
export function borrowBanner(v: Pick<Account, "liquidation" | "healthFactor" | "debt" | "writeOffReady">, graceSec: bigint): BorrowBanner | undefined {
  if (v.liquidation === "liquidatable") return "liquidatable";
  if (graceSec > 0n && v.debt > 0n && v.healthFactor !== null && v.healthFactor < WAD) return "grace";
  if (v.liquidation !== "none") return v.liquidation;
  if (writeOffShown(v)) return "write_off";
  return undefined;
}

/** Supply blockers after the pause flag (web 6.6): frozen, wiped out, amount, wallet. */
export function supplyBlocker(m: Pick<LendingMarket, "frozen" | "totalSupply" | "totalSupplyShares">, amount: bigint | undefined, wallet: bigint, tierLabel: string): string | undefined {
  if (m.frozen) return `The ${tierLabel} tier is frozen: no new deposits`;
  if (m.totalSupply === 0n && m.totalSupplyShares > 0n) return `The ${tierLabel} tier lost all its lent cash to bad debt and is closed to deposits`;
  if (!amount) return "Enter an amount";
  if (amount > wallet) return "Not enough USDC";
  return undefined;
}

/** Withdraw blockers: only what is not lent out can leave now. */
export function withdrawBlocker(supplied: bigint, amount: bigint | undefined, liquid: bigint): string | undefined {
  if (supplied === 0n) return "Nothing supplied";
  if (!amount) return "Enter an amount";
  if (amount > supplied) return `You supplied ${fmtUsd(supplied)}`;
  if (amount > liquid)
    return `Lent out right now: ${fmtUsd(liquid)} available. It frees up as loans are repaid, and rising rates draw both repayments and new lenders.`;
  return undefined;
}

export type SupplySeen = { socialized: bigint; supplied: bigint };

/**
 * The `bad-debt-notice` (web 6.6): lenders absorbed a write-off since this screen first saw the tier, and the account's
 * supply fell. Undefined otherwise.
 */
export function badDebtNotice(first: SupplySeen | undefined, now: SupplySeen): { socialized: bigint; before: bigint; after: bigint } | undefined {
  if (!first || now.socialized <= first.socialized || now.supplied >= first.supplied) return undefined;
  return { socialized: now.socialized - first.socialized, before: first.supplied, after: now.supplied };
}
