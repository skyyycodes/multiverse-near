"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type ScenarioChoice = "2x2" | "binary";

/** A selection belongs to one scenario: a key mismatch reads as nothing selected. */
type Pick = { key: string; mask: number };

type Ctx = {
  which: ScenarioChoice;
  setWhich: (w: ScenarioChoice) => void;
  sell: Pick;
  setSell: (p: Pick) => void;
  book: Pick;
  setBook: (p: Pick) => void;
};

const ScenarioContext = createContext<Ctx | null>(null);

/**
 * Which demo scenario every screen shows (SPICE × Fed, or SPICE only), and the worlds picked for a sale or
 * an order book. Kept above the routes so a selection survives moving between the home, the sell form and back; not
 * kept across a reload.
 */
export function ScenarioProvider({ children }: { children: ReactNode }) {
  const [which, setWhich] = useState<ScenarioChoice>("2x2");
  const [sell, setSell] = useState<Pick>({ key: "", mask: 0 });
  const [book, setBook] = useState<Pick>({ key: "", mask: 0 });
  const value = useMemo(() => ({ which, setWhich, sell, setSell, book, setBook }), [which, sell, book]);
  return <ScenarioContext.Provider value={value}>{children}</ScenarioContext.Provider>;
}

export function useScenarioChoice(): Ctx {
  const ctx = useContext(ScenarioContext);
  if (!ctx) throw new Error("useScenarioChoice outside ScenarioProvider");
  return ctx;
}

/**
 * The picked mask for scenario `key`, masked by what is still possible (worlds that die drop out of the order), with
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
