'use client'
// The portfolio, built from what the big apps show (Polymarket: positions value and a positions table; DeBank: an
// allocation breakdown; Hyperliquid: health beside the account) plus the one view only a multiverse app can give: what
// the whole portfolio is worth in each future. Every figure is the chain's: world tokens (NEP-245), each tier's
// collateral, loans and supply (lending_tiers), open orders (orders_by_maker), each world's pool price and odds.
// No history is kept on chain, so there is no value chart, P&L or cost basis here.
//   header        on average (by each world's chance), at worst, at best, borrowed, lent
//   every future  per market: the range from worst to best world, then what you end with if each world happens;
//                 "what if NEAR moves" is a labelled what-if over your real holdings
//   loans         every loan and supply by market and tier, beside health and the wallet
//   tabs          positions by market, open orders
import { useState, type CSSProperties, type ReactNode } from 'react'
import Link from 'next/link'
import { useActions, useMarkets, useWalletBalances, type ChainMarket } from '../chain/adapter'
import { useMarketsOf } from '../chain/hooks/useMarkets'
import { errorLine } from '../chain/errors'
import { fmt, fmtHf, fmtNear, fmtPrice, fmtUsd, hfTone, pct } from '../chain/format'
import { useHoldings } from '../chain/hooks/useLiquidation'
import { WAD } from '../chain/lending'
import { holdsAnything, marketHoldings, useOpenOrders, useTiersOf, type MarketHoldings } from '../chain/lending-screens'
import { hedgeShape, oddsWeighted, tierPositions, worldWorth } from '../chain/lending-view'
import { borrowHref, lendHref, marketHref, marketsHref, ordersHref, resolveHref } from '../chain/links'
import { useWallet } from '../chain/near/wallet'
import { TIER_LABEL } from '../chain/tiers'
import { chain } from '../config'
import { Gauge, MarketArt, WORLD_COLORS, WorldIcon } from '../components/Grand'
import { PageLoading } from '../components/layout/PageLoading'
import { RowAction } from '../components/lending/RowAction'
import { Button } from '../components/ui'
import { BRAND } from '../chain/brand'
import { short } from '../lib/format'

const TONE = { ok: 'safe', warn: 'watch', bad: 'risk' } as const
const tone = (hf: bigint | null) => TONE[hfTone(hf)]
const n = (x: bigint) => Number(x) / 1e18
const whole = (x: bigint) => `${x < 0n ? '−' : ''}$${fmt(x < 0n ? -x : x, 0)}`
type Tab = 'positions' | 'orders'

export default function Portfolio() {
  const { accountId, connect } = useWallet()
  if (!accountId) return <SignedOut connect={() => void connect()} />
  return <Mine key={accountId} account={accountId} />
}

// signed out: the page's own layout and a connect panel where the positions go (as Aave and Polymarket do)
function SignedOut({ connect }: { connect: () => void }) {
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
            <p className="tr__means">Your value in every future, your positions in each market, your loans and their health, what you’ve lent and your open orders.</p>
            <div className="pf-gate__acts">
              <div className="tk tk--buy"><Button onClick={connect}>Connect NEAR wallet</Button></div>
              <Link href={marketsHref} className="mk__btn">Browse markets</Link>
            </div>
            <p className="pc__note">{BRAND.testnetNote} Once connected, “Get test tokens” in the wallet menu fills your wallet.</p>
          </section>
        </div>
        <aside className="mk__side">
          <section className="tr__panel pf-what">
            <h2 className="obx__boxtitle">What you’ll see here</h2>
            <ul>
              <li><b>Every future</b><span>what you end with if each world happens</span></li>
              <li><b>Value</b><span>on average by chance, at worst and at best</span></li>
              <li><b>Loans and health</b><span>with the world that would be liquidated first</span></li>
              <li><b>Supply and orders</b><span>what you’ve lent and the orders you have open</span></li>
            </ul>
          </section>
          <section className="tr__panel pf-what">
            <h2 className="obx__boxtitle">New here?</h2>
            <p className="tr__means">Fund a market with NEAR or USDC to hold it in every world, then sell NEAR in the worlds you fear and borrow against the rest.</p>
            <Link href="/docs/" className="tr__link">How it works</Link>
          </section>
        </aside>
      </div>
    </div>
  )
}

function Mine({ account }: { account: string }) {
  const mine = useMarketsOf(account)
  const sids = mine.data ?? []
  const { markets, error } = useMarkets({ listedOnly: false })
  const tokens = useHoldings(account)
  const tiers = useTiersOf(sids, account)
  const orders = useOpenOrders(sids, account)
  const balances = useWalletBalances()
  const [tab, setTab] = useState<Tab>('positions')

  const bySid = new Map((markets ?? []).map((m) => [m.sid, m]))
  const ready = mine.data !== undefined && markets !== undefined && tokens.data !== undefined && sids.every((s) => tiers.tiers.has(s) || !bySid.has(s))
  if (!ready) {
    const err = mine.error ?? error ?? tokens.error ?? tiers.error
    return err ? <Frame account={account}><div className="tr__panel desk__empty"><p className="pc__note">{errorLine(err.message)}</p></div></Frame> : <PageLoading label="Reading your worlds…" />
  }
  const held = sids
    .map((s) => bySid.get(s))
    .filter((m): m is ChainMarket => m !== undefined)
    .map((m) => marketHoldings(m, tokens.data ?? [], tiers.tiers.get(m.sid) ?? []))
    .filter(holdsAnything)
  const withWorlds = held.filter((h) => h.held.near.some((x) => x > 0n) || h.held.usdc.some((x) => x > 0n) || h.debt > 0n)
  const positions = held.flatMap((h) => tierPositions(h.market.sid, h.tiers))
  const spot = bySid.get(chain.anchorMarket)?.impliedSpotWad ?? 0n
  const walletValue = balances ? balances.usdcWad + balances.innerUsdcWad + ((balances.nearWad + balances.innerNearWad) * spot) / WAD : 0n
  const supplied = held.reduce((s, h) => s + h.supplied, 0n)
  const debt = held.reduce((s, h) => s + h.debt, 0n)
  const avg = held.reduce((s, h) => s + h.average, 0n) + supplied + walletValue
  const worst = held.reduce((s, h) => s + (h.worst !== undefined ? h.values[h.worst] : 0n), 0n) + supplied + walletValue
  const best = held.reduce((s, h) => s + (h.best !== undefined ? h.values[h.best] : 0n), 0n) + supplied + walletValue
  const hfs = held.map((h) => h.lowestHealth).filter((x): x is bigint => x !== null)
  const lowest = hfs.length ? hfs.reduce((a, b) => (b < a ? b : a)) : null
  const borrowable = held.flatMap((h) => h.tiers).reduce((s, t) => s + (t.account?.maxBorrow ?? 0n), 0n)
  const openOrders = orders.orders ?? []
  // where the money is, on average: NEAR and dollars held in worlds (weighted by each world's chance), lent, wallet
  const nearExposure = held.reduce((s, h) => s + oddsWeighted(h.held.near.map((x, w) => (x * (h.market.worlds[w]?.price ?? 0n)) / WAD), h.market.worlds.map((w) => w.odds), h.market.possible), 0n)
  const hedgedUsdc = held.reduce((s, h) => s + oddsWeighted(h.held.usdc, h.market.worlds.map((w) => w.odds), h.market.possible), 0n)

  return (
    <Frame
      account={account}
      sub={`${short(account)} · positions in ${held.length} market${held.length === 1 ? '' : 's'}, ${openOrders.length} open order${openOrders.length === 1 ? '' : 's'}`}
      quote={<div className="tr__quote"><b className="num">{whole(avg)}</b><span className="pc__note">on average, by each world’s chance</span></div>}
      stats={
        <>
          <div><dt>At worst</dt><dd className="num">{whole(worst)}</dd></div>
          <div><dt>At best</dt><dd className="num">{whole(best)}</dd></div>
          <div><dt>Borrowed</dt><dd className="num">{fmtUsd(debt)}</dd></div>
          <div><dt>Lent</dt><dd className="num">{fmtUsd(supplied)}</dd></div>
        </>
      }
    >
      <div className="pf-rows">
        <div className="pf-row">
          <div className="pf-col">
            {withWorlds.length === 0 ? (
              <section className="tr__panel desk__empty"><p><b>Nothing in any world yet.</b> Fund a market with NEAR or USDC to hold it in every world.</p><Link href={marketsHref} className="mk__btn mk__btn--buy">Browse markets</Link></section>
            ) : withWorlds.map((h) => <Futures key={h.market.sid} h={h} />)}
          </div>
          <section className="tr__panel">
            <h2 className="obx__boxtitle">Where your money is</h2>
            <Donut parts={[
              { label: 'NEAR in worlds', value: n(nearExposure), color: '#e9b8bb' },
              { label: 'Dollars in worlds', value: n(hedgedUsdc), color: '#7dc9a5' },
              { label: 'Lent', value: n(supplied), color: '#6fb7e8' },
              { label: 'Wallet', value: n(walletValue), color: '#9b8cf0' },
            ]} />
            {debt > 0n && <p className="tk__line"><span>Owed</span><b className="num is-down">−{fmtUsd(debt)}</b></p>}
            <div className="pf-expo">
              <p className="tk__line"><span>Moves with NEAR</span><b className="num">{pct(nearExposure, nearExposure + hedgedUsdc + supplied + walletValue > 0n ? nearExposure + hedgedUsdc + supplied + walletValue : 1n, 0)}</b></p>
              <div className="pf-expo__bar"><i style={{ width: `${nearExposure + hedgedUsdc + supplied + walletValue > 0n ? Number((nearExposure * 1000n) / (nearExposure + hedgedUsdc + supplied + walletValue)) / 10 : 0}%` }} /></div>
              <p className="tk__line"><span>If NEAR moves 10%</span><b className="num">±{fmtUsd(nearExposure / 10n)}</b></p>
            </div>
            <p className="pc__note pf-donut-note">Worlds are weighted by each one’s chance. The wallet’s wNEAR is valued at {fmtPrice(spot)}, the markets’ NEAR price.</p>
          </section>
        </div>

        <div className="pf-row">
          <Loans positions={positions} bySid={bySid} />
          <Side lowest={lowest} loans={positions.filter((p) => p.debt > 0n).length} debt={debt} borrowable={borrowable} supplied={supplied} />
        </div>

        <div className="pc__tabs desk__filter" role="group" aria-label="Show">
          <button type="button" aria-pressed={tab === 'positions'} onClick={() => setTab('positions')}>Positions ({held.length})</button>
          <button type="button" aria-pressed={tab === 'orders'} onClick={() => setTab('orders')}>Open orders ({openOrders.length})</button>
        </div>
        <section className="tr__panel">
          {tab === 'positions' ? <Positions held={held} /> : <Orders orders={orders.orders} bySid={bySid} error={orders.error} />}
        </section>
      </div>
    </Frame>
  )
}

function Frame({ account, sub, quote, stats, children }: { account: string; sub?: string; quote?: ReactNode; stats?: ReactNode; children: ReactNode }) {
  return (
    <div className="page tr desk">
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">Portfolio</h1>
          <p className="tr__means">{sub ?? short(account)}</p>
        </div>
        {quote}
        {stats && <dl className="tr__stats">{stats}</dl>}
      </header>
      {children}
    </div>
  )
}

// a donut of where the money is, DeBank-style (display numbers only)
function Donut({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((t, p) => t + Math.max(0, p.value), 0) || 1
  const R = 52, C = 2 * Math.PI * R
  const shown = parts.filter((p) => p.value > 0)
  const starts = shown.map((_, i) => shown.slice(0, i).reduce((t, p) => t + (p.value / total) * C, 0))
  const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`
  return (
    <div className="donut">
      <svg viewBox="0 0 140 140" role="img" aria-label={`Allocation: ${parts.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ')}`}>
        <circle cx="70" cy="70" r={R} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="16" />
        {shown.map((p, i) => {
          const len = (p.value / total) * C
          return <circle key={p.label} cx="70" cy="70" r={R} fill="none" stroke={p.color} strokeWidth="16" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-starts[i]} transform="rotate(-90 70 70)" />
        })}
        <text x="70" y="66" textAnchor="middle" fontSize="11" fill="#8e96a8">assets</text>
        <text x="70" y="84" textAnchor="middle" fontSize="15" fontWeight="600" fill="#f2f2ee" fontFamily="var(--font-mono)">{money(total)}</text>
      </svg>
      <ul>
        {parts.map((p) => <li key={p.label}><i style={{ background: p.color }} /><span>{p.label}</span><b className="num">{money(p.value)}</b><small className="num">{Math.round((Math.max(0, p.value) / total) * 100)}%</small></li>)}
      </ul>
    </div>
  )
}

// Your futures in one market: the range from your worst world to your best (each world a dot at what you'd end with,
// sized by its chance, your chance-weighted average marked), then the world grid of cards. "What if NEAR moves" is a
// what-if over your real holdings: the worlds holding USDC stay put, which is the hedge, made visible.
const SHOCKS = [-5000, -2500, 0, 2500, 5000]
function Futures({ h }: { h: MarketHoldings }) {
  const [shock, setShock] = useState(0)
  const m = h.market
  const live = m.worlds.filter((w) => w.possible)
  const prices = m.worlds.map((w) => w.price)
  const at = (bps: number) => worldWorth(h.held, prices, h.debt, m.possible, bps)
  const now = at(shock)
  const span = [...at(-5000), ...at(5000)].filter((_, i) => live.some((w) => w.index === i % m.worldCount)).map(n)
  const lo = Math.min(0, ...span), hi = Math.max(1, ...span) * 1.04
  const x = (v: number) => `${((v - lo) / (hi - lo || 1)) * 100}%`
  const vals = live.map((w) => n(now[w.index]))
  const worstV = Math.min(...vals), bestV = Math.max(...vals)
  const avg = oddsWeighted(now, m.worlds.map((w) => w.odds), m.possible)
  const shape = hedgeShape(h.held, m.possible)
  const order = [...live].sort((a, b) => (now[a.index] < now[b.index] ? -1 : 1))
  const grid = m.grid
  const card = (w: number) => {
    const world = m.worlds[w]
    if (!world?.possible) return <div key={w} className="fw is-dead"><span className="fw__name">{world?.outcome}</span><span className="fw__hold">Can’t happen any more</span></div>
    const v = now[w], near = h.held.near[w] > 0n
    const tag = live.length > 1 && n(v) === bestV ? 'Best' : live.length > 1 && n(v) === worstV ? 'Worst' : null
    const price = (world.price * BigInt(10_000 + shock)) / 10_000n
    return (
      <div key={w} className={`fw${tag === 'Worst' ? ' is-worst' : tag === 'Best' ? ' is-best' : ''}`}>
        <div className="fw__top">
          <span className="fw__name"><i style={{ background: WORLD_COLORS[w % WORLD_COLORS.length] }} />{world.outcome}</span>
          <span className="fw__chance">{m.oddsKnown ? `${pct(world.odds, WAD, world.odds < WAD / 10n ? 1 : 0)} likely` : 'no odds yet'}</span>
        </div>
        <p className="fw__lead">You end with</p>
        <p className="fw__value num">{whole(v)}</p>
        <p className={`fw__hold${near ? '' : ' is-usdc'}`}>
          {near ? `${fmtNear(h.held.near[w])} NEAR at ${fmtPrice(price)}${h.held.usdc[w] > 0n ? ` + ${fmt(h.held.usdc[w], 0)} USDC` : ''}, moves with NEAR` : h.held.usdc[w] > 0n ? `${fmt(h.held.usdc[w], 0)} USDC, fixed` : 'Nothing held here'}
          {h.debt > 0n ? ` · less ${fmtUsd(h.debt)} owed` : ''}
        </p>
        {tag && <span className={`fw__tag fw__tag--${tag.toLowerCase()}`}>{tag} case</span>}
      </div>
    )
  }
  return (
    <section className="tr__panel fut">
      <div className="desk__head">
        <div className="fut__title"><MarketArt m={m} size={32} /><div><h2 className="obx__boxtitle">Your range of futures</h2><p className="pc__note">{m.question}</p></div></div>
        <Link href={marketHref(m.sid)} className="tr__link">Change it</Link>
      </div>

      <div className="orng" role="img" aria-label={`${shock ? `If NEAR moves ${shock / 100}%: ` : ''}you end with between ${whole(BigInt(Math.round(worstV)) * WAD)} and ${whole(BigInt(Math.round(bestV)) * WAD)}, ${whole(avg)} on average`}>
        <div className="orng__band" style={{ left: x(worstV), width: `calc(${x(bestV)} - ${x(worstV)})` }} />
        <span className="orng__avg" style={{ left: x(n(avg)) }} />
        {order.map((w, k) => (
          <span key={w.index} className={`orng__dot${h.held.near[w.index] > 0n ? '' : ' is-usdc'}`} style={{ left: x(n(now[w.index])), width: 12 + w.chance * 40, height: 12 + w.chance * 40, background: WORLD_COLORS[w.index % WORLD_COLORS.length] }}>
            <small className={k % 2 ? 'is-low' : ''}>{w.outcome}<b className="num">{whole(now[w.index])}</b></small>
          </span>
        ))}
        <div className="orng__axis num"><span>${Math.round(lo).toLocaleString('en-US')}</span><span>${Math.round(hi).toLocaleString('en-US')}</span></div>
      </div>
      <div className="orng__legend">
        <span><i className="orng__k orng__k--avg" />Average, by chance <b className="num">{whole(avg)}</b></span>
        <span><i className="orng__k orng__k--band" />From worst to best world</span>
        <span><i className="orng__k orng__k--usdc" />Ringed: holds USDC</span>
      </div>

      <div className={`fgrid${grid.rows.length > 1 ? ' fgrid--rows' : ''}${grid.cols.length > 2 ? ' fgrid--wide' : ''}`} style={{ '--cols': grid.cols.length } as CSSProperties}>
        {grid.rows.length > 1 && <span />}
        {grid.cols.map((c) => <span key={c} className="fgrid__axis">{c}</span>)}
        {grid.rows.map((row) => [
          grid.rows.length > 1 ? <span key={`r${row.label}`} className="fgrid__axis fgrid__axis--row">{row.label}</span> : null,
          ...row.worlds.map(card),
        ])}
      </div>

      <div className="orng__ctl">
        <span>What if NEAR moves <small className="orng__what">· a what-if on your holdings</small></span>
        <input type="range" min={-50} max={50} step={5} value={Math.round(shock / 100)} onChange={(e) => setShock(Number(e.target.value) * 100)} aria-label="What if NEAR moved by this much in every world" />
        <div className="pc__tabs" role="group" aria-label="Presets">
          {SHOCKS.map((d) => <button key={d} type="button" aria-pressed={shock === d} onClick={() => setShock(d)}>{d === 0 ? 'Today' : `${d > 0 ? '+' : '−'}${Math.abs(d / 100)}%`}</button>)}
        </div>
      </div>
      <p className="orng__note">
        {shape.moving === 0
          ? 'No world holds NEAR, so nothing here moves with it.'
          : shape.fixed === 0
            ? <>Every world you hold NEAR in moves with it. <Link href={marketHref(m.sid)} className="tr__link">Sell NEAR in the worlds you fear</Link> to fix those in dollars.</>
            : `${shape.fixed === 1 ? 'The world' : `The ${shape.fixed} worlds`} holding only USDC ${shape.fixed === 1 ? 'stays' : 'stay'} fixed; only ${shape.moving === 1 ? 'the one holding NEAR moves' : `the ${shape.moving} holding NEAR move`}.`}
        {' '}On average, by chance: <b className="num">{whole(avg)}</b>.
      </p>
    </section>
  )
}

/** Every loan and supply, by market and tier. */
function Loans({ positions, bySid }: { positions: ReturnType<typeof tierPositions>; bySid: ReadonlyMap<number, ChainMarket> }) {
  return (
    <section className="tr__panel">
      <div className="desk__head"><h2 className="obx__boxtitle">Loans and lending</h2><Link href="/liquidate/" className="tr__link">At-risk loans</Link></div>
      {positions.length === 0 ? (
        <div className="desk__empty"><p><b>No loans or supply yet.</b> Borrow USDC against your worst world, or lend USDC to borrowers.</p><Link href="/borrow/" className="mk__btn mk__btn--buy">Borrow</Link></div>
      ) : (
        <div className="desk__table">
          <div className="desk__tr desk__tr--head pfl__tr"><span>Market</span><span>Tier</span><span>Loan</span><span>Health</span><span>Supplied</span><span /></div>
          {positions.map((p) => {
            const m = bySid.get(p.sid)
            return (
              <div key={`${p.sid}:${p.tier}`} className="desk__tr pfl__tr">
                <span className="desk__mk">{m ? <MarketArt m={m} size={24} /> : null}{m?.question ?? `Market #${p.sid}`}</span>
                <span>{TIER_LABEL[p.tier]}</span>
                <span className="num">{p.debt > 0n ? fmtUsd(p.debt) : p.pieces > 0 ? 'collateral only' : '–'}</span>
                <span className={`num tone--${tone(p.debt > 0n ? p.healthFactor : null)}`}>{p.debt > 0n ? fmtHf(p.healthFactor) : '–'}</span>
                <span className="num">{p.supplied > 0n ? fmtUsd(p.supplied) : '–'}</span>
                <span className="pos__acts">
                  {(p.debt > 0n || p.pieces > 0) && <Link href={borrowHref(p.sid, p.tier)} className="mk__btn mk__btn--sell">Loan</Link>}
                  {p.supplied > 0n && <Link href={lendHref(p.sid, p.tier)} className="mk__btn mk__btn--buy">Supply</Link>}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

// health and the wallet, beside the loans
function Side({ lowest, loans, debt, borrowable, supplied }: { lowest: bigint | null; loans: number; debt: bigint; borrowable: bigint; supplied: bigint }) {
  const balances = useWalletBalances()
  const actions = useActions()
  return (
    <div className="pf-col">
      {lowest === null ? (
        <section className="tr__panel pf-loan0">
          <h2 className="obx__boxtitle">Health</h2>
          <p className="tr__means">No loans. Against your worst worlds you could borrow</p>
          <b className="num">{fmtUsd(borrowable)}</b>
          <p className="pc__note">real USDC, in the tiers where you hold collateral</p>
          <Link href="/borrow/" className="mk__btn mk__btn--buy">Borrow</Link>
        </section>
      ) : (
        <section className="tr__panel mk__pos">
          <Gauge value={Number(lowest / 10n ** 16n) / 100} label="Lowest health" />
          <dl>
            <div><dt>Lowest health</dt><dd className={`num tone--${tone(lowest)}`}>{fmtHf(lowest)}</dd></div>
            <div><dt>Loans</dt><dd className="num">{loans}</dd></div>
            <div><dt>Borrowed</dt><dd className="num">{fmtUsd(debt)}</dd></div>
            <div><dt>Can still borrow</dt><dd className="num">{fmtUsd(borrowable)}</dd></div>
          </dl>
        </section>
      )}
      <section className="tr__panel mk__ticket">
        <h2 className="obx__boxtitle">Wallet</h2>
        <p className="tk__line"><span>wNEAR</span><b className="num">{balances ? fmtNear(balances.nearWad) : '–'}</b></p>
        <p className="tk__line"><span>USDC</span><b className="num">{balances ? fmt(balances.usdcWad) : '–'}</b></p>
        {balances && (balances.innerNearWad >= 10n ** 16n || balances.innerUsdcWad >= 10n ** 16n) && <p className="tk__line"><span>{BRAND.innerBalance}</span><b className="num">{fmtNear(balances.innerNearWad)} wNEAR · {fmt(balances.innerUsdcWad)} USDC</b></p>}
        <p className="tk__line"><span>Lent</span><b className="num">{fmtUsd(supplied)}</b></p>
        <div className="pf__walletacts">
          <div className="tk tk--buy"><Button onClick={() => void actions.faucet()} disabled={actions.busy !== null}>{actions.busy ?? 'Get test tokens'}</Button></div>
          <Link href="/lend/" className="mk__btn">Supply USDC</Link>
        </div>
      </section>
    </div>
  )
}

// what a market holds, in words: "1,000 NEAR in 4 worlds" or "NEAR in 1 world · USDC in 3"
function holdingText(h: MarketHoldings): string {
  const live = h.market.worlds.filter((w) => w.possible).map((w) => w.index)
  const nw = live.filter((w) => h.held.near[w] > 0n)
  const uw = live.filter((w) => h.held.near[w] === 0n && h.held.usdc[w] > 0n)
  if (nw.length === 0 && uw.length === 0) return h.supplied > 0n ? 'Lending only' : 'Nothing in its worlds'
  const same = nw.length === live.length && nw.every((w) => h.held.near[w] === h.held.near[nw[0]])
  if (same) return `${fmt(h.held.near[nw[0]], 0)} NEAR in ${nw.length} world${nw.length === 1 ? '' : 's'}`
  return [nw.length && `NEAR in ${nw.length} world${nw.length === 1 ? '' : 's'}`, uw.length && `USDC in ${uw.length}`].filter(Boolean).join(' · ')
}

function Positions({ held }: { held: MarketHoldings[] }) {
  const [open, setOpen] = useState<number | null>(null)
  if (held.length === 0) return <div className="desk__empty"><p><b>No positions yet.</b> Fund a market with NEAR or USDC to hold it in every world.</p><Link href={marketsHref} className="mk__btn mk__btn--buy">Browse markets</Link></div>
  return (
    <div className="desk__table">
      <div className="desk__tr desk__tr--head pfp__tr"><span>Market</span><span>Holding by world</span><span>On average</span><span>At worst</span><span>Health</span><span /></div>
      {held.map((h) => {
        const m = h.market
        const live = m.worlds.filter((w) => w.possible)
        return (
          <div key={m.sid} className="pos__wrap">
            <div className="desk__tr pfp__tr">
              <span className="desk__mk"><MarketArt m={m} size={30} /><span><b>{m.question}</b><small>{m.settled ? 'Settled' : `worst: ${h.worst !== undefined ? m.worlds[h.worst]?.outcome : '–'}`}</small></span></span>
              <span className="pos__hold">
                <span className="pos__cells" style={{ gridTemplateColumns: `repeat(${m.worldCount > 2 ? 2 : m.worldCount}, 1fr)` }} aria-hidden>
                  {m.worlds.map((w) => <i key={w.index} className={!w.possible ? 'is-dead' : h.held.near[w.index] > 0n ? 'is-near' : 'is-usdc'} />)}
                </span>
                {holdingText(h)}
              </span>
              <span className="num">{whole(h.average)}</span>
              <span className="num">{h.worst !== undefined ? whole(h.values[h.worst]) : '–'}</span>
              <span className={`num tone--${tone(h.lowestHealth)}`}>{h.lowestHealth === null ? 'No loan' : fmtHf(h.lowestHealth)}</span>
              <span className="pos__acts">
                {m.settled ? <Link href={resolveHref(m.sid)} className="mk__btn mk__btn--buy">Redeem</Link> : <Link href={marketHref(m.sid)} className="mk__btn mk__btn--buy">Manage</Link>}
                <button type="button" className={`mk__chev${open === m.sid ? ' is-open' : ''}`} aria-expanded={open === m.sid} aria-label="Details" onClick={() => setOpen(open === m.sid ? null : m.sid)}>▾</button>
              </span>
            </div>
            {open === m.sid && (
              <div className="pos__detail">
                {live.map((w) => (
                  <div key={w.index}>
                    <span className="desk__mk"><WorldIcon m={m} w={w.index} size={20} />{w.outcome}</span>
                    <b className="num">{[h.held.near[w.index] > 0n && `${fmtNear(h.held.near[w.index])} NEAR`, h.held.usdc[w.index] > 0n && `${fmt(h.held.usdc[w.index])} USDC`].filter(Boolean).join(' + ') || '–'}</b>
                    <small className="num">{h.posted.near[w.index] > 0n || h.posted.usdc[w.index] > 0n ? 'part of it posted as collateral' : 'in your wallet'}</small>
                  </div>
                ))}
                <div className="pos__links"><Link href={borrowHref(m.sid)} className="tr__link">Borrow against it</Link><Link href={ordersHref(m.sid, { w: live[0]?.index })} className="tr__link">Trade a world</Link></div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Orders({ orders, bySid, error }: { orders: ReturnType<typeof useOpenOrders>['orders']; bySid: ReadonlyMap<number, ChainMarket>; error: Error | null }) {
  const actions = useActions()
  if (!orders) return <p className="obx__empty">{error ? errorLine(error.message) : 'Reading your orders…'}</p>
  if (orders.length === 0) return <p className="obx__empty">No open orders. Post one from the order book.</p>
  return (
    <div className="desk__table">
      <div className="desk__tr desk__tr--head pfo__tr"><span>Market and world</span><span>Side</span><span>Price</span><span>Left</span><span /></div>
      {orders.map((o) => {
        const m = bySid.get(o.scenarioId)
        const w = m?.worlds.find((x) => x.mask === o.mask)
        return (
          <div key={String(o.id)} className="desk__tr pfo__tr">
            <span className="desk__mk">{m && w ? <WorldIcon m={m} w={w.index} size={22} /> : null}<Link href={ordersHref(o.scenarioId, { w: w?.index })} className="tr__link">{w?.outcome ?? `Worlds ${o.mask}`}</Link><small className="muted"> · {m?.question ?? `Market #${o.scenarioId}`}</small></span>
            <span className={o.side === 'bid' ? 'is-up' : 'is-down'}>{o.side === 'bid' ? 'Buy' : 'Sell'}</span>
            <span className="num">{fmtPrice(o.price)}</span>
            <span className="num">{fmtNear(o.remaining)} NEAR</span>
            <span><RowAction label="Cancel" busyLabel="Cancelling…" action="cancel_order" tone="sell" run={() => actions.cancelOrder(o.id, o.scenarioId)} /></span>
          </div>
        )
      })}
    </div>
  )
}
