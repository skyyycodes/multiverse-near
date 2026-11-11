import { describe, expect, it } from "vitest";
import { fmtNear, nearToYocto, scaleOf, toInternal, toTokenCeil, toTokenFloor } from "./units";

describe("the NEP-141 boundary", () => {
  it("scales USDC (6 decimals) by 1e12 and leaves WETH (18) alone", () => {
    expect(scaleOf(6)).toBe(10n ** 12n);
    expect(scaleOf(18)).toBe(1n);
    expect(() => scaleOf(19)).toThrow();
  });

  it("turns wallet balances into internal units", () => {
    expect(toInternal(50_000_000n, 6)).toBe(50n * 10n ** 18n);
    expect(toInternal(2n * 10n ** 18n, 18)).toBe(2n * 10n ** 18n);
  });

  it("pays out whole token units and attaches enough to cover an amount", () => {
    const internal = 2_450_000_000_000_000_000_001n; // 2450 USDC and one wei of dust
    expect(toTokenFloor(internal, 6)).toBe(2_450_000_000n);
    expect(toTokenCeil(internal, 6)).toBe(2_450_000_001n);
    expect(toTokenCeil(2_450n * 10n ** 18n, 6)).toBe(2_450_000_000n);
    expect(toTokenCeil(0n, 6)).toBe(0n);
    expect(toTokenCeil(5n, 18)).toBe(5n);
  });

  it("round-trips: what is attached always covers the amount, by less than one token unit", () => {
    for (const x of [1n, 999_999_999_999n, 10n ** 12n, 10n ** 12n + 1n, 123_456_789_012_345_678_901n]) {
      const t = toTokenCeil(x, 6);
      expect(toInternal(t, 6) >= x).toBe(true);
      expect(toInternal(t, 6) - x < 10n ** 12n).toBe(true);
    }
  });
});

describe("NEAR amounts", () => {
  it("converts to yocto and back", () => {
    expect(nearToYocto("0.1")).toBe(10n ** 23n);
    expect(nearToYocto("1")).toBe(10n ** 24n);
    expect(nearToYocto("0.00125")).toBe(1_250_000_000_000_000_000_000n);
    expect(fmtNear(10n ** 23n)).toBe("0.1");
    expect(fmtNear(61_500_000_000_000_000_000_000n)).toBe("0.061");
  });
});
