// The market page, in the trading screen's style: a header with the market's artwork and stats, the map of its worlds
// (each one's chance and NEAR price, laid out as the market's grid), one row per world (pick the worlds you fear, or
// open one's order book), and tabs for the rules, resolution and the live checks. On the right: your loan in this
// market, the ticket (fund, hedge, borrow, lend, liquidity) and related markets. Everything is read from the contract;
// the contract keeps no history of odds, trades or holders, so the page shows none.
import { useState } from 'react'
import Link from 'next/link'
import { toNum, useActions, useMarkets, usePosition, type ChainMarket, type Position } from '../chain/adapter'
import { chanceText, compactUsd, durationText, impliedCheck, leadWorld, presetsOf, priceText, relatedOf, resolutionState, shapeName, sharedEvents } from '../chain/board'
import { humanError } from '../chain/errors'
import { fmt, fmtPct, fmtPrice, relTime } from '../chain/format'
import { useNowSeconds } from '../chain/hooks/useClock'
import { useAppConfig, useTrade } from '../chain/hooks/useData'
import { useLendingTiers, usePriceCheck } from '../chain/hooks/useLending'
import { useRelated } from '../chain/hooks/useMarkets'
import { marketsHref, ordersHref, proposalHref, proposeHref, resolveHref, shareUrl } from '../chain/links'
import { isWebSource, letter, shortDate } from '../chain/market'
import { useWallet } from '../chain/near/wallet'
import { cellBook, type Order } from '../chain/orders'
import { walletRedeemable } from '../chain/settlement'
import { positionTier, TIER_LABEL } from '../chain/tiers'
import type { PriceCheck } from '../chain/domain'
import { toggleWatch, useWatch } from '../lib/watch'
import { Gauge, MarketArt, WORLD_COLORS, WorldIcon, WorldTable } from './Grand'
import { BorrowPane, FundPane, HedgePane, LendPane, LiquidityPane } from './ticket'
import { ActionButton } from './ui/ActionButton'

type Tab = 'fund' | 'hedge' | 'borrow' | 'lend' | 'pool'
type Lower = 'rules' | 'resolution' | 'checks'
const usd = (n: number) => `$${Math.floor(n + 1e-9).toLocaleString('en-US')}` // a limit or a loan rounds down, never up
const amount = (wad: bigint) => fmt(wad, 2)

export function ScenarioMarket({ market: m }: { market: ChainMarket }) {
  const { accountId } = useWallet()
  const cfg = useAppConfig().data
  const watch = useWatch()
  const now = Number(useNowSeconds())
  const { position } = usePosition(m.sid)
  const [open, setOpen] = useState<number | null>(null) // the world row whose order book is expanded
  const [copied, setCopied] = useState(false)
  const [mask, setMask] = useState(0) // the worlds picked to hedge, contract bit order
  const [tab, setTab] = useState<Tab>('fund')
  const [lower, setLower] = useState<Lower>(m.settled ? 'resolution' : 'rules')
  const pick = mask & m.possible
  const pc = usePriceCheck(m.sid).data
  const answered = m.events.filter((e) => e.finalized).length
  const deciding = m.events.some((e) => e.proposalOpen)

  const tabs: { id: Tab; label: string }[] = [
    { id: 'fund', label: 'Fund' },
    { id: 'hedge', label: 'Hedge' },
    ...(m.lendable ? ([{ id: 'borrow', label: 'Borrow' }, { id: 'lend', label: 'Lend' }] as const) : []),
    ...(cfg?.rootLp ? ([{ id: 'pool', label: 'Liquidity' }] as const) : []),
  ]
  const shown = tabs.some((t) => t.id === tab) ? tab : 'fund'
  const toggle = (w: number) => { setMask((x) => x ^ (1 << w)); setTab('hedge') }
  const share = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl(m.sid))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* the clipboard refused: nothing to do */ }
  }

  return (
    <div className="page tr mk">
      {/* ---------- header ---------- */}
      <header className="tr__pair mk__head">
        <MarketArt m={m} size={64} />
        <div className="tr__id">
          <p className="mk__crumb">
            <Link href={marketsHref}>Markets</Link> <span aria-hidden>/</span> {m.categories.join(' · ')}
            <span className="mk__tag">{m.kind}</span>
            <span className="mk__tag">{m.statusLabel}</span>
            {!m.settled && <span className="mk__tag">{m.lendable ? 'Borrowing open' : 'Trading only'}</span>}
            <span className="num">#{m.sid}</span>
          </p>
          <h1 className="mk__title">{m.question}</h1>
          <p className="tr__means">
            {m.origin === 'pledged' && m.proposalId !== null
              ? <>Opened from pledges (<Link href={proposalHref(m.proposalId)}>proposal #{m.proposalId}</Link>){m.createdAtSec > 0 ? ` on ${shortDate(m.createdAtSec)}` : ''}.</>
              : 'Opened by the owner.'}
            {' '}{answered} of {m.events.length} {m.events.length === 1 ? 'question' : 'questions'} answered.
            {deciding && ' Trading pauses while a proposed answer waits out its dispute window.'}
            {!m.listed && ' Not listed on the board.'}
          </p>
        </div>
        <dl className="tr__stats">
          <div><dt>World pools</dt><dd className="num">{compactUsd(m.liquidity)}</dd></div>
          {!m.settled && <div title="NEAR's price these odds imply: each world's chance times NEAR's price there"><dt>Implied NEAR</dt><dd className="num">{priceText(m.impliedSpot)}</dd></div>}
          {pc?.reference && <div title={`The outside NEAR/USD median the contract checks this market against, ${relTime(-pc.reference.ageSec)}`}><dt>NEAR/USD</dt><dd className="num">{priceText(toNum(pc.reference.price))}</dd></div>}
          <div><dt>{m.settled ? 'Status' : 'Resolves'}</dt><dd className="num">{m.resolves}</dd></div>
        </dl>
        <div className="mk__headacts">
          <button type="button" className={`star${watch.includes(m.id) ? ' is-on' : ''}`} aria-pressed={watch.includes(m.id)} aria-label="Watchlist" title={watch.includes(m.id) ? 'On your watchlist' : 'Add to watchlist'} onClick={() => toggleWatch(m.id)}>{watch.includes(m.id) ? '★' : '☆'}</button>
          <button type="button" className="mk__btn" onClick={() => void share()}>{copied ? 'Link copied' : 'Share'}</button>
        </div>
      </header>

      <div className="mk__grid">
        <div className="mk__main">
          {/* ---------- the map of worlds (a two-world market's rows already say it all) ---------- */}
          {m.worldCount > 2 && (
            <section className="tr__panel mk__map" aria-label="Map of worlds">
              <WorldTable m={m} />
            </section>
          )}

          {/* ---------- one row per world ---------- */}
          <section className="tr__panel mk__worlds" aria-label="Worlds">
            <div className="mk__rowhead">
              <span>World</span><span>Chance</span><span>NEAR there</span><span>You hold</span><span />
            </div>
            {m.worlds.map((w) => {
              const dead = !w.possible
              const picked = (pick & w.mask) !== 0
              const h = accountId ? position?.worlds[w.index] : undefined
              const worst = Boolean(position && position.debt > 0 && position.worstWorld === w.index && !m.settled)
              return (
                <div key={w.index} className={`mk__row${dead ? ' is-dead' : ''}${picked ? ' is-picked' : ''}`}>
                  <span className="mk__who">
                    <WorldIcon m={m} w={w.index} possible={m.possible} />
                    <span>
                      <b>{w.outcome}{worst && <em className="mk__flag">worst world</em>}{m.settled && m.winner === w.index && <em className="mk__flag">happened</em>}</b>
                      <small>World {w.index} · {w.label}</small>
                    </span>
                  </span>
                  <span className="mk__chance"><b className="num">{dead ? '0%' : chanceText(w.chance)}</b></span>
                  <span className="num">{dead ? '–' : priceText(w.nearPrice)}</span>
                  <Holding h={h} dead={dead} />
                  <span className="mk__acts">
                    {dead ? <span className="muted">Closed</span> : m.settled ? <span className="muted">Redeems 1:1</span> : (
                      <>
                        <button type="button" className={`mk__btn mk__btn--sell${picked ? ' is-on' : ''}`} aria-pressed={picked} onClick={() => toggle(w.index)} title="Pick this world to sell your NEAR there for dollars">
                          {picked ? 'Hedging' : 'Hedge'}
                        </button>
                        <Link className="mk__btn mk__btn--buy" href={ordersHref(m.sid, { w: w.index })}>Trade</Link>
                        <button type="button" className={`mk__chev${open === w.index ? ' is-open' : ''}`} aria-expanded={open === w.index} aria-label={`Order book for ${w.outcome}`} onClick={() => setOpen(open === w.index ? null : w.index)}>▾</button>
                      </>
                    )}
                  </span>
                  {open === w.index && !dead && !m.settled && <WorldBook m={m} w={w.index} />}
                </div>
              )
            })}
            {!m.settled && (
              <div className="mk__shape">
                <span>Picked: <b>{shapeName(m, pick)}</b></span>
                <div className="pc__tabs" role="group" aria-label="Pick every world where">
                  {presetsOf(m).map((p) => <button key={p.mask} type="button" aria-pressed={pick === p.mask} onClick={() => { setMask(p.mask); setTab('hedge') }}>{p.label}</button>)}
                  <button type="button" onClick={() => setMask(0)}>Clear</button>
                </div>
              </div>
            )}
          </section>

          {/* ---------- rules, resolution, checks ---------- */}
          <section className="tr__panel" id="mk-more">
            <div className="pc__tabs mk__lowertabs" role="group" aria-label="More about this market">
              {([['rules', 'Rules'], ['resolution', 'Resolution'], ['checks', 'Checks']] as const).map(([id, label]) => (
                <button key={id} type="button" aria-pressed={lower === id} onClick={() => setLower(id)}>{label}</button>
              ))}
            </div>
            {lower === 'rules' ? <Rules m={m} /> : lower === 'resolution' ? <Resolution m={m} now={now} windowSec={cfg?.disputeWindowSec} position={position} /> : <Checks m={m} position={position} pc={pc} />}
          </section>
        </div>

        <aside className="mk__side">
          {/* ---------- your loan here (lending markets, with a wallet) ---------- */}
          {m.lendable && accountId && !m.settled && <Loan m={m} account={accountId} />}

          {/* ---------- the ticket ---------- */}
          {m.settled ? (
            <section className="tr__panel mk__ticket">
              <p className="ticket__help">This market is settled: <b>{m.winner === undefined ? 'one world' : m.worlds[m.winner].outcome}</b> happened. Its pieces redeem 1:1 for the real token; the other worlds closed at zero.</p>
              <button type="button" className="btn btn--primary" onClick={() => { setLower('resolution'); document.getElementById('mk-more')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>See what you can redeem</button>
            </section>
          ) : (
            <section className="tr__panel mk__ticket">
              <div className="pc__tabs" role="group" aria-label="Action">
                {tabs.map((t) => <button key={t.id} type="button" aria-pressed={shown === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
              </div>
              {shown === 'fund' ? <FundPane market={m} mask={pick} />
                : shown === 'hedge' ? <HedgePane market={m} mask={pick} />
                : shown === 'borrow' ? <BorrowPane market={m} mask={pick} />
                : shown === 'lend' ? <LendPane market={m} mask={pick} />
                : <LiquidityPane market={m} mask={pick} />}
              {!m.lendable && <p className="pc__note">Trading only: borrowing opens once every world’s pool is priced and deep enough.</p>}
            </section>
          )}

          <Related m={m} />
        </aside>
      </div>
    </div>
  )
}

// What the account holds in one world: wallet pieces plus collateral posted in any tier.
function Holding({ h, dead }: { h: Position['worlds'][number] | undefined; dead: boolean }) {
  if (dead) return <span className="mk__hold"><span className="muted">{h && (h.nearWad > 0n || h.usdcWad > 0n) ? 'Worth zero' : '–'}</span></span>
  if (!h || (h.nearWad === 0n && h.usdcWad === 0n)) return <span className="mk__hold"><span className="muted">–</span></span>
  const near = h.nearWad > 0n
  return (
    <span className="mk__hold">
      <b className={`num ${near ? '' : 'is-usdc'}`}>{near ? `${amount(h.nearWad)} NEAR` : `${amount(h.usdcWad)} USDC`}</b>
      {near && h.usdcWad > 0n ? <small className="num">+ {amount(h.usdcWad)} USDC</small> : h.value > 0 ? <small className="num">counts {usd(h.value)}</small> : null}
    </span>
  )
}

// A world row, expanded: its best resting orders either side, from the contract's order book.
function WorldBook({ m, w }: { m: ChainMarket; w: number }) {
  const { accountId } = useWallet()
  const trade = useTrade(m.sid, accountId)
  const nowSec = useNowSeconds()
  const d = trade.data
  const world = m.worlds[w]
  const book = d ? cellBook(d.orders, d.scenario, world.mask, nowSec) : undefined
  const asks = book ? book.asks.slice(0, 4).reverse() : []
  const bids = book ? book.bids.slice(0, 4) : []
  const top = [...asks, ...bids].reduce((t, o) => (o.remaining > t ? o.remaining : t), 1n)
  const spread = book?.asks[0] && book.bids[0] ? book.asks[0].price - book.bids[0].price : null
  const lvl = (o: Order, side: 'ask' | 'bid') => (
    <span key={String(o.id)} className={`mk__lvl is-${side}`}>
      <i style={{ width: `${Number((o.remaining * 1000n) / top) / 10}%` }} />
      <b className="num">{fmtPrice(o.price)}</b>
      <span className="num">{amount(o.remaining)} NEAR</span>
      <small>{o.maker === accountId ? 'you' : o.maker.split('.')[0]}</small>
    </span>
  )
  return (
    <div className="mk__book">
      <div className="mk__bookcol">
        <p className="pc__note">Order book · {world.outcome}</p>
        {!d ? <span className="pc__note">{trade.error ? humanError(trade.error.message) : 'Reading the order book…'}</span> : (
          <>
            {asks.map((o) => lvl(o, 'ask'))}
            <span className="mk__lvlmid num">pool {priceText(world.nearPrice)} · spread {spread === null ? '–' : fmtPrice(spread)}</span>
            {bids.map((o) => lvl(o, 'bid'))}
            {asks.length + bids.length === 0 && <span className="pc__note">No resting orders in this world.</span>}
          </>
        )}
      </div>
      <div className="mk__bookacts">
        <p className="pc__note">Trade NEAR that pays only if {world.outcome.toLowerCase()} happens.</p>
        <Link className="mk__btn mk__btn--buy" href={ordersHref(m.sid, { w, buy: true })}>Buy NEAR here</Link>
        <Link className="mk__btn mk__btn--sell" href={ordersHref(m.sid, { w })}>Sell NEAR here</Link>
      </div>
    </div>
  )
}

// Each event's exact rule: outcomes, how it resolves, its public source, deadline and category.
function Rules({ m }: { m: ChainMarket }) {
  const seed = m.card.seed
  return (
    <div className="mk__rules">
      {m.events.map((ev, k) => (
        <article key={ev.id} className="mk__rule">
          {ev.image ? <img src={ev.image} alt="" width={40} height={40} className="art" /> : <span className="art art--blank" style={{ width: 40, height: 40 }} aria-hidden>{letter(k)}</span>}
          <div>
            <h3>{ev.question} <span className="muted">· {ev.outcomes.join(' or ')}</span></h3>
            <p>{ev.rule}</p>
            <dl>
              <div><dt>Deadline</dt><dd>{ev.deadline}</dd></div>
              {ev.sources.map((s) => <div key={s}><dt>Source</dt><dd>{isWebSource(s) ? <a href={s.trim()} target="_blank" rel="noreferrer">{s.trim()}</a> : s}</dd></div>)}
              <div><dt>Category</dt><dd>{ev.categoryName}</dd></div>
              <div><dt>Event</dt><dd className="num">#{ev.id}</dd></div>
            </dl>
          </div>
        </article>
      ))}
      {m.origin === 'pledged' && m.proposalId !== null && (
        <p className="tr__means">
          Opened from pledges (<Link href={proposalHref(m.proposalId)}>proposal #{m.proposalId}</Link>){m.createdAtSec > 0 ? ` on ${shortDate(m.createdAtSec)}` : ''}. The pledgers’ seed liquidity stays in the pools{seed?.unlockAtSec ? ` until ${shortDate(seed.unlockAtSec)}, then it can be withdrawn` : ''}.
        </p>
      )}
    </div>
  )
}

// Where each answer stands, and what a settled market pays the account.
function Resolution({ m, now, windowSec, position }: { m: ChainMarket; now: number; windowSec?: number; position?: Position }) {
  return (
    <>
      <p className="tr__means">
        The reporter, or OutLayer reading public data inside a secure enclave, proposes each answer with its evidence.
        {windowSec ? ` For ${durationText(windowSec)}` : ' For a short window'} the owner can dispute it and this market’s trading pauses; after that anyone can finalize it.
        An answer only removes worlds, so a healthy loan can only get safer.
      </p>
      <ul className="sc__events">
        {m.events.map((ev) => {
          const st = resolutionState(ev, now)
          return (
            <li key={ev.id}>
              <div><b>{ev.question}</b><small>{ev.sources[0] ? `Source: ${ev.sources[0]}` : `Deadline ${ev.deadline}`}</small></div>
              <span className={`rs__state rs__state--${st.tone}`}>{st.tone === 'final' ? `Final: ${st.text}` : st.text}</span>
            </li>
          )
        })}
      </ul>
      {m.settled && <Redeem m={m} position={position} />}
      <div className="mk__demo"><Link className="tr__link" href={resolveHref(m.sid)}>Open Resolve</Link></div>
    </>
  )
}

// A settled market: the surviving world's pieces in the wallet, each redeemed 1:1 for the real token.
function Redeem({ m, position }: { m: ChainMarket; position?: Position }) {
  const { accountId } = useWallet()
  const actions = useActions()
  const rows = accountId && position ? walletRedeemable(position.scenario) : []
  return (
    <div className="mk__redeem">
      {!accountId ? <p className="obx__empty">Connect a wallet to see what you can redeem here.</p>
        : !position ? <p className="obx__empty">Reading what you hold…</p>
        : rows.length === 0 ? <p className="obx__empty">Nothing of yours to redeem here.{position.debt > 0 ? ' Your loan closes in Resolve.' : ''}</p>
        : rows.map((r) => (
          <div key={r.tokenId} className="tk__line mk__redeemrow">
            <span>{r.label} <b className="num">{amount(r.amount)}</b></span>
            <ActionButton label={`Redeem ${amount(r.amount)} ${r.symbol}`} action="redeem" variant="ghost" run={() => actions.redeem(m.sid, r.asset, r.mask, r.amount)} />
          </div>
        ))}
    </div>
  )
}

// The contract's own checks, live: every world balances, the odds-weighted price, and the outside NEAR/USD check.
function Checks({ m, position, pc }: { m: ChainMarket; position?: Position; pc?: PriceCheck }) {
  const live = position?.scenario.worlds.filter((w) => w.possible) ?? []
  const backed = live.length > 0 && live.every((w) => w.backed)
  const implied = impliedCheck(m)
  const ref = pc?.reference
  const gap = pc?.ratio != null ? Number(pc.ratio - 10n ** 18n) / 1e16 : null
  return (
    <>
      <div className="sc__checks" aria-live="polite">
        {position && <span className={backed ? '' : 'is-bad'}><i aria-hidden>{backed ? '✓' : '✕'}</i>Every world balances: the contract’s reserves back every piece in all {live.length} possible world{live.length === 1 ? '' : 's'}</span>}
        {!m.settled && m.oddsKnown && (
          <span className={implied.ok ? '' : 'is-bad'}><i aria-hidden>{implied.ok ? '✓' : '✕'}</i>Implied NEAR {priceText(implied.contract)} = {m.worlds.filter((w) => w.possible).map((w) => `${chanceText(w.chance)} × ${priceText(w.nearPrice)}`).join(' + ')}</span>
        )}
      </div>
      {pc && !m.settled && (
        <div className="mk__pc">
          <h3 className="obx__boxtitle">Outside price check</h3>
          {!pc.config.reference ? (
            <p className="tr__means">This market doesn’t compare its prices with an outside NEAR/USD feed; its lending relies on its own pools’ 30-minute averages.</p>
          ) : (
            <>
              <p className="tr__means">Lending compares the NEAR price this market implies (its pools’ 30-minute averages) with an outside NEAR/USD median. A gap over the limit pauses new borrowing; it never blocks repaying or leaving.</p>
              <p className="tk__line"><span>Outside NEAR/USD</span><b className="num">{ref ? `${fmtPrice(ref.price)} · ${ref.source === 'outlayer' ? `${ref.sourcesUsed} sources` : 'the reporter'} · ${relTime(-ref.ageSec)}` : 'none yet'}</b></p>
              <p className="tk__line"><span>Implied by this market (30-min average)</span><b className="num">{pc.impliedTwapSpot !== null ? fmtPrice(pc.impliedTwapSpot) : 'not known yet'}</b></p>
              <p className="tk__line"><span>Gap, and the limit</span><b className="num">{gap === null ? '–' : `${gap >= 0 ? '+' : '−'}${Math.abs(gap).toFixed(2)}%`} of {fmtPct(pc.config.maxDeviation, 0)}</b></p>
              <p className="tk__line"><span>Liquidation haircut, at most</span><b className="num">{fmtPct(pc.config.maxHaircut, 0)}</b></p>
              <p className="tk__line"><span>New borrowing</span><b className={pc.borrowBlock ? 'tone--watch' : 'tone--safe'}>{pc.borrowBlock ? `paused: ${humanError(pc.borrowBlock)}` : 'open'}</b></p>
            </>
          )}
        </div>
      )}
    </>
  )
}

// The account's loan in this market: the tier it borrows in (else Normal), its health and what it can still borrow.
function Loan({ m, account }: { m: ChainMarket; account: string }) {
  const tiers = useLendingTiers(m.sid, account).data
  const tier = positionTier(tiers, 'borrow') ?? 'normal'
  const { position: p } = usePosition(m.sid, tier)
  if (!p) return null
  return (
    <section className="tr__panel mk__pos" aria-label="Your loan here">
      <Gauge value={p.debt > 0 ? p.health : null} label="Health" />
      <dl>
        <div><dt>Tier</dt><dd>{TIER_LABEL[tier]}</dd></div>
        <div><dt>Worst world</dt><dd>{p.debt > 0 && p.worstWorld !== null ? m.worlds[p.worstWorld]?.outcome : '–'}</dd></div>
        <div><dt>Loan</dt><dd className="num">{usd(p.debt)}</dd></div>
        <div><dt>Can borrow</dt><dd className="num">{usd(p.maxBorrow)}</dd></div>
      </dl>
    </section>
  )
}

// Markets that share an event with this one (`related_markets`), else other open markets, and a way to combine.
function Related({ m }: { m: ChainMarket }) {
  const { markets } = useMarkets()
  const ids = useRelated(m.sid, m.listed).data?.markets.map((r) => r.scenarioId) ?? []
  const related = relatedOf(ids, markets ?? [], m.sid)
  const others = related.length ? [] : (markets ?? []).filter((x) => x.sid !== m.sid && !x.settled).sort((a, b) => b.liquidity - a.liquidity).slice(0, 3)
  const list = related.length ? related : others
  const canCombine = !m.settled && m.events.length < 3 && m.events.every((e) => !e.finalized)
  if (!markets || (list.length === 0 && !canCombine)) return null
  return (
    <section className="tr__panel mk__related" aria-label="Related markets">
      <h2 className="obx__boxtitle">{related.length ? 'Related markets' : 'More markets'}</h2>
      {list.map((x) => {
        const lead = leadWorld(x)
        const shared = sharedEvents(m, x)
        return (
          <Link key={x.sid} href={x.href} className="mk__rel">
            <MarketArt m={x} size={36} />
            <span><b>{x.question}</b><small>{shared.length ? `Shares ${shared.length === 1 ? 'one question' : `${shared.length} questions`} · ${x.kind}` : x.category}</small></span>
            {lead && !x.settled ? (
              <span className="mk__relp"><b className="num" style={{ color: WORLD_COLORS[lead.index % WORLD_COLORS.length] }}>{chanceText(lead.chance)}</b><small>{lead.outcome}</small></span>
            ) : <span className="mk__relp"><small>Settled</small></span>}
          </Link>
        )
      })}
      {canCombine && <Link className="tr__link mk__combine" href={proposeHref({ kind: 'market', events: m.events.map((e) => e.id) })}>Combine with another question</Link>}
    </section>
  )
}
