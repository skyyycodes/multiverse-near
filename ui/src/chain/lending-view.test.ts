import { describe, expect, it } from "vitest";
import {
  addWorlds,
  amountForLtv,
  bindingWorld,
  byWorld,
  futuresRange,
  hedgeShape,
  liquidationPrice,
  liquidationPrices,
  ltvOf,
  oddsWeighted,
  tierPositions,
  worldWorth,
  worstAfterFall,
  worstOf,
} from "./lending-view";

const WAD = 10n ** 18n;
const w = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

describe("byWorld", () => {
  it("counts a piece in every possible world of its mask; a real piece (root mask) in all of them", () => {
    const pieces = [
      { asset: "wnear" as const, mask: 0b0001, amount: w(2000) }, // wNEAR-if-world 0
      { asset: "usdc" as const, mask: 0b0110, amount: w(500) }, // USDC-if-worlds 1, 2
      { asset: "usdc" as const, mask: 0b1111, amount: w(100) }, // real USDC
    ];
    const h = byWorld(pieces, 4, 0b1111);
    expect(h.near).toEqual([w(2000), 0n, 0n, 0n]);
    expect(h.usdc).toEqual([w(100), w(600), w(600), w(100)]);
  });

  it("leaves a world that can no longer happen at zero", () => {
    const h = byWorld([{ asset: "wnear", mask: 0b1111, amount: w(10) }], 4, 0b0101);
    expect(h.near).toEqual([w(10), 0n, w(10), 0n]);
  });

  it("adds two tallies", () => {
    const a = { near: [1n, 2n], usdc: [3n, 4n] };
    expect(addWorlds(a, a)).toEqual({ near: [2n, 4n], usdc: [6n, 8n] });
  });
});

describe("liquidationPrice", () => {
  // carl's Bold loan on staging, world 3: 1,000 real wNEAR valued at $2.784167… (liquidation side), lltv 80%
  const carl = { value: 2_784_167_214_680_962_395_000n, near: w(1000), usdc: 0n, debt: 1_615_622_873_798_399_340_481n, lltv: 800_000_000_000_000_000n };

  it("finds the NEAR price at which health reaches 1, and the fall to it", () => {
    const l = liquidationPrice(carl);
    expect(l.kind).toBe("at");
    if (l.kind !== "at") return;
    // debt / lltv / near = 1615.6228… / 0.8 / 1000 = $2.019528…
    expect(l.price).toBe(2_019_528_592_247_999_176n);
    expect(l.now).toBe(2_784_167_214_680_962_395n);
    // 1 - 2.0195 / 2.7842 = 27.46%
    expect(Number(l.drop) / 1e18).toBeCloseTo(0.27464, 4);
    // the contract's own health factor agrees: value × lltv / debt ≈ 1.3786
    expect(Number((carl.value * carl.lltv) / carl.debt) / 1e18).toBeCloseTo(1.3786, 3);
  });

  it("is health exactly 1 at that price, and under 1 a hair below", () => {
    const l = liquidationPrice(carl);
    if (l.kind !== "at") throw new Error("expected a price");
    const valueAt = (p: bigint) => (carl.near * p) / WAD;
    expect(valueAt(l.price) * carl.lltv >= carl.debt * WAD).toBe(true);
    expect(valueAt(l.price - 10n ** 9n) * carl.lltv < carl.debt * WAD).toBe(true);
  });

  it("never liquidates a world whose dollars cover the loan", () => {
    expect(liquidationPrice({ value: w(5000), near: 0n, usdc: w(5000), debt: w(3000), lltv: WAD * 7n / 10n }).kind).toBe("never");
    expect(liquidationPrice({ value: w(6000), near: w(100), usdc: w(5000), debt: w(3000), lltv: WAD * 7n / 10n }).kind).toBe("never");
  });

  it("says now for a world already under the line, and none without a loan", () => {
    expect(liquidationPrice({ value: w(1000), near: w(500), usdc: 0n, debt: w(900), lltv: WAD * 8n / 10n }).kind).toBe("now");
    expect(liquidationPrice({ value: w(1000), near: 0n, usdc: w(1000), debt: w(900), lltv: WAD * 8n / 10n }).kind).toBe("now");
    expect(liquidationPrice({ ...carl, debt: 0n }).kind).toBe("none");
  });

  it("mixes NEAR and dollars: only the NEAR part has to fall", () => {
    // 1,000 NEAR at $3 + $1,000; loan $2,400 at 80% → line $3,000 → NEAR must be worth $2,000 → $2.00
    const l = liquidationPrice({ value: w(4000), near: w(1000), usdc: w(1000), debt: w(2400), lltv: WAD * 8n / 10n });
    expect(l).toEqual({ kind: "at", price: 2n * WAD, now: 3n * WAD, drop: WAD / 3n + 1n });
  });
});

describe("liquidationPrices and bindingWorld", () => {
  // Alice's hedge: NEAR only in world 0, dollars in the others
  const posted = byWorld(
    [
      { asset: "wnear", mask: 0b0001, amount: w(2000) },
      { asset: "usdc", mask: 0b0010, amount: w(6400) },
      { asset: "usdc", mask: 0b0100, amount: w(7000) },
      { asset: "usdc", mask: 0b1000, amount: w(5300) },
    ],
    4,
    0b1111,
  );
  const values = [w(2000 * 4.36), w(6400), w(7000), w(5300)];

  it("binds on the one NEAR world, and dollar worlds never move", () => {
    const rows = liquidationPrices({ values, posted, possible: 0b1111, debt: w(2536), lltv: WAD * 7n / 10n });
    expect(rows.map((r) => r.liq.kind)).toEqual(["at", "never", "never", "never"]);
    expect(bindingWorld(rows)).toBe(0);
  });

  it("puts a world already under the line first", () => {
    const rows = [
      { world: 0, liq: { kind: "at" as const, price: 1n, now: 2n, drop: WAD / 2n } },
      { world: 2, liq: { kind: "now" as const } },
    ];
    expect(bindingWorld(rows)).toBe(2);
    expect(bindingWorld([{ world: 1, liq: { kind: "never" as const } }])).toBeUndefined();
  });

  it("skips worlds that can no longer happen", () => {
    const rows = liquidationPrices({ values, posted, possible: 0b0110, debt: w(2536), lltv: WAD * 7n / 10n });
    expect(rows.map((r) => r.world)).toEqual([1, 2]);
  });
});

describe("worstAfterFall", () => {
  const posted = { near: [w(1000), 0n], usdc: [0n, w(2500)] };
  const values = [w(3000), w(2500)];

  it("keeps the dollar world fixed and drops the NEAR one, against the same value all in NEAR", () => {
    expect(worstAfterFall(values, posted, 0b11, 0)).toEqual({ held: w(2500), allNear: w(2500) });
    // NEAR −50%: world 0 is worth 1,500, world 1 still 2,500; all-NEAR: 1,250
    expect(worstAfterFall(values, posted, 0b11, 5000)).toEqual({ held: w(1500), allNear: w(1250) });
  });

  it("clamps the fall to 0–100%", () => {
    expect(worstAfterFall(values, posted, 0b11, 20_000).held).toBe(0n);
    expect(worstAfterFall(values, posted, 0b11, -500).held).toBe(w(2500));
  });
});

describe("worstOf, ltvOf and amountForLtv", () => {
  it("reads the worst possible world", () => {
    expect(worstOf([w(5), w(1), w(3)], 0b101)).toBe(w(3));
    expect(worstOf([], 0)).toBe(0n);
  });

  it("turns a target LTV into the amount to borrow", () => {
    expect(amountForLtv(w(10_000), w(2_000), 5000)).toBe(w(3_000));
    expect(amountForLtv(w(10_000), w(6_000), 5000)).toBe(0n);
    expect(ltvOf(w(2_500), w(10_000))).toBe(WAD / 4n);
    expect(ltvOf(w(1), 0n)).toBeUndefined();
  });
});

describe("a market's futures", () => {
  const h = { near: [w(1000), w(1000), 0n, 0n], usdc: [0n, 0n, w(3000), w(2500)] };
  const prices = [w(4), w(3), w(3.5), w(2.5)];

  it("values each world at its own NEAR price, less the debt", () => {
    expect(worldWorth(h, prices, w(500), 0b1111)).toEqual([w(3500), w(2500), w(2500), w(2000)]);
  });

  it("moves only the NEAR worlds in a what-if", () => {
    expect(worldWorth(h, prices, 0n, 0b1111, -2500)).toEqual([w(3000), w(2250), w(3000), w(2500)]);
    expect(worldWorth(h, prices, 0n, 0b0011, 0)).toEqual([w(4000), w(3000), 0n, 0n]);
  });

  it("finds the worst and best world, and the chance-weighted value", () => {
    const v = worldWorth(h, prices, 0n, 0b1111);
    expect(futuresRange(v, 0b1111)).toEqual({ worst: 3, best: 0 });
    expect(futuresRange(v, 0)).toBeUndefined();
    const odds = [WAD / 2n, WAD / 4n, WAD / 8n, WAD / 8n];
    // 4000/2 + 3000/4 + 3000/8 + 2500/8 = 3437.5
    expect(oddsWeighted(v, odds, 0b1111)).toBe(w(3437.5));
    expect(oddsWeighted(v, [0n, 0n, 0n, 0n], 0b1111)).toBe(0n);
  });

  it("names how a market holds up against NEAR", () => {
    expect(hedgeShape(h, 0b1111)).toEqual({ moving: 2, fixed: 2, empty: 0 });
    expect(hedgeShape({ near: [0n, 0n], usdc: [0n, 0n] }, 0b11)).toEqual({ moving: 0, fixed: 0, empty: 2 });
  });
});

describe("tierPositions", () => {
  it("keeps the tiers with a loan, a supply or collateral", () => {
    const acct = (debt: bigint, supplied: bigint, n: number) => ({ debt, supplied, healthFactor: debt > 0n ? WAD * 2n : null, collateral: Array.from({ length: n }) });
    const rows = tierPositions(1, [
      { tier: "safe", account: acct(0n, w(105_000), 0) },
      { tier: "normal", account: acct(0n, 0n, 0) },
      { tier: "bold", account: acct(w(1615), 0n, 1) },
    ]);
    expect(rows.map((r) => r.tier)).toEqual(["safe", "bold"]);
    expect(rows[1]).toEqual({ sid: 1, tier: "bold", debt: w(1615), supplied: 0n, healthFactor: WAD * 2n, pieces: 1 });
    expect(tierPositions(1, [{ tier: "safe", account: null }])).toEqual([]);
  });
});
