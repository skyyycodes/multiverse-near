import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALICE_WNEAR,
  BOOK_ASK_PRICE,
  BOOK_BID_PRICE,
  BOOK_SIZE_WNEAR,
  BORROW_USDC,
  CARL_WNEAR,
  checkBps,
  DEMO_EVENTS,
  fmt2,
  fmt4,
  fmtDiff,
  fmtFixed,
  fmtOdds,
  independentOdds,
  isqrt,
  oddsPairs,
  orderCost,
  planSpotMove,
  PUSH_WNEAR,
  RAVI_BID_WNEAR,
  raviBidPrice,
  SALE_WNEAR,
  SEED_2X2,
  SEED_BINARY,
  seedReserves,
  singles,
  SPOT_DEPTH,
  sumOver,
  UMA_USDC,
  UMA_WNEAR,
  wmul,
} from "./demo.ts";
import { WAD } from "./units.ts";

const e18 = (n: bigint): bigint => n * WAD;
const cents = (n: bigint): bigint => (n * WAD) / 100n;

describe("demo odds", () => {
  it("2x2 odds from basis points sum to exactly 1e18", () => {
    for (const cuts of [1, 100, 104, 119, 3000, 9999]) {
      const q = independentOdds(4, 6667, cuts);
      assert.equal(q.reduce((a, b) => a + b, 0n), WAD);
    }
    assert.deepEqual(independentOdds(4, 6667, 104), [693_368n * 10n ** 10n, 346_632n * 10n ** 10n, 65_976_632n * 10n ** 10n, 32_983_368n * 10n ** 10n]);
    assert.deepEqual(independentOdds(2, 6667, 104), [6667n * 10n ** 14n, 3333n * 10n ** 14n]);
  });

  it("the odds tree splits on the Fed first", () => {
    assert.deepEqual(oddsPairs(4), [[0x3, 0xc], [0x1, 0x2], [0x4, 0x8]]);
    assert.deepEqual(oddsPairs(2), [[0x1, 0x2]]);
    assert.deepEqual(oddsPairs(3), []);
  });

  it("odds pool reserves give the less likely side the full depth", () => {
    const q = independentOdds(4, 6667, 3000);
    const depth = e18(1_000_000n);
    const [cuts, holds] = seedReserves(sumOver(q, 0x3), sumOver(q, 0xc), depth);
    assert.equal(cuts, depth);
    // 1,000,000 x 30/70
    assert.equal(holds / 10n ** 16n, 42_857_142n);
    const [ships, delayed] = seedReserves(sumOver(q, 0x1), sumOver(q, 0x2), depth);
    assert.equal(delayed, depth);
    assert.equal(ships / WAD, 499_925n);
    assert.throws(() => seedReserves(0n, 0n, depth), /both odds are zero/);
  });

  it("rejects odds outside 1..9999 bps", () => {
    assert.throws(() => checkBps(0, "ODDS_CUTS_BPS"), /ODDS_CUTS_BPS must be between 1 and 9999/);
    assert.throws(() => checkBps(10_000, "X"), /between 1 and 9999/);
    assert.throws(() => checkBps(1.5, "X"), /between 1 and 9999/);
    checkBps(1, "X");
    checkBps(9999, "X");
  });
});

describe("demo amounts", () => {
  it("Ravi bids 2% under 2.50 for 1,000 NEAR and escrows the rounded-up cost", () => {
    const price = raviBidPrice(SEED_2X2[3]!.price);
    assert.equal(price, cents(245n));
    assert.equal(orderCost(RAVI_BID_WNEAR, price), e18(2450n));
    assert.equal(orderCost(1n, 1n), 1n);
    assert.equal(orderCost(3n, WAD / 2n), 2n);
  });

  it("world pools at NEAR scale: prices in dollars, depths in thousands of NEAR", () => {
    assert.deepEqual(SEED_2X2.map((w) => fmt2(w.price)), ["3.70", "3.00", "3.30", "2.50"]);
    assert.deepEqual(SEED_BINARY.map((w) => fmt2(w.price)), ["3.40", "2.80"]);
    assert.deepEqual(SEED_2X2.map((w) => w.depth / WAD), [100_000n, 100_000n, 100_000n, 40_000n]);
    assert.deepEqual(SEED_BINARY.map((w) => w.depth / WAD), [100_000n, 100_000n]);
    assert.equal(SPOT_DEPTH, e18(100_000n));
  });

  it("every pool's USDC side is what it was with 1,000x less NEAR at 1,000x the price", () => {
    // A constant-product pool is scale-invariant: the USDC reserves are unchanged, so every USD result is.
    assert.deepEqual(SEED_2X2.map((w) => wmul(w.depth, w.price) / WAD), [370_000n, 300_000n, 330_000n, 100_000n]);
    assert.deepEqual(SEED_BINARY.map((w) => wmul(w.depth, w.price) / WAD), [340_000n, 280_000n]);
    for (const w of [...SEED_2X2, ...SEED_BINARY]) assert.equal(wmul(w.depth, w.price) % WAD, 0n);
  });

  it("the people's amounts", () => {
    assert.equal(ALICE_WNEAR, e18(2_000n));
    assert.equal(SALE_WNEAR, e18(2_000n));
    assert.equal(BORROW_USDC, e18(3_000n));
    assert.equal(UMA_WNEAR, e18(5_000n));
    assert.equal(UMA_USDC, e18(20_000n));
    assert.equal(CARL_WNEAR, e18(1_000n));
    assert.equal(PUSH_WNEAR, e18(3_000n));
  });

  it("the e2e order book straddles the SHIPS·CUTS pool and escrows whole USDC", () => {
    const pool = SEED_2X2[0]!.price;
    assert.ok(BOOK_BID_PRICE < pool && pool < BOOK_ASK_PRICE);
    assert.equal(fmt4(BOOK_ASK_PRICE), "3.7500");
    assert.equal(fmt4(BOOK_BID_PRICE), "3.6000");
    assert.equal(orderCost(BOOK_SIZE_WNEAR, BOOK_ASK_PRICE), e18(3_750n));
    assert.equal(orderCost(BOOK_SIZE_WNEAR, BOOK_BID_PRICE), e18(3_600n));
  });

  it("singles", () => {
    assert.deepEqual(singles(4), [1, 2, 4, 8]);
    assert.deepEqual(singles(2), [1, 2]);
  });

  it("event texts match the demo", () => {
    assert.deepEqual(DEMO_EVENTS.map((e) => e.key), ["glam", "fed", "pastFed"]);
    assert.equal(DEMO_EVENTS[2]?.deadlineSec, 1793210400);
    assert.ok(DEMO_EVENTS.every((e) => e.rule.length <= 512 && e.outcomeNames.length === 2));
  });
});

describe("spot move plan", () => {
  it("isqrt floors", () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 36n, 10n ** 36n - 1n]) {
      const r = isqrt(n);
      assert.ok(r * r <= n && (r + 1n) * (r + 1n) > n, `isqrt(${n})`);
    }
  });

  it("selling NEAR lowers the price to the target", () => {
    const x = e18(100_000n);
    const y = e18(303_769n);
    const target = cents(300n);
    const plan = planSpotMove(x, y, target);
    assert.ok(plan?.wnearIn);
    const net = ((plan?.amountIn ?? 0n) * 997_000n) / 1_000_000n;
    const yAfter = (x * y) / (x + net);
    const price = (yAfter * WAD) / (x + net);
    const off = price > target ? price - target : target - price;
    assert.ok(off < 10n ** 12n, `landed at ${price}`);
  });

  it("buying NEAR raises the price; no move when already there", () => {
    const plan = planSpotMove(e18(100_000n), e18(300_000n), cents(310n));
    assert.equal(plan?.wnearIn, false);
    assert.ok((plan?.amountIn ?? 0n) > e18(4_900n) && (plan?.amountIn ?? 0n) < e18(5_100n));
    assert.equal(planSpotMove(e18(100_000n), e18(300_000n), cents(300n)), null);
  });
});

describe("report formatting", () => {
  it("fmt2 rounds down to cents", () => {
    assert.equal(fmt2(4_748_299_999_999_999_999_999n), "4748.29");
    assert.equal(fmt2(0n), "0.00");
    assert.equal(fmt2(e18(100_000n)), "100000.00");
    assert.equal(fmt2(-e18(5n) / 2n), "-2.50");
    assert.equal(fmt2(-1n), "0.00");
  });

  it("odds are percent rounded to the nearest hundredth", () => {
    assert.equal(fmtOdds(6_934n * 10n ** 12n), "0.69%");
    assert.equal(fmtOdds(659_766_320_000_000_000n), "65.98%");
    assert.equal(fmtOdds(5n * 10n ** 13n), "0.01%");
  });

  it("NEAR prices at four decimals", () => {
    // an implied spot in [3.03769, 3.03770), where the demo's 2x2 lands, shows as 3.0377
    assert.equal(fmt4(3_037_690_000_000_000_000n), "3.0377");
    assert.equal(fmt4(3_037_699_999_999_999_999n), "3.0377");
    assert.equal(fmt4(3_037_649_999_999_999_999n), "3.0376");
    assert.equal(fmt4(cents(370n)), "3.7000");
    assert.equal(fmt4(-cents(245n)), "-2.4500");
    assert.equal(fmtFixed(e18(7n) / 3n, 0), "2");
    assert.equal(fmtFixed(-1n, 4), "0.0000");
    assert.throws(() => fmtFixed(1n, 19), /invalid digits/);
  });

  it("differences are signed and zero under the last digit", () => {
    assert.equal(fmtDiff(e18(3200n), e18(3037n)), "+163.00");
    assert.equal(fmtDiff(e18(3037n), e18(3200n)), "-163.00");
    assert.equal(fmtDiff(e18(3037n) + 10n ** 15n, e18(3037n)), "0.00");
    // at NEAR scale a gap of a fraction of a cent still shows
    assert.equal(fmtDiff(cents(320n), 3_037_700_000_000_000_000n, 4), "+0.1623");
    assert.equal(fmtDiff(3_037_750_000_000_000_000n, 3_037_700_000_000_000_000n, 4), "0.0000");
    assert.equal(fmtDiff(3_038_000_000_000_000_000n, 3_037_700_000_000_000_000n, 4), "+0.0003");
  });
});
