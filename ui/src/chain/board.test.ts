import { describe, expect, it } from "vitest";
import { chainMarket, type ChainMarket } from "./adapter-model";
import {
  boardCategories,
  byChance,
  chanceText,
  clock,
  compactUsd,
  durationText,
  daysUntil,
  floorExample,
  healthAfterDrop,
  impliedCheck,
  inFilter,
  leadWorld,
  matches,
  outcomeMask,
  presetsOf,
  postedByWorld,
  priceText,
  relatedOf,
  resolutionState,
  shapeName,
  sharedEvents,
  sortBoard,
} from "./board";
import type { EventMeta, EventState, MarketCard } from "./domain";

const wad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

const event = (id: number, question: string, names: [string, string], o: Partial<EventState> = {}): EventState => ({
  id,
  question,
  rule: "A rule. [ifverse:evidence]",
  outcomeNames: names,
  deadline: 1_806_537_599n,
  proposedAt: 0n,
  proposedOutcome: 0,
  proposalOpen: false,
  finalized: false,
  outcome: 0,
  finalizableAt: 0n,
  proposedBy: null,
  ...o,
});

const SPICE = event(1, "Will SPICE ship on NEAR mainnet by Mar 31, 2027?", ["SHIPS", "DELAYED"]);
const FED = event(2, "Will the Fed cut at its December 8-9, 2026 meeting?", ["CUTS", "HOLDS"]);
const NEAR = event(5, "Will NEAR close above $3.25 on Dec 31, 2026?", ["YES", "NO"]);
const OCT = event(3, "Did the Fed cut at its October 27-28, 2026 meeting?", ["CUTS", "HOLDS"], { finalized: true, outcome: 1 });
const texts = new Map([SPICE, FED, NEAR, OCT].map((e) => [e.id, e]));
const metas = new Map<number, EventMeta | null>([
  [1, { eventId: 1, proposalId: 0, proposer: null, source: "nearcore releases", category: 1 }],
  [2, { eventId: 2, proposalId: 0, proposer: null, source: "FRED", category: 2 }],
  [3, { eventId: 3, proposalId: 0, proposer: null, source: "FRED", category: 2 }],
  [5, { eventId: 5, proposalId: 0, proposer: null, source: "Coinbase", category: 3 }],
]);

const card = (o: Partial<MarketCard> = {}): MarketCard => ({
  scenarioId: 1,
  listed: true,
  origin: "owner",
  proposalId: null,
  eventIds: [1, 2],
  worldCount: 4,
  possible: 0b1111,
  status: "open",
  categories: [1, 2],
  deadlineSec: 1_796_842_800,
  createdAtSec: 0,
  odds: [wad(0.0067), wad(0.0033), wad(0.66), wad(0.33)],
  oddsKnown: true,
  worldPrices: [wad(4.36), wad(3.25), wad(3.59), wad(2.78)],
  impliedSpot: wad(0.0067 * 4.36 + 0.0033 * 3.25 + 0.66 * 3.59 + 0.33 * 2.78),
  poolValue: wad(2_653_181.2),
  minWorldDepth: wad(165_865),
  poolCount: 7,
  lendable: true,
  seed: null,
  ...o,
});

const market = (o: Partial<MarketCard> = {}): ChainMarket => {
  const m = chainMarket(card(o), texts, metas);
  if (!m) throw new Error("fixture market did not build");
  return m;
};

const anchor = market();
// three events, eight worlds (market 8 on staging)
const three = market({
  scenarioId: 8,
  eventIds: [1, 2, 5],
  worldCount: 8,
  possible: 0xff,
  categories: [1, 2, 3],
  odds: [0.0033, 0.0017, 0.33, 0.165, 0.0033, 0.0017, 0.33, 0.165].map(wad),
  worldPrices: [4.52, 3.34, 3.82, 2.82, 3.7, 2.73, 3.13, 2.31].map(wad),
  poolValue: wad(64_831.6),
  createdAtSec: 1_794_635_082,
  origin: "pledged",
  proposalId: 5,
  lendable: false,
});
// one event, settled: HOLDS happened (world 1)
const settled = market({ scenarioId: 2, eventIds: [3], worldCount: 2, possible: 0b10, status: "resolved", categories: [2], odds: [0n, wad(1)], worldPrices: [wad(3.82), wad(3.19)], poolValue: wad(66_141.7), deadlineSec: 0, lendable: false });
// one event, open
const single = market({ scenarioId: 5, eventIds: [1], worldCount: 2, possible: 0b11, categories: [1], odds: [wad(0.6667), wad(0.3333)], worldPrices: [wad(3.61), wad(2.63)], poolValue: wad(40_045), deadlineSec: 1_806_537_599, createdAtSec: 1_794_633_112, lendable: false });

describe("numbers as the board prints them", () => {
  it("prints a chance in whole percent, a sliver as <1%, an impossible world as 0%", () => {
    expect(chanceText(0.66)).toBe("66%");
    expect(chanceText(0.0067)).toBe("1%");
    expect(chanceText(0.0033)).toBe("<1%");
    expect(chanceText(0)).toBe("0%");
    expect(chanceText(Number.NaN)).toBe("0%");
  });

  it("shortens dollars", () => {
    expect(compactUsd(2_653_181.2)).toBe("$2.65M");
    expect(compactUsd(40_045)).toBe("$40.0K");
    expect(compactUsd(950.4)).toBe("$950");
    expect(compactUsd(0)).toBe("$0");
  });

  it("prints a NEAR price, or a dash before the pool has one", () => {
    expect(priceText(3.5912)).toBe("$3.59");
    expect(priceText(0)).toBe("–");
  });

  it("counts whole days to a deadline, rounding up", () => {
    expect(daysUntil(1_000 + 86_400 * 2, 1_000)).toBe(2);
    expect(daysUntil(1_000 + 86_400 * 2 + 1, 1_000)).toBe(3);
    expect(daysUntil(0, 1_000)).toBeNull();
  });
});

describe("worlds by chance", () => {
  it("lists the possible worlds, most likely first", () => {
    expect(byChance(anchor).map((w) => w.index)).toEqual([2, 3, 0, 1]);
    expect(leadWorld(anchor)?.outcome).toBe("Ships & holds");
  });

  it("drops worlds that can no longer happen", () => {
    expect(byChance(settled).map((w) => w.index)).toEqual([1]);
    expect(leadWorld(settled)?.outcome).toBe("Holds");
  });
});

describe("the board", () => {
  const all = [single, settled, three, anchor];

  it("sorts by money in pools, settled markets last", () => {
    expect(sortBoard(all, "pool").map((m) => m.sid)).toEqual([1, 8, 5, 2]);
  });

  it("sorts by the soonest deadline, a market without one after the rest", () => {
    expect(sortBoard(all, "soon").map((m) => m.sid)).toEqual([1, 8, 5, 2]);
    expect(sortBoard([single, anchor], "soon").map((m) => m.sid)).toEqual([1, 5]);
  });

  it("sorts by the newest", () => {
    expect(sortBoard(all, "new").map((m) => m.sid)).toEqual([8, 5, 1, 2]);
  });

  it("lists each category once, in the order they appear", () => {
    expect(boardCategories(all)).toEqual(["NEAR ecosystem", "Macro", "Crypto"]);
  });

  it("filters by category and watchlist", () => {
    expect(all.filter((m) => inFilter(m, "Crypto", [])).map((m) => m.sid)).toEqual([8]);
    expect(all.filter((m) => inFilter(m, "Watchlist", ["5", "2"])).map((m) => m.sid)).toEqual([5, 2]);
    expect(all.filter((m) => inFilter(m, "All", [])).length).toBe(4);
  });

  it("searches questions, outcomes and categories, and #id exactly", () => {
    expect(all.filter((m) => matches(m, "fed")).map((m) => m.sid)).toEqual([2, 8, 1]);
    expect(all.filter((m) => matches(m, "delayed")).map((m) => m.sid)).toEqual([5, 8, 1]);
    expect(all.filter((m) => matches(m, "crypto")).map((m) => m.sid)).toEqual([8]);
    expect(all.filter((m) => matches(m, "#8")).map((m) => m.sid)).toEqual([8]);
    expect(all.filter((m) => matches(m, "#80")).map((m) => m.sid)).toEqual([]);
    expect(all.filter((m) => matches(m, "  ")).length).toBe(4);
  });
});

describe("picking worlds on the market page", () => {
  it("masks every world where an event ends one way, in the contract's bit order", () => {
    // world = spice + 2 × fed: DELAYED is bit 0 set → worlds 1 and 3
    expect(outcomeMask(anchor, 0, 1)).toBe(0b1010);
    expect(outcomeMask(anchor, 1, 1)).toBe(0b1100);
    expect(outcomeMask(three, 2, 1)).toBe(0b11110000);
  });

  it("offers one pick per outcome", () => {
    expect(presetsOf(anchor)).toEqual([
      { label: "Ships", mask: 0b0101 },
      { label: "Delayed", mask: 0b1010 },
      { label: "Cuts", mask: 0b0011 },
      { label: "Holds", mask: 0b1100 },
    ]);
    expect(presetsOf(three)).toHaveLength(6);
  });

  it("leaves out picks an answer has made empty or total", () => {
    // SPICE delayed: only worlds 1 and 3 are left
    const partly = market({ possible: 0b1010 });
    expect(presetsOf(partly)).toEqual([
      { label: "Cuts", mask: 0b0010 },
      { label: "Holds", mask: 0b1000 },
    ]);
    expect(presetsOf(settled)).toEqual([]);
  });

  it("names a pick in words", () => {
    expect(shapeName(anchor, 0)).toBe("none");
    expect(shapeName(anchor, 0b1111)).toBe("every world");
    expect(shapeName(anchor, 0b1010)).toBe("every “Delayed” world");
    expect(shapeName(anchor, 0b0100)).toBe("Ships & holds");
    expect(shapeName(anchor, 0b1110)).toBe("every world but Ships & cuts");
    expect(shapeName(three, 0b111)).toBe("3 worlds");
  });

  it("ignores worlds that can no longer happen when naming", () => {
    const partly = market({ possible: 0b1010 });
    expect(shapeName(partly, 0b1111)).toBe("every world");
    expect(shapeName(partly, 0b0110)).toBe("every “Cuts” world");
  });
});

describe("checks", () => {
  it("compares the odds-weighted price with the contract's implied NEAR", () => {
    const c = impliedCheck(anchor);
    expect(c.ok).toBe(true);
    expect(c.sum).toBeCloseTo(anchor.impliedSpot, 3);
    expect(impliedCheck({ ...anchor, impliedSpot: anchor.impliedSpot * 1.1 }).ok).toBe(false);
    expect(impliedCheck({ ...anchor, impliedSpot: 0 }).ok).toBe(false);
  });
});

describe("related markets", () => {
  it("keeps the ids the board knows, most money first, never the market itself", () => {
    expect(relatedOf([5, 8, 1, 99], [single, settled, three, anchor], 1).map((m) => m.sid)).toEqual([8, 5]);
  });

  it("names the events two markets share", () => {
    expect(sharedEvents(anchor, three)).toEqual([SPICE.question, FED.question]);
    expect(sharedEvents(anchor, settled)).toEqual([]);
  });
});

describe("resolution", () => {
  const ev = (o: Partial<ChainMarket["events"][number]> = {}) => ({ ...anchor.events[1], ...o });

  it("counts down and names durations", () => {
    expect(clock(245)).toBe("4:05");
    expect(clock(-3)).toBe("0:00");
    expect(durationText(600)).toBe("10 minutes");
    expect(durationText(30)).toBe("30 seconds");
    expect(durationText(1_800)).toBe("30 minutes");
    expect(durationText(3_600)).toBe("1 hour");
    expect(durationText(604_800)).toBe("7 days");
  });

  it("says an event is open until its deadline, then waiting", () => {
    expect(resolutionState(ev(), 1_700_000_000)).toEqual({ tone: "open", text: "Open until 31 Mar 2027" });
    expect(resolutionState(ev(), 1_806_537_599)).toEqual({ tone: "open", text: "Deadline passed · waiting for the answer" });
  });

  it("shows a proposal's dispute window, then that it can be finalized", () => {
    const p = ev({ proposalOpen: true, proposedOutcome: 1, finalizableAtSec: 1_000_600, proposedBy: "reporter" });
    expect(resolutionState(p, 1_000_000)).toEqual({ tone: "live", text: "Holds proposed · dispute window 10:00" });
    expect(resolutionState(p, 1_000_600)).toEqual({ tone: "live", text: "Holds proposed · ready to finalize" });
  });

  it("names the final answer and who gave it", () => {
    expect(resolutionState(ev({ finalized: true, outcome: 1, proposedBy: "outlayer" }), 0)).toEqual({ tone: "final", text: "Holds, by OutLayer" });
    expect(resolutionState(ev({ finalized: true, outcome: 0, proposedBy: null }), 0)).toEqual({ tone: "final", text: "Cuts" });
  });
});

describe("the landing's worked example", () => {
  // 1,000 NEAR in the four worlds of the anchor, laid out Ships & cuts, Ships & holds, Delayed & cuts, Delayed & holds
  const x = { prices: [4.36, 3.59, 3.25, 2.78], proceeds: [4_300, 3_540, 3_200, 2_740], near: 1_000, ltv: 0.6, drop: 0.4 };

  it("counts NEAR at its price in each world and reads the weakest", () => {
    const f = floorExample(x, [false, false, false, false]);
    expect(f.values).toEqual([4_360, 3_590, 3_250, 2_780]);
    expect(f.limit).toBe(1_668); // 2,780 × 60%
    expect(f.afterDrop).toBe(1_000); // 2,780 × 0.6 × 60% = 1,000.8, rounded down
    expect(f.weakest).toBe(3);
    expect(f.extra).toBe(0);
  });

  it("holds dollars where it was hedged: they don't fall with NEAR", () => {
    const f = floorExample(x, [false, true, true, true]);
    expect(f.values).toEqual([4_360, 3_540, 3_200, 2_740]);
    expect(f.shocked).toEqual([2_616, 3_540, 3_200, 2_740]);
    expect(f.limit).toBe(1_644); // 2,740 × 60%
    expect(f.afterDrop).toBe(1_569); // 2,616 × 60% = 1,569.6
    expect(f.weakest).toBe(0); // after the drop the NEAR world sets the limit
    expect(f.extra).toBe(569);
  });

  it("never goes below zero", () => {
    expect(floorExample({ ...x, drop: 1 }, [false, false, false, false]).afterDrop).toBe(0);
  });
});

describe("a loan, explained", () => {
  const worlds = [1, 2, 4, 8].map((mask) => ({ mask }));
  const E = 10n ** 18n;

  it("counts a real token in every world and a world piece only where its mask covers", () => {
    const carl = postedByWorld([{ asset: "wnear", mask: 15, isReal: true, amount: 1_000n * E }], worlds);
    expect(carl.map((w) => w.near)).toEqual([1_000n * E, 1_000n * E, 1_000n * E, 1_000n * E]);
    const alice = postedByWorld(
      [
        { asset: "wnear", mask: 1, isReal: false, amount: 2_000n * E },
        { asset: "usdc", mask: 2, isReal: false, amount: 6_422n * E },
        { asset: "usdc", mask: 12, isReal: false, amount: 5n * E },
      ],
      worlds,
    );
    expect(alice.map((w) => [w.near, w.usdc])).toEqual([
      [2_000n * E, 0n],
      [0n, 6_422n * E],
      [0n, 5n * E],
      [0n, 5n * E],
    ]);
  });

  it("drops only the NEAR part of each world", () => {
    // Carl: NEAR everywhere, Bold (80%): weakest 2,765 → 1,659 after a 40% fall, health 0.82 on 1,615.6
    const carl = [4_329, 3_229, 3_567, 2_765].map((value, i) => ({ value, near: 1_000, price: [4.36, 3.25, 3.59, 2.78][i], possible: true }));
    expect(healthAfterDrop(carl, 1_615.6, 0.8, 0.4)).toBeCloseTo((2_765 * 0.6 * 0.8) / 1_615.6, 6);
    // Alice: NEAR only in world 0, Normal (70%): 8,658.9 → 5,195.3 becomes the weakest
    const alice = [
      { value: 8_658.9, near: 2_000, price: 4.36, possible: true },
      { value: 6_422.7, near: 0, price: 3.25, possible: true },
      { value: 7_064.9, near: 0, price: 3.59, possible: true },
      { value: 5_283.4, near: 0, price: 2.78, possible: true },
    ];
    expect(healthAfterDrop(alice, 2_536.1, 0.7, 0.4)).toBeCloseTo((8_658.9 * 0.6 * 0.7) / 2_536.1, 6);
  });

  it("has no health without a loan, and ignores worlds that can no longer happen", () => {
    expect(healthAfterDrop([{ value: 10, near: 1, price: 10, possible: true }], 0, 0.7, 0.4)).toBeNull();
    expect(healthAfterDrop([{ value: 10, near: 1, price: 10, possible: false }, { value: 100, near: 0, price: 3, possible: true }], 50, 0.5, 0.4)).toBe(1);
  });
});
