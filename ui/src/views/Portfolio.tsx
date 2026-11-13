// The portfolio, built from what the big apps show (Polymarket: positions value, a P&L chart with ranges, a
// positions table with cost, value and P&L; DeBank: an allocation breakdown; Hyperliquid: health beside the
// account) plus the one view only a multiverse app can give: what the whole portfolio is worth in each future.
//   header        average value with P&L, guaranteed value (every market in its worst world), cost, debt, lent
//   value chart   1D / 1W / 1M / ALL, with the P&L over the range
//   every future  per market: what you end with if each world happens, and the P&L against your cost there
//   tabs          positions (cost, value, P&L, worst world, health), open orders, trade history, activity
//   side          allocation donut, health, wallet, lending
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AreaChart, Gauge, MarketArt, WORLD_COLORS, WorldIcon } from '../components/Grand'
import { series } from '../lib/history'
import { Button } from '../components/ui'
import { pct, short, usd } from '../lib/format'
import { YOU, actions, backing, bitsOf, health, holdsAnything, liveOdds, rates, spotPrice, useStore, worstWorld, worth, type Scenario } from '../lib/scenario'
import type { Market } from '../lib/types'
import { useClient, useWallet } from '../lib/wallet'

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
// no sign on amounts that round to zero, so "−$0" never shows
const signed = (n: number) => (Math.round(Math.abs(n)) === 0 ? '$0' : `${n >= 0 ? '+' : '−'}$${fmt(Math.abs(n))}`)
const signedPct = (n: number) => (Math.abs(n) < 0.00005 ? '0.00%' : `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(2)}%`)
const tone = (h: number | null) => (h === null || h >= 1.5 ? 'safe' : h >= 1.1 ? 'watch' : 'risk')
// green for gains, red for losses, plain for amounts that round to zero
const pnlClass = (n: number) => (Math.round(Math.abs(n)) === 0 ? 'is-flat' : n > 0 ? 'is-up' : 'is-down')
// a seeded walk that starts at `from` and ends exactly at `to`, so the chart agrees with the real P&L
function bridge(data: { time: number; value: number }[], from: number, to: number) {
  const n = data.length - 1
  if (n < 1) return data
  const a = data[0].value, b = data[n].value
  return data.map((d, i) => ({ time: d.time, value: d.value + (from - a) * (1 - i / n) + (to - b) * (i / n) }))
}
// what a position holds, in words: "1,000 NEAR in 4 worlds" or "NEAR in 1 world · USDC in 3"
function holdingText(near: number[], usdc: number[], live: number[]) {
  const n = live.filter((b) => near[b] > 0), u = live.filter((b) => near[b] <= 0 && usdc[b] > 0)
  const same = n.length === live.length && n.every((b) => Math.abs(near[b] - near[n[0]]) < 0.5)
  if (same) return `${fmt(near[n[0]])} NEAR in ${n.length} world${n.length === 1 ? '' : 's'}`
  return [n.length && `NEAR in ${n.length} world${n.length === 1 ? '' : 's'}`, u.length && `USDC in ${u.length}`].filter(Boolean).join(' · ')
}
const time = (t: number) => new Date(t).toLocaleString('en-GB', { hour12: false, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
type Tab = 'positions' | 'orders' | 'trades' | 'activity'
const RANGES = [{ id: '1D', pts: 24, step: 3600 }, { id: '1W', pts: 42, step: 4 * 3600 }, { id: '1M', pts: 30, step: 86_400 }, { id: 'ALL', pts: 60, step: 86_400 }] as const

// one market's value on average (odds-weighted), at worst, and net of its loan
const avgOf = (m: Market, s: Scenario) => { const o = liveOdds(m, s); return bitsOf(s.possible, m.worlds.length).reduce((t, b) => t + o[b] * worth(s, b), 0) }
const worstOf = (s: Scenario) => { const w = worstWorld(s); return w < 0 ? 0 : worth(s, w) }

// a donut of where the money is, DeBank-style
function Donut({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((t, p) => t + Math.max(0, p.value), 0) || 1
  const R = 52, C = 2 * Math.PI * R
  let at = 0
  return (
    <div className="donut">
      <svg viewBox="0 0 140 140" role="img" aria-label={`Allocation: ${parts.map((p) => `${p.label} ${pct(p.value / total)}`).join(', ')}`}>
        <circle cx="70" cy="70" r={R} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="16" />
        {parts.filter((p) => p.value > 0).map((p) => {
          const len = (p.value / total) * C
          const el = <circle key={p.label} cx="70" cy="70" r={R} fill="none" stroke={p.color} strokeWidth="16" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-at} transform="rotate(-90 70 70)" />
          at += len
          return el
        })}
        <text x="70" y="66" textAnchor="middle" fontSize="11" fill="#8e96a8">assets</text>
        <text x="70" y="84" textAnchor="middle" fontSize="15" fontWeight="600" fill="#f2f2ee" fontFamily="var(--font-mono)">{usd(total)}</text>
      </svg>
      <ul>
        {parts.map((p) => <li key={p.label}><i style={{ background: p.color }} /><span>{p.label}</span><b className="num">{usd(p.value)}</b><small className="num">{pct(Math.max(0, p.value) / total)}</small></li>)}
      </ul>
    </div>
  )
}

// The outcome range: one axis from your worst world to your best, each world a dot at what you'd end with (size by
// chance, colour by world), your cost and your chance-weighted average marked. "What if NEAR moves" slides the worlds
// that hold NEAR along the axis; worlds that hold USDC stay put. That's the hedge, visible in one gesture.
const SHOCKS = [-0.5, -0.25, 0, 0.25, 0.5]
function Futures({ m, s }: { m: Market; s: Scenario }) {
  const [shock, setShock] = useState(0)
  const o = liveOdds(m, s)
  const live = bitsOf(s.possible, m.worlds.length)
  const at = (b: number, d: number) => s.near[b] * s.price[b] * (1 + d) + s.usdc[b] - s.debt
  const val = live.map((b) => at(b, shock))
  // a fixed axis across the whole −50%..+50% range, so dots move against a still background
  const span = live.flatMap((b) => [at(b, -0.5), at(b, 0.5)]).concat(s.cost)
  const lo = Math.max(0, Math.min(...span) * 0.94), hi = Math.max(...span) * 1.04
  const x = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`
  const avgV = live.reduce((t, b, i) => t + o[b] * val[i], 0)
  const worstV = Math.min(...val), bestV = Math.max(...val)
  const hedged = live.filter((b) => s.near[b] <= 0).length
  const order = [...live].sort((a, b) => at(a, shock) - at(b, shock))
  return (
    <section className="tr__panel fut">
      <div className="desk__head">
        <div className="fut__title"><MarketArt m={m} size={32} /><div><h2 className="obx__boxtitle">Your range of futures</h2><p className="pc__note">{m.question}</p></div></div>
        <Link href={`/markets/${m.id}`} className="tr__link">Change it</Link>
      </div>

      <div className="orng" role="img" aria-label={`If NEAR moves ${Math.round(shock * 100)}%: you end with between ${usd(worstV)} and ${usd(bestV)}, ${usd(avgV)} on average, against ${usd(s.cost)} put in`}>
        <div className="orng__band" style={{ left: x(worstV), width: `calc(${x(bestV)} - ${x(worstV)})` }} />
        <span className="orng__cost" style={{ left: x(s.cost) }} />
        <span className="orng__avg" style={{ left: x(avgV) }} />
        {order.map((b, k) => {
          const v = at(b, shock)
          const size = 12 + o[b] * 40
          return (
            <span key={b} className={`orng__dot${s.near[b] > 0 ? '' : ' is-usdc'}`} style={{ left: x(v), width: size, height: size, background: WORLD_COLORS[b % WORLD_COLORS.length] }}>
              <small className={k % 2 ? 'is-low' : ''}>{m.worlds[b].outcome}<b className="num">{usd(v)}</b></small>
            </span>
          )
        })}
        <div className="orng__axis num"><span>{usd(lo)}</span><span>{usd(hi)}</span></div>
      </div>
      <div className="orng__legend">
        <span><i className="orng__k orng__k--cost" />You put in <b className="num">{usd(s.cost)}</b></span>
        <span><i className="orng__k orng__k--avg" />Average, by chance <b className="num">{usd(avgV)}</b></span>
        <span><i className="orng__k orng__k--band" />From worst to best world</span>
        <span><i className="orng__k orng__k--usdc" />Ringed: holds USDC</span>
      </div>

      <div className="orng__ctl">
        <span>What if NEAR moves</span>
        <input type="range" min={-50} max={50} step={5} value={Math.round(shock * 100)} onChange={(e) => setShock(Number(e.target.value) / 100)} aria-label="NEAR price move in every world" />
        <div className="pc__tabs" role="group" aria-label="Presets">
          {SHOCKS.map((d) => <button key={d} type="button" aria-pressed={Math.abs(shock - d) < 0.001} onClick={() => setShock(d)}>{d === 0 ? 'Today' : `${d > 0 ? '+' : '−'}${Math.abs(d * 100)}%`}</button>)}
        </div>
      </div>

      <dl className="orng__sum">
        <div><dt>Guaranteed</dt><dd className="num">{usd(worstV)}</dd></div>
        <div><dt>Average</dt><dd className="num">{usd(avgV)}</dd></div>
        <div><dt>Best case</dt><dd className="num">{usd(bestV)}</dd></div>
        <div><dt>Hedged worlds</dt><dd className="num">{hedged} of {live.length}</dd></div>
      </dl>
      <p className="orng__note">{hedged === 0
        ? <>Every world holds NEAR, so every dot moves with it. <Link href={`/markets/${m.id}`} className="tr__link">Sell NEAR in the worlds you fear</Link> and those dots stop moving.</>
        : hedged === live.length ? 'Every world holds dollars: nothing here moves with NEAR.'
        : `${hedged === 1 ? 'The world' : `The ${hedged} worlds`} holding USDC ${hedged === 1 ? 'stays' : 'stay'} put; only ${live.length - hedged === 1 ? 'the one holding NEAR moves' : `the ${live.length - hedged} holding NEAR move`}.`}</p>

      <div className="fut__rows">
        {live.map((b, i) => {
          const v = val[i], p = v - s.cost + s.debt // P&L ignores the borrowed cash you already have
          return (
            <div key={b} className={`fut__row${v === bestV && live.length > 1 ? ' is-best' : ''}${v === worstV && live.length > 1 ? ' is-worst' : ''}`}>
              <span className="desk__mk"><WorldIcon m={m} w={b} size={24} /><span><b>If {m.worlds[b].outcome.toLowerCase()}</b><small>{pct(o[b])} chance</small></span></span>
              <span className="fut__hold num">{s.near[b] > 0 ? `${fmt(s.near[b])} NEAR at $${(s.price[b] * (1 + shock)).toFixed(2)}` : `${fmt(s.usdc[b])} USDC`}</span>
              <b className="num">{usd(v)}</b>
              <span className={`num ${pnlClass(p)}`}>{signed(p)}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export default function Portfolio() {
  const { account, connect, connectDemo } = useWallet()
  const client = useClient()
  const { markets, sc, pool, wallet, orders, fills, history } = useStore()
  const [tab, setTab] = useState<Tab>('positions')
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('1M')
  const [open, setOpen] = useState<string | null>(null)

  const mine = markets.filter((m) => holdsAnything(sc[m.id]))
  const nearPrice = mine.length ? spotPrice(mine[0], sc[mine[0].id]) : 3.22
  const walletValue = wallet.usdc + wallet.near * nearPrice
  const avg = mine.reduce((t, m) => t + avgOf(m, sc[m.id]) - sc[m.id].debt, 0) + pool.lent + walletValue
  const atWorst = mine.reduce((t, m) => t + worstOf(sc[m.id]) - sc[m.id].debt, 0) + pool.lent + walletValue
  const cost = mine.reduce((t, m) => t + sc[m.id].cost, 0)
  const positionsAvg = mine.reduce((t, m) => t + avgOf(m, sc[m.id]), 0)
  const pnl = positionsAvg - cost
  const debt = mine.reduce((t, m) => t + sc[m.id].debt, 0)
  const hfs = mine.map((m) => health(sc[m.id])).filter((h): h is number => h !== null)
  const lowest = hfs.length ? Math.min(...hfs) : null
  const myOrders = orders.filter((o) => o.owner === YOU)
  const r = rates(pool)
  const R = RANGES.find((x) => x.id === range)!
  const key = `${account}:${range}:${Math.round(avg)}`
  // the month and all-time views start at what you put in, so their P&L is the real one; shorter ranges start near today
  const start = range === '1M' || range === 'ALL' ? cost + (avg - positionsAvg) : avg * (1 + (range === '1D' ? 0.004 : -0.012))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const chart = useMemo(() => bridge(series(`pf:${account}:${range}`, avg, R.pts, range === '1D' ? 0.004 : 0.012, R.step), start, avg), [key])
  const best = mine.reduce((t, m) => { const s = sc[m.id]; return t + Math.max(...bitsOf(s.possible, m.worlds.length).map((b) => worth(s, b))) - s.debt }, 0) + pool.lent + walletValue
  const borrowable = mine.reduce((t, m) => t + Math.max(0, worstOf(sc[m.id]) * 0.75 - sc[m.id].debt), 0)
  const rangePnl = chart.length ? chart.at(-1)!.value - chart[0].value : 0
  // where the money is, on average
  const nearExposure = mine.reduce((t, m) => { const s = sc[m.id], o = liveOdds(m, s); return t + bitsOf(s.possible, m.worlds.length).reduce((x, b) => x + o[b] * s.near[b] * s.price[b], 0) }, 0)
  const hedgedUsdc = mine.reduce((t, m) => { const s = sc[m.id], o = liveOdds(m, s); return t + bitsOf(s.possible, m.worlds.length).reduce((x, b) => x + o[b] * s.usdc[b], 0) }, 0)

  // signed out: the page's own layout and a connect panel where the positions go (as Aave and Polymarket do)
  if (!account) {
    return (
      <div className="page tr desk">
        <header className="tr__pair">
          <div className="tr__id">
            <h1 className="mk__title">Portfolio</h1>
            <p className="tr__means">What you hold in each world, what you owe and what you’ve lent.</p>
          </div>
          <span className="pf-off">Not connected</span>
        </header>
        <div className="mk__grid pf-gated">
          <div className="mk__main">
            <section className="tr__panel pf-gate">
              <div className="pf-gate__art" aria-hidden>
                {['NEAR', 'USDC', 'USDC', 'USDC'].map((t, i) => <span key={i} className={t === 'USDC' ? 'is-usdc' : ''}>{t}</span>)}
              </div>
              <h2 className="mk__title">Connect to see your worlds</h2>
              <p className="tr__means">Your value in every future, your positions with their P&amp;L, your loans and health, open orders, trades and a timestamped history of everything you do.</p>
              <div className="pf-gate__acts">
                <div className="tk tk--buy"><Button onClick={connect}>Connect NEAR wallet</Button></div>
                <button type="button" className="mk__btn" onClick={connectDemo}>Explore with the demo wallet</button>
              </div>
              <p className="pc__note">The demo wallet starts with 1,000 NEAR in the SPICE × Fed market and signs nothing.</p>
            </section>
          </div>
          <aside className="mk__side">
            <section className="tr__panel pf-what">
              <h2 className="obx__boxtitle">What you’ll see here</h2>
              <ul>
                <li><b>Value and P&amp;L</b><span>on average and guaranteed, over time</span></li>
                <li><b>Every future</b><span>what you end with if each world happens</span></li>
                <li><b>Loans and health</b><span>with the world that would be liquidated first</span></li>
                <li><b>Orders, trades, activity</b><span>everything you do, with its time</span></li>
              </ul>
            </section>
            <section className="tr__panel pf-what">
              <h2 className="obx__boxtitle">New here?</h2>
              <p className="tr__means">The demo wallet holds 1,000 NEAR across the four worlds of SPICE × Fed. Hedge, borrow and trade without signing anything.</p>
              <Link href="/docs" className="tr__link">How it works</Link>
            </section>
          </aside>
        </div>
      </div>
    )
  }

  return (
    <div className="page tr desk">
      {/* ---------- header ---------- */}
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">Portfolio</h1>
          <p className="tr__means">{short(account)} · positions in {mine.length} market{mine.length === 1 ? '' : 's'}, {myOrders.length} open order{myOrders.length === 1 ? '' : 's'}</p>
        </div>
        <div className="tr__quote">
          <b className="num">{usd(avg)}</b>
          <span className={`num ${pnlClass(pnl)}`}>{signed(pnl)} ({cost > 0 ? signedPct(pnl / cost) : '0.00%'}) on your positions</span>
        </div>
        <dl className="tr__stats">
          <div><dt>Guaranteed</dt><dd className="num">{usd(atWorst)}</dd></div>
          <div><dt>Best case</dt><dd className="num">{usd(best)}</dd></div>
          <div><dt>Cost</dt><dd className="num">{usd(cost)}</dd></div>
          <div><dt>Borrowed</dt><dd className="num">{usd(debt)}</dd></div>
          <div><dt>Lent</dt><dd className="num">{usd(pool.lent)}</dd></div>
        </dl>
      </header>

      <div className="mk__grid pf-grid">
        <div className="mk__main">
          {/* ---------- the range of futures you hold, the page's centrepiece ---------- */}
          {mine.map((m) => <Futures key={m.id} m={m} s={sc[m.id]} />)}

          {/* ---------- value over time ---------- */}
          <section className="tr__panel">
            <div className="desk__head">
              <div>
                <h2 className="obx__boxtitle">Value on average</h2>
                <p className={`num pf__range ${pnlClass(rangePnl)}`}>{signed(rangePnl)} <small>over {range === 'ALL' ? 'all time' : range === '1D' ? 'the past day' : range === '1W' ? 'the past week' : 'the past month'}</small></p>
              </div>
              <div className="pc__intervals" role="group" aria-label="Range">
                {RANGES.map((x) => <button key={x.id} type="button" aria-pressed={range === x.id} onClick={() => setRange(x.id)}>{x.id}</button>)}
              </div>
            </div>
            <AreaChart key={key} data={chart} color={Math.round(rangePnl) === 0 ? '#e9b8bb' : rangePnl > 0 ? '#7dc9a5' : '#cf6b78'} format={(v) => `$${Math.round(v).toLocaleString('en-US')}`} height={190} />
            <p className="pc__note">Odds-weighted value of everything you hold, net of loans. Earlier points are demo history.</p>
          </section>

          {/* ---------- positions, orders, trades, activity ---------- */}
          <div className="pc__tabs desk__filter" role="group" aria-label="Show">
            <button type="button" aria-pressed={tab === 'positions'} onClick={() => setTab('positions')}>Positions ({mine.length})</button>
            <button type="button" aria-pressed={tab === 'orders'} onClick={() => setTab('orders')}>Open orders ({myOrders.length})</button>
            <button type="button" aria-pressed={tab === 'trades'} onClick={() => setTab('trades')}>Trade history ({fills.length})</button>
            <button type="button" aria-pressed={tab === 'activity'} onClick={() => setTab('activity')}>Activity ({history.length})</button>
          </div>

          <section className="tr__panel">
            {tab === 'positions' ? (
              mine.length === 0 ? (
                <div className="desk__empty"><p><b>No positions yet.</b> Fund a market with NEAR or USDC to hold it in every world.</p><Link href="/markets" className="mk__btn mk__btn--buy">Browse markets</Link></div>
              ) : (
                <div className="desk__table">
                  <div className="desk__tr desk__tr--head pos__tr"><span>Market</span><span>Holding by world</span><span>Cost</span><span>Value</span><span>P&amp;L</span><span>Health</span><span /></div>
                  {mine.map((m) => {
                    const s = sc[m.id], v = avgOf(m, s), p = v - s.cost, h = health(s), w = worstWorld(s)
                    const live = bitsOf(s.possible, m.worlds.length)
                    const settled = live.length === 1
                    return (
                      <div key={m.id} className="pos__wrap">
                        <div className="desk__tr pos__tr">
                          <span className="desk__mk"><MarketArt m={m} size={30} /><span><b>{m.question}</b><small>{settled ? 'Settled' : `worst: ${w < 0 ? '–' : m.worlds[w].outcome}`}</small></span></span>
                          <span className="pos__hold">
                            <span className="pos__cells" style={{ gridTemplateColumns: `repeat(${m.worlds.length > 2 ? 2 : m.worlds.length}, 1fr)` }} aria-hidden>
                              {m.worlds.map((_, b) => <i key={b} className={!live.includes(b) ? 'is-dead' : s.near[b] > 0 ? 'is-near' : 'is-usdc'} />)}
                            </span>
                            {holdingText(s.near, s.usdc, live)}
                          </span>
                          <span className="num">{usd(s.cost)}</span>
                          <span className="num">{usd(v)}</span>
                          <span className={`num ${pnlClass(p)}`}>{signed(p)}<small> {s.cost > 0 ? signedPct(p / s.cost) : ''}</small></span>
                          <span className={`num tone--${tone(h)}`}>{h === null ? 'No loan' : h.toFixed(2)}</span>
                          <span className="pos__acts">
                            {settled && !s.claimed
                              ? <button type="button" className="mk__btn mk__btn--buy" onClick={() => client.claimAll(m.id)}>Redeem</button>
                              : <Link href={`/markets/${m.id}`} className="mk__btn mk__btn--buy">Manage</Link>}
                            <button type="button" className={`mk__chev${open === m.id ? ' is-open' : ''}`} aria-expanded={open === m.id} aria-label="Details" onClick={() => setOpen(open === m.id ? null : m.id)}>▾</button>
                          </span>
                        </div>
                        {open === m.id && (
                          <div className="pos__detail">
                            {live.map((b) => (
                              <div key={b}><span className="desk__mk"><WorldIcon m={m} w={b} size={20} />{m.worlds[b].outcome}</span><b className="num">{s.near[b] > 0 ? `${fmt(s.near[b])} NEAR` : `${fmt(s.usdc[b])} USDC`}</b><small className="num">counts {usd(backing(s, b))}</small></div>
                            ))}
                            <div className="pos__links"><Link href={`/borrow`} className="tr__link">Borrow against it</Link><Link href={`/orders?m=${m.id}&w=${live[0] ?? 0}`} className="tr__link">Trade a world</Link></div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            ) : tab === 'orders' ? (
              myOrders.length === 0 ? <p className="obx__empty">No open orders. Post one from the order book.</p> : (
                <div className="desk__table">
                  <div className="desk__tr desk__tr--head pf__tr"><span>Market and world</span><span>Side</span><span>Price</span><span>Amount</span><span /></div>
                  {myOrders.map((o) => {
                    const m = markets.find((x) => x.id === o.scenario)!
                    return (
                      <div key={o.id} className="desk__tr pf__tr">
                        <span className="desk__mk"><WorldIcon m={m} w={o.world} size={22} />{m.worlds[o.world].outcome}<small className="muted"> · {m.question}</small></span>
                        <span className={o.side === 'bid' ? 'is-up' : 'is-down'}>{o.side === 'bid' ? 'Buy' : 'Sell'}</span>
                        <span className="num">${o.price.toFixed(2)}</span>
                        <span className="num">{fmt(o.amount)} NEAR</span>
                        <span><button type="button" className="mk__btn mk__btn--sell" onClick={() => actions.cancelOrder(o.id)}>Cancel</button></span>
                      </div>
                    )
                  })}
                </div>
              )
            ) : tab === 'trades' ? (
              fills.length === 0 ? <p className="obx__empty">No trades yet. Fill an order on the order book and it shows up here.</p> : (
                <div className="desk__table">
                  <div className="desk__tr desk__tr--head pf__tr"><span>Market and world</span><span>Side</span><span>Price</span><span>Amount</span><span>When</span></div>
                  {fills.map((f, i) => {
                    const m = markets.find((x) => x.id === f.scenario)!
                    return (
                      <div key={i} className="desk__tr pf__tr">
                        <span className="desk__mk"><WorldIcon m={m} w={f.world} size={22} />{m.worlds[f.world].outcome}<small className="muted"> · with {f.with}</small></span>
                        <span className={f.side === 'buy' ? 'is-up' : 'is-down'}>{f.side === 'buy' ? 'Bought' : 'Sold'}</span>
                        <span className="num">${f.price.toFixed(2)}</span>
                        <span className="num">{fmt(f.amount)} NEAR</span>
                        <span className="num">{time(f.at)}</span>
                      </div>
                    )
                  })}
                </div>
              )
            ) : history.length === 0 ? <p className="obx__empty">Nothing yet. Everything you do shows up here with its time.</p> : (
              <ol className="feed">
                {history.map((h, i) => {
                  const m = h.scenario ? markets.find((x) => x.id === h.scenario) : null
                  return <li key={i} className={`feed__item feed__item--${h.kind}`}><time className="num">{time(h.at)}</time><span>{h.text}{m && <> <Link href={`/markets/${m.id}`} className="tr__link">{m.question}</Link></>}</span></li>
                })}
              </ol>
            )}
          </section>
        </div>

        {/* ---------- side ---------- */}
        <aside className="mk__side">
          <section className="tr__panel">
            <h2 className="obx__boxtitle">Where your money is</h2>
            <Donut parts={[
              { label: 'NEAR exposure', value: nearExposure, color: '#e9b8bb' },
              { label: 'Hedged in USDC', value: hedgedUsdc, color: '#7dc9a5' },
              { label: 'Lent', value: pool.lent, color: '#6fb7e8' },
              { label: 'Wallet', value: walletValue, color: '#9b8cf0' },
            ]} />
            {debt > 0 && <p className="tk__line"><span>Owed</span><b className="num is-down">−{usd(debt)}</b></p>}
            <p className="pc__note">NEAR and hedged USDC are weighted by each world’s chance.</p>
          </section>

          {lowest === null ? (
            <section className="tr__panel pf-loan0">
              <h2 className="obx__boxtitle">Loans</h2>
              <p className="tr__means">No loans. Against your worst worlds you could borrow</p>
              <b className="num">{usd(borrowable)}</b>
              <p className="pc__note">real USDC at {pct(r.borrow, 0)} a year</p>
              <Link href="/borrow" className="mk__btn mk__btn--buy">Borrow</Link>
            </section>
          ) : (
            <section className="tr__panel mk__pos">
              <Gauge value={lowest} label="Lowest health" />
              <dl>
                <div><dt>Lowest health</dt><dd className={`num tone--${tone(lowest)}`}>{lowest.toFixed(2)}</dd></div>
                <div><dt>Loans</dt><dd className="num">{hfs.length}</dd></div>
                <div><dt>Borrowed</dt><dd className="num">{usd(debt)}</dd></div>
                <div><dt>Can still borrow</dt><dd className="num">{usd(borrowable)}</dd></div>
              </dl>
            </section>
          )}

          <section className="tr__panel mk__ticket">
            <h2 className="obx__boxtitle">Wallet</h2>
            <p className="tk__line"><span>wNEAR</span><b className="num">{fmt(wallet.near)}</b></p>
            <p className="tk__line"><span>USDC</span><b className="num">{fmt(wallet.usdc)}</b></p>
            <p className="tk__line"><span>Lent, earning {pct(r.supply, 2)}</span><b className="num">{usd(pool.lent)}</b></p>
            <div className="pf__walletacts">
              <div className="tk tk--buy"><Button onClick={() => actions.faucet()}>Get test tokens</Button></div>
              <Link href="/lend" className="mk__btn">Supply USDC</Link>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
