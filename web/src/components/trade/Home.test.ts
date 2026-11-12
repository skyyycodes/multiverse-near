import { describe, expect, it } from "vitest";
import type { Balances } from "@/lib/hooks/useData";
import { innerChipText } from "./Home";

const E18 = 10n ** 18n;
const none: Balances = { wnear: 0n, usdc: 0n, innerWnear: 0n, innerUsdc: 0n };

describe("the In Multiverse chip", () => {
  it("stays hidden for nothing and for rounding dust", () => {
    expect(innerChipText(undefined)).toBeUndefined();
    expect(innerChipText(none)).toBeUndefined();
    // What a supply and withdraw-all can leave: a few billionths of a USDC, a fraction of a base unit.
    expect(innerChipText({ ...none, innerUsdc: 3_000_000_000n })).toBeUndefined();
    expect(innerChipText({ ...none, innerWnear: 10n ** 13n })).toBeUndefined();
  });

  it("shows each asset that reaches the chip's precision", () => {
    expect(innerChipText({ ...none, innerUsdc: 1_250n * E18 })).toBe("1,250.00 USDC");
    expect(innerChipText({ ...none, innerWnear: E18 / 2n })).toBe("0.5000 WETH");
    expect(innerChipText({ ...none, innerUsdc: 10n ** 16n, innerWnear: 10n ** 14n })).toBe("0.01 USDC + 0.0001 WETH");
  });
});
