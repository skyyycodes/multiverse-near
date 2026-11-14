import { describe, expect, it } from "vitest";
import type { Account, Scenario, World } from "./domain";
import { fmt, fmtHf, parseAmount, pct } from "./format";
import { annualRate, barWidth, borrowMath, earnedOf, linePosition, liquidationOf, neededValue, WAD, worstValue } from "./lending";

const wad = (s: string) => parseAmount(s)!;

function account(p: Partial<Account> = {}): Account {
  return {
    debt: 0n,
    healthFactor: null,
    worstWorld: 3,
    // Alice after her sale (DemoSale): 2,000 NEAR-if-SHIPS·CUTS at 3.70, then her proceeds in the other worlds.
    collateralValues: [wad("7399.26"), wad("5865.050885346196835108"), wad("6451.555973880816518618"), wad("4881.885259897065638949")],
    worldPriceOk: [true, true, true, true],
    collateral: [],
    supplied: 0n,
    supplyPrincipal: 0n,
    marketSupply: wad("100000"),
    marketBorrow: 0n,
    utilization: 0n,
    borrowRatePerSecond: 1_585_489_599n,
    supplyRatePerSecond: 0n,
    lltv: wad("0.75"),
    liquidation: "none",
    unpricedWorld: null,
    // the v2 keys as a v1 view decodes them (one Normal tier lent up to its lltv)
    tier: "normal",
    borrowLtv: wad("0.75"),
    borrowHealthFactor: null,
    borrowLimit: 0n,
    maxBorrow: 0n,
    liquidationBonus: 0n,
    insurance: 0n,
    minLoan: 0n,
    frozen: false,
    maxRepay: 0n,
    writeOffReady: false,
    worldStatus: ["trusted", "trusted", "trusted", "trusted"],
    borrowBlock: null,
    liquidationFactor: WAD,
    ...p,
  };
}

const world = (i: number, collateralWnear = 0n): World => ({
  index: i,
  mask: 1 << i,
  label: ["SHIPS·CUTS", "DELAYED·CUTS", "SHIPS·HOLDS", "DELAYED·HOLDS"][i],
  possible: true,
  poolInitialized: true,
  wnearPrice: 0n,
  backed: true,
  wnearTokenId: "",
  usdcTokenId: "",
  userWnear: 0n,
  userUsdc: 0n,
  collateralWnear,
  collateralUsdc: 0n,
  odds: 0n,
  poolId: null,
});
const scenario = (halted = false, worlds = [0, 1, 2, 3].map((i) => world(i))): Scenario => ({
  scenarioId: 1,
  worldCount: 4,
  possible: 0b1111,
  resolutionCount: 0,
  halted,
  eventIds: [1, 2],
  spotPrice: 0n,
  worlds,
  oddsKnown: true,
  impliedSpot: 0n,
});

describe("borrow maths", () => {
  it("finds the worst world among the possible ones", () => {
    const v = account().collateralValues;
    expect(worstValue(v, 0b1111)).toBe(v[3]);
    expect(worstValue(v, 0b0111)).toBe(v[1]);
    expect(worstValue(v, 0)).toBeUndefined();
  });

  it("reproduces Alice's 1.22 at a 3,000 borrow, and the max sits 0.5% under HF 1", () => {
    const m = borrowMath(account(), 0b1111, wad("3000"));
    expect(fmtHf(m.hfAfter!)).toBe("1.22");
    expect(m.hfAfter).toBe(1_220_471_314_974_266_409n); // DemoSale's raw HF
    expect(fmt(m.capacity)).toBe("3,661.41");
    expect(m.room).toBe((m.capacity * 995n) / 1000n);
    expect(m.liquidity).toBe(wad("100000"));
  });

  it("has no health factor after without collateral or without an amount", () => {
    expect(borrowMath(account({ collateralValues: [0n, 0n, 0n, 0n] }), 0b1111, wad("1")).hfAfter).toBeUndefined();
    expect(borrowMath(account(), 0b1111, undefined).hfAfter).toBeUndefined();
  });

  it("draws the HF 1 line and the bars", () => {
    const debt = wad("3000");
    expect(neededValue(debt, wad("0.75"))).toBe(wad("4000"));
    expect(neededValue(0n, wad("0.75"))).toBe(0n);
    expect(barWidth(wad("50"), wad("100"))).toBe(50);
    expect(barWidth(1n, 0n)).toBe(0);
    expect(linePosition(wad("150"), wad("100"))).toBe(100);
  });

  it("annualises the fixed 5% rate", () => {
    expect(pct(annualRate(1_585_489_599n), WAD, 2)).toBe("5.00%");
    expect(earnedOf(account({ supplied: wad("101"), supplyPrincipal: wad("100") }))).toBe(wad("1"));
    expect(earnedOf(account({ supplied: wad("99"), supplyPrincipal: wad("100") }))).toBe(0n);
  });
});

describe("liquidation status", () => {
  const unhealthy = { debt: wad("3367"), healthFactor: wad("0.93") };

  it("is none while the loan is healthy", () => {
    expect(liquidationOf(account({ debt: wad("1"), healthFactor: wad("1.2") }), scenario()).state).toBe("none");
    expect(liquidationOf(account(), scenario()).state).toBe("none");
  });

  it("follows the contract's own answer when it gives one", () => {
    expect(liquidationOf(account({ ...unhealthy, liquidation: "liquidatable" }), scenario()).state).toBe("liquidatable");
    const paused = liquidationOf(account({ ...unhealthy, liquidation: "paused_no_price", unpricedWorld: 3 }), scenario());
    expect(paused).toEqual({ state: "paused_no_price", unpricedLabel: "DELAYED·HOLDS" });
  });

  it("does not second-guess the contract", () => {
    // halted scenario, unhealthy loan, but the contract says it can be liquidated: the screen says so too
    expect(liquidationOf(account({ ...unhealthy, liquidation: "liquidatable" }), scenario(true)).state).toBe("liquidatable");
    expect(liquidationOf(account({ ...unhealthy, liquidation: "none" }), scenario()).state).toBe("none");
  });
});
