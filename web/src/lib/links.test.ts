import { describe, expect, it } from "vitest";
import {
  adminHref,
  borrowHref,
  lendHref,
  liquidateHref,
  marketHref,
  ordersHref,
  proposalHref,
  proposeHref,
  q,
  resolveHref,
  sellHref,
  shareUrl,
  splitHref,
  worldHref,
} from "./links";

describe("link builders", () => {
  it("keep the trailing slash before the query and drop empty params in order", () => {
    expect(q("/sell/", { id: 5, sel: undefined, w: 3 })).toBe("/sell/?id=5&w=3");
    expect(q("/liquidate/", { id: undefined })).toBe("/liquidate/");
    expect(q("/x/", { b: 2, a: 1 })).toBe("/x/?b=2&a=1");
  });

  it("build every route of the app", () => {
    expect(marketHref(5)).toBe("/market/?id=5");
    expect(sellHref(5)).toBe("/sell/?id=5");
    expect(sellHref(5, { sel: 14 })).toBe("/sell/?id=5&sel=14");
    expect(sellHref(5, { w: 3 })).toBe("/sell/?id=5&w=3");
    expect(ordersHref(5)).toBe("/orders/?id=5");
    expect(ordersHref(5, { w: 0, buy: true })).toBe("/orders/?id=5&w=0&buy=1");
    expect(ordersHref(5, { buy: false })).toBe("/orders/?id=5");
    expect(splitHref(5)).toBe("/split/?id=5");
    expect(splitHref(5, { asset: "usdc", mode: "merge" })).toBe("/split/?id=5&asset=usdc&mode=merge");
    expect(worldHref(5, 3)).toBe("/world/?id=5&w=3");
    expect(resolveHref(5)).toBe("/resolve/?id=5");
    expect(proposalHref(12)).toBe("/proposal/?p=12");
    expect(liquidateHref()).toBe("/liquidate/");
    expect(liquidateHref(1)).toBe("/liquidate/?id=1");
    expect(adminHref()).toBe("/admin/");
    expect(adminHref(5)).toBe("/admin/?id=5");
  });

  it("put the tier in the URL by name, never Normal", () => {
    expect(borrowHref(5)).toBe("/borrow/?id=5");
    expect(borrowHref(5, "normal")).toBe("/borrow/?id=5");
    expect(borrowHref(5, "safe")).toBe("/borrow/?id=5&tier=safe");
    expect(lendHref(5, "bold")).toBe("/lend/?id=5&tier=bold");
    expect(lendHref(5, "normal")).toBe("/lend/?id=5");
  });

  it("join the events of a proposal form", () => {
    expect(proposeHref()).toBe("/propose/");
    expect(proposeHref({ kind: "market", events: [7, 8] })).toBe("/propose/?kind=market&events=7,8");
    expect(proposeHref({ kind: "event", events: [] })).toBe("/propose/?kind=event");
  });

  it("shares an absolute market link", () => {
    expect(shareUrl(1, "https://ifverse-staging.vercel.app")).toBe("https://ifverse-staging.vercel.app/market/?id=1");
  });
});
