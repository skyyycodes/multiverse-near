'use client'
// The owner console, in the trading screen's style: proposals waiting for the owner's check (approve or reject in
// place), the pause flags with a reason and the unpause with its liquidation grace, then a market picked by its artwork
// with the owner's resolution tools (resolve at once, dispute inside the window), its listing, the NEAR/USD reference
// and the contract's version and market parameters. Everything is read from the chain; every button is a real
// transaction that only the owner's wallet (the guardian's, for a pause) can send.
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Chip, OwnerCheck, ProposalChip, SmallTx, TicketTx } from '../components/governance/Gov'
import { EventRow } from '../components/governance/EventRow'
import { MarketArt } from '../components/Grand'
import { Button } from '../components/ui'
import { marketId, useActions, useMarkets, type ChainEvent, type ChainMarket } from '../chain/adapter'
import { CONTRACT_ID } from '../chain/data/client'
import type { MarketParamsView, PauseFlag, ProposalSummary } from '../chain/domain'
import { errorLine } from '../chain/errors'
import { accountLabel, fmt, fmtBps, fmtPrice, referenceOrigin, relTime, utcDate, utf8Bytes } from '../chain/format'
import { disputeBlocker, MAX_GRACE_SEC, MAX_REASON_BYTES, parseGrace, pausePlan, proposalAnnounce, roleOf, windowWords } from '../chain/governance'
import { useChainClock, useNowSeconds } from '../chain/hooks/useClock'
import { useAdmin, useAppConfig } from '../chain/hooks/useData'
import { useContractVersion, usePauseState } from '../chain/hooks/useOps'
import { useEventTexts } from '../chain/hooks/useMarkets'
import { useMarketParams, useProposalList, useReference, useReferenceConfig } from '../chain/hooks/useProposal'
import { adminHref, proposalHref } from '../chain/links'
import { adminResolve, GAS_LIGHT, GAS_MAX, pauseTx, requestReference, setMarketListing, unpauseTx } from '../chain/near/tx'
import { useWallet } from '../chain/near/wallet'
import { FLAG_LABEL, PAUSE_FLAGS } from '../chain/pause'
import { nearText, proposalTitle, spanWords } from '../chain/proposals'

export default function Admin({ id }: { id?: string }) {
  const router = useRouter()
  const { accountId, connect, ready, connecting } = useWallet()
  const cfg = useAppConfig().data
  const version = useContractVersion()
  const pause = usePauseState()
  const review = useProposalList('review', 20)
  const mp = useMarketParams()
  const { markets, isLoading, error } = useMarkets()
  const role = roleOf(accountId, cfg?.ownerId, pause.data?.guardianId ?? cfg?.guardianId)
  const reviewing = review.data?.proposals ?? []
  const picked = marketId(id)
  const m = (markets ?? []).find((x) => x.sid === picked) ?? markets?.[0]
  const v = version.data
  const paused = pause.data?.paused

  return (
    <div className="page tr desk gv">
      <header className="tr__pair">
        <div className="tr__id">
          <p className="mk__crumb"><span className="mk__tag">Owner only</span>{cfg ? <>Owner {accountLabel(cfg.ownerId, 32)}</> : 'Reading the contract…'}</p>
          <h1 className="mk__title">Owner console</h1>
          <p className="tr__means">Review proposed events, pause and unpause, and resolve an event when the reporter cannot. Every button here is a real transaction from the owner’s wallet.</p>
        </div>
        <dl className="tr__stats">
          <div><dt>Contract</dt><dd className="num">{v ? `v${v.codeVersion}` : '–'}</dd></div>
          <div><dt>Paused</dt><dd className="num">{paused ? (paused.length === 0 ? 'Nothing' : paused.length) : '–'}</dd></div>
          <div><dt>To review</dt><dd className="num">{review.data ? reviewing.length : '–'}</dd></div>
          <div><dt>Dispute window</dt><dd className="num">{cfg ? windowWords(cfg.disputeWindowSec) : '–'}</dd></div>
        </dl>
      </header>

      {!accountId ? (
        <section className="tr__panel tr__gate">
          <p className="tr__means">Connect the owner account to use the console. Anyone can read it.</p>
          <Button onClick={() => void connect()} disabled={!ready || connecting}>{connecting ? 'Connecting…' : 'Connect NEAR wallet'}</Button>
        </section>
      ) : !role.isOwner && (
        <p className="ov__warn gv__readonly">Read-only: these actions need the owner’s wallet{cfg ? `, ${accountLabel(cfg.ownerId, 32)}` : ''}{role.isGuardian ? '. As the guardian you can pause.' : '.'}</p>
      )}

      <div className="mk__grid">
        <div className="mk__main">
          <section className="tr__panel">
            <div className="desk__head"><h2 className="obx__boxtitle">Proposals to review</h2><Link className="tr__link" href="/proposals/">All proposals</Link></div>
            <p className="tr__means">New events wait here for the three checks. Approving returns the bond and lets pledges open the market; rejecting refunds every pledge.</p>
            {review.isPending ? <p className="obx__empty" role="status">Reading the queue…</p> : review.error && !review.data ? <p className="pc__note">{errorLine(review.error.message)}</p> : reviewing.length === 0 ? <p className="obx__empty">Nothing to review.</p> : (
              reviewing.map((p) => <ReviewRow key={p.proposalId} p={p} mp={mp.data} owner={role.isOwner} />)
            )}
          </section>

          <PausePanel owner={role.isOwner} guardian={role.isGuardian} paused={paused ?? []} since={pause.data?.sinceSec} resumeAt={pause.data?.liquidationsResumeAtSec} />

          {isLoading && !markets ? (
            <div className="tr__panel"><p className="obx__empty" role="status">Reading the markets…</p></div>
          ) : error && !markets ? (
            <div className="tr__panel"><p className="pc__note">{errorLine(error.message)}</p></div>
          ) : !m ? (
            <div className="tr__panel desk__empty"><p><b>No market yet.</b> A market opens from a funded proposal.</p></div>
          ) : (
            <>
              <div className="desk__cards" role="group" aria-label="Market">
                {(markets ?? []).map((x) => (
                  <button key={x.sid} type="button" aria-pressed={x.sid === m.sid} className="desk__card" onClick={() => router.replace(adminHref(x.sid), { scroll: false })}>
                    <MarketArt m={x} size={40} />
                    <span className="desk__cardtext"><b>{x.question}</b><small>#{x.sid} · {x.worlds.filter((w) => w.possible).length} of {x.worldCount} worlds open</small></span>
                  </button>
                ))}
              </div>
              <MarketEvents m={m} owner={role.isOwner} />
            </>
          )}
        </div>

        <aside className="mk__side">
          <section className="tr__panel">
            <h2 className="obx__boxtitle">Contract</h2>
            {!v ? <p className="obx__empty">{version.error ? errorLine(version.error.message) : 'Reading…'}</p> : (
              <>
                <p className="tk__line"><span>Code · state · events</span><b className="num">{v.codeVersion} · {v.stateVersion} · {v.eventVersion}</b></p>
                <p className="tk__line"><span>Upgraded</span><b className="num">{v.upgradedAtSec > 0 ? `${utcDate(v.upgradedAtSec)} from ${v.upgradedFrom || '–'}` : 'fresh deployment'}</b></p>
                <p className="tk__line"><span>Legacy markets</span><b className="num">{v.legacyScenarioCount}</b></p>
              </>
            )}
            {cfg && (
              <>
                <p className="tk__line"><span>Guardian</span><b className="num">{pause.data?.guardianId ? accountLabel(pause.data.guardianId, 24) : 'none'}</b></p>
                {pause.data?.pendingOwnerId && <p className="tk__line"><span>Pending owner</span><b className="num">{accountLabel(pause.data.pendingOwnerId, 24)}</b></p>}
                <p className="tk__line"><span>Reporter</span><b className="num">{cfg.reporterId ? accountLabel(cfg.reporterId, 24) : 'none'}</b></p>
                <p className="tk__line"><span>Markets · events · proposals</span><b className="num">{cfg.scenarioCount} · {cfg.eventCount} · {cfg.proposalCount}</b></p>
              </>
            )}
          </section>
          {m && <ListingPanel m={m} owner={role.isOwner} />}
          <ReferencePanel />
          {mp.data && <ParamsPanel mp={mp.data} />}
        </aside>
      </div>
    </div>
  )
}

function ReviewRow({ p, mp, owner }: { p: ProposalSummary; mp?: MarketParamsView; owner: boolean }) {
  const [open, setOpen] = useState(false)
  const now = Number(useNowSeconds())
  const texts = useEventTexts(p.eventIds)
  return (
    <div className="gv__review">
      <div className="gv__reviewhead">
        <span className="gv__piece">
          <b><Link className="gv__qlink" href={proposalHref(p.proposalId)}>{proposalTitle(p, (e) => texts.data?.get(e)?.question)}</Link></b>
          <small>#{p.proposalId} · by {accountLabel(p.proposer, 28)} · proposed {relTime(p.createdAtSec - now)}{p.newEvent ? ` · resolves ${utcDate(p.newEvent.deadlineSec)}` : ''}</small>
        </span>
        <ProposalChip p={p} nowSec={now} />
        <button type="button" className="mk__btn mk__btn--buy" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Close' : 'Review'}</button>
      </div>
      {open && (
        <div className="pp__form">
          {!owner ? <p className="pc__note">Only the owner can approve or reject. <Link href={proposalHref(p.proposalId)}>Open the proposal</Link> to see it in full.</p> : !mp ? <p className="obx__empty">Reading the market parameters…</p> : (
            <>
              <p className="pc__note">The rule and the source are on <Link href={proposalHref(p.proposalId)}>the proposal’s page</Link>.</p>
              <OwnerCheck p={p} params={mp.params} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

function PausePanel({ owner, guardian, paused, since, resumeAt }: { owner: boolean; guardian: boolean; paused: readonly PauseFlag[]; since?: bigint; resumeAt?: bigint }) {
  const actions = useActions()
  const now = useNowSeconds()
  const [flags, setFlags] = useState<PauseFlag[]>([])
  const [reason, setReason] = useState('')
  const [grace, setGrace] = useState('1800')
  const { toPause, toUnpause } = pausePlan(flags, paused)
  const graceSec = parseGrace(grace)
  const choices = PAUSE_FLAGS.filter((f) => owner || f !== 'exit')
  const who = owner ? undefined : guardian ? undefined : 'Owner or guardian only'
  const toggle = (f: PauseFlag) => setFlags((xs) => (xs.includes(f) ? xs.filter((x) => x !== f) : [...xs, f]))
  return (
    <section className="tr__panel">
      <div className="desk__head">
        <h2 className="obx__boxtitle">Pauses</h2>
        {paused.length === 0 ? <Chip tone="final">Nothing paused</Chip> : <Chip tone="live">{paused.length} paused</Chip>}
      </div>
      <p className="tr__means">
        A pause stops one kind of action everywhere until it is lifted: the screens say so on every button it blocks.
        {paused.length > 0 && since && since > 0n ? ` Paused since ${utcDate(since)}.` : ''}
        {resumeAt && resumeAt > now ? ` Liquidations resume ${relTime(Number(resumeAt - now))}.` : ''}
      </p>
      <div className="gv__flags" role="group" aria-label="Pause flags">
        {choices.map((f) => (
          <label key={f} className={`gv__flag${paused.includes(f) ? ' is-paused' : ''}`}>
            <input type="checkbox" checked={flags.includes(f)} onChange={() => toggle(f)} />
            <span><b>{f}</b><small>{FLAG_LABEL[f]}{paused.includes(f) ? ' · paused' : ''}</small></span>
          </label>
        ))}
      </div>
      <label className="tk__field gv__reason"><span>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What is being fixed" aria-label="Reason for the pause" /><em className="num">{utf8Bytes(reason)}/{MAX_REASON_BYTES}</em></label>
      <div className="gv__pair">
        <TicketTx
          tone="sell"
          label={toPause.length ? `Pause ${toPause.join(', ')}` : 'Pause'}
          busyLabel="Pausing…"
          blocker={who ?? (toPause.length === 0 ? 'Pick a running flag' : utf8Bytes(reason) > MAX_REASON_BYTES ? 'Reason too long' : reason.trim() === '' ? 'Say why' : undefined)}
          action="pause"
          gas={GAS_LIGHT}
          deposit="0"
          run={() => actions.send(pauseTx(CONTRACT_ID, toPause, reason.trim()), proposalAnnounce('Pause', `Pausing ${toPause.join(', ')}…`, `Paused ${toPause.join(', ')}`))}
          onDone={() => setFlags([])}
        />
        <TicketTx
          label={toUnpause.length ? `Unpause ${toUnpause.join(', ')}` : 'Unpause'}
          busyLabel="Unpausing…"
          blocker={!owner ? 'Owner only' : toUnpause.length === 0 ? 'Pick a paused flag' : graceSec === undefined ? `Grace: 0 to ${MAX_GRACE_SEC.toLocaleString('en-US')} seconds` : undefined}
          action="unpause"
          gas={GAS_LIGHT}
          run={() => actions.send(unpauseTx(CONTRACT_ID, toUnpause, toUnpause.includes('liquidate') ? graceSec : undefined), proposalAnnounce('Pause', `Unpausing ${toUnpause.join(', ')}…`, `Running again: ${toUnpause.join(', ')}`))}
          onDone={() => setFlags([])}
        />
      </div>
      {flags.includes('liquidate') && (
        <label className="tk__field"><span>Liquidation grace after unpausing</span><input inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value)} aria-label="Liquidation grace in seconds" /><em>s</em></label>
      )}
      <p className="pc__note">The guardian can pause but never unpause, and never withdrawals. A reason is kept on chain with the pause.</p>
    </section>
  )
}

function MarketEvents({ m, owner }: { m: ChainMarket; owner: boolean }) {
  const { accountId } = useWallet()
  const view = useAdmin(m.sid, accountId)
  const clock = useChainClock(view.data?.nowSec, view.dataUpdatedAt)
  return (
    <section className="tr__panel">
      <div className="desk__head"><h2 className="obx__boxtitle">Events of #{m.sid}</h2><Link className="tr__link" href={`/resolve/?id=${m.sid}`}>Open in Resolve</Link></div>
      <p className="tr__means">The reporter proposes; inside the window only the owner can dispute; then anyone finalizes. Resolve now proposes and finalizes at once, for when the reporter cannot run: it closes worlds for good.</p>
      {m.events.map((e) => (
        <EventRow key={e.id} e={e} now={clock.now} rule={false}>
          {!e.finalized && <OwnerTools e={e} sid={m.sid} now={clock.now} owner={owner} />}
        </EventRow>
      ))}
    </section>
  )
}

function OwnerTools({ e, sid, now, owner }: { e: ChainEvent; sid: number; now?: bigint; owner: boolean }) {
  const actions = useActions()
  const [outcome, setOutcome] = useState<number>()
  const [sure, setSure] = useState(false)
  return (
    <div className="rs__acts">
      <span className="pc__note">Resolve as</span>
      {e.outcomes.map((o, i) => (
        <button key={o} type="button" className={`mk__btn${outcome === i ? ' mk__btn--sell is-on' : ''}`} aria-pressed={outcome === i} onClick={() => { setOutcome(i); setSure(false) }}>{o}</button>
      ))}
      {outcome !== undefined && <label className="wiz__confirm gv__sure"><input type="checkbox" checked={sure} onChange={(x) => setSure(x.target.checked)} />I know {e.outcomes[outcome === 0 ? 1 : 0]} worlds close for good</label>}
      <SmallTx
        tone="sell"
        label={outcome === undefined ? 'Resolve now' : `Resolve now: ${e.outcomes[outcome]}`}
        busyLabel="Resolving…"
        blocker={!owner ? 'Owner only' : outcome === undefined ? 'Pick an outcome' : !sure ? 'Confirm first' : undefined}
        action="admin_resolve"
        run={() => actions.send(adminResolve(CONTRACT_ID, e.id, outcome!), { kind: 'resolve', title: 'Resolution', pending: 'Resolving…', done: 'Resolved; the other worlds closed', market: sid }, { needs: { contract: true } })}
      />
      {e.proposalOpen && (
        <SmallTx label="Dispute" busyLabel="Disputing…" blocker={!owner ? 'Owner only' : disputeBlocker(e.state, now)} action="dispute" run={() => actions.dispute(e.id, sid)} />
      )}
    </div>
  )
}

function ListingPanel({ m, owner }: { m: ChainMarket; owner: boolean }) {
  const actions = useActions()
  return (
    <section className="tr__panel mk__ticket">
      <h2 className="obx__boxtitle">Listing of #{m.sid}</h2>
      <p className="ticket__help">Only listed markets show on the board, and only they can anchor or price new proposals.</p>
      <p className="tk__line"><span>Listed</span><b className="num">{m.listed ? 'yes' : 'no'}</b></p>
      <p className="tk__line"><span>Origin</span><b className="num">{m.origin}{m.proposalId ? ` · proposal #${m.proposalId}` : ''}</b></p>
      <TicketTx
        tone="sell"
        variant="ghost"
        label={m.listed ? 'Unlist this market' : 'List this market'}
        busyLabel="Saving…"
        blocker={owner ? undefined : 'Owner only'}
        action="listing"
        gas={GAS_LIGHT}
        run={() => actions.send(setMarketListing(CONTRACT_ID, m.sid, !m.listed), proposalAnnounce('Listing', 'Saving the listing…', m.listed ? 'Unlisted' : 'Listed'))}
      />
    </section>
  )
}

function ReferencePanel() {
  const actions = useActions()
  const ref = useReference()
  const cfg = useReferenceConfig()
  const r = ref.data
  const deposit = cfg.data?.guest?.deposit
  return (
    <section className="tr__panel mk__ticket">
      <h2 className="obx__boxtitle">NEAR/USD reference</h2>
      <p className="ticket__help">The outside price that borrowing, liquidations and openings compare the markets with.</p>
      {ref.isPending ? <p className="obx__empty">Reading…</p> : !r ? <p className="obx__empty">{ref.error ? errorLine(ref.error.message) : 'No reference price stored yet.'}</p> : (
        <>
          <p className="tk__line"><span>Price</span><b className="num">{fmtPrice(r.price)}</b></p>
          <p className="tk__line"><span>Source</span><b className="num">{referenceOrigin(r)}</b></p>
          <p className="tk__line"><span>Observed</span><b className="num">{utcDate(r.observedAt)} · {spanWords(r.ageSec)} old</b></p>
          {r.pending && <p className="tk__line"><span>Request</span><b className="num">#{r.request} pending</b></p>}
        </>
      )}
      {cfg.data && cfg.data.guest && (
        <TicketTx
          variant="ghost"
          label={deposit !== undefined ? `Refresh from OutLayer · ${nearText(deposit)} NEAR` : 'Refresh from OutLayer'}
          busyLabel="Requesting…"
          blocker={!cfg.data.enabled ? 'The reference is off' : r?.pending ? 'A request is in flight' : undefined}
          action="request_reference"
          gas={GAS_MAX}
          deposit={deposit ?? 0n}
          run={() => actions.send(requestReference(CONTRACT_ID, deposit!), proposalAnnounce('Reference', 'Asking OutLayer…', 'Requested: the price arrives in a few seconds'))}
        />
      )}
      {cfg.data && !cfg.data.guest && <p className="pc__note">Refreshed by the reporter (the keeper) on this deployment.</p>}
    </section>
  )
}

function ParamsPanel({ mp }: { mp: MarketParamsView }) {
  const p = mp.params
  const usd = (x: bigint) => `${fmt(x, 0)} USDC`
  const rows: [string, string][] = [
    ['Bond: new event / mix', `${nearText(p.bondNewEvent)} / ${nearText(p.bondMarket)} NEAR`],
    ['Reserve at 2 / 4 / 8 worlds', `${nearText(mp.reserveW2)} / ${nearText(mp.reserveW4)} / ${nearText(mp.reserveW8)} NEAR`],
    ['Storage fund', `${nearText(mp.storageFund)} NEAR`],
    ['Pledging window / review', `${spanWords(p.proposalTtlSec)} / ${spanWords(p.reviewTtlSec)}`],
    ['Shortest market life', spanWords(p.minMarketLifeSec)],
    ['Seed lock / notice', `${spanWords(p.seedLockSec)} / ${spanWords(p.noticeSec)}`],
    ['Spam floor', fmtBps(p.spamFloorBps)],
    ['Goal depth / smallest goal', `${usd(p.goalDepthUsdc)} / ${usd(p.minGoalUsdc)}`],
    ['Smallest opening depth', usd(p.minOpenDepthUsdc)],
    ['Smallest pledge', `${fmt(p.minPledgeUsdc)} USDC / ${fmt(p.minPledgeWnear)} wNEAR`],
    ['Anchors', p.anchors.filter((a) => a > 0).map((a) => `#${a}`).join(', ') || 'none'],
    ['Outside price required', p.requireExternal ? `yes, within ${fmtBps(p.maxExternalDivergenceBps)}` : 'no'],
    ['Per account: pledges / live proposals', `${p.maxPledgesPerAccount} / ${p.maxActivePerAccount}`],
  ]
  return (
    <section className="tr__panel">
      <details className="gv__details">
        <summary className="obx__boxtitle">Market parameters</summary>
        {rows.map(([k, v]) => <p key={k} className="tk__line"><span>{k}</span><b className="num">{v}</b></p>)}
        <p className="pc__note">Changed only by the owner’s setters, from the scripts.</p>
      </details>
    </section>
  )
}
