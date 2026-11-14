import { describe, expect, it } from "vitest";
import { chainMarket, eventArt, positionOf, ruleText, sentence, toNum, worldGrid, worldName } from "./adapter-model";
import type { Account, BorrowSnapshot, EventMeta, EventState, MarketCard, Scenario, World } from "./domain";

const E = 10n ** 18n;
const wad = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

const event = (id: number, question: string, names: [string, string], rule: string, o: Partial<EventState> = {}): EventState => ({
  id,
  question,
  rule,
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

const SPICE = event(1, "Will SPICE ship on NEAR mainnet by Mar 31, 2027?", ["SHIPS", "DELAYED"], "SHIPS if SPICE is active on mainnet. [ifverse:evidence]");
const FED = event(2, "Will the Fed cut at its December 8-9, 2026 meeting?", ["CUTS", "HOLDS"], "CUTS if both limits are lower. [ifverse:fomc:2026-12-08:2026-12-10]", {
  deadline: 1_796_842_800n,
});
const NEAR = event(5, "Will NEAR close above $3.25 on Dec 31, 2026?", ["YES", "NO"], "YES if it closes above. [ifverse:price_close:NEAR-USD:2026-12-31:3.25]");

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
  createdAtSec: 1_794_600_000,
  odds: [wad(0.4), wad(0.2), wad(0.3), wad(0.1)],
  oddsKnown: true,
  worldPrices: [wad(4.36), wad(3.25), wad(3.9), wad(2.8)],
  impliedSpot: wad(3.337),
  poolValue: wad(2_653_181.2),
  minWorldDepth: wad(50_000),
  poolCount: 6,
  lendable: true,
  seed: null,
  ...o,
});

const texts = new Map([SPICE, FED, NEAR].map((e) => [e.id, e]));
const metas = new Map<number, EventMeta | null>([
  [1, { eventId: 1, proposalId: 0, proposer: null, source: "github.com/near/nearcore/releases", category: 1 }],
  [2, { eventId: 2, proposalId: 0, proposer: null, source: "FRED DFEDTARU and DFEDTARL", category: 2 }],
]);

describe("words", () => {
  it("puts outcome names in sentence case and drops the rule's machine tag", () => {
    expect(sentence("DELAYED")).toBe("Delayed");
    expect(ruleText(FED.rule)).toBe("CUTS if both limits are lower.");
    expect(ruleText("no tag here")).toBe("no tag here");
  });

  it("picks an event's artwork from its tag", () => {
    expect(eventArt(FED)).toBe("/markets/fed.svg");
    expect(eventArt({ ...FED, finalized: true })).toBe("/markets/fed-oct.svg");
    expect(eventArt(NEAR)).toBe("/markets/near-price.svg");
    expect(eventArt(SPICE)).toBe("/markets/spice.svg");
    expect(eventArt(event(9, "Will it rain?", ["YES", "NO"], "plain"))).toBeUndefined();
  });

  it("names a world by its outcomes, event A first", () => {
    const evs = [{ outcomes: ["Ships", "Delayed"] }, { outcomes: ["Cuts", "Holds"] }];
    expect([0, 1, 2, 3].map((w) => worldName(evs, w))).toEqual(["Ships & cuts", "Delayed & cuts", "Ships & holds", "Delayed & holds"]);
  });

  it("reads a wad as a number for display", () => {
    expect(toNum(3n * E / 2n)).toBe(1.5);
    expect(toNum(null)).toBe(0);
  });
});

describe("the world grid, in contract order", () => {
  const ev = (name: string, a: string, b: string) => ({ name, outcomes: [a, b] });
  it("one event: one row of two worlds", () => {
    expect(worldGrid([ev("Fed", "Cuts", "Holds")]).rows).toEqual([{ label: "", worlds: [0, 1] }]);
  });
  it("two events: rows are event A, columns event B (world = a + 2b)", () => {
    const g = worldGrid([ev("SPICE", "Ships", "Delayed"), ev("Fed", "Cuts", "Holds")]);
    expect(g.rows).toEqual([
      { label: "Ships", worlds: [0, 2] },
      { label: "Delayed", worlds: [1, 3] },
    ]);
    expect(g.cols).toEqual(["Cuts", "Holds"]);
  });
  it("three events: columns run over B then C (world = a + 2b + 4c)", () => {
    const g = worldGrid([ev("A", "a0", "a1"), ev("B", "b0", "b1"), ev("C", "c0", "c1")]);
    expect(g.rows.map((r) => r.worlds)).toEqual([
      [0, 4, 2, 6],
      [1, 5, 3, 7],
    ]);
    expect(g.cols).toEqual(["b0 · c0", "b0 · c1", "b1 · c0", "b1 · c1"]);
    expect(g.rows.flatMap((r) => r.worlds).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("a market from its card and its events", () => {
  it("waits for every event's text", () => {
    expect(chainMarket(card({ eventIds: [1, 7] }), texts, metas)).toBeUndefined();
  });

  it("lifts the card into the views' shape", () => {
    const m = chainMarket(card(), texts, metas)!;
    expect(m).toMatchObject({ sid: 1, id: "1", href: "/market/?id=1", category: "NEAR ecosystem", categories: ["NEAR ecosystem", "Macro"], kind: "Combination · 4 worlds" });
    expect(m.question).toBe(`${SPICE.question} × ${FED.question}`);
    expect(m.title).toBe(m.question);
    expect(m.resolves).toBe("9 Dec 2026");
    expect(m.lendable).toBe(true);
    expect(m.tiers).toEqual(["safe", "normal", "bold"]);
    expect(m.liquidity).toBeCloseTo(2_653_181.2, 1);
    expect(m.events[1]).toMatchObject({ name: FED.question, outcomes: ["Cuts", "Holds"], rule: "CUTS if both limits are lower.", sources: ["FRED DFEDTARU and DFEDTARL"], categoryName: "Macro" });
    expect(m.worlds.map((w) => [w.label, w.outcome, w.digits])).toEqual([
      ["SHIPS·CUTS", "Ships & cuts", [0, 0]],
      ["DELAYED·CUTS", "Delayed & cuts", [1, 0]],
      ["SHIPS·HOLDS", "Ships & holds", [0, 1]],
      ["DELAYED·HOLDS", "Delayed & holds", [1, 1]],
    ]);
    expect(m.worlds.map((w) => w.chance)).toEqual([0.4, 0.2, 0.3, 0.1]);
    expect(m.worlds[0].nearPrice).toBeCloseTo(4.36, 6);
  });

  it("reads a resolved market as settled, with the world that happened, and no lending", () => {
    const m = chainMarket(card({ scenarioId: 2, eventIds: [2], worldCount: 2, possible: 0b10, status: "resolved", odds: [0n, E], worldPrices: [wad(3.8), wad(3.2)], lendable: false, categories: [2] }), texts, metas)!;
    expect(m).toMatchObject({ settled: true, winner: 1, resolves: "Settled", tiers: [] });
    expect(m.worlds.map((w) => [w.possible, w.chance])).toEqual([
      [false, 0],
      [true, 1],
    ]);
  });

  it("keeps an event without metadata sourceless, in Other", () => {
    const m = chainMarket(card({ eventIds: [5], worldCount: 2, possible: 0b11, categories: [] }), texts, metas)!;
    expect(m.events[0]).toMatchObject({ sources: [], categoryName: "Other", image: "/markets/near-price.svg" });
    expect(m.category).toBe("Other");
  });
});

describe("a position from borrow_view", () => {
  const world = (index: number, o: Partial<World> = {}): World => ({
    index,
    mask: 1 << index,
    label: ["SHIPS·CUTS", "DELAYED·CUTS", "SHIPS·HOLDS", "DELAYED·HOLDS"][index],
    possible: true,
    poolInitialized: true,
    wnearPrice: wad(3.5),
    backed: true,
    wnearTokenId: `w${index}`,
    usdcTokenId: `u${index}`,
    userWnear: 0n,
    userUsdc: 0n,
    collateralWnear: 0n,
    collateralUsdc: 0n,
    odds: wad(0.25),
    poolId: index + 1,
    ...o,
  });
  const scenario: Scenario = {
    scenarioId: 1,
    worldCount: 4,
    possible: 0b1111,
    resolutionCount: 0,
    halted: false,
    eventIds: [1, 2],
    spotPrice: wad(3.3),
    worlds: [world(0, { userWnear: 10n * E }), world(1, { collateralUsdc: 30n * E }), world(2, { userWnear: 4n * E, collateralWnear: 6n * E }), world(3)],
    oddsKnown: true,
    impliedSpot: wad(3.3),
  };
  const account = {
    debt: 100n * E,
    healthFactor: wad(1.46),
    worstWorld: 1,
    collateralValues: [wad(35), wad(30), wad(35), 0n],
    worldPriceOk: [true, true, true, true],
    collateral: [
      { tokenId: "usdc", label: "USDC", asset: "usdc", mask: 0b1111, isReal: true, amount: 5n * E },
      { tokenId: "u1", label: "USDC-if-DELAYED·CUTS", asset: "usdc", mask: 0b10, isReal: false, amount: 30n * E },
    ],
    supplied: 0n,
    supplyPrincipal: 0n,
    marketSupply: 0n,
    marketBorrow: 0n,
    utilization: wad(0.5),
    borrowRatePerSecond: 1_585_489_599n,
    supplyRatePerSecond: 0n,
    lltv: wad(0.75),
    liquidation: "none",
    unpricedWorld: null,
    tier: "normal",
    borrowLtv: wad(0.7),
    borrowHealthFactor: wad(1.3),
    borrowLimit: wad(120),
    maxBorrow: wad(20),
    liquidationBonus: wad(0.05),
    insurance: 0n,
    minLoan: wad(10),
    frozen: false,
    maxRepay: 0n,
    writeOffReady: false,
    worldStatus: ["trusted", "trusted", "trusted", "trusted"],
    borrowBlock: null,
    liquidationFactor: E,
  } satisfies Account;
  const snap: BorrowSnapshot = { scenario, account, nowSec: 1_800_000_000n };

  it("adds the wallet pieces and the posted collateral of each world", () => {
    const p = positionOf(snap, "normal");
    expect(p.worlds.map((w) => [w.near, w.usdc])).toEqual([
      [10, 0],
      [0, 30],
      [10, 0],
      [0, 0],
    ]);
    expect(p.worlds[2]).toMatchObject({ walletNearWad: 4n * E, postedNearWad: 6n * E, value: 35 });
    expect(p.realUsdcWad).toBe(5n * E);
    expect(p.realNearWad).toBe(0n);
  });

  it("carries the loan: debt, health, worst world, limits and the yearly rate", () => {
    const p = positionOf(snap, "normal");
    expect(p).toMatchObject({ sid: 1, tier: "normal", holdsAnything: true, debt: 100, health: 1.46, borrowHealth: 1.3, worstWorld: 1, maxBorrow: 20, minLoan: 10, utilization: 0.5 });
    expect(p.borrowApr).toBeCloseTo(0.05, 4);
  });

  it("reads an empty account as holding nothing, with no health", () => {
    const empty = positionOf(
      { ...snap, scenario: { ...scenario, worlds: scenario.worlds.map((w) => ({ ...w, userWnear: 0n, collateralUsdc: 0n, collateralWnear: 0n })) }, account: { ...account, debt: 0n, healthFactor: null, borrowHealthFactor: null, collateral: [] } },
      "safe",
    );
    expect(empty).toMatchObject({ holdsAnything: false, health: null, borrowHealth: null, tier: "safe" });
  });
});
