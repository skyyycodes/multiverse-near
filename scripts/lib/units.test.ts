import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  exactRaw,
  formatNear,
  formatUnits,
  internalStep,
  parseNear,
  parseUnits,
  roundDownToStep,
  roundUpToStep,
  splitByCap,
  tgas,
  toInternal,
  toRaw,
  u128,
  WAD,
} from "./units.ts";

describe("parseUnits", () => {
  it("turns decimal strings into base units", () => {
    assert.equal(parseUnits("1.5", 6), 1_500_000n);
    assert.equal(parseUnits("25.00", 6), 25_000_000n);
    assert.equal(parseUnits("0.000001", 6), 1n);
    assert.equal(parseUnits("2", 18), 2_000_000_000_000_000_000n);
    assert.equal(parseUnits("4748.29", 6), 4_748_290_000n);
    assert.equal(parseUnits(" 7 ", 0), 7n);
    assert.equal(parseUnits("3.", 6), 3_000_000n);
  });

  it("keeps every digit of large amounts", () => {
    assert.equal(parseUnits("123456789012345678.123456789012345678", 18), 123456789012345678123456789012345678n);
  });

  it("refuses more fractional digits than the token has instead of rounding", () => {
    assert.throws(() => parseUnits("0.0000001", 6), /more than 6 decimal places/);
    assert.throws(() => parseUnits("1.5", 0), /more than 0 decimal places/);
  });

  it("refuses anything that is not a plain non-negative decimal", () => {
    for (const bad of ["", ".5", "-1", "+1", "1e6", "1,000", "0x10", "abc", "1.2.3"]) {
      assert.throws(() => parseUnits(bad, 6), /not a decimal amount/, bad);
    }
    assert.throws(() => parseUnits("1", -1), /invalid decimals/);
    assert.throws(() => parseUnits("1", 2.5), /invalid decimals/);
  });
});

describe("formatUnits", () => {
  it("formats base units and trims trailing zeros", () => {
    assert.equal(formatUnits(1_500_000n, 6), "1.5");
    assert.equal(formatUnits(25_000_000n, 6), "25");
    assert.equal(formatUnits(1n, 6), "0.000001");
    assert.equal(formatUnits(0n, 18), "0");
    assert.equal(formatUnits(-1_500_000n, 6), "-1.5");
    assert.equal(formatUnits(42n, 0), "42");
  });

  it("cuts digits by rounding down", () => {
    assert.equal(formatUnits(1_999_999n, 6, { maxFractionDigits: 2 }), "1.99");
    assert.equal(formatUnits(1_000_001n, 6, { maxFractionDigits: 2 }), "1");
    assert.equal(formatUnits(1_500_000n, 6, { trimZeros: false }), "1.500000");
  });

  it("never prints a negative zero", () => {
    assert.equal(formatUnits(-1n, 6, { maxFractionDigits: 2 }), "0");
    assert.equal(formatUnits(-1n, 6, { maxFractionDigits: 2, trimZeros: false }), "0.00");
    assert.equal(formatUnits(-1n, 6, { maxFractionDigits: 0 }), "0");
    assert.equal(formatUnits(-10_000n, 6, { maxFractionDigits: 2 }), "-0.01");
    assert.equal(formatUnits(-1n, 6), "-0.000001");
  });

  it("round-trips with parseUnits", () => {
    for (const [text, decimals] of [["4881.88", 6], ["0.000000000000000001", 18], ["1000000", 6]] as const) {
      assert.equal(formatUnits(parseUnits(text, decimals), decimals), text);
    }
  });
});

describe("NEAR and gas", () => {
  it("uses 24 decimals for NEAR", () => {
    assert.equal(parseNear("1"), 10n ** 24n);
    assert.equal(parseNear("0.00125"), 1_250_000_000_000_000_000_000n);
    assert.equal(formatNear(17_708_712_345_678_901_234_567_890n), "17.7087");
    assert.equal(formatNear(1n, 24), "0.000000000000000000000001");
  });

  it("builds gas in Tgas and refuses fractions", () => {
    assert.equal(tgas(300), 300_000_000_000_000n);
    assert.throws(() => tgas(0.5), /invalid Tgas/);
    assert.throws(() => tgas(0), /invalid Tgas/);
  });
});

describe("internal 18-decimal units", () => {
  it("scales up a token with 18 decimals or fewer", () => {
    assert.equal(toInternal(3_000_000_000n, 6), 3_000n * WAD);
    assert.equal(toInternal(5n, 18), 5n);
    assert.equal(internalStep(6), 1_000_000_000_000n);
    assert.equal(internalStep(18), 1n);
  });

  it("floors when paying out a token with 18 decimals or fewer, like the contract", () => {
    assert.equal(toRaw(1_999_999_999_999n, 6), 1n);
    assert.equal(toRaw(999_999_999_999n, 6), 0n);
    assert.equal(toRaw(5n, 18), 5n);
  });

  it("wNEAR (24 decimals): a whole deposit maps exactly, both ways", () => {
    const twoThousand = parseUnits("2000", 24);
    assert.equal(twoThousand, 2_000n * 10n ** 24n);
    assert.equal(toInternal(twoThousand, 24), 2_000n * WAD);
    assert.equal(toRaw(2_000n * WAD, 24), twoThousand);
    assert.equal(toRaw(1n, 24), 1_000_000n);
    assert.equal(internalStep(24), 1n);
  });

  it("wNEAR: a sub-internal remainder never enters the ledger", () => {
    // 1.0000000000000000005 wNEAR: the last 500,000 yocto are below one internal unit
    assert.equal(toInternal(10n ** 24n + 500_000n, 24), WAD);
    assert.equal(toInternal(999_999n, 24), 0n);
    assert.equal(toInternal(1_000_000n, 24), 1n);
  });

  it("wNEAR: a payout is exact, so every internal amount round-trips", () => {
    for (const internal of [0n, 1n, 123_456_789n, 2_000n * WAD, 100_000n * WAD + 7n]) {
      assert.equal(toInternal(toRaw(internal, 24), 24), internal);
    }
  });

  it("refuses decimals above 24", () => {
    assert.throws(() => toInternal(1n, 25), /token decimals above 24/);
    assert.throws(() => toRaw(1n, 25), /token decimals above 24/);
    assert.throws(() => internalStep(25), /token decimals above 24/);
  });

  it("rounds internal amounts to whole base units", () => {
    assert.equal(roundUpToStep(1n, 6), 10n ** 12n);
    assert.equal(roundUpToStep(10n ** 12n, 6), 10n ** 12n);
    assert.equal(roundDownToStep(10n ** 12n + 1n, 6), 10n ** 12n);
    // every internal amount is already a whole number of wNEAR base units
    assert.equal(roundUpToStep(7n, 24), 7n);
    assert.equal(roundDownToStep(7n, 24), 7n);
  });

  it("exactRaw: the token amount to transfer or mint, refusing dust", () => {
    assert.equal(exactRaw(2_000n * WAD, 24), 2_000n * 10n ** 24n);
    assert.equal(exactRaw(3_000n * WAD, 6), 3_000_000_000n);
    assert.equal(exactRaw(1n, 24), 1_000_000n);
    assert.throws(() => exactRaw(1n, 6, "usdc transfer"), /usdc transfer 1 is not a whole number of base units of a 6-decimal token/);
  });
});

describe("faucet mints", () => {
  const WNEAR_CAP = 10n ** 30n; // 1,000,000 wNEAR per call
  const USDC_CAP = 10n ** 13n; // 10,000,000 USDC per call

  it("the demo's wNEAR amounts fit one call each", () => {
    for (const human of ["2000", "4000", "5000", "100000"]) {
      const raw = exactRaw(toInternal(parseUnits(human, 24), 24), 24);
      assert.deepEqual(splitByCap(raw, WNEAR_CAP), [raw], human);
    }
  });

  it("a faucet drop of 2,000 wNEAR and 5,000 USDC is within each cap", () => {
    assert.ok(parseUnits("2000", 24) <= WNEAR_CAP);
    assert.ok(parseUnits("5000", 6) <= USDC_CAP);
  });

  it("splits a larger amount under the cap, in order", () => {
    assert.deepEqual(splitByCap(2_500_000n * 10n ** 24n, WNEAR_CAP), [WNEAR_CAP, WNEAR_CAP, 500_000n * 10n ** 24n]);
    assert.deepEqual(splitByCap(0n, WNEAR_CAP), []);
    assert.deepEqual(splitByCap(USDC_CAP, USDC_CAP), [USDC_CAP]);
    assert.throws(() => splitByCap(1n, 0n), /cap must be positive/);
    assert.throws(() => splitByCap(-1n, 1n), /negative/);
  });
});

describe("u128", () => {
  it("parses JSON U128 strings", () => {
    assert.equal(u128("0"), 0n);
    assert.equal(u128("340282366920938463463374607431768211455"), (1n << 128n) - 1n);
  });

  it("refuses numbers, negatives, decimals and overflow", () => {
    for (const bad of [5, "-1", "1.0", "", " 1", null, undefined, "340282366920938463463374607431768211456"]) {
      assert.throws(() => u128(bad), /U128|fit in u128/, String(bad));
    }
  });
});
