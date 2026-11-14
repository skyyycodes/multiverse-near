// The market board, in the trading screen's style: a header with totals, the featured market (the anchor) with each
// world's chance and NEAR price laid out as its grid, then search, category filters and a sort over one card per
// market, each with its artwork and its worlds' chances. Proposed markets still collecting pledges follow; settled
// markets sit at the end with what happened. Everything here is read from the contract.
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { MarketArt, WORLD_COLORS, WorldIcon, WorldTable } from '../components/Grand'
import { toNum, useMarkets, type ChainMarket } from '../chain/adapter'
import { BOARD_SORTS, boardCategories, byChance, chanceText, compactUsd, daysUntil, inFilter, matches, priceText, sortBoard, type BoardSort } from '../chain/board'
import { errorLine } from '../chain/errors'
import { useNowSeconds } from '../chain/hooks/useClock'
import { useReference } from '../chain/hooks/useLending'
import { useEventTexts, useLiveProposals } from '../chain/hooks/useMarkets'
import { proposalHref, proposeHref } from '../chain/links'
import { shortDate } from '../chain/market'
import { STATUS_LABEL, progressPct, proposalTitle } from '../chain/proposals'
import { chain } from '../config'
import { toggleWatch, useWatch } from '../lib/watch'

const SHOWN = 4 // worlds a card lists; an eight-world market says how many more it has

export default function Markets() {
  const { markets, isLoading, error } = useMarkets()
  const [filter, setFilter] = useState('All')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<BoardSort>('pool')
  const watch = useWatch()
  const now = Number(useNowSeconds())
  const ref = useReference().data

  const all = useMemo(() => markets ?? [], [markets])
  const open = all.filter((m) => !m.settled)
  const categories = ['All', ...(watch.length ? ['Watchlist'] : []), ...boardCategories(all)]
  const tab = categories.includes(filter) ? filter : 'All'
  const featured = open.find((m) => m.sid === chain.anchorMarket) ?? sortBoard(open, 'pool')[0]
  const shown = sortBoard(all.filter((m) => inFilter(m, tab, watch) && matches(m, query)), sort)
  const stat = (v: string) => (markets ? v : '–')

  return (
    <div className="page tr desk">
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">Markets</h1>
          <p className="tr__means">Each market splits into worlds, one for every way it can turn out. Open one to hedge, borrow or lend.</p>
        </div>
        <dl className="tr__stats">
          <div><dt>Open markets</dt><dd className="num">{stat(String(open.length))}</dd></div>
          <div><dt>In world pools</dt><dd className="num">{stat(compactUsd(open.reduce((t, m) => t + m.liquidity, 0)))}</dd></div>
          <div><dt>Borrowing open</dt><dd className="num">{stat(String(open.filter((m) => m.lendable).length))}</dd></div>
          {ref && (
            <div title={`The outside NEAR/USD median the contract checks its markets against, ${Math.max(0, Math.round(ref.ageSec / 60))} min old`}>
              <dt>NEAR/USD</dt><dd className="num">{priceText(toNum(ref.price))}</dd>
            </div>
          )}
          <div><dt>Settled</dt><dd className="num">{stat(String(all.length - open.length))}</dd></div>
        </dl>
        <Link href={proposeHref()} className="mk__btn mk__btn--buy">Propose a market</Link>
      </header>

      {/* ---------- featured: the anchor market ---------- */}
      {featured && <Featured m={featured} />}

      {/* ---------- search, filters, sort ---------- */}
      <div className="tr__panel mk-bar desk__bar">
        <input className="tr__find" type="search" placeholder="Search markets" aria-label="Search markets" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="pc__tabs" role="group" aria-label="Filter by category">
          {categories.map((c) => <button key={c} type="button" aria-pressed={c === tab} onClick={() => setFilter(c)}>{c}</button>)}
        </div>
        <label className="obx__ctl mk-sort"><span>Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as BoardSort)}>
            {BOARD_SORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
      </div>

      <div className="mk-grid">
        {!markets ? (
          <div className="tr__panel desk__empty mk-empty" role="status" aria-live="polite">
            {error && !isLoading ? <p><b>Couldn’t read the markets.</b> {errorLine(error.message)}</p> : <p>Reading the markets…</p>}
          </div>
        ) : all.length === 0 ? (
          <div className="tr__panel desk__empty mk-empty">
            <p><b>No markets yet.</b> Propose the first one; it opens once its pledges reach the goal.</p>
            <Link href={proposeHref()} className="mk__btn mk__btn--buy">Propose a market</Link>
          </div>
        ) : shown.length === 0 ? (
          <div className="tr__panel desk__empty mk-empty">
            <p><b>No markets match.</b> Try another word or category, or propose the market you’re looking for.</p>
            <Link href={proposeHref()} className="mk__btn mk__btn--buy">Propose a market</Link>
          </div>
        ) : (
          shown.map((m) => <Card key={m.id} m={m} now={now} starred={watch.includes(m.id)} />)
        )}
      </div>

      <Pledging />

      <p className="pc__note desk__foot">Live on NEAR testnet with test tokens. Anyone can propose a market; it opens once its pledges reach the goal.</p>
    </div>
  )
}

// The anchor market, larger: its worlds by chance on the left, and its grid of worlds (chance and NEAR's price in each)
// on the right, where the redesign drew a chart. The contract keeps no history of odds, so there is no line over time.
function Featured({ m }: { m: ChainMarket }) {
  return (
    <section className="tr__panel feat">
      <div className="feat__info">
        <p className="mk__crumb">
          <span className="mk__tag">Featured</span>
          {m.categories.join(' · ')}
          <span className="mk__tag">{m.kind}</span>
          {m.lendable && <span className="mk__tag">Borrowing open</span>}
        </p>
        <div className="feat__title">
          <MarketArt m={m} size={56} />
          <Link href={m.href} className="feat__q">{m.question}</Link>
        </div>
        <div className="feat__worlds">
          {byChance(m).map((w) => (
            <Link key={w.index} href={m.href} className="feat__world">
              <WorldIcon m={m} w={w.index} size={24} />
              <span>{w.outcome}</span>
              <b className="num" style={{ color: WORLD_COLORS[w.index % WORLD_COLORS.length] }}>{chanceText(w.chance)}</b>
            </Link>
          ))}
        </div>
        <p className="pc__note">Pools {compactUsd(m.liquidity)} · implied NEAR {priceText(m.impliedSpot)} · resolves {m.resolves}</p>
        <Link href={m.href} className="mk__btn mk__btn--buy feat__cta">Open the market</Link>
      </div>
      <WorldTable m={m} />
    </section>
  )
}

function Card({ m, now, starred }: { m: ChainMarket; now: number; starred: boolean }) {
  const worlds = byChance(m)
  const winner = m.winner === undefined ? undefined : m.worlds[m.winner]
  // the market resolves with its last event; a combination whose next answer is sooner says so instead
  const last = m.settled ? null : daysUntil(m.resolvesSec, now)
  const next = m.settled || m.deadlineSec >= m.resolvesSec ? null : daysUntil(m.deadlineSec, now)
  const soon = (d: number | null) => d !== null && d > 0 && d <= 45
  const days = (d: number) => `${d} day${d === 1 ? '' : 's'}`
  return (
    <div className="mk-cardwrap">
      <button type="button" className={`star${starred ? ' is-on' : ''}`} aria-pressed={starred} aria-label={starred ? `Remove ${m.question} from watchlist` : `Add ${m.question} to watchlist`} onClick={() => toggleWatch(m.id)}>{starred ? '★' : '☆'}</button>
      <Link href={m.href} className={`mk-card desk__mcard${m.settled ? ' is-settled' : ''}`}>
        <span className="mk-card__head">
          <MarketArt m={m} size={44} />
          <span className="mk-card__q">{m.question}</span>
        </span>
        {soon(last) ? <span className="mk-card__ends">Resolves in {days(last!)}</span> : soon(next) ? <span className="mk-card__ends">Next answer in {days(next!)}</span> : null}
        {m.settled && winner ? (
          <span className="mk-card__result"><span className="rs__state rs__state--final">Settled</span> {winner.outcome} happened. <small>The other world{m.worldCount > 2 ? 's' : ''} closed at zero.</small></span>
        ) : !m.oddsKnown ? (
          <span className="mk-card__worlds"><span className="pc__note">Odds not known yet</span></span>
        ) : (
          <span className="mk-card__worlds">
            {worlds.slice(0, SHOWN).map((w) => (
              <span key={w.index} className="mk-card__world">
                <span className="mk-card__name"><WorldIcon m={m} w={w.index} size={16} />{w.outcome}</span>
                <span className="mk-card__track"><i style={{ width: `${Math.max(0, Math.min(100, w.chance * 100))}%`, background: WORLD_COLORS[w.index % WORLD_COLORS.length] }} /></span>
                <b className="num">{chanceText(w.chance)}</b>
              </span>
            ))}
            {worlds.length > SHOWN && <span className="mk-card__more">and {worlds.length - SHOWN} more worlds</span>}
          </span>
        )}
        <span className="mk-card__foot">
          <span>{m.category}</span>
          <span>Pools <b className="num">{compactUsd(m.liquidity)}</b></span>
          <span>{m.resolves}</span>
          {!m.settled && <span>{m.lendable ? 'Borrowing open' : 'Trading only'}</span>}
        </span>
      </Link>
    </div>
  )
}

// Proposed markets still collecting pledges (or waiting for the owner's review): each opens by itself at its goal, and
// its pledges become the first liquidity. Hidden when there are none.
function Pledging() {
  const live = useLiveProposals().data
  const rows = (live ?? []).filter((p) => p.status === 'pledging' || p.status === 'review')
  const texts = useEventTexts(rows.flatMap((p) => p.eventIds)).data
  if (rows.length === 0) return null
  return (
    <section className="tr__panel mk-pledging" aria-label="Collecting pledges">
      <div className="desk__head">
        <h2 className="obx__boxtitle">Collecting pledges</h2>
        <Link className="tr__link" href={proposeHref()}>Propose a market</Link>
      </div>
      <p className="tr__means">A proposed market opens by itself once its pledges reach the goal; the pledges become its first liquidity, and come back in full if it never opens.</p>
      <div className="desk__table">
        <div className="desk__tr desk__tr--head"><span>Proposal</span><span>Status</span><span>Pledged</span><span>Ends</span></div>
        {rows.map((p) => (
          <Link key={p.proposalId} href={proposalHref(p.proposalId)} className="desk__tr">
            <span className="desk__mk">{proposalTitle(p, (id) => texts?.get(id)?.question)}</span>
            <span>{STATUS_LABEL[p.status]}</span>
            <span className="num">{progressPct(p.progressBps)} of the goal</span>
            <span>{p.expiresAtSec > 0 ? shortDate(p.expiresAtSec) : '–'}</span>
          </Link>
        ))}
      </div>
    </section>
  )
}
