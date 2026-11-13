// The protocol model from the design doc, as a small in-browser store (demo only; the NEAR
// contracts replace this later). Every market is a scenario of 1 to 4 yes/no events. Their combined
// outcomes are the worlds, one bit each, and a verse is any set of worlds, written as a bitmask.
//   bit of a world = its outcomes read as a binary number, first event as the highest bit
//   for the demo scenario: bit 0 Ships & cuts, bit 1 Ships & holds, bit 2 Delayed & cuts, bit 3 Delayed & holds
// Debt is real USDC, the same in every world. Health is measured in the worst possible world.
// Every function above the store is pure, so the invariant tests can replay random sequences.
import { useSyncExternalStore } from 'react'
import { demoMarkets } from '../data/demo'
import type { Market, ScenarioEvent, World } from './types'

export const FEE = 0.003 // a world pool's base swap fee (0.30%; it rises to 1.50% when recent trading is one-sided)
export const HAIRCUT_NEAR = 0 // NEAR counts at its full price in each world, as in the contract
export const HAIRCUT_USDC = 0 // USDC counts in full
export const LLTV = 0.75
export const DISPUTE_MS = 30_000 // the dispute window: 30 seconds, as on the testnet contract
export const DEMO_PRICE_DROP = 2 // the doc's stress test: NEAR falls to $2 in the cheapest worlds
const SEED = { near: 50_000, usdc: 300_000 } // each world's pool, seeded once at the root

export type Proposal = { outcome: number; at: number } // proposed by the resolver agent, at a time
export type Scenario = {
  id: string
  near: number[] // NEAR you hold in each world
  usdc: number[] // USDC you hold in each world
  poolNear: number[] // NEAR in each world's pool
  poolUsdc: number[] // USDC in each world's pool
  reserves: { near: number; usdc: number } // real assets locked in the verse contract
  debt: number // real USDC borrowed (the same in every world)
  price: number[] // reference NEAR price in each world (from its pool)
  shocked: boolean
  possible: number // worlds still possible, as a mask
  proposals: (Proposal | null)[] // one per event, while its dispute window runs
  settled: (number | null)[] // the final outcome of each event, once finalized
  others: { near: number[]; usdc: number[] } // what other traders hold in each world, resting orders' escrow included
  lp: number // USDC you put into every world's pool at once (Root LP)
  lpFees: number // your share of the swap fees those pools have taken
  claimed: { near: number; usdc: number; repaid: number; lp: number } | null
  log: string[]
}
export type LendingPool = { supplied: number; borrowed: number; lent: number } // one real-USDC pool for everything
export type Wallet = { near: number; usdc: number } // real wNEAR and USDC in your wallet, outside the contract
// a resting order for NEAR inside one world, priced in USDC of that world. A bid escrows USDC-if-world, an ask
// escrows NEAR-if-world; both wait in the book until someone accepts or the owner cancels.
export type Order = { id: number; scenario: string; world: number; side: 'bid' | 'ask'; price: number; amount: number; owner: string }
export const YOU = 'you'
export const FAUCET = { near: 2_000, usdc: 5_000 } // what "Get test tokens" mints, as the testnet mock tokens do

// ---------- masks ----------
export const has = (mask: number, bit: number) => (mask & (1 << bit)) !== 0
export const worldCount = (m: Market) => m.worlds.length
export const fullMask = (m: Market) => (1 << m.worlds.length) - 1
export const bits = (m: Market, mask: number) => mask.toString(2).padStart(m.worlds.length, '0')
export const count = (mask: number) => { let n = 0; for (let x = mask; x; x &= x - 1) n++; return n }
export const bitsOf = (mask: number, n: number) => Array.from({ length: n }, (_, b) => b).filter((b) => has(mask, b))
// which outcome event e has in world b
export const outcomeIn = (m: Market, e: number, b: number) => (b >> (m.events.length - 1 - e)) & 1
// every world where event e has outcome o
export const outcomeMask = (m: Market, e: number, o: number) =>
  m.worlds.reduce((mask, _, b) => (outcomeIn(m, e, b) === o ? mask | (1 << b) : mask), 0)

export function shapeName(m: Market, mask: number) {
  const n = count(mask)
  if (n === 0) return 'Nothing selected'
  if (mask === fullMask(m)) return 'Every world'
  if (n === 1) return m.worlds[bitsOf(mask, m.worlds.length)[0]].outcome
  const single: { label: string; mask: number }[] = m.events.flatMap((ev, e) => ev.outcomes.map((o, k) => ({ label: o, mask: outcomeMask(m, e, k) })))
  const one = single.find((x) => x.mask === mask)
  if (one) return `Every “${one.label}” world`
  for (const a of single) for (const b of single) {
    if (a !== b && (a.mask | b.mask) === mask) {
      const name = `${a.label} or ${b.label.toLowerCase()}`
      return m.events.length === 2 && n === 3 ? `L-shape: ${name.toLowerCase()}` : name
    }
  }
  return 'Custom shape'
}

// quick picks for the grid: everything but the first world, then the second outcome of each event
export function presets(m: Market) {
  const masks = [fullMask(m) ^ 1, ...m.events.map((_, e) => outcomeMask(m, e, 1))]
  return [...new Set(masks)].map((mask) => ({ mask, label: shapeName(m, mask) }))
}

// rows and columns of the grid: the first half of the events down the side, the rest across the top
export function gridOf(m: Market) {
  const n = m.events.length
  const r = Math.floor(n / 2), c = n - r
  const label = (evs: ScenarioEvent[], idx: number) => evs.map((ev, k) => ev.outcomes[(idx >> (evs.length - 1 - k)) & 1]).join(' · ')
  const rowEvents = m.events.slice(0, r), colEvents = m.events.slice(r)
  return {
    rows: Array.from({ length: 1 << r }, (_, i) => ({ label: r ? label(rowEvents, i) : '', bits: Array.from({ length: 1 << c }, (_, j) => (i << c) | j) })),
    cols: Array.from({ length: 1 << c }, (_, j) => label(colEvents, j)),
    rowTitle: rowEvents.map((e) => e.name).join(' · '),
    colTitle: colEvents.map((e) => e.name).join(' · '),
  }
}

// ---------- values ----------
const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
const live = (s: Scenario) => s.price.map((_, w) => w).filter((w) => has(s.possible, w))
// what the collateral counts for in one world: NEAR at that world's price, USDC in full
export const backing = (s: Scenario, w: number) => s.near[w] * s.price[w] * (1 - HAIRCUT_NEAR) + s.usdc[w] * (1 - HAIRCUT_USDC)
export const worth = (s: Scenario, w: number) => s.near[w] * s.price[w] + s.usdc[w]
export function worstWorld(s: Scenario) {
  let worst = -1
  for (const w of live(s)) if (worst < 0 || backing(s, w) < backing(s, worst)) worst = w
  return worst
}
export const maxBorrow = (s: Scenario) => {
  const w = worstWorld(s)
  return w < 0 ? 0 : LLTV * backing(s, w)
}
export const health = (s: Scenario, debt = s.debt) => (debt <= 0 ? null : maxBorrow(s) / debt)
export const holdsAnything = (s: Scenario) => s.debt > 0 || s.lp > 0 || live(s).some((w) => s.near[w] > 0 || s.usdc[w] > 0)

// odds of the worlds still possible, renormalized
export function liveOdds(m: Market, s: Scenario) {
  const total = m.worlds.reduce((t, w, b) => t + (has(s.possible, b) ? w.chance : 0), 0)
  return m.worlds.map((w, b) => (has(s.possible, b) && total > 0 ? w.chance / total : 0))
}
// spot NEAR must equal the odds-weighted world prices; arbitrage between the pools keeps it there
export const spotPrice = (m: Market, s: Scenario) => liveOdds(m, s).reduce((t, p, b) => t + p * s.price[b], 0)

// the backing rule: in every still-possible world, what holders and pools hold adds up to the reserves
export function backingCheck(s: Scenario) {
  const ok = (a: number, b: number) => Math.abs(a - b) < 1e-6 * Math.max(1, b)
  return live(s).map((w) => ({
    world: w,
    ok: ok(s.near[w] + s.poolNear[w] + s.others.near[w], s.reserves.near) && ok(s.usdc[w] + s.poolUsdc[w] + s.others.usdc[w], s.reserves.usdc),
  }))
}

// lending: one fixed borrow rate, 5% a year, as in the contract; lenders earn what borrowers pay, spread over the pool
export const BORROW_RATE = 0.05
export function rates(pool: LendingPool) {
  const u = pool.borrowed / Math.max(1, pool.supplied)
  return { use: u, borrow: BORROW_RATE, supply: BORROW_RATE * u }
}

// ---------- pure steps ----------
export function fresh(m: Market, nearPerWorld = 0): Scenario {
  const n = m.worlds.length
  let s: Scenario = {
    id: m.id,
    near: Array(n).fill(0), usdc: Array(n).fill(0),
    poolNear: Array(n).fill(SEED.near), poolUsdc: Array(n).fill(SEED.usdc),
    reserves: { ...SEED },
    debt: 0,
    price: m.worlds.map((w) => w.nearPrice),
    shocked: false,
    possible: fullMask(m),
    proposals: m.events.map(() => null),
    settled: m.events.map(() => null),
    others: { near: Array(n).fill(0), usdc: Array(n).fill(0) },
    lp: 0,
    lpFees: 0,
    claimed: null,
    log: [],
  }
  if (nearPerWorld) s = deposit(s, 'near', nearPerWorld)
  for (const [e, o] of m.settled ?? []) s = finalize(m, s, e, o)
  return { ...s, log: [] }
}
const note = (s: Scenario, text: string): Scenario => ({ ...s, log: [text, ...s.log].slice(0, 6) })

// deposit real NEAR or USDC and push it down into every world still possible
export function deposit(s: Scenario, asset: 'near' | 'usdc', amount: number): Scenario {
  if (!(amount > 0)) return s
  const add = (xs: number[]) => xs.map((x, w) => (has(s.possible, w) ? x + amount : x))
  return asset === 'near'
    ? { ...s, near: add(s.near), reserves: { ...s.reserves, near: s.reserves.near + amount } }
    : { ...s, usdc: add(s.usdc), reserves: { ...s.reserves, usdc: s.reserves.usdc + amount } }
}

// another trader deposits real assets and pushes them down into every world still possible
export function othersDeposit(s: Scenario, near: number, usdc: number): Scenario {
  const add = (xs: number[], a: number) => xs.map((x, w) => (has(s.possible, w) ? x + a : x))
  return {
    ...s,
    others: { near: add(s.others.near, near), usdc: add(s.others.usdc, usdc) },
    reserves: { near: s.reserves.near + near, usdc: s.reserves.usdc + usdc },
  }
}
// move NEAR-if-world and USDC-if-world between you and the other traders (an order posted, cancelled or filled)
export function trade(s: Scenario, w: number, nearToYou: number, usdcToYou: number): Scenario {
  const at = (xs: number[], d: number) => xs.map((x, k) => (k === w ? x + d : x))
  return {
    ...s,
    near: at(s.near, nearToYou), usdc: at(s.usdc, usdcToYou),
    others: { near: at(s.others.near, -nearToYou), usdc: at(s.others.usdc, -usdcToYou) },
  }
}

// the hedge: sell NEAR for USDC of the same world, through that world's pool, in every chosen world
export function hedged(s: Scenario, mask: number): Scenario {
  const near = [...s.near], usdc = [...s.usdc], poolNear = [...s.poolNear], poolUsdc = [...s.poolUsdc]
  let lpFees = s.lpFees
  for (const w of live(s)) {
    if (!has(mask, w) || near[w] <= 0) continue
    const out = Math.min(poolUsdc[w], near[w] * s.price[w] * (1 - FEE))
    lpFees += s.lp > 0 ? near[w] * s.price[w] * FEE * (s.lp / poolUsdc[w]) : 0
    poolNear[w] += near[w]; poolUsdc[w] -= out
    usdc[w] += out; near[w] = 0
  }
  return { ...s, near, usdc, poolNear, poolUsdc, lpFees }
}

// Root LP: one USDC deposit adds the same depth to the pool of every world still possible
export function addLiquidity(s: Scenario, amount: number): Scenario {
  if (!(amount > 0)) return s
  return {
    ...s,
    poolUsdc: s.poolUsdc.map((x, w) => (has(s.possible, w) ? x + amount : x)),
    reserves: { ...s.reserves, usdc: s.reserves.usdc + amount },
    lp: s.lp + amount,
  }
}

export const canBorrow = (s: Scenario, amount: number) => amount > 0 && s.debt + amount <= maxBorrow(s) + 0.01

export function movePrice(s: Scenario, price: number[], shocked: boolean): Scenario {
  return { ...s, price, shocked }
}

// finalize one event: one AND against the still-possible mask. Only removes worlds, so health can only rise.
export function finalize(m: Market, s: Scenario, e: number, o: number): Scenario {
  const settled = [...s.settled]; settled[e] = o
  const proposals = [...s.proposals]; proposals[e] = null
  return { ...s, possible: s.possible & outcomeMask(m, e, o), settled, proposals }
}

// once one world is left it collapses into the real assets; the loan is repaid from them
export function claimAll(s: Scenario): Scenario {
  if (count(s.possible) !== 1) return s
  const w = live(s)[0]
  const gotNear = s.near[w], gotUsdc = s.usdc[w]
  let usdcAfterLoan = gotUsdc - s.debt
  let near = gotNear
  // not enough USDC to repay? sell just enough NEAR (at the world's price, less the fee) to cover the rest
  if (usdcAfterLoan < 0) {
    near = Math.max(0, near + usdcAfterLoan / (s.price[w] * (1 - FEE)))
    usdcAfterLoan = 0
  }
  const zero = (xs: number[]) => xs.map((x, k) => (k === w ? 0 : x))
  // the root LP collapses back to plain USDC in the world that happened, with its share of fees
  const lpBack = Math.min(s.lp + s.lpFees, s.poolUsdc[w])
  return {
    ...s,
    near: zero(s.near), usdc: zero(s.usdc),
    poolUsdc: s.poolUsdc.map((x, k) => (k === w ? x - lpBack : x)),
    reserves: { near: s.reserves.near - gotNear, usdc: s.reserves.usdc - gotUsdc - lpBack },
    claimed: { near, usdc: usdcAfterLoan, repaid: s.debt, lp: lpBack },
    lp: 0,
    lpFees: 0,
    debt: 0,
  }
}

// ---------- invariant tests, run on screen ----------
export type TestReport = { sequences: number; steps: number; checks: { name: string; failures: number }[] }
export function runInvariantTests(m: Market, sequences = 2000): TestReport {
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const pick = (n: number) => Math.floor(rnd() * n)
  const checks = { backing: 0, resolve: 0, solvent: 0 }
  let steps = 0
  const full = fullMask(m)
  for (let i = 0; i < sequences; i++) {
    let s: Scenario = { ...fresh(m), possible: full, settled: m.events.map(() => null) }
    const length = 4 + pick(10)
    for (let k = 0; k < length; k++) {
      steps++
      const op = pick(7)
      if (op === 6) s = addLiquidity(s, 1 + pick(50_000))
      else if (op === 0) s = deposit(s, 'near', 1 + pick(5000))
      else if (op === 1) s = deposit(s, 'usdc', 1 + pick(20_000))
      else if (op === 2) s = hedged(s, pick(full + 1))
      else if (op === 3) { const a = rnd() * maxBorrow(s) - s.debt; if (canBorrow(s, a)) s = { ...s, debt: s.debt + a } }
      else if (op === 4) {
        const open = m.events.map((_, e) => e).filter((e) => s.settled[e] === null)
        if (open.length) {
          const before = health(s), worstBefore = worstWorld(s) < 0 ? 0 : backing(s, worstWorld(s))
          s = finalize(m, s, open[pick(open.length)], pick(2))
          const after = health(s), worstAfter = backing(s, worstWorld(s))
          if ((before !== null && after! < before - 1e-9) || worstAfter < worstBefore - 1e-9) checks.resolve++
          if (before !== null && before >= 1 && after! < 1) checks.solvent++
        }
      } else s = claimAll(s)
      if (backingCheck(s).some((c) => !c.ok)) checks.backing++
    }
  }
  return {
    sequences, steps,
    checks: [
      { name: 'Backing rule holds in every possible world after every step', failures: checks.backing },
      { name: 'Resolution never lowers health or the worst world, in any order', failures: checks.resolve },
      { name: 'A solvent loan stays solvent through resolution', failures: checks.solvent },
    ],
  }
}

// every combination of outcomes is a world: even odds, every world starting at today's NEAR price
export function buildWorlds(events: ScenarioEvent[]): World[] {
  const n = events.length
  return Array.from({ length: 1 << n }, (_, b) => ({
    id: `w${b}`,
    outcome: events.map((ev, e) => ev.outcomes[(b >> (n - 1 - e)) & 1]).join(' & '),
    chance: 1 / (1 << n),
    nearPrice: 3.22,
  }))
}

// ---------- the store ----------
// one of your trades against a resting order: which way you went, at what price, and when
export type Fill = { scenario: string; world: number; side: 'buy' | 'sell'; price: number; amount: number; at: number; with: string }
// one line of the account's activity, with when it happened and which market it touched (null: the lending pool or wallet)
export type Event = { at: number; scenario: string | null; text: string; kind: 'trade' | 'loan' | 'lend' | 'resolve' | 'wallet' | 'other' }
type Store = { markets: Market[]; sc: Record<string, Scenario>; pool: LendingPool; wallet: Wallet; orders: Order[]; nextOrder: number; fills: Fill[]; history: Event[] }
const ALICE_NEAR = 1000 // the demo wallet arrives with 1,000 NEAR pushed down into the demo scenario

// the demo scenario's order book, as the contract's seed has it: Ravi bids 2.45 for 1,000 NEAR in Delayed & holds,
// and quotes 3.60 / 3.75 in Ships & cuts; Sam and Uma add a little depth elsewhere. Their assets come in at the root.
const BOOK: Omit<Order, 'id' | 'scenario'>[] = [
  { world: 0, side: 'ask', price: 3.75, amount: 1_000, owner: 'ravi' },
  { world: 0, side: 'bid', price: 3.6, amount: 1_000, owner: 'ravi' },
  { world: 1, side: 'ask', price: 3.38, amount: 500, owner: 'uma' },
  { world: 1, side: 'bid', price: 3.25, amount: 600, owner: 'sam' },
  { world: 2, side: 'ask', price: 3.08, amount: 400, owner: 'ravi' },
  { world: 2, side: 'bid', price: 2.94, amount: 800, owner: 'sam' },
  { world: 3, side: 'bid', price: 2.45, amount: 1_000, owner: 'ravi' },
  // more depth behind the best quotes, so each world's book reads as a ladder. Every world's resting escrow stays
  // inside what the other traders deposited (6,000 NEAR and 15,000 USDC per world).
  ...[3.7, 3.3, 3.0, 2.5].flatMap((p, world) => [1, 2, 3, 4, 5, 6].flatMap((k) => [
    { world, side: 'ask' as const, price: Math.round(p * (1.02 + 0.006 * k) * 100) / 100, amount: [180, 420, 260, 650, 310, 540][k - 1], owner: ['sam', 'uma', 'dana', 'ravi', 'bob', 'uma'][k - 1] },
    { world, side: 'bid' as const, price: Math.round(p * (0.98 - 0.006 * k) * 100) / 100, amount: [240, 380, 150, 520, 300, 460][k - 1], owner: ['uma', 'dana', 'sam', 'bob', 'ravi', 'sam'][k - 1] },
  ])),
]
function seed(m: Market, firstId: number): { s: Scenario; orders: Order[] } {
  const demo = m.id === 'ships-fed'
  let sc = fresh(m, demo ? ALICE_NEAR : 0)
  if (!demo) return { s: sc, orders: [] }
  sc = { ...othersDeposit(sc, 6_000, 15_000), log: [] }
  return { s: sc, orders: BOOK.map((o, k) => ({ ...o, id: firstId + k, scenario: m.id })) }
}
const initial = (): Store => {
  let nextOrder = 1
  const sc: Record<string, Scenario> = {}
  const orders: Order[] = []
  for (const m of demoMarkets) {
    const b = seed(m, nextOrder)
    sc[m.id] = b.s
    orders.push(...b.orders)
    nextOrder += b.orders.length
  }
  return { markets: demoMarkets, sc, pool: { supplied: 920_000, borrowed: 251_500, lent: 0 }, wallet: { near: 0, usdc: 0 }, orders, nextOrder, fills: [], history: [] }
}
let store = initial()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const sub = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
// the server renders the starting state; the browser then takes over
const first = store
export const useStore = () => useSyncExternalStore(sub, () => store, () => first)
export const useScenario = (id: string) => useSyncExternalStore(sub, () => store.sc[id], () => first.sc[id] ?? store.sc[id])
export const getMarket = (id: string) => store.markets.find((m) => m.id === id)
// the resting orders of one world, best first: asks lowest first, bids highest first
export function bookOf(orders: Order[], scenario: string, world: number) {
  const here = orders.filter((o) => o.scenario === scenario && o.world === world && o.amount > 1e-9)
  return {
    asks: here.filter((o) => o.side === 'ask').sort((a, b) => a.price - b.price),
    bids: here.filter((o) => o.side === 'bid').sort((a, b) => b.price - a.price),
  }
}

const market = (id: string) => store.markets.find((m) => m.id === id)!
// every action with a message lands in the account's history and is announced to the toasts
const kindOf = (t: string): Event['kind'] =>
  /propos|finaliz|resolved|disput|redeem/i.test(t) ? 'resolve' : /borrow|repaid/i.test(t) ? 'loan' : /supplied|withdrew|liquidity/i.test(t) ? 'lend' : /sold|bought|bid|ask|order/i.test(t) ? 'trade' : /test tokens|deposit/i.test(t) ? 'wallet' : 'other'
const toastListeners = new Set<(e: Event) => void>()
/** Subscribe to every action's message, for the toasts. */
export const onEvent = (l: (e: Event) => void) => { toastListeners.add(l); return () => { toastListeners.delete(l) } }
function record(scenario: string | null, text: string) {
  const e: Event = { at: Date.now(), scenario, text, kind: kindOf(text) }
  store = { ...store, history: [e, ...store.history].slice(0, 200) }
  toastListeners.forEach((l) => l(e))
}
function put(id: string, next: Scenario, text?: string, pool?: LendingPool, wallet?: Wallet, orders?: Order[]) {
  store = { ...store, sc: { ...store.sc, [id]: text ? note(next, text) : next }, pool: pool ?? store.pool, wallet: wallet ?? store.wallet, orders: orders ?? store.orders }
  if (text) record(id, text)
  emit()
}
const VIA_WALLET = 'from your NEAR wallet' // a deposit from the wallet spends its balance; Intents deposits arrive from elsewhere

export const actions = {
  // "Get test tokens": mint 2,000 wNEAR and 5,000 USDC to your wallet, skipping a token you already hold that much of
  faucet() {
    const w = store.wallet
    store = { ...store, wallet: { near: w.near < FAUCET.near ? w.near + FAUCET.near : w.near, usdc: w.usdc < FAUCET.usdc ? w.usdc + FAUCET.usdc : w.usdc } }
    record(null, `Minted test tokens to your wallet: up to ${fmt(FAUCET.near)} wNEAR and ${fmt(FAUCET.usdc)} USDC.`)
    emit()
  },
  deposit(id: string, asset: 'near' | 'usdc', amount: number, via: string) {
    const s = store.sc[id]
    if (!(amount > 0) || s.possible === 0) return
    const fromWallet = via === VIA_WALLET
    if (fromWallet && amount > store.wallet[asset] + 1e-9) return
    const wallet = fromWallet ? { ...store.wallet, [asset]: store.wallet[asset] - amount } : store.wallet
    put(id, deposit(s, asset, amount), `Deposited ${fmt(amount)} ${asset.toUpperCase()} ${via} and pushed it down into every world still possible.`, undefined, wallet)
  },
  sell(id: string, mask: number) {
    const m = market(id), s = store.sc[id]
    const live = mask & s.possible
    if (!count(live)) return
    put(id, hedged(s, live), `Sold NEAR in: ${shapeName(m, live)} (mask ${bits(m, live)}) for USDC of the same worlds.`)
  },
  borrow(id: string, amount: number) {
    const s = store.sc[id]
    if (!canBorrow(s, amount)) return
    const p = store.pool
    const wallet = { ...store.wallet, usdc: store.wallet.usdc + amount }
    put(id, { ...s, debt: s.debt + amount }, `Borrowed ${fmt(amount)} real USDC from the lending pool, into your wallet.`, { ...p, borrowed: p.borrowed + amount }, wallet)
  },
  // repaid from your wallet's USDC
  repay(id: string, amount: number) {
    const s = store.sc[id]
    const a = Math.min(amount, s.debt, store.wallet.usdc)
    if (a <= 0) return
    const p = store.pool
    put(id, { ...s, debt: s.debt - a }, `Repaid ${fmt(a)} USDC from your wallet.`, { ...p, borrowed: p.borrowed - a }, { ...store.wallet, usdc: store.wallet.usdc - a })
  },
  addLiquidity(id: string, amount: number) {
    const s = store.sc[id]
    if (!(amount > 0) || count(s.possible) <= 1 || amount > store.wallet.usdc + 1e-9) return
    put(id, addLiquidity(s, amount), `Added ${fmt(amount)} USDC of liquidity to every world's pool at once.`, undefined, { ...store.wallet, usdc: store.wallet.usdc - amount })
  },
  lend(amount: number) {
    if (!(amount > 0) || amount > store.wallet.usdc + 1e-9) return
    store = { ...store, pool: { ...store.pool, supplied: store.pool.supplied + amount, lent: store.pool.lent + amount }, wallet: { ...store.wallet, usdc: store.wallet.usdc - amount } }
    record(null, `Supplied ${fmt(amount)} USDC to the lending pool.`)
    emit()
  },
  // take supplied USDC back, from the part of the pool that isn't lent out
  withdraw(amount: number) {
    const p = store.pool
    const a = Math.min(amount, p.lent, p.supplied - p.borrowed)
    if (!(a > 0)) return
    store = { ...store, pool: { ...p, supplied: p.supplied - a, lent: p.lent - a }, wallet: { ...store.wallet, usdc: store.wallet.usdc + a } }
    record(null, `Withdrew ${fmt(a)} USDC from the lending pool to your wallet.`)
    emit()
  },
  // the doc's stress test: NEAR falls to $2 in the worlds where it's cheapest
  shock(id: string, on: boolean) {
    const m = market(id), s = store.sc[id]
    const base = m.worlds.map((w) => w.nearPrice)
    const low = Math.min(...base)
    const price = on ? base.map((p) => (p === low ? Math.min(p, DEMO_PRICE_DROP) : p)) : base
    put(id, movePrice(s, price, on), on ? `NEAR fell to $${DEMO_PRICE_DROP} in the worlds where it was $${low}.` : `NEAR back to $${low} in those worlds.`)
  },
  // the reporter proposes a result with its evidence; then the dispute window runs, and trading in the scenario pauses
  propose(id: string, e: number, o: number) {
    const m = market(id), s = store.sc[id]
    const ev = m.events[e]
    const proposals = [...s.proposals]; proposals[e] = { outcome: o, at: Date.now() }
    put(id, { ...s, proposals }, `Reporter proposed “${ev.outcomes[o]}” for ${ev.name}, with evidence from ${ev.sources[0]}. Dispute window open.`)
  },
  // the owner resolves an event at once, with no dispute window
  adminResolve(id: string, e: number, o: number) {
    const m = market(id), s = store.sc[id]
    const ev = m.events[e]
    put(id, finalize(m, s, e, o), `Owner resolved ${ev.name} → ${ev.outcomes[o]}. The other worlds closed at zero.`)
  },
  // the owner moves NEAR's price in one world (on testnet, by trading into that world's pool)
  setPrice(id: string, w: number, price: number) {
    const m = market(id), s = store.sc[id]
    if (!(price > 0)) return
    const next = s.price.map((x, k) => (k === w ? price : x))
    put(id, movePrice(s, next, false), `Owner moved NEAR to $${price.toFixed(2)} in ${m.worlds[w].outcome}.`)
  },
  // ---------- the order book ----------
  postOrder(id: string, w: number, side: 'bid' | 'ask', price: number, amount: number) {
    const m = market(id), s = store.sc[id]
    if (!(price > 0) || !(amount > 0) || !has(s.possible, w) || s.proposals.some(Boolean)) return
    const escrow = side === 'bid' ? price * amount : amount
    if (escrow > (side === 'bid' ? s.usdc[w] : s.near[w]) + 1e-9) return
    const order: Order = { id: store.nextOrder, scenario: id, world: w, side, price, amount, owner: YOU }
    const next = side === 'bid' ? trade(s, w, 0, -escrow) : trade(s, w, -escrow, 0)
    store = { ...store, nextOrder: store.nextOrder + 1 }
    put(id, next, `Posted a ${side} in ${m.worlds[w].outcome}: ${fmt(amount)} NEAR at $${price.toFixed(2)}.`, undefined, undefined, [...store.orders, order])
  },
  cancelOrder(orderId: number) {
    const o = store.orders.find((x) => x.id === orderId)
    if (!o || o.owner !== YOU) return
    const m = market(o.scenario), s = store.sc[o.scenario]
    const next = o.side === 'bid' ? trade(s, o.world, 0, o.price * o.amount) : trade(s, o.world, o.amount, 0)
    put(o.scenario, next, `Cancelled your ${o.side} in ${m.worlds[o.world].outcome}; the escrow came back.`, undefined, undefined, store.orders.filter((x) => x.id !== orderId))
  },
  // accept someone else's resting order, all or part of it
  takeOrder(orderId: number, amount: number) {
    const o = store.orders.find((x) => x.id === orderId)
    if (!o || o.owner === YOU || !(amount > 0) || amount > o.amount + 1e-9) return
    const m = market(o.scenario), s = store.sc[o.scenario]
    if (!has(s.possible, o.world) || s.proposals.some(Boolean)) return
    const cost = o.price * amount
    // their bid: you sell NEAR-if-world for their USDC; their ask: you buy NEAR-if-world with your USDC
    if (o.side === 'bid' ? amount > s.near[o.world] + 1e-9 : cost > s.usdc[o.world] + 1e-9) return
    const next = o.side === 'bid' ? trade(s, o.world, -amount, cost) : trade(s, o.world, amount, -cost)
    const orders = store.orders.map((x) => (x.id === orderId ? { ...x, amount: x.amount - amount } : x)).filter((x) => x.amount > 1e-9)
    const fill: Fill = { scenario: o.scenario, world: o.world, side: o.side === 'bid' ? 'sell' : 'buy', price: o.price, amount, at: Date.now(), with: o.owner }
    store = { ...store, fills: [fill, ...store.fills] }
    put(o.scenario, next, `${o.side === 'bid' ? 'Sold' : 'Bought'} ${fmt(amount)} NEAR in ${m.worlds[o.world].outcome} at $${o.price.toFixed(2)} from ${o.owner}'s ${o.side}.`, undefined, undefined, orders)
  },
  dispute(id: string, e: number) {
    const m = market(id), s = store.sc[id]
    const proposals = [...s.proposals]; proposals[e] = null
    put(id, { ...s, proposals }, `The proposal for ${m.events[e].name} was disputed and withdrawn.`)
  },
  finalize(id: string, e: number) {
    const m = market(id), s = store.sc[id]
    const p = s.proposals[e]
    if (!p) return
    const ev = m.events[e]
    put(id, finalize(m, s, e, p.outcome), `Finalized: ${ev.name} → ${ev.outcomes[p.outcome]}. The other worlds closed at zero.`)
  },
  // close and redeem, in one step: repay the loan, take every collateral piece back, redeem what collapsed into your wallet
  claimAll(id: string) {
    const m = market(id), s = store.sc[id]
    if (count(s.possible) !== 1) return
    const w = bitsOf(s.possible, m.worlds.length)[0]
    const next = claimAll(s)
    const p = store.pool
    const c = next.claimed!
    const wallet = { near: store.wallet.near + c.near, usdc: store.wallet.usdc + c.usdc + c.lp }
    put(id, next, `Closed and redeemed: repaid ${fmt(c.repaid)} USDC, and ${fmt(c.near)} NEAR and ${fmt(c.usdc + c.lp)} USDC from the “${m.worlds[w].outcome}” world went to your wallet.`, { ...p, borrowed: p.borrowed - s.debt }, wallet)
  },
  reset(id: string) {
    const m = market(id)
    const p = store.pool
    const b = seed(m, store.nextOrder)
    store = { ...store, nextOrder: store.nextOrder + b.orders.length }
    put(id, b.s, undefined, { ...p, borrowed: p.borrowed - store.sc[id].debt }, undefined, [...store.orders.filter((o) => o.scenario !== id), ...b.orders])
  },
  // a new scenario of one or two yes/no events
  createMarket(question: string, events: ScenarioEvent[], resolves: string): Market {
    const base = question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'market'
    let id = base
    for (let k = 2; store.markets.some((m) => m.id === id); k++) id = `${base}-${k}`
    const m: Market = { id, question, category: 'New', resolves, events, worlds: buildWorlds(events) }
    store = { ...store, markets: [...store.markets, m], sc: { ...store.sc, [id]: fresh(m) } }
    emit()
    return m
  },
}
