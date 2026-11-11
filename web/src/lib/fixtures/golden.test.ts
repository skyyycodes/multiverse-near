import { describe, expect, it } from "vitest";
import { fmt, fmtHf } from "../format";
import { swapOut } from "./amm";
import { accountJson, buildWorld, oddsOf, scenarioJson, wad } from "./golden";
import { nextStage } from "./wallet";

// The design fixtures must show the seeded demo's numbers, or the screenshots lie.
const cents = (x: bigint | string) => fmt(BigInt(x));

describe("seeded demo", () => {
  const w = buildWorld("seeded", 1_800_000_000);
  const s = scenarioJson(w, 1, undefined);

  it("prices the four worlds at 3,700 / 3,000 / 3,300 / 2,500", () => {
    expect(s.worlds.map((x) => cents(x.weth_price))).toEqual(["3,700.00", "3,000.00", "3,300.00", "2,500.00"]);
  });

  it("odds sum to exactly 1e18 and the implied spot is 3,037.86", () => {
    const q = oddsOf(1, 0b1111);
    expect(q.reduce((a, b) => a + b, 0n)).toBe(10n ** 18n);
    expect(cents(s.implied_spot)).toBe("3,037.86");
    expect(cents(scenarioJson(w, 2, undefined).implied_spot)).toBe("3,200.02");
  });

  it("sells 2 ETH into the thin DELAYED·HOLDS pool for 4,748.29 alone", () => {
    const p = w.pools[1][3];
    expect(cents(swapOut(p.x, p.y, wad("2"), p.feePips))).toBe("4,748.29");
    expect(cents(swapOut(p.x, p.y, wad("1"), p.feePips))).toBe("2,431.88");
  });
});

describe("Alice's sale and loan", () => {
  it("keeps her proceeds as collateral: 5,865.05 / 6,451.55 / 4,881.88 with Ravi's bid", () => {
    const w = buildWorld("sold", 1_800_000_000);
    const a = accountJson(w, 1, "alice");
    expect(a.collateral.map((c) => cents(c.amount))).toEqual(["2.00", "5,865.05", "6,451.55", "4,881.88"]);
    const s = scenarioJson(w, 1, "alice");
    expect(s.worlds.slice(1).map((x) => cents(x.weth_price))).toEqual(["2,883.84", "3,172.23", "2,379.88"]);
  });

  it("borrows 3,000 at a worst-world health factor of 1.22", () => {
    const w = buildWorld("borrowed", 1_800_000_000);
    const a = accountJson(w, 1, "alice");
    expect(a.worst_world).toBe(3);
    expect(fmtHf(a.health_factor === null ? null : BigInt(a.health_factor))).toBe("1.22");
  });

  it("collapses to DELAYED·HOLDS, where her USDC redeems", () => {
    const w = buildWorld("collapsed", 1_800_000_000);
    expect(w.possible[1]).toBe(0b1000);
    expect(oddsOf(1, 0b1000)).toEqual([0n, 0n, 0n, 10n ** 18n]);
  });
});

describe("Carl, the unhedged borrower", () => {
  it("is liquidatable after the push and paused while a result is pending", () => {
    const pushed = accountJson(buildWorld("pushed", 1_800_000_000), 1, "carl");
    expect(pushed.liquidation).toBe("liquidatable");
    expect(BigInt(pushed.health_factor!) < 10n ** 18n).toBe(true);
    expect(accountJson(buildWorld("proposed", 1_800_000_000), 1, "carl").liquidation).toBe("paused_halted");
  });
});

describe("design-mode story", () => {
  const tx = (methodName: string, args: Record<string, unknown> = {}) => ({
    receiverId: "x",
    actions: [{ type: "FunctionCall" as const, params: { methodName, args, gas: "1", deposit: "1" } }],
  });
  it("moves to the next stage only on the story's next step", () => {
    expect(nextStage("seeded", tx("ft_transfer_call", { msg: JSON.stringify({ action: "conditional_sell" }) }), "alice")).toBe("sold");
    expect(nextStage("seeded", tx("ft_transfer_call", { msg: JSON.stringify({ action: "conditional_sell" }) }), "bob")).toBeUndefined();
    expect(nextStage("sold", tx("borrow"), "alice")).toBe("borrowed");
    expect(nextStage("proposed", tx("finalize", { event_id: 2 }), "alice")).toBe("fed");
    expect(nextStage("fed", tx("admin_resolve", { event_id: 1, outcome: 1 }), "owner")).toBe("collapsed");
  });
});
