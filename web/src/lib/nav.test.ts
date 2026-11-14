import { describe, expect, it } from "vitest";
import { isCurrent, NAV, samePath } from "../components/shell/nav";

const [markets, atRisk, propose, admin] = NAV;

describe("the global navigation", () => {
  it("has the four global screens", () => {
    expect(NAV.map((n) => [n.label, n.href, n.demo])).toEqual([
      ["Markets", "/", "nav-markets"],
      ["At-risk loans", "/liquidate/", "nav-liquidate"],
      ["Propose", "/propose/", "nav-propose"],
      ["Admin", "/admin/", "nav-admin"],
    ]);
  });

  it("marks Markets current on the list and on every market screen", () => {
    for (const path of ["/", "/market/", "/sell/", "/orders/", "/split/", "/world/", "/borrow/", "/lend/", "/resolve/"]) expect(isCurrent(path, markets), path).toBe(true);
    for (const path of ["/liquidate/", "/propose/", "/admin/", "/welcome/"]) expect(isCurrent(path, markets), path).toBe(false);
  });

  it("marks the other links on their own screens", () => {
    expect(isCurrent("/liquidate/", atRisk)).toBe(true);
    expect(isCurrent("/proposal/", propose)).toBe(true);
    expect(isCurrent("/propose/", propose)).toBe(true);
    expect(isCurrent("/admin", admin)).toBe(true);
    expect(isCurrent("/borrow/", admin)).toBe(false);
    expect(samePath("/admin/", "/admin/")).toBe(true);
  });
});
