"use client";

// Reads of the market catalogue (proposals, pledges, checks) and of the operations views the Propose, Proposal and
// Admin screens use. Keys hold strings only; amounts go into keys as decimal strings.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CONTRACT_ID, readSource } from "../data/client";
import {
  decodeEventCheck,
  decodeEventMeta,
  decodeEvents,
  decodeFomcDates,
  decodeHoldings,
  decodeListMarkets,
  decodeMarketCheck,
  decodeMarketParams,
  decodeMarketsOf,
  decodeOutLayerConfig,
  decodePledgeOrNull,
  decodePledgePreview,
  decodePledges,
  decodeProposal,
  decodeProposalList,
  decodeReference,
  decodeReferenceConfig,
  decodeSeedPreview,
} from "../decode";
import type { EventState, MarketCard, OpeningTerms } from "../domain";
import type {
  EventCheckJson,
  EventMetaJson,
  EventViewJson,
  FomcDatesJson,
  ListMarketsJson,
  ListProposalsJson,
  MarketCheckJson,
  MarketParamsViewJson,
  MtTokenJson,
  OutLayerConfigJson,
  PledgePreviewJson,
  PledgeViewJson,
  ProposalViewJson,
  ReferenceConfigJson,
  ReferenceJson,
  SeedWithdrawPreviewJson,
} from "../types";
import type { Asset } from "../types";

const view = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> => (await readSource()).view<T>(CONTRACT_ID, method, args);

export const PROPOSAL_MS = 6_000;

/** `market_params()`: bonds, reserves, windows and limits; changes only by an owner setter. */
export function useMarketParams() {
  return useQuery({
    queryKey: ["marketParams", CONTRACT_ID],
    queryFn: async () => decodeMarketParams(await view<MarketParamsViewJson>("market_params")),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

/** `get_proposal(p)` with its opening preview; null for an unknown id. */
export function useProposal(pid: number | undefined) {
  return useQuery({
    queryKey: ["proposal", CONTRACT_ID, String(pid)],
    enabled: pid !== undefined,
    queryFn: async () => decodeProposal(await view<ProposalViewJson | null>("get_proposal", { proposal_id: pid })),
    refetchInterval: PROPOSAL_MS,
  });
}

export function usePledge(pid: number | undefined, account: string | null) {
  return useQuery({
    queryKey: ["pledge", CONTRACT_ID, String(pid), account ?? ""],
    enabled: pid !== undefined && Boolean(account),
    queryFn: async () => decodePledgeOrNull(await view<PledgeViewJson | null>("pledge_of", { proposal_id: pid, account_id: account })),
    refetchInterval: PROPOSAL_MS,
  });
}

export function usePledges(account: string | null) {
  return useQuery({
    queryKey: ["pledges", CONTRACT_ID, account ?? ""],
    enabled: Boolean(account),
    queryFn: async () => decodePledges(await view<PledgeViewJson[]>("pledges_of", { account_id: account })),
    refetchInterval: 15_000,
  });
}

/** `markets_of(account)`: the markets the account has a position in. */
export function useMarketsOf(account: string | null) {
  return useQuery({
    queryKey: ["marketsOf", CONTRACT_ID, account ?? ""],
    enabled: Boolean(account),
    queryFn: async () => decodeMarketsOf(await view<number[]>("markets_of", { account_id: account })),
    refetchInterval: 30_000,
  });
}

/** What a pledge would change; the view refuses an amount it cannot take, which is an answer, not a failure. */
export function usePledgePreview(pid: number | undefined, asset: Asset, amount: bigint | undefined) {
  return useQuery({
    queryKey: ["pledgePreview", CONTRACT_ID, String(pid), asset, amount?.toString() ?? ""],
    enabled: pid !== undefined && amount !== undefined && amount > 0n,
    queryFn: async () => decodePledgePreview(await view<PledgePreviewJson>("pledge_preview", { proposal_id: pid, asset, amount: amount!.toString() })),
    refetchInterval: PROPOSAL_MS,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** What a seed withdrawal of `shares` (null = all) pays now, per world. */
export function useSeedPreview(pid: number | undefined, account: string | null, shares: bigint | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["seedPreview", CONTRACT_ID, String(pid), account ?? "", shares === null ? "all" : (shares?.toString() ?? "")],
    enabled: enabled && pid !== undefined && Boolean(account) && shares !== undefined,
    queryFn: async () =>
      decodeSeedPreview(
        await view<SeedWithdrawPreviewJson>("preview_seed_withdraw", { proposal_id: pid, account_id: account, shares: shares === null ? null : shares!.toString() }),
      ),
    refetchInterval: PROPOSAL_MS,
    retry: false,
  });
}

export type ProposalFilter = "live" | "review" | "pledging" | "opened" | "closed" | "all";

/** `list_proposals`, newest first. */
export function useProposalList(filter: ProposalFilter, limit = 30, enabled = true) {
  return useQuery({
    queryKey: ["proposals", CONTRACT_ID, filter, String(limit)],
    enabled,
    queryFn: async () => decodeProposalList(await view<ListProposalsJson>("list_proposals", { from_id: null, limit, filter })),
    refetchInterval: 15_000,
  });
}

/** `market_check(event_ids)` for a combination of one to three events. */
export function useMarketCheck(eventIds: readonly number[]) {
  const key = [...eventIds].sort((a, b) => a - b).join(",");
  return useQuery({
    queryKey: ["marketCheck", CONTRACT_ID, key],
    enabled: eventIds.length > 0,
    queryFn: async () => decodeMarketCheck(await view<MarketCheckJson>("market_check", { event_ids: key.split(",").map(Number) })),
    refetchInterval: 20_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** `event_check(question, terms, deadline)`: the goal and opening prices a new event would get. */
export function useEventCheck(args: { question: string; terms: OpeningTerms; deadlineSec: number } | undefined) {
  return useQuery({
    queryKey: ["eventCheck", CONTRACT_ID, args ? JSON.stringify(args) : ""],
    enabled: Boolean(args),
    queryFn: async () =>
      decodeEventCheck(
        await view<EventCheckJson>("event_check", {
          question: args!.question,
          terms: { odds0_bps: args!.terms.odds0Bps, mult_bps: args!.terms.multBps },
          deadline_sec: args!.deadlineSec,
        }),
      ),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Every market of the registry (listed only by default), paged through `next_from`. */
export function useAllMarkets(listedOnly = true) {
  return useQuery({
    queryKey: ["allMarkets", CONTRACT_ID, listedOnly ? "listed" : "all"],
    queryFn: async (): Promise<MarketCard[]> => {
      const out: MarketCard[] = [];
      let from: number | null = null;
      for (let page = 0; page < 10; page++) {
        const list = decodeListMarkets(await view<ListMarketsJson>("list_markets", { from_id: from, limit: 50, listed_only: listedOnly }));
        out.push(...list.markets);
        if (list.nextFrom === null) break;
        from = list.nextFrom;
      }
      return out;
    },
    staleTime: 20_000,
    refetchInterval: 60_000,
  });
}

/** `get_events` (at most 24 per call). */
export function useEvents(ids: readonly number[]) {
  const key = [...new Set(ids)].sort((a, b) => a - b);
  return useQuery({
    queryKey: ["events", CONTRACT_ID, key.join(",")],
    enabled: key.length > 0,
    queryFn: async (): Promise<EventState[]> => {
      const out: EventState[] = [];
      for (let i = 0; i < key.length; i += 24) out.push(...decodeEvents(await view<EventViewJson[]>("get_events", { event_ids: key.slice(i, i + 24) })));
      return out;
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

/** `event_meta(e)`: the event's public data source and category (null for events without one). */
export function useEventMeta(eventId: number | undefined) {
  return useQuery({
    queryKey: ["eventMeta", CONTRACT_ID, String(eventId)],
    enabled: eventId !== undefined,
    queryFn: async () => decodeEventMeta(await view<EventMetaJson | null>("event_meta", { event_id: eventId })),
    staleTime: 300_000,
    retry: 1,
  });
}

/** `get_outlayer_dates(e)`: the FOMC dates an event resolves from through OutLayer, and a pending request. */
export function useOutLayerDates(eventId: number | undefined, enabled = true) {
  return useQuery({
    queryKey: ["outlayerDates", CONTRACT_ID, String(eventId)],
    enabled: enabled && eventId !== undefined,
    queryFn: async () => decodeFomcDates(await view<FomcDatesJson | null>("get_outlayer_dates", { event_id: eventId })),
    refetchInterval: (q) => (q.state.data?.pending ? 10_000 : 60_000),
    retry: 1,
  });
}

export function useOutLayerConfig() {
  return useQuery({
    queryKey: ["outlayerConfig", CONTRACT_ID],
    queryFn: async () => decodeOutLayerConfig(await view<OutLayerConfigJson | null>("get_outlayer_config")),
    staleTime: 300_000,
    retry: 1,
  });
}

/** `get_reference()`: the stored NEAR/USD reference price. */
export function useReference() {
  return useQuery({
    queryKey: ["reference", CONTRACT_ID],
    queryFn: async () => decodeReference(await view<ReferenceJson | null>("get_reference")),
    refetchInterval: (q) => (q.state.data?.pending ? 5_000 : 30_000),
    retry: 1,
  });
}

export function useReferenceConfig() {
  return useQuery({
    queryKey: ["referenceConfig", CONTRACT_ID],
    queryFn: async () => decodeReferenceConfig(await view<ReferenceConfigJson | null>("get_reference_config")),
    staleTime: 300_000,
    retry: 1,
  });
}

/** The account's verse tokens with a balance (`mt_tokens_for_owner` + `mt_batch_balance_of`), first 200. */
export function useHoldings(account: string | null) {
  return useQuery({
    queryKey: ["holdings", CONTRACT_ID, account ?? ""],
    enabled: Boolean(account),
    queryFn: async () => {
      const tokens = await view<MtTokenJson[]>("mt_tokens_for_owner", { account_id: account, from_index: null, limit: 200 });
      const ids = tokens.map((t) => t.token_id);
      const balances = ids.length ? await view<string[]>("mt_batch_balance_of", { account_id: account, token_ids: ids }) : [];
      return decodeHoldings(tokens, balances);
    },
    refetchInterval: 15_000,
  });
}

/** `verse_label(scenario, mask)`: "SHIPS", "SHIPS·YES" or "0b0110"; never changes for a market. */
export function useVerseLabel(scenarioId: number, mask: number) {
  return useQuery({
    queryKey: ["verseLabel", CONTRACT_ID, String(scenarioId), String(mask)],
    queryFn: async () => view<string>("verse_label", { scenario_id: scenarioId, mask }),
    staleTime: Infinity,
    retry: 1,
  });
}
