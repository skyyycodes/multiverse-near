import Link from 'next/link'
import { useMemo, useState, type ReactNode } from 'react'
import { Hero, type HeroStory } from '../components/Hero'
import { Dome } from '../components/DomeSlot'
import type { Item } from '../components/Orbit3D'
import { Button, Faq } from '../components/ui'
import { usd } from '../lib/format'
import { useTween } from '../lib/useTween'
import { chain, links } from '../config'
import { accountUrl } from '../chain/env'
import { toNum, useMarket, useMarkets, type ChainMarket } from '../chain/adapter'
import { byChance, chanceText, durationText, floorExample, leadWorld, priceText, sortBoard, type FloorInput } from '../chain/board'
import { feeText, useFees } from '../chain/board-hooks'
import { errorLine } from '../chain/errors'
import { fmt, fmtPct } from '../chain/format'
import { useAppConfig, useQuoteSell } from '../chain/hooks/useData'
import { useLendingTiers } from '../chain/hooks/useLending'
import { marketsHref, proposeHref } from '../chain/links'
import type { AppConfig } from '../chain/domain'

// The landing's numbers all come from the contract: the four worlds of the anchor market (SPICE × Fed) in the story
// and the worked example, the open markets in the table and on the dome, the tiers and the dispute window in the
// answers. Until the chain answers, the words stay and the numbers wait.

const NEAR = 1000 // the worked example's holding: a what-if, not anyone's wallet
const NEAR_WAD = BigInt(NEAR) * 10n ** 18n
const DROP = 0.4 // the NEAR drop the example tests the loan against

// The anchor's four worlds before the chain answers: its own outcome names, no numbers.
const STORY_WORDS: HeroStory = {
  rows: ['Ships', 'Delayed'],
  cols: ['Cuts', 'Holds'],
  worlds: [{ name: 'Ships & cuts' }, { name: 'Ships & holds' }, { name: 'Delayed & cuts' }, { name: 'Delayed & holds' }],
}

/** The anchor's worlds in story order (top left, top right, bottom left, bottom right) as contract indices. */
const storyOrder = (m: ChainMarket): number[] => m.grid.rows.flatMap((r) => r.worlds)

function heroStory(m: ChainMarket | undefined): HeroStory {
  if (!m || m.worldCount !== 4) return STORY_WORDS
  return {
    rows: m.grid.rows.map((r) => r.label),
    cols: m.grid.cols,
    worlds: storyOrder(m).map((w) => ({ name: m.worlds[w].outcome, chance: m.worlds[w].chance, price: m.worlds[w].nearPrice })),
  }
}

/** "60%", or a placeholder while the config is on its way. */
const share = (x: bigint | undefined) => (x === undefined ? '…' : fmtPct(x, 0))

function faq(cfg: AppConfig | undefined): { q: string; a: ReactNode }[] {
  const t = cfg?.lending.defaults
  const w = cfg ? durationText(cfg.disputeWindowSec) : 'a short window'
  return [
    {
      q: 'What’s a world?',
      a: 'One way the future can turn out. A market asks one, two or three yes-or-no questions, so it has 2, 4 or 8 worlds. Does SPICE ship on mainnet, and does the Fed cut in December? That makes four: ships and cuts, ships and holds, delayed and cuts, delayed and holds. Only one becomes real. Until then you can hold something different in each.',
    },
    {
      q: 'How much can I borrow?',
      a: `A market that lends has three tiers, each with its own pool of lenders. A new loan can reach ${share(t?.safe.borrowLtv)} of your weakest world in Safe, ${share(t?.normal.borrowLtv)} in Normal and ${share(t?.bold.borrowLtv)} in Bold. NEAR counts at the lower of its pool price and its 30-minute average in that world, dollars in full. The loan is real USDC, at a rate that rises as more of the tier is lent out; the smallest loan is ${cfg ? fmt(cfg.lending.minLoan, 0) : '…'} USDC.`,
    },
    {
      q: 'What if NEAR falls?',
      a: `Your health factor is your weakest world × the tier’s liquidation line (${share(t?.safe.lltv)}, ${share(t?.normal.lltv)} or ${share(t?.bold.lltv)}) ÷ your loan. Below 1, anyone can repay part of it with their own USDC and take that much of your collateral plus a bonus of ${share(t?.safe.liquidationBonus)} to ${share(t?.bold.liquidationBonus)}; below ${cfg ? fmt(cfg.lending.fullLiquidationHf, 1) : '…'}, the whole loan. Worlds where you hold dollars don’t move, so hedge or repay before it gets there.`,
    },
    {
      q: 'What happens to my loan when a question is answered?',
      a: 'The worlds that didn’t happen drop out. Your limit was set by the weakest world, and taking worlds away can’t make the weakest one weaker, so an answer never pushes a healthy loan underwater, in any order.',
    },
    {
      q: 'Who decides what happened?',
      a: `Every question names a public source: FRED for the Fed, exchange closes for NEAR’s price, nearcore releases for SPICE. The reporter proposes the answer with its evidence, or OutLayer reads it inside a secure enclave; the October Fed meeting was settled from FRED that way. For ${w} the owner can dispute it and the market pauses; after that anyone can finalize it.`,
    },
    {
      q: 'Who creates markets?',
      a: 'Anyone. Propose a new question, which the owner reviews, or a combination of up to three open questions, which opens without review. Others pledge USDC or wNEAR toward its goal; once the goal is reached the market opens by itself and the pledges become its pools’ first liquidity. If it never opens, every pledge comes back.',
    },
    {
      q: 'Why at most three questions per market?',
      a: 'Every extra question doubles the worlds and the pools that need money: one question needs 3 pools, two need 7, three need 15. You can still run many markets side by side, and markets that share a question are linked.',
    },
    {
      q: 'Where do the prices inside a world come from?',
      a: 'Each world has its own NEAR/USDC pool, and lending reads that pool’s 30-minute average, so a single trade can’t fake it. A market that lends is also checked against an outside NEAR/USD median of public exchanges: if the two drift more than 10% apart, new borrowing pauses. A keeper hosted with this site posts that price and liquidates loans that fall below 1; anyone can run the same bot.',
    },
    {
      q: 'Can I use real money?',
      a: 'No. This runs on NEAR testnet with test wNEAR and USDC from the wallet menu. It hasn’t been audited.',
    },
  ]
}

// The worked example in the story's own materials: the anchor's four worlds as the same folded panels that open in
// the scroll story, in their 2x2, at today's prices. Tap a world and its sheet flips over from NEAR to the dollars the
// pool there pays for it today. The weakest world sets your limit and carries the orange edge.
function Floor({ m, x }: { m: ChainMarket | undefined; x: FloorInput | undefined }) {
  // which worlds hold dollars. Starts with dollars everywhere but the first world.
  const [dollars, setDollars] = useState<boolean[]>([false, true, true, true])
  const toggle = (i: number) => setDollars((d) => d.map((v, k) => (k === i ? !v : v)))
  const f = x ? floorExample(x, dollars) : undefined
  const limit = useTween(f?.limit ?? 0)
  const afterDrop = useTween(f?.afterDrop ?? 0)
  const extra = useTween(f?.extra ?? 0)
  const order = m && m.worldCount === 4 ? storyOrder(m) : [0, 1, 2, 3]
  const names = STORY_WORDS.worlds.map((w, i) => (m && m.worldCount === 4 ? m.worlds[order[i]].outcome : w.name))

  return (
    <div className="sheets">
      <div className="sheets__grid" role="group" aria-label="The four worlds. Tap one to hold dollars there instead of NEAR.">
        {names.map((name, i) => {
          const w = m && m.worldCount === 4 ? m.worlds[order[i]] : undefined
          const usdc = x ? Math.round(x.proceeds[i]).toLocaleString('en-US') : '–'
          const meta = w ? `${chanceText(w.chance)} chance, NEAR at ${priceText(w.nearPrice)}` : 'Reading today’s prices…'
          const weakest = f?.weakest === i // the world that would set the limit after the drop
          return (
            <button
              key={name}
              type="button"
              aria-pressed={dollars[i]}
              aria-label={`${name}: holding ${dollars[i] ? `${usdc} USDC` : `${NEAR.toLocaleString('en-US')} NEAR`}. Tap to switch.`}
              className={`sheet sheet--${i}${dollars[i] ? ' is-usdc' : ''}${weakest ? ' is-weakest' : ''}`}
              onClick={() => toggle(i)}
            >
              <span className="sheet__flip">
                <span className="sheet__face sheet__face--near">
                  <span className="sheet__name">{name}</span>
                  <span className="sheet__meta">{meta}</span>
                  <span className="sheet__hold">{NEAR.toLocaleString('en-US')} NEAR</span>
                  <span className="sheet__counts">counts {f ? usd(x!.near * x!.prices[i]) : '–'}</span>
                </span>
                <span className="sheet__face sheet__face--usdc">
                  <span className="sheet__name">{name}</span>
                  <span className="sheet__meta">{meta}</span>
                  <span className="sheet__hold">{usdc} USDC</span>
                  <span className="sheet__counts">counts {f ? usd(x!.proceeds[i]) : '–'}</span>
                </span>
              </span>
              {weakest && <span className="sheet__limit">Sets your limit</span>}
            </button>
          )
        })}
      </div>
      <div className="sheets__read" aria-live="polite">
        <div><span>You could borrow today</span><b>{f ? usd(limit) : '–'}</b></div>
        <div><span>If NEAR drops 40%</span><b>{f ? usd(afterDrop) : '–'}</b></div>
        <div className="is-gain"><span>Kept vs only NEAR</span><b>{f ? (extra >= 0.5 ? `+${usd(extra)}` : usd(0)) : '–'}</b></div>
      </div>
    </div>
  )
}

export default function Landing() {
  const { market: anchor } = useMarket(chain.anchorMarket)
  const { markets, error } = useMarkets()
  const cfg = useAppConfig().data
  const fees = useFees().data
  const tiers = useLendingTiers(chain.anchorMarket, null).data
  const ltv = tiers?.find((t) => t.tier === 'normal')?.market.config.borrowLtv
  // what each world's pool pays today for the example's NEAR (fee and price impact included)
  const quote = useQuoteSell(chain.anchorMarket, NEAR_WAD, anchor?.possible ?? 0, anchor?.worldCount === 4).data
  const open = useMemo(() => sortBoard((markets ?? []).filter((m) => !m.settled), 'pool'), [markets])

  const story = heroStory(anchor)
  const example = useMemo((): FloorInput | undefined => {
    if (!anchor || anchor.worldCount !== 4 || !quote || ltv === undefined) return undefined
    const order = storyOrder(anchor)
    return { prices: order.map((w) => anchor.worlds[w].nearPrice), proceeds: order.map((w) => toNum(quote[w])), near: NEAR, ltv: toNum(ltv), drop: DROP }
  }, [anchor, quote, ltv])
  // the dome's inner arch: each open market's likeliest world and its chance
  const odds = useMemo(
    () => open.flatMap((m): Item[] => {
      const lead = leadWorld(m)
      return lead ? [{ kind: 'text', text: `${lead.outcome}  ${chanceText(lead.chance)}` }, { kind: 'mark', src: '/logo.svg' }] : []
    }),
    [open],
  )

  return (
    <div className="landing">
      <Hero worlds={story} />

      {/* 1. the worked example: change what you hold in one world, watch the floor move */}
      <section className="flow flow--worlds" id="how">
        <div className="flow__copy">
          <h2>Hedge the worlds you fear. Borrow against all four.</h2>
          <p>Say you hold {NEAR.toLocaleString('en-US')} NEAR. SPICE either ships on NEAR mainnet by March or slips, and the Fed either cuts or holds in December. That makes four worlds, and NEAR has its own price in each, set by that world’s pool.</p>
          <p>A lender counts only your weakest world: in the Normal tier a new loan can reach {share(ltv)} of it. Tap a world to sell your NEAR there for dollars at what its pool pays today ({fees ? `a ${feeText(fees.base)} fee, up to ${feeText(fees.cap)} when trading is one-sided` : 'a small fee'}, plus the sale’s own price impact). Dollars don’t fall with NEAR, so if NEAR drops, the worlds you hedged hold their value and your loan stays safe.</p>
          <p className="demo-note">A what-if at today’s prices in the SPICE × Fed market, read from the contract.</p>
          <Button to={anchor?.href ?? `/market/?id=${chain.anchorMarket}`}>Open the market</Button>
        </div>
        <Floor m={anchor} x={example} />
      </section>

      {/* 2. markets */}

      <section className="landing-markets">
        <div className="dome-head">
          <Dome odds={odds} />
          <div className="dome-head__text">
            <h2>Open markets</h2>
            <p>Each market splits into worlds. Open one to hedge, borrow or lend.</p>
            <Link href={marketsHref}>All markets</Link>
          </div>
        </div>
        <div className="mtable" role="table" aria-label="Open markets">
          <div className="mtable__row mtable__row--head" role="row">
            <span role="columnheader">Market</span>
            <span role="columnheader">Most likely</span>
            <span role="columnheader">Chance</span>
            <span role="columnheader">Resolves</span>
          </div>
          {!markets ? (
            <div className="mtable__row" role="row"><span role="cell" className="mtable__when">{error ? errorLine(error.message) : 'Reading the markets…'}</span></div>
          ) : open.length === 0 ? (
            <div className="mtable__row" role="row"><span role="cell" className="mtable__when">No open markets yet. <Link href={proposeHref()}>Propose one</Link>.</span></div>
          ) : open.map((m) => {
            const lead = byChance(m)[0]
            return (
              <Link key={m.id} href={m.href} className="mtable__row" role="row">
                <span className="mtable__q" role="cell"><small>{m.category}, {m.worldCount} worlds</small>{m.question}</span>
                <span role="cell">{lead?.outcome ?? '–'}</span>
                <span className="mtable__odds" role="cell">
                  <b>{lead ? chanceText(lead.chance) : '–'}</b>
                </span>
                <span role="cell" className="mtable__when">{m.resolves}</span>
              </Link>
            )
          })}
        </div>
        <p className="demo-note">Live on NEAR testnet with test tokens. No real funds.</p>
      </section>

      {/* 3. questions: heading on the left, answers on the right */}
      <section className="landing-faq">
        <div className="landing-faq__side">
          <h2>Questions</h2>
          <p className="landing-faq__note">Built on NEAR testnet from Paradigm’s <a href={links.paper} target="_blank" rel="noreferrer">Multiverse Finance</a> paper. The contract is live at <a href={accountUrl(chain.contractId)} target="_blank" rel="noreferrer">{chain.contractId}</a>. The full mechanics, with real testnet transactions, are in <Link href="/docs/">How it works</Link>.</p>
        </div>
        <Faq items={faq(cfg)} />
      </section>
    </div>
  )
}
