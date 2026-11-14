import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EventFormatError,
  multiverseEvents,
  multiverseItems,
  onlyOne,
  orderFills,
  parseEventLines,
  tierOf,
  type LiquidateEvent,
  type PledgedEvent,
} from "./events.ts";
import { multiverseEvents as outlayerMultiverseEvents } from "./outlayer.ts";

const line = (event: string, data: unknown[], version = "2.0.0", standard = "multiverse"): string =>
  `EVENT_JSON:${JSON.stringify({ standard, version, event, data })}`;

// A v1 liquidation (one item per line) and a v2 trade receipt: the owner LogScope writes one
// mt_mint, one mt_transfer, one mt_burn, then one multiverse line per event name with every item.
const V1_LIQUIDATE = line(
  "liquidate",
  [{ scenario_id: 1, account_id: "carl.t", liquidator_id: "leo.t", repaid: "446411128000000000000", shares: "1", pieces: ["wnear"], seized: ["226391747000000000000"], c_min: "1133134240000000000000", worst_world: 3 }],
  "1.0.0",
);
const V2_TRADE = [
  line("mt_mint", [{ owner_id: "alice.t", token_ids: ["5:usdc:2"], amounts: ["10"] }], "1.0.0", "nep245"),
  line("mt_transfer", [{ old_owner_id: "alice.t", new_owner_id: "app.t", token_ids: ["5:wnear:1"], amounts: ["5"] }], "1.0.0", "nep245"),
  line("swap", [
    { pool_id: 7, account_id: "alice.t", amount_in: "1", amount_out: "2" },
    { pool_id: 8, account_id: "alice.t", amount_in: "3", amount_out: "4" },
  ]),
  line("orders_filled", [
    { scenario_id: 5, taker: "alice.t", fills: [["11", "1000000000000000000000", "2450000000000000000000", "0"], ["12", "500", "1225", "100"]] },
    { scenario_id: 5, taker: "bob.t", fills: [["13", "7", "21", "0"]] },
  ]),
  line("supply", [{ scenario_id: 5, account_id: "alice.t", amount: "9", tier: "safe" }]),
];

describe("parseEventLines", () => {
  it("reads every NEP-297 line and skips the rest", () => {
    const events = parseEventLines(["plain log", "EVENT_JSON:{broken", ...V2_TRADE]);
    assert.deepEqual(events.map((e) => `${e.standard}/${e.version}/${e.event}/${e.data.length}`), [
      "nep245/1.0.0/mt_mint/1",
      "nep245/1.0.0/mt_transfer/1",
      "multiverse/2.0.0/swap/2",
      "multiverse/2.0.0/orders_filled/2",
      "multiverse/2.0.0/supply/1",
    ]);
  });
});

describe("multiverseItems", () => {
  it("flattens the items of grouped v2 lines", () => {
    assert.deepEqual(multiverseItems<{ pool_id: number }>(V2_TRADE, "swap").map((s) => s.pool_id), [7, 8]);
  });

  it("reads v1 lines the same way", () => {
    const ev = onlyOne(multiverseItems<LiquidateEvent>([V1_LIQUIDATE], "liquidate"), "liquidate");
    assert.equal(ev.repaid, "446411128000000000000");
    assert.equal(tierOf(ev), "normal");
  });

  it("ignores other standards with the same event name", () => {
    assert.deepEqual(multiverseItems([line("supply", [{ x: 1 }], "1.0.0", "other")], "supply"), []);
  });

  it("refuses a multiverse version it does not know", () => {
    assert.throws(() => multiverseItems([line("supply", [{}], "3.0.0")], "supply"), (e: unknown) => e instanceof EventFormatError && /version "3\.0\.0"/.test(e.message));
  });

  it("reads an absent tier as Normal and a present one as given", () => {
    assert.equal(tierOf(onlyOne(multiverseItems<{ tier?: "safe" }>(V2_TRADE, "supply"), "supply")), "safe");
    assert.equal(tierOf({}), "normal");
  });

  it("outlayer.ts re-exports the same reader", () => {
    assert.equal(outlayerMultiverseEvents, multiverseEvents);
    const pledged = line("pledged", [{ proposal_id: 12, account_id: "leo.t", asset: "usdc", amount: "5", escrow_wnear: "0", escrow_usdc: "5" }]);
    assert.equal((onlyOne(multiverseEvents([pledged], "pledged"), "pledged") as PledgedEvent).proposal_id, 12);
  });
});

describe("orderFills", () => {
  it("reads v2 orders_filled groups and direct order_filled lines in log order", () => {
    const direct = line("order_filled", [{ order_id: "14", scenario_id: 5, taker: "sam.t", amount: "1000", usdc_amount: "3750", remaining: "0" }]);
    const v1direct = line("order_filled", [{ order_id: "3", scenario_id: 1, taker: "sam.t", amount: "1", usdc_amount: "2", remaining: "4" }], "1.0.0");
    const fills = orderFills([v1direct, ...V2_TRADE, direct]);
    assert.deepEqual(
      fills.map((f) => [f.scenarioId, f.taker, f.orderId, f.amount, f.usdcAmount, f.remaining]),
      [
        [1, "sam.t", "3", 1n, 2n, 4n],
        [5, "alice.t", "11", 1000000000000000000000n, 2450000000000000000000n, 0n],
        [5, "alice.t", "12", 500n, 1225n, 100n],
        [5, "bob.t", "13", 7n, 21n, 0n],
        [5, "sam.t", "14", 1000n, 3750n, 0n],
      ],
    );
  });

  it("refuses a malformed fill amount", () => {
    assert.throws(() => orderFills([line("orders_filled", [{ scenario_id: 5, taker: "a", fills: [["1", "x", "1", "0"]] }])]), /not a U128 string/);
  });
});

describe("onlyOne", () => {
  it("returns the one item or names how many there were", () => {
    assert.equal(onlyOne([7], "x"), 7);
    assert.throws(() => onlyOne([], "liquidate"), /expected one liquidate, found 0/);
    assert.throws(() => onlyOne([1, 2], "cash_out"), /expected one cash_out, found 2/);
  });
});
