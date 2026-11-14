import { describe, expect, it } from "vitest";
import type { Account, LendingMarket, Scenario, TierConfig, World } from "./domain";
import { fmt, fmtHf, parseAmount, pct } from "./format";
import {
  annualRate,
  badDebtNotice,
  badDebtOf,
  barWidth,
  borrowBanner,
  borrowBlocker,
  borrowMath,
  borrowRate,
  curvePoints,
  cushion,
  earnedOf,
  linePosition,
  liquidationOf,
  neededValue,
  repayAllSend,
  repayBlocker,
  supplyBlocker,
  supplyRate,
  utilizationOf,
  WAD,
  withdrawBlocker,
  worstValue,
  writeOffShown,
} from "./lending";

const wad = (s: string) => parseAmount(s)!;

// The contract's built-in tiers (tiers.rs `TierState::builtin`): bps → per-second rates rounded down.
const perSec = (bps: bigint) => (bps * 10n ** 14n) / 31_536_000n;
const bp = (bps: bigint) => bps * 10n ** 14n;
function builtin(lltv: bigint, ltv: bigint, bonus: bigint, base: bigint, s1: bigint, s2: bigint): TierConfig {
  return {
    lltv: bp(lltv),
    borrowLtv: bp(ltv),
    liquidationBonus: bp(bonus),
    reserveFactor: bp(1_000n),
    rateBase: perSec(base),
    rateSlope1: perSec(s1),
    rateSlope2: perSec(s2),
    rateKink: bp(8_000n),
    maxUtilization: bp(9_000n),
    borrowCap: null,
  };
}
const SAFE = builtin(6_000n, 5_000n, 500n, 100n, 400n, 4_500n);
const NORMAL = builtin(7_000n, 6_000n, 600n, 200n, 600n, 5_200n);
const BOLD = builtin(8_000n, 7_000n, 800n, 300n, 900n, 6_300n);

function tierMarket(config: TierConfig, tsa: bigint, tba: bigint, p: Partial<LendingMarket> = {}): LendingMarket {
  return {
    tier: "normal",
    totalSupply: tsa,
    totalBorrow: tba,
    totalSupplyShares: tsa,
    totalBorrowShares: tba,
    utilization: utilizationOf(tba, tsa),
    supplyRatePerSec: 0n,
    borrowRatePerSec: 0n,
    lastUpdateSec: 0,
    insurance: 0n,
    liquid: tsa - tba,
    badDebtCovered: 0n,
    badDebtSocialized: 0n,
    borrowers: 0,
    frozen: false,
    config,
    ...p,
  };
}

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

  it("reproduces Alice's 1.22 at a 3,000 borrow on legacy Normal (0.75 / 0.65), with max 0.5% under the view's max", () => {
    const limit = (wad("4881.885259897065638949") * wad("0.65")) / WAD;
    const m = borrowMath(account({ borrowLtv: wad("0.65"), borrowLimit: limit, maxBorrow: limit, minLoan: wad("100") }), 0b1111, wad("3000"));
    expect(fmtHf(m.hfAfter!)).toBe("1.22");
    expect(m.hfAfter).toBe(1_220_471_314_974_266_409n); // DemoSale's raw HF
    expect(fmt(m.limit)).toBe("3,173.22");
    expect(pct(m.limitUsedAfter!, WAD, 1)).toBe("94.5%");
    expect(m.room).toBe((limit * 995n) / 1000n);
    expect(m.belowMinLoan).toBe(false);
  });

  it("works web 7.1's Normal example: room 2,985, HF after 1.21, APR after 28.76%, min loan", () => {
    const market = tierMarket(NORMAL, wad("100000"), wad("85000"));
    const v = account({ lltv: wad("0.70"), borrowLtv: wad("0.60"), collateralValues: [wad("5200"), wad("6000"), wad("7000"), wad("8000")], borrowLimit: wad("3000"), maxBorrow: wad("3000"), minLoan: wad("100") });
    const m = borrowMath(v, 0b1111, wad("2985"), market);
    expect(fmt(m.room)).toBe("2,985.00");
    expect(fmtHf(m.hfAfter!)).toBe("1.21");
    expect(pct(m.limitUsedAfter!, WAD, 1)).toBe("99.5%");
    expect(pct(m.aprAfter!, WAD, 2)).toBe("28.76%");
    expect(borrowMath(v, 0b1111, wad("50"), market).belowMinLoan).toBe(true);
    expect(borrowMath({ ...v, debt: wad("150") }, 0b1111, wad("50"), market).belowMinLoan).toBe(false);
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

describe("rates (web 7.3)", () => {
  const at = [0n, 50n, 80n, 90n, 100n].map((x) => (x * WAD) / 100n);
  it.each([
    ["Safe", SAFE, [317_097_919n, 1_109_842_718n, 1_585_489_598n, 8_720_192_794n, 15_854_895_990n], ["1.00%", "3.50%", "5.00%", "27.50%", "50.00%"]],
    ["Normal", NORMAL, [634_195_839n, 1_823_313_038n, 2_536_783_358n, 10_781_329_273n, 19_025_875_189n], ["2.00%", "5.75%", "8.00%", "34.00%", "60.00%"]],
    ["Bold", BOLD, [951_293_759n, 2_734_969_557n, 3_805_175_037n, 13_793_759_511n, 23_782_343_986n], ["3.00%", "8.62%", "12.00%", "43.50%", "75.00%"]],
  ] as const)("pins %s's kinked curve", (_, c, perSecond, apr) => {
    expect(at.map((u) => borrowRate(u, c))).toEqual(perSecond);
    expect(at.map((u) => pct(annualRate(borrowRate(u, c)), WAD, 2))).toEqual(apr);
  });

  it("pays lenders the borrow rate on the lent part less the reserve: Normal at 80% is 5.76%", () => {
    const r = borrowRate(utilizationOf(wad("80000"), wad("100000")), NORMAL);
    expect(pct(annualRate(supplyRate(r, wad("100000"), wad("80000"), NORMAL.reserveFactor)), WAD, 2)).toBe("5.76%");
    expect(supplyRate(r, 0n, 0n, NORMAL.reserveFactor)).toBe(0n);
  });

  it("caps utilization at 1 and draws 21 points from 0 to full use", () => {
    expect(utilizationOf(0n, 0n)).toBe(0n);
    expect(utilizationOf(wad("2"), wad("1"))).toBe(WAD);
    const pts = curvePoints(NORMAL);
    expect(pts).toHaveLength(21);
    expect(pts[0].u).toBe(0n);
    expect(pts[20].u).toBe(WAD);
    expect(pts[20].borrow).toBe(19_025_875_189n);
  });

  it("shows the cushion between the borrow limit and liquidation per tier", () => {
    expect(pct(cushion(SAFE), WAD, 1)).toBe("16.7%");
    expect(pct(cushion(NORMAL), WAD, 1)).toBe("14.3%");
    expect(pct(cushion(BOLD), WAD, 1)).toBe("12.5%");
    expect(pct(cushion({ lltv: wad("0.75"), borrowLtv: wad("0.65") }), WAD, 1)).toBe("13.3%");
  });

  it("adds bad debt from insurance and from lenders", () => {
    expect(badDebtOf({ badDebtCovered: wad("3"), badDebtSocialized: wad("4") })).toBe(wad("7"));
  });
});

describe("borrow and repay blockers (SPEC 3.6.4 order)", () => {
  const market = tierMarket(NORMAL, wad("100000"), wad("85000"));
  const v = account({ lltv: wad("0.70"), borrowLtv: wad("0.60"), borrowLimit: wad("3000"), maxBorrow: wad("3000"), minLoan: wad("100") });
  const base = { halted: false, account: v, market, amount: wad("500"), tierLabel: "Normal" };

  it("passes a loan inside every limit", () => {
    expect(borrowBlocker(base)).toBeUndefined();
  });

  it("refuses in the contract's order", () => {
    expect(borrowBlocker({ ...base, halted: true, market: { ...market, frozen: true } })).toBe("Paused while a result is pending");
    expect(borrowBlocker({ ...base, market: { ...market, frozen: true } })).toBe("The Normal tier is frozen: no new loans");
    expect(borrowBlocker({ ...base, amount: undefined })).toBe("Enter an amount");
    expect(borrowBlocker({ ...base, amount: wad("16000") })).toBe("Only $15,000.00 to lend in the Normal tier");
    expect(borrowBlocker({ ...base, amount: wad("6000") })).toBe("This tier lends at most 90% of its cash; try a smaller amount");
    expect(borrowBlocker({ ...base, market: { ...market, config: { ...NORMAL, borrowCap: wad("85100") } } })).toBe("This tier's borrowing cap is $85,100.00");
    expect(borrowBlocker({ ...base, amount: wad("50") })).toBe("The minimum loan is $100.00");
    expect(borrowBlocker({ ...base, amount: wad("3001") })).toBe("Over your borrow limit: at most $2,985.00 now");
  });

  it("refuses exactly the limit (the contract rounds the new debt up) but passes Max's room", () => {
    expect(borrowBlocker({ ...base, amount: wad("3000") })).toBe("Over your borrow limit: at most $2,985.00 now");
    expect(borrowBlocker({ ...base, amount: wad("2985") })).toBeUndefined();
    expect(borrowBlocker({ ...base, amount: wad("2985.01") })).toBe("Over your borrow limit: at most $2,985.00 now");
  });

  it("names the price check when new borrowing is blocked", () => {
    expect(borrowBlocker({ ...base, account: { ...v, borrowBlock: "ReferenceStale" } })).toBeTruthy();
  });

  it("refuses a repayment that leaves dust (web 7.2)", () => {
    const debt = wad("150");
    expect(repayBlocker(debt, wad("100"), false, wad("1000"), wad("100"))).toBe("Leaves $50.00: repay all, or leave at least $100.00");
    expect(repayBlocker(debt, wad("50"), false, wad("1000"), wad("100"))).toBeUndefined();
    expect(repayBlocker(debt, wad("150"), false, wad("1000"), wad("100"))).toBeUndefined();
    expect(repayBlocker(debt, wad("150"), false, wad("10"), wad("100"))).toBe("Not enough USDC");
    expect(repayBlocker(0n, wad("1"), false, wad("10"), wad("100"))).toBe("No debt");
    expect(repayBlocker(debt, debt, true, 0n, wad("100"))).toBe("Not enough USDC");
  });

  it("repays all with 0.1% on top, never more than the wallet", () => {
    expect(repayAllSend(wad("1000"), wad("5000"))).toBe(wad("1001"));
    expect(repayAllSend(wad("1000"), wad("1000.5"))).toBe(wad("1000.5"));
  });
});

describe("the Borrow banner (web 6.5 priority)", () => {
  const under = { debt: wad("100"), healthFactor: wad("0.95"), writeOffReady: false };
  it("puts liquidatable first, then grace, then a pause, then write-off", () => {
    expect(borrowBanner({ ...under, liquidation: "liquidatable", writeOffReady: true }, 30n)).toBe("liquidatable");
    expect(borrowBanner({ ...under, liquidation: "paused" }, 30n)).toBe("grace");
    expect(borrowBanner({ ...under, liquidation: "paused_reference" }, 0n)).toBe("paused_reference");
    expect(borrowBanner({ ...under, healthFactor: wad("1.2"), liquidation: "none", writeOffReady: true }, 0n)).toBe("write_off");
    expect(borrowBanner({ ...under, healthFactor: wad("1.2"), liquidation: "none" }, 30n)).toBeUndefined();
    expect(writeOffShown({ writeOffReady: true, debt: 0n })).toBe(false);
  });
});

describe("lend blockers and the bad-debt notice (web 6.6)", () => {
  const m = { frozen: false, totalSupply: wad("100"), totalSupplyShares: wad("100") };
  it("refuses deposits to a frozen or wiped-out tier, then checks the amount", () => {
    expect(supplyBlocker({ ...m, frozen: true }, wad("1"), wad("5"), "Bold")).toBe("The Bold tier is frozen: no new deposits");
    expect(supplyBlocker({ ...m, totalSupply: 0n }, wad("1"), wad("5"), "Bold")).toMatch(/closed to deposits/);
    expect(supplyBlocker(m, undefined, wad("5"), "Bold")).toBe("Enter an amount");
    expect(supplyBlocker(m, wad("6"), wad("5"), "Bold")).toBe("Not enough USDC");
    expect(supplyBlocker(m, wad("5"), wad("5"), "Bold")).toBeUndefined();
  });

  it("lets only the cash not lent out leave", () => {
    expect(withdrawBlocker(0n, wad("1"), wad("10"))).toBe("Nothing supplied");
    expect(withdrawBlocker(wad("50"), wad("20"), wad("10"))).toMatch(/^Lent out right now: \$10\.00 available/);
    expect(withdrawBlocker(wad("50"), wad("60"), wad("100"))).toBe("You supplied $50.00");
    expect(withdrawBlocker(wad("50"), wad("10"), wad("10"))).toBeUndefined();
  });

  it("tells a lender when a write-off cut their supply", () => {
    const first = { socialized: 0n, supplied: wad("1000") };
    expect(badDebtNotice(first, { socialized: wad("30"), supplied: wad("990") })).toEqual({ socialized: wad("30"), before: wad("1000"), after: wad("990") });
    expect(badDebtNotice(first, { socialized: 0n, supplied: wad("990") })).toBeUndefined();
    expect(badDebtNotice(undefined, { socialized: wad("30"), supplied: wad("990") })).toBeUndefined();
  });
});
