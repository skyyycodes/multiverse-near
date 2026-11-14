import { describe, expect, it } from "vitest";
import { fmtYocto, nearToYocto, toInternal, toTokenCeil, toTokenFloor, unitOf } from "./units";

const E18 = 10n ** 18n;
const E24 = 10n ** 24n;

describe("the NEP-141 boundary", () => {
  it("scales USDC (6 decimals) by 1e12; an 18-decimal token and wNEAR (24) move internal units one to one", () => {
    expect(unitOf(6)).toBe(10n ** 12n);
    expect(unitOf(18)).toBe(1n);
    expect(unitOf(24)).toBe(1n);
    expect(() => unitOf(25)).toThrow();
    expect(() => unitOf(-1)).toThrow();
  });

  it("turns wallet balances into internal units", () => {
    expect(toInternal(50_000_000n, 6)).toBe(50n * E18);
    expect(toInternal(2n * E18, 18)).toBe(2n * E18);
    expect(toInternal(2_000n * E24, 24)).toBe(2_000n * E18);
  });

  it("drops a wNEAR balance's sub-unit remainder, which never enters the ledger", () => {
    expect(toInternal(2_000n * E24 + 999_999n, 24)).toBe(2_000n * E18);
    expect(toInternal(2_000n * E24 + 1_000_000n, 24)).toBe(2_000n * E18 + 1n);
    expect(toInternal(999_999n, 24)).toBe(0n);
  });

  it("pays out whole token units and attaches enough to cover an amount", () => {
    const internal = 2_450_000_000_000_000_000_001n; // 2450 USDC and one internal unit of dust
    expect(toTokenFloor(internal, 6)).toBe(2_450_000_000n);
    expect(toTokenCeil(internal, 6)).toBe(2_450_000_001n);
    expect(toTokenCeil(2_450n * E18, 6)).toBe(2_450_000_000n);
    expect(toTokenCeil(0n, 6)).toBe(0n);
    expect(toTokenCeil(5n, 18)).toBe(5n);
  });

  it("sends wNEAR exactly: internal × 1e6, no rounding either way", () => {
    expect(toTokenFloor(2_000n * E18, 24)).toBe(2_000n * E24);
    expect(toTokenCeil(2_000n * E18, 24)).toBe(2_000n * E24);
    expect(toTokenFloor(1n, 24)).toBe(1_000_000n);
    expect(toTokenCeil(1n, 24)).toBe(1_000_000n);
    for (const x of [1n, 999_999_999_999n, 1_234_567_890_123_456_789_012n]) {
      expect(toInternal(toTokenFloor(x, 24), 24)).toBe(x);
    }
  });

  it("round-trips: what is attached always covers the amount, by less than one token unit", () => {
    for (const x of [1n, 999_999_999_999n, 10n ** 12n, 10n ** 12n + 1n, 123_456_789_012_345_678_901n]) {
      const t = toTokenCeil(x, 6);
      expect(toInternal(t, 6) >= x).toBe(true);
      expect(toInternal(t, 6) - x < 10n ** 12n).toBe(true);
    }
  });
});

describe("native NEAR amounts", () => {
  it("converts to yocto and back", () => {
    expect(nearToYocto("0.1")).toBe(10n ** 23n);
    expect(nearToYocto("1")).toBe(E24);
    expect(nearToYocto("0.00125")).toBe(1_250_000_000_000_000_000_000n);
    expect(fmtYocto(10n ** 23n)).toBe("0.1");
    expect(fmtYocto(61_500_000_000_000_000_000_000n)).toBe("0.061");
  });
});
