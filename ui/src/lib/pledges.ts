// Proposed markets funded by pledges, the roadmap flow from LEARN.md: propose (question, rule, public data source,
// deadline, a small refundable deposit), pledge (both sides lock USDC: people who want to hedge and people happy to
// take the other side), check (clear yes/no, public data, can't be caused), open (the market starts with the
// pledged money inside), resolve from the data. A combination of events that already exist skips the owner check
// and opens as soon as it's funded. In-browser demo model; not in the contract.
import { useSyncExternalStore } from 'react'
import { demoMarkets } from '../data/demo'
import type { ScenarioEvent } from './types'

export type PledgeKind = 'new' | 'combo'
export type PledgeStatus = 'pledging' | 'review' | 'open'
export type PledgeProposal = {
  id: number
  question: string
  kind: PledgeKind
  category: string
  events: ScenarioEvent[]
  rule: string
  source: string
  deadline: string
  goal: number // USDC needed to open with useful depth
  pledged: { hedge: number; take: number }
  backers: number
  yours: number
  author: string
  daysLeft: number
  status: PledgeStatus
  marketId?: string // once opened
}

export const DEPOSIT = 10 // USDC, refunded once the proposal is accepted
export const MIN_GOAL = 5_000

const ev = (name: string) => demoMarkets.flatMap((m) => m.events).find((e) => e.name === name)!
let next = 104
let list: PledgeProposal[] = [
  {
    id: 101, question: 'Does SPICE ship by March, and is NEAR above $3.50 on 31 Dec?', kind: 'combo', category: 'NEAR',
    events: [ev('SPICE on mainnet'), ev('NEAR on 31 Dec')],
    rule: 'Combines two events that already exist, with their own rules and sources; nothing new to check.',
    source: 'NEAR release tag; Pyth NEAR/USD', deadline: '31 Mar 2027', goal: 20_000, pledged: { hedge: 9_200, take: 6_100 },
    backers: 23, yours: 0, author: 'ravi.multiverse-near.testnet', daysLeft: 6, status: 'pledging',
  },
  {
    id: 102, question: 'Will NEAR Intents pass $1B in monthly volume by 30 June 2027?', kind: 'new', category: 'NEAR',
    events: [{ name: 'Intents volume', outcomes: ['Above $1B', '$1B or below'], sources: ['NEAR Intents explorer', 'Dune dashboard'] }],
    rule: 'ABOVE if any calendar month before 1 Jul 2027 shows more than $1B of settled volume on the NEAR Intents explorer.',
    source: 'NEAR Intents explorer, monthly volume', deadline: '30 Jun 2027', goal: 15_000, pledged: { hedge: 4_300, take: 2_100 },
    backers: 11, yours: 0, author: 'uma.multiverse-near.testnet', daysLeft: 12, status: 'pledging',
  },
  {
    id: 103, question: 'Will the Fed cut at its January 2027 meeting?', kind: 'new', category: 'Economy',
    events: [{ name: 'The Fed in January', outcomes: ['Cuts', 'Holds'], sources: ['FRED DFEDTARU', 'FOMC statement'], image: '/markets/fed.svg' }],
    rule: 'CUTS if and only if the upper limit of the federal funds target range (FRED DFEDTARU) after the Jan 26-27, 2027 FOMC meeting is lower than before it; otherwise HOLDS.',
    source: 'FRED DFEDTARU', deadline: '27 Jan 2027', goal: 10_000, pledged: { hedge: 6_100, take: 3_900 },
    backers: 31, yours: 0, author: 'sam.multiverse-near.testnet', daysLeft: 0, status: 'review',
  },
]
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
export const usePledges = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => list, () => list)

const funded = (p: PledgeProposal) => p.pledged.hedge + p.pledged.take >= p.goal
const update = (id: number, fn: (p: PledgeProposal) => PledgeProposal) => { list = list.map((p) => (p.id === id ? fn(p) : p)); emit() }

export const pledges = {
  propose(p: Omit<PledgeProposal, 'id' | 'pledged' | 'backers' | 'yours' | 'daysLeft' | 'status'>) {
    const id = next++
    list = [{ ...p, id, pledged: { hedge: 0, take: 0 }, backers: 0, yours: 0, daysLeft: 14, status: 'pledging' }, ...list]
    emit()
    return id
  },
  // a combination of existing events opens as soon as it's funded; a new event waits for the owner's check
  pledge(id: number, side: 'hedge' | 'take', amount: number) {
    update(id, (p) => {
      const n = { ...p, pledged: { ...p.pledged, [side]: p.pledged[side] + amount }, backers: p.backers + (p.yours > 0 ? 0 : 1), yours: p.yours + amount }
      return funded(n) && n.status === 'pledging' ? { ...n, status: n.kind === 'combo' ? 'open' : 'review' } : n
    })
  },
  approve(id: number) { update(id, (p) => ({ ...p, status: 'open' })) },
  opened(id: number, marketId: string) { update(id, (p) => ({ ...p, marketId })) },
}
export const isFunded = funded
