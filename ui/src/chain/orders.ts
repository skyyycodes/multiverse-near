// The order book in the browser: the contract's rounding, which orders can still fill, each cell's book, and the
// sale planner. Amounts are bigint in 18-decimal units (NEAR and USDC alike); nothing here uses floating point.

const ONE = 10n ** 18n;

export type Side = "bid" | "ask";

export type Order = {
  id: bigint;
  maker: string;
  scenarioId: number;
  mask: number;
  side: Side;
  price: bigint; // USDC per NEAR, 18 decimals
  amount: bigint; // NEAR when posted
  remaining: bigint; // NEAR left; 0 once filled or cancelled
  expiry: bigint; // unix seconds; fills fail from this second on
  epoch: number; // the scenario's resolution count when posted
  cancelled: boolean;
};

/** USDC a buyer pays for `amount` NEAR at `price`, rounded up: a bid's escrow, or the cost of filling an ask. */
export function cost(amount: bigint, price: bigint): bigint {
  const p = amount * price;
  return p === 0n ? 0n : (p - 1n) / ONE + 1n;
}

/** USDC a seller receives for `amount` NEAR at `price`, rounded down: what filling a bid pays. */
export function proceeds(amount: bigint, price: bigint): bigint {
  return (amount * price) / ONE;
}

export type ScenarioState = { scenarioId: number; possible: number; resolutionCount: number };

/** Why an order can no longer be filled (the contract's checks, in its order), or undefined if it can. */
export function closedReason(o: Order, s: ScenarioState, nowSec: bigint): string | undefined {
  if (o.cancelled) return "cancelled";
  if (o.remaining === 0n) return "filled";
  if (nowSec >= o.expiry) return "expired";
  if ((o.mask & s.possible) === 0) return "world resolved away";
  if (o.epoch !== s.resolutionCount) return "stale: a resolution came after it";
  return undefined;
}

export function isOpen(o: Order, s: ScenarioState, nowSec: bigint): boolean {
  return o.scenarioId === s.scenarioId && closedReason(o, s, nowSec) === undefined;
}

export type CellBook = { bids: Order[]; asks: Order[] };

/** Open bids (highest first) and asks (lowest first) of one grid cell; equal prices keep the older order first. */
export function cellBook(orders: readonly Order[], s: ScenarioState, mask: number, nowSec: bigint): CellBook {
  const open = orders.filter((o) => o.mask === mask && isOpen(o, s, nowSec));
  const byId = (a: Order, b: Order) => (a.id < b.id ? -1 : 1);
  return {
    bids: open.filter((o) => o.side === "bid").sort((a, b) => (a.price === b.price ? byId(a, b) : a.price > b.price ? -1 : 1)),
    asks: open.filter((o) => o.side === "ask").sort((a, b) => (a.price === b.price ? byId(a, b) : a.price < b.price ? -1 : 1)),
  };
}

/** Best open bid and ask of one world's order book (USDC per NEAR); either is missing when that side is empty. */
export type CellQuote = { bid?: bigint; ask?: bigint };

/**
 * Every world's best open bid and ask, in world-index order. The one source for each grid, list and card that shows a
 * best bid, so they all agree.
 */
export function cellQuotes(orders: readonly Order[], s: ScenarioState & { worlds: readonly { mask: number }[] }, nowSec: bigint): CellQuote[] {
  return s.worlds.map((w) => {
    const b = cellBook(orders, s, w.mask, nowSec);
    return { bid: b.bids[0]?.price, ask: b.asks[0]?.price };
  });
}

export const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

/** How many resting orders the planner looks at per world (the order panel shows the same top 5). */
export const MAX_PLAN_ORDERS = 5;

/** The contract's fill caps per trade (`get_app_config` `max_trade_fills`, `max_trade_fills_8w`). */
export type FillCaps = { maxTradeFills: number; maxTradeFills8w: number };
export const DEFAULT_FILL_CAPS: FillCaps = { maxTradeFills: 20, maxTradeFills8w: 16 };

/**
 * Orders the planner may fill per traded world, so the whole trade stays within the contract's cap (web 7.9):
 * min(5, floor(B / traded)), B = the cap for the market's size (20 up to 4 worlds, 16 at 8).
 */
export function planBudget(worldCount: number, tradedWorlds: number, caps: FillCaps = DEFAULT_FILL_CAPS): number {
  if (tradedWorlds <= 0) return MAX_PLAN_ORDERS;
  const b = worldCount <= 4 ? caps.maxTradeFills : caps.maxTradeFills8w;
  return Math.max(0, Math.min(MAX_PLAN_ORDERS, Math.floor(b / tradedWorlds)));
}

export type Fill = { order: Order; amount: bigint; out: bigint };
export type Candidate = { fills: Fill[]; poolAmount: bigint };
export type WorldPlan = Candidate & { poolOut: bigint; total: bigint };

/**
 * Candidate k fills the best k bids in turn (the last one only in part if the sale runs out) and sends the rest to the
 * pool, using at most `maxOrders` bids (the trade's budget per world, `planBudget`). Candidate 0 is the pool alone. A
 * bid that would pay nothing for its part ends the list: the book rejects such fills.
 */
export function saleCandidates(bids: readonly Order[], amount: bigint, maxOrders: number = MAX_PLAN_ORDERS): Candidate[] {
  const out: Candidate[] = [{ fills: [], poolAmount: amount }];
  const fills: Fill[] = [];
  let left = amount;
  for (const order of bids.slice(0, Math.max(0, Math.min(maxOrders, MAX_PLAN_ORDERS)))) {
    if (left === 0n) break;
    const take = order.remaining < left ? order.remaining : left;
    const got = proceeds(take, order.price);
    if (got === 0n) break;
    fills.push({ order, amount: take, out: got });
    left -= take;
    out.push({ fills: [...fills], poolAmount: left });
  }
  return out;
}

/**
 * The candidate that pays the most, given what the pool pays for each candidate's pool part. A missing quote means
 * no plan yet; a pool part quoted at 0 (the view's answer when a swap would fail) skips that candidate. The comparison
 * is strict, so a tie keeps the plan with fewer orders, ultimately the pool alone.
 */
export function bestPlan(candidates: readonly Candidate[], poolOut: (amount: bigint) => bigint | undefined): WorldPlan | undefined {
  let best: WorldPlan | undefined;
  for (const c of candidates) {
    const fromPool = c.poolAmount === 0n ? 0n : poolOut(c.poolAmount);
    if (fromPool === undefined) return undefined;
    if (c.poolAmount !== 0n && fromPool === 0n) continue;
    const total = c.fills.reduce((sum, f) => sum + f.out, fromPool);
    if (!best || total > best.total) best = { ...c, poolOut: fromPool, total };
  }
  return best;
}

/** Each world must pay at least its plan, less 0.5% on the pool part: listed orders pay exactly their price. */
export const SLIPPAGE_BPS = 50n;
export const minOutOf = (plan: WorldPlan | undefined): bigint => (plan ? plan.total - (plan.poolOut * SLIPPAGE_BPS) / 10_000n : 0n);

/** Where a sold world's NEAR goes, for the preview line. */
export function via(plan: WorldPlan | undefined): string {
  if (!plan?.fills.length) return "sell via pool → ";
  const orders = plan.fills.length === 1 ? "a bid" : `${plan.fills.length} bids`;
  return `sell via ${orders}${plan.poolAmount > 0n ? " + pool" : ""} → `;
}
