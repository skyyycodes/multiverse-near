import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatNear, formatUnits, fromInternal, internalScale, parseNear, parseUnits, tgas, toInternal, u128 } from "./units.ts";

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
  it("scales by 10^(18 - decimals)", () => {
    assert.equal(internalScale(6), 1_000_000_000_000n);
    assert.equal(internalScale(18), 1n);
    assert.throws(() => internalScale(24), /token decimals above 18/);
    assert.equal(toInternal(3_000_000_000n, 6), 3_000n * 10n ** 18n);
  });

  it("floors when converting back, like the contract's payout", () => {
    assert.equal(fromInternal(1_999_999_999_999n, 6), 1n);
    assert.equal(fromInternal(999_999_999_999n, 6), 0n);
    assert.equal(fromInternal(5n, 18), 5n);
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
