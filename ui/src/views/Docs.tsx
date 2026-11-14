// How it works: the design doc, in plain words. Same visual system as the rest of the site.
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { CollateralBars } from '../components/CollateralBars'
import { demoMarkets } from '../data/demo'
import { FEE, LLTV, fresh } from '../lib/scenario'
import { Button } from '../components/ui'
import { links } from '../config'

// Alice's sale and loan as they ran on NEAR testnet on 2026-11-12 (README, LEARN.md lesson 10, DESIGN.md): she
// keeps 2,000 NEAR in Ships & cuts and sells it in the other three worlds, the L-shape, mask 14 (0b1110).
const money = (n: number) => Math.round(n).toLocaleString('en-US')
const ALICE_NEAR = 2000
const PROCEEDS: Record<string, number> = { sh: 6451.55, dc: 5865.05, dh: 4881.88 } // USDC-if-world she received
const ALICE = demoMarkets[0].worlds.map((w) => {
  const kept = w.id === 'sc'
  return {
    world: w.outcome,
    price: `$${w.nearPrice.toFixed(2)}`,
    before: `${money(ALICE_NEAR)} NEAR ($${money(ALICE_NEAR * w.nearPrice)})`,
    after: kept ? `${money(ALICE_NEAR)} NEAR, kept` : `${PROCEEDS[w.id].toLocaleString('en-US', { minimumFractionDigits: 2 })} USDC`,
    kept,
  }
})
const DEBT = 3000
const WORST = PROCEEDS.dh // Delayed & holds, her weakest world after the sale

const TERMS = [
  ['World', 'One combination of the events’ outcomes, numbered from 0. Two yes/no events make four worlds.'],
  ['Mask', 'A set of worlds as bits: bit w set means world w is in it. Mask 14 (0b1110) is every world but Ships & cuts.'],
  ['Verse', 'One asset on one mask of one scenario, e.g. wNEAR-if-14: it pays 1 wNEAR if the world that comes true is in mask 14. The root mask (every world) is the real asset itself.'],
  ['Split / merge', 'Turn an amount on one mask into the same amount on each part of a split of it, or join the parts back.'],
  ['Live, dead, collapsed', 'A verse is live while its mask touches a world still possible, dead once it doesn’t, and collapsed once it covers every possible world.'],
  ['Redeem', 'A collapsed verse pays one real token per token. After resolution, the verse covering the surviving world redeems 1:1.'],
  ['Token', 'Every verse is a NEP-245 token with id “{scenario}:{asset}:{mask}”, for example 1:wnear:14, with 18 decimals, all in one contract.'],
  ['Backing rule', 'In every world still possible, for every asset, what all verses pay there adds up to the reserves. The app shows it as “every world balances”.'],
  ['Health factor', 'Worst world × 75% ÷ debt. Borrowing and withdrawing collateral need it at 1 or more; below 1, anyone can liquidate.'],
  ['Swap fee', 'World pools charge 0.30%, rising to 1.50% when the last 8 swaps all went one way. After Alice’s sale, the three pools she sold into charged 1.50%.'],
  ['Reporter', 'The account that proposes an event’s result: resolver.multiverse-near.testnet, or OutLayer for the FRED-backed Fed event.'],
]

// the gaps LEARN.md lists for a real-money launch, plus what's specific to this interface
const RISKS = [
  ['Only the owner opens markets.', 'Creating events, combining them into worlds and seeding pools all need the owner account. Proposing markets funded by pledges is on the roadmap.'],
  ['At most two events per market.', 'Three events (eight worlds) is the natural next step; more needs a redesign.'],
  ['Prices lag up to 30 minutes.', 'Loans are judged on each world’s 30-minute average price, so in a fast crash the contract reacts late. Someone with enough money could also hold one world’s price down for the window.'],
  ['No insurance fund.', 'A crash too fast to liquidate leaves bad debt, and it falls on lenders. Bad debt is never written off.'],
  ['No liquidation bot or button yet.', 'Anyone can liquidate, but there’s no borrower list in the contract and no ready-made bot; liquidators are paid in world tokens, not cash.'],
  ['Joint odds assume the events are independent.', 'Prediction markets give odds for each event alone, not for combinations.'],
  ['Unaudited, testnet only, mock tokens.', 'The cross-chain deposit quotes in this interface come from NEAR Intents as dry runs; the contract itself takes only wNEAR and USDC.'],
]

// Alice's position before and after the sale, on the same chart as the portfolio
const SCENARIO = demoMarkets[0]
const BEFORE = { ...fresh(SCENARIO, ALICE_NEAR), debt: DEBT }
const AFTER = (() => {
  const s = fresh(SCENARIO, ALICE_NEAR)
  const near = SCENARIO.worlds.map((w) => (w.id === 'sc' ? ALICE_NEAR : 0))
  const usdc = SCENARIO.worlds.map((w) => PROCEEDS[w.id] ?? 0)
  return { ...s, near, usdc, debt: DEBT }
})()

// the deployment on NEAR testnet, from the upstream README and deployments/testnet.json
const NB = 'https://testnet.nearblocks.io'
const ACCOUNTS: [string, string][] = [
  ['Protocol contract', 'app.multiverse-near.testnet'],
  ['Owner', 'multiverse-near.testnet'],
  ['Reporter', 'resolver.multiverse-near.testnet'],
  ['Mock wNEAR', 'wnear.multiverse-near.testnet'],
  ['Mock USDC', 'usdc.multiverse-near.testnet'],
  ['Alice (sells and borrows)', 'alice.multiverse-near.testnet'],
]
const FED_TX: [string, string][] = [
  ['set_outlayer_config', 'FUZHqurtQEqXxGjLwDuWzjNZ8pYR8wdYJVX2kHsUNaJM'],
  ['request_resolution', '5DKPy7JXgjs4UMP8Bpt2AEyepa4QVswQcBRtwu6p4rgk'],
  ['finalize', 'Aygmi1WCCzuEhxMADrQ3eTes1KAeFyyrRg3y7G4epgGE'],
]

const TOC: [string, string][] = [
  ['problem', 'The problem'],
  ['worlds', 'How worlds work'],
  ['example', 'Alice on testnet'],
  ['borrowing', 'Borrowing'],
  ['prices', 'Prices and odds'],
  ['resolution', 'Resolution'],
  ['testnet', 'On NEAR testnet'],
  ['terms', 'Terms'],
  ['limits', 'Limits'],
]

// which section is being read: the last one whose heading has passed the upper third of the screen
function useActiveSection() {
  const [active, setActive] = useState(TOC[0][0])
  useEffect(() => {
    const on = () => {
      let cur = TOC[0][0]
      for (const [id] of TOC) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top < window.innerHeight * 0.33) cur = id
      }
      setActive(cur)
    }
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  return active
}

export default function Docs() {
  const active = useActiveSection()
  return (
    <div className="page docs">
      <header className="docs__head">
        <h1 className="page__title">How it works</h1>
        <p className="docs__lede">Keep NEAR in the futures you like, hold dollars in the ones you fear, and borrow against both at once. Each asset is split into copies that only exist in one possible future, and lending and trading happen inside each of them.</p>
      </header>

      <div className="docs__body">
      <nav className="docs__toc" aria-label="On this page">
        {TOC.map(([id, label]) => <a key={id} href={`#${id}`} className={id === active ? 'is-on' : ''}>{label}</a>)}
      </nav>
      <article className="docs__article">

      <section className="docs__section" id="problem">
        <h2>The problem</h2>
        <p>Every order in DeFi is conditional on price, and none is conditional on the state of the world. You can say “sell if NEAR hits $5”, but not “sell if SPICE is delayed”.</p>
        <p>Prediction markets let you bet on one event, but the money is locked until the result, often months away. A single outcome token, like “USDC if the Fed cuts”, is worth zero in the other future, so lenders give it no credit. That capital just sits there.</p>
      </section>

      <section className="docs__section" id="worlds">
        <h2>How worlds work</h2>
        <p>A scenario combines one or two yes/no events, each with a rule for how it resolves. Every combination of outcomes is a world, numbered from 0, so there are at most four. The demo uses two: does SPICE ship on NEAR mainnet by 31 March 2027, and does the Fed cut at its December meeting.</p>
        <div className="docs__grid" role="table" aria-label="The four worlds and their numbers">
          <span />
          <span className="docs__axis">Fed cuts</span>
          <span className="docs__axis">Fed holds</span>
          <span className="docs__axis">Ships</span>
          <span className="docs__cell">Ships &amp; cuts<b>world 0</b></span>
          <span className="docs__cell is-l">Ships &amp; holds<b>world 2</b></span>
          <span className="docs__axis">Delayed</span>
          <span className="docs__cell is-l">Delayed &amp; cuts<b>world 1</b></span>
          <span className="docs__cell is-l">Delayed &amp; holds<b>world 3</b></span>
        </div>
        <p className="docs__caption">As the contract numbers them. The highlighted L-shape, every world but Ships &amp; cuts, is mask 14 (0b1110); all four together are the root, 15, which is the real asset itself.</p>
        <p>A <b>verse</b> is one asset on one set of worlds: wNEAR-if-14 pays one wNEAR if the world that comes true is in mask 14. Depositing 1 NEAR <b>splits</b> it into one piece per world; holding every piece <b>merges</b> back to 1 NEAR at any time. When an event resolves, worlds that didn’t happen die, and the piece covering the surviving world <b>redeems</b> 1:1 for the real token, in either resolution order.</p>
      </section>

      <section className="docs__section" id="example">
        <h2>Alice on NEAR testnet</h2>
        <p>This ran on <code>app.multiverse-near.testnet</code> on 12 November 2026. The seeded pools price NEAR at $3.70 in Ships &amp; cuts, $3.30 in Ships &amp; holds, $3.00 in Delayed &amp; cuts and $2.50 in Delayed &amp; holds. Alice holds 2,000 NEAR, wants NEAR only if everything goes well, and picks the other three worlds. One click, one signature: her NEAR is split into all four worlds and sold for USDC of the same world in the three she fears.</p>
        <div className="docs__table" role="table">
          <div role="row" className="docs__tr docs__tr--head"><span>World</span><span>NEAR price</span><span>Before</span><span>After</span></div>
          {ALICE.map((r) => (
            <div role="row" key={r.world} className={`docs__tr${r.kept ? '' : ' is-sold'}`}>
              <span>{r.world}</span><span className="num">{r.price}</span><span className="num">{r.before}</span><span className="num">{r.after}</span>
            </div>
          ))}
        </div>
        <p>Why 5,865 and not 2,000 × $3.00 = $6,000 in Delayed &amp; cuts? A big sale moves the pool’s price as it goes, and each world pool takes a fee ({(FEE * 100).toFixed(2)}%, rising to 1.50% for one-sided flow). In Delayed &amp; holds, Ravi had a resting bid for 1,000 NEAR at $2.45; the sale filled it first, which got Alice 4,881.88 USDC instead of 4,748 from the pool alone.</p>
        <p>If Delayed &amp; holds happens and NEAR ends at $2.00, an unhedged Alice has $4,000 there. Hedged, she has 4,881.88 USDC whatever NEAR does. The hedge cost about 2.4% if prices end as expected, and protects her if they end worse.</p>
      </section>

      <section className="docs__section" id="borrowing">
        <h2>Borrowing: your worst world sets the limit</h2>
        <p>Each collateral piece is valued in every world still possible: NEAR-if-world at that world’s price where it pays and nothing elsewhere, USDC-if-world in full where it pays. Your worst world sets the limit: health = worst world × 75% ÷ debt. The loan is real USDC, owed the same in every world. Hedging keeps the limit from falling when NEAR does.</p>
        <div className="docs__compare">
          <figure>
            <CollateralBars m={SCENARIO} s={BEFORE} scale={8000} />
            <figcaption><b>Plain NEAR.</b> Worst world ${money(ALICE_NEAR * 2.5)} (2,000 × $2.50), so a ${money(DEBT)} loan has health {(LLTV * ALICE_NEAR * 2.5 / DEBT).toFixed(2)}. If NEAR falls 40% there, health drops to {(LLTV * ALICE_NEAR * 2.5 * 0.6 / DEBT).toFixed(2)} and anyone can liquidate it. That’s what happened to Carl on testnet: health 0.86, liquidated by Leo.</figcaption>
          </figure>
          <figure>
            <CollateralBars m={SCENARIO} s={AFTER} scale={8000} />
            <figcaption><b>Alice, after the sale.</b> Worst world {WORST.toLocaleString('en-US')} USDC, so with ${money(DEBT)} borrowed her health is {(LLTV * WORST / DEBT).toFixed(2)} (she could borrow up to ${money(LLTV * WORST)}). It stays there through the same drop, because her worst world holds dollars.</figcaption>
          </figure>
        </div>
        <p><b>Lending.</b> Each scenario has one market for real USDC. Lenders supply USDC and earn one fixed rate, 5% a year, all of it paid by borrowers; the protocol keeps nothing. A borrower can post up to 16 collateral pieces per market.</p>
        <p><b>Liquidation.</b> When health falls below 1, anyone can repay up to half the debt with their own USDC and take the same fraction of every collateral piece, worth the repayment plus a 5% bonus. Cutting every piece by the same fraction keeps the worst world worst. On testnet, Leo took Carl from health 0.86 to 0.95. Liquidation pauses while a result is in dispute, or when a world has no trusted price.</p>
        <p><b>Closing.</b> After the events resolve, “Close and redeem” repays the loan and pays out the surviving world in one transaction. In the demo the world was Delayed &amp; holds: Alice’s 4,881.88 USDC repaid about 3,056 of debt and interest and left her about 1,825 USDC, on top of the 3,000 she had borrowed.</p>
        <p><b>Why resolution can’t create bad debt.</b> Resolving an event only removes worlds from the set your health is measured over. A minimum over fewer worlds is never lower, so health can only rise, in any order.</p>
      </section>

      <section className="docs__section" id="prices">
        <h2>Prices and odds</h2>
        <p><b>Inside a world</b>, lending prices NEAR from that world’s pool, as its average over 30 minutes. The world has a price only if the pool is at least 60 seconds old, its live price is within about 10% of that average, and it holds at least 10,000 USDC. A world without a price counts zero toward borrowing and pauses liquidation in that market. Pools stop trading while a result is in dispute and once their world is dead. On testnet the owner seeds the pools with mock tokens, so treat the prices as an example.</p>
        <p><b>Between worlds</b>, pools such as Ships vs Delayed imply a probability p = y / (x + y). The owner seeds them with each event’s odds when it opens the market, and joint odds assume the events are independent (p of a world = pA × pB). Spot NEAR must equal the odds-weighted world prices; arbitrage keeps it there.</p>
      </section>

      <section className="docs__section" id="resolution">
        <h2>Resolution and NEAR</h2>
        <p>A result comes in one of three ways: the reporter account proposes it with its evidence, OutLayer reads FRED inside a secure enclave and proposes it, or the owner resolves it directly. A proposal stays open for a dispute window, 30 seconds on testnet. During it only the owner can cancel it, and the scenario’s trading and liquidations pause; after it anyone can finalize. Either event can resolve first. During the hackathon the two demo events are resolved from an outcomes file the team controls (the December Fed meeting comes after it).</p>
        <p><b>Real data: the October Fed meeting.</b> On testnet, OutLayer ran the FRED reader for the 27–28 October 2026 meeting and logged its evidence with the proposal: <code>DFEDTARU 4.00 → 4.00, DFEDTARL 3.75 → 3.75: HOLDS</code>. Leo finalized it after the window; no person typed the answer.</p>
        <p>Every position is a NEP-245 token, and lending, pools, the order book and resolution all live in one contract, so a sale, a borrow and a close each happen in a single transaction. Separately, this interface shows NEAR Intents quotes for bringing funds from other chains; they’re dry runs, since there’s no Intents testnet, and the contract itself takes only wNEAR and USDC.</p>
        <p><b>Decision markets (demo only).</b> Not in the contract yet. The Proposals page shows the idea: a DAO posts a proposal with pass and fail branches, people trade in both, the higher branch price decides, and trades in the losing branch revert.</p>
      </section>

      <section className="docs__section" id="testnet">
        <h2>On NEAR testnet</h2>
        <p>Everything runs in one contract on NEAR testnet with mock tokens. The full flow (Alice’s sale and loan, Ravi’s and Sam’s orders, Uma’s liquidity, Carl’s liquidation by Leo, the reporter’s proposals and Alice’s close) ran there on 12 November 2026 in 88 transactions, with real waits for the 30-minute price window.</p>
        <dl className="docs__terms">
          {ACCOUNTS.map(([role, id]) => <div key={id}><dt>{role}</dt><dd><a href={`${NB}/address/${id}`} target="_blank" rel="noreferrer"><code>{id}</code> ↗</a></dd></div>)}
        </dl>
        <p className="docs__caption">The October Fed meeting, resolved from FRED by OutLayer: {FED_TX.map(([name, tx], i) => <span key={tx}>{i > 0 && ' · '}<a href={`${NB}/txns/${tx}`} target="_blank" rel="noreferrer"><code>{name}</code> ↗</a></span>)}</p>
        <p>The hosted app for that deployment is <a href="https://multiverse-lending.vercel.app" target="_blank" rel="noreferrer">multiverse-lending.vercel.app</a>, and <a href={links.learn} target="_blank" rel="noreferrer">the guide from zero</a> walks through all of it lesson by lesson.</p>
      </section>

      <section className="docs__section" id="terms">
        <h2>Terms</h2>
        <dl className="docs__terms">
          {TERMS.map(([t, d]) => <div key={t}><dt>{t}</dt><dd>{d}</dd></div>)}
        </dl>
      </section>

      <section className="docs__section" id="limits">
        <h2>What this doesn’t do yet</h2>
        <ul className="docs__risks">
          {RISKS.map(([t, d]) => <li key={t}><b>{t}</b> {d}</li>)}
        </ul>
      </section>

      </article>
      </div>

      <section className="docs__section docs__end">
        <p>Based on Paradigm’s <a href={links.paper} target="_blank" rel="noreferrer">Multiverse Finance</a> paper (Dave White, May 2025).</p>
        <div className="docs__actions">
          <Button to="/market/?id=ships-fed">Try the demo scenario <span aria-hidden>&#8599;</span></Button>
          <Link href="/markets" className="docs__link">See all markets</Link>
        </div>
      </section>
    </div>
  )
}
