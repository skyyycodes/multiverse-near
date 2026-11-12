"use client";

import { keepPreviousData, useQuery, type Query } from "@tanstack/react-query";
import { CONTRACT_ID, readSource } from "../data/client";
import { ENV } from "../env";
import {
  big,
  decodeAdmin,
  decodeBorrow,
  decodeConfig,
  decodeLend,
  decodeLpPreview,
  decodeResolve,
  decodeTrade,
} from "../decode";
import type { AppConfig, TokenCfg } from "../domain";
import type {
  AdminViewJson,
  AppConfigView,
  BorrowViewJson,
  LendViewJson,
  LpPreviewJson,
  PoolViewJson,
  ResolveViewJson,
  StorageBalance,
  StorageBounds,
  TradeViewJson,
} from "../types";
import { cellQuotes, type CellQuote } from "../orders";
import { toInternal } from "../units";
import { useNowSeconds } from "./useClock";
import { useScenarioChoice } from "./useScenario";

/** Snapshots every 4 s, quotes every 6 s. */
export const POLL_MS = 4_000;
export const QUOTE_MS = 6_000;

const view = async <T>(method: string, args: Record<string, unknown> = {}, contractId = CONTRACT_ID): Promise<T> =>
  (await readSource()).view<T>(contractId, method, args);

/**
 * Keep the previous snapshot on screen while a new one loads only when it belongs to the same scenario: switching
 * scenarios shows the loading state, never another scenario's numbers. Keys hold strings only (no bigint).
 */
function keepWithin(sid: number | undefined) {
  return <T>(prev: T | undefined, prevQuery: Query<T, Error, T, readonly unknown[]> | undefined) =>
    prevQuery && prevQuery.queryKey[2] === String(sid) ? prev : undefined;
}

/** The contract names its tokens; a build made for another deployment must not quietly read balances elsewhere. */
export function checkTokens(c: AppConfig): AppConfig {
  for (const [token, expected] of [
    [c.wnear, ENV.wnearId],
    [c.usdc, ENV.usdcId],
  ] as const) {
    if (expected && token.tokenId !== expected) {
      throw new Error(`${CONTRACT_ID} uses ${token.tokenId} for ${token.symbol}, but this build was made for ${expected}. Rebuild for this deployment.`);
    }
  }
  return c;
}

export function useAppConfig() {
  return useQuery({
    queryKey: ["config", CONTRACT_ID],
    queryFn: async (): Promise<AppConfig> => checkTokens(decodeConfig(await view<AppConfigView>("get_app_config"))),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 2,
  });
}

/** The scenario id the screens show, from the on-chain demo record. */
export function useScenarioId(config: AppConfig | undefined): number | undefined {
  const { which } = useScenarioChoice();
  const id = which === "2x2" ? config?.demo?.scenario2x2 : config?.demo?.scenarioBinary;
  return id ?? undefined;
}

export function useTrade(sid: number | undefined, account: string | null) {
  return useQuery({
    queryKey: ["trade", CONTRACT_ID, String(sid), account ?? ""],
    enabled: sid !== undefined,
    queryFn: async () => decodeTrade(await view<TradeViewJson>("trade_view", { scenario_id: sid, account_id: account })),
    refetchInterval: POLL_MS,
    placeholderData: keepWithin(sid),
  });
}

export function useBorrow(sid: number | undefined, account: string | null) {
  return useQuery({
    queryKey: ["borrow", CONTRACT_ID, String(sid), account ?? ""],
    enabled: sid !== undefined,
    queryFn: async () => decodeBorrow(await view<BorrowViewJson>("borrow_view", { scenario_id: sid, account_id: account })),
    refetchInterval: POLL_MS,
    placeholderData: keepWithin(sid),
  });
}

export function useLend(sid: number | undefined, account: string | null) {
  return useQuery({
    queryKey: ["lend", CONTRACT_ID, String(sid), account ?? ""],
    enabled: sid !== undefined,
    queryFn: async () => decodeLend(await view<LendViewJson>("lend_view", { scenario_id: sid, account_id: account })),
    refetchInterval: POLL_MS,
    placeholderData: keepWithin(sid),
  });
}

/** Resolve and admin poll every 2 s while a proposal is open, so the countdown and Finalize track the chain. */
export function useResolve(sid: number | undefined, account: string | null) {
  return useQuery({
    queryKey: ["resolve", CONTRACT_ID, String(sid), account ?? ""],
    enabled: sid !== undefined,
    queryFn: async () => decodeResolve(await view<ResolveViewJson>("resolve_view", { scenario_id: sid, account_id: account })),
    refetchInterval: (q) => {
      const d = q.state.data;
      const open = d && [...d.events, ...(d.pastFedEvent ? [d.pastFedEvent] : [])].some((e) => e.proposalOpen);
      return open ? 2_000 : POLL_MS;
    },
    placeholderData: keepWithin(sid),
  });
}

export function useAdmin(sid: number | undefined, account: string | null) {
  return useQuery({
    queryKey: ["admin", CONTRACT_ID, String(sid), account ?? ""],
    enabled: sid !== undefined,
    queryFn: async () => decodeAdmin(await view<AdminViewJson>("admin_view", { scenario_id: sid, account_id: account })),
    refetchInterval: (q) => {
      const d = q.state.data;
      const open = d && [...d.events, ...(d.pastFedEvent ? [d.pastFedEvent] : [])].some((e) => e.proposalOpen);
      return open ? 2_000 : POLL_MS;
    },
    placeholderData: keepWithin(sid),
  });
}

/**
 * Every world's best bid and ask from the scenario's order book (the trade view), for the grids and lists of any
 * screen; undefined while it loads or when the deployment has no order book. Screens share the trade query's cache.
 */
export function useCellQuotes(config: AppConfig, sid: number | undefined, account: string | null): CellQuote[] | undefined {
  const trade = useTrade(config.orderBook ? sid : undefined, account);
  const now = useNowSeconds();
  const d = trade.data;
  return d && config.orderBook ? cellQuotes(d.orders, d.scenario, now) : undefined;
}

/** Whether a result is waiting out its dispute window in this scenario (the header's status bell). */
export function useHalted(sid: number | undefined) {
  return useQuery({
    queryKey: ["halted", CONTRACT_ID, String(sid)],
    enabled: sid !== undefined,
    queryFn: async () => view<boolean>("is_halted", { scenario_id: sid }),
    refetchInterval: 8_000,
    retry: 1,
  });
}

/** Pool proceeds of selling `amount` NEAR in every world of `mask` (0 where unsold, dead, unpooled or failing). */
export function useQuoteSell(sid: number | undefined, amount: bigint | undefined, mask: number, enabled = true) {
  return useQuery({
    queryKey: ["quote", CONTRACT_ID, String(sid), amount?.toString() ?? "", String(mask)],
    enabled: enabled && sid !== undefined && amount !== undefined && amount > 0n && mask !== 0,
    queryFn: async () =>
      (await view<string[]>("quote_sell", { scenario_id: sid, wnear_amount: amount!.toString(), sell_mask: mask })).map(big),
    refetchInterval: QUOTE_MS,
  });
}

export type Part = { world: number; amount: bigint };

/** What the pool pays for each part of a sale that orders do not cover, keyed `${world}:${amount}`. */
export function usePartQuotes(sid: number | undefined, parts: readonly Part[]) {
  const key = parts.map((p) => `${p.world}:${p.amount}`).join(",");
  return useQuery({
    queryKey: ["quoteParts", CONTRACT_ID, String(sid), key],
    enabled: sid !== undefined && parts.length > 0,
    queryFn: async () => {
      const out = await view<string[]>("quote_sell_parts", {
        scenario_id: sid,
        parts: parts.map((p) => ({ world: p.world, wnear_amount: p.amount.toString() })),
      });
      const map: Record<string, bigint> = {};
      parts.forEach((p, i) => {
        map[`${p.world}:${p.amount}`] = big(out[i]);
      });
      return map;
    },
    refetchInterval: QUOTE_MS,
  });
}

export type Balances = {
  /** NEP-141 wallet balances, already in 18-decimal internal units. */
  wnear: bigint;
  usdc: bigint;
  /** The contract's internal real balances (failed payouts, dust, deposits), 18-decimal. */
  innerWnear: bigint;
  innerUsdc: bigint;
};

export function useBalances(account: string | null, wnear: TokenCfg | undefined, usdc: TokenCfg | undefined) {
  return useQuery({
    queryKey: ["balances", CONTRACT_ID, account ?? "", wnear?.tokenId ?? "", usdc?.tokenId ?? ""],
    enabled: Boolean(account && wnear && usdc),
    queryFn: async (): Promise<Balances> => {
      const [w, u, iw, iu] = await Promise.all([
        view<string>("ft_balance_of", { account_id: account }, wnear!.tokenId),
        view<string>("ft_balance_of", { account_id: account }, usdc!.tokenId),
        view<string>("real_balance_of", { account_id: account, asset: "wnear" }),
        view<string>("real_balance_of", { account_id: account, asset: "usdc" }),
      ]);
      return {
        wnear: toInternal(big(w), wnear!.decimals),
        usdc: toInternal(big(u), usdc!.decimals),
        innerWnear: big(iw),
        innerUsdc: big(iu),
      };
    },
    refetchInterval: POLL_MS,
    placeholderData: keepPreviousData,
  });
}

export type Registration = {
  /** NEP-145 balance on the Multiverse contract; null when not registered. */
  contract: StorageBalance | null;
  wnear: StorageBalance | null;
  usdc: StorageBalance | null;
  bounds: { contract: StorageBounds; wnear: StorageBounds; usdc: StorageBounds };
};

export function useRegistration(account: string | null, wnear: TokenCfg | undefined, usdc: TokenCfg | undefined) {
  return useQuery({
    queryKey: ["registration", CONTRACT_ID, account ?? "", wnear?.tokenId ?? "", usdc?.tokenId ?? ""],
    enabled: Boolean(account && wnear && usdc),
    queryFn: async (): Promise<Registration> => {
      const [c, w, u, bc, bw, bu] = await Promise.all([
        view<StorageBalance | null>("storage_balance_of", { account_id: account }),
        view<StorageBalance | null>("storage_balance_of", { account_id: account }, wnear!.tokenId),
        view<StorageBalance | null>("storage_balance_of", { account_id: account }, usdc!.tokenId),
        view<StorageBounds>("storage_balance_bounds"),
        view<StorageBounds>("storage_balance_bounds", {}, wnear!.tokenId),
        view<StorageBounds>("storage_balance_bounds", {}, usdc!.tokenId),
      ]);
      return { contract: c ?? null, wnear: w ?? null, usdc: u ?? null, bounds: { contract: bc, wnear: bw, usdc: bu } };
    },
    refetchInterval: 15_000,
  });
}

/** What a Root LP deposit would buy. The view panics for amounts too small, which is an answer, not a failure. */
export function useLpPreview(sid: number | undefined, wnear: bigint | undefined, usdc: bigint | undefined) {
  return useQuery({
    queryKey: ["lpPreview", CONTRACT_ID, String(sid), wnear?.toString() ?? "", usdc?.toString() ?? ""],
    enabled: sid !== undefined && Boolean(wnear) && Boolean(usdc),
    queryFn: async () =>
      decodeLpPreview(
        await view<LpPreviewJson>("preview_lp_deposit", {
          scenario_id: sid,
          wnear_amount: wnear!.toString(),
          usdc_amount: usdc!.toString(),
        }),
      ),
    refetchInterval: POLL_MS,
    retry: false,
  });
}

export type PoolInfo = { wnearReserve?: bigint; usdcReserve?: bigint; feePips?: number; twapPrice?: bigint | null };

/** Depth, fee and TWAP of one world's pool, for the world screen. */
export function usePool(poolId: number | null | undefined) {
  return useQuery({
    queryKey: ["pool", CONTRACT_ID, String(poolId)],
    enabled: poolId !== null && poolId !== undefined,
    queryFn: async (): Promise<PoolInfo | null> => {
      const p = await view<PoolViewJson | null>("get_pool", { pool_id: poolId });
      if (!p) return null;
      return {
        wnearReserve: p.wnear_reserve === null ? undefined : big(p.wnear_reserve),
        usdcReserve: p.usdc_reserve === null ? undefined : big(p.usdc_reserve),
        feePips: p.fee_pips,
        twapPrice: p.twap_price === null ? null : big(p.twap_price),
      };
    },
    refetchInterval: POLL_MS * 2,
    retry: false,
  });
}
