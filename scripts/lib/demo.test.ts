import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkBps,
  DEMO_EVENTS,
  fmt2,
  fmtDiff,
  fmtOdds,
  independentOdds,
  isqrt,
  oddsPairs,
  orderCost,
  planSpotMove,
  raviBidPrice,
  seedReserves,
  singles,
  sumOver,
  wmul,
} from "./demo.ts";
import { WAD } from "./units.ts";

const e18 = (n: bigint): bigint => n * WAD;

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
  it("Ravi bids 2% under 2,500 and escrows the rounded-up cost", () => {
    const price = raviBidPrice(e18(2500n));
    assert.equal(price, e18(2450n));
    assert.equal(orderCost(WAD, price), e18(2450n));
    assert.equal(orderCost(1n, 1n), 1n);
    assert.equal(orderCost(3n, WAD / 2n), 2n);
  });

  it("world pool USDC depths", () => {
    assert.equal(wmul(e18(40n), e18(2500n)), e18(100_000n));
    assert.equal(wmul(e18(100n), e18(3700n)), e18(370_000n));
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
    const x = e18(100n);
    const y = e18(303_769n);
    const target = e18(3000n);
    const plan = planSpotMove(x, y, target);
    assert.ok(plan?.wnearIn);
    const net = ((plan?.amountIn ?? 0n) * 997_000n) / 1_000_000n;
    const yAfter = (x * y) / (x + net);
    const price = (yAfter * WAD) / (x + net);
    const off = price > target ? price - target : target - price;
    assert.ok(off < 10n ** 15n, `landed at ${price}`);
  });

  it("buying NEAR raises the price; no move when already there", () => {
    const plan = planSpotMove(e18(100n), e18(300_000n), e18(3100n));
    assert.equal(plan?.wnearIn, false);
    assert.ok((plan?.amountIn ?? 0n) > e18(4_900n) && (plan?.amountIn ?? 0n) < e18(5_100n));
    assert.equal(planSpotMove(e18(100n), e18(300_000n), e18(3000n)), null);
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

  it("differences are signed and zero under a cent", () => {
    assert.equal(fmtDiff(e18(3200n), e18(3037n)), "+163.00");
    assert.equal(fmtDiff(e18(3037n), e18(3200n)), "-163.00");
    assert.equal(fmtDiff(e18(3037n) + 10n ** 15n, e18(3037n)), "0.00");
  });
});
