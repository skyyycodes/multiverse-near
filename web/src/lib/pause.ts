// Which pause flags block which app action (SPEC-contract 3.2, transcribed; web design 5.4). A TxButton names its
// action and is blocked only by these flags (WI-3): an action with no flags (repay, adding collateral, insurance,
// storage) is never blocked by a pause.
import type { PauseFlag, PauseState } from "./domain";
import { countdown } from "./format";

export type { PauseFlag };

export type AppAction =
  | "sell"
  | "sell_to_collateral"
  | "buy"
  | "post_order"
  | "cancel_order"
  | "split"
  | "merge"
  | "redeem"
  | "close"
  | "borrow"
  | "repay"
  | "add_collateral"
  | "supply"
  | "withdraw_supply"
  | "lp_deposit"
  | "lp_withdraw"
  | "withdraw_inner"
  | "liquidate_tokens"
  | "liquidate_cash"
  | "write_off"
  | "fund_insurance"
  | "propose"
  | "pledge"
  | "withdraw_pledge"
  | "claim_unused"
  | "seed_withdraw"
  | "open_market"
  | "cancel_proposal"
  | "top_up_proposal"
  | "approve"
  | "reject"
  | "listing"
  | "finalize"
  | "admin_resolve"
  | "dispute"
  | "request_resolution"
  | "request_reference"
  | "price_push"
  | "register"
  | "storage_top_up"
  | "faucet"
  | "pause"
  | "unpause";

export const PAUSE_FLAGS: readonly PauseFlag[] = ["trade", "mint", "transfer", "lend", "liquidate", "oracle", "pledge", "exit"];

export const ACTION_FLAGS: Record<AppAction, readonly PauseFlag[]> = {
  sell: ["trade"],
  sell_to_collateral: ["trade", "lend"],
  buy: ["trade"],
  post_order: ["trade"],
  cancel_order: ["exit"],
  split: ["mint"],
  merge: ["exit"],
  redeem: ["exit"],
  close: ["exit"],
  borrow: ["lend"],
  repay: [],
  add_collateral: [],
  supply: ["lend"],
  withdraw_supply: ["exit"],
  lp_deposit: ["mint"],
  lp_withdraw: ["exit"],
  withdraw_inner: ["exit"],
  liquidate_tokens: ["liquidate"],
  liquidate_cash: ["liquidate", "trade"],
  write_off: ["liquidate"],
  fund_insurance: [],
  propose: ["pledge"],
  pledge: ["pledge"],
  withdraw_pledge: ["exit"],
  claim_unused: ["exit"],
  seed_withdraw: ["exit"],
  open_market: ["mint"],
  cancel_proposal: [],
  top_up_proposal: ["pledge"],
  approve: [],
  reject: [],
  listing: [],
  finalize: ["oracle"],
  admin_resolve: [],
  dispute: [],
  request_resolution: ["oracle"],
  request_reference: ["oracle"],
  price_push: ["trade"],
  register: [],
  storage_top_up: [],
  faucet: [],
  pause: [],
  unpause: [],
};

/** Each flag in plain words, as the banner and a blocked button name it. */
export const FLAG_LABEL: Record<PauseFlag, string> = {
  trade: "trading",
  mint: "new positions and markets",
  transfer: "token transfers",
  lend: "lending",
  liquidate: "liquidations",
  oracle: "resolution",
  pledge: "proposals and pledges",
  exit: "withdrawals",
};

/** Actions that also wait out the liquidation grace after an unpause. */
const GRACED: ReadonlySet<AppAction> = new Set(["liquidate_tokens", "liquidate_cash", "write_off"]);

/** Seconds left in the liquidation grace (0 when none runs). */
export const graceLeft = (p: PauseState | undefined, nowSec: bigint): bigint =>
  p && nowSec < p.liquidationsResumeAtSec ? p.liquidationsResumeAtSec - nowSec : 0n;

/**
 * "Paused: trading", "Liquidations resume in 12:04", or undefined when the action may run. Checked in the contract's
 * order: each flag of the action, with the grace right after `liquidate` (Paused(liquidate) → LiquidationGrace →
 * Paused(trade) for a cash-out).
 */
export function pauseBlocker(action: AppAction, p: PauseState | undefined, nowSec: bigint): string | undefined {
  if (!p) return undefined;
  for (const flag of ACTION_FLAGS[action]) {
    if (p.paused.includes(flag)) return `Paused: ${FLAG_LABEL[flag]}`;
    if (flag === "liquidate" && GRACED.has(action)) {
      const left = graceLeft(p, nowSec);
      if (left > 0n) return `Liquidations resume in ${countdown(left)}`;
    }
  }
  return undefined;
}
