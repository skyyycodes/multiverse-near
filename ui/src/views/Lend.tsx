'use client'
// Lend, in the trading screen's style, per market and tier (lending_tiers): a header with the tier's rates, the tier's
// rate curve with how much of it is lent out, who it is lent to, every market you can underwrite (Root LP) with its
// real pools, and where the risk sits with the insurance fund and bad debt. On the right: supply, withdraw and
// insurance, and your position.
import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { marketId, useActions, useMarkets, useWalletBalances, type ChainMarket } from '../chain/adapter'
import type { Account, AppConfig, LendingMarket, Tier } from '../chain/domain'
import { errorLine } from '../chain/errors'
import { accountLabel, fmt, fmtCompactUsd, fmtHf, fmtUsd, hfTone, inputText, parseAmount, pct } from '../chain/format'
import { useAppConfig } from '../chain/hooks/useData'
import { useLendingTiers } from '../chain/hooks/useLending'
import { useAtRisk } from '../chain/hooks/useLiquidation'
import { useScreenTier } from '../chain/hooks/useTier'
import { annualRate, badDebtNotice, badDebtOf, borrowRate, earnedOf, supplyBlocker, supplyRate, utilizationOf, WAD, withdrawBlocker, type SupplySeen } from '../chain/lending'
import { useTiersOf } from '../chain/lending-screens'
import { lendHref, liquidateHref, marketHref, marketsHref } from '../chain/links'
import { CONTRACT_ID } from '../chain/data/client'
import { fundInsurance } from '../chain/near/tx'
import { useWallet } from '../chain/near/wallet'
import { TIER_LABEL } from '../chain/tiers'
import { toTokenCeil } from '../chain/units'
import { chain } from '../config'
import { MarketArt, WorldIcon } from '../components/Grand'
import { PageLoading } from '../components/layout/PageLoading'
import { MarketStrip } from '../components/lending/MarketStrip'
import { RateCurve } from '../components/lending/RateCurve'
import { TierPick } from '../components/lending/TierPick'
import { Button } from '../components/ui'
import { ActionButton } from '../components/ui/ActionButton'

const TONE = { ok: 'safe', warn: 'watch', bad: 'risk' } as const

export default function Lend() {
  const params = useSearchParams()
  const router = useRouter()
  const { accountId } = useWallet()
  const { markets, error } = useMarkets()
  const lendable = (markets ?? []).filter((m) => m.lendable)
  const asked = marketId(params.get('id'))
  const sid = asked ?? lendable.find((m) => m.sid === chain.anchorMarket)?.sid ?? lendable[0]?.sid
  const extra = asked !== undefined && !lendable.some((m) => m.sid === asked) ? (markets ?? []).filter((m) => m.sid === asked) : []
  const strip = [...extra, ...lendable]
  const stripTiers = useTiersOf(strip.map((m) => m.sid), accountId)

  if (sid === undefined) {
    if (!markets) return error ? <Frame><div className="tr__panel desk__empty"><p className="pc__note">{errorLine(error.message)}</p></div></Frame> : <PageLoading />
    return (
      <Frame>
        <div className="tr__panel desk__empty"><p><b>No market lends yet.</b> Lending opens with borrowing, once every world of a market has a deep, priced pool.</p><Link className="mk__btn mk__btn--buy" href={marketsHref}>Browse markets</Link></div>
      </Frame>
    )
  }
  return <LendMarket key={sid} sid={sid} strip={strip} stripTiers={stripTiers.tiers} onPick={(s) => router.replace(lendHref(s), { scroll: false })} />
}

function Frame({ children, quote, stats }: { children: ReactNode; quote?: ReactNode; stats?: ReactNode }) {
  return (
    <div className="page tr desk">
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">Lend</h1>
          <p className="tr__means">Every borrower is limited by the world where their collateral is worth least, so each loan is covered in every world that can still happen. Lenders earn what borrowers pay.</p>
        </div>
        {quote}
        {stats && <dl className="tr__stats">{stats}</dl>}
      </header>
      {children}
    </div>
  )
}

function LendMarket({ sid, strip, stripTiers, onPick }: { sid: number; strip: ChainMarket[]; stripTiers: ReturnType<typeof useTiersOf>['tiers']; onPick: (sid: number) => void }) {
  const { accountId } = useWallet()
  const cfg = useAppConfig().data
  const tiers = useLendingTiers(sid, accountId)
  const { tier, pick } = useScreenTier(sid, tiers.data, 'lend', lendHref)
  const t = tiers.data?.find((x) => x.tier === tier)
  const lm = t?.market
  const v = t?.account ?? null
  const m = strip.find((x) => x.sid === sid)
  const notice = useBadDebtNotice(`${sid}:${tier}:${accountId ?? ''}`, lm, v)

  return (
    <Frame
      quote={<div className="tr__quote"><b className="num is-up">{lm ? pct(annualRate(lm.supplyRatePerSec), WAD, 2) : '–'}</b><span className="pc__note">lenders earn, a year · {TIER_LABEL[tier]}</span></div>}
      stats={
        <>
          <div><dt>Borrow rate</dt><dd className="num">{lm ? `${pct(annualRate(lm.borrowRatePerSec), WAD, 2)} variable` : '–'}</dd></div>
          <div><dt>Supplied</dt><dd className="num">{lm ? fmtCompactUsd(lm.totalSupply) : '–'}</dd></div>
          <div><dt>Lent out</dt><dd className="num">{lm ? fmtCompactUsd(lm.totalBorrow) : '–'}</dd></div>
          <div><dt>You supplied</dt><dd className="num">{v ? fmtUsd(v.supplied) : '–'}</dd></div>
        </>
      }
    >
      {strip.length > 0 && <MarketStrip markets={strip} sid={sid} mode="lend" tiers={stripTiers} onPick={onPick} />}
      <TierPick tiers={tiers.data} value={tier} onChange={pick} mode="lend" />
      {!lm || !cfg ? (
        <div className="tr__panel desk__empty" role="status"><p>{tiers.error ? errorLine(tiers.error.message) : 'Reading the tier…'}</p></div>
      ) : (
        <div className="mk__grid">
          <div className="mk__main">
            {notice && <p className="lend__alert" role="status">Lenders absorbed {fmtUsd(notice.socialized)} of bad debt; your supply went from {fmtUsd(notice.before)} to {fmtUsd(notice.after)}.</p>}
            {lm.frozen && <p className="lend__alert" role="status">The {TIER_LABEL[tier]} tier is frozen: no new deposits or loans. Withdrawing still works.</p>}

            <section className="tr__panel">
              <div className="desk__head">
                <h2 className="obx__boxtitle">What lenders earn</h2>
                <span className="pc__note">By how much is lent out · the {TIER_LABEL[tier]} tier’s rate model</span>
              </div>
              <RateCurve config={lm.config} utilization={lm.utilization} />
              <div className="odds__legend"><span><i style={{ background: 'rgba(233,227,216,0.55)' }} />Borrowers pay</span><span><i style={{ background: '#7dc9a5' }} />Lenders earn</span><span><i style={{ background: '#f0c05a' }} />Now</span></div>
              <div className="util">
                <div className="util__bar"><i style={{ width: `${Math.min(100, Number((lm.utilization * 1000n) / WAD) / 10)}%` }} /></div>
                <div className="util__legend">
                  <span><i className="is-lent" />Lent out <b className="num">{pct(lm.utilization, WAD, 1)}</b> · {fmtUsd(lm.totalBorrow)}</span>
                  <span><i />Free to withdraw <b className="num">{fmtUsd(lm.liquid)}</b></span>
                </div>
                <p className="pc__note">Lenders earn the borrow rate × the share lent out × what the insurance fund leaves ({pct(WAD - lm.config.reserveFactor, WAD, 0)}): {pct(annualRate(lm.borrowRatePerSec), WAD, 2)} × {pct(lm.utilization, WAD, 1)} × {pct(WAD - lm.config.reserveFactor, WAD, 0)} = {pct(annualRate(lm.supplyRatePerSec), WAD, 2)}.</p>
              </div>
            </section>

            <LentTo sid={sid} tier={tier} lm={lm} me={accountId} />

            <Underwrite markets={strip} />
          </div>

          <aside className="mk__side">
            <LendTicket cfg={cfg} sid={sid} tier={tier} lm={lm} v={v} />
            <section className="tr__panel">
              <h2 className="obx__boxtitle">Where the risk sits</h2>
              <dl className="lendrisk">
                <div><dt>Insurance fund</dt><dd>{fmtUsd(lm.insurance)}<small>{pct(lm.config.reserveFactor, WAD, 0)} of interest</small></dd></div>
                <div><dt>Bad debt</dt><dd className={lm.badDebtSocialized > 0n ? 'tone--watch' : undefined}>{fmtUsd(badDebtOf(lm))}<small>insurance {fmtUsd(lm.badDebtCovered)} · lenders {fmtUsd(lm.badDebtSocialized)}</small></dd></div>
              </dl>
              <ul className="risk">
                <li className="is-ok"><b>Any one future</b> The worst world still pays every loan back.</li>
                <li className="is-ok"><b>An event being answered</b> Removing worlds can’t make the worst one worse.</li>
                <li className="is-warn"><b>A very fast crash</b> Faster than liquidators can act, the insurance fund pays first; past it, the loss falls on lenders.</li>
                <li><b>Withdrawals</b> Come from USDC that isn’t lent out ({fmtUsd(lm.liquid)} now).</li>
              </ul>
              {m && <Link className="tr__link" href={marketHref(m.sid)}>Open the market</Link>}
            </section>
          </aside>
        </div>
      )}
    </Frame>
  )
}

/** The supply and bad-debt totals this screen first saw for a tier (in memory only), for `badDebtNotice`. */
function useBadDebtNotice(key: string, market: LendingMarket | undefined, v: Account | null) {
  const [first, setFirst] = useState<{ key: string; seen: SupplySeen } | undefined>(undefined)
  const now = market && v ? { socialized: market.badDebtSocialized, supplied: v.supplied } : undefined
  if (now && first?.key !== key) setFirst({ key, seen: now })
  if (!now || first?.key !== key) return undefined
  return badDebtNotice(first.seen, now)
}

/** Who the tier lends to: each borrower's debt as a share of what is supplied, then what is not lent out. */
function LentTo({ sid, tier, lm, me }: { sid: number; tier: Tier; lm: LendingMarket; me: string | null }) {
  const all = useAtRisk(sid, undefined)
  const rows = (all.data?.rows ?? []).filter((r) => r.tier === tier && r.debt > 0n).sort((a, b) => (a.debt < b.debt ? 1 : -1))
  const total = lm.totalSupply > 0n ? lm.totalSupply : 1n
  const share = (x: bigint) => `${Math.min(100, Number((x * 1000n) / total) / 10)}%`
  return (
    <section className="tr__panel">
      <div className="desk__head"><h2 className="obx__boxtitle">Where the pool is lent</h2><Link className="tr__link" href={liquidateHref(sid)}>Loans close to liquidation</Link></div>
      {!all.data ? <p className="obx__empty">{all.error ? errorLine(all.error.message) : 'Reading the borrowers…'}</p> : (
        <div className="alloc">
          {rows.map((r) => (
            <div key={r.accountId} className="alloc__row">
              <span className="desk__mk"><span className="alloc__sw alloc__sw--1" />{accountLabel(r.accountId)}{r.accountId === me ? <small>you</small> : null}<small className={`num tone--${TONE[hfTone(r.healthFactor)]}`}>health {fmtHf(r.healthFactor)}</small></span>
              <span className="alloc__bar"><i style={{ width: share(r.debt) }} /></span>
              <b className="num">{fmtUsd(r.debt)}</b>
              <small className="num">{pct(r.debt, total, 1)}</small>
            </div>
          ))}
          <div className="alloc__row">
            <span className="desk__mk"><span className="alloc__sw alloc__sw--2" />Not lent out</span>
            <span className="alloc__bar"><i className="is-idle" style={{ width: share(lm.liquid) }} /></span>
            <b className="num">{fmtUsd(lm.liquid)}</b>
            <small className="num">{pct(lm.liquid, total, 1)}</small>
          </div>
          {rows.length === 0 && <p className="obx__empty">No loans in this tier yet.</p>}
        </div>
      )}
    </section>
  )
}

/** Root liquidity: every market's real pools, to underwrite from the market's ticket. */
function Underwrite({ markets }: { markets: ChainMarket[] }) {
  if (markets.length === 0) return null
  return (
    <section className="tr__panel">
      <div className="desk__head">
        <h2 className="obx__boxtitle">Underwrite every world</h2>
        <span className="pc__note">Root liquidity: earn the swap fees</span>
      </div>
      <p className="tr__means">One deposit is split into every world of a market and added to each world’s pool at its own price. You take the other side of every conditional sale and earn the pools’ fees. When one world is left, its share comes back as real tokens.</p>
      <div className="lend__markets">
        {markets.map((m) => (
          <Link key={m.sid} href={marketHref(m.sid)} className="lend__card">
            <div className="lend__top"><MarketArt m={m} size={44} /><b>{m.question}</b></div>
            <div className="lend__worlds">
              {m.worlds.filter((w) => w.possible).map((w) => <span key={w.index}><WorldIcon m={m} w={w.index} size={18} />{w.outcome}<b className="num">{m.oddsKnown ? pct(w.odds, WAD, w.odds < WAD / 10n ? 1 : 0) : '–'}</b></span>)}
            </div>
            <dl>
              <div><dt>Pools</dt><dd className="num">{fmtCompactUsd(m.liquidityWad)}</dd></div>
              <div><dt>Thinnest world</dt><dd className="num">{fmtCompactUsd(m.card.minWorldDepth)}</dd></div>
              <div><dt>Worlds</dt><dd className="num">{m.worlds.filter((w) => w.possible).length}</dd></div>
            </dl>
            <span className="mk__btn mk__btn--buy">Add liquidity</span>
          </Link>
        ))}
      </div>
    </section>
  )
}

function LendTicket({ cfg, sid, tier, lm, v }: { cfg: AppConfig; sid: number; tier: Tier; lm: LendingMarket; v: Account | null }) {
  const { accountId, connect } = useWallet()
  const actions = useActions()
  const balances = useWalletBalances()
  const wallet = balances?.usdcWad ?? 0n
  const [mode, setMode] = useState<'supply' | 'withdraw' | 'insure'>('supply')
  const [input, setInput] = useState('')
  const name = TIER_LABEL[tier]
  const supplied = v?.supplied ?? 0n
  const all = input.trim().toLowerCase() === 'all'
  const amount = mode === 'withdraw' && all ? supplied : parseAmount(input, cfg.usdc.decimals)
  const canOut = supplied < lm.liquid ? supplied : lm.liquid
  const go = (x: typeof mode) => { setMode(x); setInput('') }
  // what the tier would pay lenders with this much more supplied: same borrowers, more cash, the tier's own rate model
  const aprAfter = amount && mode === 'supply' ? annualRate(supplyRate(borrowRate(utilizationOf(lm.totalBorrow, lm.totalSupply + amount), lm.config), lm.totalSupply + amount, lm.totalBorrow, lm.config.reserveFactor)) : undefined

  return (
    <section className="tr__panel mk__ticket">
      <div className="pc__tabs" role="group" aria-label="Supply, withdraw or insure">
        <button type="button" aria-pressed={mode === 'supply'} onClick={() => go('supply')}>Supply</button>
        <button type="button" aria-pressed={mode === 'withdraw'} onClick={() => go('withdraw')} disabled={supplied <= 0n}>Withdraw</button>
        <button type="button" aria-pressed={mode === 'insure'} onClick={() => go('insure')}>Insure</button>
      </div>
      {!accountId ? (
        <div className="tr__gate">
          <Button onClick={() => void connect()}>Connect NEAR wallet</Button>
          <p className="pc__note">Test tokens come from the wallet menu once you’re connected.</p>
        </div>
      ) : mode === 'withdraw' ? (
        <>
          <p className="ticket__help">Take your USDC back from the part of the {name} tier that isn’t lent out.</p>
          <label className="tk__field"><span>Amount</span>
            <input aria-label="USDC to withdraw" inputMode="decimal" placeholder="0" value={input} onChange={(e) => setInput(e.target.value.replace(/[^0-9.allAL]/g, ''))} />
            <em>USDC</em>
          </label>
          <div className="tk__pcts">
            {[0.25, 0.5, 0.75].map((k) => <button key={k} type="button" onClick={() => setInput(inputText((canOut * BigInt(k * 100)) / 100n, 2))}>{k * 100}%</button>)}
            <button type="button" onClick={() => setInput(supplied <= lm.liquid ? 'all' : inputText(canOut, 2))}>Max</button>
          </div>
          <p className="tk__line"><span>You supplied</span><b className="num">{fmtUsd(supplied)}</b></p>
          <p className="tk__line"><span>Free to withdraw now</span><b className="num">{fmtUsd(canOut)}</b></p>
          <div className="tk tk--sell">
            <ActionButton label={all ? 'Withdraw all' : amount ? `Withdraw ${fmt(amount)} USDC` : 'Withdraw'} busyLabel="Withdrawing…" blocker={withdrawBlocker(supplied, amount, lm.liquid)} action="withdraw_supply"
              run={() => actions.withdrawSupply(sid, tier, all ? null : amount!)} onDone={() => setInput('')} />
          </div>
        </>
      ) : mode === 'insure' ? (
        <>
          <p className="ticket__help">Add USDC to the {name} tier’s insurance fund. It covers bad debt before lenders lose anything. A donation: it can’t be taken back.</p>
          <label className="tk__field"><span>Amount</span>
            <input aria-label="USDC to donate" inputMode="decimal" placeholder="0" value={input} onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ''))} />
            <em>USDC</em>
          </label>
          <p className="tk__line"><span>Insurance fund now</span><b className="num">{fmtUsd(lm.insurance)}</b></p>
          <p className="tk__line"><span>In your wallet</span><b className="num">{fmtUsd(wallet)}</b></p>
          <div className="tk tk--buy">
            <ActionButton label={`Donate to ${name} insurance`} busyLabel="Donating…" blocker={!amount ? 'Enter an amount' : amount > wallet ? 'Not enough USDC' : undefined} action="fund_insurance"
              run={() => {
                const tokens = toTokenCeil(amount!, cfg.usdc.decimals)
                return actions.send(fundInsurance(cfg.usdc.tokenId, CONTRACT_ID, tokens, { scenarioId: sid, tier }), { kind: 'lend', title: 'Insurance', pending: 'Funding the insurance…', done: 'Added to the insurance fund', market: sid }, { needs: { contract: true }, expectUsed: tokens })
              }}
              onDone={() => setInput('')} />
          </div>
        </>
      ) : (
        <>
          <p className="ticket__help">Supply real USDC to the {name} tier. You earn on the part that’s lent out, and can withdraw what isn’t.</p>
          <label className="tk__field"><span>Amount</span>
            <input aria-label="USDC to supply" inputMode="decimal" placeholder="0" value={input} onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, ''))} />
            <em>USDC</em>
          </label>
          <div className="tk__pcts">
            {[0.25, 0.5, 0.75, 1].map((k) => <button key={k} type="button" onClick={() => setInput(inputText((wallet * BigInt(k * 100)) / 100n, 2))}>{k === 1 ? 'Max' : `${k * 100}%`}</button>)}
          </div>
          <p className="tk__line"><span>In your wallet</span><b className="num">{fmtUsd(wallet)}</b></p>
          <p className="tk__line"><span>Rate after</span><b className="num">{pct(aprAfter ?? annualRate(lm.supplyRatePerSec), WAD, 2)}</b></p>
          <p className="tk__line"><span>Earns about</span><b className="num">{fmtUsd(((amount ?? 0n) * (aprAfter ?? annualRate(lm.supplyRatePerSec))) / WAD)} a year</b></p>
          <div className="tk tk--buy">
            <ActionButton label={amount ? `Supply ${fmt(amount)} USDC` : 'Supply USDC'} busyLabel="Supplying…" blocker={supplyBlocker(lm, amount, wallet, name)} action="supply"
              run={() => actions.supply(sid, tier, amount!)} onDone={() => setInput('')} />
          </div>
        </>
      )}
      {v && supplied > 0n && (
        <div className="ov">
          <p className="ov__title">Your position · {name}</p>
          <p className="tk__line"><span>Supplied, with interest</span><b className="num">{fmtUsd(supplied)}</b></p>
          <p className="tk__line"><span>Earned</span><b className="num is-up">{fmtUsd(earnedOf(v))}</b></p>
          <p className="tk__line"><span>Share of the tier</span><b className="num">{pct(supplied, lm.totalSupply > 0n ? lm.totalSupply : 1n, 2)}</b></p>
        </div>
      )}
    </section>
  )
}
