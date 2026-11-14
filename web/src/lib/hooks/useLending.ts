"use client";

import { useQuery } from "@tanstack/react-query";
import { CONTRACT_ID, readSource } from "../data/client";
import { decodeLendingTiers, decodePriceCheck, decodeReference, decodeReferenceConfig } from "../decode";
import type { LendingTier } from "../domain";
import type { LendingTierJson, PriceCheckJson, ReferenceConfigJson, ReferenceJson } from "../types";
import { keepWithin } from "./useData";

export const view = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> => (await readSource()).view<T>(CONTRACT_ID, method, args);

/** `lending_tiers`: the three tiers of a market (Safe, Normal, Bold) and, with an account, its position in each. */
export const fetchLendingTiers = async (sid: number, account: string | null): Promise<LendingTier[]> =>
  decodeLendingTiers(await view<LendingTierJson[]>("lending_tiers", { scenario_id: sid, account_id: account }));

export function useLendingTiers(sid: number | undefined, account: string | null) {
  return useQuery({
    queryKey: ["tiers", CONTRACT_ID, String(sid), account ?? ""],
    enabled: sid !== undefined,
    queryFn: () => fetchLendingTiers(sid!, account),
    refetchInterval: 8_000,
    placeholderData: keepWithin(sid),
  });
}

/** `price_check`: the outside NEAR/USD check behind new borrowing (and the liquidation guard). */
export function usePriceCheck(sid: number | undefined) {
  return useQuery({
    queryKey: ["priceCheck", CONTRACT_ID, String(sid)],
    enabled: sid !== undefined,
    queryFn: async () => decodePriceCheck(await view<PriceCheckJson>("price_check", { scenario_id: sid })),
    refetchInterval: 15_000,
    retry: 1,
  });
}

export function useReference(enabled = true) {
  return useQuery({
    queryKey: ["reference", CONTRACT_ID],
    enabled,
    queryFn: async () => decodeReference(await view<ReferenceJson | null>("get_reference")),
    refetchInterval: (q) => (q.state.data?.pending ? 5_000 : 30_000),
    retry: 1,
  });
}

export function useReferenceConfig(enabled = true) {
  return useQuery({
    queryKey: ["referenceConfig", CONTRACT_ID],
    enabled,
    queryFn: async () => decodeReferenceConfig(await view<ReferenceConfigJson | null>("get_reference_config")),
    staleTime: 300_000,
    retry: 1,
  });
}
