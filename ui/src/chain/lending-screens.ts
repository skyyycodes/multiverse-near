"use client";

// The reads Borrow, Lend, At-risk loans and Portfolio add to the adapter: every tier of several markets at once (the
// same cache as `useLendingTiers`), the account's open orders across markets, and what the account holds in each
// market's worlds (verse tokens plus the collateral of every tier), with that market's prices and odds.
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ChainMarket } from "./adapter-model";
import { CONTRACT_ID } from "./data/client";
import { decodeOrder } from "./decode";
import type { Holding, LendingTier } from "./domain";
import { fetchLendingTiers, view } from "./hooks/useLending";
import { addWorlds, byWorld, oddsWeighted, worldWorth, futuresRange, type ByWorld } from "./lending-view";
import type { Order } from "./orders";
import type { OrderViewJson } from "./types";

/** `lending_tiers` of each market (with the account's position in each tier), keyed by market id; every 8 s. */
export function useTiersOf(sids: readonly number[], account: string | null): { tiers: Map<number, LendingTier[]>; loading: boolean; error: Error | null } {
  const qs = useQueries({
    queries: sids.map((sid) => ({
      queryKey: ["tiers", CONTRACT_ID, String(sid), account ?? ""],
      queryFn: () => fetchLendingTiers(sid, account),
      refetchInterval: 8_000,
      retry: 1,
    })),
  });
  const data = qs.map((q) => q.data);
  const key = data.map((d) => (d ? "1" : "0")).join("") + qs.map((q) => q.dataUpdatedAt).join(",");
  const tiers = useMemo(() => {
    const m = new Map<number, LendingTier[]>();
    sids.forEach((sid, i) => {
      const d = data[i];
      if (d) m.set(sid, d);
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sids.join(","), key]);
  return { tiers, loading: qs.some((q) => q.isLoading), error: qs.find((q) => q.error)?.error ?? null };
}

/** The account's open orders in each market (`orders_by_maker`), newest first; every 10 s. */
export function useOpenOrders(sids: readonly number[], account: string | null): { orders: Order[] | undefined; error: Error | null } {
  const qs = useQueries({
    queries: (account ? sids : []).map((sid) => ({
      queryKey: ["makerOrders", CONTRACT_ID, String(sid), account ?? ""],
      queryFn: async () => (await view<OrderViewJson[]>("orders_by_maker", { account_id: account, scenario_id: sid })).map(decodeOrder),
      refetchInterval: 10_000,
      retry: 1,
    })),
  });
  const ready = qs.every((q) => q.data !== undefined);
  const stamp = qs.map((q) => q.dataUpdatedAt).join(",");
  const orders = useMemo(
    () => (ready ? qs.flatMap((q) => q.data ?? []).filter((o) => !o.cancelled && o.remaining > 0n).sort((a, b) => (a.id < b.id ? 1 : -1)) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, stamp],
  );
  return { orders: account ? orders : [], error: qs.find((q) => q.error)?.error ?? null };
}

/** One market as the portfolio sees it: what is held in each world (verse tokens and every tier's collateral). */
export type MarketHoldings = {
  market: ChainMarket;
  /** Verse tokens in the wallet, per world. */
  wallet: ByWorld;
  /** Collateral posted in any tier, per world (real pieces pay in every world). */
  posted: ByWorld;
  /** Both together. */
  held: ByWorld;
  /** Owed in the market, every tier together. */
  debt: bigint;
  /** Supplied to the market's lending tiers. */
  supplied: bigint;
  /** What the account ends with in each world (held at that world's NEAR price, less the debt). */
  values: bigint[];
  /** The chance-weighted value of the worlds above. */
  average: bigint;
  worst: number | undefined;
  best: number | undefined;
  /** The lowest health factor of a loan in the market (null without one). */
  lowestHealth: bigint | null;
  tiers: LendingTier[];
};

/** Per-world holdings of a market from the account's verse tokens and its lending tiers. */
export function marketHoldings(market: ChainMarket, tokens: readonly Holding[], tiers: readonly LendingTier[]): MarketHoldings {
  const n = market.worldCount;
  const wallet = byWorld(tokens.filter((t) => t.scenarioId === market.sid), n, market.possible);
  const pieces = tiers.flatMap((t) => t.account?.collateral ?? []);
  const posted = byWorld(pieces, n, market.possible);
  const held = addWorlds(wallet, posted);
  const debt = tiers.reduce((s, t) => s + (t.account?.debt ?? 0n), 0n);
  const supplied = tiers.reduce((s, t) => s + (t.account?.supplied ?? 0n), 0n);
  const prices = market.worlds.map((w) => w.price);
  const values = worldWorth(held, prices, debt, market.possible);
  const range = futuresRange(values, market.possible);
  const hfs = tiers.map((t) => (t.account && t.account.debt > 0n ? t.account.healthFactor : null)).filter((h): h is bigint => h !== null);
  return {
    market,
    wallet,
    posted,
    held,
    debt,
    supplied,
    values,
    average: oddsWeighted(values, market.worlds.map((w) => w.odds), market.possible),
    worst: range?.worst,
    best: range?.best,
    lowestHealth: hfs.length ? hfs.reduce((m, h) => (h < m ? h : m)) : null,
    tiers: [...tiers],
  };
}

/** Anything at all in a market: a world piece, collateral, a loan or a supply. */
export const holdsAnything = (h: MarketHoldings): boolean =>
  h.debt > 0n || h.supplied > 0n || h.held.near.some((x) => x > 0n) || h.held.usdc.some((x) => x > 0n);
