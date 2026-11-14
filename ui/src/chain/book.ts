// The order book screen's maths: one world's book as price levels, the world's pool as the contract computes it, and
// a trade inside one world planned against both. Everything is bigint in 18-decimal units (NEAR and USDC alike).
//
// A trade here spends what the account already holds in that world (its NEAR-if-w or USDC-if-w), through the
// contract's direct calls, sent as one transaction so it lands whole or not at all:
//   fill_order   take a resting order at its price (a bid when selling, an ask when buying)
//   swap         the rest through the world's pool, exact input, with a minimum out
//   post_order   what a limit order does not fill rests on the book at the limit
// The wallet path (real wNEAR or USDC split into every world first) is the market page's Fund and Hedge.
import type { ImpactPoint } from "./domain";
import { call, ONE_YOCTO, type Tx } from "./near/tx";
import { closedReason, cost, proceeds, SLIPPAGE_BPS, type Order, type ScenarioState, type Side } from "./orders";

const ONE = 10n ** 18n;

/** The contract's order limits (orders.rs): at least 0.001 NEAR, worth at least 0.0001 USDC, 64 open per maker. */
export const MIN_ORDER_AMOUNT = 10n ** 15n;
export const MIN_ORDER_VALUE = 10n ** 14n;
export const MAX_OPEN_ORDERS = 64;
/** Resting orders one trade takes at most; with the pool leg it stays well inside one transaction's gas. */
export const MAX_TAKES = 5;
/** Pool fees are in pips: 1e6 = 100% (multiverse-math cpmm). */
const FEE_DENOMINATOR = 1_000_000n;

/**
 * Gas per action of a world trade: a fill, the pool swap, a new order. None of them schedules a promise (orders.rs,
 * amm/trade.rs); on staging a fill burns about 4.5 Tgas, a swap 6.4 and a post 4.9 (receipt gas). Testnet buys the
 * prepaid gas up front (0.001 NEAR per Tgas) and refunds the rest, so five takes, the pool and a post (155 Tgas) need
 * about 0.17 NEAR free.
 */
export const GAS_FILL = 20_000_000_000_000n;
export const GAS_SWAP = 30_000_000_000_000n;
export const GAS_POST = 25_000_000_000_000n;

const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);

// ---------- the pool: the contract's constant-product maths, rounding included ----------

export type PoolState = { wnear: bigint; usdc: bigint; feePips: number };

/** What `amountIn` buys: the fee comes off the input (rounded down), the output rounds down. 0 when nothing. */
export function exactIn(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feePips: number): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const afterFee = (amountIn * (FEE_DENOMINATOR - BigInt(feePips))) / FEE_DENOMINATOR;
  return (reserveOut * afterFee) / (reserveIn + afterFee);
}

/** The least input that buys at least `amountOut` (exact-output rounding, both steps up); undefined past the reserve. */
export function inputFor(reserveIn: bigint, reserveOut: bigint, amountOut: bigint, feePips: number): bigint | undefined {
  if (amountOut <= 0n) return 0n;
  if (reserveIn <= 0n || amountOut >= reserveOut || BigInt(feePips) >= FEE_DENOMINATOR) return undefined;
  const intoCurve = ceilDiv(reserveIn * amountOut, reserveOut - amountOut);
  return ceilDiv(intoCurve * FEE_DENOMINATOR, FEE_DENOMINATOR - BigInt(feePips));
}

/** USDC-if-w the pool pays for `near` NEAR-if-w. */
export const poolSell = (p: PoolState, near: bigint) => exactIn(p.wnear, p.usdc, near, p.feePips);
/** USDC-if-w the pool takes for `near` NEAR-if-w; undefined when it holds less. */
export const poolBuyCost = (p: PoolState, near: bigint) => inputFor(p.usdc, p.wnear, near, p.feePips);
/** The pool's price before a trade, USDC per NEAR. */
export const poolPrice = (p: PoolState) => (p.wnear > 0n ? (p.usdc * ONE) / p.wnear : 0n);

/** At least `x` less 0.5%: what a pool leg must pay, or the trade does nothing. */
export const withSlippage = (x: bigint) => x - (x * SLIPPAGE_BPS) / 10_000n;

// ---------- the book as price levels ----------

export type Level = { price: bigint; amount: bigint; total: bigint; sum: bigint; orders: Order[]; mine: boolean };

/**
 * One side of a world's book grouped into price levels of `step`, best first, at most `depth` of them. Bids round down
 * and asks round up, so a level never shows a better price than the orders in it. `total` is the level's USDC, `sum`
 * the running total away from the middle.
 */
export function levels(orders: readonly Order[], side: Side, step: bigint, depth: number, me?: string | null): Level[] {
  const key = (p: bigint) => (step <= 0n ? p : side === "bid" ? (p / step) * step : ceilDiv(p, step) * step);
  const byPrice = new Map<bigint, Level>();
  for (const o of orders) {
    if (o.side !== side) continue;
    const price = key(o.price);
    const l = byPrice.get(price) ?? { price, amount: 0n, total: 0n, sum: 0n, orders: [], mine: false };
    l.amount += o.remaining;
    l.total += cost(o.remaining, o.price);
    l.orders.push(o);
    l.mine ||= Boolean(me) && o.maker.toLowerCase() === me!.toLowerCase();
    byPrice.set(price, l);
  }
  const sorted = [...byPrice.values()].sort((a, b) => (side === "bid" ? (a.price > b.price ? -1 : 1) : a.price < b.price ? -1 : 1));
  let run = 0n;
  return sorted.slice(0, Math.max(0, depth)).map((l) => ({ ...l, sum: (run += l.total) }));
}

/** The account's orders in a market that still hold escrow (open, or closed but not cancelled), newest first. */
export function myOrders(orders: readonly Order[], me: string | null | undefined, sid: number): Order[] {
  if (!me) return [];
  const m = me.toLowerCase();
  return orders.filter((o) => o.scenarioId === sid && o.maker.toLowerCase() === m && o.remaining > 0n && !o.cancelled).sort((a, b) => (a.id > b.id ? -1 : 1));
}

/** Why one of your orders can no longer fill, in words; undefined while it can. */
export function orderState(o: Order, s: ScenarioState, nowSec: bigint): string | undefined {
  const r = closedReason(o, s, nowSec);
  if (r === undefined || r === "filled" || r === "cancelled") return undefined;
  if (r === "expired") return "Expired";
  if (r === "world resolved away") return "World ruled out";
  return "Stale after a resolution";
}

// ---------- a trade inside one world ----------

export type Take = { order: Order; near: bigint; usdc: bigint };

export type WorldTrade = {
  side: "buy" | "sell";
  /** Resting orders taken, best first: NEAR of each and the USDC paid (an ask) or received (a bid). */
  takes: Take[];
  /** The pool leg: NEAR bought or sold through the pool and the USDC it costs or pays. */
  pool: { near: bigint; usdc: bigint } | null;
  /** NEAR left to rest as your own order at the limit (limit orders only). */
  rest: bigint;
  /** NEAR bought or sold now, and the USDC paid or received for it. */
  near: bigint;
  usdc: bigint;
  /** USDC (a buy) or NEAR (a sell) the whole trade needs from what you hold in the world, resting order included. */
  spend: bigint;
};

const notMine = (me: string | null | undefined) => (o: Order) => !me || o.maker.toLowerCase() !== me.toLowerCase();

/** Fill `amount` NEAR from `book` best first, up to `limit` (a bid at or above it, an ask at or below it). */
function sweep(book: readonly Order[], side: "buy" | "sell", amount: bigint, limit: bigint | null, max: number): { takes: Take[]; left: bigint } {
  const takes: Take[] = [];
  let left = amount;
  for (const o of book) {
    if (left <= 0n || takes.length >= max) break;
    if (limit !== null && (side === "buy" ? o.price > limit : o.price < limit)) break;
    const near = o.remaining < left ? o.remaining : left;
    const usdc = side === "buy" ? cost(near, o.price) : proceeds(near, o.price);
    if (usdc === 0n) break; // the book refuses a fill that moves no dollars
    takes.push({ order: o, near, usdc });
    left -= near;
  }
  return { takes, left };
}

const total = (takes: readonly Take[], f: (t: Take) => bigint) => takes.reduce((s, t) => s + f(t), 0n);

function trade(side: "buy" | "sell", takes: Take[], pool: WorldTrade["pool"], rest: bigint, limit: bigint | null): WorldTrade {
  const near = total(takes, (t) => t.near) + (pool?.near ?? 0n);
  const usdc = total(takes, (t) => t.usdc) + (pool?.usdc ?? 0n);
  const escrow = rest === 0n || limit === null ? 0n : side === "buy" ? cost(rest, limit) : rest;
  return { side, takes, pool, rest, near, usdc, spend: side === "buy" ? usdc + escrow : near + escrow };
}

/**
 * A market order for `amount` NEAR: resting orders first while they beat the pool, then the pool. Every split between
 * the best k orders and the pool is tried (k up to MAX_TAKES); a sale keeps the one that pays most, a buy the one that
 * costs least, and a tie keeps fewer orders. Undefined when nothing can fill it all (an empty side and no pool).
 */
export function marketTrade(side: "buy" | "sell", amount: bigint, book: readonly Order[], pool: PoolState | null, me?: string | null): WorldTrade | undefined {
  if (amount <= 0n) return undefined;
  const open = book.filter(notMine(me));
  let best: WorldTrade | undefined;
  for (let k = 0; k <= Math.min(MAX_TAKES, open.length); k++) {
    const { takes, left } = sweep(open, side, amount, null, k);
    if (takes.length < k) break; // the book ran out (or a fill would move nothing) before k orders
    let leg: WorldTrade["pool"] = null;
    if (left > 0n) {
      if (!pool) continue;
      const usdc = side === "sell" ? poolSell(pool, left) : poolBuyCost(pool, left);
      if (usdc === undefined || usdc === 0n) continue;
      leg = { near: left, usdc };
    }
    const t = trade(side, takes, leg, 0n, null);
    if (!best || (side === "sell" ? t.usdc > best.usdc : t.usdc < best.usdc)) best = t;
  }
  return best;
}

/**
 * A limit order for `amount` NEAR at `price`: it takes the resting orders that cross the limit, best first, and what
 * is left rests on the book as your order at the limit. The pool is never used.
 */
export function limitTrade(side: "buy" | "sell", amount: bigint, price: bigint, book: readonly Order[], me?: string | null): WorldTrade | undefined {
  if (amount <= 0n || price <= 0n) return undefined;
  const { takes, left } = sweep(book.filter(notMine(me)), side, amount, price, MAX_TAKES);
  return trade(side, takes, null, left, price);
}

/** Why a planned trade cannot be sent, in the words a button shows; undefined when it can. */
export function tradeBlocker(t: WorldTrade, held: bigint, o: { limit: bigint | null; openOrders: number }): string | undefined {
  const asset = t.side === "buy" ? "USDC" : "NEAR";
  if (t.spend > held) return `Not enough ${asset} in this world`;
  if (t.rest > 0n && o.limit !== null) {
    if (t.rest < MIN_ORDER_AMOUNT) return "The resting part is under 0.001 NEAR";
    if (cost(t.rest, o.limit) < MIN_ORDER_VALUE) return "The resting part is worth too little";
    if (o.openOrders >= MAX_OPEN_ORDERS) return `You have ${MAX_OPEN_ORDERS} open orders; cancel one first`;
  }
  return undefined;
}

/**
 * The most NEAR a trade can be for while what it spends stays within `budget` (the "100%" of a buy form), by
 * bisection over [0, hi]; `plan` plans a trade of a given size. 0 when even the smallest does not fit.
 */
export function maxFor(budget: bigint, hi: bigint, plan: (near: bigint) => WorldTrade | undefined): bigint {
  let lo = 0n;
  let top = hi;
  while (lo < top) {
    const mid = (lo + top + 1n) / 2n;
    const t = plan(mid);
    if (t && t.spend <= budget) lo = mid;
    else top = mid - 1n;
  }
  return lo;
}

/** The average price of what fills now, USDC per NEAR; 0 when nothing does. */
export const avgPrice = (t: WorldTrade) => (t.near > 0n ? (t.usdc * ONE) / t.near : 0n);

/** Total gas of a world trade's transaction. */
export const tradeGas = (t: WorldTrade): bigint => BigInt(t.takes.length) * GAS_FILL + (t.pool ? GAS_SWAP : 0n) + (t.rest > 0n ? GAS_POST : 0n);

/**
 * The trade as one transaction to the contract, its actions in order: the fills, then the pool swap with its minimum,
 * then the resting order. Each action is a direct call with one yoctoNEAR, paid from what the account holds in the
 * world; if any of them fails, none of them happens.
 */
export function worldTradeTx(contractId: string, t: WorldTrade, w: { sid: number; mask: number; poolId: number | null; limit: bigint | null; expirySec: number }): Tx {
  const actions: Tx["actions"] = [];
  for (const take of t.takes) {
    actions.push(call(contractId, "fill_order", { order_id: take.order.id.toString(), amount: take.near.toString(), limit_price: take.order.price.toString() }, ONE_YOCTO, GAS_FILL.toString()).actions[0]);
  }
  if (t.pool) {
    if (w.poolId === null) throw new Error("This world has no pool yet.");
    const sell = t.side === "sell";
    actions.push(
      call(
        contractId,
        "swap",
        { pool_id: w.poolId, zero_for_one: sell, amount_in: (sell ? t.pool.near : t.pool.usdc).toString(), min_out: withSlippage(sell ? t.pool.usdc : t.pool.near).toString() },
        ONE_YOCTO,
        GAS_SWAP.toString(),
      ).actions[0],
    );
  }
  if (t.rest > 0n) {
    if (w.limit === null) throw new Error("A resting order needs a price.");
    actions.push(
      call(
        contractId,
        "post_order",
        { scenario_id: w.sid, mask: w.mask, side: t.side === "buy" ? "bid" : "ask", price: w.limit.toString(), amount: t.rest.toString(), expiry_sec: w.expirySec },
        ONE_YOCTO,
        GAS_POST.toString(),
      ).actions[0],
    );
  }
  if (actions.length === 0) throw new Error("Nothing to trade.");
  return { receiverId: contractId, actions };
}

// ---------- how long an order rests ----------

export const LIVES = [
  { label: "1 hour", seconds: 3_600 },
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 604_800 },
  { label: "30 days", seconds: 2_592_000 },
] as const;

/** An order's expiry: from now (the later of chain time and the wall clock) for `seconds`. */
export const expiryOf = (chainNow: bigint | undefined, wallNow: bigint, seconds: number): number =>
  Number((chainNow !== undefined && chainNow > wallNow ? chainNow : wallNow) + BigInt(seconds));

// ---------- the pool's recent prices (the contract's Impact Meter: the last 64 swaps of the market) ----------

export type PricePoint = { at: number; price: bigint };

/** World `w`'s pool price after each recorded swap, oldest first (points before the pool had a price dropped). */
export function priceLine(impact: readonly ImpactPoint[], w: number): PricePoint[] {
  return impact.filter((p) => (p.prices[w] ?? 0n) > 0n).map((p) => ({ at: p.at, price: p.prices[w] }));
}

export type PriceMove = PricePoint & { prev: bigint; up: boolean };

/** The swaps that moved world `w`'s pool, newest first: each one's price after it and the move. */
export function priceMoves(impact: readonly ImpactPoint[], w: number): PriceMove[] {
  const line = priceLine(impact, w);
  const out: PriceMove[] = [];
  for (let i = 1; i < line.length; i++) {
    if (line[i].price !== line[i - 1].price) out.push({ ...line[i], prev: line[i - 1].price, up: line[i].price > line[i - 1].price });
  }
  return out.reverse();
}
