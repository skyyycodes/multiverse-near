// The market page, in the trading screen's style: a header with the market's artwork and stats, a chart of each
// world's chance over time, one row per world (pick the worlds you fear, or trade one), and tabs for the rules,
// resolution, activity and the live checks. On the right: your position, the ticket (fund, hedge, borrow, lend,
// liquidity) and related markets. Resolution runs as on testnet: a reporter proposes, the owner can dispute during
// the window, then anyone finalizes.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { pct, usd } from '../lib/format'
import { oddsHistory } from '../lib/history'
import {
  DISPUTE_MS, FEE, LLTV, YOU, actions, backing, backingCheck, bitsOf, bookOf, canBorrow, count, fullMask, has, health, hedged,
  holdsAnything, liveOdds, maxBorrow, outcomeIn, presets, rates, runInvariantTests, shapeName, spotPrice, useScenario, useStore, worstWorld, worth, type Order, type TestReport,
} from '../lib/scenario'
import type { Market } from '../lib/types'
import { useTween } from '../lib/useTween'
import { useClient, useWallet } from '../lib/wallet'
import { SOURCES as INTENT_SOURCES, type SourceId } from '../lib/intents'
import { Gauge, MarketArt, OddsChart, WORLD_COLORS, WorldIcon } from './Grand'
import { IntentsQuote } from './IntentsQuote'
import { Button } from './ui'
import { toggleWatch, useWatch } from '../lib/watch'

type Tab = 'fund' | 'hedge' | 'borrow' | 'lend' | 'pool'
const TABS: { id: Tab; label: string }[] = [
  { id: 'fund', label: 'Fund' },
  { id: 'hedge', label: 'Hedge' },
  { id: 'borrow', label: 'Borrow' },
  { id: 'lend', label: 'Lend' },
  { id: 'pool', label: 'Liquidity' },
]
type Lower = 'rules' | 'resolution' | 'activity' | 'holders' | 'checks'
// where a deposit can come from: your NEAR wallet, or another chain through NEAR Intents (dry-run quotes)
const FROM = [{ id: 'wallet', label: 'NEAR wallet' }, ...INTENT_SOURCES.map((x) => ({ id: x.id, label: `${x.label}, via NEAR Intents` }))]
const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
const cap = (n: number) => `$${Math.floor(n + 1e-9).toLocaleString('en-US')}` // a borrowing limit rounds down, never up
const clock = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
const compact = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`)

// a world row, expanded: its best resting orders either side of the pool price, as Polymarket expands an outcome
function WorldBook({ m, w, pool, orders }: { m: Market; w: number; pool: number; orders: Order[] }) {
  const bk = bookOf(orders, m.id, w)
  const asks = bk.asks.slice(0, 4).reverse(), bids = bk.bids.slice(0, 4)
  const top = Math.max(1, ...[...asks, ...bids].map((o) => o.amount))
  const spread = bk.asks[0] && bk.bids[0] ? bk.asks[0].price - bk.bids[0].price : null
  const lvl = (o: Order, side: 'ask' | 'bid') => (
    <span key={o.id} className={`mk__lvl is-${side}`}><i style={{ width: `${(o.amount / top) * 100}%` }} /><b className="num">${o.price.toFixed(2)}</b><span className="num">{fmt(o.amount)} NEAR</span><small>{o.owner === YOU ? 'you' : o.owner}</small></span>
  )
  return (
    <div className="mk__book">
      <div className="mk__bookcol">
        <p className="pc__note">Order book · {m.worlds[w].outcome}</p>
        {asks.map((o) => lvl(o, 'ask'))}
        <span className="mk__lvlmid num">pool ${pool.toFixed(2)} · spread {spread === null ? '–' : `$${spread.toFixed(2)}`}</span>
        {bids.map((o) => lvl(o, 'bid'))}
        {asks.length + bids.length === 0 && <span className="pc__note">No resting orders in this world.</span>}
      </div>
      <div className="mk__bookacts">
        <p className="pc__note">Trade NEAR that pays only if {m.worlds[w].outcome.toLowerCase()} happens.</p>
        <Link className="mk__btn mk__btn--buy" href={`/orders?m=${m.id}&w=${w}`}>Buy NEAR here</Link>
        <Link className="mk__btn mk__btn--sell" href={`/orders?m=${m.id}&w=${w}`}>Sell NEAR here</Link>
      </div>
    </div>
  )
}

// who has money resting in this market: the demo's traders, by their orders, and you
function Holders({ mid, orders, spot, you }: { mid: string; orders: Order[]; spot: number; you: number | null }) {
  const by = new Map<string, { near: number; usdc: number; n: number }>()
  orders.filter((o) => o.scenario === mid && o.owner !== YOU).forEach((o) => {
    const v = by.get(o.owner) ?? { near: 0, usdc: 0, n: 0 }
    if (o.side === 'ask') v.near += o.amount; else v.usdc += o.amount * o.price
    v.n++; by.set(o.owner, v)
  })
  const rows = [...by.entries()].sort((p, q) => (q[1].usdc + q[1].near * spot) - (p[1].usdc + p[1].near * spot))
  return (
    <div className="desk__table">
      <p className="tr__means">Traders with orders resting in this market (the testnet demo’s people), and your own position.</p>
      <div className="desk__tr desk__tr--head"><span>Trader</span><span>NEAR offered</span><span>USDC bid</span><span>Orders</span></div>
      {you !== null && <div className="desk__tr"><span className="desk__mk"><span className="hold__av is-you">Y</span>You <small className="muted">· worth {usd(you)} on average</small></span><span className="num">–</span><span className="num">–</span><span className="num">–</span></div>}
      {rows.map(([k, v]) => (
        <div key={k} className="desk__tr"><span className="desk__mk"><span className="hold__av">{k.slice(0, 1).toUpperCase()}</span>{k}</span><span className="num">{fmt(v.near)}</span><span className="num">{usd(v.usdc)}</span><span className="num">{v.n}</span></div>
      ))}
    </div>
  )
}

export function ScenarioMarket({ market: m }: { market: Market }) {
  const s = useScenario(m.id)
  const { pool, wallet, markets, sc, orders, history } = useStore()
  const watch = useWatch()
  const [open, setOpen] = useState<number | null>(null) // the world row whose order book is expanded
  const [copied, setCopied] = useState(false)
  const mine = history.filter((h) => h.scenario === m.id)
  const { account, connect, connectDemo, isDemo } = useWallet()
  const client = useClient()
  const n = m.worlds.length
  const all = fullMask(m)
  const [mask, setMask] = useState(all ^ 1) // start on every world but the first: for the demo, the doc's L-shape
  const [tab, setTab] = useState<Tab>(s.near.some((x) => x > 0) ? 'hedge' : 'fund')
  const [lower, setLower] = useState<Lower>('rules')
  const [amount, setAmount] = useState('')
  const [asset, setAsset] = useState<'near' | 'usdc'>('near')
  const [source, setSource] = useState<string>('wallet')
  const [report, setReport] = useState<TestReport | null>(null)
  const [now, setNow] = useState(() => Date.now()) // the dispute-window clock
  const a = Number(amount) || 0

  // the dispute-window clock ticks only while a proposal is open
  const pending = s.proposals.some(Boolean)
  useEffect(() => {
    if (!pending) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [pending])

  const odds = liveOdds(m, s)
  const spot = spotPrice(m, s)
  const worst = worstWorld(s)
  const hf = health(s)
  const limit = maxBorrow(s)
  const debtShown = useTween(s.debt)
  const r = rates(pool)
  const oneLeft = count(s.possible) === 1
  const funded = holdsAnything(s)
  const checks = backingCheck(s)
  const balanced = checks.every((c) => c.ok)
  const liveWorlds = bitsOf(s.possible, n)
  const pick = mask & s.possible
  const depth = liveWorlds.reduce((t, w) => t + s.poolUsdc[w], 0)
  // a day ago, for the change beside each world's chance (8 points of 3 hours)
  const hist = oddsHistory(m.id, odds)
  const before = hist[Math.max(0, hist.length - 9)].p
  // markets that share one of this market's events, e.g. "SPICE only" next to "SPICE × Fed"
  const related = markets.filter((x) => x.id !== m.id && x.events.some((e) => m.events.some((f) => f.name === e.name)))
  const others = markets.filter((x) => x.id !== m.id && !related.includes(x) && !x.settled).slice(0, Math.max(0, 3 - related.length))

  const toggle = (bit: number) => { setMask((x) => x ^ (1 << bit)); setTab('hedge') }
  const preview = hedged(s, pick)
  const sellable = liveWorlds.some((w) => has(pick, w) && s.near[w] > 0)
  // the USDC the sale must return at least, across the chosen worlds (1% slippage on the preview)
  const minOut = liveWorlds.reduce((t, w) => t + (preview.usdc[w] - s.usdc[w]), 0) * 0.99
  const reset = () => { actions.reset(m.id); setMask(all ^ 1); setReport(null) }
  const means = (b: number) => m.events.map((ev, e) => `${ev.name}: ${ev.outcomes[outcomeIn(m, e, b)]}`).join(' · ')

  return (
    <div className="page tr mk">
      {/* ---------- header ---------- */}
      <header className="tr__pair mk__head">
        <MarketArt m={m} size={64} />
        <div className="tr__id">
          <p className="mk__crumb"><Link href="/markets">Markets</Link> <span aria-hidden>/</span> {m.category}{m.tags?.map((t) => <span key={t} className="mk__tag">{t}</span>)}</p>
          <h1 className="mk__title">{m.question}</h1>
          {m.description && <p className="tr__means">{m.description}</p>}
        </div>
        <dl className="tr__stats">
          <div><dt>Volume</dt><dd className="num">{compact(m.volume ?? 0)}</dd></div>
          <div><dt>World pools</dt><dd className="num">{compact(depth)}</dd></div>
          <div><dt>Spot NEAR</dt><dd className="num">${spot.toFixed(2)}</dd></div>
          <div><dt>{oneLeft ? 'Status' : 'Resolves'}</dt><dd className="num">{oneLeft ? 'Settled' : m.resolves}</dd></div>
        </dl>
        <div className="mk__headacts">
          <button type="button" className={`star${watch.includes(m.id) ? ' is-on' : ''}`} aria-pressed={watch.includes(m.id)} aria-label="Watchlist" title={watch.includes(m.id) ? 'On your watchlist' : 'Add to watchlist'} onClick={() => toggleWatch(m.id)}>{watch.includes(m.id) ? '★' : '☆'}</button>
          <button type="button" className="mk__btn" onClick={() => { navigator.clipboard?.writeText(window.location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}>{copied ? 'Link copied' : 'Share'}</button>
        </div>
      </header>

      <div className="mk__grid">
        <div className="mk__main">
          {/* ---------- chance of each world over time ---------- */}
          <section className="tr__panel">
            <OddsChart m={m} odds={odds} possible={s.possible} />
          </section>

          {/* ---------- one row per world ---------- */}
          <section className="tr__panel mk__worlds" aria-label="Worlds">
            <div className="mk__rowhead">
              <span>World</span><span>Chance</span><span>NEAR there</span><span>You hold</span><span />
            </div>
            {m.worlds.map((w, b) => {
              const dead = !has(s.possible, b)
              const picked = has(mask, b) && !dead
              const holdsNear = s.near[b] > 0
              const empty = !holdsNear && s.usdc[b] <= 0
              const ch = odds[b] - before[b]
              const isWorst = worst === b && funded && !oneLeft
              return (
                <div key={w.id} className={`mk__row${dead ? ' is-dead' : ''}${picked ? ' is-picked' : ''}`}>
                  <span className="mk__who">
                    <WorldIcon m={m} w={b} possible={s.possible} />
                    <span>
                      <b>{w.outcome}{isWorst && <em className="mk__flag">worst world</em>}</b>
                      <small>{means(b)}</small>
                    </span>
                  </span>
                  <span className="mk__chance">
                    <b className="num">{dead ? '0%' : pct(odds[b])}</b>
                    {!dead && <small className={`num ${ch >= 0 ? 'is-up' : 'is-down'}`}>{ch >= 0 ? '▲' : '▼'} {Math.abs(ch * 100).toFixed(1)}</small>}
                  </span>
                  <span className="num">${s.price[b].toFixed(2)}</span>
                  <span className="mk__hold">
                    {dead ? <span className="muted">Worth zero</span> : empty ? <span className="muted">–</span> : (
                      <><b className={`num ${holdsNear ? '' : 'is-usdc'}`}>{holdsNear ? `${fmt(s.near[b])} NEAR` : `${fmt(s.usdc[b])} USDC`}</b><small className="num">{usd(worth(s, b))}</small></>
                    )}
                  </span>
                  <span className="mk__acts">
                    {dead ? <span className="muted">Closed</span> : (
                      <>
                        <button type="button" className={`mk__btn mk__btn--sell${picked ? ' is-on' : ''}`} aria-pressed={picked} onClick={() => toggle(b)} title="Pick this world to sell your NEAR there for dollars">
                          {picked ? 'Hedging' : 'Hedge'}
                        </button>
                        <Link className="mk__btn mk__btn--buy" href={`/orders?m=${m.id}&w=${b}`}>Trade</Link>
                        <button type="button" className={`mk__chev${open === b ? ' is-open' : ''}`} aria-expanded={open === b} aria-label={`Order book for ${w.outcome}`} onClick={() => setOpen(open === b ? null : b)}>▾</button>
                      </>
                    )}
                  </span>
                  {open === b && !dead && <WorldBook m={m} w={b} pool={s.price[b]} orders={orders} />}
                </div>
              )
            })}
            <div className="mk__shape">
              <span>Picked: <b>{shapeName(m, pick)}</b></span>
              <div className="pc__tabs">
                {presets(m).map((p) => <button key={p.mask} type="button" onClick={() => setMask(p.mask)}>{p.label}</button>)}
                <button type="button" onClick={() => setMask(0)}>Clear</button>
              </div>
            </div>
          </section>

          {/* ---------- rules, resolution, activity, checks ---------- */}
          <section className="tr__panel">
            <div className="pc__tabs mk__lowertabs" role="group" aria-label="More about this market">
              {([['rules', 'Rules'], ['resolution', 'Resolution'], ['activity', `Activity (${mine.length})`], ['holders', 'Holders'], ['checks', 'Checks']] as const).map(([id, label]) => (
                <button key={id} type="button" aria-pressed={lower === id} onClick={() => setLower(id)}>{label}</button>
              ))}
            </div>

            {lower === 'rules' ? (
              <div className="mk__rules">
                {m.events.map((ev) => (
                  <article key={ev.name} className="mk__rule">
                    {ev.image && <img src={ev.image} alt="" width={40} height={40} className="art" />}
                    <div>
                      <h3>{ev.name} <span className="muted">· {ev.outcomes.join(' or ')}</span></h3>
                      <p>{ev.rule ?? 'The reporter proposes the answer from the sources below.'}</p>
                      <dl>
                        {ev.deadline && <div><dt>Deadline</dt><dd>{ev.deadline}</dd></div>}
                        <div><dt>Sources</dt><dd>{ev.sources.join(', ')}</dd></div>
                        {m.opened && <div><dt>Opened</dt><dd>{m.opened}</dd></div>}
                      </dl>
                    </div>
                  </article>
                ))}
              </div>
            ) : lower === 'resolution' ? (
              <>
                <p className="tr__means">The reporter proposes a result with its evidence; for {clock(DISPUTE_MS)} the owner can dispute it and trading pauses, then anyone can finalize. Settling an event removes worlds, so a healthy loan can only get safer.</p>
                <ul className="sc__events">
                  {m.events.map((ev, e) => {
                    const settled = s.settled[e]
                    const p = s.proposals[e]
                    const left = p ? Math.min(DISPUTE_MS, p.at + DISPUTE_MS - now) : 0
                    return (
                      <li key={ev.name}>
                        <div><b>{ev.name}</b><small>Sources: {ev.sources[0]} and {ev.sources[1]}</small></div>
                        {settled !== null ? (
                          <span className="sc__chip is-on">Final: {ev.outcomes[settled]}</span>
                        ) : p ? (
                          <div className="sc__proposal">
                            <span>Proposed <b>{ev.outcomes[p.outcome]}</b> · {left > 0 ? <>dispute window <b className="num">{clock(left)}</b></> : 'window closed'}</span>
                            <button type="button" className="sc__chip" onClick={() => client.dispute(m.id, e)}>Dispute</button>
                            <button type="button" className="sc__chip is-on" onClick={() => client.finalize(m.id, e)}>{left > 0 ? 'Finalize now (demo)' : 'Finalize'}</button>
                          </div>
                        ) : (
                          <div className="sc__proposal">
                            <span className="sc__label">Reporter proposes (demo)</span>
                            {ev.outcomes.map((o, k) => <button key={o} type="button" className="sc__chip" onClick={() => client.propose(m.id, e, k)}>{o}</button>)}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
                <div className="mk__demo">
                  <button type="button" className={`sc__chip${s.shocked ? ' is-on' : ''}`} onClick={() => actions.shock(m.id, !s.shocked)} disabled={oneLeft}>Demo: NEAR falls to $2 where it’s cheapest</button>
                  {oneLeft && !s.claimed && <Button onClick={() => client.claimAll(m.id)}>Close and redeem</Button>}
                  <button type="button" className="sc__reset" onClick={reset}>Reset demo</button>
                </div>
                {s.claimed && (
                  <p className="sc__claimed">Closed and redeemed in one step: <b>{fmt(s.claimed.near)} NEAR</b> and <b>{fmt(s.claimed.usdc + s.claimed.lp)} USDC</b> from the world that became real went to your wallet.{s.claimed.repaid > 0 && <> The {usd(s.claimed.repaid)} loan was repaid from it first.</>}</p>
                )}
              </>
            ) : lower === 'activity' ? (
              mine.length === 0 ? <p className="obx__empty">Nothing yet. Fund, hedge, trade or borrow and it shows up here.</p> : (
                <ol className="feed">
                  {mine.map((h, i) => <li key={i} className={`feed__item feed__item--${h.kind}`}><time className="num">{new Date(h.at).toLocaleTimeString('en-GB', { hour12: false })}</time><span>{h.text}</span></li>)}
                </ol>
              )
            ) : lower === 'holders' ? (
              <Holders mid={m.id} orders={orders} spot={spot} you={funded ? liveWorlds.reduce((t, w) => t + worth(s, w) * odds[w], 0) : null} />
            ) : (
              <>
                <div className="sc__checks" aria-live="polite">
                  <span className={balanced ? '' : 'is-bad'}><i aria-hidden>{balanced ? '✓' : '✕'}</i>Every world balances: holders, other traders and pools add up to the reserves in all {checks.length} possible world{checks.length > 1 ? 's' : ''}</span>
                  <span><i aria-hidden>✓</i>Spot ${spot.toFixed(2)} = {liveWorlds.map((w) => `${pct(odds[w])} × $${s.price[w].toFixed(2)}`).join(' + ')}</span>
                </div>
                <div className="mk__tests">
                  <p className="tr__means">Plays 2,000 random runs of deposit, sell, borrow, settle and claim on this market and checks the rules after every step.</p>
                  <Button variant="ghost" onClick={() => setReport(runInvariantTests(m))}>{report ? 'Run again' : 'Run the tests'}</Button>
                </div>
                {report && (
                  <ul className="sc__tests">
                    {report.checks.map((c) => (
                      <li key={c.name} className={c.failures ? 'is-bad' : ''}><i aria-hidden>{c.failures ? '✕' : '✓'}</i>{c.name}<b className="num">{c.failures ? `${c.failures} failures` : 'pass'}</b></li>
                    ))}
                    <li className="sc__tests-foot">{fmt(report.sequences)} sequences, {fmt(report.steps)} steps</li>
                  </ul>
                )}
              </>
            )}
          </section>
        </div>

        <aside className="mk__side">
          {/* ---------- your position ---------- */}
          <section className="tr__panel mk__pos">
            <Gauge value={hf} label="Health" />
            <dl>
              <div><dt>Worst world</dt><dd>{worst < 0 || oneLeft || !funded ? '–' : m.worlds[worst].outcome}</dd></div>
              <div><dt>Counts for</dt><dd className="num">{worst < 0 || !funded ? '–' : usd(backing(s, worst))}</dd></div>
              <div><dt>Loan</dt><dd className="num">{usd(debtShown)}</dd></div>
              <div><dt>Can borrow</dt><dd className="num">{cap(Math.max(0, limit - s.debt))}</dd></div>
            </dl>
          </section>

          {/* ---------- the ticket ---------- */}
          <section className="tr__panel mk__ticket">
            <div className="pc__tabs" role="group" aria-label="Action">
              {TABS.map((t) => <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => { setTab(t.id); setAmount('') }}>{t.label}</button>)}
            </div>
            {account && !client.live && !isDemo && <p className="sc__note">Contracts aren't on testnet yet, so actions run on the demo model. Nothing is signed.</p>}

            {!account ? (
              <div className="tr__gate">
                <Button onClick={connect}>Connect NEAR wallet</Button>
                <button type="button" className="ticket__switch" onClick={connectDemo}>or explore with the demo wallet</button>
              </div>
            ) : tab === 'fund' ? (
              <>
                <p className="ticket__help">Deposit NEAR or USDC. It’s split into every world still possible, so you hold it in each one.</p>
                <div className="sc__seg" role="group" aria-label="Asset">
                  {(['near', 'usdc'] as const).map((x) => <button key={x} type="button" aria-pressed={asset === x} onClick={() => setAsset(x)}>{x.toUpperCase()}</button>)}
                </div>
                <label className="sc__select">
                  <span className="muted">From</span>
                  <select value={source} onChange={(e) => setSource(e.target.value)}>
                    {FROM.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </select>
                </label>
                <label className="tk__field"><span>Amount</span>
                  <input aria-label={`${asset.toUpperCase()} to deposit`} inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
                  <em>{asset.toUpperCase()}</em>
                </label>
                {source !== 'wallet' && <IntentsQuote source={source as SourceId} asset={asset} amount={a} />}
                <p className="tk__line"><span>In your wallet</span><b className="num">{fmt(wallet[asset])} {asset === 'near' ? 'wNEAR' : 'USDC'}</b></p>
                <Button onClick={() => { client.deposit(m.id, asset, a, source === 'wallet' ? 'from your NEAR wallet' : `from ${FROM.find((x) => x.id === source)!.label} (dry-run quote)`); setAmount('') }} disabled={!(a > 0) || oneLeft || (source === 'wallet' && a > wallet[asset] + 1e-9)}>
                  {source === 'wallet' && a > wallet[asset] + 1e-9 ? 'More than your wallet holds' : a > 0 ? `Deposit ${fmt(a)} ${asset.toUpperCase()} into ${count(s.possible)} worlds` : 'Deposit'}
                </Button>
              </>
            ) : tab === 'hedge' ? (
              <>
                <p className="ticket__help">Sell your NEAR for USDC of the same world, only in the worlds you picked in the list: <b>{shapeName(m, pick)}</b>. {pct(FEE, 2)} fee, up to 1.50% when trading is one-sided.</p>
                <table className="sc__preview">
                  <thead><tr><th>World</th><th className="r">Now</th><th className="r">After</th></tr></thead>
                  <tbody>
                    {liveWorlds.map((w) => (
                      <tr key={w} className={has(pick, w) && s.near[w] > 0 ? 'is-change' : ''}>
                        <td><i className="mk__dot" style={{ background: WORLD_COLORS[w % WORLD_COLORS.length] }} />{m.worlds[w].outcome}</td>
                        <td className="r num">{s.near[w] > 0 ? `${fmt(s.near[w])} NEAR` : `${fmt(s.usdc[w])} USDC`}</td>
                        <td className="r num">{preview.near[w] > 0 ? `${fmt(preview.near[w])} NEAR` : `${fmt(preview.usdc[w])} USDC`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="tk__line"><span>Worst-world limit</span><b className="num">{cap(limit)} → {cap(maxBorrow(preview))}</b></p>
                <div className="tk tk--sell">
                  <Button onClick={() => client.sellMask(m.id, pick, minOut)} disabled={!sellable}>
                    {sellable ? `Sell NEAR in ${count(pick)} world${count(pick) > 1 ? 's' : ''}` : s.near.some((x) => x > 0) ? 'Pick worlds that hold NEAR' : 'Fund with NEAR first'}
                  </Button>
                </div>
              </>
            ) : tab === 'borrow' ? (
              <>
                <p className="ticket__help">Borrow real USDC, owed the same in every world. Your worst world sets the limit at {pct(LLTV)}.</p>
                <label className="tk__field"><span>Amount</span>
                  <input aria-label="USDC to borrow" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
                  <em>USDC</em>
                </label>
                <div className="tk__pcts">
                  {[0.25, 0.5, 0.8, 1].map((k) => <button key={k} type="button" onClick={() => setAmount(String(Math.floor(Math.max(0, limit - s.debt) * k)))}>{k === 1 ? 'Max' : `${k * 100}%`}</button>)}
                </div>
                <p className="tk__line"><span>Health after</span><b className="num">{a > 0 ? health(s, s.debt + a)?.toFixed(2) : hf === null ? '–' : hf.toFixed(2)}</b></p>
                <div className="tk tk--buy">
                  <Button onClick={() => { client.borrow(m.id, a); setAmount('') }} disabled={!canBorrow(s, a) || oneLeft}>
                    {a > 0 && !canBorrow(s, a) ? 'Above your worst-world limit' : a > 0 ? `Borrow ${fmt(a)} USDC` : 'Borrow USDC'}
                  </Button>
                </div>
                {s.debt > 0 && <button type="button" className="ticket__switch" onClick={() => client.repay(m.id, s.debt)} disabled={wallet.usdc <= 0}>{wallet.usdc >= s.debt ? `Repay the whole loan (${usd(s.debt)})` : wallet.usdc > 0 ? `Repay ${usd(wallet.usdc)} from your wallet` : 'No USDC in your wallet to repay with'}</button>}
              </>
            ) : tab === 'pool' ? (
              <>
                <p className="ticket__help">One USDC deposit adds depth to every world’s pool and earns a share of each swap’s fee. When one world is left, your share comes back as plain USDC.</p>
                <div className="pool">
                  <div><span>You’ve added</span><b className="num">{usd(s.lp)}</b></div>
                  <div><span>Fees earned</span><b className="num up">{usd(s.lpFees)}</b></div>
                </div>
                <label className="tk__field"><span>Amount</span>
                  <input aria-label="USDC to add to every pool" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
                  <em>USDC</em>
                </label>
                <Button onClick={() => { client.addRootLiquidity(m.id, a); setAmount('') }} disabled={!(a > 0) || oneLeft || a > wallet.usdc + 1e-9}>
                  {a > wallet.usdc + 1e-9 ? `You have ${fmt(wallet.usdc)} USDC in your wallet` : a > 0 ? `Add ${fmt(a)} USDC to all ${count(s.possible)} worlds` : 'Add liquidity'}
                </Button>
              </>
            ) : (
              <>
                <p className="ticket__help">Lend real USDC and earn what borrowers pay. Every loan is covered in its worst world.</p>
                <div className="pool">
                  <div><span>Lenders earn</span><b className="num up">{pct(r.supply, 1)}</b></div>
                  <div><span>In use</span><b className="num">{pct(r.use)}</b></div>
                </div>
                <label className="tk__field"><span>Amount</span>
                  <input aria-label="USDC to lend" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
                  <em>USDC</em>
                </label>
                <Button onClick={() => { client.supply(a); setAmount('') }} disabled={!(a > 0) || a > wallet.usdc + 1e-9}>{a > wallet.usdc + 1e-9 ? `You have ${fmt(wallet.usdc)} USDC in your wallet` : a > 0 ? `Lend ${fmt(a)} USDC` : 'Lend USDC'}</Button>
              </>
            )}
          </section>

          {/* ---------- related markets ---------- */}
          {(related.length > 0 || others.length > 0) && (
            <section className="tr__panel mk__related" aria-label="Related markets">
              <h2 className="obx__boxtitle">{related.length > 0 ? 'Related markets' : 'More markets'}</h2>
              {[...related, ...others].map((x) => {
                const xs = sc[x.id], xo = liveOdds(x, xs)
                const lead = x.worlds.map((_, b) => b).filter((b) => has(xs.possible, b)).sort((p, q) => xo[q] - xo[p])[0]
                return (
                  <Link key={x.id} href={`/market/?id=${x.id}`} className="mk__rel">
                    <MarketArt m={x} size={36} />
                    <span><b>{x.question}</b><small>{related.includes(x) ? `Shares ${x.events.filter((e) => m.events.some((f) => f.name === e.name)).map((e) => e.name).join(', ')}` : x.category}</small></span>
                    <span className="mk__relp"><b className="num">{pct(xo[lead])}</b><small>{x.worlds[lead].outcome}</small></span>
                  </Link>
                )
              })}
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
