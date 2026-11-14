// How the keeper sizes one liquidation from the contract's own quotes (design scripts 17.2, S-8):
// repay what `liquidation_quote(.., "max")` says, attach that plus an interest buffer, and take the
// cash-out only when its proceeds, less slippage, cover the repayment (never sell at a loss);
// otherwise take the seized pieces as tokens. All amounts are internal 18-decimal units.

import type { Receive } from "./msgs.ts";
import { roundUpToStep } from "./units.ts";
import type { LiquidationQuote } from "./views.ts";

export interface DecideOptions {
  /** auto = cash when it pays, else tokens; cash = skip unless cash pays; tokens = never cash out. */
  mode: "auto" | "cash" | "tokens";
  slippageBps: number;
  minProfitBps: number;
  /** Interest that may accrue between the quote and the transaction, as a share of the debt. */
  bufferBps: number;
  usdcDecimals: number;
}

export const DEFAULT_DECIDE: DecideOptions = { mode: "auto", slippageBps: 50, minProfitBps: 0, bufferBps: 10, usdcDecimals: 6 };

export type Decision =
  | { kind: "liquidate"; receive: Receive; repay: bigint; budget: bigint; minOut: bigint | null; cash: bigint | null }
  | { kind: "write_off" }
  | { kind: "skip"; reason: string };

const bps = (x: bigint, b: number): bigint => (x * BigInt(b)) / 10_000n;
const ceilBps = (x: bigint, b: number): bigint => (x * BigInt(b) + 9_999n) / 10_000n;

/**
 * `tokens`: the quote with receive "tokens"; `cash`: the same with receive "cash" (null when the
 * cash-out was not asked for, e.g. trading is paused).
 */
export function decide(writeOffReady: boolean, tokens: LiquidationQuote, cash: LiquidationQuote | null, o: DecideOptions = DEFAULT_DECIDE): Decision {
  if (writeOffReady) return { kind: "write_off" };
  if (tokens.error !== null) return { kind: "skip", reason: tokens.error };
  const repay = BigInt(tokens.repay);
  if (repay === 0n) return { kind: "skip", reason: "nothing to repay" };
  const budgetFor = (r: bigint, debt: bigint): bigint => roundUpToStep(r + ceilBps(debt, o.bufferBps), o.usdcDecimals);
  let proceeds: bigint | null = null;
  if (o.mode !== "tokens" && cash !== null && cash.error === null && cash.cash !== null && cash.cash.guard_ok) {
    // the two quotes may straddle a block: the cash one sizes its own repayment
    const repayC = BigInt(cash.repay);
    proceeds = BigInt(cash.cash.cash);
    const net = bps(proceeds, 10_000 - o.slippageBps);
    const floor = bps(repayC, 10_000 + o.minProfitBps);
    // S-8: a cash-out is sent only with min_out >= repay
    if (repayC > 0n && net >= floor && floor >= repayC) {
      return { kind: "liquidate", receive: "cash", repay: repayC, budget: budgetFor(repayC, BigInt(cash.debt)), minOut: net, cash: proceeds };
    }
  }
  if (o.mode === "cash") return { kind: "skip", reason: cash?.error ?? "cash-out does not cover the repayment" };
  return { kind: "liquidate", receive: "tokens", repay, budget: budgetFor(repay, BigInt(tokens.debt)), minOut: null, cash: proceeds };
}
