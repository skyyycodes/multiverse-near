import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { orderCost } from "./demo.ts";
import {
  borrowRateOf,
  checkBacking,
  checkBorrowerIndex,
  checkBorrowerList,
  checkHfNotLowered,
  checkLiquidation,
  checkMarket,
  checkOrders,
  checkPledgeEscrow,
  checkStorage,
  checkVersion,
  judgeLiquidation,
  judgePledgeEscrow,
  utilizationOf,
} from "./invariants.ts";
import type { ChainReader } from "./protocol.ts";
import { WAD } from "./units.ts";

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/v2/${name}.json`, import.meta.url), "utf8"));
const e18 = (n: bigint): bigint => n * WAD;

type Handler = unknown | ((args: Record<string, unknown>) => unknown);

/** A ChainReader answering from a table: `method` or `method <json args>` (more specific wins). */
function fake(table: Record<string, Handler>, extra: Partial<ChainReader> = {}): ChainReader & { blocks: Set<number | "final"> } {
  const blocks = new Set<number | "final">();
  const answer = (method: string, args: Record<string, unknown>): unknown => {
    const exact = `${method} ${JSON.stringify(args)}`;
    const h = exact in table ? table[exact] : table[method];
    if (h === undefined) throw new Error(`unexpected view ${exact}`);
    return typeof h === "function" ? (h as (a: Record<string, unknown>) => unknown)(args) : h;
  };
  return {
    contract: "app.test.near",
    blocks,
    viewAt: async <T>(method: string, args: Record<string, unknown>, block: number | "final") => {
      blocks.add(block);
      return answer(method, args) as T;
    },
    tokenViewAt: async <T>(_a: unknown, method: string, args: Record<string, unknown>) => answer(`token.${method}`, args) as T,
    accountAt: async () => ({ amount: 0n, storageUsage: 0, codeHash: "Code1" }),
    blockTimeSec: async () => 1_794_620_000,
    decimals: (a) => (a === "wnear" ? 24 : 6),
    ...extra,
  };
}

describe("rate model mirrors (SPEC-C 3.6.2 and the 4.4 goldens)", () => {
  const cfg = {
    safe: { rate_base: "317097919", rate_slope1: "1268391679", rate_slope2: "14269406392", rate_kink: "800000000000000000" },
    normal: { rate_base: "634195839", rate_slope1: "1902587519", rate_slope2: "16489091831", rate_kink: "800000000000000000" },
    bold: { rate_base: "951293759", rate_slope1: "2853881278", rate_slope2: "19977168949", rate_kink: "800000000000000000" },
  };
  const golden: Record<keyof typeof cfg, bigint[]> = {
    safe: [317_097_919n, 1_109_842_718n, 1_585_489_598n, 8_720_192_794n, 15_854_895_990n],
    normal: [634_195_839n, 1_823_313_038n, 2_536_783_358n, 10_781_329_273n, 19_025_875_189n],
    bold: [951_293_759n, 2_734_969_557n, 3_805_175_037n, 13_793_759_511n, 23_782_343_986n],
  };
  const utils = [0n, WAD / 2n, (WAD * 8n) / 10n, (WAD * 9n) / 10n, WAD];
  for (const tier of ["safe", "normal", "bold"] as const) {
    it(`${tier}: 0%, 50%, 80%, 90%, 100%`, () => {
      assert.deepEqual(utils.map((u) => borrowRateOf(u, cfg[tier])), golden[tier]);
    });
  }

  it("utilization caps at 1 and is 0 without borrowing", () => {
    assert.equal(utilizationOf(0n, 0n), 0n);
    assert.equal(utilizationOf(e18(80_000n), e18(100_000n)), (WAD * 8n) / 10n);
    assert.equal(utilizationOf(e18(101n), e18(100n)), WAD);
    assert.equal(borrowRateOf(2n * WAD, cfg.normal), golden.normal[4]);
  });
});

describe("checkHfNotLowered (V-3, SPEC.md 3.8 11.2)", () => {
  const before = new Map<string, bigint | null>([["carl", 1_200_000_000_000_000_000n]]);

  it("passes an interest-only drop", () => {
    const after = new Map([["carl", 1_199_940_000_000_000_000n]]);
    const r = checkHfNotLowered(before, after, WAD, WAD, 7);
    assert.equal(r.length, 1);
    assert.equal(r[0]?.ok, true);
    assert.match(r[0]?.detail ?? "", /−0 bps/);
  });

  it("passes a drop explained by the reference factor", () => {
    const after = new Map([["carl", 1_080_000_000_000_000_000n]]);
    const r = checkHfNotLowered(before, after, WAD, (WAD * 9n) / 10n);
    assert.equal(r[0]?.ok, true);
  });

  it("fails an unexplained 0.2% drop", () => {
    const after = new Map([["carl", 1_197_600_000_000_000_000n]]);
    const r = checkHfNotLowered(before, after, WAD, WAD);
    assert.equal(r[0]?.ok, false);
    assert.match(r[0]?.detail ?? "", /−20 bps/);
  });

  it("does not let a rising factor excuse a drop", () => {
    const after = new Map([["carl", 1_197_600_000_000_000_000n]]);
    assert.equal(checkHfNotLowered(before, after, (WAD * 9n) / 10n, WAD)[0]?.ok, false);
  });

  it("has nothing to compare for no debt, no change or a rise", () => {
    const b = new Map<string, bigint | null>([["a", null], ["b", WAD], ["c", WAD], ["d", WAD]]);
    const a = new Map<string, bigint | null>([["a", WAD / 2n], ["b", null], ["c", 2n * WAD]]);
    assert.deepEqual(checkHfNotLowered(b, a, WAD, WAD), []);
  });
});

describe("pledge escrow (M-2)", () => {
  const pr = (id: number, status: string, w: bigint, u: bigint) => ({ proposal_id: id, status: status as "pledging", pledged_wnear: w.toString(), pledged_usdc: u.toString() });

  it("is exact without opened proposals", () => {
    const ps = [pr(1, "pledging", 5n, 10n), pr(2, "expired", 1n, 0n), pr(3, "review", 0n, 4n)];
    assert.equal(judgePledgeEscrow({ wnear: 6n, usdc: 14n }, ps, 1).ok, true);
    const off = judgePledgeEscrow({ wnear: 6n, usdc: 15n }, ps, 1);
    assert.equal(off.ok, false);
    assert.match(off.detail, /usdc: books 15 ≠ Σ escrow 14/);
  });

  it("bounds what opened proposals may still hold", () => {
    const ps = [pr(1, "pledging", 5n, 10n), pr(2, "opened", 100n, 200n)];
    assert.equal(judgePledgeEscrow({ wnear: 5n, usdc: 13n }, ps, 1).ok, true);
    assert.equal(judgePledgeEscrow({ wnear: 4n, usdc: 13n }, ps, 1).ok, false, "below the live pledges");
    assert.equal(judgePledgeEscrow({ wnear: 106n, usdc: 13n }, ps, 1).ok, false, "above live + opened");
  });

  it("reads books and every page of list_proposals at the block", async () => {
    const books = fx("books") as { wnear: Record<string, string>; usdc: Record<string, string> };
    const r = fake({
      books: { ...books, wnear: { ...books.wnear, pledges: "5" }, usdc: { ...books.usdc, pledges: "10" } },
      'list_proposals {"from_id":null,"limit":50,"filter":"all"}': { proposals: [{ ...(fx("get_proposal") as object), status: "pledging", pledged_wnear: "5", pledged_usdc: "4", preview: undefined }], next_from: 1 },
      'list_proposals {"from_id":1,"limit":50,"filter":"all"}': { proposals: [{ ...(fx("get_proposal") as object), proposal_id: 1, status: "expired", pledged_wnear: "0", pledged_usdc: "6" }], next_from: null },
    });
    const c = await checkPledgeEscrow(r, 99);
    assert.equal(c.ok, true, c.detail);
    assert.deepEqual([...r.blocks], [99]);
  });
});

describe("checkOrders (V-5)", () => {
  const scenario = { scenario_id: 5, event_ids: [1, 2], world_count: 4, root: 15, possible: 15, resolution_count: 0, halted: false, pool_ids: [] };
  const order = (o: Record<string, unknown>) => ({
    id: "7",
    maker: "ravi.t",
    scenario_id: 5,
    mask: 8,
    side: "bid",
    price: "2450000000000000000",
    amount: e18(1_000n).toString(),
    remaining: e18(1_000n).toString(),
    escrow: orderCost(e18(1_000n), 2_450_000_000_000_000_000n).toString(),
    expiry_sec: 1_800_000_000,
    epoch: 0,
    ...o,
  });

  it("accepts a bid whose escrow covers the ceiling cost, listed on its world", async () => {
    const o = order({});
    const r = fake({ get_order: o, get_scenario: scenario, orders_for_world: { bids: [o], asks: [] } });
    const [c] = await checkOrders(r, ["7"], 5);
    assert.equal(c?.ok, true, c?.detail);
  });

  it("flags a bid escrow one unit short of orderCost", async () => {
    const short = (orderCost(e18(1_000n), 2_450_000_000_000_000_000n) - 1n).toString();
    const o = order({ escrow: short });
    const [c] = await checkOrders(fake({ get_order: o, get_scenario: scenario, orders_for_world: { bids: [o], asks: [] } }), ["7"], 5);
    assert.equal(c?.ok, false);
    assert.match(c?.detail ?? "", /bid escrow .* < cost/);
  });

  it("an ask escrows exactly what is left", async () => {
    const ok = order({ side: "ask", escrow: e18(1_000n).toString() });
    assert.equal((await checkOrders(fake({ get_order: ok, get_scenario: scenario, orders_for_world: { bids: [], asks: [ok] } }), ["7"], 5))[0]?.ok, true);
    const bad = order({ side: "ask", escrow: e18(999n).toString() });
    assert.equal((await checkOrders(fake({ get_order: bad, get_scenario: scenario, orders_for_world: { bids: [], asks: [bad] } }), ["7"], 5))[0]?.ok, false);
  });

  it("flags a fillable order missing from the ladder, not an expired one", async () => {
    const o = order({});
    assert.equal((await checkOrders(fake({ get_order: o, get_scenario: scenario, orders_for_world: { bids: [], asks: [] } }), ["7"], 5))[0]?.ok, false);
    const expired = order({ expiry_sec: 1_794_000_000 });
    assert.equal((await checkOrders(fake({ get_order: expired, get_scenario: scenario }), ["7"], 5))[0]?.ok, true);
  });

  it("a closed order holds no escrow", async () => {
    assert.equal((await checkOrders(fake({ get_order: order({ remaining: "0", escrow: "0" }) }), ["7"], 5))[0]?.ok, true);
    assert.equal((await checkOrders(fake({ get_order: order({ remaining: "0", escrow: "1" }) }), ["7"], 5))[0]?.ok, false);
    assert.equal((await checkOrders(fake({ get_order: null }), ["7"], 5))[0]?.ok, false);
  });
});

describe("checkMarket (L-1, L-3 count, L-9)", () => {
  const ms = fx("market_state") as Record<string, unknown>;

  it("accepts the fixture market (Bold at 80%)", async () => {
    const results = await checkMarket(fake({ market_state: ms, borrower_count: 2 }), 5, "bold", 3);
    assert.deepEqual(results.map((r) => [r.name, r.ok]), [
      ["L-1 cash s5/bold", true],
      ["utilization s5/bold", true],
      ["L-3 borrower count s5/bold", true],
      ["L-9 rate s5/bold", false],
    ]);
  });

  it("passes when the rate is the tier's curve at the utilization", async () => {
    const results = await checkMarket(fake({ market_state: { ...ms, borrow_rate_per_sec: "3805175037" }, borrower_count: 2 }), 5, "bold", 3);
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  });

  it("flags negative cash, a wrong utilization and a count mismatch", async () => {
    const broken = { ...ms, total_supply: e18(70_000n).toString(), insurance: "0", utilization: "800000000000000000", borrowers: 3, borrow_rate_per_sec: "3805175037" };
    const results = await checkMarket(fake({ market_state: broken, borrower_count: 2 }), 5, "bold", 3);
    assert.deepEqual(results.map((r) => r.ok), [false, false, false, true]);
    assert.match(results[0]?.detail ?? "", /< 0/);
  });

  it("asks the views for the tier, and Normal without one", async () => {
    const seen: string[] = [];
    const r = fake({
      market_state: (a: Record<string, unknown>) => (seen.push(JSON.stringify(a)), { ...ms, borrow_rate_per_sec: "3805175037" }),
      borrower_count: 2,
    });
    await checkMarket(r, 5, "bold", 3);
    await checkMarket(r, 5, "normal", 3);
    assert.deepEqual(seen, ['{"scenario_id":5,"tier":"bold"}', '{"scenario_id":5}']);
  });
});

describe("borrower index (L-3)", () => {
  const page = fx("borrowers") as { rows: { account_id: string; index: number }[] };

  it("has debt exactly when indexed", async () => {
    const carl = "carl.multiverse-near.testnet";
    const indexed = fake({ borrowers: page, debt_of: "892822257000000000000" });
    assert.equal((await checkBorrowerIndex(indexed, 1, "normal", carl, 8)).ok, true);
    assert.equal((await checkBorrowerIndex(fake({ borrowers: page, debt_of: "0" }), 1, "normal", carl, 8)).ok, false);
    assert.equal((await checkBorrowerIndex(fake({ borrowers: page, debt_of: "5" }), 1, "normal", "dana.t", 8)).ok, false);
    assert.equal((await checkBorrowerIndex(fake({ borrowers: page, debt_of: "0" }), 1, "normal", "dana.t", 8)).ok, true);
  });

  it("is dense from 0", async () => {
    assert.equal((await checkBorrowerList(fake({ borrowers: page }), 1, "normal", 8)).ok, true);
    const gap = { ...page, rows: page.rows.map((r, i) => ({ ...r, index: i === 1 ? 2 : r.index })) };
    assert.equal((await checkBorrowerList(fake({ borrowers: gap }), 1, "normal", 8)).ok, false);
  });
});

describe("checkBacking (V-1)", () => {
  const ws = fx("world_supply") as { possible: number; wnear: string[] };

  it("compares possible worlds only", async () => {
    assert.equal((await checkBacking(fake({ world_supply: ws }), 5, 1)).ok, true);
    const deadOff = { ...ws, wnear: ["1", "2", ...ws.wnear.slice(2)] };
    assert.equal((await checkBacking(fake({ world_supply: deadOff }), 5, 1)).ok, true, "worlds 0 and 1 are not possible (0b1100)");
    const liveOff = { ...ws, wnear: [...ws.wnear.slice(0, 3), "1"] };
    const c = await checkBacking(fake({ world_supply: liveOff }), 5, 1);
    assert.equal(c.ok, false);
    assert.match(c.detail, /w3 wNEAR 1 ≠ reserve/);
  });

  it("with full, also asks backing()", async () => {
    const r = fake({ world_supply: ws, backing: { worlds: [{ world: 2, possible: true, wnear_backed: true, usdc_backed: false }] } });
    assert.equal((await checkBacking(r, 5, 1, true)).ok, false);
  });
});

describe("liquidation slices (V-4)", () => {
  // Carl (production, market 1): repays 446.411128 for 41.3659% of 547.294 wNEAR = 226.391747 wNEAR.
  const ev = { repaid: "446411128000000000000", pieces: ["wnear"], seized: ["226391747000000000000"] };

  it("a cut is worth at least the repayment in every possible world", () => {
    const prices = [3_750_000_000_000_000_000n, 3_500_000_000_000_000_000n, 2_900_000_000_000_000_000n, 2_070_000_000_000_000_000n];
    assert.equal(judgeLiquidation(ev, 15, 4, prices, 1).ok, true);
  });

  it("flags a world where the slice is short", () => {
    const prices = [3_750_000_000_000_000_000n, 3_500_000_000_000_000_000n, 2_900_000_000_000_000_000n, 1_900_000_000_000_000_000n];
    const c = judgeLiquidation(ev, 15, 4, prices, 1);
    assert.equal(c.ok, false);
    assert.match(c.detail, /^w3: slice/);
    assert.equal(judgeLiquidation(ev, 7, 4, prices, 1).ok, true, "world 3 is no longer possible");
  });

  it("counts verse pieces only in the worlds they cover", () => {
    const verse = { repaid: e18(100n).toString(), pieces: ["5:usdc:1", "5:usdc:2"], seized: [e18(100n).toString(), e18(50n).toString()] };
    const c = judgeLiquidation(verse, 3, 2, [WAD, WAD], 1);
    assert.equal(c.ok, false);
    assert.match(c.detail, /w1: slice 50000000000000000000 < repaid/);
  });

  it("leaves seize-all liquidations and write-offs to the bad-debt rules", async () => {
    const r = fake({});
    const base = { scenario_id: 1, account_id: "carl", liquidator_id: "leo", shares: "1", c_min: "1", worst_world: 3, ...ev };
    assert.equal((await checkLiquidation(r, { ...base, seize_all: true }, 10)).ok, true);
    assert.equal((await checkLiquidation(r, { ...base, written_off: "5" }, 10)).ok, true);
  });

  it("reads prices at the block before the liquidation", async () => {
    const r = fake({
      get_scenario: { scenario_id: 1, event_ids: [1, 2], world_count: 4, root: 15, possible: 15, resolution_count: 0, halted: false, pool_ids: [] },
      world_prices: (fx("world_prices") as { liquidation_price: string }[]).map((row) => ({ ...row, liquidation_price: "3500000000000000000" })),
    });
    const c = await checkLiquidation(r, { scenario_id: 1, account_id: "carl", liquidator_id: "leo", shares: "1", c_min: "1", worst_world: 3, ...ev }, 10);
    assert.equal(c.ok, true, c.detail);
    assert.deepEqual([...r.blocks], [9]);
  });
});

describe("checkVersion and checkStorage", () => {
  it("wants state version 2, matching code versions and the expected code hash", async () => {
    const v = fx("contract_version") as Record<string, unknown>;
    assert.equal((await checkVersion(fake({ contract_version: v }), "Code1", 4)).ok, true);
    assert.match((await checkVersion(fake({ contract_version: v }), "Other", 4)).detail, /code hash Code1, expected Other/);
    assert.match((await checkVersion(fake({ contract_version: { ...v, recorded_code_version: "1.0.0" } }), "Code1", 4)).detail, /recorded 1\.0\.0 ≠ code 2\.0\.0/);
    assert.equal((await checkVersion(fake({ contract_version: { ...v, state_version: 1 } }), "Code1", 4)).ok, false);
  });

  it("NEP-145 records: available never above total", async () => {
    const r = fake({
      'storage_balance_of {"account_id":"a"}': null,
      'storage_balance_of {"account_id":"b"}': { total: "100", available: "40" },
      'storage_balance_of {"account_id":"c"}': { total: "100", available: "140" },
    });
    assert.deepEqual((await checkStorage(r, ["a", "b", "c"], 2)).map((c) => c.ok), [true, true, false]);
  });
});
