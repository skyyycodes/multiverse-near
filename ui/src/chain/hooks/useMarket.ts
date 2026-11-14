"use client";

// Which market a screen shows (W-D2): the URL's `id`, else the last market this browser opened on this contract, else
// the demo record's 2×2 scenario, else none ("Pick a market"). A fallback id is written back into the URL, so every
// visible page has a shareable address. The URL is the truth; localStorage only remembers (a per-viewer convenience).
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { CONTRACT_ID, readSource } from "../data/client";
import { decodeListMarkets, decodeMarketCardOrNull, decodeScenarioInfo } from "../decode";
import type { AppConfig, MarketCard, ScenarioInfo } from "../domain";
import type { ListMarketsJson, MarketCardJson, ScenarioInfoJson } from "../types";

export type MarketSource = "url" | "last" | "demo" | "none";
export type MarketRef = { sid: number | undefined; source: MarketSource; invalid?: string };

/** "5" → 5; anything but a positive safe integer written without leading zeros is invalid; no param is undefined. */
export function parseMarketParam(v: string | null): number | "invalid" | undefined {
  if (v === null) return undefined;
  if (!/^[1-9]\d*$/.test(v)) return "invalid";
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : "invalid";
}

/** The resolution order, pure: URL > last opened here > the demo record's 2×2 > none. An invalid URL id stops there. */
export function resolveMarket(urlParam: string | null, last: number | undefined, demo: number | null | undefined): MarketRef {
  const fromUrl = parseMarketParam(urlParam);
  if (fromUrl === "invalid") return { sid: undefined, source: "url", invalid: urlParam ?? "" };
  if (fromUrl !== undefined) return { sid: fromUrl, source: "url" };
  if (last !== undefined) return { sid: last, source: "last" };
  if (demo !== null && demo !== undefined) return { sid: demo, source: "demo" };
  return { sid: undefined, source: "none" };
}

/** The current query string with `id` set and every other param kept in place ("sel=14" → "sel=14&id=5"). */
export function withMarketId(search: string, sid: number): string {
  const p = new URLSearchParams(search);
  p.set("id", String(sid));
  return p.toString();
}

export const lastMarketKey = (contractId: string = CONTRACT_ID) => `ifverse.market.last:${contractId}`;

const listeners = new Set<() => void>();

function readLast(): number | undefined {
  try {
    const v = parseMarketParam(window.localStorage.getItem(lastMarketKey()));
    return typeof v === "number" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Remember the market this browser opened (localStorage, in try/catch: losing it only loses the fallback). */
export function rememberMarket(sid: number): void {
  try {
    if (window.localStorage.getItem(lastMarketKey()) === String(sid)) return;
    window.localStorage.setItem(lastMarketKey(), String(sid));
  } catch {
    return;
  }
  listeners.forEach((l) => l());
}

/** Forget the remembered market (it no longer exists on this contract), so the fallback moves on to the demo record. */
export function forgetMarket(sid: number): void {
  try {
    if (window.localStorage.getItem(lastMarketKey()) !== String(sid)) return;
    window.localStorage.removeItem(lastMarketKey());
  } catch {
    return;
  }
  listeners.forEach((l) => l());
}

/** The last market opened here, kept in step with rememberMarket. */
export function useLastMarket(): number | undefined {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    readLast,
    () => undefined,
  );
}

/** The market of the URL or the fallback, without touching the URL. */
export function useMarketRef(config: AppConfig | undefined): MarketRef {
  const params = useSearchParams();
  const last = useLastMarket();
  return resolveMarket(params.get("id"), last, config?.demo?.scenario2x2);
}

/** Writes a fallback id into the URL once (`enabled`: the market is known to exist), every other param kept. */
export function useMarketUrlRewrite(ref: MarketRef, enabled: boolean): void {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const rewritten = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!enabled || ref.sid === undefined || (ref.source !== "last" && ref.source !== "demo") || rewritten.current === ref.sid) return;
    rewritten.current = ref.sid;
    router.replace(`${path}?${withMarketId(params.toString(), ref.sid)}`, { scroll: false });
  }, [enabled, ref.sid, ref.source, router, path, params]);
}

/** useMarketRef, plus the URL rewrite of a fallback id. */
export function useMarketId(config: AppConfig | undefined, opts: { rewrite?: boolean } = {}): MarketRef {
  const ref = useMarketRef(config);
  useMarketUrlRewrite(ref, opts.rewrite ?? true);
  return ref;
}

/** For the header bell and the phone nav: the URL's id or the last market, never the demo fallback, no rewrite. */
export function useCurrentMarketId(): number | undefined {
  const params = useSearchParams();
  const last = useLastMarket();
  const fromUrl = parseMarketParam(params.get("id"));
  return typeof fromUrl === "number" ? fromUrl : last;
}

/** The market a MarketGuard checked, for the screens inside it. */
export const MarketIdContext = createContext<number | undefined>(undefined);
export const useGuardedMarketId = (): number | undefined => useContext(MarketIdContext);

/** Set by MarketGuard to the market's id when the registry says it is not listed (the phone header's banner reads it). */
export const UnlistedContext = createContext<number | undefined>(undefined);
export const useUnlistedMarket = (): number | undefined => useContext(UnlistedContext);

const view = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> => (await readSource()).view<T>(CONTRACT_ID, method, args);

/** `get_scenario`: whether the market exists (UnknownScenario otherwise), every 60 s. */
export function useScenarioInfo(sid: number | undefined) {
  return useQuery({
    queryKey: ["scenarioInfo", CONTRACT_ID, String(sid)],
    enabled: sid !== undefined,
    queryFn: async (): Promise<ScenarioInfo> => decodeScenarioInfo(await view<ScenarioInfoJson>("get_scenario", { scenario_id: sid })),
    refetchInterval: 60_000,
    retry: (count, e) => !/UnknownScenario/.test(e.message) && count < 2,
  });
}

/** The first `n` open listed markets (the market guard's "Pick a market"); empty when the list cannot be read. */
export function useFirstMarkets(n = 3, enabled = true) {
  return useQuery({
    queryKey: ["firstMarkets", CONTRACT_ID, n],
    enabled,
    queryFn: async (): Promise<MarketCard[]> => {
      const list = decodeListMarkets(await view<ListMarketsJson>("list_markets", { from_id: null, limit: 12, listed_only: true }));
      return list.markets.filter((m) => m.status === "open").slice(0, n);
    },
    staleTime: 20_000,
    retry: false,
  });
}

/** `get_market`: the registry's card (listed or not, lendable, seed), every 15 s; null for an unknown scenario. */
export function useMarketCard(sid: number | undefined) {
  return useQuery({
    queryKey: ["market", CONTRACT_ID, String(sid)],
    enabled: sid !== undefined,
    queryFn: async (): Promise<MarketCard | null> => decodeMarketCardOrNull(await view<MarketCardJson | null>("get_market", { scenario_id: sid })),
    refetchInterval: 15_000,
    retry: 1,
  });
}
