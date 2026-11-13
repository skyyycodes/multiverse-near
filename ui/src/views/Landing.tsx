import Link from 'next/link'
import { useState } from 'react'
import { Hero } from '../components/Hero'
import { Dome } from '../components/DomeSlot'
import { Button, Faq } from '../components/ui'
import { usd } from '../lib/format'
import { useTween } from '../lib/useTween'
import { links } from '../config'
import { demoMarkets } from '../data/demo'

const FAQ = [
  {
    q: 'What’s a world?',
    a: 'One way the future can turn out. Two yes-or-no questions give four worlds: SPICE ships on mainnet and the Fed cuts, ships and holds, slips and cuts, slips and holds. Only one becomes real. Until then you can hold something different in each.',
  },
  {
    q: 'How much can I borrow?',
    a: 'Up to 75% of what your weakest world is worth, with NEAR at its price in that world and dollars in full. The loan is real USDC at a fixed 5% a year, and all of that interest goes to the lenders.',
  },
  {
    q: 'What if NEAR falls?',
    a: 'Your health factor is your worst world × 75% ÷ your loan. Below 1, anyone can repay up to half the loan with their own USDC and take that much of your collateral plus a 5% bonus. The bonus comes out of your pocket, so repay or add collateral before it gets there. Worlds where you already hold dollars don’t move.',
  },
  {
    q: 'What happens to my loan when a question is answered?',
    a: 'The worlds that didn’t happen drop out. Your limit was set by the worst world, and taking worlds away can’t make the worst one worse, so an answer never pushes a healthy loan underwater, in either order.',
  },
  {
    q: 'Who decides what happened?',
    a: 'A reporter proposes each result. For a short window (30 seconds on testnet) the owner can dispute it and trading pauses; after that anyone can finalize it. In the testnet demo, the October 2026 Fed decision was settled from FRED data by OutLayer, with no person typing the answer.',
  },
  {
    q: 'Who creates markets?',
    a: 'Today only the owner account can create events, worlds and their pools, and it puts in the first liquidity. Once a market exists, anyone can split, sell, trade, borrow, lend and redeem. Proposing markets funded by pledges is on the roadmap, not built yet.',
  },
  {
    q: 'Why at most two questions per market?',
    a: 'Every extra question doubles the worlds and the pools that need money: two questions need 7 pools, three would need 15. Three is the natural next step; you can already run many separate markets side by side.',
  },
  {
    q: 'Where do the prices inside a world come from?',
    a: 'Each world has its own NEAR/USDC pool, and lending reads that pool’s 30-minute average price, so a single trade can’t fake it. On testnet the pools are seeded by the team with mock tokens, so treat the numbers as an example, not a market.',
  },
  {
    q: 'Can I use real money?',
    a: 'No. This is a hackathon build on NEAR testnet with mock wNEAR and USDC. It hasn’t been audited.',
  },
]

// The example everyone works through: 1,000 NEAR across the demo scenario's four worlds.
const NEAR = 1000
const FEE = 0.003 // a world pool's base fee to swap NEAR for USDC (it rises to 1.50% when trading is one-sided)
const LLTV = 0.75 // borrow up to 75% of your weakest world
const DROP = 0.4 // the NEAR drop the example tests the loan against

const cap = (n: number) => Math.floor(n * LLTV) // a limit rounds down, never up

// what one world counts for as collateral, holding NEAR (at its price there) or holding dollars (after the swap fee);
// `drop`: the same after NEAR falls by DROP, which dollars don't feel
const credit = (price: number, dollars: boolean, drop = false) => (dollars ? NEAR * price * (1 - FEE) : NEAR * price * (drop ? 1 - DROP : 1))

// The worked example in the story's own materials: the four worlds as the same folded panels that open in
// the scroll story, in their 2x2, with orange showing through the creases. Tap a world and its sheet flips
// over from NEAR to dollars. The weakest world sets your limit and carries the orange edge.
function Floor() {
  const worlds = demoMarkets[0].worlds
  // which worlds hold dollars. Starts on the doc's example: dollars everywhere but Ships & cuts.
  const [dollars, setDollars] = useState<boolean[]>([false, true, true, true])
  const toggle = (i: number) => setDollars((d) => d.map((v, k) => (k === i ? !v : v)))

  // the limit today, then the limit after NEAR falls 40%: with dollars where you chose, and with NEAR everywhere
  const values = worlds.map((w, i) => credit(w.nearPrice, dollars[i]))
  const shocked = worlds.map((w, i) => credit(w.nearPrice, dollars[i], true))
  const floor = Math.min(...shocked)
  const nearOnly = Math.min(...worlds.map((w) => credit(w.nearPrice, false, true)))
  const limit = useTween(cap(Math.min(...values)))
  const afterDrop = useTween(cap(floor))
  const extra = useTween(cap(floor) - cap(nearOnly))

  return (
    <div className="sheets">
      <div className="sheets__grid" role="group" aria-label="The four worlds. Tap one to hold dollars there instead of NEAR.">
        {worlds.map((w, i) => {
          const usdc = Math.round(NEAR * w.nearPrice * (1 - FEE)).toLocaleString('en-US')
          const weakest = shocked[i] === floor // the world that would set the limit after the drop
          return (
            <button
              key={w.id}
              type="button"
              aria-pressed={dollars[i]}
              aria-label={`${w.outcome}: holding ${dollars[i] ? `${usdc} USDC` : '1,000 NEAR'}. Tap to switch.`}
              className={`sheet sheet--${i}${dollars[i] ? ' is-usdc' : ''}${weakest ? ' is-weakest' : ''}`}
              onClick={() => toggle(i)}
            >
              <span className="sheet__flip">
                <span className="sheet__face sheet__face--near">
                  <span className="sheet__name">{w.outcome}</span>
                  <span className="sheet__meta">{Math.round(w.chance * 100)}% chance, NEAR at ${w.nearPrice.toFixed(2)}</span>
                  <span className="sheet__hold">1,000 NEAR</span>
                  <span className="sheet__counts">counts {usd(credit(w.nearPrice, false))}</span>
                </span>
                <span className="sheet__face sheet__face--usdc">
                  <span className="sheet__name">{w.outcome}</span>
                  <span className="sheet__meta">{Math.round(w.chance * 100)}% chance, NEAR at ${w.nearPrice.toFixed(2)}</span>
                  <span className="sheet__hold">{usdc} USDC</span>
                  <span className="sheet__counts">counts {usd(credit(w.nearPrice, true))}</span>
                </span>
              </span>
              {weakest && <span className="sheet__limit">Sets your limit</span>}
            </button>
          )
        })}
      </div>
      <div className="sheets__read" aria-live="polite">
        <div><span>You can borrow today</span><b>{usd(limit)}</b></div>
        <div><span>If NEAR drops 40%</span><b>{usd(afterDrop)}</b></div>
        <div className="is-gain"><span>Kept vs only NEAR</span><b>{extra >= 0.5 ? `+${usd(extra)}` : usd(0)}</b></div>
      </div>
    </div>
  )
}

export default function Landing() {
  const market = demoMarkets[0]
  const open = demoMarkets.filter((m) => !m.settled)

  return (
    <div className="landing">
      <Hero />

      {/* 1. the worked example: change what you hold in one world, watch the floor move */}
      <section className="flow flow--worlds" id="how">
        <div className="flow__copy">
          <h2>Hedge the worlds you fear. Borrow against all four.</h2>
          <p>You hold 1,000 NEAR. SPICE either ships on NEAR mainnet by March or slips, and the Fed either cuts or holds in December. That makes four worlds, and NEAR is worth something different in each.</p>
          <p>A lender counts only your weakest world. Tap a world to swap your NEAR there for dollars (a 0.30% fee, more when trading is one-sided). Dollars don’t fall with NEAR, so if NEAR drops, the worlds you hedged hold their value and your loan stays safe.</p>
          <Button to={`/markets/${market.id}`}>Try it with the demo wallet</Button>
        </div>
        <Floor />
      </section>

      {/* 2. markets */}

      <section className="landing-markets">
        <div className="dome-head">
          <Dome />
          <div className="dome-head__text">
            <h2>Open markets</h2>
            <p>Each market splits into worlds. Open one to hedge, borrow or lend.</p>
            <Link href="/markets">All markets</Link>
          </div>
        </div>
        <div className="mtable" role="table" aria-label="Open markets">
          <div className="mtable__row mtable__row--head" role="row">
            <span role="columnheader">Market</span>
            <span role="columnheader">Most likely</span>
            <span role="columnheader">Chance</span>
            <span role="columnheader">Resolves</span>
          </div>
          {open.map((m) => {
            const lead = [...m.worlds].sort((a, b) => b.chance - a.chance)
            return (
              <Link key={m.id} href={`/markets/${m.id}`} className="mtable__row" role="row">
                <span className="mtable__q" role="cell"><small>{m.category}, {m.worlds.length} worlds</small>{m.question}</span>
                <span role="cell">{lead[0].outcome}</span>
                <span className="mtable__odds" role="cell">
                  <b>{Math.round(lead[0].chance * 100)}%</b>
                </span>
                <span role="cell" className="mtable__when">{m.resolves}</span>
              </Link>
            )
          })}
        </div>
        <p className="demo-note">Demo data on testnet. No real funds.</p>
      </section>

      {/* 3. questions: heading on the left, answers on the right */}
      <section className="landing-faq">
        <div className="landing-faq__side">
          <h2>Questions</h2>
          <p className="landing-faq__note">Built on NEAR testnet for the NEAR hackathon, from Paradigm’s <a href={links.paper} target="_blank" rel="noreferrer">Multiverse Finance</a> paper. The contract is live at <a href="https://testnet.nearblocks.io/address/app.multiverse-near.testnet" target="_blank" rel="noreferrer">app.multiverse-near.testnet</a>. The full mechanics, with the testnet run, are in <Link href="/docs">How it works</Link>.</p>
        </div>
        <Faq items={FAQ} />
      </section>
    </div>
  )
}
