import { describe, expect, it } from "vitest";
import { needsTopUp, STORAGE_FLOOR, TOP_UP } from "./storage-floor";

describe("storage top-up", () => {
  it("tops up a registered account whose free deposit is under the floor, and nothing else", () => {
    expect(STORAGE_FLOOR).toBe(2n * 10n ** 22n);
    expect(TOP_UP).toBe(10n ** 23n);
    expect(needsTopUp({ total: "100000000000000000000000", available: "19999999999999999999999" })).toBe(true);
    expect(needsTopUp({ total: "100000000000000000000000", available: "20000000000000000000000" })).toBe(false);
    expect(needsTopUp(null)).toBe(false);
    expect(needsTopUp(undefined)).toBe(false);
  });
});
