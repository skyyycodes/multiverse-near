"use client";

import type { Scenario } from "../domain";
import { bestPlan, cellBook, saleCandidates, type Order, type WorldPlan } from "../orders";
import { usePartQuotes, type Part } from "./useData";

export type SalePlan = {
  /** Per world index: the plan for a sold world (orders first, then the pool); undefined for worlds not sold, and for
   *  a sold world without any price once `ready`. */
  plans: (WorldPlan | undefined)[];
  /** Every quote the plans need has arrived. */
  ready: boolean;
};

/**
 * The router's plan for a conditional sale of `amount` in every world of `sellMask`: resting bids first, best price
 * first, while each beats what the pool pays for the slice it takes; the rest goes to the pool. `poolQuote` is
 * `quote_sell` for the whole amount (the pool alone, candidate 0); every other candidate's pool part comes from one
 * `quote_sell_parts` call. The account's own orders are skipped.
 */
export function useSalePlan(
  scenario: Scenario,
  sellMask: number,
  amount: bigint | undefined,
  poolQuote: readonly bigint[] | undefined,
  orders: readonly Order[],
  me: string | null,
  nowSec: bigint,
): SalePlan {
  const state = { scenarioId: scenario.scenarioId, possible: scenario.possible, resolutionCount: scenario.resolutionCount };
  const mine = me?.toLowerCase();
  const candidates = scenario.worlds.map((w) => {
    if (!amount || (sellMask & w.mask) === 0 || !w.possible) return undefined;
    const bids = cellBook(orders, state, w.mask, nowSec).bids.filter((o) => o.maker.toLowerCase() !== mine);
    return saleCandidates(bids, amount);
  });
  const needed: Part[] = candidates.flatMap((cs, w) =>
    (cs ?? []).slice(1).flatMap((c) => (c.poolAmount > 0n ? [{ world: w, amount: c.poolAmount }] : [])),
  );
  const parts = usePartQuotes(scenario.scenarioId, needed);
  const plans = candidates.map((cs, w) =>
    cs ? bestPlan(cs, (x) => (x === amount ? poolQuote?.[w] : parts.data?.[`${w}:${x}`])) : undefined,
  );
  return { plans, ready: poolQuote !== undefined && (needed.length === 0 || parts.data !== undefined) };
}
