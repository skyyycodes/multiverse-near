import { describe, expect, it } from "vitest";
import { bestPlan, cellBook, closedReason, cost, isOpen, MAX_PLAN_ORDERS, minOutOf, proceeds, saleCandidates, via, type Order } from "./orders";
import { parseAmount } from "./format";

const E18 = 10n ** 18n;
const wad = (s: string) => parseAmount(s)!;

const state = { scenarioId: 1, possible: 0b1111, resolutionCount: 0 };
const NOW = 1_800_000_000n;

function order(p: Omit<Partial<Order>, "id"> & { id: number }): Order {
  return {
    maker: "ravi.multiverse-lending.testnet",
    scenarioId: 1,
    mask: 8,
    side: "bid",
    price: wad("2450"),
    amount: E18,
    remaining: E18,
    expiry: NOW + 86_400n,
    epoch: 0,
    cancelled: false,
    ...p,
    id: BigInt(p.id),
  };
}

describe("order maths", () => {
  it("rounds the buyer up and the seller down", () => {
    const p = wad("1.5");
    expect(cost(3n, p)).toBe(5n); // 4.5 → 5: a bid's escrow
    expect(proceeds(3n, p)).toBe(4n); // 4.5 → 4: what filling it pays
    expect(proceeds(1n, p)).toBe(1n);
    expect(cost(1n, p)).toBe(2n);
    expect(cost(0n, p)).toBe(0n);
    expect(cost(E18, wad("2450"))).toBe(wad("2450"));
  });

  it("never lets cost and proceeds drift more than one unit apart", () => {
    let seed = 7n;
    const next = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n);
    for (let i = 0; i < 500; i++) {
      const amount = next() % (10n ** 21n);
      const price = (next() % (10n ** 22n)) + 1n;
      const c = cost(amount, price);
      const f = proceeds(amount, price);
      expect(c - f === 0n || c - f === 1n).toBe(true);
      expect(c * E18 >= amount * price).toBe(true);
      expect(f * E18 <= amount * price).toBe(true);
    }
  });
});

describe("open and closed orders", () => {
  it("names the first reason an order can no longer fill, in the contract's order", () => {
    expect(closedReason(order({ id: 1, cancelled: true, remaining: 0n }), state, NOW)).toBe("cancelled");
    expect(closedReason(order({ id: 1, remaining: 0n, expiry: 0n }), state, NOW)).toBe("filled");
    expect(closedReason(order({ id: 1, expiry: NOW, mask: 1 }), { ...state, possible: 0b1100 }, NOW)).toBe("expired");
    expect(closedReason(order({ id: 1, mask: 1, epoch: 0 }), { ...state, possible: 0b1100, resolutionCount: 1 }, NOW)).toBe(
      "world resolved away",
    );
    expect(closedReason(order({ id: 1, mask: 8, epoch: 0 }), { ...state, possible: 0b1100, resolutionCount: 1 }, NOW)).toBe(
      "stale: a resolution came after it",
    );
    expect(closedReason(order({ id: 1 }), state, NOW)).toBeUndefined();
  });

  it("expires at the expiry second, not after it", () => {
    expect(isOpen(order({ id: 1, expiry: NOW }), state, NOW)).toBe(false);
    expect(isOpen(order({ id: 1, expiry: NOW + 1n }), state, NOW)).toBe(true);
    expect(isOpen(order({ id: 1, scenarioId: 2 }), state, NOW)).toBe(false);
  });

  it("sorts a cell's book best first, older first on a tie", () => {
    const orders = [
      order({ id: 1, price: wad("2400") }),
      order({ id: 2, price: wad("2450") }),
      order({ id: 3, price: wad("2450") }),
      order({ id: 4, side: "ask", price: wad("2600") }),
      order({ id: 5, side: "ask", price: wad("2550") }),
      order({ id: 6, side: "ask", price: wad("2550") }),
      order({ id: 7, mask: 4 }),
      order({ id: 8, cancelled: true }),
    ];
    const b = cellBook(orders, state, 8, NOW);
    expect(b.bids.map((o) => o.id)).toEqual([2n, 3n, 1n]);
    expect(b.asks.map((o) => o.id)).toEqual([5n, 6n, 4n]);
  });
});

describe("sale planner", () => {
  it("builds candidates best bid first, the last one partly, the rest to the pool", () => {
    const bids = [order({ id: 1, remaining: wad("0.5"), price: wad("2500") }), order({ id: 2, remaining: wad("2"), price: wad("2450") })];
    const c = saleCandidates(bids, wad("2"));
    expect(c).toHaveLength(3);
    expect(c[0]).toEqual({ fills: [], poolAmount: wad("2") });
    expect(c[1].poolAmount).toBe(wad("1.5"));
    expect(c[2].fills.map((f) => f.amount)).toEqual([wad("0.5"), wad("1.5")]);
    expect(c[2].poolAmount).toBe(0n);
    expect(c[2].fills[1].out).toBe(wad("3675"));
  });

  it("looks at five bids at most and stops at a bid that would pay nothing", () => {
    const many = Array.from({ length: 8 }, (_, i) => order({ id: i + 1, remaining: 1n, price: wad("2450") }));
    expect(saleCandidates(many, wad("1"))).toHaveLength(MAX_PLAN_ORDERS + 1);
    const dust = [order({ id: 1, remaining: 1n, price: 10n ** 17n })]; // 1 wei at 0.1 pays 0
    expect(saleCandidates(dust, wad("1"))).toHaveLength(1);
  });

  it("reproduces the demo: Ravi's bid then the pool beats the pool alone", () => {
    // DELAYED·HOLDS: 40 WETH / 100,000 USDC at 0.30%. Pool alone for 2 WETH: 4,748.29; for 1 WETH: 2,431.88.
    const poolOut = (a: bigint) => {
      const x = wad("40");
      const y = wad("100000");
      const aEff = (a * 997_000n) / 1_000_000n;
      return (y * aEff) / (x + aEff);
    };
    const plan = bestPlan(saleCandidates([order({ id: 1 })], wad("2")), poolOut)!;
    expect(plan.fills.map((f) => f.order.id)).toEqual([1n]);
    expect(plan.poolAmount).toBe(wad("1"));
    expect(plan.total).toBe(wad("2450") + poolOut(wad("1")));
    expect(plan.total / 10n ** 16n).toBe(488_188n); // 4,881.88
    expect(poolOut(wad("2")) / 10n ** 16n).toBe(474_829n); // 4,748.29
    expect(via(plan)).toBe("sell via a bid + pool → ");
    // only the pool part can slip: 0.5% of 2,431.88
    expect(minOutOf(plan)).toBe(plan.total - (plan.poolOut * 50n) / 10_000n);
  });

  it("keeps the plan with fewer orders on a tie, waits for missing quotes, skips zero quotes", () => {
    const bids = [order({ id: 1, remaining: wad("1"), price: wad("1000") })];
    const cands = saleCandidates(bids, wad("2"));
    // the pool pays exactly 1,000 per ETH: a tie, so the pool alone wins
    expect(bestPlan(cands, (a) => (a * 1000n) / 1n)!.fills).toHaveLength(0);
    expect(bestPlan(cands, () => undefined)).toBeUndefined();
    const onlyBid = bestPlan(cands, (a) => (a === wad("2") ? 0n : a * 900n));
    expect(onlyBid!.fills).toHaveLength(1);
    expect(bestPlan([{ fills: [], poolAmount: wad("1") }], () => 0n)).toBeUndefined();
  });

  it("describes the route", () => {
    expect(via(undefined)).toBe("sell via pool → ");
    const two = { fills: [{ order: order({ id: 1 }), amount: 1n, out: 1n }, { order: order({ id: 2 }), amount: 1n, out: 1n }], poolAmount: 0n, poolOut: 0n, total: 2n };
    expect(via(two)).toBe("sell via 2 bids → ");
    expect(minOutOf(undefined)).toBe(0n);
  });
});
