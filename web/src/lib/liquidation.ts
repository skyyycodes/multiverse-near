// At-risk loans and the liquidate dialog (web design 6.10, 7.4; SPEC X15 / ECO-04).
import type { BorrowerRow, LiquidationQuote, LiquidationState, Tier } from "./domain";
import { humanError } from "./errors";
import { toTokenCeil } from "./units";

const WAD = 10n ** 18n;

/** The At-risk filter: the URL `hf` value and the `max_health_factor` it sends ("all" sends none). */
export const HF_FILTERS = ["1", "1.1", "1.5", "all"] as const;
export type HfFilter = (typeof HF_FILTERS)[number];
export const DEFAULT_HF_FILTER: HfFilter = "1.1";

export function parseHfFilter(v: string | null): HfFilter {
  return (HF_FILTERS as readonly string[]).includes(v ?? "") ? (v as HfFilter) : DEFAULT_HF_FILTER;
}

/** `max_health_factor` as a U128 string, undefined for "all". */
export function maxHfArg(f: HfFilter): string | undefined {
  if (f === "all") return undefined;
  const [w, d = ""] = f.split(".");
  return (BigInt(w) * WAD + BigInt(d.padEnd(18, "0").slice(0, 18) || "0")).toString();
}

export type AtRiskRow = BorrowerRow & { scenarioId: number; tier: Tier };

/** Liquidatable first, then health factor ascending (no debt last), then market, tier and account for a stable order. */
export function sortAtRisk(rows: readonly AtRiskRow[]): AtRiskRow[] {
  const rank = (r: AtRiskRow) => (r.liquidation === "liquidatable" ? 0 : 1);
  return [...rows].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const ha = a.healthFactor;
    const hb = b.healthFactor;
    if (ha !== hb) {
      if (ha === null) return 1;
      if (hb === null) return -1;
      return ha < hb ? -1 : 1;
    }
    return a.scenarioId - b.scenarioId || a.tier.localeCompare(b.tier) || a.accountId.localeCompare(b.accountId);
  });
}

/** The status chip of a row; a paused loan under HF 1 during the grace after an unpause reads "Grace". */
export const STATE_LABEL: Record<LiquidationState, string> = {
  none: "Healthy",
  liquidatable: "Liquidatable",
  paused: "Paused",
  paused_halted: "Result pending",
  paused_reference: "Price check",
  paused_no_price: "No price",
};

export function statusLabel(r: Pick<BorrowerRow, "liquidation" | "healthFactor">, graceSec: bigint): string {
  if (r.liquidation === "paused" && graceSec > 0n && r.healthFactor !== null && r.healthFactor < WAD) return "Grace";
  if (r.liquidation === "none" && r.healthFactor !== null && r.healthFactor < WAD) return "Below 1";
  return STATE_LABEL[r.liquidation];
}

/** The USDC a liquidation attaches: the repayment plus 0.1% (interest keeps accruing), in token units, rounded up. */
export function liquidationBudget(repay: bigint, decimals: number): bigint {
  return toTokenCeil(repay + repay / 1000n, decimals);
}

/** Cash mode's `min_out`: 1% under the quoted cash, never under the repayment (X15). */
export function cashMinOut(cash: bigint, repay: bigint): bigint {
  const lower = (cash * 9_900n) / 10_000n;
  return lower > repay ? lower : repay;
}

/** The share of every piece a partial seizure takes (`target / c_min`, WAD); undefined without collateral value. */
export const seizedShare = (target: bigint, cMin: bigint): bigint | undefined => (cMin > 0n ? (target * WAD) / cMin : undefined);

/** "wnear" / "usdc" are real pieces; anything else is a verse token id. */
export const realPiece = (piece: string): "wnear" | "usdc" | undefined => (piece === "wnear" || piece === "usdc" ? piece : undefined);

/**
 * Why the liquidate confirm cannot go now (the pause flag and grace are the TxButton's): an amount over the cap, a
 * quote error, no quote, a loan no longer liquidatable, a cash-out that would unprice a world or return less than the
 * repayment, or too little USDC.
 */
export function liquidateBlocker(p: {
  quote: LiquidationQuote | undefined;
  receive: "cash" | "tokens";
  walletUsdc: bigint;
  budgetInternal: bigint;
  amount?: bigint;
  quoteError?: string;
}): string | undefined {
  const q = p.quote;
  if (p.amount !== undefined && p.amount === 0n) return "Enter an amount";
  if (p.amount !== undefined && q && q.cap > 0n && p.amount > q.cap) return "More than can be repaid now: use Max";
  if (p.quoteError) return p.quoteError;
  if (!q) return "Getting a quote…";
  if (q.error) return humanError(q.error);
  if (q.liquidation !== "liquidatable") return "Not liquidatable now";
  if (q.repay === 0n) return "Nothing to repay";
  if (p.receive === "cash") {
    if (!q.cash) return "Getting a quote…";
    if (!q.cash.guardOk) return "Cash-out would unprice a world: use tokens";
    if (q.cash.cash < q.repay) return "Cash-out would return less than you repay; take tokens";
  }
  if (p.walletUsdc < p.budgetInternal) return "Not enough USDC in your wallet";
  return undefined;
}

/** "Max repays all of it": the cap is the whole debt (a loan under `small_loan`, or HF under `full_liquidation_hf`). */
export const maxRepaysAll = (q: Pick<LiquidationQuote, "cap" | "debt">): boolean => q.debt > 0n && q.cap >= q.debt;
