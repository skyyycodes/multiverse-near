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
export type Proposal = {
  question: string
  detail: string
  closesAt: number
  pools: Record<Branch, Pool>
  wallet: number // real USDC, not yet split
  held: Record<Branch, { near: number; usdc: number }> // what you hold inside each branch
  decided: Branch | null
  log: string[]
}

const initial = (): Proposal => ({
  question: 'Should the NEAR DAO fund a $2M Intents liquidity grant?',
  detail: 'The grant would seed deeper pools for cross-chain deposits. Traders price NEAR in both futures; the market, not a vote, decides.',
  closesAt: Date.now() + TRADING_MS,
  pools: { pass: { near: 10_000, usdc: 51_000 }, fail: { near: 10_000, usdc: 47_000 } },
  wallet: 2_000,
  held: { pass: { near: 0, usdc: 0 }, fail: { near: 0, usdc: 0 } },
  decided: null,
  log: [],
})

let state = initial()
const listeners = new Set<() => void>()
const set = (next: Partial<Proposal>, note?: string) => {
  state = { ...state, ...next, log: note ? [note, ...state.log].slice(0, 5) : state.log }
  listeners.forEach((l) => l())
}
export const useProposal = () =>
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => state, () => state)

export const price = (p: Pool) => p.usdc / p.near
export const leader = (s: Proposal): Branch => (price(s.pools.pass) >= price(s.pools.fail) ? 'pass' : 'fail')
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
    set({ pools, held }, `Bought ${fmt(out)} NEAR in the world where it ${name(b)}.`)
  },
  sell(b: Branch, nearIn: number) {
    const h = state.held[b]
    if (!(nearIn > 0) || nearIn > h.near + 1e-9 || state.decided) return
    const out = quoteSell(state.pools[b], nearIn)
    const pools = { ...state.pools, [b]: { near: state.pools[b].near + nearIn, usdc: state.pools[b].usdc - out } }
    const held = { ...state.held, [b]: { near: h.near - nearIn, usdc: h.usdc + out } }
    set({ pools, held }, `Sold ${fmt(nearIn)} NEAR in the world where it ${name(b)}.`)
  },
  // trading closes: the branch with the higher NEAR price wins; the other branch's trades are undone
  decide() {
    if (state.decided) return
    const w = leader(state)
    const loser: Branch = w === 'pass' ? 'fail' : 'pass'
    set({ decided: w, closesAt: Math.min(state.closesAt, Date.now()) },
      `The proposal ${name(w)}: NEAR was worth $${price(state.pools[w]).toFixed(2)} there against $${price(state.pools[loser]).toFixed(2)}. Trades in the other branch were undone.`)
  },
  reset() { state = initial(); listeners.forEach((l) => l()) },
}
