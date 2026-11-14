// How it works: the complete guide, in plain words, as the v2 contract runs it. Same visual system as the rest of the
// site. The words are data (src/docs/content.ts), shared with /docs.md and /llms.txt; the parts marked live (the two
// loans, the tiers, the settings, the accounts) are read from the contract when the page opens.
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { CollateralBars, type BarWorld } from '../components/CollateralBars'
import { Button } from '../components/ui'
import { chain, links } from '../config'
import { docsSections, DOCS_LEDE, DOCS_TITLE, TXS, accountsOf, type Block, type LiveWidget } from '../docs/content'
import { Inline } from '../docs/Inline'
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

const SECTIONS = docsSections({ contract: chain.contractId, wnear: chain.wnear, usdc: chain.usdc })

// which section is being read: the last one whose heading has passed the upper third of the screen
function useActiveSection() {
  const [active, setActive] = useState(SECTIONS[0].id)
  useEffect(() => {
    const on = () => {
      let cur = SECTIONS[0].id
      for (const { id } of SECTIONS) {
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

/** Everything the live parts of the page read, once. */
function useLive() {
  const cfg = useAppConfig().data
  const version = useContractVersion().data
  const fees = useFees().data
  const { market: anchor } = useMarket(ANCHOR)
  const tiers = useLendingTiers(ANCHOR, null).data
  const pc = usePriceCheck(ANCHOR).data
  const refCfg = useReferenceConfig().data
  const carl = useLoan(CARL)
  const alice = useLoan(ALICE)
  return { cfg, version, fees, anchor, tiers, pc, refCfg, carl, alice }
}
type Live = ReturnType<typeof useLive>

const LiveTag = () => <span className="docs__live">Live from the chain</span>

function LiveBlock({ widget, live }: { widget: LiveWidget; live: Live }) {
  const { cfg, version, fees, anchor, tiers, pc, refCfg, carl, alice } = live
  if (widget === 'loans') {
    const scale = Math.max(1, ...[carl, alice].flatMap((p) => (p ? [...p.worlds.map((w) => w.value), p.debt / Math.max(0.01, toNum(p.account.lltv))] : []))) * 1.12
    return (
      <div className="docs__livebox">
        <LiveTag />
        <div className="docs__compare">
          <LoanFigure who="Carl" p={carl} m={anchor} scale={scale} plain />
          <LoanFigure who="Alice" p={alice} m={anchor} scale={scale} plain={false} />
        </div>
        <p className="docs__caption">Carl posted plain wNEAR. Alice kept NEAR only where things go well and sold it for dollars in the other worlds. The what-if assumes the pools’ NEAR prices fall {DROP * 100}% and the dollars stay put.</p>
      </div>
    )
  }
  if (widget === 'tiers') {
    return (
      <div className="docs__livebox">
        <LiveTag />
        <div className="docs__scroll">
          <div className="docs__table docs__table--tiers" role="table" aria-label="The tiers of the anchor market, live">
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
        </div>
        <p className="docs__caption">Market {ANCHOR}, now: a year’s rate at today’s use of each tier.</p>
      </div>
    )
  }
  if (widget === 'config') {
    const rows: [string, string][] = [
      ['Contract version', version ? version.codeVersion : '…'],
      ['Average price window', cfg ? durationText(cfg.twapWindowSec) : '…'],
      ['Pool fee', fees ? `${feeText(fees.base)}, up to ${feeText(fees.cap)}` : '…'],
      ['Dispute window', cfg ? durationText(cfg.disputeWindowSec) : '…'],
      ['Smallest loan', cfg ? `${fmt(cfg.lending.minLoan, 0)} USDC` : '…'],
      ['Whole loan liquidated below health', cfg ? fmt(cfg.lending.fullLiquidationHf, 2) : '…'],
      ['…or with less owed than', cfg ? `${fmt(cfg.lending.smallLoan, 0)} USDC` : '…'],
      [`A world pool prices loans (market ${ANCHOR}) from`, pc ? `${durationText(pc.config.minAgeSec)} old and ${fmt(pc.config.minDepth, 0)} USDC deep` : '…'],
      ['Pools vs outside price, at most', pc ? fmtPct(pc.config.maxDeviation, 0) : '…'],
      ['Outside price older than this pauses borrowing', refCfg ? durationText(refCfg.borrowMaxAgeSec) : '…'],
    ]
    return (
      <div className="docs__livebox">
        <LiveTag />
        <dl className="docs__terms">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="num">{v}</dd></div>)}</dl>
      </div>
    )
  }
  if (widget === 'txs') {
    return (
      <div className="docs__scroll">
        <div className="docs__table docs__table--txs" role="table" aria-label="Transactions on this deployment">
          <div role="row" className="docs__tr docs__tr--head"><span>What happened</span><span>Who</span><span>Transaction</span></div>
          {TXS.map((t) => (
            <div role="row" key={t.hash} className="docs__tr">
              <span>{t.what}</span><span>{t.who}</span><span><a href={txUrl(t.hash)} target="_blank" rel="noreferrer"><code>{t.hash.slice(0, 10)}…</code> ↗</a></span>
            </div>
          ))}
        </div>
      </div>
    )
  }
  const a = accountsOf({ contract: chain.contractId, wnear: chain.wnear, usdc: chain.usdc })
  const accounts: [string, string][] = [
    ['Protocol contract', chain.contractId],
    ['Owner', cfg?.ownerId ?? a.owner],
    ['Reporter', cfg?.reporterId ?? a.reporter],
    ['Keeper', a.keeper],
    ['Maker', a.maker],
    ['Test wNEAR', chain.wnear],
    ['Test USDC', chain.usdc],
  ]
  return (
    <dl className="docs__terms">
      {accounts.map(([role, id]) => <div key={role}><dt>{role}</dt><dd><a href={accountUrl(id)} target="_blank" rel="noreferrer"><code>{id}</code> ↗</a></dd></div>)}
    </dl>
  )
}

/** The four worlds of the SPICE × Fed market as the contract numbers them, with mask 14 (every world but Ships & cuts)
 *  drawn as the crimson L-shape. */
function WorldsFigure() {
  return (
    <figure>
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
      <figcaption className="docs__caption">The highlighted L-shape, every world but Ships &amp; cuts, is mask 14 (0b1110); all four together are the root, mask 15, which is the real asset itself.</figcaption>
    </figure>
  )
}

function DocBlock({ b, live }: { b: Block; live: Live }) {
  switch (b.type) {
    case 'p': return <p><Inline text={b.text} /></p>
    case 'note': return <p className="docs__caption"><Inline text={b.text} /></p>
    case 'h3': return <h3 className="docs__h3">{b.text}</h3>
    case 'list': {
      const items = b.items.map((x) => <li key={x}><Inline text={x} /></li>)
      return b.ordered ? <ol className="docs__list docs__list--ol">{items}</ol> : <ul className="docs__list">{items}</ul>
    }
    case 'table':
      return (
        <div className="docs__scroll">
          <table className="docs__grid-table">
            <thead><tr>{b.head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
            <tbody>{b.rows.map((r) => <tr key={r.join('|')}>{r.map((c, i) => <td key={i}><Inline text={c} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      )
    case 'code': return <pre className="docs__code"><code>{b.text}</code></pre>
    case 'terms': return <dl className="docs__terms">{b.items.map(([t, d]) => <div key={t}><dt>{t}</dt><dd><Inline text={d} /></dd></div>)}</dl>
    case 'live': return <LiveBlock widget={b.widget} live={live} />
    case 'figure': return <WorldsFigure />
  }
}

export default function Docs() {
  const active = useActiveSection()
  const live = useLive()

  return (
    <div className="page docs">
      <header className="docs__head">
        <h1 className="page__title">{DOCS_TITLE}</h1>
        <p className="docs__lede">{DOCS_LEDE}</p>
        <p className="docs__alt">Also as <a href="/docs.md">plain Markdown</a> for agents, and the <a href={links.whitepaper} target="_blank" rel="noreferrer">whitepaper</a>.</p>
      </header>

      <details className="docs__mtoc">
        <summary>On this page</summary>
        <nav aria-label="On this page">{SECTIONS.map((s) => <a key={s.id} href={`#${s.id}`}>{s.toc}</a>)}</nav>
      </details>

      <div className="docs__body">
        <nav className="docs__toc" aria-label="On this page">
          {SECTIONS.map((s) => <a key={s.id} href={`#${s.id}`} className={s.id === active ? 'is-on' : ''} aria-current={s.id === active ? 'location' : undefined}>{s.toc}</a>)}
        </nav>
        <article className="docs__article">
          {SECTIONS.map((s) => (
            <section key={s.id} className="docs__section" id={s.id} aria-labelledby={`${s.id}-h`}>
              <h2 id={`${s.id}-h`}>{s.title}</h2>
              {s.blocks.map((b, i) => <DocBlock key={i} b={b} live={live} />)}
            </section>
          ))}
        </article>
      </div>

      <section className="docs__section docs__end">
        <div className="docs__actions">
          <Button to={`/market/?id=${ANCHOR}`}>Open the SPICE × Fed market <span aria-hidden>&#8599;</span></Button>
          <Link href="/markets/" className="docs__link">See all markets</Link>
        </div>
      </section>
    </div>
  )
}
