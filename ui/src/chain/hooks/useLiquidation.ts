"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CONTRACT_ID } from "../data/client";
import { decodeBorrowers, decodeHoldings, decodeLiquidationQuote } from "../decode";
import type { Holding, LendingTier, Tier } from "../domain";
import { sortAtRisk, type AtRiskRow } from "../liquidation";
import { withTier } from "../near/tx";
import type { BorrowersPageJson, LiquidationQuoteJson, MtTokenJson } from "../types";
import { fetchLendingTiers, view } from "./useLending";

const PAGE = 50;
const MAX_PAGES = 10;

/** Every borrower of one tier below `maxHf` (all of them without), page by page. */
async function borrowersOf(sid: number, tier: Tier, maxHf: string | undefined): Promise<AtRiskRow[]> {
  const rows: AtRiskRow[] = [];
  let from = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = decodeBorrowers(
      await view<BorrowersPageJson>("borrowers", withTier({ scenario_id: sid, from_index: from, limit: PAGE, max_health_factor: maxHf }, tier)),
    );
    rows.push(...page.rows.map((r) => ({ ...r, scenarioId: sid, tier })));
    if (page.nextIndex === null) break;
    from = page.nextIndex;
  }
  return rows;
}

export type AtRisk = { rows: AtRiskRow[]; markets: number; tiersWithLoans: number; unreadable: number[] };

/**
 * The At-risk page's discovery (web design 6.10): every market (or only `onlySid`) → its tiers → the borrowers of
 * each tier that has any, below `maxHf`. A market whose tiers cannot be read is skipped and named.
 */
export function useAtRisk(onlySid: number | undefined, maxHf: string | undefined) {
  return useQuery({
    queryKey: ["atRisk", CONTRACT_ID, onlySid === undefined ? "" : String(onlySid), maxHf ?? "all"],
    queryFn: async (): Promise<AtRisk> => {
      const sids = onlySid !== undefined ? [onlySid] : Array.from({ length: Number(await view<number>("scenario_count")) }, (_, i) => i + 1);
      const unreadable: number[] = [];
      const tiers = await Promise.all(
        sids.map((sid) =>
          fetchLendingTiers(sid, null).catch(() => {
            unreadable.push(sid);
            return [] as LendingTier[];
          }),
        ),
      );
      const jobs = sids.flatMap((sid, i) => tiers[i].filter((t) => t.market.borrowers > 0).map((t) => ({ sid, tier: t.tier })));
      const pages = await Promise.all(jobs.map((j) => borrowersOf(j.sid, j.tier, maxHf)));
      return { rows: sortAtRisk(pages.flat()), markets: sids.length, tiersWithLoans: jobs.length, unreadable: unreadable.sort((a, b) => a - b) };
    },
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });
}

/** `liquidation_quote`: what `liquidate` would do now. Debounce the amount before passing it. */
export function useLiquidationQuote(p: { sid: number; account: string; tier: Tier; repay: "max" | bigint | undefined; receive: "cash" | "tokens" }) {
  const repay = p.repay === undefined ? undefined : p.repay === "max" ? "max" : p.repay.toString();
  return useQuery({
    queryKey: ["liqQuote", CONTRACT_ID, String(p.sid), p.account, p.tier, repay ?? "", p.receive],
    enabled: repay !== undefined,
    queryFn: async () =>
      decodeLiquidationQuote(
        await view<LiquidationQuoteJson>(
          "liquidation_quote",
          withTier({ scenario_id: p.sid, account_id: p.account, repay_amount: repay, receive: p.receive }, p.tier),
        ),
      ),
    refetchInterval: 6_000,
    placeholderData: keepPreviousData,
  });
}

/** Every verse token the account holds (NEP-245 `mt_tokens_for_owner`, then the balances), zeros dropped. */
export function useHoldings(account: string | null) {
  return useQuery({
    queryKey: ["holdings", CONTRACT_ID, account ?? ""],
    enabled: Boolean(account),
    queryFn: async (): Promise<Holding[]> => {
      const tokens: MtTokenJson[] = [];
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await view<MtTokenJson[]>("mt_tokens_for_owner", { account_id: account, from_index: String(tokens.length), limit: PAGE });
        tokens.push(...page);
        if (page.length < PAGE) break;
      }
      if (tokens.length === 0) return [];
      const balances = await view<string[]>("mt_batch_balance_of", { account_id: account, token_ids: tokens.map((t) => t.token_id) });
      return decodeHoldings(tokens, balances);
    },
    refetchInterval: 15_000,
  });
}

/** A verse token's world label ("SHIPS·CUTS", "ANY"); labels never change. */
export function useVerseLabel(sid: number, mask: number, enabled = true) {
  return useQuery({
    queryKey: ["label", CONTRACT_ID, String(sid), String(mask)],
    enabled,
    queryFn: () => view<string>("verse_label", { scenario_id: sid, mask }),
    staleTime: Infinity,
    retry: 1,
  });
}
