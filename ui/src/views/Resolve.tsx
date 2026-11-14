'use client'
// Resolve, in the trading screen's style: every listed market with its events, each with artwork, rule, deadline and
// source and a line of where it stands (open, proposed, its dispute window, final), all read from the chain. The
// reporter (or OutLayer, for FRED questions) proposes a result; the owner can dispute it inside the window; then
// anyone finalizes. Once an event of a market has resolved, close and redeem pays out what you hold there.
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Chip, SmallTx, TicketTx } from '../components/governance/Gov'
import { EventRow } from '../components/governance/EventRow'
import { MarketArt } from '../components/Grand'
import { marketId, useActions, useIsOwner, useMarkets, useMyMarkets, useWalletBalances, type ChainEvent, type ChainMarket } from '../chain/adapter'
import { CONTRACT_ID } from '../chain/data/client'
import type { Account, Scenario, Tier } from '../chain/domain'
import { errorLine } from '../chain/errors'
import { fmt, fmtAsset, fmtNear, fmtUsd, utcDate } from '../chain/format'
import { disputeBlocker, finalizeBlocker, proposalAnnounce, resolutionHistory, resolveStats, windowWords } from '../chain/governance'
import { useChainClock } from '../chain/hooks/useClock'
import { useAppConfig, useResolve } from '../chain/hooks/useData'
import { useLendingTiers } from '../chain/hooks/useLending'
import { useOutLayerConfig, useOutLayerDates } from '../chain/hooks/useProposal'
import { marketsHref } from '../chain/links'
import { closeAfterResolution, closeWithDebt, GAS_MAX, requestResolution } from '../chain/near/tx'
import { useWallet } from '../chain/near/wallet'
import { nearText } from '../chain/proposals'
import { fateText, planClose, walletRedeemable } from '../chain/settlement'
import { TIER_LABEL } from '../chain/tiers'
import { toTokenCeil } from '../chain/units'

type Filter = 'all' | 'open' | 'settled'

export default function Resolve({ id }: { id?: string }) {
  const router = useRouter()
  const focus = marketId(id)
  const cfg = useAppConfig().data
  const owner = useIsOwner()
  const { markets, isLoading, error } = useMarkets()
  const mine = useMyMarkets()
  const [filter, setFilter] = useState<Filter>('all')
  const all = useMemo(() => markets ?? [], [markets])
  const events = useMemo(() => all.flatMap((m) => m.events.map((e) => e.state)), [all])
  const stats = resolveStats(events)
  const history = resolutionHistory(events)

  // chain time, from the resolve view of a market whose result waits in its window (polled every 2 s while it does)
  const pending = all.find((m) => m.events.some((e) => e.proposalOpen))
  const pendingView = useResolve(pending?.sid, null)
  const clock = useChainClock(pendingView.data?.nowSec, pendingView.dataUpdatedAt)

  const shown = all.filter((m) => (focus !== undefined ? m.sid === focus : filter === 'all' || (filter === 'settled' ? m.settled : !m.settled)))

  return (
    <div className="page tr desk gv">
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">Resolve</h1>
          <p className="tr__means">When an event is decided, the worlds it rules out close and their pieces become worthless. The world left redeems 1:1 for real NEAR and USDC.</p>
        </div>
        <dl className="tr__stats">
          <div><dt>Events decided</dt><dd className="num">{markets ? `${stats.final} of ${stats.events}` : '–'}</dd></div>
          <div><dt>In a dispute window</dt><dd className="num">{markets ? stats.proposed : '–'}</dd></div>
          <div><dt>Dispute window</dt><dd className="num">{cfg ? windowWords(cfg.disputeWindowSec) : '–'}</dd></div>
        </dl>
      </header>

      <div className="mk__grid">
        <div className="mk__main">
          {focus !== undefined ? (
            <div className="pc__tabs desk__filter" role="group" aria-label="Show">
              <button type="button" aria-pressed>Market #{focus}</button>
              <button type="button" aria-pressed={false} onClick={() => router.push('/resolve/')}>All markets</button>
            </div>
          ) : (
            <div className="pc__tabs desk__filter" role="group" aria-label="Show">
              {(['all', 'open', 'settled'] as const).map((f) => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? 'All markets' : f === 'open' ? 'Open' : 'Settled'}</button>)}
            </div>
          )}

          {isLoading && !markets ? (
            <div className="tr__panel"><p className="obx__empty" role="status">Reading the markets and their events…</p></div>
          ) : error && !markets ? (
            <div className="tr__panel"><p className="pc__note">{errorLine(error.message)}</p></div>
          ) : shown.length === 0 ? (
            <div className="tr__panel desk__empty">
              <p><b>{focus !== undefined ? `No market #${focus}.` : 'Nothing here.'}</b> {focus !== undefined ? 'It is not listed on this contract.' : 'Markets show up here once they exist.'}</p>
              <Link href={marketsHref} className="mk__btn mk__btn--buy">See the markets</Link>
            </div>
          ) : (
            shown.map((m, i) => <MarketResolve key={m.sid} m={m} now={clock.now} blockTime={clock.blockTime} owner={owner} holds={mine.includes(m.sid)} seen={new Set(shown.slice(0, i).flatMap((x) => x.events.map((e) => e.id)))} />)
          )}
        </div>

        <aside className="mk__side">
          <section className="tr__panel">
            <h2 className="obx__boxtitle">How an event is decided</h2>
            <ol className="steps steps--col">
              <li><span className="steps__n">1</span><b>A result is proposed</b><p>From the data source in the rule: the reporter for most questions, OutLayer reading FRED in a secure enclave for the Fed.</p></li>
              <li><span className="steps__n">2</span><b>Dispute window</b><p>{cfg ? windowWords(cfg.disputeWindowSec) : 'A few minutes'} on testnet. The owner can cancel a wrong answer; trading in that market pauses meanwhile.</p></li>
              <li><span className="steps__n">3</span><b>Anyone finalizes</b><p>The worlds the answer rules out close. A healthy loan can only get safer.</p></li>
              <li><span className="steps__n">4</span><b>Close and redeem</b><p>One transaction repays your loan and pays out the world that happened, 1:1.</p></li>
            </ol>
          </section>
          <section className="tr__panel">
            <h2 className="obx__boxtitle">Resolution history</h2>
            {!markets ? <p className="obx__empty">Reading the events…</p> : history.length === 0 ? <p className="obx__empty">No event has resolved yet.</p> : (
              <ol className="feed feed--compact">
                {history.map((h) => (
                  <li key={h.id} className="feed__item feed__item--resolve">
                    <time className="num" dateTime={new Date(h.atSec * 1000).toISOString()}>{utcDate(h.atSec).slice(5, 10)}</time>
                    <span>{h.question} <b>{h.outcome}</b>{h.by ? `, proposed by ${h.by}` : ''}.</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}

/** `seen`: events already drawn higher up the page; their rule is not repeated. */
function MarketResolve({ m, now, blockTime, owner, holds, seen }: { m: ChainMarket; now?: bigint; blockTime?: bigint; owner: boolean; holds: boolean; seen: ReadonlySet<number> }) {
  const left = m.worlds.filter((w) => w.possible).length
  const winner = m.winner !== undefined ? m.worlds[m.winner] : undefined
  return (
    <section className="tr__panel rs">
      <div className="rs__head">
        <MarketArt m={m} size={44} />
        <div>
          <Link href={m.href} className="rs__q">{m.question}</Link>
          <p className="pc__note">{m.settled ? `Settled: ${winner?.outcome ?? 'one world left'}` : `${left} of ${m.worldCount} worlds still possible · #${m.sid}`}</p>
        </div>
        {m.settled && <Chip tone="final">Settled</Chip>}
      </div>
      {m.events.map((e) => (
        <EventRow key={e.id} e={e} now={now} rule={!seen.has(e.id)}>
          <EventActions e={e} sid={m.sid} now={now} blockTime={blockTime} owner={owner} />
        </EventRow>
      ))}
      {holds && m.status !== 'open' && <CloseAndRedeem sid={m.sid} />}
    </section>
  )
}

/** Finalize for anyone once the window has passed; dispute for the owner inside it; OutLayer for a FRED question. */
function EventActions({ e, sid, now, blockTime, owner }: { e: ChainEvent; sid: number; now?: bigint; blockTime?: bigint; owner: boolean }) {
  const actions = useActions()
  const dates = useOutLayerDates(e.id, !e.finalized)
  const ol = useOutLayerConfig()
  if (e.finalized) return null
  const d = dates.data
  return (
    <>
      {e.proposalOpen && (
        <div className="rs__acts">
          <SmallTx tone="buy" label="Finalize" busyLabel="Finalizing…" blocker={finalizeBlocker(e.state, now, blockTime)} action="finalize" deposit="0" run={() => actions.finalize(e.id, sid)} />
          {owner && <SmallTx tone="sell" label="Dispute" busyLabel="Disputing…" blocker={disputeBlocker(e.state, now)} action="dispute" run={() => actions.dispute(e.id, sid)} />}
        </div>
      )}
      {d && (d.pending ? (
        <p className="pc__note">OutLayer is reading FRED (request #{d.request})…</p>
      ) : (
        <div className="rs__acts">
          <SmallTx
            label="Ask OutLayer to read FRED"
            busyLabel="Sending the request…"
            blocker={e.proposalOpen ? 'A result is proposed already' : !ol.data ? 'OutLayer is not set up' : undefined}
            action="request_resolution"
            gas={GAS_MAX}
            deposit={ol.data?.deposit ?? 0n}
            run={() => actions.send(requestResolution(CONTRACT_ID, e.id, ol.data!.deposit), proposalAnnounce('Resolution', 'Asking OutLayer…', 'Requested: OutLayer proposes the result'))}
          />
          {ol.data && <span className="pc__note">{nearText(ol.data.deposit)} NEAR; unused NEAR comes back. FRED rates for {d.before} and {d.after} decide it.</span>}
        </div>
      ))}
    </>
  )
}

const hasPosition = (v: Account) => v.debt > 0n || v.collateral.length > 0

/** Every tier with a position: repay, withdraw and redeem in one transaction; and wallet pieces of the world left. */
function CloseAndRedeem({ sid }: { sid: number }) {
  const { accountId } = useWallet()
  const view = useResolve(sid, accountId)
  const tiers = useLendingTiers(sid, accountId)
  const balances = useWalletBalances()
  const s = view.data?.scenario
  const shown = (tiers.data ?? []).filter((t) => t.account && hasPosition(t.account))
  const rows = s ? walletRedeemable(s) : []
  if (!s || (shown.length === 0 && rows.length === 0)) return null
  return (
    <div className="gv__close">
      {shown.map((t) => <ClosePanel key={t.tier} s={s} tier={t.tier} v={t.account!} walletUsdc={balances?.usdcWad ?? 0n} />)}
      {rows.length > 0 && <WalletRedeem s={s} rows={rows} />}
    </div>
  )
}

function ClosePanel({ s, tier, v, walletUsdc }: { s: Scenario; tier: Tier; v: Account; walletUsdc: bigint }) {
  const actions = useActions()
  const cfg = useAppConfig().data
  const plan = planClose(v.collateral, s.possible)
  let blocker: string | undefined
  if (s.resolutionCount === 0) blocker = 'Opens once an event resolves'
  else if (v.debt > walletUsdc) blocker = `Needs ${fmt(v.debt)} USDC in your wallet to repay`
  else if (!cfg) blocker = 'Reading the contract…'
  return (
    <div className="gv__closebox">
      <div className="desk__head"><h3 className="gv__h3">Close and redeem · {TIER_LABEL[tier]}</h3><span className="pc__note">One transaction</span></div>
      <div className="desk__table gv__table2">
        <div className="desk__tr desk__tr--head"><span>Collateral</span><span>Amount</span></div>
        {plan.pieces.map((p) => (
          <div key={p.tokenId} className={`desk__tr${p.fate === 'dead' ? ' gv__dead' : ''}`}>
            <span className="gv__piece"><b>{p.label}</b><small>{fateText(p)}</small></span>
            <span className="num">{fmtAsset(p.asset, p.amount)}</span>
          </div>
        ))}
      </div>
      <p className="tk__line"><span>You repay (loan plus interest)</span><b className="num">{fmtUsd(v.debt)}</b></p>
      <p className="tk__line"><span>You receive, real</span><b className="num">{fmt(plan.realUsdc)} USDC{plan.realWnear > 0n ? ` + ${fmtNear(plan.realWnear)} wNEAR` : ''}</b></p>
      <TicketTx
        label={`Close ${TIER_LABEL[tier]} and redeem`}
        busyLabel="Closing…"
        blocker={blocker}
        action="close"
        run={() => {
          if (v.debt > 0n) {
            // the debt grows by a few seconds of interest before this lands: send 0.1% more, bounded by the wallet; the rest comes back
            const cap = v.debt + v.debt / 1000n
            const tokens = toTokenCeil(cap > walletUsdc ? walletUsdc : cap, cfg!.usdc.decimals)
            return actions.send(closeWithDebt(cfg!.usdc.tokenId, CONTRACT_ID, tokens, { scenarioId: s.scenarioId, tier }), proposalAnnounce('Close', 'Closing and redeeming…', 'Closed: repaid and redeemed'), { needs: { contract: true, tokens: ['usdc', 'wnear'] }, expectUsed: 'nonzero' })
          }
          return actions.send(closeAfterResolution(CONTRACT_ID, { scenarioId: s.scenarioId, tier }), proposalAnnounce('Close', 'Closing and redeeming…', 'Closed and redeemed'), { needs: { contract: true, tokens: ['usdc', 'wnear'] } })
        }}
      />
    </div>
  )
}

function WalletRedeem({ s, rows }: { s: Scenario; rows: ReturnType<typeof walletRedeemable> }) {
  const actions = useActions()
  return (
    <div className="gv__closebox">
      <h3 className="gv__h3">Redeem from your wallet</h3>
      <p className="pc__note">Pieces in your wallet, not in a loan, whose world is the only one left: each redeems 1:1 for the real token.</p>
      {rows.map((r) => (
        <div key={r.tokenId} className="gv__redeem">
          <span className="gv__piece"><b>{r.label}</b><small>{fmtAsset(r.asset, r.amount)} → {fmtAsset(r.asset, r.amount)} real {r.symbol}</small></span>
          <SmallTx tone="buy" label="Redeem" busyLabel="Redeeming…" action="redeem" run={() => actions.redeem(s.scenarioId, r.asset, r.mask, r.amount)} />
        </div>
      ))}
    </div>
  )
}

