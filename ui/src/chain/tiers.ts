// The three lending tiers of a market, in display order, and which one a screen opens on.
import type { LendingTier, Tier } from "./domain";

export const TIERS: readonly Tier[] = ["safe", "normal", "bold"];

export const TIER_LABEL: Record<Tier, string> = { safe: "Safe", normal: "Normal", bold: "Bold" };

/** A `tier` URL parameter; anything else reads as none (Normal never appears in a URL). */
export function parseTier(v: string | null | undefined): Tier | undefined {
  return v && (TIERS as readonly string[]).includes(v) ? (v as Tier) : undefined;
}

const hasDebt = (t: LendingTier) => Boolean(t.account && t.account.debt > 0n);
const hasCollateral = (t: LendingTier) => Boolean(t.account && t.account.collateral.length > 0);
const hasSupply = (t: LendingTier) => Boolean(t.account && t.account.supplied > 0n);

/**
 * Where the account already is: Borrow opens on the first tier with debt, else with collateral; Lend on the first
 * tier with supply. Undefined when the account has nothing in any tier (or the tiers are not loaded).
 */
export function positionTier(tiers: readonly LendingTier[] | undefined, mode: "borrow" | "lend"): Tier | undefined {
  if (!tiers) return undefined;
  const hit = mode === "borrow" ? (tiers.find(hasDebt) ?? tiers.find(hasCollateral)) : tiers.find(hasSupply);
  return hit?.tier;
}

/** `defaultTier` of web 6.5/6.6: the position's tier, else Normal. */
export const defaultTier = (tiers: readonly LendingTier[] | undefined, mode: "borrow" | "lend"): Tier => positionTier(tiers, mode) ?? "normal";

/**
 * The tier a screen shows: the URL's, else the one last picked for this market, else where the account has a
 * position, else Normal.
 */
export function resolveTier(urlParam: string | null, remembered: Tier | undefined, tiers: readonly LendingTier[] | undefined, mode: "borrow" | "lend"): Tier {
  return parseTier(urlParam) ?? remembered ?? defaultTier(tiers, mode);
}

/** The tier a sale keeps its collateral in: remembered, else the tier with debt, else Normal (web 6.4). */
export function sellTier(remembered: Tier | undefined, tiers: readonly LendingTier[] | undefined): Tier {
  if (remembered) return remembered;
  return tiers?.find(hasDebt)?.tier ?? "normal";
}
