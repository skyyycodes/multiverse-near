// The adapter's pure half: chain snapshots (decoded by decode.ts, bigint 18-decimal) turned into the shapes the
// redesign's views draw: a market with its events and worlds, and a position with what you hold in each world.
// Worlds are always in the contract's bit order: world = a + 2b + 4c, event A the lowest bit (market.ts `digit`).
// Numbers named like `chance`, `nearPrice`, `usdc` are JS numbers for display and charts only; every amount that
// moves money stays a bigint (the `…Wad` fields), and actions take bigints.
import type { Account, BorrowSnapshot, Collateral, EventMeta, EventState, LiquidationState, MarketCard, MarketOrigin, MarketStatus, ProposalSource, Scenario, Tier } from "./domain";
import { annualRate, borrowRoom } from "./lending";
import { marketHref } from "./links";
import { categoryName, digit, isPossible, kindLabel, shortDate, STATUS_LABEL, survivor, utcMinute } from "./market";
import { TIERS } from "./tiers";

/** An 18-decimal amount as a JS number, for display and charts only (never for an amount that is sent). */
export const toNum = (wad: bigint | null | undefined): number => (wad === null || wad === undefined ? 0 : Number(wad) / 1e18);

/** "SHIPS" → "Ships", "YES" → "Yes": the contract's outcome names in the site's sentence case. */
export const sentence = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);

/** An event's rule without the machine tag the contract keeps at its end ("[ifverse:fomc:…]"). */
export const ruleText = (rule: string): string => rule.replace(/\s*\[ifverse:[^\]]*\]\s*$/, "").trim();

/** The artwork under public/markets/ that fits an event, from its rule's tag; none for an event it does not know. */
export function eventArt(e: Pick<EventState, "rule" | "question" | "finalized">): string | undefined {
  const tag = /\[ifverse:([a-z_]+)/.exec(e.rule)?.[1];
  if (tag === "fomc") return e.finalized ? "/markets/fed-oct.svg" : "/markets/fed.svg";
  if (tag === "price_close") return "/markets/near-price.svg";
  if (/\bSPICE\b/.test(e.question)) return "/markets/spice.svg";
  return undefined;
}

export type ChainEvent = {
  id: number;
  /** The question; the redesign calls it the event's name. */
  name: string;
  question: string;
  /** Outcome names in sentence case ("Ships", "Delayed"); index = the outcome's digit. */
  outcomes: string[];
  /** As the contract names them ("SHIPS"). */
  outcomeNames: string[];
  /** How the answer is decided, in plain words. */
  rule: string;
  /** Where the answer comes from (`event_meta`); empty when the event has none. */
  sources: string[];
  category: number;
  categoryName: string;
  deadlineSec: number;
  /** "2027-03-31 23:59 UTC". */
  deadline: string;
  image?: string;
  finalized: boolean;
  /** The final outcome once finalized, else null. */
  outcome: number | null;
  proposalOpen: boolean;
  /** The outcome a proposal named while it is open, else null. */
  proposedOutcome: number | null;
  /** When an open proposal can be finalized (0 when none is open). */
  finalizableAtSec: number;
  proposedBy: ProposalSource | null;
  /** The decoded view row, for anything not lifted above. */
  state: EventState;
};

export type ChainWorld = {
  /** Contract index (bit order). */
  index: number;
  mask: number;
  id: string;
  /** As the contract labels it: "SHIPS·CUTS". */
  label: string;
  /** In words: "Ships & cuts". */
  outcome: string;
  /** Each event's outcome in this world, event A first. */
  digits: number[];
  possible: boolean;
  /** Chance of this world, 0 to 1 (0 for a world that can no longer happen). */
  chance: number;
  odds: bigint;
  /** NEAR's price in this world's pool, USDC per NEAR (0 before the pool has a price). */
  nearPrice: number;
  price: bigint;
};

/** The worlds laid out as the redesign's grid: rows = event A's outcomes, columns = the other events'. */
export type WorldGrid = {
  rows: { label: string; worlds: number[] }[];
  cols: string[];
  rowTitle: string;
  colTitle: string;
};

export type ChainMarket = {
  sid: number;
  /** String(sid), for keys and the redesign's components. */
  id: string;
  /** "/market/?id=N". */
  href: string;
  /** The events' questions, event A first, joined by " × " (the redesign's `question`). */
  question: string;
  /** The same, as a title. */
  title: string;
  events: ChainEvent[];
  worlds: ChainWorld[];
  grid: WorldGrid;
  /** The first category's name ("NEAR ecosystem", "Macro", "Crypto", "Other"). */
  category: string;
  categories: string[];
  /** "Single event", "Combination · 4 worlds", "3 events · 8 worlds". */
  kind: string;
  /** "31 Mar 2027" (the last open event's deadline: the market settles once every event is answered), or "Settled". */
  resolves: string;
  /** The last open event's deadline (0 when none is set). */
  resolvesSec: number;
  /** The contract's `deadline_sec`: the soonest open event's deadline, i.e. the next answer due. */
  deadlineSec: number;
  createdAtSec: number;
  status: MarketStatus;
  statusLabel: string;
  settled: boolean;
  /** The world that happened, once one is left. */
  winner: number | undefined;
  possible: number;
  worldCount: number;
  /** USDC held in the market's pools (the registry's `pool_value`). */
  liquidity: number;
  liquidityWad: bigint;
  /** The thinnest world pool, USDC. */
  minWorldDepth: number;
  /** The odds-weighted NEAR price over the worlds (0 while not known). */
  impliedSpot: number;
  impliedSpotWad: bigint;
  oddsKnown: boolean;
  /** Borrowing is open on this market (every world priced and deep enough). */
  lendable: boolean;
  /** Lending tiers that take loans here: all three when lendable, none otherwise. */
  tiers: readonly Tier[];
  origin: MarketOrigin;
  proposalId: number | null;
  listed: boolean;
  /** The registry card, for anything not lifted above. */
  card: MarketCard;
};

/** The outcome of each event in world `w`, event A first. */
export const digitsOf = (w: number, eventCount: number): number[] => Array.from({ length: eventCount }, (_, k) => digit(w, k));

/** "Ships & cuts": the world's outcomes in words, the first capitalised. */
export function worldName(events: readonly Pick<ChainEvent, "outcomes">[], w: number): string {
  return events
    .map((e, k) => e.outcomes[digit(w, k)] ?? "?")
    .map((o, i) => (i === 0 ? o : o.toLowerCase()))
    .join(" & ");
}

/**
 * The world grid in contract indices. One event: one row of its two outcomes. More: rows are event A's outcomes;
 * columns run over the other events, the first of them changing slowest (as the redesign labels its columns).
 */
export function worldGrid(events: readonly Pick<ChainEvent, "name" | "outcomes">[]): WorldGrid {
  const n = events.length;
  if (n <= 1) return { rows: [{ label: "", worlds: [0, 1] }], cols: events[0]?.outcomes.slice(0, 2) ?? [], rowTitle: "", colTitle: events[0]?.name ?? "" };
  const colEvents = events.slice(1);
  const c = colEvents.length;
  const colDigits = (j: number) => colEvents.map((_, k) => (j >> (c - 1 - k)) & 1);
  const cols = Array.from({ length: 1 << c }, (_, j) =>
    colDigits(j)
      .map((d, k) => colEvents[k].outcomes[d])
      .join(" · "),
  );
  const rows = [0, 1].map((a) => ({
    label: events[0].outcomes[a],
    worlds: Array.from({ length: 1 << c }, (_, j) => colDigits(j).reduce((w, d, k) => w + d * 2 ** (k + 1), a)),
  }));
  return { rows, cols, rowTitle: events[0].name, colTitle: colEvents.map((e) => e.name).join(" · ") };
}

export function chainEvent(e: EventState, meta: EventMeta | null | undefined): ChainEvent {
  return {
    id: e.id,
    name: e.question,
    question: e.question,
    outcomes: e.outcomeNames.map(sentence),
    outcomeNames: e.outcomeNames,
    rule: ruleText(e.rule),
    sources: meta?.source ? [meta.source] : [],
    category: meta?.category ?? 0,
    categoryName: categoryName(meta?.category ?? 0),
    deadlineSec: Number(e.deadline),
    deadline: utcMinute(Number(e.deadline)),
    image: eventArt(e),
    finalized: e.finalized,
    outcome: e.finalized ? e.outcome : null,
    proposalOpen: e.proposalOpen,
    proposedOutcome: e.proposalOpen ? e.proposedOutcome : null,
    finalizableAtSec: Number(e.finalizableAt),
    proposedBy: e.proposedBy,
    state: e,
  };
}

/**
 * A market as the views draw it, from its registry card and its events' texts; undefined until every event's text
 * has loaded (a card is never shown half-named).
 */
export function chainMarket(card: MarketCard, texts: ReadonlyMap<number, EventState>, metas: ReadonlyMap<number, EventMeta | null> = new Map()): ChainMarket | undefined {
  const states = card.eventIds.map((id) => texts.get(id));
  if (states.some((s) => s === undefined)) return undefined;
  const events = (states as EventState[]).map((s) => chainEvent(s, metas.get(s.id)));
  const worlds: ChainWorld[] = Array.from({ length: card.worldCount }, (_, w) => {
    const possible = isPossible(card.possible, w);
    const odds = possible ? (card.odds[w] ?? 0n) : 0n;
    const price = card.worldPrices[w] ?? 0n;
    return {
      index: w,
      mask: 1 << w,
      id: `w${w}`,
      label: events.map((e, k) => e.outcomeNames[digit(w, k)] ?? "?").join("·"),
      outcome: worldName(events, w),
      digits: digitsOf(w, events.length),
      possible,
      chance: toNum(odds),
      odds,
      nearPrice: toNum(price),
      price,
    };
  });
  const settled = card.status === "resolved";
  const resolvesSec = events.reduce((t, e) => (!e.finalized && e.deadlineSec > t ? e.deadlineSec : t), 0);
  const cats = card.categories.length ? card.categories : [...new Set(events.map((e) => e.category))];
  return {
    sid: card.scenarioId,
    id: String(card.scenarioId),
    href: marketHref(card.scenarioId),
    question: events.map((e) => e.question).join(" × "),
    title: events.map((e) => e.question).join(" × "),
    events,
    worlds,
    grid: worldGrid(events),
    category: categoryName(cats[0] ?? 0),
    categories: cats.map(categoryName),
    kind: kindLabel(events.length, card.worldCount),
    resolves: settled ? "Settled" : resolvesSec ? shortDate(resolvesSec) : "No deadline",
    resolvesSec,
    deadlineSec: card.deadlineSec,
    createdAtSec: card.createdAtSec,
    status: card.status,
    statusLabel: STATUS_LABEL[card.status],
    settled,
    winner: survivor(card.possible, card.worldCount),
    possible: card.possible,
    worldCount: card.worldCount,
    liquidity: toNum(card.poolValue),
    liquidityWad: card.poolValue,
    minWorldDepth: toNum(card.minWorldDepth),
    impliedSpot: toNum(card.impliedSpot),
    impliedSpotWad: card.impliedSpot,
    oddsKnown: card.oddsKnown,
    lendable: card.lendable,
    tiers: card.lendable ? TIERS : [],
    origin: card.origin,
    proposalId: card.proposalId,
    listed: card.listed,
    card,
  };
}

export type WorldHolding = {
  index: number;
  label: string;
  possible: boolean;
  /** NEAR and USDC you hold in this world: wallet pieces plus collateral posted in any tier. */
  near: number;
  usdc: number;
  nearWad: bigint;
  usdcWad: bigint;
  /** The part in your wallet (outside lending). */
  walletNearWad: bigint;
  walletUsdcWad: bigint;
  /** The part posted as loan collateral, every tier together. */
  postedNearWad: bigint;
  postedUsdcWad: bigint;
  /** What this tier's collateral counts for in this world, USDC (the contract's collateral value). */
  value: number;
  /** NEAR's price in this world's pool. */
  price: number;
};

export type Position = {
  sid: number;
  tier: Tier;
  worlds: WorldHolding[];
  /** Anything at all in this market: a world piece, collateral, debt or supply. */
  holdsAnything: boolean;
  debt: number;
  debtWad: bigint;
  /** Health factor (liquidation side); null without debt. */
  health: number | null;
  /** Health factor against the borrow-side values; null without debt. */
  borrowHealth: number | null;
  worstWorld: number | null;
  /** What you can borrow in this tier now, USDC: the Borrow page's room (`borrowRoom`), not the contract's whole `max_borrow`. */
  maxBorrow: number;
  maxBorrowWad: bigint;
  borrowLimit: number;
  minLoan: number;
  liquidation: LiquidationState;
  frozen: boolean;
  /** Why new borrowing is blocked in this market, when it is (contract wording). */
  borrowBlock: string | null;
  /** USDC you supply to this tier. */
  supplied: number;
  suppliedWad: bigint;
  /** Yearly rates and utilisation of this tier, 0 to 1. */
  borrowApr: number;
  supplyApr: number;
  utilization: number;
  /** Posted collateral pieces of this tier. */
  collateral: Collateral[];
  /** Real wNEAR / USDC posted in this tier: it counts in every world. */
  realNearWad: bigint;
  realUsdcWad: bigint;
  account: Account;
  scenario: Scenario;
};

const hf = (x: bigint | null): number | null => (x === null ? null : toNum(x));

/** What an account holds in one market and tier, from `borrow_view`. */
export function positionOf(snap: BorrowSnapshot, tier: Tier): Position {
  const { scenario: s, account: a } = snap;
  const real = (asset: "wnear" | "usdc") => a.collateral.filter((c) => c.isReal && c.asset === asset).reduce((t, c) => t + c.amount, 0n);
  const realNearWad = real("wnear");
  const realUsdcWad = real("usdc");
  const worlds = s.worlds.map((w): WorldHolding => {
    const nearWad = w.userWnear + w.collateralWnear;
    const usdcWad = w.userUsdc + w.collateralUsdc;
    return {
      index: w.index,
      label: w.label,
      possible: w.possible,
      near: toNum(nearWad),
      usdc: toNum(usdcWad),
      nearWad,
      usdcWad,
      walletNearWad: w.userWnear,
      walletUsdcWad: w.userUsdc,
      postedNearWad: w.collateralWnear,
      postedUsdcWad: w.collateralUsdc,
      value: toNum(a.collateralValues[w.index] ?? 0n),
      price: toNum(w.wnearPrice),
    };
  });
  const holdsAnything =
    a.debt > 0n || a.supplied > 0n || a.collateral.some((c) => c.amount > 0n) || worlds.some((w) => w.possible && (w.nearWad > 0n || w.usdcWad > 0n));
  return {
    sid: s.scenarioId,
    tier,
    worlds,
    holdsAnything,
    debt: toNum(a.debt),
    debtWad: a.debt,
    health: hf(a.healthFactor),
    borrowHealth: hf(a.borrowHealthFactor),
    worstWorld: a.worstWorld,
    maxBorrow: toNum(borrowRoom(a)),
    maxBorrowWad: borrowRoom(a),
    borrowLimit: toNum(a.borrowLimit),
    minLoan: toNum(a.minLoan),
    liquidation: a.liquidation,
    frozen: a.frozen,
    borrowBlock: a.borrowBlock,
    supplied: toNum(a.supplied),
    suppliedWad: a.supplied,
    borrowApr: toNum(annualRate(a.borrowRatePerSecond)),
    supplyApr: toNum(annualRate(a.supplyRatePerSecond)),
    utilization: toNum(a.utilization),
    collateral: a.collateral,
    realNearWad,
    realUsdcWad,
    account: a,
    scenario: s,
  };
}

