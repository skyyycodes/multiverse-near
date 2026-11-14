import { describe, expect, it } from "vitest";
import type { PauseState } from "./domain";
import { ACTION_FLAGS, FLAG_LABEL, PAUSE_FLAGS, graceLeft, pauseBlocker, type AppAction, type PauseFlag } from "./pause";

/**
 * SPEC-contract 3.2, transcribed: what each flag stops, by contract method or msg. "to_lending" stands for a
 * conditional trade with `to_lending: true`, "cash" for the liquidation cash-out, "withdraw_collateral_debt" for a
 * collateral withdrawal while the account owes.
 */
const STOPS: Record<PauseFlag, readonly string[]> = {
  trade: ["swap", "conditional_sell", "conditional_buy", "spot_swap", "post_order", "fill_order", "move_spot_to", "sell_and_borrow", "cash"],
  mint: ["split", "register_verse", "create_event", "create_scenario", "create_within_pool", "create_between_pool", "create_spot_pool", "add_liquidity", "lp_deposit", "open_market", "auto_open"],
  transfer: ["mt_transfer", "mt_batch_transfer", "mt_transfer_call", "mt_batch_transfer_call", "lp_transfer"],
  lend: ["supply", "borrow", "sell_and_borrow", "to_lending", "withdraw_collateral_debt"],
  liquidate: ["liquidate", "write_off_bad_debt"],
  oracle: ["report_outcome", "finalize", "request_resolution", "request_reference", "report_reference"],
  pledge: ["propose_event", "propose_market", "pledge", "top_up_proposal"],
  exit: [
    "withdraw",
    "withdraw_supply",
    "withdraw_collateral",
    "cancel_order",
    "merge",
    "redeem",
    "close_after_resolution",
    "lp_withdraw",
    "remove_liquidity",
    "collect_fees",
    "storage_withdraw",
    "storage_unregister",
    "withdraw_pledge",
    "claim_unused",
    "seed_withdraw",
    "withdraw_insurance",
  ],
};

/** What each app action sends to the contract (web design 5.2), in the terms of the table above. */
const SENDS: Record<AppAction, readonly string[]> = {
  sell: ["conditional_sell"],
  sell_to_collateral: ["conditional_sell", "to_lending"],
  buy: ["conditional_buy"],
  post_order: ["post_order"],
  cancel_order: ["cancel_order"],
  split: ["split"],
  merge: ["merge"],
  redeem: ["redeem"],
  close: ["close_after_resolution"],
  borrow: ["borrow"],
  repay: ["repay"],
  add_collateral: ["deposit_collateral"],
  withdraw_collateral: ["withdraw_collateral"],
  withdraw_collateral_debt: ["withdraw_collateral_debt"],
  supply: ["supply"],
  withdraw_supply: ["withdraw_supply"],
  lp_deposit: ["lp_deposit"],
  lp_withdraw: ["lp_withdraw"],
  withdraw_inner: ["withdraw"],
  liquidate_tokens: ["liquidate"],
  liquidate_cash: ["liquidate", "cash"],
  write_off: ["write_off_bad_debt"],
  fund_insurance: ["fund_insurance"],
  propose: ["propose_event", "propose_market"],
  pledge: ["pledge"],
  withdraw_pledge: ["withdraw_pledge"],
  claim_unused: ["claim_unused"],
  seed_withdraw: ["seed_withdraw"],
  open_market: ["open_market"],
  cancel_proposal: ["cancel_proposal"],
  top_up_proposal: ["top_up_proposal"],
  approve: ["approve_proposal"],
  reject: ["reject_proposal"],
  listing: ["set_market_listing"],
  finalize: ["finalize"],
  admin_resolve: ["admin_resolve"],
  dispute: ["dispute"],
  request_resolution: ["request_resolution"],
  request_reference: ["request_reference"],
  price_push: ["conditional_sell"],
  register: ["storage_deposit"],
  storage_top_up: ["storage_deposit"],
  storage_withdraw: ["storage_withdraw"],
  faucet: ["mint (token contract)"],
  pause: ["pause"],
  unpause: ["unpause"],
};

/** SPEC-contract 3.2 "Never paused", for the app actions that send them. */
const NEVER: readonly AppAction[] = ["repay", "add_collateral", "fund_insurance", "register", "storage_top_up", "dispute", "admin_resolve", "approve", "reject", "listing", "cancel_proposal", "pause", "unpause", "faucet"];

const state = (paused: PauseFlag[], resumeAt = 0n): PauseState => ({ paused, sinceSec: 100n, liquidationsResumeAtSec: resumeAt, guardianId: null, pendingOwnerId: null });
const ACTIONS = Object.keys(ACTION_FLAGS) as AppAction[];

describe("the pause mapping (WI-3)", () => {
  it("equals the SPEC 3.2 table for every action", () => {
    expect(Object.keys(SENDS).sort()).toEqual([...ACTIONS].sort());
    for (const action of ACTIONS) {
      const expected = PAUSE_FLAGS.filter((f) => STOPS[f].some((m) => SENDS[action].includes(m)));
      expect([...ACTION_FLAGS[action]].sort(), action).toEqual([...expected].sort());
    }
  });

  it("never blocks a never-paused action, whatever is paused", () => {
    for (const action of NEVER) {
      expect(ACTION_FLAGS[action], action).toEqual([]);
      expect(pauseBlocker(action, state([...PAUSE_FLAGS], 10_000n), 0n), action).toBeUndefined();
    }
  });

  it("blocks each action by exactly its flags, naming the flag", () => {
    for (const action of ACTIONS) {
      for (const flag of PAUSE_FLAGS) {
        const blocked = pauseBlocker(action, state([flag]), 0n);
        if (ACTION_FLAGS[action].includes(flag)) expect(blocked, `${action} × ${flag}`).toBe(`Paused: ${FLAG_LABEL[flag]}`);
        else expect(blocked, `${action} × ${flag}`).toBeUndefined();
      }
    }
    expect(pauseBlocker("sell", state(["trade", "lend"]), 0n)).toBe("Paused: trading");
    expect(pauseBlocker("borrow", state(["trade", "lend"]), 0n)).toBe("Paused: lending");
    expect(pauseBlocker("repay", state(["trade", "lend"]), 0n)).toBeUndefined();
    expect(pauseBlocker("sell", undefined, 0n)).toBeUndefined();
  });

  it("holds liquidations through the grace, with a countdown, and nothing else", () => {
    const p = state([], 1_000n);
    expect(graceLeft(p, 276n)).toBe(724n);
    expect(pauseBlocker("liquidate_cash", p, 276n)).toBe("Liquidations resume in 12:04");
    expect(pauseBlocker("liquidate_tokens", p, 999n)).toBe("Liquidations resume in 0:01");
    expect(pauseBlocker("write_off", p, 0n)).toBe("Liquidations resume in 16:40");
    expect(pauseBlocker("liquidate_cash", p, 1_000n)).toBeUndefined();
    expect(pauseBlocker("borrow", p, 0n)).toBeUndefined();
    // the contract's order: Paused(liquidate), then the grace, then Paused(trade) for a cash-out
    expect(pauseBlocker("liquidate_cash", state(["trade"], 1_000n), 0n)).toBe("Liquidations resume in 16:40");
    expect(pauseBlocker("liquidate_cash", state(["trade"]), 0n)).toBe("Paused: trading");
    expect(pauseBlocker("liquidate_cash", state(["liquidate", "trade"], 1_000n), 0n)).toBe("Paused: liquidations");
  });
});
