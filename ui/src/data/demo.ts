// Demo data only. The in-browser store serves this until the NEAR contracts are connected.
// Every market is a scenario: one or two yes/no events, whose combined outcomes are the worlds (at most four).
// Worlds are in bit order: for two events, bit = 2 * (first event's outcome) + (second event's outcome).
// Joint odds assume the events are independent (p of a world = pA x pB).
// `nearPrice` is the reference NEAR price inside each world, set by that world's seeded pool. Seeds are
// picked so every scenario's odds-weighted price equals today's one spot price, about $3.22. The demo scenario uses
// the contract's demo pool prices: 3.70, 3.30, 3.00 and 2.50 USDC per NEAR.
import type { Market } from '../lib/types'

// The events, with the rules as the testnet contract states them (LEARN.md and the Resolve screen)
const FED: Market['events'][number] = {
  name: 'The Fed in December', outcomes: ['Cuts', 'Holds'], sources: ['FRED DFEDTARU', 'FOMC statement'], image: '/markets/fed.svg',
  rule: 'CUTS if and only if the upper limit of the federal funds target range (FRED DFEDTARU) after the Dec 8-9, 2026 FOMC meeting is lower than before it; otherwise HOLDS (a hike resolves HOLDS).',
  deadline: '9 Dec 2026, 19:00 UTC',
}
const SPICE: Market['events'][number] = {
  name: 'SPICE on mainnet', outcomes: ['Ships', 'Delayed'], sources: ['NEAR release tag', 'NEAR mainnet protocol version'], image: '/markets/spice.svg',
  rule: 'SHIPS if SPICE, NEAR’s separation of consensus and execution, is active on NEAR mainnet before 2027-04-01 00:00 UTC; otherwise DELAYED. During the hackathon this event is resolved from a team-controlled outcomes file (demo).',
  deadline: '31 Mar 2027, 23:59 UTC',
}

export const demoMarkets: Market[] = [
  // The demo scenario from the contract's demo: 60% SPICE ships on mainnet in time, 55% the Fed cuts in December.
  {
    id: 'ships-fed',
    question: 'Does SPICE ship on NEAR mainnet by 31 Mar 2027, and does the Fed cut in December?',
    category: 'Scenario',
    resolves: '31 Mar 2027',
    description: 'The demo market: two events that move NEAR, combined into four worlds. Keep NEAR where things go well and hold dollars where they don’t, then borrow against the worst world.',
    tags: ['NEAR', 'Rates', 'Combined'],
    volume: 412_800,
    opened: '2 Nov 2026',
    events: [
      SPICE,
      FED,
    ],
    worlds: [
      { id: 'sc', outcome: 'Ships & cuts', chance: 0.33, nearPrice: 3.7 },
      { id: 'sh', outcome: 'Ships & holds', chance: 0.27, nearPrice: 3.3 },
      { id: 'dc', outcome: 'Delayed & cuts', chance: 0.22, nearPrice: 3 },
      { id: 'dh', outcome: 'Delayed & holds', chance: 0.18, nearPrice: 2.5 },
    ],
  },
  {
    id: 'fed-dec-2026',
    question: 'Will the Fed cut at its December meeting?',
    category: 'Economy',
    resolves: '9 Dec 2026',
    description: 'Cheaper money tends to lift crypto. Hedge NEAR against the Fed holding rates, or keep it if they cut.',
    tags: ['Rates'],
    volume: 96_300,
    opened: '2 Nov 2026',
    events: [FED],
    worlds: [
      { id: 'cut', outcome: 'Fed cuts', chance: 0.58, nearPrice: 3.49 },
      { id: 'hold', outcome: 'Fed holds', chance: 0.42, nearPrice: 2.85 },
    ],
  },
  {
    id: 'near-5',
    question: 'Is NEAR above $3.50 on 31 Dec 2026?',
    category: 'Crypto',
    resolves: '31 Dec 2026',
    description: 'A price event: NEAR’s close on the last day of the year. Not in the testnet contract yet; it shows how a second NEAR event would look.',
    tags: ['NEAR', 'Price'],
    volume: 58_900,
    opened: '5 Nov 2026',
    events: [{
      name: 'NEAR on 31 Dec', outcomes: ['Above $3.50', '$3.50 or below'], sources: ['Pyth NEAR/USD', 'Binance daily close'], image: '/markets/near-price.svg',
      rule: 'ABOVE if NEAR/USD closes above $3.50 on 31 Dec 2026 (UTC) on both sources; otherwise $3.50 OR BELOW.',
      deadline: '31 Dec 2026, 23:59 UTC',
    }],
    worlds: [
      { id: 'above', outcome: 'Above $3.50', chance: 0.31, nearPrice: 3.76 },
      { id: 'below', outcome: '$3.50 or below', chance: 0.69, nearPrice: 2.98 },
    ],
  },
  // LEARN.md's "SPICE only": the same event on its own, so the combined market has a related market to point at
  {
    id: 'spice',
    question: 'Will SPICE ship on NEAR mainnet by 31 Mar 2027?',
    category: 'NEAR',
    resolves: '31 Mar 2027',
    description: 'SPICE on its own: does NEAR’s consensus and execution split reach mainnet on time?',
    tags: ['NEAR'],
    volume: 133_400,
    opened: '2 Nov 2026',
    events: [SPICE],
    worlds: [
      { id: 'ships', outcome: 'Ships', chance: 0.6, nearPrice: 3.52 },
      { id: 'delayed', outcome: 'Delayed', chance: 0.4, nearPrice: 2.77 },
    ],
  },
  // the past Fed decision the testnet demo settled from FRED through OutLayer: resolved HOLDS
  {
    id: 'fed-oct-2026',
    question: 'Did the Fed cut at its October 27-28, 2026 meeting?',
    category: 'Economy',
    resolves: 'Settled',
    description: 'Settled on testnet from official US data: OutLayer read FRED’s target range in a secure enclave and reported the result, with no person typing it.',
    tags: ['Rates', 'Settled'],
    volume: 71_200,
    opened: '20 Oct 2026',
    events: [{
      name: 'The Fed in October', outcomes: ['Cuts', 'Holds'], sources: ['FRED DFEDTARU', 'FRED DFEDTARL'], image: '/markets/fed-oct.svg',
      rule: 'CUTS if and only if both limits of the federal funds target range (FRED DFEDTARU and DFEDTARL) are lower on 2026-10-29 than on 2026-10-27; HOLDS if neither is; if they disagree, nothing is reported.',
      deadline: '29 Oct 2026',
    }],
    worlds: [
      { id: 'cut', outcome: 'Fed cut', chance: 0.5, nearPrice: 3.22 },
      { id: 'hold', outcome: 'Fed held', chance: 0.5, nearPrice: 3.22 },
    ],
    settled: [[0, 1]],
  },
]
