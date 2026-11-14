import { describe, expect, it } from "vitest";
import {
  avgPrice,
  exactIn,
  expiryOf,
  GAS_FILL,
  GAS_POST,
  GAS_SWAP,
  inputFor,
  levels,
  limitTrade,
  marketTrade,
  maxFor,
  MAX_TAKES,
  myOrders,
  orderState,
  poolBuyCost,
  poolPrice,
  poolSell,
  priceLine,
  priceMoves,
  tradeBlocker,
  tradeGas,
  withSlippage,
  worldTradeTx,
  type PoolState,
} from "./book";
import { parseAmount } from "./format";
import { cost, proceeds, type Order } from "./orders";

const wad = (s: string) => parseAmount(s)!;
const NOW = 1_800_000_000n;
const ME = "uma.ifverse-staging.testnet";

function order(p: Omit<Partial<Order>, "id"> & { id: number }): Order {
  return {
    maker: "ravi.ifverse-staging.testnet",
    scenarioId: 1,
    mask: 1,
    side: "bid",
    price: wad("4"),
    amount: wad("10"),
    remaining: wad("10"),
    expiry: NOW + 86_400n,
    epoch: 0,
    cancelled: false,
    ...p,
    id: BigInt(p.id),
  };
}

// Staging pool 1 (market 1, SHIPS·CUTS) as `get_pool` read it, and what `quote_sell` answered for it.
const STAGING: PoolState = { wnear: 96487670045256639511710n, usdc: 420735964130764337748692n, feePips: 15_000 };

describe("pool maths", () => {
  it("matches the contract's quote_sell to the last unit", () => {
    expect(poolSell(STAGING, wad("10"))).toBe(42946691736164885695n);
    expect(poolSell(STAGING, 123456789000000000000n)).toBe(529592738279908044034n);
  });

  it("prices exact output so the exact-input swap pays at least that much", () => {
    for (const out of [1n, wad("0.001"), wad("1"), wad("250.5"), wad("90000")]) {
      const usdc = poolBuyCost(STAGING, out)!;
      expect(exactIn(STAGING.usdc, STAGING.wnear, usdc, STAGING.feePips)).toBeGreaterThanOrEqual(out);
      // one unit less no longer buys it: the input is the least that does
      expect(exactIn(STAGING.usdc, STAGING.wnear, usdc - 1n, STAGING.feePips)).toBeLessThan(out + 1n);
    }
  });

  it("refuses what the pool cannot pay, and an empty pool", () => {
    expect(inputFor(STAGING.usdc, STAGING.wnear, STAGING.wnear, STAGING.feePips)).toBeUndefined();
    expect(inputFor(0n, 10n, 1n, 0)).toBeUndefined();
    expect(exactIn(0n, 10n, 5n, 0)).toBe(0n);
    expect(exactIn(10n, 10n, 0n, 0)).toBe(0n);
    expect(poolPrice({ wnear: 0n, usdc: 5n, feePips: 0 })).toBe(0n);
    expect(poolPrice({ wnear: wad("2"), usdc: wad("7"), feePips: 0 })).toBe(wad("3.5"));
  });

  it("takes 0.5% off a pool leg's minimum", () => {
    expect(withSlippage(wad("100"))).toBe(wad("99.5"));
  });
});

describe("levels", () => {
  const bids = [order({ id: 1, price: wad("3.987") }), order({ id: 2, price: wad("3.981"), maker: ME }), order({ id: 3, price: wad("3.95"), remaining: wad("2") })];
  const asks = [order({ id: 4, side: "ask", price: wad("4.011") }), order({ id: 5, side: "ask", price: wad("4.02"), remaining: wad("5") })];

  it("groups bids down and asks up, best first, with a running sum", () => {
    const b = levels(bids, "bid", wad("0.01"), 10, ME);
    expect(b.map((l) => l.price)).toEqual([wad("3.98"), wad("3.95")]);
    expect(b[0].amount).toBe(wad("20"));
    expect(b[0].mine).toBe(true);
    expect(b[0].total).toBe(cost(wad("10"), wad("3.987")) + cost(wad("10"), wad("3.981")));
    expect(b[1].sum).toBe(b[0].total + b[1].total);
    const a = levels(asks, "ask", wad("0.01"), 10);
    expect(a.map((l) => l.price)).toEqual([wad("4.02")]);
    expect(a[0].orders).toHaveLength(2);
    expect(a[0].mine).toBe(false);
  });

  it("keeps the exact prices at step 0 and cuts at the depth", () => {
    expect(levels(bids, "bid", 0n, 2).map((l) => l.price)).toEqual([wad("3.987"), wad("3.981")]);
    expect(levels(asks, "bid", wad("0.01"), 5)).toEqual([]);
  });
});

describe("a trade inside one world", () => {
  const bids = [order({ id: 1, price: wad("4.40") }), order({ id: 2, price: wad("4.30"), maker: ME }), order({ id: 3, price: wad("4.20") })];
  const asks = [order({ id: 4, side: "ask", price: wad("4.30") }), order({ id: 5, side: "ask", price: wad("4.50") })];

  it("sells into the bids that beat the pool, then the pool, skipping your own", () => {
    const t = marketTrade("sell", wad("15"), bids, STAGING, ME)!;
    expect(t.takes.map((x) => x.order.id)).toEqual([1n]);
    expect(t.takes[0].usdc).toBe(proceeds(wad("10"), wad("4.40")));
    expect(t.pool).toEqual({ near: wad("5"), usdc: poolSell(STAGING, wad("5")) });
    expect(t.near).toBe(wad("15"));
    expect(t.spend).toBe(wad("15"));
    expect(t.usdc).toBe(t.takes[0].usdc + t.pool!.usdc);
  });

  it("buys from an ask cheaper than the pool, then the pool, at the least total cost", () => {
    const t = marketTrade("buy", wad("12"), asks, STAGING)!;
    expect(t.takes.map((x) => x.order.id)).toEqual([4n]);
    expect(t.pool?.near).toBe(wad("2"));
    expect(t.usdc).toBe(cost(wad("10"), wad("4.30")) + poolBuyCost(STAGING, wad("2"))!);
    expect(t.spend).toBe(t.usdc);
    expect(avgPrice(t)).toBe((t.usdc * 10n ** 18n) / wad("12"));
  });

  it("keeps the pool alone when no order beats it", () => {
    const dear = [order({ id: 9, side: "ask", price: wad("9") })];
    const t = marketTrade("buy", wad("1"), dear, STAGING)!;
    expect(t.takes).toEqual([]);
    expect(t.pool?.near).toBe(wad("1"));
  });

  it("fills from the book alone without a pool, and gives up when the book runs out", () => {
    expect(marketTrade("sell", wad("10"), bids, null)?.takes.map((x) => x.order.id)).toEqual([1n]);
    expect(marketTrade("sell", wad("40"), bids, null)).toBeUndefined();
    expect(marketTrade("buy", 0n, asks, STAGING)).toBeUndefined();
  });

  it("takes at most MAX_TAKES orders", () => {
    const many = Array.from({ length: 9 }, (_, i) => order({ id: 20 + i, side: "ask", price: wad("1"), remaining: wad("1") }));
    const t = marketTrade("buy", wad("9"), many, STAGING)!;
    expect(t.takes).toHaveLength(MAX_TAKES);
    expect(t.pool?.near).toBe(wad("4"));
  });

  it("a crossing limit takes what crosses and rests the rest at the limit", () => {
    const t = limitTrade("buy", wad("15"), wad("4.40"), asks)!;
    expect(t.takes.map((x) => x.order.id)).toEqual([4n]);
    expect(t.rest).toBe(wad("5"));
    expect(t.pool).toBeNull();
    expect(t.spend).toBe(cost(wad("10"), wad("4.30")) + cost(wad("5"), wad("4.40")));
    const s = limitTrade("sell", wad("3"), wad("4.35"), bids, ME)!;
    expect(s.takes.map((x) => x.order.id)).toEqual([1n]);
    expect(s.rest).toBe(0n);
    const none = limitTrade("sell", wad("3"), wad("5"), bids)!;
    expect(none.takes).toEqual([]);
    expect(none.rest).toBe(wad("3"));
    expect(none.spend).toBe(wad("3"));
  });

  it("finds the most a budget buys, through the book and the pool", () => {
    const budget = wad("100");
    const plan = (n: bigint) => marketTrade("buy", n, asks, STAGING);
    const most = maxFor(budget, STAGING.wnear, plan);
    expect(plan(most)!.spend).toBeLessThanOrEqual(budget);
    expect(plan(most + 1n)!.spend).toBeGreaterThan(budget);
    // a limit at 4.40 spends at most amount × 4.40, less where it fills cheaper
    const lim = maxFor(budget, (budget * 10n ** 18n) / wad("4.30") + 1n, (n) => limitTrade("buy", n, wad("4.40"), asks));
    expect(limitTrade("buy", lim, wad("4.40"), asks)!.spend).toBeLessThanOrEqual(budget);
    expect(lim).toBeGreaterThan((budget * 10n ** 18n) / wad("4.40"));
    expect(maxFor(0n, wad("5"), plan)).toBe(0n);
  });

  it("says what stops a trade", () => {
    const t = limitTrade("buy", wad("1"), wad("4"), [])!;
    expect(tradeBlocker(t, wad("3"), { limit: wad("4"), openOrders: 0 })).toBe("Not enough USDC in this world");
    expect(tradeBlocker(t, wad("5"), { limit: wad("4"), openOrders: 0 })).toBeUndefined();
    expect(tradeBlocker(t, wad("5"), { limit: wad("4"), openOrders: 64 })).toMatch(/64 open orders/);
    const tiny = limitTrade("sell", wad("0.0001"), wad("4"), [])!;
    expect(tradeBlocker(tiny, wad("1"), { limit: wad("4"), openOrders: 0 })).toBe("The resting part is under 0.001 NEAR");
    const cheap = limitTrade("sell", wad("0.01"), wad("0.000001"), [])!;
    expect(tradeBlocker(cheap, wad("1"), { limit: wad("0.000001"), openOrders: 0 })).toBe("The resting part is worth too little");
  });
});

describe("the transaction", () => {
  const asks = [order({ id: 4, side: "ask", price: wad("4.30") })];

  it("fills, then swaps with a minimum, in one transaction", () => {
    const t = marketTrade("buy", wad("12"), asks, STAGING)!;
    const tx = worldTradeTx("app.ifverse-staging.testnet", t, { sid: 1, mask: 1, poolId: 1, limit: null, expirySec: 0 });
    expect(tx.receiverId).toBe("app.ifverse-staging.testnet");
    expect(tx.actions.map((a) => a.params.methodName)).toEqual(["fill_order", "swap"]);
    expect(tx.actions[0].params.args).toEqual({ order_id: "4", amount: wad("10").toString(), limit_price: wad("4.30").toString() });
    expect(tx.actions[1].params.args).toEqual({ pool_id: 1, zero_for_one: false, amount_in: t.pool!.usdc.toString(), min_out: withSlippage(wad("2")).toString() });
    expect(tx.actions.every((a) => a.params.deposit === "1")).toBe(true);
    expect(tradeGas(t)).toBe(GAS_FILL + GAS_SWAP);
  });

  it("sells through the pool token0 first, and rests a limit's remainder", () => {
    const sale = marketTrade("sell", wad("1"), [], STAGING)!;
    const s = worldTradeTx("c", sale, { sid: 1, mask: 1, poolId: 7, limit: null, expirySec: 0 });
    expect(s.actions[0].params.args).toMatchObject({ pool_id: 7, zero_for_one: true, amount_in: wad("1").toString() });
    const t = limitTrade("buy", wad("15"), wad("4.40"), asks)!;
    const tx = worldTradeTx("c", t, { sid: 3, mask: 4, poolId: 1, limit: wad("4.40"), expirySec: 1_900_000_000 });
    expect(tx.actions.map((a) => a.params.methodName)).toEqual(["fill_order", "post_order"]);
    expect(tx.actions[1].params.args).toEqual({ scenario_id: 3, mask: 4, side: "bid", price: wad("4.40").toString(), amount: wad("5").toString(), expiry_sec: 1_900_000_000 });
    expect(tradeGas(t)).toBe(GAS_FILL + GAS_POST);
  });

  it("refuses a pool leg without a pool and an empty trade", () => {
    const sale = marketTrade("sell", wad("1"), [], STAGING)!;
    expect(() => worldTradeTx("c", sale, { sid: 1, mask: 1, poolId: null, limit: null, expirySec: 0 })).toThrow(/no pool/);
    const empty = { side: "buy" as const, takes: [], pool: null, rest: 0n, near: 0n, usdc: 0n, spend: 0n };
    expect(() => worldTradeTx("c", empty, { sid: 1, mask: 1, poolId: 1, limit: null, expirySec: 0 })).toThrow(/Nothing/);
  });
});

describe("your orders, expiry and prices", () => {
  const s = { scenarioId: 1, possible: 0b1110, resolutionCount: 1 };

  it("lists your orders that still hold escrow, newest first, with why one cannot fill", () => {
    const os = [
      order({ id: 1, maker: ME, epoch: 1 }),
      order({ id: 3, maker: ME.toUpperCase(), epoch: 1, expiry: NOW - 1n }),
      order({ id: 4, maker: ME, cancelled: true }),
      order({ id: 5, maker: ME, remaining: 0n }),
      order({ id: 6, maker: "x.testnet" }),
      order({ id: 7, maker: ME, scenarioId: 2 }),
    ];
    expect(myOrders(os, ME, 1).map((o) => o.id)).toEqual([3n, 1n]);
    expect(myOrders(os, null, 1)).toEqual([]);
    expect(orderState(os[0], s, NOW)).toBe("World ruled out");
    expect(orderState(order({ id: 8, mask: 2, epoch: 1 }), s, NOW)).toBeUndefined();
    expect(orderState(order({ id: 8, mask: 2, epoch: 1, expiry: NOW }), s, NOW)).toBe("Expired");
    expect(orderState(order({ id: 8, mask: 2, epoch: 0 }), s, NOW)).toBe("Stale after a resolution");
  });

  it("dates an expiry from the later clock", () => {
    expect(expiryOf(100n, 90n, 60)).toBe(160);
    expect(expiryOf(undefined, 90n, 60)).toBe(150);
    expect(expiryOf(80n, 90n, 60)).toBe(150);
  });

  it("reads a world's prices off the Impact Meter, and the swaps that moved it", () => {
    const impact = [
      { at: 10, prices: [wad("4"), 0n] },
      { at: 20, prices: [wad("4"), wad("3")] },
      { at: 30, prices: [wad("4.2"), wad("3")] },
      { at: 40, prices: [wad("4.1"), wad("3.1")] },
    ];
    expect(priceLine(impact, 1)).toEqual([{ at: 20, price: wad("3") }, { at: 30, price: wad("3") }, { at: 40, price: wad("3.1") }]);
    expect(priceMoves(impact, 0)).toEqual([
      { at: 40, price: wad("4.1"), prev: wad("4.2"), up: false },
      { at: 30, price: wad("4.2"), prev: wad("4"), up: true },
    ]);
    expect(priceMoves(impact, 3)).toEqual([]);
  });
});
