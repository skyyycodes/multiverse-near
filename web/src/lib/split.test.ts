import { describe, expect, it } from "vitest";
import { canSplit, mergeMax, rootMask, singleWorldMasks } from "./split";

describe("split and merge", () => {
  it("lists the single worlds of the possible mask", () => {
    expect(singleWorldMasks(0b1111)).toEqual([1, 2, 4, 8]);
    expect(singleWorldMasks(0b1010)).toEqual([2, 8]);
    expect(rootMask(4)).toBe(15);
    expect(rootMask(8)).toBe(255);
  });

  it("merges at most the smallest balance over possible worlds, ignoring dead ones", () => {
    const worlds = [
      { mask: 1, userWnear: 5n, userUsdc: 9n },
      { mask: 2, userWnear: 3n, userUsdc: 7n },
      { mask: 4, userWnear: 0n, userUsdc: 0n },
      { mask: 8, userWnear: 4n, userUsdc: 8n },
    ];
    expect(mergeMax(worlds, 0b1111, "wnear")).toBe(0n);
    expect(mergeMax(worlds, 0b1011, "wnear")).toBe(3n);
    expect(mergeMax(worlds, 0b1011, "usdc")).toBe(7n);
  });

  it("refuses a market with one possible world", () => {
    expect(canSplit(0b0100)).toBe(false);
    expect(canSplit(0b0110)).toBe(true);
  });
});
