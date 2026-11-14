// The trading screen for one world, laid out like an exchange's spot page. NEAR/USDC trades inside a single world:
// a bid escrows USDC-if-world, an ask escrows NEAR-if-world, and both pay out only if that world happens.
//   pair bar      price, 24h change, high, low and volume of the world's pool; the market picker
//   order book    one box: buy orders on top, price and spread in the middle, sell orders below
//   chart         TradingView lightweight-charts candles with volume and moving averages, or the depth view
//   order form    limit or market, buy and sell side by side; a limit that crosses the book fills first, the rest rests
//   right column  every world you can trade, then the trades in this one
//   bottom tabs   your open orders, your trade history, and what you hold in each world of this market
// Trading pauses while a result is in dispute.
import { useEffect, useMemo, useState } from 'react'
import { PriceChart } from '../components/PriceChart'
import { Button } from '../components/ui'
import Link from 'next/link'
import { day, tape } from '../lib/history'
import { YOU, actions, bitsOf, bookOf, liveOdds, outcomeIn, useStore, type Order } from '../lib/scenario'
import { useWallet } from '../lib/wallet'

const fmt = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const num = (v: string) => v.replace(/[^0-9.]/g, '')
const time = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour12: false })
const DEPTHS = [5, 10, 15, 20]
const GROUPS = [0.01, 0.05, 0.1]
type View = 'both' | 'bids' | 'asks'

// one price level: every resting order in a price bucket
type Level = { price: number; amount: number; total: number; sum: number; orders: Order[]; mine: boolean }

// bids round down and asks round up, so a grouped level never shows a better price than the orders in it
function levels(orders: Order[], side: 'bid' | 'ask', step: number, depth: number): Level[] {
  const key = (p: number) => Math.round((side === 'bid' ? Math.floor(p / step + 1e-9) : Math.ceil(p / step - 1e-9)) * step * 100) / 100
  const out: Level[] = []
  for (const o of orders) {
    const price = key(o.price)
    let l = out.find((x) => x.price === price)
    if (!l) { l = { price, amount: 0, total: 0, sum: 0, orders: [], mine: false }; out.push(l) }
    l.amount += o.amount
    l.total += o.amount * o.price
    l.orders.push(o)
    l.mine ||= o.owner === YOU
  }
  out.sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price))
  let run = 0
  return out.slice(0, depth).map((l) => ({ ...l, sum: (run += l.total) }))
}

// one half of the book. Buys sit above the middle with the best bid lowest, right next to it; sells sit below with
// the best ask highest. The running sum and its depth bar grow away from the middle on both sides.
function Rows({ side, rows, max, onPick }: { side: 'bid' | 'ask'; rows: Level[]; max: number; onPick: (l: Level) => void }) {
  const shown = side === 'bid' ? [...rows].reverse() : rows
  return (
    <div className={`obx__side obx__side--${side}`} aria-label={side === 'bid' ? 'Buy orders' : 'Sell orders'}>
      {rows.length === 0 && <p className="obx__empty">No {side === 'bid' ? 'buy' : 'sell'} orders.</p>}
      {shown.map((l) => (
        <button
          key={l.price}
          type="button"
          className={`obx__row${l.mine ? ' is-mine' : ''}`}
          onClick={() => onPick(l)}
          title={l.orders.map((o) => `${o.owner === YOU ? 'You' : o.owner}: ${fmt(o.amount)} NEAR at $${o.price.toFixed(2)}`).join('\n')}
        >
          <i className="obx__bar" style={{ width: `${(l.sum / max) * 100}%` }} aria-hidden />
          <span className="obx__price num">{fmt(l.price)}</span>
          <span className="num">{fmt(l.amount)}</span>
          <span className="num">{fmt(l.sum)}</span>
        </button>
      ))}
    </div>
  )
}

// fill against the book: you buy from asks up to `limit` (or any price), or sell into bids down to it, best first
function sweep(book: Order[], side: 'buy' | 'sell', amount: number, limit: number | null) {
  let left = amount, cost = 0
  const fills: { o: Order; q: number }[] = []
  for (const o of book) {
    if (left <= 1e-9) break
    if (o.owner === YOU) continue
    if (limit !== null && (side === 'buy' ? o.price > limit + 1e-9 : o.price < limit - 1e-9)) break
    const q = Math.min(left, o.amount)
    fills.push({ o, q }); cost += q * o.price; left -= q
  }
  return { fills, filled: amount - left, cost, left }
}

function Ticket({ side, type, mid, w, near, usdc, asks, bids, halted, preset, connected, onConnect }: {
  side: 'buy' | 'sell'; type: 'limit' | 'market'; mid: string; w: number; near: number; usdc: number
  asks: Order[]; bids: Order[]; halted: boolean; preset: number | null; connected: boolean; onConnect: () => void
}) {
  const [price, setPrice] = useState('')
  const [amount, setAmount] = useState('')
  const [seen, setSeen] = useState(preset)
  if (preset !== seen) { setSeen(preset); if (preset !== null) setPrice(preset.toFixed(2)) } // a click on the book fills the price
  const p = type === 'limit' ? Number(price) || 0 : null
  const a = Number(amount) || 0
  const book = side === 'buy' ? asks : bids
  const run = sweep(book, side, a, p)
  const rest = type === 'limit' ? run.left : 0 // what would rest on the book as your own order
  const spend = side === 'buy' ? run.cost + rest * (p ?? 0) : a // USDC for a buy, NEAR for a sell
  const avbl = side === 'buy' ? usdc : near
  const total = run.cost + rest * (p ?? 0)
  const ok = a > 0 && (type === 'market' || (p ?? 0) > 0) && spend <= avbl + 1e-9 && !halted && (type === 'limit' || run.filled > 0)
  const best = book.find((o) => o.owner !== YOU)?.price

  const pctOf = (k: number) => {
    if (side === 'sell') return setAmount(String(Math.floor(near * k * 100) / 100))
    const px = p || best || 0
    if (px > 0) setAmount(String(Math.floor((usdc * k / px) * 100) / 100))
  }
  const submit = () => {
    run.fills.forEach((f) => actions.takeOrder(f.o.id, f.q))
    if (rest > 1e-9 && p) actions.postOrder(mid, w, side === 'buy' ? 'bid' : 'ask', p, rest)
    setAmount('')
  }

  return (
    <div className={`tk tk--${side}`}>
      {type === 'limit' ? (
        <label className="tk__field"><span>Price</span>
          <input inputMode="decimal" placeholder={best?.toFixed(2) ?? '0.00'} value={price} onChange={(e) => setPrice(num(e.target.value))} aria-label={`${side} price`} />
          <em>USDC</em>
        </label>
      ) : (
        <div className="tk__field tk__field--fixed"><span>Price</span><b>Best market price</b><em>USDC</em></div>
      )}
      <label className="tk__field"><span>Amount</span>
        <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(num(e.target.value))} aria-label={`${side} amount`} />
        <em>NEAR</em>
      </label>
      <div className="tk__pcts" role="group" aria-label="Share of available">
        {[0.25, 0.5, 0.75, 1].map((k) => <button key={k} type="button" onClick={() => pctOf(k)}>{k * 100}%</button>)}
      </div>
      <div className="tk__field tk__field--fixed"><span>Total</span><b className="num">{a > 0 ? fmt(total) : '–'}</b><em>USDC</em></div>
      {connected && <p className="tk__line"><span>Available in this world</span><b className="num">{fmt(avbl)} {side === 'buy' ? 'USDC' : 'NEAR'}</b></p>}
      {a > 0 && (
        <p className="tk__line tk__line--muted">
          {run.filled > 0 ? <>Fills {fmt(run.filled)} NEAR now at avg {fmt(run.cost / run.filled)}</> : type === 'market' ? 'No orders on that side to fill' : 'Nothing crosses the book'}
          {rest > 1e-9 && type === 'limit' && <>; {fmt(rest)} NEAR rests as your order</>}
          {type === 'market' && run.left > 1e-9 && run.filled > 0 && <>; only {fmt(run.filled)} NEAR on the book</>}
        </p>
      )}
      {!connected ? <Button onClick={onConnect}>Connect wallet to {side}</Button> : <Button onClick={submit} disabled={!ok}>
        {halted ? 'Paused during a dispute' : spend > avbl + 1e-9 ? `Not enough ${side === 'buy' ? 'USDC' : 'NEAR'} in this world` : `${side === 'buy' ? 'Buy' : 'Sell'} NEAR`}
      </Button>}
    </div>
  )
}

export default function Orders() {
  const { account, connect, connectDemo } = useWallet()
  const { markets, sc, orders, fills } = useStore()
  const tradable = markets.filter((m) => !m.settled)
  const [mid, setMid] = useState(tradable[0]?.id ?? '')
  const m = markets.find((x) => x.id === mid) ?? tradable[0]
  const s = sc[m.id]
  const live = bitsOf(s.possible, m.worlds.length)
  const [pickW, setPickW] = useState(live[0] ?? 0)
  const w = live.includes(pickW) ? pickW : live[0]
  const [depth, setDepth] = useState(15)
  const [group, setGroup] = useState(0.01)
  const [view, setView] = useState<View>('both')
  const [type, setType] = useState<'limit' | 'market'>('limit')
  const [preset, setPreset] = useState<{ side: 'buy' | 'sell'; price: number } | null>(null)
  const [bottom, setBottom] = useState<'open' | 'history' | 'holdings'>('open')
  const [rightTab, setRightTab] = useState<'market' | 'mine'>('market')
  const [query, setQuery] = useState('')
  // a link like /orders?m=ships-fed&w=3 (the Trade button on a market page) opens on that world
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const id = q.get('m'), b = Number(q.get('w'))
    if (id && markets.some((x) => x.id === id)) { setMid(id); if (Number.isInteger(b)) setPickW(b) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const book = useMemo(() => bookOf(orders, m.id, w), [orders, m.id, w])
  const bids = useMemo(() => levels(book.bids, 'bid', group, depth), [book.bids, group, depth])
  const asks = useMemo(() => levels(book.asks, 'ask', group, depth), [book.asks, group, depth])
  const max = Math.max(1, bids.at(-1)?.sum ?? 0, asks.at(-1)?.sum ?? 0)
  const halted = s.proposals.some(Boolean)
  const price = s.price[w]
  const bestBid = book.bids[0]?.price, bestAsk = book.asks[0]?.price
  const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : null
  const d = day(m.id, w, price)
  // the clock is read in the browser only, so the server's render and the browser's agree
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => { setNow(Date.now()) }, [])
  const trades = useMemo(() => (now === null ? [] : tape(m.id, w, price, now)), [m.id, w, price, now])
  const mineHere = fills.filter((f) => f.scenario === m.id && f.world === w)
  const myOrders = orders.filter((o) => o.owner === YOU && o.scenario === m.id)
  const myFills = fills.filter((f) => f.scenario === m.id)
  const choose = (id: string, b: number) => { setMid(id); setPickW(b); setPreset(null) }

  // every world of every open market, for the list on the right
  const q = query.trim().toLowerCase()
  const worldsList = tradable.flatMap((x) => bitsOf(sc[x.id].possible, x.worlds.length).map((b) => ({ x, b, p: sc[x.id].price[b], ch: day(x.id, b, sc[x.id].price[b]).pct })))
    .filter(({ x, b }) => !q || `${x.worlds[b].outcome} ${x.question}`.toLowerCase().includes(q))

  if (!w && w !== 0) return null
  return (
    <div className="page obx tr">
      {/* ---------- pair bar ---------- */}
      <header className="tr__pair">
        <div className="tr__id">
          <div className="tr__title">
            <h1>NEAR/USDC</h1>
            <span className="tr__world">{m.worlds[w].outcome}</span>
            <label className="tr__market">
              <span>Change market</span>
              <select value={m.id} onChange={(e) => choose(e.target.value, 0)} aria-label="Change market">
                {tradable.map((x) => <option key={x.id} value={x.id}>{x.question}</option>)}
              </select>
            </label>
          </div>
          <p className="tr__q">{m.question}</p>
          {/* what this world is, in plain words: the pieces traded here pay out only if all of it happens */}
          <p className="tr__means">
            Pays out only if {m.events.map((ev, e) => <span key={ev.name}>{e > 0 && ' and '}<b>{ev.name.toLowerCase()}: {ev.outcomes[outcomeIn(m, e, w)].toLowerCase()}</b></span>)}.
            {' '}{Math.round(liveOdds(m, s)[w] * 100)}% chance today.
          </p>
        </div>
        <div className="tr__quote">
          <b className="num">{fmt(price)}</b>
          <span className={`num ${d.change >= 0 ? 'is-up' : 'is-down'}`}>{d.change >= 0 ? '+' : ''}{fmt(d.change)} ({d.change >= 0 ? '+' : ''}{(d.pct * 100).toFixed(2)}%) 24h</span>
        </div>
        <dl className="tr__stats">
          <div><dt>24h high</dt><dd className="num">{fmt(d.high)}</dd></div>
          <div><dt>24h low</dt><dd className="num">{fmt(d.low)}</dd></div>
          <div><dt>24h volume</dt><dd className="num">{fmt(d.usdc, 0)} USDC</dd></div>
        </dl>
      </header>

      {halted && <p className="ob__halt">A result is in its dispute window, so this market’s trading is paused until it’s final or disputed.</p>}

      {/* ---------- every world you can trade, as a strip of chips ---------- */}
      <nav className="tr__strip" aria-label="Worlds">
        <input className="tr__find" type="search" placeholder="Find a world" aria-label="Find a world" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="tr__chips">
          {worldsList.map(({ x, b, p, ch }) => (
            <button key={`${x.id}-${b}`} type="button" aria-pressed={x.id === m.id && b === w} className="tr__chip" onClick={() => choose(x.id, b)} title={x.question}>
              <b>{x.worlds[b].outcome}</b>
              <span className="num">{fmt(p)} <em className={ch >= 0 ? 'is-up' : 'is-down'}>{ch >= 0 ? '+' : ''}{(ch * 100).toFixed(2)}%</em></span>
            </button>
          ))}
          {worldsList.length === 0 && <span className="tr__none">No world matches.</span>}
        </div>
      </nav>

      <div className="tr__grid">
        {/* ---------- order book ---------- */}
        <section className="obx__box tr__book" aria-label={`Order book for ${m.worlds[w].outcome}`}>
          <div className="obx__boxhead">
            <span className="obx__boxtitle">Order book</span>
            <div className="obx__view" role="group" aria-label="Show">
              {(['both', 'bids', 'asks'] as const).map((v) => <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{v === 'both' ? 'Both' : v === 'bids' ? 'Buy' : 'Sell'}</button>)}
            </div>
          </div>
          <div className="tr__bookctl">
            <label className="obx__ctl"><span>Depth</span>
              <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>{DEPTHS.map((x) => <option key={x} value={x}>{x}</option>)}</select>
            </label>
            <label className="obx__ctl"><span>Group</span>
              <select value={group} onChange={(e) => setGroup(Number(e.target.value))}>{GROUPS.map((g) => <option key={g} value={g}>{g.toFixed(2)}</option>)}</select>
            </label>
          </div>
          <div className="obx__row obx__row--head">
            <span>Price (USDC)</span><span>Amount (NEAR)</span><span>Sum (USDC)</span>
          </div>
          {view !== 'asks' && <Rows side="bid" rows={bids} max={max} onPick={(l) => setPreset({ side: 'sell', price: l.price })} />}
          <div className="obx__mid">
            <span className="obx__mid-main"><b className="num">{fmt(price)}</b><span className="obx__mid-label">pool</span></span>
            <span className="obx__mid-main obx__mid-spread"><b className="num">{spread === null ? '–' : fmt(spread)}</b><span className="obx__mid-label">{spread === null ? 'spread, one-sided' : `spread ${((spread / price) * 100).toFixed(2)}%`}</span></span>
          </div>
          {view !== 'bids' && <Rows side="ask" rows={asks} max={max} onPick={(l) => setPreset({ side: 'buy', price: l.price })} />}
          <p className="obx__hint">Click a level to put its price in the order form.</p>
        </section>

        {/* ---------- chart and order form ---------- */}
        <div className="tr__center">
          <PriceChart market={m.id} world={w} price={price} bids={book.bids} asks={book.asks} />

          <section className="tr__form" aria-label="Place an order">
            <div className="tr__formhead">
              <div className="pc__tabs" role="group" aria-label="Order type">
                {(['limit', 'market'] as const).map((x) => <button key={x} type="button" aria-pressed={type === x} onClick={() => setType(x)}>{x === 'limit' ? 'Limit' : 'Market'}</button>)}
              </div>
              <span className="pc__note">Trades NEAR-if-{m.worlds[w].outcome} for USDC-if-{m.worlds[w].outcome}</span>
            </div>
            {/* one balance only: what you hold inside this world, which is what the form trades */}
            {account ? (
              <p className="tr__bal">
                <span>You hold in <b>{m.worlds[w].outcome}</b></span>
                <b className="num">{fmt(s.near[w])} NEAR</b>
                <b className="num">{fmt(s.usdc[w])} USDC</b>
                <Link href={`/markets/${m.id}`}>Add funds</Link>
              </p>
            ) : (
              <p className="tr__bal tr__bal--gate">
                <span>Connect a wallet to trade.</span>
                <button type="button" className="tr__link" onClick={connect}>Connect NEAR wallet</button>
                <button type="button" className="tr__link" onClick={connectDemo}>Use the demo wallet</button>
              </p>
            )}
            <div className="tr__tickets">
              <Ticket key={`buy-${m.id}-${w}`} side="buy" type={type} mid={m.id} w={w} near={s.near[w]} usdc={s.usdc[w]} asks={book.asks} bids={book.bids} halted={halted} preset={preset?.side === 'buy' ? preset.price : null} connected={!!account} onConnect={connect} />
              <Ticket key={`sell-${m.id}-${w}`} side="sell" type={type} mid={m.id} w={w} near={s.near[w]} usdc={s.usdc[w]} asks={book.asks} bids={book.bids} halted={halted} preset={preset?.side === 'sell' ? preset.price : null} connected={!!account} onConnect={connect} />
            </div>
          </section>
        </div>

        {/* ---------- worlds and trades ---------- */}
        <aside className="tr__right">
          <section className="tr__panel tr__trades" aria-label="Trades">
            <div className="pc__tabs" role="group" aria-label="Trades">
              <button type="button" aria-pressed={rightTab === 'market'} onClick={() => setRightTab('market')}>Market trades</button>
              <button type="button" aria-pressed={rightTab === 'mine'} onClick={() => setRightTab('mine')}>My trades</button>
            </div>
            <div className="tr__list">
              <div className="tr__li tr__li--head tr__li--trade"><span>Price (USDC)</span><span>Amount (NEAR)</span><span>Time</span></div>
              {(rightTab === 'mine'
                ? mineHere.map((f) => ({ price: f.price, amount: f.amount, at: f.at, buy: f.side === 'buy' }))
                : [...mineHere.map((f) => ({ price: f.price, amount: f.amount, at: f.at, buy: f.side === 'buy' })), ...trades].sort((a, b) => b.at - a.at)
              ).slice(0, 24).map((t, i) => (
                <div key={i} className="tr__li tr__li--trade">
                  <span className={`num ${t.buy ? 'is-up' : 'is-down'}`}>{fmt(t.price)}</span>
                  <span className="num">{fmt(t.amount)}</span>
                  <span className="num">{time(t.at)}</span>
                </div>
              ))}
              {rightTab === 'mine' && mineHere.length === 0 && <p className="obx__empty">No trades of yours in this world yet.</p>}
            </div>
            {rightTab === 'market' && <p className="pc__note">Other traders’ trades are demo data.</p>}
          </section>
        </aside>
      </div>

      {/* ---------- your orders, trades and holdings ---------- */}
      <section className="tr__bottom" aria-label="Your activity">
        <div className="pc__tabs" role="group" aria-label="Your activity">
          <button type="button" aria-pressed={bottom === 'open'} onClick={() => setBottom('open')}>Open orders ({myOrders.length})</button>
          <button type="button" aria-pressed={bottom === 'history'} onClick={() => setBottom('history')}>Trade history ({myFills.length})</button>
          <button type="button" aria-pressed={bottom === 'holdings'} onClick={() => setBottom('holdings')}>Holdings</button>
        </div>
        {!account ? <p className="obx__empty">Connect a wallet to see your orders and holdings.</p> : bottom === 'open' ? (
          myOrders.length === 0 ? <p className="obx__empty">No open orders in this market.</p> : (
            <div className="pg-table">
              <div className="pg-table__row pg-table__row--head tr__row5"><span>World</span><span>Side</span><span>Price</span><span>Amount</span><span /></div>
              {myOrders.map((o) => (
                <div key={o.id} className="pg-table__row tr__row5">
                  <span>{m.worlds[o.world].outcome}</span>
                  <span className={o.side === 'bid' ? 'is-up' : 'is-down'}>{o.side === 'bid' ? 'Buy' : 'Sell'}</span>
                  <span className="num">{fmt(o.price)}</span>
                  <span className="num">{fmt(o.amount)} NEAR</span>
                  <span><button type="button" className="ob__act" onClick={() => actions.cancelOrder(o.id)}>Cancel</button></span>
                </div>
              ))}
            </div>
          )
        ) : bottom === 'history' ? (
          myFills.length === 0 ? <p className="obx__empty">No trades in this market yet.</p> : (
            <div className="pg-table">
              <div className="pg-table__row pg-table__row--head tr__row5"><span>Time</span><span>World</span><span>Side</span><span>Price</span><span>Amount</span></div>
              {myFills.map((f, i) => (
                <div key={i} className="pg-table__row tr__row5">
                  <span className="num">{time(f.at)}</span>
                  <span>{m.worlds[f.world].outcome}</span>
                  <span className={f.side === 'buy' ? 'is-up' : 'is-down'}>{f.side === 'buy' ? 'Buy' : 'Sell'} from {f.with}</span>
                  <span className="num">{fmt(f.price)}</span>
                  <span className="num">{fmt(f.amount)} NEAR</span>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="pg-table">
            <div className="pg-table__row pg-table__row--head"><span>World</span><span>NEAR</span><span>USDC</span><span>Worth here</span></div>
            {live.map((b) => (
              <button key={b} type="button" className={`pg-table__row tr__hold${b === w ? ' is-on' : ''}`} onClick={() => choose(m.id, b)}>
                <span>{m.worlds[b].outcome}</span>
                <span className="num">{fmt(s.near[b])}</span>
                <span className="num">{fmt(s.usdc[b])}</span>
                <span className="num">${fmt(s.near[b] * s.price[b] + s.usdc[b])}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
