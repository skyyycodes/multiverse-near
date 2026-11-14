import assert from "node:assert/strict";
import { test } from "node:test";

import { decide, DEFAULT_DECIDE } from "./liquidator.ts";
import type { LiquidationQuote } from "./views.ts";

const usdc = (s: string): bigint => {
  const [w = "0", f = ""] = s.split(".");
  return BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, "0"));
};

function quote(repay: bigint, debt: bigint, cash: bigint | null, extra: Partial<LiquidationQuote> = {}): LiquidationQuote {
  return {
    error: null,
    liquidation: "liquidatable",
    debt: debt.toString(),
    health_factor: "900000000000000000",
    cap: repay.toString(),
    full_seize_repay: debt.toString(),
    repay: repay.toString(),
    target: "0",
    seize_all: false,
    written_off: "0",
    price_factor: "1000000000000000000",
    pieces: [],
    cash:
      cash === null
        ? null
        : { sold: [], received: [], merged: "0", real_usdc: "0", redeemed: "0", cash: cash.toString(), left_usdc: [], dead: [], guard_ok: true },
    ...extra,
  };
}

// Production Carl (design scripts 17.2): repay 446.411128 of a 892.822257 debt, cash about 464.98.
const REPAY = usdc("446.411128");
const DEBT = usdc("892.822257");

test("Carl: budget is repay plus 10 bps of the debt, rounded up to a USDC unit; cash-out with min_out 462.6551", () => {
  const d = decide(false, quote(REPAY, DEBT, null), quote(REPAY, DEBT, usdc("464.98")));
  assert.equal(d.kind, "liquidate");
  if (d.kind !== "liquidate") return;
  assert.equal(d.receive, "cash");
  assert.equal(d.budget, usdc("447.303951"));
  assert.equal(d.budget % 10n ** 12n, 0n);
  assert.equal(d.minOut, usdc("462.6551"));
  assert.ok(d.minOut !== null && d.minOut >= d.repay, "S-8");
});

test("tokens when the cash-out would not cover the repayment after slippage", () => {
  // 448 x 0.995 = 445.76 < 446.411128
  const d = decide(false, quote(REPAY, DEBT, null), quote(REPAY, DEBT, usdc("448")));
  assert.equal(d.kind, "liquidate");
  if (d.kind === "liquidate") {
    assert.equal(d.receive, "tokens");
    assert.equal(d.minOut, null);
  }
});

test("S-8 holds for any proceeds: a cash decision always has min_out >= repay", () => {
  for (let cents = 40_000n; cents <= 50_000n; cents += 7n) {
    const d = decide(false, quote(REPAY, DEBT, null), quote(REPAY, DEBT, cents * 10n ** 16n));
    if (d.kind === "liquidate" && d.receive === "cash") assert.ok(d.minOut !== null && d.minOut >= d.repay);
  }
});

test("a cash quote whose guard fails, or that errs, falls back to tokens; mode cash then skips", () => {
  const bad = quote(REPAY, DEBT, usdc("500"));
  if (bad.cash) bad.cash.guard_ok = false;
  assert.equal(decide(false, quote(REPAY, DEBT, null), bad).kind, "liquidate");
  const erred = quote(REPAY, DEBT, null, { error: "CashOutUnpricesWorld(2)" });
  const d = decide(false, quote(REPAY, DEBT, null), erred, { ...DEFAULT_DECIDE, mode: "cash" });
  assert.deepEqual(d, { kind: "skip", reason: "CashOutUnpricesWorld(2)" });
});

test("the cash quote sizes its own repayment when the two quotes straddle a block", () => {
  const repayC = REPAY + 5n * 10n ** 12n;
  const d = decide(false, quote(REPAY, DEBT, null), quote(repayC, DEBT + 10n ** 13n, usdc("464.98")));
  assert.ok(d.kind === "liquidate" && d.receive === "cash" && d.repay === repayC && d.budget >= repayC);
});

test("errors skip, write-off-ready rows write off, mode tokens never cashes out", () => {
  assert.deepEqual(decide(false, quote(REPAY, DEBT, null, { error: "NotLiquidatable(1012000000000000000)" }), null), {
    kind: "skip",
    reason: "NotLiquidatable(1012000000000000000)",
  });
  assert.deepEqual(decide(true, quote(REPAY, DEBT, null), null), { kind: "write_off" });
  const d = decide(false, quote(REPAY, DEBT, null), quote(REPAY, DEBT, usdc("600")), { ...DEFAULT_DECIDE, mode: "tokens" });
  assert.ok(d.kind === "liquidate" && d.receive === "tokens");
});
