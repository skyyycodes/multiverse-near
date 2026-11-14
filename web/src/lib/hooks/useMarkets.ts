"use client";

// Reads of the market list and the market page (web 4.7): the registry's cards, event texts, related markets, live
// proposals, the account's markets and pledges, the outside NEAR/USD reference and a market's price check.
import { useQuery } from "@tanstack/react-query";
import { CONTRACT_ID, readSource } from "../data/client";
import {
  decodeEvent,
  decodeEventMeta,
  decodeListMarkets,
  decodeMarketCards,
  decodeMarketsOf,
  decodePledges,
  decodePriceCheck,
  decodeProposalList,
  decodeReference,
  decodeRelated,
} from "../decode";
import type { EventMeta, EventState, MarketCard, Pledge, PriceCheck, ProposalSummary, Reference, RelatedMarkets } from "../domain";
import { chunks } from "../market";
import type {
  EventMetaJson,
  EventViewJson,
  ListMarketsJson,
  ListProposalsJson,
  MarketCardJson,
  PledgeViewJson,
  PriceCheckJson,
  ReferenceJson,
  RelatedMarketsJson,
} from "../types";
import { isMethodNotFound } from "../version";

const view = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> => (await readSource()).view<T>(CONTRACT_ID, method, args);

/** Cards per `list_markets` page; the view scans at most 128 ids per call, so a page can come back short. */
export const MARKET_PAGE = 12;
/** At most this many pages per refresh (120 cards). */
export const MAX_MARKET_PAGES = 10;

/** Every listed market's card, page after page until `next_from` is null (at most 120), every 20 s. */
export function useMarketList(listedOnly = true) {
  return useQuery({
    queryKey: ["markets", CONTRACT_ID, String(listedOnly)],
    queryFn: async (): Promise<MarketCard[]> => {
      const out: MarketCard[] = [];
      let from: number | null = null;
      for (let page = 0; page < MAX_MARKET_PAGES; page++) {
        const list = decodeListMarkets(await view<ListMarketsJson>("list_markets", { from_id: from, limit: MARKET_PAGE, listed_only: listedOnly }));
        out.push(...list.markets);
        if (list.nextFrom === null) break;
        from = list.nextFrom;
      }
      return out;
    },
    refetchInterval: 20_000,
    retry: 2,
  });
}

/** Cards of the given markets (`market_cards`, 12 ids per call), every 30 s; unknown ids are skipped by the view. */
export function useMarketCards(ids: readonly number[]) {
  return useQuery({
    queryKey: ["cards", CONTRACT_ID, ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async (): Promise<MarketCard[]> => {
      const pages = await Promise.all(chunks(ids, 12).map((c) => view<MarketCardJson[]>("market_cards", { scenario_ids: c })));
      return pages.flatMap((p) => decodeMarketCards(p));
    },
    refetchInterval: 30_000,
  });
}

/** Events by id (`get_events`, 24 per call; `get_event` one by one on a contract without it), every 30 s. */
export function useEventTexts(ids: readonly number[]) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  return useQuery({
    queryKey: ["events", CONTRACT_ID, sorted.join(",")],
    enabled: sorted.length > 0,
    queryFn: async (): Promise<Map<number, EventState>> => {
      let rows: EventViewJson[];
      try {
        rows = (await Promise.all(chunks(sorted, 24).map((c) => view<EventViewJson[]>("get_events", { event_ids: c })))).flat();
      } catch (e) {
        if (!isMethodNotFound(e instanceof Error ? e.message : String(e))) throw e;
        rows = await Promise.all(sorted.map((id) => view<EventViewJson>("get_event", { event_id: id })));
      }
      return new Map(rows.map((r) => decodeEvent(r)).map((e) => [e.id, e]));
    },
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });
}

/** `event_meta`: source and category of an event (null for one without), texts that never change. */
export function useEventMeta(id: number | undefined) {
  return useQuery({
    queryKey: ["eventMeta", CONTRACT_ID, String(id)],
    enabled: id !== undefined,
    queryFn: async (): Promise<EventMeta | null> => decodeEventMeta(await view<EventMetaJson | null>("event_meta", { event_id: id })),
    staleTime: 300_000,
    retry: 1,
  });
}

/** Listed markets sharing an event with this one, and the live proposals on its events, every 30 s. */
export function useRelated(sid: number | undefined, enabled = true) {
  return useQuery({
    queryKey: ["related", CONTRACT_ID, String(sid)],
    enabled: enabled && sid !== undefined,
    queryFn: async (): Promise<RelatedMarkets> => decodeRelated(await view<RelatedMarketsJson>("related_markets", { scenario_id: sid })),
    refetchInterval: 30_000,
  });
}

/** Markets the account holds anything in (`markets_of`), every 30 s. */
export function useMarketsOf(account: string | null) {
  return useQuery({
    queryKey: ["marketsOf", CONTRACT_ID, account ?? ""],
    enabled: Boolean(account),
    queryFn: async (): Promise<number[]> => decodeMarketsOf(await view<number[]>("markets_of", { account_id: account })),
    refetchInterval: 30_000,
  });
}

/** The account's pledges (`pledges_of`), every 15 s. */
export function useAccountPledges(account: string | null) {
  return useQuery({
    queryKey: ["pledges", CONTRACT_ID, account ?? ""],
    enabled: Boolean(account),
    queryFn: async (): Promise<Pledge[]> => decodePledges(await view<PledgeViewJson[]>("pledges_of", { account_id: account })),
    refetchInterval: 15_000,
  });
}

/** Proposals still in review or collecting pledges, newest first (pages of 20, at most 5), every 15 s. */
export function useLiveProposals() {
  return useQuery({
    queryKey: ["proposals", CONTRACT_ID, "live"],
    queryFn: async (): Promise<ProposalSummary[]> => {
      const out: ProposalSummary[] = [];
      let from: number | null = null;
      for (let page = 0; page < 5; page++) {
        const list = decodeProposalList(await view<ListProposalsJson>("list_proposals", { from_id: from, limit: 20, filter: "live" }));
        out.push(...list.proposals);
        if (list.nextFrom === null) break;
        from = list.nextFrom;
      }
      return out;
    },
    refetchInterval: 15_000,
  });
}

/** The outside NEAR/USD reference (null before its first price), every 30 s. */
export function useReference() {
  return useQuery({
    queryKey: ["reference", CONTRACT_ID],
    queryFn: async (): Promise<Reference | null> => decodeReference(await view<ReferenceJson | null>("get_reference")),
    refetchInterval: 30_000,
    retry: 1,
  });
}

/** A market's outside price check (`price_check`), every 15 s. */
export function usePriceCheck(sid: number | undefined) {
  return useQuery({
    queryKey: ["priceCheck", CONTRACT_ID, String(sid)],
    enabled: sid !== undefined,
    queryFn: async (): Promise<PriceCheck> => decodePriceCheck(await view<PriceCheckJson>("price_check", { scenario_id: sid })),
    refetchInterval: 15_000,
    retry: 1,
  });
}
