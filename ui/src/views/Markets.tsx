// The market board, in the trading screen's style: a header with totals, the featured market (most volume) with its
// chance chart and worlds, then search, category filters and a sort over one card per market, each with its artwork
// and every world's chance. Settled markets sit at the end with what happened.
import { useState } from 'react'
import Link from 'next/link'
import { MarketArt, OddsChart, WORLD_COLORS, WorldIcon } from '../components/Grand'
import { pct } from '../lib/format'
import { oddsHistory } from '../lib/history'
import { bitsOf, count, has, liveOdds, spotPrice, useStore } from '../lib/scenario'
import { daysLeft, toggleWatch, useWatch } from '../lib/watch'

type Sort = 'volume' | 'soon' | 'deep' | 'new'
const SORTS: { id: Sort; label: string }[] = [
  { id: 'volume', label: 'Most traded' },
  { id: 'soon', label: 'Resolving soon' },
  { id: 'deep', label: 'Deepest pools' },
  { id: 'new', label: 'Newest' },
]
const when = (d: string) => { const t = Date.parse(d); return Number.isNaN(t) ? Infinity : t }
const compact = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`)

export default function Markets() {
  const { markets, sc } = useStore()
  const [filter, setFilter] = useState('All')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('volume')
  const watch = useWatch()
  const categories = ['All', ...(watch.length ? ['Watchlist'] : []), ...new Set(markets.map((m) => m.category))]
  const depth = (id: string) => { const s = sc[id]; return bitsOf(s.possible, s.price.length).reduce((t, w) => t + s.poolUsdc[w], 0) }
  const isSettled = (id: string) => count(sc[id].possible) === 1
  const open = markets.filter((m) => !isSettled(m.id))
  const volume = markets.reduce((t, m) => t + (m.volume ?? 0), 0)
  const pools = open.reduce((t, m) => t + depth(m.id), 0)
  const featured = [...open].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))[0]
  const fs = featured && sc[featured.id]
  const fodds = featured ? liveOdds(featured, fs) : []

  const q = query.trim().toLowerCase()
  const shown = markets
    .map((m, i) => ({ m, i, settled: isSettled(m.id) }))
    .filter(({ m }) => (filter === 'All' || (filter === 'Watchlist' ? watch.includes(m.id) : m.category === filter)) && (!q || `${m.question} ${m.events.map((e) => e.name).join(' ')} ${(m.tags ?? []).join(' ')}`.toLowerCase().includes(q)))
    .sort((a, b) => Number(a.settled) - Number(b.settled)
      || (sort === 'volume' ? (b.m.volume ?? 0) - (a.m.volume ?? 0) : sort === 'soon' ? when(a.m.resolves) - when(b.m.resolves) : sort === 'deep' ? depth(b.m.id) - depth(a.m.id) : b.i - a.i))

  return (
    <div className="page tr desk">
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">Markets</h1>
          <p className="tr__means">Each market splits into worlds, one for every way it can turn out. Open one to hedge, borrow or lend.</p>
        </div>
        <dl className="tr__stats">
          <div><dt>Open markets</dt><dd className="num">{open.length}</dd></div>
          <div><dt>Volume</dt><dd className="num">{compact(volume)}</dd></div>
          <div><dt>World pools</dt><dd className="num">{compact(pools)}</dd></div>
          <div><dt>Settled</dt><dd className="num">{markets.length - open.length}</dd></div>
        </dl>
        <Link href="/markets/new" className="mk__btn mk__btn--buy">Propose a market</Link>
      </header>

      {/* ---------- featured: the most traded open market ---------- */}
      {featured && (
        <section className="tr__panel feat">
          <div className="feat__info">
            <p className="mk__crumb"><span className="mk__tag">Featured</span>{featured.category}{featured.tags?.map((t) => <span key={t} className="mk__tag">{t}</span>)}</p>
            <div className="feat__title">
              <MarketArt m={featured} size={56} />
              <Link href={`/markets/${featured.id}`} className="feat__q">{featured.question}</Link>
            </div>
            {featured.description && <p className="tr__means">{featured.description}</p>}
            <div className="feat__worlds">
              {bitsOf(fs.possible, featured.worlds.length).sort((a, b) => fodds[b] - fodds[a]).map((b) => (
                <Link key={b} href={`/markets/${featured.id}`} className="feat__world">
                  <WorldIcon m={featured} w={b} size={24} />
                  <span>{featured.worlds[b].outcome}</span>
                  <b className="num" style={{ color: WORLD_COLORS[b % WORLD_COLORS.length] }}>{pct(fodds[b])}</b>
                </Link>
              ))}
            </div>
            <p className="pc__note">Volume {compact(featured.volume ?? 0)} · pools {compact(depth(featured.id))} · NEAR ${spotPrice(featured, fs).toFixed(2)} · resolves {featured.resolves}</p>
            <Link href={`/markets/${featured.id}`} className="mk__btn mk__btn--buy feat__cta">Open the market</Link>
          </div>
          <div className="feat__chart"><OddsChart m={featured} odds={fodds} possible={fs.possible} /></div>
        </section>
      )}

      {/* ---------- search, filters, sort ---------- */}
      <div className="tr__panel mk-bar desk__bar">
        <input className="tr__find" type="search" placeholder="Search markets" aria-label="Search markets" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="pc__tabs" role="group" aria-label="Filter by category">
          {categories.map((c) => <button key={c} type="button" aria-pressed={c === filter} onClick={() => setFilter(c)}>{c}</button>)}
        </div>
        <label className="obx__ctl mk-sort"><span>Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {SORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
      </div>

      <div className="mk-grid">
        {shown.map(({ m, settled }) => {
          const s = sc[m.id]
          const odds = liveOdds(m, s)
          const winner = m.worlds.findIndex((_, b) => has(s.possible, b))
          const order = m.worlds.map((_, b) => b).sort((a, b) => odds[b] - odds[a])
          const hist = settled ? null : oddsHistory(m.id, odds)
          const dayAgo = hist ? hist[Math.max(0, hist.length - 9)].p : null
          const left = settled ? null : daysLeft(m.resolves)
          const starred = watch.includes(m.id)
          return (
            <div key={m.id} className="mk-cardwrap">
            <button type="button" className={`star${starred ? ' is-on' : ''}`} aria-pressed={starred} aria-label={starred ? `Remove ${m.question} from watchlist` : `Add ${m.question} to watchlist`} onClick={() => toggleWatch(m.id)}>{starred ? '★' : '☆'}</button>
            <Link href={`/markets/${m.id}`} className={`mk-card desk__mcard${settled ? ' is-settled' : ''}`}>
              <span className="mk-card__head">
                <MarketArt m={m} size={44} />
                <span className="mk-card__q">{m.question}</span>
              </span>
              {left !== null && left <= 45 && <span className="mk-card__ends">Ends in {left} day{left === 1 ? '' : 's'}</span>}
              {settled ? (
                <span className="mk-card__result"><span className="rs__state rs__state--final">Settled</span> {m.worlds[winner].outcome} <small>happened. The other world{m.worlds.length > 2 ? 's' : ''} closed at zero.</small></span>
              ) : (
                <span className="mk-card__worlds">
                  {order.map((b) => (
                    <span key={b} className="mk-card__world">
                      <span className="mk-card__name"><WorldIcon m={m} w={b} size={16} />{m.worlds[b].outcome}</span>
                      <span className="mk-card__track"><i style={{ width: pct(odds[b]), background: WORLD_COLORS[b % WORLD_COLORS.length] }} /></span>
                      <b className="num">{pct(odds[b])}{dayAgo && <small className={odds[b] - dayAgo[b] >= 0 ? 'is-up' : 'is-down'}>{odds[b] - dayAgo[b] >= 0 ? '▲' : '▼'}{Math.abs((odds[b] - dayAgo[b]) * 100).toFixed(1)}</small>}</b>
                    </span>
                  ))}
                </span>
              )}
              <span className="mk-card__foot">
                <span>{m.category}</span>
                <span>Vol <b className="num">{compact(m.volume ?? 0)}</b></span>
                {!settled && <span>Pools <b className="num">{compact(depth(m.id))}</b></span>}
                <span>{settled ? 'Settled' : m.resolves}</span>
              </span>
            </Link>
            </div>
          )
        })}
        {shown.length === 0 && (
          <div className="tr__panel desk__empty mk-empty">
            <p><b>No markets match.</b> Try another word or category, or propose the market you’re looking for.</p>
            <Link href="/markets/new" className="mk__btn mk__btn--buy">Propose a market</Link>
          </div>
        )}
      </div>
      <p className="pc__note desk__foot">Testnet demo data with mock tokens. Today only the owner account opens markets.</p>
    </div>
  )
}
