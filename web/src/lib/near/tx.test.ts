import { describe, expect, it } from "vitest";
import type { Order, WorldPlan } from "../orders";
import {
  acceptAsk,
  approveProposal,
  borrow,
  call,
  canonicalEvents,
  cancelProposal,
  claimUnused,
  closeAfterResolution,
  closeWithDebt,
  depositCollateral,
  ftTransferCall,
  fundInsurance,
  GAS_CALL,
  GAS_FT_CALL,
  GAS_LIGHT,
  liquidate,
  merge,
  ONE_YOCTO,
  openMarket,
  pauseTx,
  planFills,
  planMinOut,
  pledge,
  proposeEvent,
  proposeMarket,
  rejectProposal,
  repay,
  requestReference,
  requestResolution,
  seedWithdraw,
  sellFromInner,
  sellFromWallet,
  setMarketListing,
  singleOrderPlan,
  split,
  storageDeposit,
  supply,
  topUpDeposit,
  topUpProposal,
  unpauseTx,
  withdrawPledge,
  withdrawSupply,
  withTier,
  writeOffBadDebt,
  type Tx,
} from "./tx";

const E18 = 10n ** 18n;

describe("transactions the wallet signs", () => {
  it("sends real tokens with ft_transfer_call: token units outside, a JSON action inside, 1 yocto", () => {
    const tx = ftTransferCall("wnear.multiverse-lending.testnet", "app.multiverse-lending.testnet", 2n * E18, {
      action: "conditional_sell",
      scenario_id: 1,
      sell_mask: 14,
      plans: [[], [], [], [{ order_id: "1", amount: E18.toString() }]],
      min_out: ["0", "1", "2", "3"],
      to_lending: true,
    });
    expect(tx.receiverId).toBe("wnear.multiverse-lending.testnet");
    const p = tx.actions[0].params;
    expect(p.methodName).toBe("ft_transfer_call");
    expect(p.deposit).toBe(ONE_YOCTO);
    expect(p.gas).toBe(GAS_FT_CALL);
    expect(p.args.receiver_id).toBe("app.multiverse-lending.testnet");
    expect(p.args.amount).toBe("2000000000000000000");
    expect(typeof p.args.msg).toBe("string");
    expect(JSON.parse(p.args.msg as string)).toEqual({
      action: "conditional_sell",
      scenario_id: 1,
      sell_mask: 14,
      plans: [[], [], [], [{ order_id: "1", amount: "1000000000000000000" }]],
      min_out: ["0", "1", "2", "3"],
      to_lending: true,
    });
  });

  it("turns plans into per-world fills and minimums, discounting only the pool part", () => {
    const order = { id: 7n, price: 2450n * E18 } as Order;
    const plan: WorldPlan = { fills: [{ order, amount: E18, out: 2450n * E18 }], poolAmount: E18, poolOut: 2431n * E18, total: 4881n * E18 };
    expect(planFills([undefined, plan])).toEqual([[], [{ order_id: "7", amount: "1000000000000000000" }]]);
    expect(planMinOut([undefined, plan])).toEqual(["0", (4881n * E18 - (2431n * E18 * 50n) / 10_000n).toString()]);
  });

  it("builds one-order plans for accepting a bid or an ask", () => {
    expect(singleOrderPlan(4, 2, 9n, 5n, 3n)).toEqual({
      plans: [[], [], [{ order_id: "9", amount: "5" }], []],
      min_out: ["0", "0", "3", "0"],
    });
  });

  it("registers storage with an attached deposit and calls methods with 1 yocto by default", () => {
    const s = storageDeposit("app.multiverse-lending.testnet", 10n ** 23n, false);
    expect(s.actions[0].params).toMatchObject({ methodName: "storage_deposit", deposit: "100000000000000000000000", args: { account_id: null, registration_only: false } });
    expect(call("x", "borrow", { scenario_id: 1, amount: "1" }).actions[0].params.deposit).toBe("1");
    expect(call("x", "finalize", { event_id: 2 }, "0").actions[0].params.deposit).toBe("0");
  });
});

const APP = "app.ifverse-staging.testnet";
const WNEAR = "wnear.ifverse-staging.testnet";
const USDC = "usdc.ifverse-staging.testnet";
const NEAR = 10n ** 24n;

/** The one function call of `tx`, with its msg parsed when it is an ft_transfer_call. */
function one(tx: Tx) {
  expect(tx.actions).toHaveLength(1);
  const p = tx.actions[0].params;
  return { receiver: tx.receiverId, method: p.methodName, args: p.args, gas: p.gas, deposit: p.deposit, msg: typeof p.args.msg === "string" ? (p.args.msg as string) : undefined };
}

describe("tiers in msgs and calls (WI-5)", () => {
  it("withTier sends Safe and Bold by name and Normal by omission", () => {
    expect(withTier({ scenario_id: 5 }, "safe")).toEqual({ scenario_id: 5, tier: "safe" });
    expect(withTier({ scenario_id: 5 }, "bold")).toEqual({ scenario_id: 5, tier: "bold" });
    expect(withTier({ scenario_id: 5 }, "normal")).toEqual({ scenario_id: 5 });
    expect(withTier({ scenario_id: 5 }, undefined)).toEqual({ scenario_id: 5 });
  });

  it("T1: a sale kept as collateral names its tier last; a sale that keeps nothing never names one", () => {
    const plans = [[], [], [], [{ order_id: "4", amount: "1000000000000000000000" }]];
    const t = one(sellFromWallet(WNEAR, APP, 2_000n * NEAR, { scenarioId: 5, sellMask: 14, plans, minOut: ["0", "1", "2", "3"], toLending: true, tier: "safe" }));
    expect(t).toMatchObject({ receiver: WNEAR, method: "ft_transfer_call", deposit: "1", gas: GAS_FT_CALL });
    expect(t.args).toMatchObject({ receiver_id: APP, amount: (2_000n * NEAR).toString(), memo: null });
    expect(t.msg).toBe(
      '{"action":"conditional_sell","scenario_id":5,"sell_mask":14,"plans":[[],[],[],[{"order_id":"4","amount":"1000000000000000000000"}]],"min_out":["0","1","2","3"],"to_lending":true,"tier":"safe"}',
    );
    const normal = one(sellFromWallet(WNEAR, APP, 1n, { scenarioId: 5, sellMask: 14, plans: [[], [], [], []], minOut: ["0", "0", "0", "0"], toLending: true, tier: "normal" }));
    expect(normal.msg).toBe('{"action":"conditional_sell","scenario_id":5,"sell_mask":14,"plans":[[],[],[],[]],"min_out":["0","0","0","0"],"to_lending":true}');
    const noLending = one(sellFromWallet(WNEAR, APP, 1n, { scenarioId: 5, sellMask: 2, plans: [[], []], minOut: ["0", "1"], toLending: false, tier: "bold" }));
    expect(JSON.parse(noLending.msg!)).not.toHaveProperty("tier");
  });

  it("T2 and T4: the inner-balance sale and an accepted ask", () => {
    const t2 = one(sellFromInner(APP, { scenarioId: 5, amount: 10n, sellMask: 1, plans: [[], []], minOut: ["9", "0"], toLending: true, tier: "bold" }));
    expect(t2).toMatchObject({ receiver: APP, method: "conditional_sell", deposit: "1", gas: GAS_FT_CALL });
    expect(t2.args).toEqual({ scenario_id: 5, amount: "10", sell_mask: 1, plans: [[], []], min_out: ["9", "0"], to_lending: true, tier: "bold" });
    const t4 = one(acceptAsk(USDC, APP, 1_875_000_000n, { scenarioId: 1, buyMask: 1, plans: [[{ order_id: "2", amount: "500" }], []], minOut: ["500", "0"] }));
    expect(JSON.parse(t4.msg!)).toEqual({ action: "conditional_buy", scenario_id: 1, buy_mask: 1, plans: [[{ order_id: "2", amount: "500" }], []], min_out: ["500", "0"], to_lending: false });
  });
});

describe("lending transactions", () => {
  it("T8 borrow: 1 yocto, 150 Tgas, tier by name", () => {
    const t = one(borrow(APP, { scenarioId: 5, amount: 2_985n * 10n ** 18n, tier: "safe" }));
    expect(t).toEqual({ receiver: APP, method: "borrow", args: { scenario_id: 5, amount: "2985000000000000000000", tier: "safe" }, gas: GAS_CALL, deposit: "1", msg: undefined });
    expect(one(borrow(APP, { scenarioId: 1, amount: 100n })).args).toEqual({ scenario_id: 1, amount: "100" });
  });

  it("T9 repay, T10 supply, T11 withdraw supply", () => {
    expect(one(repay(USDC, APP, 3_003_000_000n, { scenarioId: 5, all: true, tier: "bold" })).msg).toBe('{"action":"repay","scenario_id":5,"all":true,"tier":"bold"}');
    expect(one(repay(USDC, APP, 1n, { scenarioId: 5, all: false })).msg).toBe('{"action":"repay","scenario_id":5,"all":false}');
    const t10 = one(supply(USDC, APP, 5_000_000_000n, { scenarioId: 5, tier: "safe" }));
    expect(t10).toMatchObject({ receiver: USDC, method: "ft_transfer_call", gas: GAS_FT_CALL, deposit: "1", msg: '{"action":"supply","scenario_id":5,"tier":"safe"}' });
    expect(t10.args.amount).toBe("5000000000");
    expect(one(withdrawSupply(APP, { scenarioId: 5, amount: null, tier: "bold" }))).toMatchObject({
      method: "withdraw_supply",
      args: { scenario_id: 5, amount: null, tier: "bold" },
      gas: GAS_CALL,
      deposit: "1",
    });
    expect(one(withdrawSupply(APP, { scenarioId: 5, amount: 7n })).args).toEqual({ scenario_id: 5, amount: "7" });
  });

  it("T15 and T16: close per tier", () => {
    expect(one(closeWithDebt(USDC, APP, 1n, { scenarioId: 5, tier: "bold" })).msg).toBe('{"action":"close_after_resolution","scenario_id":5,"tier":"bold"}');
    expect(one(closeAfterResolution(APP, { scenarioId: 5, tier: "bold" }))).toMatchObject({ method: "close_after_resolution", args: { scenario_id: 5, tier: "bold" }, gas: GAS_CALL, deposit: "1" });
    expect(one(closeAfterResolution(APP, { scenarioId: 5 })).args).toEqual({ scenario_id: 5 });
  });

  it("T38 liquidate: cash mode carries min_out, tokens mode never does", () => {
    const cash = one(
      liquidate(USDC, APP, 446_857_540n, { scenarioId: 1, accountId: "carl.multiverse-near.testnet", repayAmount: "max", receive: "cash", minOut: 460_329_761_843_022_353_409n }),
    );
    expect(cash).toMatchObject({ receiver: USDC, method: "ft_transfer_call", gas: GAS_FT_CALL, deposit: "1" });
    expect(cash.args.amount).toBe("446857540");
    expect(cash.msg).toBe(
      '{"action":"liquidate","scenario_id":1,"account_id":"carl.multiverse-near.testnet","repay_amount":"max","receive":"cash","min_out":"460329761843022353409"}',
    );
    const bold = one(liquidate(USDC, APP, 1n, { scenarioId: 5, accountId: "x.testnet", repayAmount: 446n, tier: "bold", receive: "cash", minOut: 1n }));
    expect(bold.msg).toBe('{"action":"liquidate","scenario_id":5,"account_id":"x.testnet","repay_amount":"446","tier":"bold","receive":"cash","min_out":"1"}');
    const tokens = one(liquidate(USDC, APP, 1n, { scenarioId: 5, accountId: "x.testnet", repayAmount: "max", tier: "safe", receive: "tokens" }));
    expect(tokens.msg).toBe('{"action":"liquidate","scenario_id":5,"account_id":"x.testnet","repay_amount":"max","tier":"safe"}');
    expect(() => liquidate(USDC, APP, 1n, { scenarioId: 5, accountId: "x", repayAmount: "max", receive: "cash" })).toThrow(/needs min_out/);
    expect(() => liquidate(USDC, APP, 1n, { scenarioId: 5, accountId: "x", repayAmount: "max", receive: "tokens", minOut: 1n })).toThrow(/never sends min_out/);
  });

  it("T39 write-off, T40 insurance, T41 collateral", () => {
    expect(one(writeOffBadDebt(APP, { scenarioId: 5, accountId: "x.testnet", tier: "bold" }))).toMatchObject({
      method: "write_off_bad_debt",
      args: { scenario_id: 5, account_id: "x.testnet", tier: "bold" },
      gas: GAS_CALL,
      deposit: "1",
    });
    expect(one(fundInsurance(USDC, APP, 100_000_000n, { scenarioId: 5, tier: "bold" })).msg).toBe('{"action":"fund_insurance","scenario_id":5,"tier":"bold"}');
    expect(one(depositCollateral(WNEAR, APP, NEAR, { scenarioId: 5, tier: "safe" }))).toMatchObject({
      receiver: WNEAR,
      msg: '{"action":"deposit_collateral","scenario_id":5,"tier":"safe"}',
    });
  });
});

describe("markets, proposals and pledges", () => {
  it("T27 propose a combination: canonical ids, bond + reserve attached, 300 Tgas", () => {
    expect(canonicalEvents([8, 7, 8])).toEqual([7, 8]);
    const t = one(proposeMarket(APP, [8, 7], 200_000_000_000_000_000_000_000n));
    expect(t).toEqual({ receiver: APP, method: "propose_market", args: { event_ids: [7, 8] }, gas: GAS_FT_CALL, deposit: "200000000000000000000000", msg: undefined });
  });

  it("T28 propose a new event, args in the contract's order", () => {
    const t = one(
      proposeEvent(
        APP,
        {
          question: "Will NEAR mainnet process 1B transactions by 2027-06-30?",
          outcomeNames: ["YES", "NO"],
          rule: "YES if …",
          source: "https://nearblocks.io/charts/txns",
          deadlineSec: 1_814_313_599,
          category: 1,
          terms: { odds0Bps: 4_000, multBps: [11_500, 9_000] },
        },
        300_000_000_000_000_000_000_000n,
      ),
    );
    expect(t.deposit).toBe("300000000000000000000000");
    expect(t.gas).toBe(GAS_FT_CALL);
    expect(JSON.stringify(t.args)).toBe(
      '{"question":"Will NEAR mainnet process 1B transactions by 2027-06-30?","outcome_names":["YES","NO"],"rule":"YES if …","source":"https://nearblocks.io/charts/txns","deadline_sec":1814313599,"category":1,"terms":{"odds0_bps":4000,"mult_bps":[11500,9000]}}',
    );
  });

  it("T29-T37", () => {
    const t29 = one(pledge(USDC, APP, 1_000_000_000n, 12));
    expect(t29).toMatchObject({ receiver: USDC, method: "ft_transfer_call", gas: GAS_FT_CALL, deposit: "1", msg: '{"action":"pledge","proposal_id":12}' });
    expect(one(withdrawPledge(APP, 12))).toMatchObject({ method: "withdraw_pledge", args: { proposal_id: 12, wnear: null, usdc: null }, gas: GAS_CALL, deposit: "1" });
    expect(one(withdrawPledge(APP, 12, { wnear: 0n, usdc: 250n * 10n ** 18n })).args).toEqual({ proposal_id: 12, wnear: "0", usdc: "250000000000000000000" });
    expect(one(claimUnused(APP, 12))).toMatchObject({ method: "claim_unused", args: { proposal_id: 12 }, gas: GAS_CALL, deposit: "1" });
    expect(one(seedWithdraw(APP, { proposalId: 12, shares: null, minWnearOut: [1n, 0n], minUsdcOut: [2n, 0n] }))).toMatchObject({
      method: "seed_withdraw",
      args: { proposal_id: 12, shares: null, min_wnear_out: ["1", "0"], min_usdc_out: ["2", "0"] },
      gas: GAS_FT_CALL,
      deposit: "1",
    });
    expect(one(openMarket(APP, 12))).toMatchObject({ method: "open_market", args: { proposal_id: 12 }, gas: GAS_FT_CALL, deposit: "0" });
    expect(one(cancelProposal(APP, 12))).toMatchObject({ method: "cancel_proposal", args: { proposal_id: 12 }, gas: GAS_CALL, deposit: "1" });
    expect(topUpDeposit(100n, 40n)).toBe(66n);
    expect(topUpDeposit(101n, 1n)).toBe(110n);
    expect(topUpDeposit(5n, 9n)).toBe(0n);
    expect(one(topUpProposal(APP, 12, 10n ** 23n, 0n))).toMatchObject({ method: "top_up_proposal", gas: GAS_LIGHT, deposit: "110000000000000000000000" });
    expect(one(approveProposal(APP, 12, null))).toMatchObject({ method: "approve_proposal", args: { proposal_id: 12, terms: null }, gas: GAS_FT_CALL, deposit: "1" });
    expect(one(approveProposal(APP, 12, { odds0Bps: 3_500, multBps: [12_000, 9_000] })).args).toEqual({ proposal_id: 12, terms: { odds0_bps: 3_500, mult_bps: [12_000, 9_000] } });
    expect(one(rejectProposal(APP, 12, true))).toMatchObject({ method: "reject_proposal", args: { proposal_id: 12, forfeit_bond: true }, gas: GAS_CALL, deposit: "1" });
  });
});

describe("resolution, split and operations", () => {
  it("T42 and T43 attach the guest's deposit and the full 300 Tgas", () => {
    expect(one(requestReference(APP, 5_000_000_000_000_000_000_000n))).toMatchObject({ method: "request_reference", args: {}, gas: GAS_FT_CALL, deposit: "5000000000000000000000" });
    expect(one(requestResolution(APP, 9, 5_000_000_000_000_000_000_000n))).toMatchObject({ method: "request_resolution", args: { event_id: 9 }, gas: GAS_FT_CALL });
  });

  it("T44 split and T45 merge", () => {
    expect(one(split(USDC, APP, 1_000_000n, { scenarioId: 5, toMasks: [1, 2, 4, 8] })).msg).toBe('{"action":"split","scenario_id":5,"to_masks":[1,2,4,8]}');
    expect(one(merge(APP, { scenarioId: 5, asset: "wnear", fromMasks: [1, 2, 4, 8], toMask: 15, amount: 3n }))).toMatchObject({
      method: "merge",
      args: { scenario_id: 5, asset: "wnear", from_masks: [1, 2, 4, 8], to_mask: 15, amount: "3" },
      gas: GAS_CALL,
      deposit: "1",
    });
  });

  it("T46 pause, T47 unpause, T48 listing", () => {
    expect(one(pauseTx(APP, ["trade", "lend"], "investigating a price feed"))).toEqual({
      receiver: APP,
      method: "pause",
      args: { flags: ["trade", "lend"], reason: "investigating a price feed" },
      gas: GAS_LIGHT,
      deposit: "0",
      msg: undefined,
    });
    expect(one(unpauseTx(APP, ["trade", "lend", "liquidate"], 1_800))).toMatchObject({
      method: "unpause",
      args: { flags: ["trade", "lend", "liquidate"], liquidation_grace_sec: 1_800 },
      gas: GAS_LIGHT,
      deposit: "1",
    });
    expect(one(unpauseTx(APP, ["oracle"])).args).toEqual({ flags: ["oracle"], liquidation_grace_sec: null });
    expect(one(setMarketListing(APP, 5, true))).toMatchObject({ method: "set_market_listing", args: { scenario_id: 5, listed: true }, gas: GAS_LIGHT, deposit: "1" });
  });
});
