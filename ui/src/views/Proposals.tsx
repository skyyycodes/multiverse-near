// Decision markets (futarchy), laid out as MetaDAO shows a proposal: each branch (pass, fail) is its own market for
// NEAR; their prices are averaged over time, and the proposal passes only if the pass average beats the fail
// average by a threshold. Header with both averages and the margin, a decision meter, both prices over time, a
// trade card per branch, what the proposal does and how it's decided, and earlier proposals. Demo only: the
// decision-market module isn't in the contract.
import { useEffect, useRef, useState } from 'react'
import { ColorType, LineSeries, createChart, type UTCTimestamp } from 'lightweight-charts'
import { Button } from '../components/ui'
import { BRANCHES, PAST, THRESHOLD, futarchy, leader, margin, price, quoteBuy, quoteSell, twap, useProposal, type Branch, type Proposal } from '../lib/futarchy'
import { useWallet } from '../lib/wallet'

const fmt = (n: number, d = 2) => n.toLocaleString('en-US', { maximumFractionDigits: d })
const pctS = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`
const clock = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
const COLOR: Record<Branch, string> = { pass: '#7dc9a5', fail: '#cf6b78' }
const LABEL: Record<Branch, string> = { pass: 'If it passes', fail: 'If it fails' }

// both branches' NEAR price over time
function BranchChart({ p }: { p: Proposal }) {
  const box = useRef<HTMLDivElement>(null)
  const key = `${p.obs.pass.length}:${p.obs.fail.length}`
  useEffect(() => {
    if (!box.current) return
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8e96a8', fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true },
      handleScroll: false, handleScale: false,
    })
    for (const b of BRANCHES) {
      const s = c.addSeries(LineSeries, { color: COLOR[b], lineWidth: 2, priceLineVisible: false, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } })
      // one point per second, the latest price in it
      const pts = new Map<number, number>()
      p.obs[b].forEach((o) => pts.set(Math.floor(o.at / 1000), o.price))
      s.setData([...pts.entries()].sort((x, y) => x[0] - y[0]).map(([t, v]) => ({ time: t as UTCTimestamp, value: v })))
    }
    c.timeScale().fitContent()
    return () => c.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return <div ref={box} className="dm__chart" />
}

// one branch: its price and average, what you hold in it, and a buy / sell form
function BranchCard({ b }: { b: Branch }) {
  const p = useProposal()
  const { account } = useWallet()
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('')
  const a = Number(amount) || 0
  const pool = p.pools[b], h = p.held[b]
  const out = side === 'buy' ? quoteBuy(pool, a) : quoteSell(pool, a)
  const max = side === 'buy' ? h.usdc : h.near
  const won = p.decided === b, lost = p.decided && p.decided !== b
  return (
    <section className={`tr__panel dm__branch dm__branch--${b}${won ? ' is-won' : ''}${lost ? ' is-lost' : ''}`}>
      <div className="desk__head">
        <h2 className="obx__boxtitle"><i style={{ background: COLOR[b] }} />{LABEL[b]}</h2>
        {won && <span className="rs__state rs__state--final">Became real</span>}
        {lost && <span className="rs__state rs__state--open">Undone</span>}
      </div>
      <div className="dm__px">
        <div><span>NEAR now</span><b className="num">${price(pool).toFixed(2)}</b></div>
        <div><span>Time-weighted average</span><b className="num">${twap(p, b).toFixed(3)}</b></div>
      </div>
      <p className="tk__line"><span>You hold here</span><b className="num">{fmt(h.near)} NEAR · {fmt(h.usdc)} USDC</b></p>
      {!p.decided && account && (
        <>
          <div className="pc__tabs" role="group" aria-label="Buy or sell">
            {(['buy', 'sell'] as const).map((x) => <button key={x} type="button" aria-pressed={side === x} onClick={() => { setSide(x); setAmount('') }}>{x === 'buy' ? 'Buy NEAR' : 'Sell NEAR'}</button>)}
          </div>
          <label className="tk__field"><span>Amount</span>
            <input aria-label={side === 'buy' ? `USDC to spend ${LABEL[b].toLowerCase()}` : `NEAR to sell ${LABEL[b].toLowerCase()}`} inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
            <em>{side === 'buy' ? 'USDC' : 'NEAR'}</em>
          </label>
          <div className="tk__pcts">{[0.25, 0.5, 0.75, 1].map((k) => <button key={k} type="button" onClick={() => setAmount(String(Math.floor(max * k * 100) / 100))}>{k === 1 ? 'Max' : `${k * 100}%`}</button>)}</div>
          <p className="tk__line"><span>You get</span><b className="num">{a > 0 ? `${fmt(out)} ${side === 'buy' ? 'NEAR' : 'USDC'}` : '–'}</b></p>
          <div className={`tk ${side === 'buy' ? 'tk--buy' : 'tk--sell'}`}>
            <Button onClick={() => { if (side === 'buy') futarchy.buy(b, a); else futarchy.sell(b, a); setAmount('') }} disabled={!(a > 0) || a > max + 1e-9}>
              {!(a > 0) ? (max > 0 ? 'Enter an amount' : side === 'buy' ? 'Split USDC first' : 'No NEAR here yet') : a > max + 1e-9 ? `You have ${fmt(max)} ${side === 'buy' ? 'USDC' : 'NEAR'} here` : side === 'buy' ? `Buy NEAR ${b === 'pass' ? 'if it passes' : 'if it fails'}` : `Sell NEAR ${b === 'pass' ? 'if it passes' : 'if it fails'}`}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

export default function Proposals() {
  const p = useProposal()
  const { account, connect, connectDemo } = useWallet()
  const [split, setSplit] = useState('')
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  // trading closes on its own when the clock runs out
  useEffect(() => { if (now && !p.decided && now >= p.closesAt) futarchy.decide() }, [now, p.decided, p.closesAt])
  const s = Number(split) || 0
  const m = margin(p)
  const lead = leader(p)
  // the meter runs from -10% to +10%
  const pos = (x: number) => `${Math.max(0, Math.min(100, ((x + 0.1) / 0.2) * 100))}%`

  return (
    <div className="page tr desk">
      <header className="tr__pair">
        <div className="tr__id">
          <p className="mk__crumb"><span className="mk__tag">Decision market</span><span className="mk__tag">Demo, not in the contract</span>Proposal #{p.id} · by {p.author}</p>
          <h1 className="mk__title">{p.question}</h1>
          <p className="tr__means">{p.detail}</p>
        </div>
        <dl className="tr__stats">
          <div><dt>Pass average</dt><dd className="num is-up">${twap(p, 'pass').toFixed(3)}</dd></div>
          <div><dt>Fail average</dt><dd className="num is-down">${twap(p, 'fail').toFixed(3)}</dd></div>
          <div><dt>Margin</dt><dd className={`num ${m >= THRESHOLD ? 'is-up' : 'is-down'}`}>{pctS(m)}</dd></div>
          <div><dt>{p.decided ? 'Result' : 'Closes in'}</dt><dd className="num">{p.decided ? (p.decided === 'pass' ? 'Passed' : 'Failed') : now ? clock(p.closesAt - now) : '–'}</dd></div>
        </dl>
      </header>

      <div className="mk__grid">
        <div className="mk__main">
          {/* ---------- where the decision stands ---------- */}
          <section className="tr__panel">
            <div className="desk__head">
              <h2 className="obx__boxtitle">{p.decided ? `Decided: it ${p.decided === 'pass' ? 'passed' : 'failed'}` : lead === 'pass' ? 'Passing right now' : 'Failing right now'}</h2>
              <span className="pc__note">Passes if the pass average is at least +{(THRESHOLD * 100).toFixed(0)}% above the fail average</span>
            </div>
            <div className="dm__meter" aria-label={`Margin ${pctS(m)}, threshold +${(THRESHOLD * 100).toFixed(0)}%`}>
              <div className="dm__track">
                <i className="dm__zone" style={{ left: pos(THRESHOLD), right: 0 }} />
                <span className="dm__thresh" style={{ left: pos(THRESHOLD) }}><small>+{(THRESHOLD * 100).toFixed(0)}% needed</small></span>
                <span className={`dm__mark ${m >= THRESHOLD ? 'is-pass' : 'is-fail'}`} style={{ left: pos(m) }}><b className="num">{pctS(m)}</b></span>
              </div>
              <div className="dm__scale num"><span>−10%</span><span>0</span><span>+10%</span></div>
            </div>
          </section>

          <section className="tr__panel">
            <div className="desk__head">
              <h2 className="obx__boxtitle">NEAR in each branch</h2>
              <div className="odds__legend">{BRANCHES.map((b) => <span key={b}><i style={{ background: COLOR[b] }} />{LABEL[b]} <b>${price(p.pools[b]).toFixed(2)}</b></span>)}</div>
            </div>
            <BranchChart p={p} />
            <p className="pc__note">Each trade records a new price; the decision uses the average of the last {48} observations, not the last trade. Earlier points are demo history.</p>
          </section>

          <div className="dm__branches">
            {BRANCHES.map((b) => <BranchCard key={b} b={b} />)}
          </div>

          <section className="tr__panel">
            <h2 className="obx__boxtitle">What it does if it passes</h2>
            <p className="tr__means dm__text">{p.ifPass}</p>
            <h2 className="obx__boxtitle dm__h">How it’s decided</h2>
            <ol className="steps">
              <li><span className="steps__n">1</span><b>Split</b><p>1 USDC becomes 1 USDC-if-pass and 1 USDC-if-fail. Holding both is the same as holding 1 USDC.</p></li>
              <li><span className="steps__n">2</span><b>Trade both futures</b><p>Buy or sell NEAR in each branch at the price you think it’ll have if the proposal passes, or fails.</p></li>
              <li><span className="steps__n">3</span><b>Average beats threshold</b><p>When trading closes, pass wins only if its average NEAR price is +{(THRESHOLD * 100).toFixed(0)}% above fail’s. The other branch’s trades are undone.</p></li>
            </ol>
          </section>
        </div>

        <aside className="mk__side">
          <section className="tr__panel mk__ticket">
            <h2 className="obx__boxtitle">Split USDC into both futures</h2>
            {!account ? (
              <div className="tr__gate">
                <Button onClick={connect}>Connect NEAR wallet</Button>
                <button type="button" className="ticket__switch" onClick={connectDemo}>or explore with the demo wallet</button>
              </div>
            ) : p.decided ? (
              <>
                <p className="ticket__help">It {p.decided === 'pass' ? 'passed' : 'failed'}. You now hold what you had where it {p.decided === 'pass' ? 'passed' : 'failed'}, plus anything you never split.</p>
                <p className="tk__line"><span>NEAR</span><b className="num">{fmt(p.held[p.decided].near)}</b></p>
                <p className="tk__line"><span>USDC</span><b className="num">{fmt(p.held[p.decided].usdc + p.wallet)}</b></p>
                <Button variant="ghost" onClick={futarchy.reset}>Start the demo over</Button>
              </>
            ) : (
              <>
                <p className="ticket__help">Each USDC becomes one to trade if it passes and one if it fails.</p>
                <label className="tk__field"><span>Amount</span>
                  <input aria-label="USDC to split" inputMode="decimal" placeholder="0" value={split} onChange={(e) => setSplit(e.target.value.replace(/[^0-9.]/g, ''))} />
                  <em>USDC</em>
                </label>
                <div className="tk__pcts">{[0.25, 0.5, 0.75, 1].map((k) => <button key={k} type="button" onClick={() => setSplit(String(Math.floor(p.wallet * k)))}>{k === 1 ? 'Max' : `${k * 100}%`}</button>)}</div>
                <p className="tk__line"><span>Available</span><b className="num">{fmt(p.wallet)} USDC</b></p>
                <div className="tk tk--buy"><Button onClick={() => { futarchy.split(s); setSplit('') }} disabled={!(s > 0) || s > p.wallet}>{s > 0 ? `Split ${fmt(s)} USDC` : 'Enter an amount'}</Button></div>
                <button type="button" className="mk__btn" onClick={futarchy.decide}>Close trading now (demo)</button>
              </>
            )}
          </section>

          <section className="tr__panel">
            <h2 className="obx__boxtitle">Earlier proposals</h2>
            <div className="dm__past">
              {PAST.map((x) => (
                <div key={x.id} className="dm__pastrow">
                  <span><b>#{x.id} {x.question}</b><small>Closed {x.closed} · ${fmt(x.volume / 1000, 0)}K traded</small></span>
                  <span className={`rs__state ${x.result === 'pass' ? 'rs__state--final' : 'rs__state--open'}`}>{x.result === 'pass' ? 'Passed' : 'Failed'} {pctS(x.margin)}</span>
                </div>
              ))}
            </div>
            <p className="pc__note">Demo history.</p>
          </section>

          {p.log.length > 0 && (
            <section className="tr__panel">
              <h2 className="obx__boxtitle">Activity</h2>
              <ol className="feed feed--compact">{p.log.map((l, i) => <li key={i} className="feed__item feed__item--trade"><time /><span>{l}</span></li>)}</ol>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
