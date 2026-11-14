'use client'
// The trading screen for one world, laid out like an exchange's spot page. NEAR/USDC trades inside a single world:
// what you hold there (NEAR-if-world and USDC-if-world) buys and sells against the world's resting orders and its pool,
// and both pay out only if that world happens. Everything on it reads the contract on testnet.
//   pair bar      the pool price, the best bid and ask, the pool's depth; the market picker
//   world strip   every world of every open market, at its pool price
//   order book    one box: buy orders on top, the pool price and spread in the middle, sell orders below
//   chart         the pool's price after each of the market's recent swaps, or the depth of the resting orders
//   order form    limit or market, buy and sell side by side. A limit takes the orders that cross it and the rest
//                 rests on the book; a market order takes orders while they beat the pool, then uses the pool. One
//                 transaction either way, paid from what you hold in this world.
//   pool trades   the swaps that moved this world's pool
//   bottom tabs   your open orders (cancel any time), and what you hold in each world of this market
// Trading pauses while a result is in dispute; resting a new order does not.
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { PriceChart } from '../components/PriceChart'
import { WORLD_COLORS, WorldIcon } from '../components/Grand'
import { PageLoading } from '../components/layout/PageLoading'
import { ActionButton } from '../components/ui/ActionButton'
import { marketId, useActions, useBlocker, useMarket, useMarkets, type Announce, type ChainMarket } from '../chain/adapter'
import {
  avgPrice, expiryOf, levels, limitTrade, LIVES, marketTrade, maxFor, myOrders, orderState, priceLine, priceMoves,
  tradeBlocker, tradeGas, withSlippage, worldTradeTx, type Level, type PoolState, type WorldTrade,
} from '../chain/book'
import { CONTRACT_ID } from '../chain/data/client'
import type { Scenario, World } from '../chain/domain'
import { errorLine } from '../chain/errors'
import { accountLabel, fmt, fmtCompactUsd, inputText, parseAmount, utcDate } from '../chain/format'
import { usePoolState } from '../chain/hooks/useBook'
import { useChainClock, useNowSeconds } from '../chain/hooks/useClock'
import { useAppConfig, useTrade } from '../chain/hooks/useData'
import { marketsHref, ordersHref, resolveHref, splitHref } from '../chain/links'
import { useWallet } from '../chain/near/wallet'
import { cellBook, proceeds, type Order } from '../chain/orders'
import { chain } from '../config'

const ONE = 10n ** 18n
const num = (v: string) => v.replace(/[^0-9.]/g, '')
const DEPTHS = [5, 10, 15, 25]
const GROUPS = [
  { label: '0.0001', step: 10n ** 14n },
  { label: '0.01', step: 10n ** 16n },
  { label: '0.05', step: 5n * 10n ** 16n },
  { label: '0.10', step: 10n ** 17n },
]
type View = 'both' | 'bids' | 'asks'
const p4 = (x: bigint) => fmt(x, 4)
const n2 = (x: bigint) => fmt(x, 2)
/** A swap's time: the clock today, the date before that. */
const stamp = (sec: number, now: number) =>
  now - sec < 86_400
    ? new Date(sec * 1000).toLocaleTimeString('en-GB', { hour12: false })
    : new Date(sec * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
const worldOf = (s: Scenario, mask: number) => s.worlds.find((x) => x.mask === mask)
/** A pool move in percent, two decimals; a move too small to show at that reads "<0.01%". */
function move(prev: bigint, price: bigint): string {
  const up = price >= prev
  const bp = ((up ? price - prev : prev - price) * 100n * ONE) / prev
  return bp < 10n ** 16n ? `${up ? '+' : '−'}<0.01%` : `${up ? '+' : '−'}${fmt(bp, 2)}%`
}
/** A world's chance in whole percent; a whole-percent 0 shows its first decimal instead. */
const chanceText = (c: number) => (c > 0 && c < 0.01 ? `${(c * 100).toFixed(1)}%` : `${Math.round(c * 100)}%`)

// one half of the book. Buys sit above the middle with the best bid lowest, right next to it; sells sit below with
// the best ask highest. The running sum and its depth bar grow away from the middle on both sides.
function Rows({ side, rows, max, dec, me, onPick }: { side: 'bid' | 'ask'; rows: Level[]; max: bigint; dec: number; me: string | null; onPick: (l: Level) => void }) {
  const shown = side === 'bid' ? [...rows].reverse() : rows
  return (
    <div className={`obx__side obx__side--${side}`} aria-label={side === 'bid' ? 'Buy orders' : 'Sell orders'}>
      {rows.length === 0 && <p className="obx__empty">No {side === 'bid' ? 'buy' : 'sell'} orders.</p>}
      {shown.map((l) => (
        <button
          key={String(l.price)}
          type="button"
          className={`obx__row${l.mine ? ' is-mine' : ''}`}
          onClick={() => onPick(l)}
          title={l.orders.map((o) => `#${o.id} ${me && o.maker.toLowerCase() === me.toLowerCase() ? 'You' : accountLabel(o.maker)}: ${n2(o.remaining)} NEAR at ${p4(o.price)}`).join('\n')}
        >
          <i className="obx__bar" style={{ width: `${Number((l.sum * 10_000n) / (max > 0n ? max : 1n)) / 100}%` }} aria-hidden />
          <span className="obx__price num">{fmt(l.price, dec)}</span>
          <span className="num">{n2(l.amount)}</span>
          <span className="num">{n2(l.sum)}</span>
        </button>
      ))}
    </div>
  )
}

type Preset = { price: bigint; n: number }

type TicketCtx = {
  sid: number
  world: World
  name: string
  held: { near: bigint; usdc: bigint }
  asks: Order[]
  bids: Order[]
  pool: PoolState | null | undefined
  halted: boolean
  me: string | null
  openOrders: number
  /** Unix seconds an order posted now would expire at. */
  expiry: () => number
}

function Ticket({ side, type, ctx, preset, focus }: { side: 'buy' | 'sell'; type: 'limit' | 'market'; ctx: TicketCtx; preset?: Preset; focus?: boolean }) {
  const actions = useActions()
  const [price, setPrice] = useState('')
  const [amount, setAmount] = useState('')
  const [seen, setSeen] = useState(preset)
  if (preset !== seen) { setSeen(preset); if (preset) setPrice(inputText(preset.price, 4)) } // a click on the book fills the price
  const { sid, world, name, held, pool, me } = ctx
  const book = side === 'buy' ? ctx.asks : ctx.bids
  const limit = type === 'limit' ? parseAmount(price, 18) : undefined
  const a = parseAmount(amount, 18)
  const plan = (n: bigint): WorldTrade | undefined =>
    type === 'limit' ? (limit ? limitTrade(side, n, limit, book, me) : undefined) : marketTrade(side, n, book, pool ?? null, me)
  const t = a ? plan(a) : undefined
  const avbl = side === 'buy' ? held.usdc : held.near
  const unit = side === 'buy' ? 'USDC' : 'NEAR'
  const best = book.find((o) => !me || o.maker.toLowerCase() !== me.toLowerCase())?.price

  let blocker: string | undefined
  if (type === 'limit' && !limit) blocker = 'Enter a price'
  else if (!a) blocker = 'Enter an amount'
  else if (type === 'market' && pool === undefined) blocker = 'Reading the pool…'
  else if (!t) blocker = side === 'buy' ? 'Nothing to buy from: no asks, no pool' : 'Nothing to sell into: no bids, no pool'
  else if (ctx.halted && (t.takes.length > 0 || t.pool)) blocker = 'Paused during a dispute'
  else blocker = tradeBlocker(t, avbl, { limit: limit ?? null, openOrders: ctx.openOrders })

  // the share buttons: a sale sells that share of your NEAR here; a buy spends that share of your USDC here
  const pctOf = (k: bigint) => {
    const budget = (avbl * k) / 100n
    if (side === 'sell') return setAmount(budget > 0n ? inputText(budget, 4) : '')
    const hi = type === 'limit' ? (limit ? (budget * ONE) / limit + 1n : 0n) : (pool?.wnear ?? 0n) + book.reduce((s, o) => s + o.remaining, 0n)
    const most = maxFor(budget, hi, plan)
    setAmount(most > 0n ? inputText(most, 4) : '')
  }
  const total = t ? (side === 'buy' ? t.spend : t.usdc + (t.rest > 0n && limit ? proceeds(t.rest, limit) : 0n)) : undefined
  const poolPx = pool && pool.wnear > 0n ? (pool.usdc * ONE) / pool.wnear : undefined
  const throughPool = type === 'limit' && t && t.rest > 0n && limit && poolPx !== undefined && (side === 'buy' ? limit > poolPx : limit < poolPx)

  const announce = (x: WorldTrade): Announce => {
    const now = x.near > 0n
    const rests = x.rest > 0n
    const order = side === 'buy' ? 'bid' : 'ask'
    return {
      kind: 'trade',
      title: side === 'buy' ? 'Buy' : 'Sell',
      market: sid,
      pending: now ? `${side === 'buy' ? 'Buying' : 'Selling'} ${n2(x.near)} NEAR in ${name}…` : `Posting your ${order}…`,
      done: now && rests ? `Filled ${n2(x.near)} NEAR; the rest rests at ${p4(limit!)}` : now ? `${side === 'buy' ? 'Bought' : 'Sold'} ${n2(x.near)} NEAR in ${name}` : `Your ${order} rests at ${p4(limit!)}`,
    }
  }

  return (
    <div className={`tk tk--${side}`}>
      {type === 'limit' ? (
        <label className="tk__field"><span>Price</span>
          <input inputMode="decimal" placeholder={best ? inputText(best, 4) : '0.00'} value={price} onChange={(e) => setPrice(num(e.target.value))} aria-label={`${side} price`} />
          <em>USDC</em>
        </label>
      ) : (
        <div className="tk__field tk__field--fixed"><span>Price</span><b>{side === 'buy' ? 'Best asks, then the pool' : 'Best bids, then the pool'}</b><em>USDC</em></div>
      )}
      <label className="tk__field"><span>Amount</span>
        <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(num(e.target.value))} aria-label={`${side} amount`} autoFocus={focus} />
        <em>NEAR</em>
      </label>
      <div className="tk__pcts" role="group" aria-label="Share of what you hold here">
        {[25n, 50n, 75n, 100n].map((k) => <button key={String(k)} type="button" onClick={() => pctOf(k)} disabled={avbl === 0n}>{String(k)}%</button>)}
      </div>
      <div className="tk__field tk__field--fixed"><span>{side === 'buy' ? 'Total' : 'You get'}</span><b className="num">{total !== undefined ? n2(total) : '–'}</b><em>USDC</em></div>
      {me && <p className="tk__line"><span>Available in this world</span><b className="num">{n2(avbl)} {unit}</b></p>}
      {t && (
        <p className="tk__line tk__line--muted">
          {t.near > 0n
            ? <>Fills {n2(t.near)} NEAR now at avg {p4(avgPrice(t))} ({t.takes.length > 0 ? `${t.takes.length} order${t.takes.length === 1 ? '' : 's'}` : ''}{t.takes.length > 0 && t.pool ? ' + ' : ''}{t.pool ? 'pool' : ''})</>
            : 'Nothing crosses the book'}
          {t.rest > 0n && <>; {n2(t.rest)} NEAR rests as your order</>}
          {t.pool && <>. The pool part must {side === 'buy' ? `give at least ${n2(withSlippage(t.pool.near))} NEAR` : `pay at least ${n2(withSlippage(t.pool.usdc))} USDC`}, or nothing happens.</>}
        </p>
      )}
      {throughPool && <p className="tk__line tk__line--muted">{side === 'buy' ? 'Above' : 'Below'} the pool price ({p4(poolPx!)}): anyone can {side === 'buy' ? 'sell into' : 'buy from'} it through the pool at once.</p>}
      <ActionButton
        label={`${side === 'buy' ? 'Buy' : 'Sell'} NEAR`}
        blocker={blocker}
        action={t && t.rest > 0n && t.takes.length === 0 ? 'post_order' : side}
        gas={t ? tradeGas(t).toString() : undefined}
        run={() => actions.send(worldTradeTx(CONTRACT_ID, t!, { sid, mask: world.mask, poolId: world.poolId, limit: limit ?? null, expirySec: ctx.expiry() }), announce(t!), { needs: { contract: true } })}
        onDone={() => setAmount('')}
      />
    </div>
  )
}

// One of your orders: cancel gives the escrow back to what you hold in its world, whatever state the order is in.
function Cancel({ order, sid }: { order: Order; sid: number }) {
  const actions = useActions()
  const blocked = useBlocker('cancel_order')
  const [busy, setBusy] = useState(false)
  return (
    <button type="button" className="ob__act" disabled={busy || Boolean(blocked)} title={blocked} onClick={async () => { setBusy(true); try { await actions.cancelOrder(order.id, sid) } finally { setBusy(false) } }}>
      {busy ? 'Cancelling…' : 'Cancel'}
    </button>
  )
}

export default function Orders() {
  const params = useSearchParams()
  const router = useRouter()
  const { accountId, connect } = useWallet()
  const cfg = useAppConfig().data
  const { markets } = useMarkets()
  const sid = marketId(params.get('id')) ?? chain.anchorMarket
  const { market: m, isLoading, notFound, error } = useMarket(sid)
  const trade = useTrade(sid, accountId)
  const now = useNowSeconds()
  const clock = useChainClock(trade.data?.nowSec, trade.dataUpdatedAt)
  const s = trade.data?.scenario
  const live = s ? s.worlds.filter((x) => x.possible) : []
  const asked = Number(params.get('w'))
  const world = live.find((x) => x.index === asked) ?? live[0]
  const pool = usePoolState(world?.poolId)

  const [depth, setDepth] = useState(15)
  const [group, setGroup] = useState(1)
  const [view, setView] = useState<View>('both')
  const [type, setType] = useState<'limit' | 'market'>('limit')
  const [life, setLife] = useState(1)
  const [preset, setPreset] = useState<{ side: 'buy' | 'sell'; price: bigint; n: number } | null>(null)
  const [bottom, setBottom] = useState<'open' | 'holdings'>('open')
  const [query, setQuery] = useState('')
  // the strip scrolls to the world on screen (an 8-world market's worlds sit far along it)
  const strip = useRef<HTMLDivElement>(null)
  const onScreen = `${sid}-${world?.index}-${markets ? 1 : 0}`
  useEffect(() => {
    const box = strip.current
    const chip = box?.querySelector<HTMLElement>('[aria-pressed="true"]')
    if (box && chip) box.scrollLeft = Math.max(0, chip.offsetLeft - box.offsetLeft - 24)
  }, [onScreen])

  const choose = (id: number, w?: number) => { setPreset(null); router.replace(ordersHref(id, { w }), { scroll: false }) }
  const book = s && world && trade.data
    ? cellBook(trade.data.orders, { scenarioId: s.scenarioId, possible: s.possible, resolutionCount: s.resolutionCount }, world.mask, now)
    : { bids: [], asks: [] }

  // every world of every open market, for the strip
  const tradable = (markets ?? []).filter((x) => !x.settled)
  const q = query.trim().toLowerCase()
  const chips = tradable.flatMap((x) => x.worlds.filter((y) => y.possible).map((y) => ({ x, y })))
    .filter(({ x, y }) => !q || `${y.outcome} ${x.question}`.toLowerCase().includes(q))

  if (notFound && !isLoading) {
    return (
      <div className="page tr desk">
        <header className="tr__pair"><div className="tr__id"><h1 className="mk__title">Order book</h1><p className="tr__means">Trade NEAR inside one world of a market.</p></div></header>
        <div className="tr__panel desk__empty"><p><b>No market #{params.get('id')}.</b> The link may be wrong, or the market is on another deployment.</p><Link className="mk__btn mk__btn--buy" href={marketsHref}>See the markets</Link></div>
      </div>
    )
  }
  if (cfg && !cfg.orderBook) {
    return (
      <div className="page tr desk">
        <header className="tr__pair"><div className="tr__id"><h1 className="mk__title">Order book</h1></div></header>
        <div className="tr__panel desk__empty"><p><b>Not live yet.</b> The order book is not open on this deployment.</p><Link className="mk__btn mk__btn--buy" href={marketsHref}>See the markets</Link></div>
      </div>
    )
  }
  if (!m || !s || !trade.data) {
    const err = error ?? trade.error
    return err ? <PageLoading label={errorLine(err.message)} /> : <PageLoading />
  }
  if (m.settled || !world) {
    return (
      <div className="page tr desk">
        <header className="tr__pair"><div className="tr__id"><h1 className="mk__title">{m.question}</h1><p className="tr__means">Order book</p></div></header>
        <div className="tr__panel desk__empty"><p><b>This market has settled.</b> Its book is closed; what you hold in the world that happened pays out on Resolve.</p><Link className="mk__btn mk__btn--buy" href={resolveHref(sid)}>Redeem</Link></div>
      </div>
    )
  }

  const cw = m.worlds[world.index]
  const name = cw?.outcome ?? world.label
  const me = accountId
  const step = GROUPS[group].step
  const dec = step >= 10n ** 16n ? 2 : 4
  const bids = levels(book.bids, 'bid', step, depth, me)
  const asks = levels(book.asks, 'ask', step, depth, me)
  const max = [bids.at(-1)?.sum ?? 0n, asks.at(-1)?.sum ?? 0n].reduce((a, b) => (a > b ? a : b), 1n)
  const price = world.poolInitialized ? world.wnearPrice : 0n
  const bestBid = book.bids[0]?.price
  const bestAsk = book.asks[0]?.price
  const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : null
  const mine = myOrders(trade.data.orders, me, sid)
  const state = { scenarioId: s.scenarioId, possible: s.possible, resolutionCount: s.resolutionCount }
  const points = priceLine(trade.data.impact, world.index)
  const moves = priceMoves(trade.data.impact, world.index).slice(0, 40)
  const held = { near: world.userWnear, usdc: world.userUsdc }
  const ctx: TicketCtx = {
    sid, world, name, held, pool, me, halted: s.halted, openOrders: mine.length, asks: book.asks, bids: book.bids,
    expiry: () => expiryOf(clock.now, now, LIVES[life].seconds),
  }
  const nowNum = Number(now)

  return (
    <div className="page obx tr">
      {/* ---------- pair bar ---------- */}
      <header className="tr__pair">
        <div className="tr__id">
          <div className="tr__title">
            <h1>NEAR/USDC</h1>
            <span className="tr__world">{name}</span>
            <label className="tr__market">
              <span>Change market</span>
              <select value={sid} onChange={(e) => choose(Number(e.target.value))} aria-label="Change market">
                {(tradable.some((x) => x.sid === sid) ? tradable : [m, ...tradable]).map((x: ChainMarket) => <option key={x.sid} value={x.sid}>{x.question}</option>)}
              </select>
            </label>
          </div>
          <p className="tr__q">{m.question}</p>
          {/* what this world is, in plain words: the pieces traded here pay out only if it happens */}
          <p className="tr__means">
            Pays out only if the market ends in <b>{name.toLowerCase()}</b>.
            {m.oddsKnown && cw && <>{' '}{chanceText(cw.chance)} chance today.</>}
          </p>
        </div>
        <div className="tr__quote">
          <b className="num">{price > 0n ? p4(price) : '–'}</b>
          <span className="tr__sub">pool price, USDC per NEAR</span>
        </div>
        <dl className="tr__stats">
          <div><dt>Best bid</dt><dd className="num is-up">{bestBid !== undefined ? p4(bestBid) : '–'}</dd></div>
          <div><dt>Best ask</dt><dd className="num is-down">{bestAsk !== undefined ? p4(bestAsk) : '–'}</dd></div>
          <div><dt>Pool depth</dt><dd className="num">{pool ? fmtCompactUsd(pool.usdc) : '–'}</dd></div>
          <div><dt>Resting orders</dt><dd className="num">{book.bids.length + book.asks.length}</dd></div>
        </dl>
      </header>

      {s.halted && <p className="ob__halt">A result is in its dispute window, so this market’s trading is paused until it’s final or disputed. You can still rest an order or cancel one.</p>}

      {/* ---------- every world you can trade, as a strip of chips ---------- */}
      <nav className="tr__strip" aria-label="Worlds">
        <input className="tr__find" type="search" placeholder="Find a world" aria-label="Find a world" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="tr__chips" ref={strip}>
          {chips.map(({ x, y }) => (
            <button key={`${x.sid}-${y.index}`} type="button" aria-pressed={x.sid === sid && y.index === world.index} className="tr__chip" onClick={() => choose(x.sid, y.index)} title={x.question}>
              <b>{y.outcome}</b>
              <span className="num">{y.nearPrice > 0 ? y.nearPrice.toFixed(2) : '–'} <em>#{x.sid}</em></span>
            </button>
          ))}
          {markets && chips.length === 0 && <span className="tr__none">No world matches.</span>}
          {!markets && <span className="tr__none">Reading the markets…</span>}
        </div>
      </nav>

      <div className="tr__grid">
        {/* ---------- order book ---------- */}
        <section className="obx__box tr__book" aria-label={`Order book for ${name}`}>
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
              <select value={group} onChange={(e) => setGroup(Number(e.target.value))}>{GROUPS.map((g, i) => <option key={g.label} value={i}>{g.label}</option>)}</select>
            </label>
          </div>
          <div className="obx__row obx__row--head">
            <span>Price (USDC)</span><span>Amount (NEAR)</span><span>Sum (USDC)</span>
          </div>
          {view !== 'asks' && <Rows side="bid" rows={bids} max={max} dec={dec} me={me} onPick={(l) => setPreset({ side: 'sell', price: l.price, n: Date.now() })} />}
          <div className="obx__mid">
            <span className="obx__mid-main"><b className="num">{price > 0n ? p4(price) : '–'}</b><span className="obx__mid-label">pool</span></span>
            <span className="obx__mid-main obx__mid-spread"><b className="num">{spread === null ? '–' : p4(spread)}</b><span className="obx__mid-label">{spread === null ? 'spread, one-sided' : price > 0n ? `spread ${fmt((spread * 100n * ONE) / price, 2)}%` : 'spread'}</span></span>
          </div>
          {view !== 'bids' && <Rows side="ask" rows={asks} max={max} dec={dec} me={me} onPick={(l) => setPreset({ side: 'buy', price: l.price, n: Date.now() })} />}
          <p className="obx__hint">Click a level to put its price in the order form. A dot marks your own.</p>
        </section>

        {/* ---------- chart and order form ---------- */}
        <div className="tr__center">
          <PriceChart points={points} bids={book.bids} asks={book.asks} price={price} color={WORLD_COLORS[world.index % WORLD_COLORS.length]} />

          <section className="tr__form" aria-label="Place an order">
            <div className="tr__formhead">
              <div className="pc__tabs" role="group" aria-label="Order type">
                {(['limit', 'market'] as const).map((x) => <button key={x} type="button" aria-pressed={type === x} onClick={() => setType(x)}>{x === 'limit' ? 'Limit' : 'Market'}</button>)}
              </div>
              {type === 'limit' && (
                <label className="obx__ctl tr__life"><span>Good for</span>
                  <select value={life} onChange={(e) => setLife(Number(e.target.value))}>{LIVES.map((l, i) => <option key={l.label} value={i}>{l.label}</option>)}</select>
                </label>
              )}
              <span className="pc__note">Trades NEAR-if-{name} for USDC-if-{name}</span>
            </div>
            {/* one balance only: what you hold inside this world, which is what the form trades */}
            {accountId ? (
              <p className="tr__bal">
                <span>You hold in <b>{name}</b></span>
                <b className="num">{n2(held.near)} NEAR</b>
                <b className="num">{n2(held.usdc)} USDC</b>
                <Link href={splitHref(sid)}>Add funds</Link>
              </p>
            ) : (
              <p className="tr__bal tr__bal--gate">
                <span>Connect a wallet to trade.</span>
                <button type="button" className="tr__link" onClick={() => void connect()}>Connect NEAR wallet</button>
              </p>
            )}
            <div className="tr__tickets">
              <Ticket key={`buy-${sid}-${world.index}-${type}`} side="buy" type={type} ctx={ctx} preset={preset?.side === 'buy' ? preset : undefined} focus={params.get('buy') === '1'} />
              <Ticket key={`sell-${sid}-${world.index}-${type}`} side="sell" type={type} ctx={ctx} preset={preset?.side === 'sell' ? preset : undefined} />
            </div>
          </section>
        </div>

        {/* ---------- the pool's recent trades ---------- */}
        <aside className="tr__right">
          <section className="tr__panel tr__trades" aria-label="Pool trades">
            <div className="desk__head"><h2 className="obx__boxtitle">Pool trades</h2><span className="pc__note">{moves.length > 0 ? `last ${moves.length}` : ''}</span></div>
            <div className="tr__list">
              <div className="tr__li tr__li--head tr__li--trade"><span>Price (USDC)</span><span>Move</span><span>Time</span></div>
              {moves.map((x) => (
                <div key={x.at} className="tr__li tr__li--trade">
                  <span className={`num ${x.up ? 'is-up' : 'is-down'}`}>{p4(x.price)}</span>
                  <span className="num">{move(x.prev, x.price)}</span>
                  <span className="num" title={utcDate(x.at)}>{stamp(x.at, nowNum)}</span>
                </div>
              ))}
              {moves.length === 0 && <p className="obx__empty">No swap has moved this world’s pool lately.</p>}
            </div>
            <p className="pc__note">Swaps that moved this world’s pool, newest first, from the contract’s record of the market’s last 64. Order fills are not listed.</p>
          </section>
        </aside>
      </div>

      {/* ---------- your orders and holdings ---------- */}
      <section className="tr__bottom" aria-label="Your activity">
        <div className="pc__tabs" role="group" aria-label="Your activity">
          <button type="button" aria-pressed={bottom === 'open'} onClick={() => setBottom('open')}>Open orders ({mine.length})</button>
          <button type="button" aria-pressed={bottom === 'holdings'} onClick={() => setBottom('holdings')}>Holdings</button>
        </div>
        {!accountId ? <p className="obx__empty">Connect a wallet to see your orders and holdings.</p> : bottom === 'open' ? (
          mine.length === 0 ? <p className="obx__empty">No open orders in this market.</p> : (
            <div className="pg-table">
              <div className="pg-table__row pg-table__row--head tr__row6"><span>World</span><span>Side</span><span>Price</span><span>Left</span><span>Until</span><span /></div>
              {mine.map((o) => {
                const ow = worldOf(s, o.mask)
                const why = orderState(o, state, now)
                return (
                  <div key={String(o.id)} className="pg-table__row tr__row6">
                    <button type="button" className="tr__wbtn" onClick={() => ow && ow.possible && choose(sid, ow.index)}>{ow ? (m.worlds[ow.index]?.outcome ?? ow.label) : `Worlds ${o.mask}`}</button>
                    <span className={o.side === 'bid' ? 'is-up' : 'is-down'}>{o.side === 'bid' ? 'Buy' : 'Sell'}</span>
                    <span className="num">{p4(o.price)}</span>
                    <span className="num">{n2(o.remaining)} of {n2(o.amount)} NEAR</span>
                    <span className={why ? 'tone--watch' : 'num'}>{why ?? utcDate(o.expiry)}</span>
                    <span><Cancel order={o} sid={sid} /></span>
                  </div>
                )
              })}
            </div>
          )
        ) : (
          <div className="pg-table">
            <div className="pg-table__row pg-table__row--head"><span>World</span><span>NEAR</span><span>USDC</span><span>Worth here</span></div>
            {live.map((x) => (
              <button key={x.index} type="button" className={`pg-table__row tr__hold${x.index === world.index ? ' is-on' : ''}`} onClick={() => choose(sid, x.index)}>
                <span className="desk__mk"><WorldIcon m={m} w={x.index} size={22} />{m.worlds[x.index]?.outcome ?? x.label}</span>
                <span className="num">{n2(x.userWnear)}</span>
                <span className="num">{n2(x.userUsdc)}</span>
                <span className="num">${n2(proceeds(x.userWnear, x.wnearPrice) + x.userUsdc)}</span>
              </button>
            ))}
          </div>
        )}
        {accountId && bottom === 'holdings' && <p className="pc__note">What you hold outside lending, priced at each world’s pool. <Link className="tr__link" href={splitHref(sid)}>Split or merge</Link></p>}
      </section>
    </div>
  )
}
