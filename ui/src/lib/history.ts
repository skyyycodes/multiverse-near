// Demo price history for one world's NEAR/USDC pool. The demo has no stored trades, so each world gets a seeded,
// repeatable random walk that ends at the pool's price now. Every candle is labelled demo data where it is shown.
// On chain this comes from the pool's TWAP observations and swap events instead.

export type Interval = '15m' | '1H' | '4H' | '1D' | '1W'
export const INTERVALS: Interval[] = ['15m', '1H', '4H', '1D', '1W']
const SECONDS: Record<Interval, number> = { '15m': 900, '1H': 3600, '4H': 14_400, '1D': 86_400, '1W': 604_800 }
const COUNT = 220 // candles drawn per interval

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number }

// a small seeded generator (mulberry32) so the same world always draws the same history
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }

const cache = new Map<string, Candle[]>()

/** Candles for one world, oldest first, the last one closing at `price`. Bucketed to the interval, ending now. */
export function candles(market: string, world: number, interval: Interval, price: number, now = Date.now()): Candle[] {
  const step = SECONDS[interval]
  const end = Math.floor(now / 1000 / step) * step
  const key = `${market}:${world}:${interval}:${end}`
  let base = cache.get(key)
  if (!base) {
    const r = rng(hash(`${market}:${world}:${interval}`))
    const vol = 0.004 * Math.sqrt(step / 900) // bigger candles for longer intervals
    // walk backwards from 1 so the newest close is exactly the price now; scaled below
    const closes = [1]
    for (let i = 1; i < COUNT; i++) closes.unshift(closes[0] * Math.exp((r() - 0.5) * 2 * vol + Math.sin(i / 17) * vol * 0.35))
    base = closes.map((close, i) => {
      const open = i === 0 ? close * (1 + (r() - 0.5) * vol) : closes[i - 1]
      const wick = vol * (0.3 + r() * 0.9)
      return {
        time: end - (COUNT - 1 - i) * step,
        open, close,
        high: Math.max(open, close) * (1 + wick * r()),
        low: Math.min(open, close) * (1 - wick * r()),
        volume: Math.round((80 + r() * 900) * Math.sqrt(step / 900) * (1 + Math.abs(close - open) / close / vol)),
      }
    })
    cache.set(key, base)
  }
  return base.map((c) => ({ ...c, open: c.open * price, high: c.high * price, low: c.low * price, close: c.close * price }))
}

/** 24-hour figures from the hourly series: change, high, low and volume in NEAR and USDC. */
export function day(market: string, world: number, price: number) {
  const last = candles(market, world, '1H', price).slice(-24)
  const open = last[0].open
  const high = Math.max(...last.map((c) => c.high))
  const low = Math.min(...last.map((c) => c.low))
  const near = last.reduce((t, c) => t + c.volume, 0)
  const usdc = last.reduce((t, c) => t + c.volume * (c.open + c.close) / 2, 0)
  return { change: price - open, pct: (price - open) / open, high, low, near, usdc }
}

/** A few recent trades by other traders around the price, newest first, for the trades list. */
export function tape(market: string, world: number, price: number, now = Date.now(), n = 24) {
  const minute = Math.floor(now / 60_000)
  const r = rng(hash(`${market}:${world}:tape:${minute}`))
  let t = now
  return Array.from({ length: n }, () => {
    t -= Math.floor(4_000 + r() * 50_000)
    const buy = r() > 0.48
    return { price: price * (1 + (r() - 0.5) * 0.006), amount: Math.round((5 + r() * 400) * 100) / 100, at: t, buy }
  })
}

/** Each world's chance over time (0 to 1), oldest first, ending at today's odds. Seeded per market, demo data. */
export function oddsHistory(market: string, odds: number[], points = 160, stepSec = 3 * 3600, now = Date.now()) {
  const r = rng(hash(`${market}:odds`))
  const end = Math.floor(now / 1000 / stepSec) * stepSec
  // walk each world's log-weight backwards from today's odds, then renormalise so every point sums to 1
  const logs = odds.map((p) => [Math.log(Math.max(p, 1e-4))])
  for (let i = 1; i < points; i++) logs.forEach((l) => l.unshift(l[0] + (r() - 0.5) * 0.12))
  return Array.from({ length: points }, (_, i) => {
    const e = logs.map((l) => Math.exp(l[i]))
    const sum = e.reduce((t, x) => t + x, 0)
    return { time: end - (points - 1 - i) * stepSec, p: e.map((x) => x / sum) }
  })
}

/** A generic seeded series ending at `last`, oldest first, for small demo charts (APR, utilization). */
export function series(key: string, last: number, points = 90, vol = 0.03, stepSec = 86_400, now = Date.now()) {
  const r = rng(hash(key))
  const end = Math.floor(now / 1000 / stepSec) * stepSec
  const v = [last]
  for (let i = 1; i < points; i++) v.unshift(Math.max(0, v[0] * (1 + (r() - 0.5) * 2 * vol)))
  return v.map((value, i) => ({ time: end - (points - 1 - i) * stepSec, value }))
}
