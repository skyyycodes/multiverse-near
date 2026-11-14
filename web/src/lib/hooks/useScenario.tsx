"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Tier } from "../domain";

/** A selection belongs to one market: a key mismatch reads as nothing selected. */
type Pick = { key: string; mask: number };

type Ctx = {
  sell: Pick;
  setSell: (p: Pick) => void;
  book: Pick;
  setBook: (p: Pick) => void;
  /** The tier "keep as collateral" goes to, per market (`${contractId}:${sid}`). */
  tiers: Record<string, Tier>;
  setTier: (key: string, tier: Tier) => void;
};

const ScenarioContext = createContext<Ctx | null>(null);

const TIERS: readonly Tier[] = ["safe", "normal", "bold"];
/** localStorage key of a market's remembered tier: `ifverse.tier:<contractId>:<sid>` (key = `${contractId}:${sid}`). */
export const tierStorageKey = (key: string) => `ifverse.tier:${key}`;

function readTier(key: string): Tier | undefined {
  try {
    const v = window.localStorage.getItem(tierStorageKey(key));
    return (TIERS as readonly string[]).includes(v ?? "") ? (v as Tier) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The worlds picked for a sale or an order book, and the tier picked for collateral, per market. Kept above the
 * routes so a selection survives moving between the home, the sell form and back. Picks are not kept across a reload;
 * the tier is remembered per market in localStorage (a per-viewer convenience).
 */
export function ScenarioProvider({ children }: { children: ReactNode }) {
  const [sell, setSell] = useState<Pick>({ key: "", mask: 0 });
  const [book, setBook] = useState<Pick>({ key: "", mask: 0 });
  const [tiers, setTiers] = useState<Record<string, Tier>>({});
  const setTier = useCallback((key: string, tier: Tier) => {
    setTiers((t) => ({ ...t, [key]: tier }));
    try {
      window.localStorage.setItem(tierStorageKey(key), tier);
    } catch {
      // storage blocked: the pick lasts for this tab
    }
  }, []);
  const value = useMemo(() => ({ sell, setSell, book, setBook, tiers, setTier }), [sell, book, tiers, setTier]);
  return <ScenarioContext.Provider value={value}>{children}</ScenarioContext.Provider>;
}

export function useScenarioChoice(): Ctx {
  const ctx = useContext(ScenarioContext);
  if (!ctx) throw new Error("useScenarioChoice outside ScenarioProvider");
  return ctx;
}

/**
 * The picked mask for market `key`, masked by what is still possible (worlds that die drop out of the order), with
 * setters that stamp the key.
 */
export function usePicks(key: string, possible: number) {
  const { sell, setSell, book, setBook } = useScenarioChoice();
  const rawSell = sell.key === key ? sell.mask : 0;
  const sellMask = rawSell & possible;
  const bookMask = (book.key === key ? book.mask : 0) & possible;
  const toggleSell = useCallback((m: number) => setSell({ key, mask: rawSell ^ m }), [key, rawSell, setSell]);
  const setSellMask = useCallback((m: number) => setSell({ key, mask: m }), [key, setSell]);
  const openBook = useCallback((m: number) => setBook({ key, mask: m }), [key, setBook]);
  return { sellMask, toggleSell, setSellMask, bookMask, openBook };
}

/**
 * The tier last picked for market `key` (this tab first, then this browser), or undefined when none was: the screen
 * then chooses its default. The setter remembers it for the market.
 */
export function useCollateralTier(key: string): { tier: Tier | undefined; setTier: (t: Tier) => void } {
  const { tiers, setTier } = useScenarioChoice();
  const tier = tiers[key] ?? readTier(key);
  const set = useCallback((t: Tier) => setTier(key, t), [key, setTier]);
  return { tier, setTier: set };
}
