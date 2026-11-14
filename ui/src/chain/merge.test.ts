import { describe, expect, it } from "vitest";
import { mergeable } from "./merge";

const w = (index: number, near: bigint, usdc: bigint) => ({ index, walletNearWad: near, walletUsdcWad: usdc });

describe("mergeable", () => {
  it("is the least piece over the worlds still possible, per asset", () => {
    const worlds = [w(0, 5n, 9n), w(1, 3n, 0n), w(2, 7n, 4n), w(3, 0n, 1n)];
    expect(mergeable(worlds, 0b0111, "wnear")).toBe(3n);
    expect(mergeable(worlds, 0b0101, "usdc")).toBe(4n);
    expect(mergeable(worlds, 0b1111, "wnear")).toBe(0n);
    expect(mergeable(undefined, 0b11, "wnear")).toBe(0n);
  });
});
