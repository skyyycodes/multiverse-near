// The market board, the market page and the landing, pure: what they draw from the adapter's chain markets. Plain
// numbers here are for display only (the adapter's `chance`, `nearPrice`, `liquidity`); nothing here moves money.
// Worlds are in the contract's bit order, world = a + 2b + 4c (market.ts `digit`).
import type { ChainEvent, ChainMarket, ChainWorld } from "./adapter-model";
import type { Collateral, ProposalSource } from "./domain";
import { digit, fold, isPossible, shortDate } from "./market";

/** A world's chance as the site prints it: whole percent, "<1%" for a sliver that can still happen, "0%" for none. */
export function chanceText(c: number): string {
  if (!(c > 0)) return "0%";
  if (c < 0.005) return "<1%";
  return `${Math.round(c * 100)}%`;
}

/** Dollars, short: "$2.65M", "$40.0K", "$950". */
export function compactUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

/** A NEAR price: "$3.33" (two decimals), "–" before the pool has one. */
export const priceText = (p: number): string => (p > 0 ? `$${p.toFixed(2)}` : "–");

type Worlds = Pick<ChainMarket, "worlds">;

/** Worlds still possible, most likely first (equal chances keep the contract's order). */
export function byChance(m: Worlds): ChainWorld[] {
  return m.worlds.filter((w) => w.possible).sort((a, b) => b.chance - a.chance || a.index - b.index);
}

/** The most likely world still possible; undefined when none is. */
export const leadWorld = (m: Worlds): ChainWorld | undefined => byChance(m)[0];

/** Whole days from `nowSec` to `sec` (rounded up), or null without a deadline. */
export function daysUntil(sec: number, nowSec: number): number | null {
  if (!(sec > 0)) return null;
  return Math.ceil((sec - nowSec) / 86_400);
}

// ---------- the board: search, filters, sort ----------

export const BOARD_SORTS = [
  { id: "pool", label: "Money in pools" },
  { id: "soon", label: "Ending soon" },
  { id: "new", label: "Newest" },
] as const;
export type BoardSort = (typeof BOARD_SORTS)[number]["id"];

type Sortable = Pick<ChainMarket, "sid" | "settled" | "liquidity" | "deadlineSec" | "createdAtSec">;

/** Open markets first, then settled; within each, by the sort (ties by id). */
export function sortBoard<T extends Sortable>(ms: readonly T[], sort: BoardSort): T[] {
  const key = (m: T) => (sort === "pool" ? -m.liquidity : sort === "soon" ? (m.deadlineSec > 0 ? m.deadlineSec : Number.MAX_SAFE_INTEGER) : -m.createdAtSec);
  return [...ms].sort((a, b) => Number(a.settled) - Number(b.settled) || key(a) - key(b) || (sort === "new" ? b.sid - a.sid : a.sid - b.sid));
}

/** The category names the markets carry, each once, in the order they first appear. */
export function boardCategories(ms: readonly Pick<ChainMarket, "categories">[]): string[] {
  return [...new Set(ms.flatMap((m) => m.categories))];
}

/** The board's tab: "All", "Watchlist" or a category name. */
export function inFilter(m: Pick<ChainMarket, "id" | "categories">, filter: string, watch: readonly string[]): boolean {
  if (filter === "All") return true;
  if (filter === "Watchlist") return watch.includes(m.id);
  return m.categories.includes(filter);
}

/** Search over a market's questions, outcomes and categories; "#5" finds market 5 only (never 50). */
export function matches(m: Pick<ChainMarket, "sid" | "question" | "categories" | "kind" | "events">, query: string): boolean {
  const q = fold(query);
  if (!q) return true;
  if (/^#\d+$/.test(q)) return q === `#${m.sid}`;
  return fold([m.question, m.kind, ...m.categories, ...m.events.flatMap((e) => e.outcomes)].join(" ")).includes(q);
}

// ---------- the market page: picking worlds ----------

export type Preset = { label: string; mask: number };

type Pickable = Pick<ChainMarket, "events" | "worlds" | "possible">;

/** Every possible world where event `k` has outcome `o`, as a mask. */
export function outcomeMask(m: Pick<ChainMarket, "worlds" | "possible">, k: number, o: number): number {
  return m.worlds.reduce((mask, w) => (isPossible(m.possible, w.index) && digit(w.index, k) === o ? mask | w.mask : mask), 0);
}

/**
 * One-tap picks over the worlds: for each event, every world where it ends one way ("Delayed", "Holds"). A pick that
 * is empty or covers every possible world (an event already answered) is left out, and so is a repeat.
 */
export function presetsOf(m: Pickable): Preset[] {
  const out: Preset[] = [];
  m.events.forEach((e, k) =>
    e.outcomes.forEach((o, i) => {
      const mask = outcomeMask(m, k, i);
      if (mask === 0 || mask === m.possible || out.some((p) => p.mask === mask)) return;
      out.push({ label: o, mask });
    }),
  );
  return out;
}

/** The picked worlds in words: "every “Delayed” world", "Ships & cuts", "every world but Ships & cuts", "3 worlds". */
export function shapeName(m: Pickable, mask: number): string {
  const pick = mask & m.possible;
  if (pick === 0) return "none";
  if (pick === m.possible) return "every world";
  const preset = presetsOf(m).find((p) => p.mask === pick);
  if (preset) return `every “${preset.label}” world`;
  const picked = m.worlds.filter((w) => (pick & w.mask) !== 0);
  if (picked.length === 1) return picked[0].outcome;
  const left = m.worlds.filter((w) => isPossible(m.possible, w.index) && (pick & w.mask) === 0);
  if (left.length === 1) return `every world but ${left[0].outcome}`;
  return `${picked.length} worlds`;
}

/** NEAR's price the odds imply (Σ chance × price over the possible worlds), next to the contract's own figure. */
export function impliedCheck(m: Pick<ChainMarket, "worlds" | "impliedSpot">): { sum: number; contract: number; ok: boolean } {
  const sum = m.worlds.filter((w) => w.possible).reduce((t, w) => t + w.chance * w.nearPrice, 0);
  const ok = m.impliedSpot > 0 && Math.abs(sum - m.impliedSpot) <= m.impliedSpot * 0.001;
  return { sum, contract: m.impliedSpot, ok };
}

/** The markets `related_markets` names, as the board has them (unknown ids dropped), most money in pools first. */
export function relatedOf<T extends Pick<ChainMarket, "sid" | "liquidity">>(ids: readonly number[], all: readonly T[], self: number): T[] {
  const byId = new Map(all.map((m) => [m.sid, m]));
  return ids
    .filter((id) => id !== self)
    .map((id) => byId.get(id))
    .filter((m): m is T => m !== undefined)
    .sort((a, b) => b.liquidity - a.liquidity || a.sid - b.sid);
}

/** The events two markets share, by question. */
export function sharedEvents(a: Pick<ChainMarket, "events">, b: Pick<ChainMarket, "events">): string[] {
  return b.events.filter((e) => a.events.some((f) => f.id === e.id)).map((e) => e.question);
}

// ---------- resolution ----------

/** "4:05": a countdown in minutes and seconds. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "10 minutes", "30 seconds", "1 hour", "7 days": a contract duration in words. */
export function durationText(sec: number): string {
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (sec % 86_400 === 0 && sec >= 86_400) return unit(sec / 86_400, "day");
  if (sec % 3_600 === 0 && sec >= 3_600) return unit(sec / 3_600, "hour");
  if (sec % 60 === 0 && sec >= 60) return unit(sec / 60, "minute");
  return unit(sec, "second");
}

const BY: Readonly<Record<ProposalSource, string>> = { outlayer: "OutLayer", reporter: "the reporter", admin: "the owner" };

export type ResolutionState = { tone: "open" | "live" | "final"; text: string };

type Resolvable = Pick<ChainEvent, "finalized" | "outcome" | "outcomes" | "proposalOpen" | "proposedOutcome" | "finalizableAtSec" | "deadlineSec" | "proposedBy">;

/** Where an event's answer stands, in the words and tone of the resolve screen's pills. */
export function resolutionState(e: Resolvable, nowSec: number): ResolutionState {
  if (e.finalized && e.outcome !== null) return { tone: "final", text: `${e.outcomes[e.outcome]}${e.proposedBy ? `, by ${BY[e.proposedBy]}` : ""}` };
  if (e.proposalOpen && e.proposedOutcome !== null) {
    const left = e.finalizableAtSec - nowSec;
    const what = `${e.outcomes[e.proposedOutcome]} proposed`;
    return { tone: "live", text: left > 0 ? `${what} · dispute window ${clock(left)}` : `${what} · ready to finalize` };
  }
  if (e.deadlineSec > 0 && nowSec >= e.deadlineSec) return { tone: "open", text: "Deadline passed · waiting for the answer" };
  return { tone: "open", text: e.deadlineSec > 0 ? `Open until ${shortDate(e.deadlineSec)}` : "Open" };
}

// ---------- the landing's worked example ----------

export type FloorInput = {
  /** NEAR's price in each world, in the order the example lays them out. */
  prices: readonly number[];
  /** USDC the pool there pays for the example's NEAR (`quote_sell`: fee and price impact included). */
  proceeds: readonly number[];
  /** NEAR held in every world. */
  near: number;
  /** The tier's borrow LTV: the share of the weakest world a new loan may reach. */
  ltv: number;
  /** The what-if: how far NEAR falls (0.4 = 40%). Dollars don't move. */
  drop: number;
};

export type Floor = {
  /** What each world counts for now, and after the drop. */
  values: number[];
  shocked: number[];
  /** The world that sets the limit after the drop. */
  weakest: number;
  /** Whole dollars a loan may reach today, after the drop, and what hedging kept over NEAR everywhere. */
  limit: number;
  afterDrop: number;
  extra: number;
};

/** The example's numbers: hold NEAR or dollars in each world (`dollars[i]`), read the weakest world, today and after the drop. */
export function floorExample(x: FloorInput, dollars: readonly boolean[]): Floor {
  const cap = (v: number) => Math.max(0, Math.floor(v * x.ltv + 1e-9));
  const near = (i: number, shock: boolean) => x.near * (x.prices[i] ?? 0) * (shock ? 1 - x.drop : 1);
  const values = x.prices.map((_, i) => (dollars[i] ? (x.proceeds[i] ?? 0) : near(i, false)));
  const shocked = x.prices.map((_, i) => (dollars[i] ? (x.proceeds[i] ?? 0) : near(i, true)));
  const floor = Math.min(...shocked);
  const nearOnly = Math.min(...x.prices.map((_, i) => near(i, true)));
  return {
    values,
    shocked,
    weakest: shocked.indexOf(floor),
    limit: cap(Math.min(...values)),
    afterDrop: cap(floor),
    extra: cap(floor) - cap(nearOnly),
  };
}

// ---------- a loan, explained (the docs' live example) ----------

/** What a tier's posted pieces hold in each world: a real token counts in every world, a world piece where its mask covers. */
export function postedByWorld(collateral: readonly Pick<Collateral, "asset" | "mask" | "isReal" | "amount">[], worlds: readonly { mask: number }[]): { near: bigint; usdc: bigint }[] {
  return worlds.map((w) =>
    collateral.reduce(
      (t, c) => {
        if (!c.isReal && (c.mask & w.mask) === 0) return t;
        return c.asset === "wnear" ? { ...t, near: t.near + c.amount } : { ...t, usdc: t.usdc + c.amount };
      },
      { near: 0n, usdc: 0n },
    ),
  );
}

export type ShockRow = {
  /** What the world counts for now, USDC. */
  value: number;
  /** NEAR held there and its price, for the part of the value that falls with NEAR. */
  near: number;
  price: number;
  possible: boolean;
};

/**
 * The health factor after NEAR falls by `drop` everywhere: in each possible world the NEAR part of its value (at most
 * NEAR × price) falls, dollars stay. Null without debt.
 */
export function healthAfterDrop(rows: readonly ShockRow[], debt: number, lltv: number, drop: number): number | null {
  if (!(debt > 0)) return null;
  const live = rows.filter((r) => r.possible);
  if (live.length === 0) return 0;
  const worst = Math.min(...live.map((r) => r.value - drop * Math.min(r.value, r.near * r.price)));
  return (Math.max(0, worst) * lltv) / debt;
}
