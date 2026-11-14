import { describe, expect, it } from "vitest";
import type { LiquidationQuote } from "./domain";
import { pct } from "./format";
import {
  cashMinOut,
  liquidateBlocker,
  liquidationBudget,
  maxHfArg,
  maxRepaysAll,
  parseHfFilter,
  realPiece,
  seizedShare,
  sortAtRisk,
  statusLabel,
  type AtRiskRow,
} from "./liquidation";
import { liquidate } from "./near/tx";
import { toInternal } from "./units";

const WAD = 10n ** 18n;
const usd = (s: string) => {
  const [w, f = ""] = s.split(".");
  return BigInt(w) * WAD + BigInt(f.padEnd(18, "0"));
};

// Carl on production's market 1 (web 7.4): legacy Normal 0.75 / 0.05, "max" repays half of 892.822257.
const CARL_REPAY = usd("446.411128636390666887");
const CARL_CASH = usd("464.979557417194296373");

function quote(p: Partial<LiquidationQuote> = {}): LiquidationQuote {
  return {
    error: null,
    liquidation: "liquidatable",
    debt: usd("892.822257"),
    healthFactor: usd("0.95187"),
    cap: CARL_REPAY,
    fullSeizeRepay: usd("1079.175467"),
    repay: CARL_REPAY,
    target: 0n,
    seizeAll: false,
    writtenOff: 0n,
    priceFactor: WAD,
    pieces: [],
    cash: { sold: [], received: [], merged: 0n, realUsdc: 0n, redeemed: 0n, cash: CARL_CASH, leftUsdc: [], dead: [], guardOk: true },
    ...p,
  };
}

describe("liquidation budget and cash minimum (web 7.4, X15)", () => {
  it("attaches Carl's repayment plus 0.1%, rounded up to a USDC unit", () => {
    expect(liquidationBudget(CARL_REPAY, 6)).toBe(446_857_540n);
  });

  it("asks at least 1% under Carl's cash quote", () => {
    expect(cashMinOut(CARL_CASH, CARL_REPAY)).toBe(460_329_761_843_022_353_409n);
  });

  it("never asks less than the repayment", () => {
    expect(cashMinOut(usd("450"), usd("446.411128"))).toBe(usd("446.411128"));
  });

  it("blocks cash mode when the cash would not cover the repayment", () => {
    const q = quote({ repay: usd("446.411128"), cash: { ...quote().cash!, cash: usd("446") } });
    const p = { quote: q, walletUsdc: usd("1000"), budgetInternal: usd("447") };
    expect(liquidateBlocker({ ...p, receive: "cash" })).toBe("Cash-out would return less than you repay; take tokens");
    expect(liquidateBlocker({ ...p, receive: "tokens" })).toBeUndefined();
  });

  it("sends min_out in cash mode only", () => {
    const base = { scenarioId: 1, accountId: "carl.testnet", repayAmount: "max" as const };
    const cash = liquidate("usdc.testnet", "app.testnet", 446_857_540n, { ...base, receive: "cash", minOut: cashMinOut(CARL_CASH, CARL_REPAY) });
    const tokens = liquidate("usdc.testnet", "app.testnet", 446_857_540n, { ...base, receive: "tokens", tier: "bold" });
    const msg = (tx: typeof cash) => JSON.parse(tx.actions[0].params.args.msg as string);
    expect(msg(cash)).toMatchObject({ action: "liquidate", repay_amount: "max", receive: "cash", min_out: "460329761843022353409" });
    expect(msg(tokens)).toEqual({ action: "liquidate", scenario_id: 1, account_id: "carl.testnet", repay_amount: "max", tier: "bold" });
    expect(() => liquidate("u", "c", 1n, { ...base, receive: "tokens", minOut: 1n })).toThrow();
  });
});

describe("the liquidate blocker", () => {
  const ok = { quote: quote(), receive: "cash" as const, walletUsdc: usd("1000"), budgetInternal: toInternal(446_857_540n, 6) };
  it("passes Carl with enough USDC", () => {
    expect(liquidateBlocker(ok)).toBeUndefined();
  });
  it("names what stops it", () => {
    expect(liquidateBlocker({ ...ok, quote: undefined })).toBe("Getting a quote…");
    expect(liquidateBlocker({ ...ok, quote: quote({ liquidation: "paused_no_price" }) })).toBe("Not liquidatable now");
    expect(liquidateBlocker({ ...ok, quote: quote({ cash: { ...quote().cash!, guardOk: false } }) })).toBe("Cash-out would unprice a world: use tokens");
    expect(liquidateBlocker({ ...ok, walletUsdc: usd("10") })).toBe("Not enough USDC in your wallet");
    expect(liquidateBlocker({ ...ok, amount: usd("500") })).toBe("More than can be repaid now: use Max");
    expect(liquidateBlocker({ ...ok, quote: quote({ error: "ZeroAmount" }) })).toBeTruthy();
  });
  it("says when Max repays the whole loan", () => {
    expect(maxRepaysAll(quote())).toBe(false);
    expect(maxRepaysAll(quote({ debt: usd("150"), cap: usd("150") }))).toBe(true);
  });
});

describe("at-risk rows", () => {
  const row = (accountId: string, hf: string | null, liquidation: AtRiskRow["liquidation"] = "none", scenarioId = 1): AtRiskRow => ({
    index: 0,
    accountId,
    debt: usd("100"),
    healthFactor: hf === null ? null : usd(hf),
    worstWorld: 0,
    cMin: usd("100"),
    liquidation,
    unpricedWorld: null,
    maxRepay: 0n,
    fullSeizeRepay: 0n,
    writeOffReady: false,
    scenarioId,
    tier: "normal",
  });

  it("puts liquidatable loans first, then the lowest health factor", () => {
    const sorted = sortAtRisk([row("a", "1.05"), row("b", "0.97", "paused"), row("c", "0.99", "liquidatable"), row("d", null)]);
    expect(sorted.map((r) => r.accountId)).toEqual(["c", "b", "a", "d"]);
  });

  it("reads the filter from the URL, defaulting to 1.1", () => {
    expect(parseHfFilter(null)).toBe("1.1");
    expect(parseHfFilter("1.5")).toBe("1.5");
    expect(parseHfFilter("2")).toBe("1.1");
    expect(maxHfArg("1.1")).toBe("1100000000000000000");
    expect(maxHfArg("1")).toBe("1000000000000000000");
    expect(maxHfArg("all")).toBeUndefined();
  });

  it("labels a paused loan in its grace", () => {
    expect(statusLabel({ liquidation: "paused", healthFactor: usd("0.9") }, 20n)).toBe("Grace");
    expect(statusLabel({ liquidation: "paused", healthFactor: usd("0.9") }, 0n)).toBe("Paused");
    expect(statusLabel({ liquidation: "liquidatable", healthFactor: usd("0.9") }, 0n)).toBe("Liquidatable");
  });

  it("shows the share of every piece a partial seizure takes", () => {
    expect(pct(seizedShare(usd("41.3659"), usd("100"))!, WAD, 4)).toBe("41.3659%");
    expect(seizedShare(1n, 0n)).toBeUndefined();
    expect(realPiece("wnear")).toBe("wnear");
    expect(realPiece("1:wnear:3")).toBeUndefined();
  });
});
