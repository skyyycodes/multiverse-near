import { describe, expect, it } from "vitest";
import { footerLinks, isCurrent, nav } from "../config";

describe("the navigation", () => {
  it("has the app's screens, in order", () => {
    expect(nav.map((n) => [n.label, n.to])).toEqual([
      ["Markets", "/markets/"],
      ["Portfolio", "/portfolio/"],
      ["Borrow", "/borrow/"],
      ["Lend", "/lend/"],
      ["Order book", "/orders/"],
      ["Propose", "/propose/"],
      ["Resolve", "/resolve/"],
      ["How it works", "/docs/"],
    ]);
  });

  it("marks Markets on the board and on a market's own pages", () => {
    const markets = nav[0];
    for (const path of ["/markets", "/markets/", "/market", "/market/", "/split/"]) expect(isCurrent(path, markets), path).toBe(true);
    for (const path of ["/", "/portfolio/", "/orders/", "/marketsx/"]) expect(isCurrent(path, markets), path).toBe(false);
  });

  it("marks Propose on a proposal's page too, and each other link on its own screen", () => {
    const at = (label: string) => nav.find((n) => n.label === label)!;
    expect(isCurrent("/proposal", at("Propose"))).toBe(true);
    expect(isCurrent("/propose/", at("Propose"))).toBe(true);
    expect(isCurrent("/borrow", at("Borrow"))).toBe(true);
    expect(isCurrent("/borrow/", at("Lend"))).toBe(false);
    expect(isCurrent("/docs/", at("How it works"))).toBe(true);
  });

  it("links the screens reached in context from the footer", () => {
    const hrefs = footerLinks.map((l) => l.to);
    expect(hrefs).toContain("/liquidate/");
    expect(hrefs).toContain("/admin/");
  });
});
