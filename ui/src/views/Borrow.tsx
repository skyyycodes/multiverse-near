// Borrow, built from what lending apps usually show (Aave, Morpho, Compound, Instadapp), in the trading screen's
// style and adapted to worlds:
//   header            net worth and the account's lowest health, as on a lending dashboard
//   loan position     LTV against the liquidation LTV, a borrow-capacity meter, collateral, loan and health
//   liquidation price one per world: the NEAR price there at which health reaches 1; dollar worlds never move
//   collateral at risk worst-world value as NEAR falls, against the liquidation line, hedged vs. NEAR everywhere
//   borrow form       amount or a target LTV, then before → after for health, LTV and liquidation price
//   tabs              markets to borrow against, your loans, risk parameters, how liquidation works
import { useState } from 'react'
import Link from 'next/link'
import { Gauge, MarketArt, WorldIcon } from '../components/Grand'
import { Button } from '../components/ui'
import { pct, usd } from '../lib/format'
import { BORROW_RATE, LLTV, backing, bitsOf, canBorrow, health, holdsAnything, maxBorrow, rates, useStore, worstWorld, type Scenario } from '../lib/scenario'
import type { Market } from '../lib/types'
import { useClient, useWallet } from '../lib/wallet'

const BONUS = 0.05 // the liquidator's bonus on the testnet contract
const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
const cap = (n: number) => `$${Math.floor(n + 1e-9).toLocaleString('en-US')}`
const tone = (h: number | null) => (h === null || h >= 1.5 ? 'safe' : h >= 1.1 ? 'watch' : 'risk')
const hfText = (h: number | null) => (h === null ? '∞' : h.toFixed(2))
type Tab = 'markets' | 'loans' | 'risk' | 'liquidation'

// the NEAR price in one world at which a loan of `debt` reaches health 1 there; null when that world can't move it
function liqPrice(s: Scenario, w: number, debt: number) {
  if (debt <= 0) return { kind: 'none' as const }
  const need = debt / LLTV
  const n = s.near[w], u = s.usdc[w]
  if (n <= 0) return u >= need ? { kind: 'never' as const } : { kind: 'now' as const }
  const p = (need - u) / n
  if (p <= 0) return { kind: 'never' as const }
  if (p >= s.price[w]) return { kind: 'now' as const } // already at or under the line
  return { kind: 'at' as const, price: p, drop: 1 - p / s.price[w] }
}

// worst-world value as NEAR falls by `d` everywhere, holding what you hold, or the same value as NEAR in every world
function worstAt(s: Scenario, live: number[], d: number, unhedged: boolean) {
  return Math.min(...live.map((w) => {
    const n = unhedged ? s.near[w] + s.usdc[w] / s.price[w] : s.near[w]
    const u = unhedged ? 0 : s.usdc[w]
    return n * s.price[w] * (1 - d) + u
  }))
}

function RiskChart({ s, live, debt }: { s: Scenario; live: number[]; debt: number }) {
  const W = 1100, H = 260, L = 56, R = 12, T = 16, B = 30 // drawn near its on-screen size so the labels stay small
  const drops = Array.from({ length: 19 }, (_, i) => i * 0.05) // 0% to 90%
  const mine = drops.map((d) => worstAt(s, live, d, false))
  const plain = drops.map((d) => worstAt(s, live, d, true))
  const line = debt > 0 ? debt / LLTV : 0
  const top = Math.max(1, ...mine, ...plain, line) * 1.08
  const x = (d: number) => L + (d / 0.9) * (W - L - R)
  const y = (v: number) => T + (1 - v / top) * (H - T - B)
  const path = (vs: number[]) => vs.map((v, i) => `${i ? 'L' : 'M'}${x(drops[i]).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const cross = line > 0 ? drops.find((_, i) => mine[i] < line) : undefined
  return (
    <svg className="risk__chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Worst-world value as NEAR falls, hedged and unhedged, against the liquidation line">
      {[0, 0.25, 0.5, 0.75, 1].map((f) => <g key={f}><line x1={L} x2={W - R} y1={y(top * f)} y2={y(top * f)} stroke="rgba(255,255,255,0.05)" /><text x={L - 6} y={y(top * f) + 3} textAnchor="end" fontSize="10" fill="#8e96a8">{usd(top * f)}</text></g>)}
      {[0, 0.3, 0.6, 0.9].map((d) => <text key={d} x={x(d)} y={H - 10} textAnchor="middle" fontSize="10" fill="#8e96a8">{d === 0 ? 'now' : `−${d * 100}%`}</text>)}
      {line > 0 && <><line x1={L} x2={W - R} y1={y(line)} y2={y(line)} stroke="#cf6b78" strokeDasharray="5 4" /><text x={W - R} y={y(line) - 5} textAnchor="end" fontSize="10" fill="#cf6b78">liquidation line {usd(line)}</text></>}
      <path d={path(plain)} fill="none" stroke="rgba(233,227,216,0.45)" strokeWidth="2" strokeDasharray="3 3" />
      <path d={path(mine)} fill="none" stroke="#7dc9a5" strokeWidth="2.5" />
      {cross !== undefined && <circle cx={x(cross)} cy={y(line)} r="4" fill="#cf6b78" />}
    </svg>
  )
}

export default function Borrow() {
  const { account, connect, connectDemo } = useWallet()
  const client = useClient()
  const { markets, sc, wallet, pool } = useStore()
  const open = markets.filter((m) => bitsOf(sc[m.id].possible, m.worlds.length).length > 1)
  const [id, setId] = useState(open[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<'borrow' | 'repay'>('borrow')
  const [tab, setTab] = useState<Tab>('markets')
  const m = open.find((x) => x.id === id) ?? open[0]
  const s = sc[m.id]
  const live = bitsOf(s.possible, m.worlds.length)
  const a = Number(amount) || 0
  const worst = worstWorld(s)
  const worstVal = worst < 0 ? 0 : backing(s, worst)
  const hf = health(s)
  const limit = maxBorrow(s)
  const room = Math.max(0, limit - s.debt)
  const funded = holdsAnything(s)
  const after = mode === 'borrow' ? s.debt + a : Math.max(0, s.debt - a)
  const hfAfter = health(s, after)
  const ltv = worstVal > 0 ? s.debt / worstVal : 0
  const ltvAfter = worstVal > 0 ? after / worstVal : 0
  const r = rates(pool)
  const loans = markets.filter((x) => sc[x.id].debt > 0)
  const totalDebt = loans.reduce((t, x) => t + sc[x.id].debt, 0)
  const allHf = loans.map((x) => health(sc[x.id])).filter((h): h is number => h !== null)
  const lowest = allHf.length ? Math.min(...allHf) : null
  const netWorth = markets.reduce((t, x) => { const xs = sc[x.id], w = worstWorld(xs); return t + (holdsAnything(xs) && w >= 0 ? backing(xs, w) - xs.debt : 0) }, 0)
  const demo = markets.find((x) => x.id === 'ships-fed')
  // the world that would be liquidated first: the highest liquidation price relative to its current price
  const binding = (debt: number) => live.map((w) => ({ w, l: liqPrice(s, w, debt) })).filter((x) => x.l.kind === 'at').sort((p, q) => (p.l.kind === 'at' && q.l.kind === 'at' ? p.l.drop - q.l.drop : 0))[0]
  const bNow = binding(s.debt), bAfter = binding(after)
  const okBorrow = mode === 'borrow' ? canBorrow(s, a) : a > 0 && a <= Math.min(s.debt, wallet.usdc) + 1e-9
  const setLtv = (k: number) => setAmount(String(Math.max(0, Math.floor(worstVal * k - s.debt))))

  return (
    <div className="page tr desk">
      {/* ---------- dashboard header ---------- */}
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">Borrow</h1>
          <p className="tr__means">Borrow real USDC against what you hold in every world. A lender counts only your worst world, so the loan is covered whichever future happens.</p>
        </div>
        <dl className="tr__stats">
          <div><dt>Net worth (worst worlds)</dt><dd className="num">{usd(netWorth)}</dd></div>
          <div><dt>Borrowed</dt><dd className="num">{usd(totalDebt)}</dd></div>
          <div><dt>Borrow rate</dt><dd className="num">{pct(BORROW_RATE, 2)} fixed</dd></div>
          <div><dt>Lowest health</dt><dd className={`num tone--${tone(lowest)}`}>{hfText(lowest)}</dd></div>
        </dl>
      </header>

      <div className="desk__cards" role="group" aria-label="Market">
        {open.map((x) => {
          const xs = sc[x.id], xh = health(xs)
          return (
            <button key={x.id} type="button" aria-pressed={x.id === m.id} className="desk__card" onClick={() => { setId(x.id); setAmount('') }}>
              <MarketArt m={x} size={40} />
              <span className="desk__cardtext"><b>{x.question}</b><small>{xs.debt > 0 ? `Loan ${usd(xs.debt)} · health ${xh?.toFixed(2)}` : holdsAnything(xs) ? `Available ${cap(maxBorrow(xs))}` : 'No collateral yet'}</small></span>
            </button>
          )
        })}
      </div>

      <div className="mk__grid">
        <div className="mk__main">
          {/* ---------- loan position ---------- */}
          <section className="tr__panel">
            <div className="desk__head"><h2 className="obx__boxtitle">Your loan position</h2><Link href={`/markets/${m.id}`} className="tr__link">Open the market</Link></div>
            {!funded ? (
              <div className="desk__empty">
                <MarketArt m={m} size={56} />
                <p><b>Nothing posted in this market yet.</b> Fund it, then sell NEAR in the worlds you fear. What you hold becomes the collateral.</p>
                <Link className="mk__btn mk__btn--buy" href={`/markets/${m.id}`}>Go to the market</Link>
              </div>
            ) : (
              <>
                <div className="lp__nums">
                  <div><span>Collateral (worst world)</span><b className="num">{usd(worstVal)}</b><small>{m.worlds[worst].outcome}</small></div>
                  <div><span>Loan</span><b className="num">{usd(s.debt)}</b><small>{pct(BORROW_RATE)} a year</small></div>
                  <div><span>LTV / Liquidation LTV</span><b className="num">{pct(ltv, 1)} <em>/ {pct(LLTV)}</em></b><small>loan ÷ worst world</small></div>
                  <div><span>Health</span><b className={`num tone--${tone(hf)}`}>{hfText(hf)}</b><small>{hf === null ? 'no loan' : hf < 1 ? 'can be liquidated' : `${pct(1 - 1 / hf)} from liquidation`}</small></div>
                </div>
                <div className="meter" aria-label={`Borrow capacity used: ${pct(limit > 0 ? s.debt / limit : 0)}`}>
                  <div className="meter__bar">
                    <i style={{ width: pct(Math.min(1, limit > 0 ? s.debt / limit : 0), 1) }} className={`tone-bg--${tone(hf)}`} />
                    {a > 0 && mode === 'borrow' && <i className="meter__add" style={{ left: pct(Math.min(1, s.debt / Math.max(limit, 1)), 1), width: pct(Math.max(0, Math.min(1, after / Math.max(limit, 1)) - s.debt / Math.max(limit, 1)), 1) }} />}
                  </div>
                  <div className="meter__legend"><span>Borrow capacity used <b className="num">{pct(limit > 0 ? s.debt / limit : 0)}</b></span><span>{cap(s.debt)} of {cap(limit)}</span><span>Liquidation at 100%</span></div>
                </div>
              </>
            )}
          </section>

          {/* ---------- liquidation price per world ---------- */}
          {funded && (
            <section className="tr__panel">
              <div className="desk__head"><h2 className="obx__boxtitle">Liquidation price by world</h2><span className="pc__note">{s.debt > 0 || a > 0 ? `For a loan of ${usd(after)}` : 'Shows once you borrow'}</span></div>
              <p className="tr__means">The NEAR price inside each world at which health reaches 1. Worlds that hold dollars don’t move with NEAR, which is why hedging keeps a loan safe.</p>
              <div className="lq">
                <div className="lq__row lq__row--head"><span>World</span><span>You hold</span><span>NEAR now</span><span>Liquidated at</span><span>Room</span></div>
                {live.map((w) => {
                  const l = liqPrice(s, w, after)
                  return (
                    <div key={w} className={`lq__row${bAfter?.w === w ? ' is-binding' : ''}`}>
                      <span className="desk__mk"><WorldIcon m={m} w={w} size={22} />{m.worlds[w].outcome}</span>
                      <span className="num">{s.near[w] > 0 ? `${fmt(s.near[w])} NEAR` : `${fmt(s.usdc[w])} USDC`}</span>
                      <span className="num">${s.price[w].toFixed(2)}</span>
                      <span className="num">{l.kind === 'at' ? `$${l.price.toFixed(2)}` : l.kind === 'never' ? <span className="tone--safe">Never</span> : l.kind === 'now' ? <span className="tone--risk">Now</span> : '–'}</span>
                      <span>{l.kind === 'at' ? <span className="lq__room"><i style={{ width: pct(Math.max(0, Math.min(1, l.drop)), 0) }} className={l.drop < 0.15 ? 'is-risk' : l.drop < 0.35 ? 'is-watch' : ''} /><b className="num">−{pct(Math.max(0, l.drop))}</b></span> : l.kind === 'never' ? <small className="muted">holds dollars</small> : '–'}</span>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* ---------- collateral at risk ---------- */}
          {funded && (
            <section className="tr__panel">
              <div className="desk__head"><h2 className="obx__boxtitle">Collateral at risk</h2><span className="pc__note">If NEAR falls in every world</span></div>
              <RiskChart s={s} live={live} debt={after} />
              <div className="odds__legend"><span><i style={{ background: '#7dc9a5' }} />Your worst world, as you hold it</span><span><i style={{ background: 'rgba(233,227,216,0.45)' }} />Same value, NEAR in every world</span>{after > 0 && <span><i style={{ background: '#cf6b78' }} />Liquidation line</span>}</div>
            </section>
          )}

          {/* ---------- markets, loans, risk, liquidation ---------- */}
          <section className="tr__panel">
            <div className="pc__tabs mk__lowertabs" role="group" aria-label="More">
              {([['markets', 'Markets to borrow against'], ['loans', `Your loans (${loans.length})`], ['risk', 'Risk parameters'], ['liquidation', 'Liquidations']] as const).map(([k, label]) => (
                <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>
              ))}
            </div>
            {tab === 'markets' ? (
              <div className="desk__table">
                <div className="desk__tr desk__tr--head bw__tr"><span>Market</span><span>Your worst world</span><span>Available</span><span>Max LTV</span><span>Rate</span><span /></div>
                {open.map((x: Market) => {
                  const xs = sc[x.id], xw = worstWorld(xs), has = holdsAnything(xs)
                  return (
                    <div key={x.id} className="desk__tr bw__tr">
                      <span className="desk__mk"><MarketArt m={x} size={28} />{x.question}</span>
                      <span className="num">{has && xw >= 0 ? usd(backing(xs, xw)) : '–'}</span>
                      <span className="num">{has ? cap(Math.max(0, maxBorrow(xs) - xs.debt)) : '–'}</span>
                      <span className="num">{pct(LLTV)}</span>
                      <span className="num">{pct(BORROW_RATE)}</span>
                      <span><button type="button" className="mk__btn mk__btn--buy" onClick={() => { setId(x.id); setMode('borrow'); setAmount('') ; window.scrollTo({ top: 0, behavior: 'smooth' }) }}>{has ? 'Borrow' : 'Details'}</button></span>
                    </div>
                  )
                })}
              </div>
            ) : tab === 'loans' ? (
              loans.length === 0 ? <p className="obx__empty">No loans yet.</p> : (
                <div className="desk__table">
                  <div className="desk__tr desk__tr--head bw__tr"><span>Market</span><span>Loan</span><span>Worst world</span><span>LTV</span><span>Health</span><span /></div>
                  {loans.map((x) => {
                    const t = sc[x.id], w = worstWorld(t), h = health(t), v = w < 0 ? 0 : backing(t, w)
                    return (
                      <div key={x.id} className="desk__tr bw__tr">
                        <span className="desk__mk"><MarketArt m={x} size={28} />{x.question}</span>
                        <span className="num">{usd(t.debt)}</span>
                        <span>{w < 0 ? '–' : x.worlds[w].outcome}</span>
                        <span className="num">{v > 0 ? pct(t.debt / v, 1) : '–'}</span>
                        <span className={`num tone--${tone(h)}`}>{hfText(h)}</span>
                        <span><button type="button" className="mk__btn mk__btn--sell" onClick={() => { setId(x.id); setMode('repay'); setAmount(''); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Repay</button></span>
                      </div>
                    )
                  })}
                </div>
              )
            ) : tab === 'risk' ? (
              <dl className="params">
                <div><dt>Max LTV and liquidation LTV</dt><dd>{pct(LLTV)} of the worst world. Borrowing stops there, and below health 1 anyone can liquidate.</dd></div>
                <div><dt>Price source</dt><dd>Each world’s own NEAR/USDC pool, read as a 30-minute average, so one trade can’t fake it.</dd></div>
                <div><dt>Liquidation bonus</dt><dd>{pct(BONUS)}, paid from the borrower’s collateral to the liquidator.</dd></div>
                <div><dt>Close factor</dt><dd>Up to half the loan per liquidation.</dd></div>
                <div><dt>Interest</dt><dd>{pct(BORROW_RATE)} a year, fixed, all paid to lenders. Lenders now earn {pct(r.supply, 2)}.</dd></div>
                <div><dt>Pauses</dt><dd>Liquidation pauses while a result is in its dispute window, or when a world’s pool is too thin to price.</dd></div>
                <div><dt>Not covered yet</dt><dd>A crash faster than liquidators can act. There is no insurance fund; that loss would fall on lenders.</dd></div>
              </dl>
            ) : (
              <>
                <ol className="steps">
                  <li><span className="steps__n">1</span><b>Health falls below 1</b><p>Your worst world × {pct(LLTV)} is now less than the loan.</p></li>
                  <li><span className="steps__n">2</span><b>Anyone repays half</b><p>A liquidator repays up to half the loan and takes that much collateral plus {pct(BONUS)}.</p></li>
                  <li><span className="steps__n">3</span><b>Loan shrinks</b><p>Health is usually back above 1. If prices keep falling, it can happen again.</p></li>
                </ol>
                {demo && (
                  <div className="bw__pair">
                    <article className="bw bw--safe"><p className="bw__name">Alice, hedged</p><p className="bw__kind">NEAR only in Ships & cuts, dollars in the other three. Borrowed 3,000 USDC against a 4,881 USDC worst world.</p><p className="lp__big tone--safe">Health 1.22, unchanged after the drop</p></article>
                    <article className="bw bw--hit"><p className="bw__name">Carl, unhedged</p><p className="bw__kind">NEAR in every world. When NEAR was pushed down in the worst world, his health fell with it.</p><p className="lp__big tone--risk">Health 0.86, liquidated by Leo</p></article>
                  </div>
                )}
              </>
            )}
          </section>
        </div>

        {/* ---------- the form ---------- */}
        <aside className="mk__side">
          <section className="tr__panel mk__pos">
            <Gauge value={hfAfter} label="Health after this" />
            <dl>
              <div><dt>Available</dt><dd className="num">{cap(room)}</dd></div>
              <div><dt>Loan</dt><dd className="num">{usd(s.debt)}</dd></div>
              <div><dt>LTV</dt><dd className="num">{pct(ltv, 1)}</dd></div>
              <div><dt>Max LTV</dt><dd className="num">{pct(LLTV)}</dd></div>
            </dl>
          </section>

          <section className="tr__panel mk__ticket">
            <div className="pc__tabs" role="group" aria-label="Borrow or repay">
              <button type="button" aria-pressed={mode === 'borrow'} onClick={() => { setMode('borrow'); setAmount('') }}>Borrow</button>
              <button type="button" aria-pressed={mode === 'repay'} onClick={() => { setMode('repay'); setAmount('') }} disabled={s.debt <= 0}>Repay</button>
            </div>
            {!account ? (
              <div className="tr__gate">
                <Button onClick={connect}>Connect NEAR wallet</Button>
                <button type="button" className="ticket__switch" onClick={connectDemo}>or explore with the demo wallet</button>
              </div>
            ) : (
              <>
                <label className="tk__field"><span>Amount</span>
                  <input aria-label={mode === 'borrow' ? 'USDC to borrow' : 'USDC to repay'} inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
                  <em>USDC</em>
                </label>
                {mode === 'borrow' ? (
                  <div className="ltv">
                    <div className="ltv__top"><span>Target LTV</span><b className="num">{pct(ltvAfter, 1)}</b></div>
                    <input type="range" min={Math.round(ltv * 1000)} max={Math.round(LLTV * 1000)} step={5} value={Math.round(Math.min(LLTV, Math.max(ltv, ltvAfter)) * 1000)} onChange={(e) => setLtv(Number(e.target.value) / 1000)} disabled={!funded} aria-label="Target loan to value" />
                    <div className="ltv__marks"><span>Safe</span><span>Moderate</span><span>Max {pct(LLTV)}</span></div>
                  </div>
                ) : (
                  <div className="tk__pcts">
                    {[0.25, 0.5, 0.75, 1].map((k) => <button key={k} type="button" onClick={() => setAmount(String(Math.floor(Math.min(s.debt, wallet.usdc) * k * 100) / 100))}>{k === 1 ? 'Max' : `${k * 100}%`}</button>)}
                  </div>
                )}

                <div className="ov">
                  <p className="ov__title">Transaction overview</p>
                  <p className="tk__line"><span>Health factor</span><b className="num"><span className={`tone--${tone(hf)}`}>{hfText(hf)}</span> → <span className={`tone--${tone(hfAfter)}`}>{hfText(hfAfter)}</span></b></p>
                  <p className="tk__line"><span>LTV</span><b className="num">{pct(ltv, 1)} → {pct(ltvAfter, 1)}</b></p>
                  <p className="tk__line"><span>First liquidation</span><b className="num">{bAfter && bAfter.l.kind === 'at' ? `${m.worlds[bAfter.w].outcome} at $${bAfter.l.price.toFixed(2)}` : after > 0 ? 'No NEAR world at risk' : '–'}</b></p>
                  {bNow && bNow.l.kind === 'at' && bAfter && bAfter.l.kind === 'at' && <p className="tk__line"><span>Liquidation price</span><b className="num">${bNow.l.price.toFixed(2)} → ${bAfter.l.price.toFixed(2)}</b></p>}
                  <p className="tk__line"><span>Interest</span><b className="num">{usd(after * BORROW_RATE)} a year</b></p>
                  {mode === 'repay' && <p className="tk__line"><span>In your wallet</span><b className="num">{fmt(wallet.usdc)} USDC</b></p>}
                </div>
                {mode === 'borrow' && a > 0 && hfAfter !== null && hfAfter < 1.5 && hfAfter >= 1 && (
                  <p className="ov__warn">Borrowing this much brings health to {hfAfter.toFixed(2)}. A {pct(1 - 1 / hfAfter)} fall in your worst world would let anyone liquidate it.</p>
                )}

                <div className={`tk ${mode === 'borrow' ? 'tk--buy' : 'tk--sell'}`}>
                  {mode === 'borrow' ? (
                    <Button onClick={() => { client.borrow(m.id, a); setAmount('') }} disabled={!okBorrow}>
                      {!funded ? 'Post collateral first' : a > 0 && !canBorrow(s, a) ? 'Above your worst-world limit' : a > 0 ? `Borrow ${fmt(a)} USDC` : 'Enter an amount'}
                    </Button>
                  ) : (
                    <Button onClick={() => { client.repay(m.id, a); setAmount('') }} disabled={!okBorrow}>
                      {a > wallet.usdc + 1e-9 ? 'More than your wallet holds' : a > 0 ? `Repay ${fmt(a)} USDC` : 'Enter an amount'}
                    </Button>
                  )}
                </div>
              </>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
