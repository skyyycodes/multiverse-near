import { describe, expect, it } from "vitest";
import type { MarketCard, ProposalSummary } from "./domain";
import {
  cardMatches,
  checkState,
  chunks,
  digit,
  eventIdsOf,
  eventOdds,
  eventsOf,
  filterMarkets,
  filterProposals,
  fold,
  gridBlocks,
  isWebSource,
  kindLabel,
  nextDeadline,
  oddsPair,
  parseFilter,
  parseSort,
  pledgedValue,
  priceRange,
  proposalMatches,
  shortDate,
  sortMarkets,
  sortProposals,
  statusLine,
  survivor,
  tabOf,
  utcMinute,
  worldLabel,
  yoursOf,
} from "./market";

const E18 = 10n ** 18n;
const wad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

function card(p: Partial<MarketCard> & { scenarioId: number }): MarketCard {
  return {
    listed: true,
    origin: "owner",
    proposalId: null,
    eventIds: [1],
    worldCount: 2,
    possible: 0b11,
    status: "open",
    categories: [1],
    deadlineSec: 0,
    createdAtSec: 0,
    odds: [E18 / 2n, E18 / 2n],
    oddsKnown: true,
    worldPrices: [wad(3.4), wad(2.8)],
    impliedSpot: wad(3.1),
    poolValue: 0n,
    minWorldDepth: 0n,
    poolCount: 1,
    lendable: false,
    seed: null,
    ...p,
  };
}

function proposal(p: Partial<ProposalSummary> & { proposalId: number }): ProposalSummary {
  return {
    kind: "market",
    proposer: "ana.testnet",
    status: "pledging",
    voidReason: null,
    blocker: null,
    eventIds: [1, 2],
    worldCount: 4,
    newEvent: null,
    category: 0,
    deadlineSec: 0,
    createdAtSec: 0,
    approvedAtSec: 0,
    expiresAtSec: 0,
    openNotBeforeSec: 0,
    goal: 1000n * E18,
    idealWnear: 0n,
    idealUsdc: 0n,
    sHint: 3n * E18,
    pledgedWnear: 0n,
    pledgedUsdc: 0n,
    pledgers: 0,
    progressBps: 0,
    bond: 0n,
    reserve: 0n,
    seedLockSec: 0,
    opened: null,
    ...p,
  };
}

const texts = new Map([
  [1, { question: "Will SPICE ship by March?", outcomeNames: ["SHIPS", "DELAYED"] }],
  [2, { question: "Will the Fed cut in December?", outcomeNames: ["CUTS", "HOLDS"] }],
  [3, { question: "Will Ré launch?", outcomeNames: ["YES", "NO"] }],
]);

describe("world digits and labels", () => {
  it("reads event k's outcome as the k-th binary digit (world = a + 2b + 4c)", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((w) => digit(w, 0))).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((w) => digit(w, 1))).toEqual([0, 0, 1, 1, 0, 0, 1, 1]);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((w) => digit(w, 2))).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it("labels a world with each event's outcome, A first", () => {
    const evs = [texts.get(1)!, texts.get(2)!, texts.get(3)!];
    expect(worldLabel(evs, 0)).toBe("SHIPS·CUTS·YES");
    expect(worldLabel(evs, 5)).toBe("DELAYED·CUTS·NO");
    expect(worldLabel(evs.slice(0, 1), 1)).toBe("DELAYED");
  });

  it("orders the cells of a two-column grid per 2×2 block", () => {
    expect(gridBlocks(2)).toEqual([[0, 1]]);
    expect(gridBlocks(4)).toEqual([[0, 2, 1, 3]]);
    expect(gridBlocks(8)).toEqual([
      [0, 2, 1, 3],
      [4, 6, 5, 7],
    ]);
  });

  it("finds the survivor only once one world is left", () => {
    expect(survivor(0b0100, 4)).toBe(2);
    expect(survivor(0b0110, 4)).toBeUndefined();
    expect(survivor(0b1000_0000, 8)).toBe(7);
  });
});

describe("card odds (web 7.10)", () => {
  // SPICE × Fed with world odds (0.0067, 0.0033, 0.66, 0.33)
  const c = card({ scenarioId: 5, eventIds: [1, 2], worldCount: 4, possible: 0b1111, odds: [wad(0.0067), wad(0.0033), wad(0.66), wad(0.33)] });

  it("sums the possible worlds of each outcome", () => {
    expect(eventOdds(c, 0)).toEqual([wad(0.6667), wad(0.3333)]);
    expect(eventOdds(c, 1)).toEqual([wad(0.01), wad(0.99)]);
    expect(oddsPair(eventOdds(c, 0))).toEqual(["67%", "33%"]);
    expect(oddsPair(eventOdds(c, 1))).toEqual(["1%", "99%"]);
  });

  it("leaves dead worlds out", () => {
    const half = { ...c, possible: 0b0101, odds: [wad(0.4), 0n, wad(0.6), 0n] };
    expect(eventOdds(half, 0)).toEqual([E18, 0n]);
    expect(oddsPair(eventOdds(half, 1))).toEqual(["40%", "60%"]);
  });

  it("never reads 99% + 0%, and says nothing when nothing is known", () => {
    expect(oddsPair([wad(0.995), wad(0.005)])).toEqual(["100%", "0%"]);
    expect(oddsPair([wad(0.994), wad(0.006)])).toEqual(["99%", "1%"]);
    expect(oddsPair([0n, 0n])).toEqual(["—", "—"]);
  });

  it("spans the possible worlds that have a price", () => {
    const k = card({ scenarioId: 6, worldCount: 4, eventIds: [1, 2], possible: 0b1011, worldPrices: [wad(3), wad(2.5), wad(9), 0n] });
    expect(priceRange(k)).toEqual({ min: wad(2.5), max: wad(3) });
    expect(priceRange({ ...k, worldPrices: [0n, 0n, 0n, 0n] })).toBeUndefined();
  });
});

describe("labels", () => {
  it("names a market's kind", () => {
    expect(kindLabel(1, 2)).toBe("Single event");
    expect(kindLabel(2, 4)).toBe("Combination · 4 worlds");
    expect(kindLabel(3, 8)).toBe("3 events · 8 worlds");
  });

  it("writes dates in UTC", () => {
    expect(shortDate(1806537599)).toBe("31 Mar 2027");
    expect(utcMinute(1806537599)).toBe("2027-03-31 23:59 UTC");
  });
});

describe("search", () => {
  it("folds case and accents", () => {
    expect(fold("  Ré LAUNCH ")).toBe("re launch");
  });

  it("matches questions, outcomes, categories and an exact #id", () => {
    const c = card({ scenarioId: 5, eventIds: [1, 2], categories: [1, 2] });
    expect(cardMatches(c, texts, "fed")).toBe(true);
    expect(cardMatches(c, texts, "delayed")).toBe(true);
    expect(cardMatches(c, texts, "macro")).toBe(true);
    expect(cardMatches(c, texts, "#5")).toBe(true);
    expect(cardMatches(card({ scenarioId: 50 }), texts, "#5")).toBe(false);
    expect(cardMatches(c, texts, "bitcoin")).toBe(false);
    expect(cardMatches(card({ scenarioId: 7, eventIds: [3] }), texts, "re")).toBe(true);
    expect(cardMatches(c, texts, "")).toBe(true);
  });

  it("matches a proposal by its new event, its events and p<id>", () => {
    const a = proposal({ proposalId: 12, kind: "new_event", eventIds: [], newEvent: { question: "Will ETH flip?", outcomeNames: ["FLIPS", "NOT"], deadlineSec: 0, category: 3, terms: { odds0Bps: 5000, multBps: [10000, 10000] } } });
    expect(proposalMatches(a, texts, "flip")).toBe(true);
    expect(proposalMatches(a, texts, "crypto")).toBe(true);
    expect(proposalMatches(a, texts, "p12")).toBe(true);
    expect(proposalMatches(a, texts, "p1")).toBe(false);
    expect(proposalMatches(proposal({ proposalId: 3 }), texts, "spice")).toBe(true);
  });
});

describe("filters and sort", () => {
  const cards = [
    card({ scenarioId: 1, eventIds: [1], categories: [1], poolValue: 5n, deadlineSec: 300, createdAtSec: 10 }),
    card({ scenarioId: 2, eventIds: [1, 2], categories: [1, 2], poolValue: 9n, deadlineSec: 0, createdAtSec: 0 }),
    card({ scenarioId: 3, eventIds: [2], categories: [2], poolValue: 9n, deadlineSec: 100, createdAtSec: 30, status: "deciding" }),
    card({ scenarioId: 4, eventIds: [3], categories: [0], status: "resolved", proposalId: 8 }),
  ];
  const ids = (xs: readonly { scenarioId: number }[]) => xs.map((c) => c.scenarioId);

  it("reads only known keys from the URL", () => {
    expect(parseFilter("cat-2")).toBe("cat-2");
    expect(parseFilter("nope")).toBe("all");
    expect(parseFilter(null)).toBe("all");
    expect(parseSort("deadline")).toBe("deadline");
    expect(parseSort("x")).toBe("pool");
  });

  it("keeps resolved markets out of every filter but Resolved and Yours", () => {
    expect(ids(filterMarkets(cards, "all"))).toEqual([1, 2, 3]);
    expect(ids(filterMarkets(cards, "single"))).toEqual([1, 3]);
    expect(ids(filterMarkets(cards, "combo"))).toEqual([2]);
    expect(ids(filterMarkets(cards, "cat-2"))).toEqual([2, 3]);
    expect(ids(filterMarkets(cards, "cat-0"))).toEqual([]);
    expect(ids(filterMarkets(cards, "pledging"))).toEqual([]);
    expect(ids(filterMarkets(cards, "resolved"))).toEqual([4]);
    expect(ids(filterMarkets(cards, "yours", { markets: new Set([4, 1]), proposals: new Set() }))).toEqual([1, 4]);
  });

  it("collects the account's markets: held, and opened from its pledges", () => {
    const y = yoursOf([2], [{ proposalId: 8 }, { proposalId: 11 }], cards);
    expect([...y.markets].sort((a, b) => a - b)).toEqual([2, 4]);
    expect([...y.proposals].sort((a, b) => a - b)).toEqual([8, 11]);
  });

  it("filters live proposals", () => {
    const ps = [
      proposal({ proposalId: 1, kind: "new_event", status: "review", newEvent: { question: "q", outcomeNames: ["A", "B"], deadlineSec: 0, category: 2, terms: { odds0Bps: 5000, multBps: [10000, 10000] } } }),
      proposal({ proposalId: 2, kind: "market", status: "pledging", category: 1 }),
      proposal({ proposalId: 3, status: "opened" }),
    ];
    expect(filterProposals(ps, "all").map((p) => p.proposalId)).toEqual([1, 2]);
    expect(filterProposals(ps, "single").map((p) => p.proposalId)).toEqual([1]);
    expect(filterProposals(ps, "combo").map((p) => p.proposalId)).toEqual([2]);
    expect(filterProposals(ps, "cat-2").map((p) => p.proposalId)).toEqual([1]);
    expect(filterProposals(ps, "pledging").map((p) => p.proposalId)).toEqual([1, 2]);
    expect(filterProposals(ps, "resolved")).toEqual([]);
    expect(filterProposals(ps, "yours", { markets: new Set(), proposals: new Set([2]) }).map((p) => p.proposalId)).toEqual([2]);
  });

  it("sorts by pool value (ties by id), deadline (none last) and newest", () => {
    expect(ids(sortMarkets(cards, "pool"))).toEqual([2, 3, 1, 4]);
    expect(ids(sortMarkets(cards, "deadline"))).toEqual([3, 1, 2, 4]);
    expect(ids(sortMarkets(cards, "newest"))).toEqual([3, 1, 4, 2]);
  });

  it("sorts proposals closest to their goal first, then the soonest to expire", () => {
    const ps = [
      proposal({ proposalId: 1, progressBps: 5000, expiresAtSec: 50 }),
      proposal({ proposalId: 2, progressBps: 9000, expiresAtSec: 90 }),
      proposal({ proposalId: 3, progressBps: 5000, expiresAtSec: 20 }),
    ];
    expect(sortProposals(ps).map((p) => p.proposalId)).toEqual([2, 3, 1]);
  });
});

describe("helpers", () => {
  it("values pledges in USDC at the spot hint (web 7.5)", () => {
    expect(pledgedValue({ pledgedUsdc: 100n * E18, pledgedWnear: 10n * E18, sHint: wad(3.5) })).toBe(135n * E18);
  });

  it("collects event ids once and texts once all have loaded", () => {
    expect(eventIdsOf([{ eventIds: [2, 1] }, { eventIds: [1, 3] }])).toEqual([2, 1, 3]);
    expect(eventsOf([1, 2], texts)?.map((e) => e.outcomeNames[0])).toEqual(["SHIPS", "CUTS"]);
    expect(eventsOf([1, 9], texts)).toBeUndefined();
  });

  it("splits ids into the views' chunk sizes", () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 12)).toEqual([]);
  });
});

describe("market header", () => {
  const ev = (finalized: boolean, deadline: number) => ({ finalized, deadline: BigInt(deadline) });

  it("states the market's progress", () => {
    expect(statusLine(5, 4, [ev(false, 0), ev(false, 0)], false)).toBe("#5 · 4 worlds · 0 of 2 resolved");
    expect(statusLine(7, 8, [ev(true, 0), ev(false, 0), ev(false, 0)], true)).toBe("#7 · 8 worlds · 1 of 3 resolved · paused: resolution pending");
  });

  it("takes the soonest deadline of an open event", () => {
    expect(nextDeadline([ev(true, 100), ev(false, 300), ev(false, 200)])).toBe(200);
    expect(nextDeadline([ev(true, 100)])).toBeUndefined();
  });

  it("names the outside price check", () => {
    expect(checkState({ config: { reference: true }, borrowBlock: null })).toBe("on");
    expect(checkState({ config: { reference: false }, borrowBlock: null })).toBe("off");
    expect(checkState({ config: { reference: true }, borrowBlock: "ReferenceStale" })).toBe("blocked");
  });

  it("links only https sources", () => {
    expect(isWebSource("https://www.federalreserve.gov/")).toBe(true);
    expect(isWebSource("http://example.com")).toBe(false);
    expect(isWebSource("The Fed's statement")).toBe(false);
  });

  it("finds the tab of a path, slash or not", () => {
    expect(tabOf("/market/")).toBe("trade");
    expect(tabOf("/orders")).toBe("orders");
    expect(tabOf("/world/")).toBeUndefined();
    expect(tabOf("/")).toBeUndefined();
  });
});
