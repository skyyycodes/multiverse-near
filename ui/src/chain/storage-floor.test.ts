import { describe, expect, it } from "vitest";
import { needsTopUp, STORAGE_FLOOR, storageShortfall, TOP_UP } from "./storage-floor";

describe("storage top-up", () => {
  it("tops up a registered account whose free deposit is under the floor, and nothing else", () => {
    expect(STORAGE_FLOOR).toBe(2n * 10n ** 22n);
    expect(TOP_UP).toBe(10n ** 23n);
    expect(needsTopUp({ total: "100000000000000000000000", available: "19999999999999999999999" })).toBe(true);
    expect(needsTopUp({ total: "100000000000000000000000", available: "20000000000000000000000" })).toBe(false);
    expect(needsTopUp(null)).toBe(false);
    expect(needsTopUp(undefined)).toBe(false);
  });

  it("sizes the top-up after an InsufficientStorage refusal", () => {
    expect(storageShortfall("Short (InsufficientStorage(3000000000000000000000, 1000000000000000000000))")).toBe(TOP_UP);
    // 0.25 NEAR short: 0.26 rounded up, plus 0.01
    expect(storageShortfall(`x (InsufficientStorage(${3n * 10n ** 23n}, ${5n * 10n ** 22n}))`)).toBe(26n * 10n ** 22n);
    expect(storageShortfall("InsufficientStorage(5, 9)")).toBe(TOP_UP);
    expect(storageShortfall("NotRegistered(bob.testnet)")).toBeUndefined();
  });
});
