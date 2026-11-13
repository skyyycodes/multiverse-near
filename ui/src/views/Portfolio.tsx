// The portfolio, in the trading screen's style: what you hold in every world of every market, what that is worth
// at worst and on average, your loans, open orders and trades. On the right: your lowest health, your wallet and
// what you've lent.
import { useState } from 'react'
import Link from 'next/link'
import { CollateralBars } from '../components/CollateralBars'
import { AreaChart, Gauge, MarketArt, WorldIcon } from '../components/Grand'
import { series } from '../lib/history'
import { Button } from '../components/ui'
import { pct, short, usd } from '../lib/format'
import { YOU, actions, backing, bitsOf, health, holdsAnything, liveOdds, rates, useStore, worstWorld, worth } from '../lib/scenario'
import { useWallet } from '../lib/wallet'

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
const tone = (h: number | null) => (h === null || h >= 1.5 ? 'safe' : h >= 1.1 ? 'watch' : 'risk')
const time = (t: number) => new Date(t).toLocaleString('en-GB', { hour12: false, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
type Tab = 'positions' | 'orders' | 'trades' | 'activity'

export default function Portfolio() {
  const { account, connect, connectDemo } = useWallet()
  const { markets, sc, pool, wallet, orders, fills, history } = useStore()
  const [tab, setTab] = useState<Tab>('positions')

  // signed out: the page's own layout with dashes, and a connect panel where the positions go (as Aave and
  // Polymarket do), rather than an empty screen
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
        <div className="mk__grid">
          <div className="mk__main">
            <section className="tr__panel pf-gate">
              <div className="pf-gate__art" aria-hidden>
                {['NEAR', 'USDC', 'USDC', 'USDC'].map((t, i) => <span key={i} className={t === 'USDC' ? 'is-usdc' : ''}>{t}</span>)}
              </div>
              <h2 className="mk__title">Connect to see your worlds</h2>
              <p className="tr__means">Your positions in every world, their worst-world value, your loans and health, open orders, trades and a timestamped history of everything you do.</p>
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
                <li><b>Guaranteed value</b><span>every market counted in its worst world</span></li>
                <li><b>Each world’s holding</b><span>NEAR or USDC, and what it counts for</span></li>
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

  const mine = markets.filter((m) => holdsAnything(sc[m.id]))
  const debt = mine.reduce((t, m) => t + sc[m.id].debt, 0)
  const healths = mine.map((m) => health(sc[m.id])).filter((h): h is number => h !== null)
  const lowest = healths.length ? Math.min(...healths) : null
  // at worst: each market counted in its worst world; on average: weighted by each world's chance
  const atWorst = mine.reduce((t, m) => { const s = sc[m.id], w = worstWorld(s); return t + (w < 0 ? 0 : worth(s, w)) - s.debt }, 0) + pool.lent
  const onAverage = mine.reduce((t, m) => { const s = sc[m.id], o = liveOdds(m, s); return t + bitsOf(s.possible, m.worlds.length).reduce((x, b) => x + o[b] * worth(s, b), 0) - s.debt }, 0) + pool.lent
  const myOrders = orders.filter((o) => o.owner === YOU)
  const r = rates(pool)

  return (
    <div className="page tr desk">
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">Portfolio</h1>
          <p className="tr__means">{short(account)} · what you hold in each world, what you owe and what you’ve lent.</p>
        </div>
        <div className="tr__quote">
          <b className="num">{usd(atWorst)}</b>
          <span className="pc__note">guaranteed: every market in its worst world</span>
        </div>
        <dl className="tr__stats">
          <div><dt>On average</dt><dd className="num">{usd(onAverage)}</dd></div>
          <div><dt>Borrowed</dt><dd className="num">{usd(debt)}</dd></div>
          <div><dt>Lent</dt><dd className="num">{usd(pool.lent)}</dd></div>
          <div><dt>Markets</dt><dd className="num">{mine.length}</dd></div>
        </dl>
      </header>

      <div className="mk__grid">
        <div className="mk__main">
          {mine.length > 0 && (
            <section className="tr__panel">
              <div className="desk__head"><h2 className="obx__boxtitle">Value on average</h2><span className="pc__note">Last 30 days · demo history</span></div>
              <AreaChart key={Math.round(onAverage)} data={series(`pf:${account}`, onAverage, 30, 0.02)} color="#e9b8bb" format={(v) => `$${Math.round(v).toLocaleString('en-US')}`} height={170} />
            </section>
          )}

          <div className="pc__tabs desk__filter" role="group" aria-label="Show">
            <button type="button" aria-pressed={tab === 'positions'} onClick={() => setTab('positions')}>Positions ({mine.length})</button>
            <button type="button" aria-pressed={tab === 'orders'} onClick={() => setTab('orders')}>Open orders ({myOrders.length})</button>
            <button type="button" aria-pressed={tab === 'trades'} onClick={() => setTab('trades')}>Trade history ({fills.length})</button>
            <button type="button" aria-pressed={tab === 'activity'} onClick={() => setTab('activity')}>Activity ({history.length})</button>
          </div>

          {tab === 'activity' ? (
            <section className="tr__panel">
              {history.length === 0 ? <p className="obx__empty">Nothing yet. Everything you do (deposits, sales, loans, trades, resolutions) shows up here with its time.</p> : (
                <ol className="feed">
                  {history.map((h, i) => {
                    const m = h.scenario ? markets.find((x) => x.id === h.scenario) : null
                    return (
                      <li key={i} className={`feed__item feed__item--${h.kind}`}>
                        <time className="num">{time(h.at)}</time>
                        <span>{h.text}{m && <> <Link href={`/markets/${m.id}`} className="tr__link">{m.question}</Link></>}</span>
                      </li>
                    )
                  })}
                </ol>
              )}
            </section>
          ) : tab === 'positions' ? (
            mine.length === 0 ? (
              <section className="tr__panel desk__empty">
                <p><b>No positions yet.</b> Fund a market with NEAR or USDC to hold it in every world.</p>
                <Link href="/markets" className="mk__btn mk__btn--buy">Browse markets</Link>
              </section>
            ) : mine.map((m) => {
              const s = sc[m.id], w = worstWorld(s), hf = health(s)
              const live = bitsOf(s.possible, m.worlds.length)
              const settled = live.length === 1
              return (
                <section key={m.id} className="tr__panel pf">
                  <div className="rs__head">
                    <MarketArt m={m} size={44} />
                    <div>
                      <Link href={`/markets/${m.id}`} className="rs__q">{m.question}</Link>
                      <p className="pc__note">{settled ? `Settled: ${m.worlds[live[0]].outcome}` : `${live.length} of ${m.worlds.length} worlds possible · resolves ${m.resolves}`}</p>
                    </div>
                    <dl className="pf__nums">
                      <div><dt>Loan</dt><dd className="num">{usd(s.debt)}</dd></div>
                      <div><dt>Worst world</dt><dd>{w < 0 || settled ? '–' : m.worlds[w].outcome}</dd></div>
                      <div><dt>Health</dt><dd className={`num tone--${tone(hf)}`}>{hf === null ? 'No loan' : hf.toFixed(2)}</dd></div>
                    </dl>
                  </div>
                  <div className="pf__worlds">
                    {m.worlds.map((x, b) => {
                      const dead = !s.possible || !live.includes(b)
                      return (
                        <span key={x.id} className={`pf__world${dead ? ' is-dead' : ''}${b === w && !settled ? ' is-worst' : ''}`}>
                          <WorldIcon m={m} w={b} size={26} possible={s.possible} />
                          <span><small>{x.outcome}</small><b className="num">{dead ? 'Closed' : s.near[b] > 0 ? `${fmt(s.near[b])} NEAR` : `${fmt(s.usdc[b])} USDC`}</b></span>
                          {!dead && <em className="num">{usd(backing(s, b))}</em>}
                        </span>
                      )
                    })}
                  </div>
                  <CollateralBars m={m} s={s} />
                  <div className="pf__acts">
                    <Link href={`/markets/${m.id}`} className="mk__btn mk__btn--buy">Hedge or borrow</Link>
                    <Link href={`/orders?m=${m.id}&w=${live[0] ?? 0}`} className="mk__btn mk__btn--buy">Trade a world</Link>
                    {hf !== null && hf < 1 && <span className="tone--risk">Below 1: anyone can liquidate</span>}
                  </div>
                </section>
              )
            })
          ) : tab === 'orders' ? (
            <section className="tr__panel">
              {myOrders.length === 0 ? <p className="obx__empty">No open orders. Post one from the order book.</p> : (
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
              )}
            </section>
          ) : (
            <section className="tr__panel">
              {fills.length === 0 ? <p className="obx__empty">No trades yet. Fill an order on the order book and it shows up here.</p> : (
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
              )}
            </section>
          )}
        </div>

        <aside className="mk__side">
          <section className="tr__panel mk__pos">
            <Gauge value={lowest} label="Lowest health" />
            <dl>
              <div><dt>Lowest health</dt><dd className={`num tone--${tone(lowest)}`}>{lowest === null ? 'No loans' : lowest.toFixed(2)}</dd></div>
              <div><dt>Loans</dt><dd className="num">{healths.length}</dd></div>
              <div><dt>Borrowed</dt><dd className="num">{usd(debt)}</dd></div>
              <div><dt>Rate</dt><dd className="num">{pct(r.borrow, 0)} a year</dd></div>
            </dl>
          </section>

          <section className="tr__panel mk__ticket">
            <h2 className="obx__boxtitle">Wallet</h2>
            <p className="tk__line"><span>wNEAR</span><b className="num">{fmt(wallet.near)}</b></p>
            <p className="tk__line"><span>USDC</span><b className="num">{fmt(wallet.usdc)}</b></p>
            <p className="pc__note">Outside the contract. Fund a market to hold it in every world.</p>
            <div className="tk tk--buy"><Button onClick={() => actions.faucet()}>Get test tokens</Button></div>
          </section>

          <section className="tr__panel mk__ticket">
            <h2 className="obx__boxtitle">Lending</h2>
            <p className="tk__line"><span>Supplied</span><b className="num">{usd(pool.lent)}</b></p>
            <p className="tk__line"><span>Earning</span><b className="num is-up">{pct(r.supply, 2)} a year</b></p>
            <Link href="/lend" className="mk__btn mk__btn--buy">Supply USDC</Link>
          </section>
        </aside>
      </div>
    </div>
  )
}
