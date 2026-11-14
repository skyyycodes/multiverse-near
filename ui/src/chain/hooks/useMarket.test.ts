import { describe, expect, it } from "vitest";
import { lastMarketKey, parseMarketParam, resolveMarket, withMarketId } from "./useMarket";

describe("the market id in the URL", () => {
  it("takes only a positive safe integer without leading zeros", () => {
    expect(parseMarketParam("5")).toBe(5);
    expect(parseMarketParam("1")).toBe(1);
    expect(parseMarketParam("9007199254740991")).toBe(9_007_199_254_740_991);
    for (const bad of ["05", "0", "-1", "1e3", "5.0", "9007199254740993", "abc", "", " 5", "5 "]) expect(parseMarketParam(bad), bad).toBe("invalid");
    expect(parseMarketParam(null)).toBeUndefined();
  });

  it("resolves URL, then the last market, then the demo record, then none", () => {
    expect(resolveMarket("7", 3, 1)).toEqual({ sid: 7, source: "url" });
    expect(resolveMarket(null, 3, 1)).toEqual({ sid: 3, source: "last" });
    expect(resolveMarket(null, undefined, 1)).toEqual({ sid: 1, source: "demo" });
    expect(resolveMarket(null, undefined, null)).toEqual({ sid: undefined, source: "none" });
    expect(resolveMarket(null, undefined, undefined)).toEqual({ sid: undefined, source: "none" });
    // an invalid id in the URL is an answer, never replaced by a fallback
    expect(resolveMarket("05", 3, 1)).toEqual({ sid: undefined, source: "url", invalid: "05" });
  });

  it("rewrites the URL with the id, keeping every other param", () => {
    expect(withMarketId("sel=14", 5)).toBe("sel=14&id=5");
    expect(withMarketId("w=3&fx=seeded&as=alice", 1)).toBe("w=3&fx=seeded&as=alice&id=1");
    expect(withMarketId("", 2)).toBe("id=2");
    expect(withMarketId("id=9&tier=safe", 2)).toBe("id=2&tier=safe");
  });

  it("remembers per contract", () => {
    expect(lastMarketKey("app.ifverse-staging.testnet")).toBe("ifverse.market.last:app.ifverse-staging.testnet");
  });
});
