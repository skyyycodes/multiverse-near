'use client'
// Borrow, built from what lending apps usually show (Aave, Morpho, Compound, Instadapp), in the trading screen's
// style and adapted to worlds. Every figure is the contract's (borrow_view, lending_tiers) for one market and tier:
//   header            your loans across markets: borrowed, lowest health; this tier's rate and cash
//   markets, tiers    markets that take loans, then Safe / Normal / Bold with each tier's limits and rate
//   loan position     worst world, loan, LTV against the liquidation LTV, health, and the borrow-limit meter
//   liquidation price one per world: the NEAR price there at which health reaches 1; dollar worlds never move
//   collateral        what is posted in this tier, and taking it back
//   collateral at risk a what-if: the worst world as NEAR falls, hedged vs. the same value in NEAR everywhere
//   sell and borrow   sell NEAR in the worlds you fear, keeping the result as collateral (one transaction)
//   ticket            borrow (amount or a target LTV), repay, add collateral, with before → after
import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { marketId, useActions, useLoanSummary, useMarket, useMarkets, useWalletBalances, type ChainMarket } from '../chain/adapter'
import type { Account, AppConfig, LendingMarket, LendingTier, Scenario, Tier, WorldStatus } from '../chain/domain'
import { errorLine, humanError } from '../chain/errors'
import { countdown, fmt, fmtAsset, fmtHf, fmtPrice, fmtUsd, hfTone, inputText, parseAmount, pct } from '../chain/format'
import { useNowSeconds } from '../chain/hooks/useClock'
import { useAppConfig, useBorrow } from '../chain/hooks/useData'
import { useLendingTiers, usePriceCheck, useReference, useReferenceConfig } from '../chain/hooks/useLending'
import { usePauseState } from '../chain/hooks/useOps'
import { useScreenTier } from '../chain/hooks/useTier'
import { annualRate, borrowBanner, borrowBlocker, borrowMath, cushion, liquidationOf, repayBlocker, WAD, type BorrowBanner } from '../chain/lending'
import { useTiersOf } from '../chain/lending-screens'
import { amountForLtv, bindingWorld, byWorld, liquidationPrices, ltvOf, worstAfterFall, type LiqPrice } from '../chain/lending-view'
import { borrowHref, liquidateHref, marketHref, marketsHref } from '../chain/links'
import { CONTRACT_ID } from '../chain/data/client'
import { GAS_CALL, GAS_MAX, requestReference } from '../chain/near/tx'
import { useWallet } from '../chain/near/wallet'
import { graceLeft } from '../chain/pause'
import { TIER_LABEL } from '../chain/tiers'
import { chain } from '../config'
import { Gauge, WorldIcon } from '../components/Grand'
import { PageLoading } from '../components/layout/PageLoading'
import { MarketStrip } from '../components/lending/MarketStrip'
import { RowAction } from '../components/lending/RowAction'
import { SellToCollateral } from '../components/lending/SellToCollateral'
import { TierPick } from '../components/lending/TierPick'
import { Button } from '../components/ui'
import { ActionButton } from '../components/ui/ActionButton'

const TONE = { ok: 'safe', warn: 'watch', bad: 'risk' } as const
const tone = (hf: bigint | null | undefined) => (hf === undefined ? 'safe' : TONE[hfTone(hf)])
// a health factor for the gauge, cut to two decimals as fmtHf shows it (never rounded up past the line)
const num = (x: bigint | null | undefined) => (x === null || x === undefined ? null : Number(x / 10n ** 16n) / 100)
const cut2 = (n: number) => (Math.floor(n * 100) / 100).toFixed(2)
type Tab = 'markets' | 'loans' | 'risk' | 'liquidation'

export default function Borrow() {
  const params = useSearchParams()
  const router = useRouter()
  const { accountId } = useWallet()
  const { markets, error } = useMarkets()
  const lendable = (markets ?? []).filter((m) => m.lendable)
  const asked = marketId(params.get('id'))
  const sid = asked ?? lendable.find((m) => m.sid === chain.anchorMarket)?.sid ?? lendable[0]?.sid
  // the markets that take loans, and the one in the URL even when it does not (its screen says why)
  const extra = asked !== undefined && !lendable.some((m) => m.sid === asked) ? (markets ?? []).filter((m) => m.sid === asked) : []
  const strip = [...extra, ...lendable]
  const loans = useLoanSummary()
  const stripTiers = useTiersOf(strip.map((m) => m.sid), accountId)

  if (sid === undefined) {
    if (!markets) return error ? <Shell><div className="tr__panel desk__empty"><p className="pc__note">{errorLine(error.message)}</p></div></Shell> : <PageLoading />
    return (
      <Shell>
        <div className="tr__panel desk__empty"><p><b>No market takes loans yet.</b> Borrowing opens once every world of a market has a deep, priced pool.</p><Link className="mk__btn mk__btn--buy" href={marketsHref}>Browse markets</Link></div>
      </Shell>
    )
  }
  return (
    <Shell loans={loans} stats={<TierStats key={sid} sid={sid} />}>
      {strip.length > 0 && <MarketStrip markets={strip} sid={sid} mode="borrow" tiers={stripTiers.tiers} onPick={(s) => router.replace(borrowHref(s), { scroll: false })} />}
      <BorrowMarket key={sid} sid={sid} lendable={lendable} stripTiers={stripTiers.tiers} />
    </Shell>
  )
}

function Shell({ children, loans, stats }: { children: ReactNode; loans?: ReturnType<typeof useLoanSummary>; stats?: ReactNode }) {
  return (
    <div className="page tr desk">
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">Borrow</h1>
          <p className="tr__means">Borrow real USDC against what you hold in every world. A lender counts only your worst world, so the loan is covered whichever future happens.</p>
        </div>
        <dl className="tr__stats">
          <div><dt>Borrowed, all markets</dt><dd className="num">{loans ? `$${loans.debt.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}` : '–'}</dd></div>
          <div><dt>Lowest health</dt><dd className={`num tone--${loans?.lowest == null ? 'safe' : loans.lowest >= 1.5 ? 'safe' : loans.lowest >= 1.1 ? 'watch' : 'risk'}`}>{loans?.lowest == null ? '∞' : cut2(loans.lowest)}</dd></div>
          {stats}
        </dl>
      </header>
      {children}
    </div>
  )
}

/** The picked tier's rate and cash in the header (reads the same cache as the screen). */
function TierStats({ sid }: { sid: number }) {
  const { accountId } = useWallet()
  const tiers = useLendingTiers(sid, accountId)
  const { tier } = useScreenTier(sid, tiers.data, 'borrow', borrowHref)
  const m = tiers.data?.find((t) => t.tier === tier)?.market
  return (
    <>
      <div><dt>Borrow rate · {TIER_LABEL[tier]}</dt><dd className="num">{m ? `${pct(annualRate(m.borrowRatePerSec), WAD, 2)} variable` : '–'}</dd></div>
      <div><dt>Free to lend</dt><dd className="num">{m ? fmtUsd(m.liquid) : '–'}</dd></div>
    </>
  )
}

function BorrowMarket({ sid, lendable, stripTiers }: { sid: number; lendable: ChainMarket[]; stripTiers: ReadonlyMap<number, LendingTier[]> }) {
  const { accountId } = useWallet()
  const cfg = useAppConfig().data
  const tiers = useLendingTiers(sid, accountId)
  const { tier, pick, ready } = useScreenTier(sid, tiers.data, 'borrow', borrowHref)
  const view = useBorrow(ready ? sid : undefined, accountId, tier)
  const { market: m, notFound } = useMarket(sid)
  const lm = tiers.data?.find((t) => t.tier === tier)?.market
  const v = view.data?.account
  const s = view.data?.scenario
  const err = view.error ?? tiers.error

  if (notFound) {
    return <div className="tr__panel desk__empty"><p><b>No market #{sid}.</b> It may be on another deployment.</p><Link className="mk__btn mk__btn--buy" href={marketsHref}>Browse markets</Link></div>
  }
  return (
    <>
      <TierPick tiers={tiers.data} value={tier} onChange={pick} mode="borrow" />
      {!v || !s || !lm || !m || !cfg ? (
        <div className="tr__panel desk__empty" role="status"><p>{err ? errorLine(err.message) : 'Reading your loan…'}</p></div>
      ) : (
        <Screen cfg={cfg} m={m} s={s} v={v} lm={lm} tier={tier} lendable={lendable} stripTiers={stripTiers} />
      )}
    </>
  )
}

type ScreenProps = { cfg: AppConfig; m: ChainMarket; s: Scenario; v: Account; lm: LendingMarket; tier: Tier; lendable: ChainMarket[]; stripTiers: ReadonlyMap<number, LendingTier[]> }

function Screen(p: ScreenProps) {
  const { m, s, v, lm, tier } = p
  const { accountId } = useWallet()
  const pause = usePauseState()
  const now = useNowSeconds()
  const grace = graceLeft(pause.data, now)
  const [mode, setMode] = useState<'borrow' | 'repay' | 'collateral'>('borrow')
  const [input, setInput] = useState('')
  const amount = parseAmount(input, p.cfg.usdc.decimals)
  const posted = byWorld(v.collateral, s.worldCount, s.possible)
  const math = borrowMath(v, s.possible, mode === 'borrow' ? amount : undefined, lm)
  const funded = v.collateral.length > 0
  const after = mode === 'borrow' ? v.debt + (amount ?? 0n) : mode === 'repay' ? (amount && amount < v.debt ? v.debt - amount : 0n) : v.debt
  const rows = liquidationPrices({ values: v.collateralValues, posted, possible: s.possible, debt: after, lltv: v.lltv })
  const bound = bindingWorld(rows)
  const banner = borrowBanner(v, grace)
  const frozen = lm.frozen || v.frozen
  const hfAfter = after > 0n && math.cMinLiq > 0n ? (math.cMinLiq * v.lltv) / after : null

  return (
    <div className="mk__grid">
      <div className="mk__main">
        <Banners cfg={p.cfg} v={v} s={s} banner={banner} grace={grace} tier={tier} frozen={frozen} />
        <PriceCheck sid={m.sid} v={v} />

        {/* ---------- loan position ---------- */}
        <section className="tr__panel">
          <div className="desk__head"><h2 className="obx__boxtitle">Your loan position · {TIER_LABEL[tier]}</h2><Link href={marketHref(m.sid)} className="tr__link">Open the market</Link></div>
          {!funded ? (
            <div className="desk__empty">
              <p><b>{accountId ? `No collateral in the ${TIER_LABEL[tier]} tier yet.` : 'Connect a wallet to see your loan.'}</b> Sell NEAR into collateral below, or post real USDC or wNEAR from the ticket. What you post becomes what you borrow against.</p>
              <Link className="mk__btn mk__btn--buy" href={marketHref(m.sid)}>Go to the market</Link>
            </div>
          ) : (
            <>
              <div className="lp__nums">
                <div><span>Collateral (worst world)</span><b className="num">{fmtUsd(math.cMinLiq)}</b><small>{v.worstWorld !== null ? m.worlds[v.worstWorld]?.outcome : '–'}</small></div>
                <div><span>Loan</span><b className="num">{fmtUsd(v.debt)}</b><small>{pct(annualRate(v.borrowRatePerSecond), WAD, 2)} a year, variable</small></div>
                <div><span>LTV / Liquidation LTV</span><b className="num">{v.debt > 0n && math.cMinLiq > 0n ? pct(v.debt, math.cMinLiq, 1) : '0.0%'} <em>/ {pct(v.lltv, WAD, 0)}</em></b><small>loan ÷ worst world</small></div>
                <div><span>Health</span><b className={`num tone--${tone(v.healthFactor)}`}>{fmtHf(v.healthFactor)}</b><small>{v.healthFactor === null ? 'no loan' : v.healthFactor < WAD ? 'can be liquidated' : `${pct(WAD - (WAD * WAD) / v.healthFactor, WAD, 0)} from liquidation`}</small></div>
              </div>
              <div className="meter" aria-label={`Borrow limit used: ${v.borrowLimit > 0n ? pct(v.debt, v.borrowLimit, 0) : '0%'}`}>
                <div className="meter__bar">
                  <i style={{ width: `${v.borrowLimit > 0n ? Math.min(100, Number((v.debt * 1000n) / v.borrowLimit) / 10) : 0}%` }} className={`tone-bg--${tone(v.borrowHealthFactor ?? v.healthFactor)}`} />
                  {mode === 'borrow' && amount && v.borrowLimit > 0n ? <i className="meter__add" style={{ left: `${Math.min(100, Number((v.debt * 1000n) / v.borrowLimit) / 10)}%`, width: `${Math.max(0, Math.min(100, Number((after * 1000n) / v.borrowLimit) / 10) - Math.min(100, Number((v.debt * 1000n) / v.borrowLimit) / 10))}%` }} /> : null}
                </div>
                <div className="meter__legend"><span>Borrow limit used <b className="num">{v.borrowLimit > 0n ? pct(v.debt, v.borrowLimit, 0) : '0%'}</b></span><span className="num">{fmtUsd(v.debt)} of {fmtUsd(v.borrowLimit)}</span><span>Liquidated at {pct(v.lltv, WAD, 0)} LTV</span></div>
              </div>
            </>
          )}
        </section>

        {/* ---------- liquidation price per world ---------- */}
        {funded && (
          <section className="tr__panel">
            <div className="desk__head"><h2 className="obx__boxtitle">Liquidation price by world</h2><span className="pc__note">{after > 0n ? `For a loan of ${fmtUsd(after)}` : 'Shows once you borrow'}</span></div>
            <p className="tr__means">The NEAR price inside each world at which health reaches 1. Worlds that hold dollars don’t move with NEAR, which is why hedging keeps a loan safe.</p>
            <div className="lq">
              <div className="lq__row lq__row--head"><span>World</span><span>Posted here</span><span>NEAR (30-min avg)</span><span>Liquidated at</span><span>Room</span></div>
              {rows.map(({ world: w, liq }) => (
                <div key={w} className={`lq__row${bound === w && after > 0n ? ' is-binding' : ''}`}>
                  <span className="desk__mk"><WorldIcon m={m} w={w} size={22} possible={s.possible} />{m.worlds[w]?.outcome}<StatusFlag st={v.worldStatus[w]} /></span>
                  <span className="num">{holdText(posted.near[w] ?? 0n, posted.usdc[w] ?? 0n)}</span>
                  <span className="num">{nowPrice(v.collateralValues[w] ?? 0n, posted.near[w] ?? 0n, posted.usdc[w] ?? 0n)}</span>
                  <span className="num"><LiqCell liq={liq} /></span>
                  <span><Room liq={liq} /></span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ---------- posted collateral ---------- */}
        {funded && <Posted m={m} v={v} tier={tier} />}

        {/* ---------- collateral at risk (a what-if) ---------- */}
        {funded && (
          <section className="tr__panel">
            <div className="desk__head"><h2 className="obx__boxtitle">Collateral at risk</h2><span className="pc__note">What if NEAR falls in every world · a what-if on your collateral</span></div>
            <RiskChart values={v.collateralValues} posted={posted} possible={s.possible} line={after > 0n ? (after * WAD) / v.lltv : 0n} />
            <div className="odds__legend"><span><i style={{ background: '#7dc9a5' }} />Your worst world, as you hold it</span><span><i style={{ background: 'rgba(233,227,216,0.45)' }} />Same value, NEAR in every world</span>{after > 0n && <span><i style={{ background: '#cf6b78' }} />Liquidation line</span>}</div>
          </section>
        )}

        {m.lendable && <SellToCollateral market={m} tier={tier} frozen={frozen} />}

        <MoreTabs cfg={p.cfg} m={m} lm={lm} tier={tier} lendable={p.lendable} stripTiers={p.stripTiers} />
      </div>

      {/* ---------- the ticket ---------- */}
      <aside className="mk__side">
        <section className="tr__panel mk__pos">
          <Gauge value={num(input && mode !== 'collateral' ? hfAfter : v.healthFactor)} label={input && mode !== 'collateral' ? 'Health after this' : 'Health'} />
          <dl>
            <div><dt>Can borrow</dt><dd className="num">{fmtUsd(math.room)}</dd></div>
            <div><dt>Loan</dt><dd className="num">{fmtUsd(v.debt)}</dd></div>
            <div><dt>LTV</dt><dd className="num">{v.debt > 0n && math.cMinLiq > 0n ? pct(v.debt, math.cMinLiq, 1) : '0.0%'}</dd></div>
            <div><dt>Max LTV</dt><dd className="num">{pct(v.borrowLtv, WAD, 0)}</dd></div>
          </dl>
        </section>
        <Ticket {...p} mode={mode} setMode={(x) => { setMode(x); setInput('') }} input={input} setInput={setInput} amount={amount} math={math} after={after} hfAfter={hfAfter} rows={rows} bound={bound} frozen={frozen} />
      </aside>
    </div>
  )
}

function holdText(near: bigint, usdc: bigint): string {
  if (near > 0n && usdc > 0n) return `${fmt(near, 0)} NEAR + ${fmt(usdc, 0)} USDC`
  if (near > 0n) return `${fmt(near, 0)} NEAR`
  if (usdc > 0n) return `${fmt(usdc, 0)} USDC`
  return '–'
}

/** The NEAR price collateral is valued at in a world (liquidation side), read back from the contract's own value. */
function nowPrice(value: bigint, near: bigint, usdc: bigint): string {
  if (near === 0n) return '–'
  return fmtPrice(((value > usdc ? value - usdc : 0n) * WAD) / near)
}

function LiqCell({ liq }: { liq: LiqPrice }) {
  if (liq.kind === 'at') return <>{fmtPrice(liq.price)}</>
  if (liq.kind === 'never') return <span className="tone--safe">Never</span>
  if (liq.kind === 'now') return <span className="tone--risk">Now</span>
  return <>–</>
}

function Room({ liq }: { liq: LiqPrice }) {
  if (liq.kind === 'never') return <small className="muted">holds dollars</small>
  if (liq.kind !== 'at') return <>–</>
  const d = Number(liq.drop) / 1e18
  return <span className="lq__room"><i style={{ width: `${Math.round(Math.max(0, Math.min(1, d)) * 100)}%` }} className={d < 0.15 ? 'is-risk' : d < 0.35 ? 'is-watch' : ''} /><b className="num">−{pct(liq.drop, WAD, 0)}</b></span>
}

const STATUS: Record<Exclude<WorldStatus, 'trusted'>, [string, string]> = {
  young: ['No price yet', 'The pool is younger than its averaging window; it counts zero for borrowing'],
  shallow: ['Thin pool', 'The pool is too thin at its average price to count for borrowing'],
  out_of_band: ['Moving fast', 'Its price moved more than 10% from the 30-minute average; borrowing values it at zero, liquidation at the average'],
  no_pool: ['No pool', 'No pool in this world yet'],
}

function StatusFlag({ st }: { st: WorldStatus | undefined }) {
  if (!st || st === 'trusted') return null
  const [label, title] = STATUS[st]
  return <em className="mk__flag" title={title}>{label}</em>
}

function RiskChart({ values, posted, possible, line }: { values: readonly bigint[]; posted: ReturnType<typeof byWorld>; possible: number; line: bigint }) {
  const W = 1100, H = 260, L = 56, R = 12, T = 16, B = 30
  const drops = Array.from({ length: 19 }, (_, i) => i * 500) // 0% to 90%, in basis points
  const pts = drops.map((d) => worstAfterFall(values, posted, possible, d))
  const mine = pts.map((x) => Number(x.held) / 1e18)
  const plain = pts.map((x) => Number(x.allNear) / 1e18)
  const ln = Number(line) / 1e18
  const top = Math.max(1, ...mine, ...plain, ln) * 1.08
  const x = (d: number) => L + (d / 9000) * (W - L - R)
  const y = (val: number) => T + (1 - val / top) * (H - T - B)
  const path = (vs: number[]) => vs.map((val, i) => `${i ? 'L' : 'M'}${x(drops[i]).toFixed(1)},${y(val).toFixed(1)}`).join(' ')
  const cross = ln > 0 ? drops.find((_, i) => mine[i] < ln) : undefined
  const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
  return (
    <svg className="risk__chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="What if NEAR falls: your worst world as you hold it, and the same value all in NEAR, against the liquidation line">
      {[0, 0.25, 0.5, 0.75, 1].map((f) => <g key={f}><line x1={L} x2={W - R} y1={y(top * f)} y2={y(top * f)} stroke="rgba(255,255,255,0.05)" /><text x={L - 6} y={y(top * f) + 3} textAnchor="end" fontSize="10" fill="#8e96a8">{money(top * f)}</text></g>)}
      {[0, 3000, 6000, 9000].map((d) => <text key={d} x={x(d)} y={H - 10} textAnchor="middle" fontSize="10" fill="#8e96a8">{d === 0 ? 'now' : `−${d / 100}%`}</text>)}
      {ln > 0 && <><line x1={L} x2={W - R} y1={y(ln)} y2={y(ln)} stroke="#cf6b78" strokeDasharray="5 4" /><text x={W - R} y={y(ln) - 5} textAnchor="end" fontSize="10" fill="#cf6b78">liquidation line {money(ln)}</text></>}
      <path d={path(plain)} fill="none" stroke="rgba(233,227,216,0.45)" strokeWidth="2" strokeDasharray="3 3" />
      <path d={path(mine)} fill="none" stroke="#7dc9a5" strokeWidth="2.5" />
      {cross !== undefined && <circle cx={x(cross)} cy={y(ln)} r="4" fill="#cf6b78" />}
    </svg>
  )
}

/** What is posted in this tier, and taking it back: real USDC and wNEAR to the wallet, a world's piece to your holdings. */
function Posted({ m, v, tier }: { m: ChainMarket; v: Account; tier: Tier }) {
  const actions = useActions()
  const owes = v.debt > 0n
  return (
    <section className="tr__panel">
      <div className="desk__head"><h2 className="obx__boxtitle">Posted collateral · {TIER_LABEL[tier]}</h2><span className="pc__note">{v.collateral.length} piece{v.collateral.length === 1 ? '' : 's'}</span></div>
      <div className="desk__table">
        <div className="desk__tr desk__tr--head lc__tr"><span>Piece</span><span>Amount</span><span>Pays in</span><span /></div>
        {v.collateral.map((c) => (
          <div key={c.tokenId} className="desk__tr lc__tr">
            <span className="desk__mk">{c.isReal ? `Real ${c.asset === 'wnear' ? 'wNEAR' : 'USDC'}` : c.label}</span>
            <span className="num">{fmtAsset(c.asset, c.amount)} {c.asset === 'wnear' ? 'wNEAR' : 'USDC'}</span>
            <span>{c.isReal ? 'Every world' : worldsOf(m, c.mask)}</span>
            <span>
              <RowAction
                label="Take back"
                busyLabel="Taking back…"
                tone="sell"
                action={owes ? 'withdraw_collateral_debt' : 'withdraw_collateral'}
                gas={GAS_CALL}
                run={() => actions.withdrawCollateral(m.sid, tier, { tokenId: c.isReal ? c.asset : c.tokenId, isReal: c.isReal, asset: c.asset }, c.amount)}
              />
            </span>
          </div>
        ))}
      </div>
      <p className="pc__note lc__note">{owes ? 'With a loan open, only what keeps your health above the borrow limit can come out; repay first to take everything back.' : 'Real tokens go back to your wallet; a world’s piece to your holdings in that world.'}</p>
    </section>
  )
}

function worldsOf(m: ChainMarket, mask: number): string {
  const ws = m.worlds.filter((w) => (mask & w.mask) !== 0)
  return ws.length === m.worlds.length ? 'Every world' : ws.map((w) => w.outcome).join(', ')
}

function Banners({ cfg, v, s, banner, grace, tier, frozen }: { cfg: AppConfig; v: Account; s: Scenario; banner: BorrowBanner | undefined; grace: bigint; tier: Tier; frozen: boolean }) {
  const liq = liquidationOf(v, s)
  const l = cfg.lending
  return (
    <>
      {frozen && <p className="lend__alert" role="status">The {TIER_LABEL[tier]} tier is frozen: no new loans. Repaying, adding collateral and closing still work.</p>}
      {banner === 'liquidatable' && (
        <p className="lend__alert lend__alert--risk" role="alert">
          Health is below 1. Anyone may repay up to half the loan (all of it under {fmtUsd(l.smallLoan)} or below health {fmt(l.fullLiquidationHf, 2)}) and take the same share of every piece, worth the repayment plus {pct(v.liquidationBonus, WAD, 1)}. Repay or add collateral to lift it above 1.
        </p>
      )}
      {banner === 'grace' && <p className="lend__alert" role="status">Liquidations resume in {countdown(grace)}. Repay or add collateral now.</p>}
      {banner === 'paused' && <p className="lend__alert" role="status">Liquidations are paused for maintenance.</p>}
      {banner === 'paused_halted' && <p className="lend__alert" role="status">Health is below 1, but liquidations wait while a result is in its dispute window: a result can only raise it.</p>}
      {banner === 'paused_reference' && <p className="lend__alert" role="status">Liquidation waits: this market’s prices are too far from the outside NEAR/USD price.</p>}
      {banner === 'paused_no_price' && <p className="lend__alert" role="status">Health is below 1 because {liq.unpricedLabel ?? 'a world'} has no valid price yet. Liquidations wait for one.</p>}
      {banner === 'write_off' && <p className="lend__alert lend__alert--risk" role="alert">Your collateral is worth nothing in a possible world: what is left of this loan can be written off by anyone.</p>}
    </>
  )
}

const REFRESHABLE = /^Reference(Missing|Stale)/

/** Why new borrowing waits for the outside NEAR/USD check, and the refresh when OutLayer can fetch it. */
function PriceCheck({ sid, v }: { sid: number; v: Account }) {
  const actions = useActions()
  const check = usePriceCheck(v.borrowBlock ? sid : undefined)
  const refreshable = Boolean(v.borrowBlock && REFRESHABLE.test(v.borrowBlock))
  const ref = useReference(refreshable)
  const cfg = useReferenceConfig(refreshable)
  if (!v.borrowBlock) return null
  const guest = cfg.data?.guest
  return (
    <div className="lend__alert lend__alert--row" role="status">
      <span>{humanError(check.data?.borrowBlock ?? v.borrowBlock)}</span>
      {ref.data?.pending ? <span className="pc__note">Fetching NEAR/USD in OutLayer…</span> : refreshable && guest && (
        <RowAction label={`Refresh the price check (${fmt(guest.deposit / 10n ** 6n, 2)} NEAR)`} busyLabel="Asking OutLayer…" action="request_reference" gas={GAS_MAX} deposit={guest.deposit}
          run={() => actions.send(requestReference(CONTRACT_ID, guest.deposit), { kind: 'other', title: 'Price check', pending: 'Asking OutLayer for NEAR/USD…', done: 'Price check requested; it lands in about 15 s', market: sid })} />
      )}
    </div>
  )
}

type TicketProps = ScreenProps & {
  mode: 'borrow' | 'repay' | 'collateral'
  setMode: (m: 'borrow' | 'repay' | 'collateral') => void
  input: string
  setInput: (s: string) => void
  amount: bigint | undefined
  math: ReturnType<typeof borrowMath>
  after: bigint
  hfAfter: bigint | null
  rows: { world: number; liq: LiqPrice }[]
  bound: number | undefined
  frozen: boolean
}

function Ticket(p: TicketProps) {
  const { accountId, connect } = useWallet()
  const { v, m } = p
  return (
    <section className="tr__panel mk__ticket">
      <div className="pc__tabs" role="group" aria-label="Borrow, repay or add collateral">
        <button type="button" aria-pressed={p.mode === 'borrow'} onClick={() => p.setMode('borrow')}>Borrow</button>
        <button type="button" aria-pressed={p.mode === 'repay'} onClick={() => p.setMode('repay')} disabled={v.debt <= 0n}>Repay</button>
        <button type="button" aria-pressed={p.mode === 'collateral'} onClick={() => p.setMode('collateral')}>Add collateral</button>
      </div>
      {!accountId ? (
        <div className="tr__gate">
          <Button onClick={() => void connect()}>Connect NEAR wallet</Button>
          <p className="pc__note">Test tokens come from the wallet menu once you’re connected.</p>
        </div>
      ) : p.mode === 'collateral' ? (
        <AddCollateral cfg={p.cfg} sid={m.sid} tier={p.tier} v={v} />
      ) : p.mode === 'repay' ? (
        <Repay {...p} />
      ) : (
        <BorrowForm {...p} />
      )}
    </section>
  )
}

function BorrowForm(p: TicketProps) {
  const actions = useActions()
  const { v, s, lm, tier, math, amount, after, m } = p
  const name = TIER_LABEL[tier]
  const blocker = borrowBlocker({ halted: s.halted, account: v, market: lm, amount, tierLabel: name })
  const ltvNow = ltvOf(v.debt, math.cMinLiq) ?? 0n
  const maxLtv = math.cMinLiq > 0n ? (v.borrowLimit * WAD) / math.cMinLiq : 0n
  const bps = (x: bigint) => Number((x * 10_000n) / WAD)
  const ltvAfter = ltvOf(after, math.cMinLiq) ?? 0n
  const setLtv = (b: number) => {
    const a = amountForLtv(math.cMinLiq, v.debt, b)
    p.setInput(a > 0n ? inputText(a > math.room ? math.room : a, 2) : '')
  }
  const b = p.bound !== undefined ? p.rows.find((r) => r.world === p.bound) : undefined
  const apr = math.aprAfter ?? annualRate(v.borrowRatePerSecond)
  return (
    <>
      <label className="tk__field"><span>Amount</span>
        <input aria-label="USDC to borrow" inputMode="decimal" placeholder="0" value={p.input} onChange={(e) => p.setInput(e.target.value.replace(/[^0-9.]/g, ''))} />
        <em>USDC</em>
      </label>
      {maxLtv > ltvNow && (
        <div className="ltv">
          <div className="ltv__top"><span>Target LTV</span><b className="num">{pct(ltvAfter, WAD, 1)}</b></div>
          <input type="range" min={bps(ltvNow)} max={bps(maxLtv)} step={25} value={Math.min(bps(maxLtv), Math.max(bps(ltvNow), bps(ltvAfter)))} onChange={(e) => setLtv(Number(e.target.value))} aria-label="Target loan to value" />
          <div className="ltv__marks"><span>Now {pct(ltvNow, WAD, 0)}</span><span>Limit {pct(maxLtv, WAD, 0)}</span><span>Liquidated at {pct(v.lltv, WAD, 0)}</span></div>
        </div>
      )}
      <div className="tk__pcts">
        {[0.25, 0.5, 0.75, 1].map((k) => <button key={k} type="button" onClick={() => p.setInput(inputText((math.room * BigInt(k * 100)) / 100n, 2))}>{k === 1 ? 'Max' : `${k * 100}%`}</button>)}
      </div>
      <div className="ov">
        <p className="ov__title">Transaction overview</p>
        <p className="tk__line"><span>Health</span><b className="num"><span className={`tone--${tone(v.healthFactor)}`}>{fmtHf(v.healthFactor)}</span> → <span className={`tone--${tone(math.hfAfter ?? v.healthFactor)}`}>{math.hfAfter !== undefined ? fmtHf(math.hfAfter) : fmtHf(v.healthFactor)}</span></b></p>
        <p className="tk__line"><span>LTV</span><b className="num">{pct(ltvNow, WAD, 1)} → {pct(ltvAfter, WAD, 1)}</b></p>
        <p className="tk__line"><span>Borrow limit used</span><b className="num">{math.limitUsedAfter !== undefined ? pct(math.limitUsedAfter, WAD, 1) : v.borrowLimit > 0n ? pct(v.debt, v.borrowLimit, 1) : '–'}</b></p>
        <p className="tk__line"><span>First liquidation</span><b className="num">{b?.liq.kind === 'at' ? `${m.worlds[b.world]?.outcome} at ${fmtPrice(b.liq.price)}` : after > 0n ? (b?.liq.kind === 'now' ? 'Now' : 'No NEAR world at risk') : '–'}</b></p>
        <p className="tk__line"><span>Rate after</span><b className="num">{pct(apr, WAD, 2)} a year</b></p>
        <p className="tk__line"><span>Interest</span><b className="num">about {fmtUsd((after * apr) / WAD)} a year</b></p>
      </div>
      {math.hfAfter !== undefined && math.hfAfter >= WAD && math.hfAfter < (WAD * 3n) / 2n && (
        <p className="ov__warn">Borrowing this much brings health to {fmtHf(math.hfAfter)}. A {pct(WAD - (WAD * WAD) / math.hfAfter, WAD, 0)} fall in your worst world would let anyone liquidate it.</p>
      )}
      <div className="tk tk--buy">
        <ActionButton label={amount ? `Borrow ${fmt(amount)} USDC` : 'Borrow'} busyLabel="Borrowing…" blocker={blocker} action="borrow" gas={GAS_CALL}
          run={() => actions.borrow(m.sid, tier, amount!)} onDone={() => p.setInput('')} />
      </div>
      <p className="pc__note num">{fmtUsd(lm.liquid)} free to lend in {name} · minimum loan {fmtUsd(v.minLoan)}</p>
    </>
  )
}

function Repay(p: TicketProps) {
  const actions = useActions()
  const balances = useWalletBalances()
  const wallet = balances?.usdcWad ?? 0n
  const { v, m, tier } = p
  const all = p.input.trim().toLowerCase() === 'all'
  const amount = all ? v.debt : p.amount
  const blocker = repayBlocker(v.debt, amount, all, wallet, v.minLoan)
  const left = all || (amount !== undefined && amount >= v.debt) ? 0n : v.debt - (amount ?? 0n)
  const cap = wallet < v.debt ? wallet : v.debt
  return (
    <>
      <p className="ticket__help">Pay back USDC. “All” repays the loan with its interest to the second; what you send above it comes back.</p>
      <label className="tk__field"><span>Amount</span>
        <input aria-label="USDC to repay" inputMode="decimal" placeholder="0" value={p.input} onChange={(e) => p.setInput(e.target.value.replace(/[^0-9.allAL]/g, ''))} />
        <em>USDC</em>
      </label>
      <div className="tk__pcts">
        {[0.25, 0.5, 0.75].map((k) => <button key={k} type="button" onClick={() => p.setInput(inputText((cap * BigInt(k * 100)) / 100n, 2))}>{k * 100}%</button>)}
        <button type="button" onClick={() => p.setInput('all')}>All</button>
      </div>
      <p className="tk__line"><span>Loan</span><b className="num">{fmtUsd(v.debt)}</b></p>
      <p className="tk__line"><span>Left after</span><b className="num">{fmtUsd(left)}</b></p>
      <p className="tk__line"><span>Health after</span><b className={`num tone--${tone(left > 0n && p.math.cMinLiq > 0n ? (p.math.cMinLiq * v.lltv) / left : null)}`}>{left > 0n && p.math.cMinLiq > 0n ? fmtHf((p.math.cMinLiq * v.lltv) / left) : '∞'}</b></p>
      <p className="tk__line"><span>In your wallet</span><b className="num">{fmtUsd(wallet)}</b></p>
      <div className="tk tk--sell">
        <ActionButton label={all ? 'Repay all' : amount ? `Repay ${fmt(amount)} USDC` : 'Repay'} busyLabel="Repaying…" blocker={blocker} action="repay"
          run={() => actions.repay(m.sid, tier, all ? 'all' : amount!, v.debt, wallet)} onDone={() => p.setInput('')} />
      </div>
    </>
  )
}

function AddCollateral({ cfg, sid, tier, v }: { cfg: AppConfig; sid: number; tier: Tier; v: Account }) {
  const actions = useActions()
  const balances = useWalletBalances()
  const [asset, setAsset] = useState<'usdc' | 'wnear'>('usdc')
  const [input, setInput] = useState('')
  const token = asset === 'usdc' ? cfg.usdc : cfg.wnear
  const wallet = (asset === 'usdc' ? balances?.usdcWad : balances?.nearWad) ?? 0n
  const amount = parseAmount(input, token.decimals)
  const max = cfg.lending.maxCollateralPieces
  const full = v.collateral.length >= max && !v.collateral.some((c) => c.isReal && c.asset === asset)
  const blocker = full ? `${max} pieces is the most one loan can hold` : !amount ? 'Enter an amount' : amount > wallet ? `Not enough ${token.symbol}` : undefined
  return (
    <>
      <div className="pc__tabs" role="group" aria-label="Asset">
        <button type="button" aria-pressed={asset === 'usdc'} onClick={() => { setAsset('usdc'); setInput('') }}>USDC</button>
        <button type="button" aria-pressed={asset === 'wnear'} onClick={() => { setAsset('wnear'); setInput('') }}>wNEAR</button>
      </div>
      <p className="ticket__help">Real USDC counts the same in every world; real wNEAR at each world’s price. Either lifts your worst world.</p>
      <label className="tk__field"><span>Amount</span>
        <input aria-label={`${token.symbol} to post`} inputMode="decimal" placeholder="0" value={input} onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ''))} />
        <em>{token.symbol}</em>
      </label>
      <div className="tk__pcts">
        {[0.25, 0.5, 0.75, 1].map((k) => <button key={k} type="button" onClick={() => setInput(inputText((wallet * BigInt(k * 100)) / 100n, 2))}>{k === 1 ? 'Max' : `${k * 100}%`}</button>)}
      </div>
      <p className="tk__line"><span>In your wallet</span><b className="num">{fmtAsset(asset, wallet)} {token.symbol}</b></p>
      <div className="tk tk--buy">
        <ActionButton label={`Post to ${TIER_LABEL[tier]}`} busyLabel="Posting…" blocker={blocker} action="add_collateral"
          run={() => actions.depositCollateral(sid, tier, asset, amount!)} onDone={() => setInput('')} />
      </div>
    </>
  )
}

/** Markets to borrow against, your loans everywhere, the tier's risk parameters and how liquidation works. */
function MoreTabs({ cfg, m, lm, tier, lendable, stripTiers }: { cfg: AppConfig; m: ChainMarket; lm: LendingMarket; tier: Tier; lendable: ChainMarket[]; stripTiers: ReadonlyMap<number, LendingTier[]> }) {
  const [tab, setTab] = useState<Tab>('markets')
  const c = lm.config
  const l = cfg.lending
  const loans = lendable.flatMap((x) => (stripTiers.get(x.sid) ?? []).filter((t) => t.account && t.account.debt > 0n).map((t) => ({ m: x, t })))
  return (
    <section className="tr__panel">
      <div className="pc__tabs mk__lowertabs" role="group" aria-label="More">
        {([['markets', 'Markets to borrow against'], ['loans', `Your loans (${loans.length})`], ['risk', 'Risk parameters'], ['liquidation', 'Liquidations']] as const).map(([k, label]) => (
          <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'markets' ? (
        lendable.length === 0 ? <p className="obx__empty">No market takes loans yet.</p> : (
          <div className="desk__table">
            <div className="desk__tr desk__tr--head bw__tr"><span>Market</span><span>Your loan</span><span>Lowest health</span><span>Rate · {TIER_LABEL[tier]}</span><span>Free to lend</span><span /></div>
            {lendable.map((x) => {
              const ts = stripTiers.get(x.sid)
              const t = ts?.find((y) => y.tier === tier)
              const debt = (ts ?? []).reduce((sum, y) => sum + (y.account?.debt ?? 0n), 0n)
              const hfs = (ts ?? []).filter((y) => y.account && y.account.debt > 0n && y.account.healthFactor !== null).map((y) => y.account!.healthFactor as bigint)
              const low = hfs.length ? hfs.reduce((a, h) => (h < a ? h : a)) : null
              return (
                <div key={x.sid} className="desk__tr bw__tr">
                  <span className="desk__mk">{x.question}</span>
                  <span className="num">{ts ? fmtUsd(debt) : '–'}</span>
                  <span className={`num tone--${tone(low)}`}>{ts ? fmtHf(low) : '–'}</span>
                  <span className="num">{t ? pct(annualRate(t.market.borrowRatePerSec), WAD, 2) : '–'}</span>
                  <span className="num">{t ? fmtUsd(t.market.liquid) : '–'}</span>
                  <span><Link className="mk__btn mk__btn--buy" href={borrowHref(x.sid, tier)}>{x.sid === m.sid ? 'Here' : 'Borrow'}</Link></span>
                </div>
              )
            })}
          </div>
        )
      ) : tab === 'loans' ? (
        loans.length === 0 ? <p className="obx__empty">No loans yet.</p> : (
          <div className="desk__table">
            <div className="desk__tr desk__tr--head bw__tr"><span>Market</span><span>Tier</span><span>Loan</span><span>LTV</span><span>Health</span><span /></div>
            {loans.map(({ m: x, t }) => {
              const a = t.account!
              const cMin = a.collateralValues.reduce<bigint | undefined>((lo, val, w) => ((x.possible >> w) & 1 && (lo === undefined || val < lo) ? val : lo), undefined) ?? 0n
              return (
                <div key={`${x.sid}:${t.tier}`} className="desk__tr bw__tr">
                  <span className="desk__mk">{x.question}</span>
                  <span>{TIER_LABEL[t.tier]}</span>
                  <span className="num">{fmtUsd(a.debt)}</span>
                  <span className="num">{cMin > 0n ? pct(a.debt, cMin, 1) : '–'}</span>
                  <span className={`num tone--${tone(a.healthFactor)}`}>{fmtHf(a.healthFactor)}</span>
                  <span><Link className="mk__btn mk__btn--sell" href={borrowHref(x.sid, t.tier)}>Manage</Link></span>
                </div>
              )
            })}
          </div>
        )
      ) : tab === 'risk' ? (
        <dl className="params">
          <div><dt>Borrow limit and liquidation · {TIER_LABEL[tier]}</dt><dd>Borrow up to {pct(c.borrowLtv, WAD, 0)} of your worst world. Below health 1 (a loan over {pct(c.lltv, WAD, 0)} of it) anyone can liquidate; that is a {pct(cushion(c), WAD, 1)} fall from the limit.</dd></div>
          <div><dt>Price source</dt><dd>Each world’s own NEAR/USDC pool, read as a 30-minute average, so one trade can’t fake it. Borrowing takes the lower of the current and average price.</dd></div>
          <div><dt>Liquidation bonus</dt><dd>{pct(c.liquidationBonus, WAD, 1)}, paid from the borrower’s collateral to whoever liquidates.</dd></div>
          <div><dt>Close factor</dt><dd>Up to {pct(l.closeFactor, WAD, 0)} of the loan per liquidation; all of it under {fmtUsd(l.smallLoan)} or below health {fmt(l.fullLiquidationHf, 2)}.</dd></div>
          <div><dt>Interest</dt><dd>Variable: {pct(annualRate(c.rateBase), WAD, 2)} at zero use, rising to {pct(annualRate(c.rateBase + c.rateSlope1), WAD, 2)} at {pct(c.rateKink, WAD, 0)} lent out and faster after. Now {pct(annualRate(lm.borrowRatePerSec), WAD, 2)}.</dd></div>
          <div><dt>Minimum loan</dt><dd>{fmtUsd(l.minLoan)}. A partial repayment may not leave less than that.</dd></div>
          <div><dt>Insurance</dt><dd>{pct(c.reserveFactor, WAD, 0)} of the interest goes to the tier’s insurance fund ({fmtUsd(lm.insurance)} now). It pays bad debt before lenders lose anything.</dd></div>
          <div><dt>Pauses</dt><dd>Liquidation waits while a result is in its dispute window, while a world has no valid price, or when prices stray from the outside NEAR/USD price.</dd></div>
        </dl>
      ) : (
        <>
          <ol className="steps">
            <li><span className="steps__n">1</span><b>Health falls below 1</b><p>Your worst world × {pct(c.lltv, WAD, 0)} is now less than the loan.</p></li>
            <li><span className="steps__n">2</span><b>Anyone repays part</b><p>A liquidator repays up to {pct(l.closeFactor, WAD, 0)} of the loan and takes that much collateral plus {pct(c.liquidationBonus, WAD, 1)}.</p></li>
            <li><span className="steps__n">3</span><b>Loan shrinks</b><p>Health is usually back above 1. If prices keep falling, it can happen again.</p></li>
          </ol>
          <Link className="tr__link" href={liquidateHref(m.sid)}>See the loans close to liquidation</Link>
        </>
      )}
    </section>
  )
}
