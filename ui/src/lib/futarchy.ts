// Decision markets (futarchy), as a small in-browser model until the core contract's futarchy module is live.
// A proposal has two branches, Pass and Fail. Depositing USDC splits it into USDC-if-pass and USDC-if-fail,
// and each branch has its own NEAR pool. When trading closes, the branch where NEAR is worth more decides:
// that branch becomes real, and every trade in the other branch is undone.
import { useSyncExternalStore } from 'react'

export type Branch = 'pass' | 'fail'
export const BRANCHES: Branch[] = ['pass', 'fail']
const FEE = 0.01
const TRADING_MS = 10 * 60_000 // the demo closes trading ten minutes after the page loads

type Pool = { near: number; usdc: number } // constant product: price = usdc / near
// As MetaDAO decides: each branch's price is averaged over time (TWAP), and the proposal passes only if the pass
// average beats the fail average by a margin, so a last-minute trade can't flip the result.
export const THRESHOLD = 0.03
const OBS = 48 // observations in the averaging window
type Obs = { at: number; price: number }
export type Proposal = {
  id: number
  question: string
  detail: string
  ifPass: string // what happens if it passes
  author: string
  closesAt: number
  pools: Record<Branch, Pool>
  obs: Record<Branch, Obs[]> // the price of NEAR in each branch over time, newest last
  wallet: number // real USDC, not yet split
  held: Record<Branch, { near: number; usdc: number }> // what you hold inside each branch
  decided: Branch | null
  log: string[]
}

// a seeded walk ending at `last`, so each branch opens with some history to average over
function walk(last: number, seed: number, now: number): Obs[] {
  let a = seed >>> 0
  const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296 }
  const v = [last]
  for (let i = 1; i < OBS; i++) v.unshift(v[0] * (1 + (r() - 0.5) * 0.02))
  return v.map((price, i) => ({ at: now - (OBS - 1 - i) * 60_000, price }))
}

const initial = (): Proposal => {
  const now = Date.now()
  return {
    id: 7,
    question: 'Should the NEAR DAO fund a $2M Intents liquidity grant?',
    detail: 'The grant would seed deeper pools for cross-chain deposits. Traders price NEAR in the future where it passes and the future where it fails; the markets, not a vote, decide.',
    ifPass: '$2M from the DAO treasury goes to market makers on NEAR Intents over six months, paid monthly against volume targets.',
    author: 'grants.near-dao.testnet',
    closesAt: now + TRADING_MS,
    pools: { pass: { near: 10_000, usdc: 51_000 }, fail: { near: 10_000, usdc: 47_000 } },
    obs: { pass: walk(5.1, 11, now), fail: walk(4.7, 23, now) },
    wallet: 2_000,
    held: { pass: { near: 0, usdc: 0 }, fail: { near: 0, usdc: 0 } },
    decided: null,
    log: [],
  }
}

/** Earlier proposals, decided the same way (demo history). */
export const PAST = [
  { id: 6, question: 'Raise the loan-to-value limit from 75% to 80%?', result: 'fail' as Branch, margin: -0.012, closed: '9 Nov 2026', volume: 184_000 },
  { id: 5, question: 'Open a “SPICE only” market beside SPICE × Fed?', result: 'pass' as Branch, margin: 0.051, closed: '3 Nov 2026', volume: 241_000 },
  { id: 4, question: 'Send 20% of swap fees to an insurance fund?', result: 'pass' as Branch, margin: 0.037, closed: '27 Oct 2026', volume: 312_000 },
]

let state = initial()
const listeners = new Set<() => void>()
const set = (next: Partial<Proposal>, note?: string) => {
  state = { ...state, ...next, log: note ? [note, ...state.log].slice(0, 5) : state.log }
  listeners.forEach((l) => l())
}
export const useProposal = () =>
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => state, () => state)

export const price = (p: Pool) => p.usdc / p.near
/** The time-weighted average of a branch's price over the window. */
export const twap = (s: Proposal, b: Branch) => { const o = s.obs[b].slice(-OBS); return o.reduce((t, x) => t + x.price, 0) / o.length }
/** How far the pass average is above the fail average, as a fraction. */
export const margin = (s: Proposal) => twap(s, 'pass') / twap(s, 'fail') - 1
/** Pass needs its average at least THRESHOLD above fail's; otherwise the status quo (fail) wins. */
export const leader = (s: Proposal): Branch => (margin(s) >= THRESHOLD ? 'pass' : 'fail')
// record the new price of a branch after a trade, as the TWAP oracle does
const observe = (s: Proposal, b: Branch, pools: Record<Branch, Pool>) => ({ ...s.obs, [b]: [...s.obs[b], { at: Date.now(), price: price(pools[b]) }].slice(-OBS * 3) })
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
const name = (b: Branch) => (b === 'pass' ? 'passes' : 'fails')

// what a trade would return, for the preview
export function quoteBuy(p: Pool, usdcIn: number) {
  const k = p.near * p.usdc
  return p.near - k / (p.usdc + usdcIn * (1 - FEE))
}
export function quoteSell(p: Pool, nearIn: number) {
  const k = p.near * p.usdc
  return p.usdc - k / (p.near + nearIn * (1 - FEE))
}

export const futarchy = {
  // split real USDC into both branches: one USDC-if-pass and one USDC-if-fail for each USDC
  split(amount: number) {
    if (!(amount > 0) || amount > state.wallet || state.decided) return
    const held = { pass: { ...state.held.pass, usdc: state.held.pass.usdc + amount }, fail: { ...state.held.fail, usdc: state.held.fail.usdc + amount } }
    set({ wallet: state.wallet - amount, held }, `Split ${fmt(amount)} USDC into both branches.`)
  },
  buy(b: Branch, usdcIn: number) {
    const h = state.held[b]
    if (!(usdcIn > 0) || usdcIn > h.usdc + 1e-9 || state.decided) return
    const out = quoteBuy(state.pools[b], usdcIn)
    const pools = { ...state.pools, [b]: { near: state.pools[b].near - out, usdc: state.pools[b].usdc + usdcIn } }
    const held = { ...state.held, [b]: { near: h.near + out, usdc: h.usdc - usdcIn } }
    set({ pools, held, obs: observe(state, b, pools) }, `Bought ${fmt(out)} NEAR in the world where it ${name(b)}.`)
  },
  sell(b: Branch, nearIn: number) {
    const h = state.held[b]
    if (!(nearIn > 0) || nearIn > h.near + 1e-9 || state.decided) return
    const out = quoteSell(state.pools[b], nearIn)
    const pools = { ...state.pools, [b]: { near: state.pools[b].near + nearIn, usdc: state.pools[b].usdc - out } }
    const held = { ...state.held, [b]: { near: h.near - nearIn, usdc: h.usdc + out } }
    set({ pools, held, obs: observe(state, b, pools) }, `Sold ${fmt(nearIn)} NEAR in the world where it ${name(b)}.`)
  },
  // trading closes: pass wins only if its average beats fail's by the threshold; the other branch's trades are undone
  decide() {
    if (state.decided) return
    const w = leader(state)
    set({ decided: w, closesAt: Math.min(state.closesAt, Date.now()) },
      `The proposal ${name(w)}: the pass average was ${(margin(state) * 100).toFixed(2)}% against fail's (it needed +${(THRESHOLD * 100).toFixed(0)}%). Trades in the other branch were undone.`)
  },
  reset() { state = initial(); listeners.forEach((l) => l()) },
}
