import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { encodeMsg, msgFlags, MsgCheckError, tierField, V2OnlyOnV1Contract, withTier, type Msg } from "./msgs.ts";

// The msgs the v1 app sends, copied from contracts/multiverse/src/tests/receiver.rs (DESIGN_MESSAGES).
const V1 = JSON.parse(readFileSync(new URL("./fixtures/msgs/v1.json", import.meta.url), "utf8")) as { messages: { action: string; msg: string }[] };

describe("encodeMsg: v1 messages", () => {
  it("has all eleven v1 messages", () => {
    assert.equal(V1.messages.length, 11);
  });
  for (const { action, msg } of V1.messages) {
    it(`${action} encodes byte for byte, on v1 and on v2`, () => {
      const m = JSON.parse(msg) as Msg;
      assert.equal(encodeMsg(m, 1), msg);
      assert.equal(encodeMsg(m, 2), msg);
    });
  }

  it("writes fields in the declared order whatever order the caller used", () => {
    const m = { min_out: ["0"], action: "spot_swap" } as unknown as Msg;
    assert.equal(encodeMsg({ ...(m as object), min_out: "5" } as Msg, 1), '{"action":"spot_swap","min_out":"5"}');
    const split = { to_masks: [5, 10], scenario_id: 1, action: "split" } as unknown as Msg;
    assert.equal(encodeMsg(split, 1), '{"action":"split","scenario_id":1,"to_masks":[5,10]}');
  });

  it("a deposit is the empty msg", () => {
    assert.equal(encodeMsg({ action: "deposit" }, 1), "");
  });
});

describe("encodeMsg: tiers", () => {
  it("omits the Normal tier so the bytes stay v1's", () => {
    assert.equal(encodeMsg({ action: "supply", scenario_id: 5, tier: "normal" }, 2), '{"action":"supply","scenario_id":5}');
    assert.equal(encodeMsg({ action: "repay", scenario_id: 5, all: true, tier: "normal" }, 1), '{"action":"repay","scenario_id":5,"all":true}');
  });

  it("writes Safe and Bold after the v1 fields", () => {
    assert.equal(encodeMsg({ action: "supply", scenario_id: 5, tier: "safe" }, 2), '{"action":"supply","scenario_id":5,"tier":"safe"}');
    assert.equal(encodeMsg({ action: "repay", scenario_id: 5, all: true, tier: "bold" }, 2), '{"action":"repay","scenario_id":5,"all":true,"tier":"bold"}');
    assert.equal(
      encodeMsg({ action: "sell_and_borrow", scenario_id: 5, sell_mask: 15, plans: [], min_out: [], borrow_amount: "150000000000000000000", tier: "safe" }, 2),
      '{"action":"sell_and_borrow","scenario_id":5,"sell_mask":15,"plans":[],"min_out":[],"borrow_amount":"150000000000000000000","tier":"safe"}',
    );
  });

  it("drops the tier of a trade that does not go to lending (the contract ignores it)", () => {
    assert.equal(
      encodeMsg({ action: "conditional_buy", scenario_id: 1, buy_mask: 1, plans: [[]], min_out: ["0"], to_lending: false, tier: "bold" }, 1),
      '{"action":"conditional_buy","scenario_id":1,"buy_mask":1,"plans":[[]],"min_out":["0"],"to_lending":false}',
    );
    assert.equal(
      encodeMsg({ action: "conditional_sell", scenario_id: 1, sell_mask: 2, plans: [[]], min_out: ["0"], to_lending: true, tier: "bold" }, 2),
      '{"action":"conditional_sell","scenario_id":1,"sell_mask":2,"plans":[[]],"min_out":["0"],"to_lending":true,"tier":"bold"}',
    );
  });

  it("call arguments get the tier the same way", () => {
    assert.deepEqual(withTier({ scenario_id: 1, amount: "5" }, "normal", 1), { scenario_id: 1, amount: "5" });
    assert.deepEqual(withTier({ scenario_id: 1 }, "bold", 2), { scenario_id: 1, tier: "bold" });
    assert.deepEqual(tierField(undefined, 1), {});
  });
});

describe("encodeMsg: liquidation modes", () => {
  const base = { action: "liquidate", scenario_id: 1, account_id: "carl.multiverse-near.testnet", repay_amount: "max" } as const;

  it("matches SPEC-C 3.8's cash example byte for byte", () => {
    assert.equal(
      encodeMsg({ ...base, tier: "bold", receive: "cash", min_out: "455000000000000000000" }, 2),
      '{"action":"liquidate","scenario_id":1,"account_id":"carl.multiverse-near.testnet","repay_amount":"max","tier":"bold","receive":"cash","min_out":"455000000000000000000"}',
    );
  });

  it("omits tokens mode (the default)", () => {
    assert.equal(
      encodeMsg({ ...base, receive: "tokens" }, 2),
      '{"action":"liquidate","scenario_id":1,"account_id":"carl.multiverse-near.testnet","repay_amount":"max"}',
    );
  });

  it("refuses cash without min_out (MinOutRequired)", () => {
    assert.throws(() => encodeMsg({ ...base, receive: "cash" }, 2), (e: unknown) => e instanceof MsgCheckError && e.message === "MinOutRequired");
  });

  it("refuses min_out without cash (MinOutWithoutCash)", () => {
    assert.throws(() => encodeMsg({ ...base, min_out: "1" }, 2), (e: unknown) => e instanceof MsgCheckError && e.message === "MinOutWithoutCash");
    assert.throws(() => encodeMsg({ ...base, receive: "tokens", min_out: "1" }, 2), /MinOutWithoutCash/);
  });

  it("checks the repay amount", () => {
    assert.match(encodeMsg({ ...base, repay_amount: "446411128000000000000" }, 1), /"repay_amount":"446411128000000000000"/);
    assert.throws(() => encodeMsg({ ...base, repay_amount: "1.5" }, 1), /BadMsg\(repay_amount is not a U128 string/);
  });
});

describe("encodeMsg: the version guard (S-2)", () => {
  const v1Only: [string, Msg][] = [
    ["tier safe", { action: "supply", scenario_id: 5, tier: "safe" }],
    ["tier bold", { action: "close_after_resolution", scenario_id: 5, tier: "bold" }],
    ["receive cash", { action: "liquidate", scenario_id: 1, account_id: "a.testnet", repay_amount: "max", receive: "cash", min_out: "1" }],
    ["fund_insurance", { action: "fund_insurance", scenario_id: 5 }],
    ["pledge", { action: "pledge", proposal_id: 12 }],
  ];
  for (const [what, m] of v1Only) {
    it(`refuses ${what} at state version 1`, () => {
      assert.throws(() => encodeMsg(m, 1), (e: unknown) => e instanceof V2OnlyOnV1Contract && e.message.startsWith("V2OnlyOnV1Contract("));
    });
  }

  it("sends the v2 actions to a v2 contract", () => {
    assert.equal(encodeMsg({ action: "fund_insurance", scenario_id: 5, tier: "bold" }, 2), '{"action":"fund_insurance","scenario_id":5,"tier":"bold"}');
    assert.equal(encodeMsg({ action: "pledge", proposal_id: 12 }, 2), '{"action":"pledge","proposal_id":12}');
  });

  it("refuses malformed fields before anything is sent", () => {
    assert.throws(() => encodeMsg({ action: "split", scenario_id: 1, to_masks: [256] }, 1), /to_masks\[0\] is not a u8 mask/);
    assert.throws(() => encodeMsg({ action: "supply", scenario_id: -1 }, 1), /scenario_id is not a u64/);
    assert.throws(() => encodeMsg({ action: "supply", scenario_id: 1, tier: "gold" as never }, 2), /unknown tier "gold"/);
    assert.throws(() => encodeMsg({ action: "spot_swap", min_out: (1n << 128n).toString() }, 1), /min_out is not a U128 string/);
  });
});

describe("msgFlags", () => {
  it("names the pause flags each msg needs (SPEC-C 3.2)", () => {
    assert.deepEqual(msgFlags({ action: "repay", scenario_id: 1, all: true }), []);
    assert.deepEqual(msgFlags({ action: "fund_insurance", scenario_id: 1 }), []);
    assert.deepEqual(msgFlags({ action: "split", scenario_id: 1, to_masks: [1, 2] }), ["mint"]);
    assert.deepEqual(msgFlags({ action: "conditional_sell", scenario_id: 1, sell_mask: 1, plans: [], min_out: [], to_lending: true }), ["trade", "lend"]);
    assert.deepEqual(msgFlags({ action: "liquidate", scenario_id: 1, account_id: "a", repay_amount: "max", receive: "cash", min_out: "1" }), ["liquidate", "trade"]);
    assert.deepEqual(msgFlags({ action: "close_after_resolution", scenario_id: 1 }), ["exit"]);
    assert.deepEqual(msgFlags({ action: "pledge", proposal_id: 1 }), ["pledge"]);
  });
});
