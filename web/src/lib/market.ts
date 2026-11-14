// The market list and the market page, pure: world digits and labels, per-event odds of a card, search, filters,
// sort and the few words a card shows. Amounts are 18-decimal bigint; nothing here touches the chain.
import type { EventState, MarketCard, MarketStatus, ProposalSummary } from "./domain";

const ONE = 10n ** 18n;

/** The outcome of event `k` in world `w`: world = a + 2b + 4c, so it is the k-th binary digit of the index. */
export const digit = (w: number, k: number): number => Math.floor(w / 2 ** k) % 2;

export const isPossible = (possible: number, w: number): boolean => (possible & (1 << w)) !== 0;

type Named = Pick<EventState, "outcomeNames">;
type Texts = Pick<EventState, "question" | "outcomeNames">;

/** "SHIPS·CUTS": the outcome of each event in world `w`, event A first. */
export function worldLabel(events: readonly Named[], w: number): string {
  return events.map((e, k) => e.outcomeNames[digit(w, k)] ?? "?").join("·");
}

/**
 * Odds of event `k`'s two outcomes from a card's world odds: outcome o sums the odds of the possible worlds whose
 * k-th digit is o (web 7.10). Over possible worlds the pair always adds up to one.
 */
export function eventOdds(card: Pick<MarketCard, "odds" | "possible">, k: number): [bigint, bigint] {
  const out: [bigint, bigint] = [0n, 0n];
  card.odds.forEach((o, w) => {
    if (isPossible(card.possible, w)) out[digit(w, k)] += o;
  });
  return out;
}

/** Category codes of `event_meta` (the contract accepts 0-3). */
export const CATEGORY_NAMES: Readonly<Record<number, string>> = { 1: "NEAR ecosystem", 2: "Macro", 3: "Crypto", 0: "Other" };
export const categoryName = (c: number): string => CATEGORY_NAMES[c] ?? "Other";

/** "Single event", "Combination · 4 worlds", "3 events · 8 worlds". */
export function kindLabel(eventCount: number, worldCount: number): string {
  if (eventCount <= 1) return "Single event";
  if (eventCount === 2) return `Combination · ${worldCount} worlds`;
  return `${eventCount} events · ${worldCount} worlds`;
}

export const STATUS_LABEL: Readonly<Record<MarketStatus, string>> = {
  open: "Open",
  deciding: "Deciding",
  partly_resolved: "Partly resolved",
  resolved: "Resolved",
};
export const STATUS_TONE: Readonly<Record<MarketStatus, "pos" | "warn" | "info" | "neutral">> = {
  open: "pos",
  deciding: "warn",
  partly_resolved: "info",
  resolved: "neutral",
};

/** Lowest and highest NEAR price over the possible worlds that have a pool price; undefined when none has one. */
export function priceRange(card: Pick<MarketCard, "worldPrices" | "possible">): { min: bigint; max: bigint } | undefined {
  let r: { min: bigint; max: bigint } | undefined;
  card.worldPrices.forEach((p, w) => {
    if (!isPossible(card.possible, w) || p === 0n) return;
    r = r ? { min: p < r.min ? p : r.min, max: p > r.max ? p : r.max } : { min: p, max: p };
  });
  return r;
}

/** The one world left once every event resolved; undefined while more than one is possible. */
export function survivor(possible: number, worldCount: number): number | undefined {
  const alive = Array.from({ length: worldCount }, (_, w) => w).filter((w) => isPossible(possible, w));
  return alive.length === 1 ? alive[0] : undefined;
}

/** The order cells take in a 2-column CSS grid, per 2×2 block (rows = event A, columns = event B, blocks = event C). */
export function gridBlocks(worldCount: number): number[][] {
  if (worldCount === 8) return [[0, 2, 1, 3], [4, 6, 5, 7]];
  if (worldCount === 4) return [[0, 2, 1, 3]];
  return [Array.from({ length: worldCount }, (_, w) => w)];
}

/** Case- and accent-insensitive text for search ("Ré" finds "re"). */
export const fold = (s: string): string => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();

export type EventTexts = ReadonlyMap<number, Texts>;

/** Questions and outcome names of a market's events, A first; undefined until every one has loaded. */
export function eventsOf(ids: readonly number[], texts: EventTexts): Texts[] | undefined {
  const out = ids.map((id) => texts.get(id));
  return out.every((e) => e !== undefined) ? (out as Texts[]) : undefined;
}

function hit(hay: readonly string[], q: string): boolean {
  return hay.some((h) => fold(h).includes(q));
}

/** Search over a card: questions, outcome names, category names and "#<id>" (an exact id, so #5 never finds #50). */
export function cardMatches(card: Pick<MarketCard, "scenarioId" | "eventIds" | "categories">, texts: EventTexts, query: string): boolean {
  const q = fold(query);
  if (!q) return true;
  if (/^#\d+$/.test(q)) return q === `#${card.scenarioId}`;
  const hay = [
    ...card.eventIds.flatMap((id) => {
      const e = texts.get(id);
      return e ? [e.question, ...e.outcomeNames] : [];
    }),
    ...card.categories.map(categoryName),
  ];
  return hit(hay, q);
}

/** Search over a proposal: the new event's question and outcomes, the combined events, its category and "p<id>". */
export function proposalMatches(p: Pick<ProposalSummary, "proposalId" | "eventIds" | "newEvent" | "category">, texts: EventTexts, query: string): boolean {
  const q = fold(query);
  if (!q) return true;
  if (/^p\d+$/.test(q)) return q === `p${p.proposalId}`;
  const hay = [
    ...(p.newEvent ? [p.newEvent.question, ...p.newEvent.outcomeNames] : []),
    ...p.eventIds.flatMap((id) => {
      const e = texts.get(id);
      return e ? [e.question, ...e.outcomeNames] : [];
    }),
    categoryName(p.newEvent?.category ?? p.category),
  ];
  return hit(hay, q);
}

export const FILTERS = ["all", "single", "combo", "cat-1", "cat-2", "cat-3", "cat-0", "pledging", "yours", "resolved"] as const;
export type ListFilter = (typeof FILTERS)[number];
export const parseFilter = (v: string | null | undefined): ListFilter => ((FILTERS as readonly string[]).includes(v ?? "") ? (v as ListFilter) : "all");

export const SORTS = ["pool", "deadline", "newest"] as const;
export type ListSort = (typeof SORTS)[number];
export const SORT_LABEL: Readonly<Record<ListSort, string>> = { pool: "Money in pools", deadline: "Ending soon", newest: "Newest" };
export const parseSort = (v: string | null | undefined): ListSort => ((SORTS as readonly string[]).includes(v ?? "") ? (v as ListSort) : "pool");

/** What "Yours" covers: markets the account holds or opened by its pledges, and proposals it pledged to. */
export type Yours = { markets: ReadonlySet<number>; proposals: ReadonlySet<number> };
export const NO_YOURS: Yours = { markets: new Set(), proposals: new Set() };

/** "Yours" from `markets_of` and `pledges_of`: the markets held, those opened by a pledged proposal, and the proposals. */
export function yoursOf(held: readonly number[], pledges: readonly { proposalId: number }[], cards: readonly Pick<MarketCard, "scenarioId" | "proposalId">[]): Yours {
  const proposals = new Set(pledges.map((p) => p.proposalId));
  const markets = new Set(held);
  for (const c of cards) if (c.proposalId !== null && proposals.has(c.proposalId)) markets.add(c.scenarioId);
  return { markets, proposals };
}

const catOf = (f: ListFilter): number | undefined => (f.startsWith("cat-") ? Number(f.slice(4)) : undefined);

/** The cards a filter shows. Every filter but Resolved and Yours leaves resolved markets out. */
export function filterMarkets<T extends Pick<MarketCard, "scenarioId" | "eventIds" | "categories" | "status">>(cards: readonly T[], f: ListFilter, yours: Yours = NO_YOURS): T[] {
  const live = (c: T) => c.status !== "resolved";
  const cat = catOf(f);
  return cards.filter((c) => {
    if (f === "resolved") return c.status === "resolved";
    if (f === "yours") return yours.markets.has(c.scenarioId);
    if (f === "pledging") return false;
    if (!live(c)) return false;
    if (f === "single") return c.eventIds.length === 1;
    if (f === "combo") return c.eventIds.length >= 2;
    if (cat !== undefined) return c.categories.includes(cat);
    return true;
  });
}

/** Live proposals (review, pledging) a filter shows. */
export function filterProposals<T extends Pick<ProposalSummary, "proposalId" | "kind" | "status" | "category" | "newEvent">>(ps: readonly T[], f: ListFilter, yours: Yours = NO_YOURS): T[] {
  const cat = catOf(f);
  return ps.filter((p) => {
    if (p.status !== "review" && p.status !== "pledging") return false;
    if (f === "resolved") return false;
    if (f === "yours") return yours.proposals.has(p.proposalId);
    if (f === "single") return p.kind === "new_event";
    if (f === "combo") return p.kind === "market";
    if (cat !== undefined) return (p.newEvent?.category ?? p.category) === cat;
    return true;
  });
}

/** pool: money in pools, most first; deadline: soonest first, none last; newest: created last first (legacy 0 by id). */
export function sortMarkets<T extends Pick<MarketCard, "scenarioId" | "poolValue" | "deadlineSec" | "createdAtSec">>(cards: readonly T[], sort: ListSort): T[] {
  const byId = (a: T, b: T) => a.scenarioId - b.scenarioId;
  const out = [...cards];
  if (sort === "pool") out.sort((a, b) => (a.poolValue === b.poolValue ? byId(a, b) : a.poolValue > b.poolValue ? -1 : 1));
  else if (sort === "deadline") {
    const key = (c: T) => (c.deadlineSec === 0 ? Number.MAX_SAFE_INTEGER : c.deadlineSec);
    out.sort((a, b) => key(a) - key(b) || byId(a, b));
  } else out.sort((a, b) => b.createdAtSec - a.createdAtSec || b.scenarioId - a.scenarioId);
  return out;
}

/** Proposals: closest to their goal first, then the soonest to expire. */
export function sortProposals<T extends Pick<ProposalSummary, "proposalId" | "progressBps" | "expiresAtSec">>(ps: readonly T[]): T[] {
  return [...ps].sort((a, b) => b.progressBps - a.progressBps || a.expiresAtSec - b.expiresAtSec || a.proposalId - b.proposalId);
}

/** Pledged value in USDC: USDC plus wNEAR at the proposal's spot hint (web 7.5). */
export const pledgedValue = (p: Pick<ProposalSummary, "pledgedUsdc" | "pledgedWnear" | "sHint">): bigint => p.pledgedUsdc + (p.pledgedWnear * p.sHint) / ONE;

/** "31 Mar 2027" (UTC), the card's deadline. */
export function shortDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** "2027-03-31 23:59 UTC", the market page's deadline. */
export const utcMinute = (sec: number): string => `${new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** "A", "B", "C": the letter of an event in its market. */
export const letter = (k: number): string => String.fromCharCode(65 + k);

/** Event ids of the cards, each once, in first-seen order (what the list needs texts for). */
export function eventIdsOf(groups: readonly { eventIds: readonly number[] }[]): number[] {
  const seen = new Set<number>();
  for (const g of groups) for (const id of g.eventIds) seen.add(id);
  return [...seen];
}

/** Ids in chunks the views accept (`market_cards` 12, `get_events` 24). */
export function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * An event's two odds as whole percentages that add up to 100 ("67%", "33%"): the first rounded half up, the second
 * the rest, so a card never reads 99% + 0%. Both "—" when nothing is known.
 */
export function oddsPair(pair: readonly [bigint, bigint]): [string, string] {
  const total = pair[0] + pair[1];
  if (total === 0n) return ["—", "—"];
  const first = Number((pair[0] * 200n + total) / (2n * total));
  return [`${first}%`, `${100 - first}%`];
}

const WORLD_WORDS = (n: number) => `${n} ${n === 1 ? "world" : "worlds"}`;

/** The market header's status: "#5 · 4 worlds · 0 of 2 resolved", plus " · paused: resolution pending" while halted. */
export function statusLine(sid: number, worldCount: number, events: readonly { finalized: boolean }[], halted: boolean): string {
  const done = events.filter((e) => e.finalized).length;
  return `#${sid} · ${WORLD_WORDS(worldCount)} · ${done} of ${events.length} resolved${halted ? " · paused: resolution pending" : ""}`;
}

/** The soonest deadline (seconds) of an event with no final result yet; undefined once every event resolved. */
export function nextDeadline(events: readonly { finalized: boolean; deadline: bigint }[]): number | undefined {
  const open = events.filter((e) => !e.finalized).map((e) => Number(e.deadline));
  return open.length ? Math.min(...open) : undefined;
}

/** The market header's price-check chip: the outside check on, off, or blocking new borrowing. */
export type CheckState = "on" | "off" | "blocked";
export function checkState(pc: { config: { reference: boolean }; borrowBlock: string | null }): CheckState {
  if (pc.borrowBlock) return "blocked";
  return pc.config.reference ? "on" : "off";
}
export const CHECK_LABEL: Readonly<Record<CheckState, string>> = {
  on: "Outside price check on",
  off: "Outside price check off",
  blocked: "New borrowing paused",
};

/** A data source that is a web address renders as a link; anything else stays text. */
export const isWebSource = (s: string): boolean => /^https:\/\/[^\s]+$/i.test(s.trim());

/** The tab of a market-scoped path ("/orders/" → "orders"); undefined off the market's screens. */
export type MarketTab = "trade" | "sell" | "orders" | "split" | "borrow" | "lend" | "resolve";
export function tabOf(path: string | null): MarketTab | undefined {
  const p = (path ?? "/").replace(/\/+$/, "");
  const map: Record<string, MarketTab> = {
    "/market": "trade",
    "/sell": "sell",
    "/orders": "orders",
    "/split": "split",
    "/borrow": "borrow",
    "/lend": "lend",
    "/resolve": "resolve",
  };
  return map[p];
}
