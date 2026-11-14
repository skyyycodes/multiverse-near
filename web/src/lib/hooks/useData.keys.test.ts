import { describe, expect, it } from "vitest";
import { keepWithin } from "./useData";

const C = "app.ifverse-staging.testnet";
const prev = { scenario: 5 };
const query = (key: readonly unknown[]) => ({ queryKey: key });

describe("placeholder data stays within its market and tier (WI-1)", () => {
  it("keeps the previous snapshot on the same market", () => {
    expect(keepWithin(5)(prev, query(["trade", C, "5", "alice"]))).toBe(prev);
    expect(keepWithin(5, "safe")(prev, query(["borrow", C, "5", "alice", "safe"]))).toBe(prev);
    expect(keepWithin(5, "safe")(prev, query(["borrow", C, "5", "", "safe"]))).toBe(prev);
  });

  it("drops it when the market changes", () => {
    expect(keepWithin(6)(prev, query(["trade", C, "5", "alice"]))).toBeUndefined();
    expect(keepWithin(6, "safe")(prev, query(["borrow", C, "5", "alice", "safe"]))).toBeUndefined();
    expect(keepWithin(undefined)(prev, query(["trade", C, "5", "alice"]))).toBeUndefined();
  });

  it("drops it when the tier changes", () => {
    expect(keepWithin(5, "bold")(prev, query(["borrow", C, "5", "alice", "safe"]))).toBeUndefined();
    expect(keepWithin(5, "normal")(prev, query(["lend", C, "5", "alice", "safe"]))).toBeUndefined();
  });

  it("has nothing to keep before the first answer", () => {
    expect(keepWithin(5)(undefined, undefined)).toBeUndefined();
  });
});
