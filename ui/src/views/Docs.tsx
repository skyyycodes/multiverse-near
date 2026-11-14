// How it works: the design, in plain words, as the v2 contract runs it. Same visual system as the rest of the site.
// Every number that describes the protocol (tiers, windows, fees, versions, the two live loans) is read from the
// contract when the page opens; the transaction links are real ones on this deployment.
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { CollateralBars, type BarWorld } from '../components/CollateralBars'
import { Button } from '../components/ui'
import { chain, links } from '../config'
import { positionOf, toNum, useMarket, type ChainMarket, type Position } from '../chain/adapter'
import { durationText, healthAfterDrop, postedByWorld } from '../chain/board'
import { feeText, useFees } from '../chain/board-hooks'
import { fmt, fmtPct } from '../chain/format'
import { useAppConfig, useBorrow } from '../chain/hooks/useData'
import { useLendingTiers, usePriceCheck, useReferenceConfig } from '../chain/hooks/useLending'
import { useContractVersion } from '../chain/hooks/useOps'
import { annualRate } from '../chain/lending'
import { positionTier, TIER_LABEL, TIERS } from '../chain/tiers'
import { txUrl, accountUrl } from '../chain/env'
import { usd } from '../lib/format'

const ANCHOR = chain.anchorMarket
const DROP = 0.4 // the what-if both live loans are tested against
// two staging accounts with loans on the anchor market: Carl posted plain wNEAR, Alice hedged
const ROOT = chain.contractId.replace(/^app\./, '')
const CARL = `carl.${ROOT}`
const ALICE = `alice.${ROOT}`

// Real transactions on this deployment (deployments/staging.json), each checked on chain: the smoke runs of 14 Nov 2026.
const TXS: { what: string; who: string; hash: string }[] = [
  { what: 'The v2 contract deployed', who: 'app', hash: 'C3KthRtFPyJa68XRXNqBjvE6LpTqZfPgKsAo2U73bcpU' },
  { what: 'Split 10 wNEAR into the four worlds of SPICE × Fed', who: 'a fresh account', hash: '8PiGoktaQrvKbR9xQVM9sC6q9NVRVL71DxXuQ5eehDDK' },
  { what: 'Sold that NEAR in one world, Delayed & cuts', who: 'the same account', hash: '5CvVwf2yLsQZzDVsUvx5XxPCjD9hUmcda8Qh7iHc6q2F' },
  { what: 'Posted an ask for NEAR in Ships & holds', who: 'bob', hash: 'Ar9bjstgtNF2AFVE15jyFobn6aLAJdfKkAV5A8cAtjNA' },
  { what: 'Bought 2 NEAR from that ask', who: 'the same account', hash: 'Ai3tNvAD6sDi6GYjySQMopS5bJCip44fzz9SaTDJ7nT1' },
  { what: 'Sold NEAR straight into loan collateral', who: 'the same account', hash: '3Us4dxEGopbRGNY4p8AtdEqRa3JPbqujUR4HJUA9MuB7' },
  { what: 'Lent 150 USDC to the Normal tier', who: 'sam', hash: 'CarV5RRGdwLe1o2o9nJuApGwWZ5oYe213GDkdTMFFzbi' },
  { what: 'Borrowed 110 USDC, then repaid it all', who: 'uma', hash: '6aWQo6owFhwsuA37oekhRPq4URYWU5Yz19TUJh9ioWsL' },
  { what: '(the repayment)', who: 'uma', hash: 'Hr8Te74cVvymD8BLFTzrnnUcg7PsvhivFVy15KHUmVMs' },
  { what: 'Posted the outside NEAR/USD price', who: 'reporter', hash: '6FiZKCn78TnTnnUSbMeWGMBqPG1vrRN5tnN4uRDNrqrd' },
  { what: 'Proposed a new question: NEAR above $3.25 on 31 Dec', who: 'sam', hash: '39Eu1oWYGZHmj9pMJRsJhVuNenVjzeRLp1QUFXWfZVnz' },
  { what: 'Approved it', who: 'owner', hash: '7etK5dUxeD6hRCi2n9j1RhLDunZ9PUcKdx6xrdeSYkGp' },
  { what: 'Proposed the December Fed question as a market', who: 'uma', hash: 'F69pf735E5XLuRnzUJ8hggD5S6bG7AtMQ5b228qXPwZX' },
  { what: 'The pledge that reached its goal and opened it', who: 'alice', hash: '5vFZLCzAniB96gvVsudAY9WuMcKqk42ddxh8NXqAViAR' },
  { what: 'Paused pledges, then unpaused them', who: 'owner', hash: 'DoaqE9h9JfiEps8MYPQSu97fLyJsp6uZWM5a4hqGrcET' },
  { what: '(the unpause)', who: 'owner', hash: '2hPyr89awCrvpmmHD29Sgauy4Z14EkQtSbXHaxittQMn' },
]
// The two questions answered on this deployment, with their transactions.
const OCT_FED = { ask: 'GH1fftYYX8RU56GsgyAadCM1yfHHFdmzcvhDdUQrijqy', finalize: '5C1dsLULtK2cnLCneEHwCWtUM86AsBKiWSHdvBLkjYfW' }
const NOV_NEAR = { report: '4JUNNwUAZzHArvY6TwBtiZftuztFAxiqsQs59rmpyK9R', finalize: 'C6et7nkCPb6tdLyqZZqw7dnDGHHZfwXpDVvtmZn6vvYw' }

const TOC: [string, string][] = [
  ['problem', 'The problem'],
  ['worlds', 'How worlds work'],
  ['example', 'Two loans, live'],
  ['borrowing', 'Borrowing'],
  ['prices', 'Prices'],
  ['proposals', 'Proposals'],
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

const Tx = ({ hash, children }: { hash: string; children: string }) => <a href={txUrl(hash)} target="_blank" rel="noreferrer"><code>{children}</code> ↗</a>

/** One account's loan on the anchor market, in the tier it borrows in. */
function useLoan(account: string): Position | undefined {
  const tiers = useLendingTiers(ANCHOR, account).data
  const tier = positionTier(tiers, 'borrow')
  const snap = useBorrow(tier ? ANCHOR : undefined, account, tier ?? 'normal').data
  return snap && tier ? positionOf(snap, tier) : undefined
}

/** A loan's worlds as bars, in the market's grid order (Ships & cuts, Ships & holds, Delayed & cuts, Delayed & holds). */
function barsOf(p: Position, m: ChainMarket): { bars: BarWorld[]; drop: number | null } {
  const order = m.grid.rows.flatMap((r) => r.worlds)
  const posted = postedByWorld(p.collateral, p.scenario.worlds)
  const bars = order.map((w): BarWorld => {
    const near = toNum(posted[w].near), usdc = toNum(posted[w].usdc)
    const hold = near > 0 ? `${Math.round(near).toLocaleString('en-US')} NEAR` : `${Math.round(usdc).toLocaleString('en-US')} USDC`
    return { name: m.worlds[w].outcome, hold, usdc: near === 0 && usdc > 0, value: p.worlds[w].value, price: p.worlds[w].price, dead: !m.worlds[w].possible }
  })
  const rows = order.map((w) => ({ value: p.worlds[w].value, near: toNum(posted[w].near), price: p.worlds[w].price, possible: m.worlds[w].possible }))
  return { bars, drop: healthAfterDrop(rows, p.debt, toNum(p.account.lltv), DROP) }
}

function LoanFigure({ who, p, m, scale, plain }: { who: string; p: Position | undefined; m: ChainMarket | undefined; scale: number; plain: boolean }) {
  if (!p || !m) return <figure><p className="docs__caption">Reading {who}’s loan…</p></figure>
  if (p.debt <= 0) return <figure><p className="docs__caption">{who} has no loan on this market right now.</p></figure>
  const { bars, drop } = barsOf(p, m)
  const worst = p.worstWorld !== null ? m.worlds[p.worstWorld] : undefined
  const floor = p.worstWorld !== null ? p.worlds[p.worstWorld].value : 0
  const hf = p.health ?? 0
  return (
    <figure>
      <CollateralBars worlds={bars} needs={toNum((p.debtWad * 10n ** 18n) / (p.account.lltv || 1n))} scale={scale} />
      <figcaption>
        <b>{who}, {TIER_LABEL[p.tier]} tier.</b>{' '}
        {plain ? 'Plain wNEAR, posted as collateral: it counts in every world at NEAR’s price there.' : 'NEAR kept in one world, dollars in the others, all posted as collateral.'}{' '}
        Weakest world {worst?.outcome ?? '–'}, counted at {usd(floor)}; with {usd(p.debt)} borrowed, health {hf.toFixed(2)}.{' '}
        {drop !== null && <>If NEAR fell {DROP * 100}%, {plain ? 'every world would fall with it' : 'only the NEAR world would fall'}: health {drop.toFixed(2)}{drop < 1 ? ', and anyone could liquidate it.' : '.'}</>}
      </figcaption>
    </figure>
  )
}

export default function Docs() {
  const active = useActiveSection()
  const cfg = useAppConfig().data
  const version = useContractVersion().data
  const fees = useFees().data
  const { market: anchor } = useMarket(ANCHOR)
  const tiers = useLendingTiers(ANCHOR, null).data
  const pc = usePriceCheck(ANCHOR).data
  const carl = useLoan(CARL)
  const alice = useLoan(ALICE)
  const scale = Math.max(1, ...[carl, alice].flatMap((p) => (p ? [...p.worlds.map((w) => w.value), p.debt / Math.max(0.01, toNum(p.account.lltv))] : []))) * 1.12
  const normal = tiers?.find((t) => t.tier === 'normal')?.market.config
  const dispute = cfg ? durationText(cfg.disputeWindowSec) : 'a short window'
  const refCfg = useReferenceConfig().data
  const accounts: [string, string][] = [
    ['Protocol contract', chain.contractId],
    ...(cfg ? [['Owner', cfg.ownerId] as [string, string]] : []),
    ...(cfg?.reporterId ? [['Reporter', cfg.reporterId] as [string, string]] : []),
    ['Test wNEAR', chain.wnear],
    ['Test USDC', chain.usdc],
  ]

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
        <p>A market asks one, two or three yes-or-no questions, each with a rule for how it resolves and a public source. Every combination of answers is a world, numbered from 0, so a market has 2, 4 or 8 worlds. The anchor market asks two: does SPICE ship on NEAR mainnet by 31 March 2027, and does the Fed cut at its December meeting.</p>
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
        <p className="docs__caption">As the contract numbers them: world = first answer + 2 × second (+ 4 × third). The highlighted L-shape, every world but Ships &amp; cuts, is mask 14 (0b1110); all four together are the root, 15, which is the real asset itself.</p>
        <p>A <b>verse</b> is one asset on one set of worlds: wNEAR-if-14 pays one wNEAR if the world that comes true is in mask 14. Depositing 1 NEAR <b>splits</b> it into one piece per world; holding every piece <b>merges</b> back to 1 NEAR at any time. When a question is answered, the worlds that didn’t happen die, and once one world is left its pieces <b>redeem</b> 1:1 for the real token, whatever order the answers came in.</p>
      </section>

      <section className="docs__section" id="example">
        <h2>Two loans, live</h2>
        <p>Two staging accounts borrow against the SPICE × Fed market right now, and the bars below are read from the contract as you open this page. Carl posted plain wNEAR. Alice kept NEAR only where things go well and sold it for dollars in the other three worlds; each sale is one transaction that splits her NEAR into all four worlds and sells the pieces she picked.</p>
        <div className="docs__compare">
          <LoanFigure who="Carl" p={carl} m={anchor} scale={scale} plain />
          <LoanFigure who="Alice" p={alice} m={anchor} scale={scale} plain={false} />
        </div>
        <p>A lender counts only the weakest world, because that is the one that could come true. Plain NEAR is weakest wherever NEAR is cheapest, and gets weaker when NEAR falls everywhere. Dollars in the worlds you fear don’t fall with NEAR, so the hedged loan keeps its health through the same drop. The what-if numbers here assume the pools’ prices fall by {DROP * 100}% and the dollars stay put.</p>
      </section>

      <section className="docs__section" id="borrowing">
        <h2>Borrowing: your weakest world sets the limit</h2>
        <p>Each collateral piece is valued in every world still possible: NEAR-if-world at that world’s price where it pays and nothing elsewhere, USDC-if-world in full where it pays, real wNEAR and USDC in every world. The loan is real USDC, owed the same in every world. Health = weakest world × the tier’s liquidation line ÷ debt.</p>
        <p><b>Three tiers.</b> A market that lends has three, each its own pool of lenders with its own limits and rate. A loan lives in one tier, with the pieces posted for it. On the anchor market today:</p>
        <div className="docs__table docs__table--tiers" role="table">
          <div role="row" className="docs__tr docs__tr--head"><span>Tier</span><span>Borrow up to</span><span>Liquidated at</span><span>Bonus</span><span>Borrowers pay</span><span>Lenders earn</span></div>
          {TIERS.map((t) => {
            const x = tiers?.find((y) => y.tier === t)?.market
            return (
              <div role="row" key={t} className="docs__tr">
                <span>{TIER_LABEL[t]}</span>
                <span className="num">{x ? fmtPct(x.config.borrowLtv, 0) : '…'}</span>
                <span className="num">{x ? fmtPct(x.config.lltv, 0) : '…'}</span>
                <span className="num">{x ? fmtPct(x.config.liquidationBonus, 0) : '…'}</span>
                <span className="num">{x ? fmtPct(annualRate(x.borrowRatePerSec), 2) : '…'}</span>
                <span className="num">{x ? fmtPct(annualRate(x.supplyRatePerSec), 2) : '…'}</span>
              </div>
            )
          })}
        </div>
        <p className="docs__caption">A year’s rate at today’s use of each tier. Rates follow how much of a tier is lent out: gentle until {normal ? fmtPct(normal.rateKink, 0) : '…'}, steep after it, and no new loans past {normal ? fmtPct(normal.maxUtilization, 0) : '…'}. {normal ? fmtPct(normal.reserveFactor, 0) : '…'} of the interest goes to the tier’s insurance reserve, which absorbs bad debt before lenders do.</p>
        <p><b>The limit.</b> A new loan values each world at the lower of its pool price and its 30-minute average, at the tier’s borrow line, which sits below its liquidation line: a loan that just passed can’t be liquidated in the same block. The smallest loan is {cfg ? fmt(cfg.lending.minLoan, 0) : '…'} USDC.</p>
        <p><b>Liquidation.</b> Below 1, anyone can repay part of the loan with their own USDC and take the same fraction of every posted piece, plus the tier’s bonus; below {cfg ? fmt(cfg.lending.fullLiquidationHf, 1) : '…'}, or with less than {cfg ? fmt(cfg.lending.smallLoan, 0) : '…'} USDC owed, the whole loan. The liquidator takes the pieces, or has them sold for USDC in the same transaction. Cutting every piece by the same fraction keeps the weakest world weakest. <Link href="/liquidate/">At-risk loans</Link> lists every loan below a health you choose, and a keeper bot hosted with this site liquidates on its own. Liquidation waits while an answer is in its dispute window, or while a world’s pool is too young or thin to price.</p>
        <p><b>Closing.</b> Once every question is answered, one transaction repays the loan from the surviving world’s pieces and pays out the rest (on <Link href="/resolve/">Resolve</Link>).</p>
        <p><b>Why an answer can’t create bad debt.</b> Answering a question only removes worlds from the set your health is measured over. A minimum over fewer worlds is never lower, so health can only rise, in any order.</p>
      </section>

      <section className="docs__section" id="prices">
        <h2>Prices and odds</h2>
        <p><b>Inside a world</b>, lending prices NEAR from that world’s pool, as its average over {cfg ? durationText(cfg.twapWindowSec) : '30 minutes'}, so a single trade can’t fake it. A world counts toward lending once its pool is {pc ? durationText(pc.config.minAgeSec) : '…'} old and holds {pc ? fmt(pc.config.minDepth, 0) : '…'} USDC, and while its live price stays near that average; a world without a trusted price counts zero toward new loans. Pools stop trading while an answer is in dispute and once their world is dead. Each pool charges {fees ? feeText(fees.base) : '…'} a swap, rising toward {fees ? feeText(fees.cap) : '…'} when trading is one-sided.</p>
        <p><b>Between worlds</b>, pools such as Ships vs Delayed imply each answer’s odds. A new combination opens with joint odds that assume its questions are independent; trading moves them after. NEAR’s price the odds imply is the odds-weighted average of the world prices, and each market page checks that sum against the contract’s own.</p>
        <p><b>The outside check.</b> A market that lends compares the NEAR price it implies (from its pools’ 30-minute averages) with an outside NEAR/USD median of Coinbase, Kraken, Gemini and CoinGecko. If the two are more than {pc ? fmtPct(pc.config.maxDeviation, 0) : '10%'} apart, or the outside price is more than {refCfg ? durationText(refCfg.borrowMaxAgeSec) : 'an hour'} old, new borrowing pauses; repaying, adding collateral and leaving never do. On this deployment a keeper computes the median and posts it with the reporter’s key (<Tx hash={TXS[9].hash}>report_reference</Tx>); the contract can also take it from an OutLayer enclave.</p>
      </section>

      <section className="docs__section" id="proposals">
        <h2>Proposals and pledges</h2>
        <p>Anyone can propose a market. A <b>new question</b> (its rule, public source, deadline and category) goes to the owner for review. A <b>combination</b> of up to three open questions needs no review. Each proposal has a goal in USDC, and anyone can pledge USDC or wNEAR toward it.</p>
        <p>The pledge that reaches the goal opens the market: the pledges become its pools, and the pledgers own that seed liquidity, locked for a week. If a proposal expires, is rejected or is cancelled, every pledge comes back. The proposer’s bond comes back once the market is accepted.</p>
        <p className="docs__caption">On this deployment: a new question proposed (<Tx hash={TXS[10].hash}>propose_event</Tx>) and approved (<Tx hash={TXS[11].hash}>approve_proposal</Tx>); the December Fed question proposed as a market (<Tx hash={TXS[12].hash}>propose_market</Tx>) and opened by the pledge that reached its goal (<Tx hash={TXS[13].hash}>pledge</Tx>). <Link href="/proposals/">See the proposals</Link> or <Link href="/propose/">propose a market</Link>.</p>
      </section>

      <section className="docs__section" id="resolution">
        <h2>Resolution</h2>
        <p>An answer comes in one of three ways: the reporter account proposes it with its evidence, OutLayer reads public data inside a secure enclave and proposes it, or the owner resolves it directly. A proposal stays open for {dispute}. During it only the owner can dispute it, and that market’s trading and liquidations pause; after it anyone can finalize it. The questions can be answered in any order.</p>
        <p><b>Real data: the October Fed meeting.</b> OutLayer ran the FRED reader for the 27–28 October 2026 meeting: both limits of the target range unchanged, so HOLDS. Nobody typed the answer: <Tx hash={OCT_FED.ask}>request_resolution</Tx>, then <Tx hash={OCT_FED.finalize}>finalize</Tx> after the window.</p>
        <p><b>Real data: NEAR on 1 November.</b> The reporter answered YES with its evidence, Coinbase’s close at 4.284 and Kraken’s at 4.2827 against the $4.00 line: <Tx hash={NOV_NEAR.report}>report_outcome</Tx>, then <Tx hash={NOV_NEAR.finalize}>finalize</Tx>.</p>
        <p>Every position is a NEP-245 token, and lending, pools, the order book and resolution all live in one contract, so a sale, a borrow and a close each happen in a single transaction.</p>
        <p><b>Decision markets.</b> Not built. <Link href="/decision-markets/">The roadmap page</Link> explains the idea: a DAO posts a proposal with pass and fail branches, people trade in both, and the higher branch decides.</p>
      </section>

      <section className="docs__section" id="testnet">
        <h2>On NEAR testnet</h2>
        <p>Everything runs in one contract on NEAR testnet with test tokens{version ? `, version ${version.codeVersion}` : ''}. These transactions ran on it on 14 November 2026, from the deploy and seed scripts and the end-to-end tests:</p>
        <div className="docs__table docs__table--txs" role="table">
          <div role="row" className="docs__tr docs__tr--head"><span>What happened</span><span>Who</span><span>Transaction</span></div>
          {TXS.map((t) => (
            <div role="row" key={t.hash} className="docs__tr">
              <span>{t.what}</span><span>{t.who}</span><span><a href={txUrl(t.hash)} target="_blank" rel="noreferrer"><code>{t.hash.slice(0, 10)}…</code> ↗</a></span>
            </div>
          ))}
        </div>
        <dl className="docs__terms">
          {accounts.map(([role, id]) => <div key={id}><dt>{role}</dt><dd><a href={accountUrl(id)} target="_blank" rel="noreferrer"><code>{id}</code> ↗</a></dd></div>)}
        </dl>
        <p><a href={links.learn} target="_blank" rel="noreferrer">The guide from zero</a> walks through all of it lesson by lesson.</p>
      </section>

      <section className="docs__section" id="terms">
        <h2>Terms</h2>
        <dl className="docs__terms">
          {[
            ['World', 'One combination of the questions’ answers, numbered from 0. Two yes/no questions make four worlds, three make eight.'],
            ['Mask', 'A set of worlds as bits: bit w set means world w is in it. Mask 14 (0b1110) is every world but world 0.'],
            ['Verse', 'One asset on one mask of one market, e.g. wNEAR-if-14: it pays 1 wNEAR if the world that comes true is in mask 14. The root mask (every world) is the real asset itself.'],
            ['Split / merge', 'Turn an amount on one mask into the same amount on each part of a split of it, or join the parts back.'],
            ['Live, dead, collapsed', 'A verse is live while its mask touches a world still possible, dead once it doesn’t, and collapsed once it covers every possible world.'],
            ['Redeem', 'A collapsed verse pays one real token per token. After the last answer, the pieces of the surviving world redeem 1:1.'],
            ['Token', 'Every verse is a NEP-245 token with id “{market}:{asset}:{mask}”, for example 1:wnear:14, with 18 decimals, all in one contract.'],
            ['Backing rule', 'In every world still possible, for every asset, what all verses pay there adds up to the reserves. Each market page shows it as “every world balances”.'],
            ['Tier', 'Safe, Normal or Bold: one pool of lenders per market with its own borrow line, liquidation line, bonus and rate.'],
            ['Health factor', 'Weakest world × the tier’s liquidation line ÷ debt. Below 1, anyone can liquidate.'],
            ['Proposal and pledge', 'A market someone asked for, and money promised toward its goal. The pledge that reaches the goal opens it; otherwise every pledge comes back.'],
            ['Reporter and keeper', 'The reporter proposes answers with evidence and posts the outside NEAR/USD price; the keeper is the bot that does the second and liquidates unhealthy loans.'],
          ].map(([t, d]) => <div key={t}><dt>{t}</dt><dd>{d}</dd></div>)}
        </dl>
      </section>

      <section className="docs__section" id="limits">
        <h2>What this doesn’t do yet</h2>
        <ul className="docs__risks">
          <li><b>Testnet only, test tokens, not audited.</b> Nothing here is real money.</li>
          <li><b>At most three questions per market.</b> Each one doubles the worlds and the pools that need money; more needs a redesign.</li>
          <li><b>New questions need the owner.</b> Combinations of open questions don’t, but a brand-new question waits for review.</li>
          <li><b>Prices lag up to 30 minutes.</b> Loans are judged on each world’s 30-minute average, so in a fast crash the contract reacts late, and someone with enough money could hold one world’s price down for the window.</li>
          <li><b>The outside price needs a keeper.</b> If nobody posts NEAR/USD for an hour, new borrowing pauses until someone does.</li>
          <li><b>Joint odds start out independent.</b> A new combination opens as if its questions don’t affect each other; only trading corrects that.</li>
          <li><b>No decision markets.</b> They are on the roadmap, not in the contract.</li>
        </ul>
      </section>

      </article>
      </div>

      <section className="docs__section docs__end">
        <p>Based on Paradigm’s <a href={links.paper} target="_blank" rel="noreferrer">Multiverse Finance</a> paper (Dave White, May 2025).</p>
        <div className="docs__actions">
          <Button to={`/market/?id=${ANCHOR}`}>Open the SPICE × Fed market <span aria-hidden>&#8599;</span></Button>
          <Link href="/markets/" className="docs__link">See all markets</Link>
        </div>
      </section>
    </div>
  )
}
