'use client'
// One proposal (/proposal/?p=N), in the trading screen's style: the pair-bar header with its status and pledge
// totals; where it stands (stage, progress, the mix that helps most); the question or the events it combines, with
// rules and sources; what opening it now would do (`get_proposal`'s preview). On the right, what you can do: open it
// when it is ready, top up its reserve, pledge, withdraw / refund / claim your pledge, cancel it if it is yours, and,
// for the owner, the check of a new event.
import { useState } from 'react'
import Link from 'next/link'
import { Chip, OwnerCheck, PledgeExits, PledgeForm, PledgeProgress, ProposalChip, TicketTx } from '../components/governance/Gov'
import { useStorageFree } from '../chain/hooks/useStorageFree'
import { pledgeWords, proposalAnnounce, STORAGE_MARGIN, storageToWithdraw } from '../chain/governance'
import { MarketArt } from '../components/Grand'
import { eventArt, ruleText, useActions, useEventMetas, useIsOwner, useMarket } from '../chain/adapter'
import { CONTRACT_ID } from '../chain/data/client'
import type { EventState, MarketParamsView, Pledge, Proposal as ProposalT } from '../chain/domain'
import { errorLine, humanError, parseContractError } from '../chain/errors'
import { accountLabel, fmt, fmtNear, fmtPrice, parseAmount, pct, relTime, utcDate } from '../chain/format'
import { useNowSeconds } from '../chain/hooks/useClock'
import { useDebounced } from '../chain/hooks/useDebounced'
import { useEvents, useMarketParams, usePledge, useProposal, useSeedPreview } from '../chain/hooks/useProposal'
import { marketHref, proposeHref } from '../chain/links'
import { categoryName, isWebSource } from '../chain/market'
import { openedMarketId, seedWithdrawnLine } from '../chain/near/outcome'
import { call, cancelProposal, GAS_CALL, GAS_LIGHT, GAS_MAX, ONE_YOCTO, openMarket, seedWithdraw, topUpDeposit, topUpProposal } from '../chain/near/tx'
import { useWallet } from '../chain/near/wallet'
import { isLive, isTerminal, nearText, parseProposalParam, pledgeActions, proposalStage, proposalTitle, seedMinimums, spanWords, worldLabels } from '../chain/proposals'

const STAGE_TONE = { pos: 'final', neg: 'off', warn: 'live', neutral: 'open', info: 'open' } as const

export default function Proposal({ id }: { id: string }) {
  const pid = parseProposalParam(id)
  const prop = useProposal(pid)
  const mp = useMarketParams()
  const p = prop.data
  const events = useEvents(p?.eventIds ?? [])
  const evs = (p?.eventIds ?? []).map((e) => events.data?.find((x) => x.id === e)).filter((e): e is EventState => Boolean(e))

  if (pid === undefined || p === null) {
    return (
      <div className="page tr desk gv">
        <header className="tr__pair"><div className="tr__id"><h1 className="mk__title">{pid === undefined ? 'Which proposal?' : `No proposal #${pid}`}</h1></div></header>
        <div className="tr__panel desk__empty">
          <p><b>{pid === undefined ? 'This link names no proposal.' : 'There is no such proposal on this contract.'}</b> The board lists every one.</p>
          <Link href="/proposals/" className="mk__btn mk__btn--buy">See the proposals</Link>
        </div>
      </div>
    )
  }
  if (!p || !mp.data) {
    const err = prop.error ?? mp.error
    return (
      <div className="page tr desk gv">
        <div className="tr__panel desk__empty" role="status"><p>{err ? errorLine(err.message) : 'Reading the chain…'}</p></div>
      </div>
    )
  }

  const labels = p.newEvent ? worldLabels([p.newEvent]) : evs.length === p.eventIds.length ? worldLabels(evs) : undefined
  const title = proposalTitle(p, (e) => evs.find((x) => x.id === e)?.question)
  const art = p.newEvent ? [{ image: eventArt({ rule: p.newEvent.rule ?? '', question: p.newEvent.question, finalized: false }) }] : evs.map((e) => ({ image: eventArt(e) }))
  return (
    <div className="page tr desk gv">
      <Header p={p} title={title} art={art} />
      <div className="mk__grid">
        <div className="mk__main">
          <Stage p={p} labels={labels} />
          <Questions p={p} events={evs} />
          {p.preview && p.status !== 'opened' && <Preview p={p} labels={labels} mp={mp.data} />}
        </div>
        <aside className="mk__side">
          <Side p={p} mp={mp.data} />
        </aside>
      </div>
    </div>
  )
}

function Header({ p, title, art }: { p: ProposalT; title: string; art: { image?: string }[] }) {
  const now = Number(useNowSeconds())
  const live = isLive(p.status)
  return (
    <header className="tr__pair">
      <MarketArt m={{ question: title, events: art }} size={52} />
      <div className="tr__id">
        <p className="mk__crumb">
          <Link href="/proposals/">Proposals</Link> /
          <span className="mk__tag">#{p.proposalId}</span>
          <span className="mk__tag">{p.kind === 'new_event' ? 'New event' : `Combination · ${p.worldCount} worlds`}</span>
          {p.kind === 'new_event' ? categoryName(p.category) : ''}
        </p>
        <h1 className="mk__title">{title}</h1>
        <p className="tr__means">
          By {accountLabel(p.proposer, 32)} · proposed {utcDate(p.createdAtSec)}
          {live && p.expiresAtSec > 0 ? ` · pledging closes ${relTime(p.expiresAtSec - now)} (${utcDate(p.expiresAtSec)})` : ''}
        </p>
      </div>
      <dl className="tr__stats">
        <div><dt>Status</dt><dd><ProposalChip p={p} nowSec={now} /></dd></div>
        <div><dt>Goal</dt><dd className="num">${fmt(p.goal, 0)}</dd></div>
        <div><dt>Pledgers</dt><dd className="num">{p.pledgers}</dd></div>
      </dl>
    </header>
  )
}

function Stage({ p, labels }: { p: ProposalT; labels?: string[] }) {
  const stage = proposalStage(p, labels ? (w) => labels[w] ?? `#${w}` : undefined)
  const needs = p.preview?.needs
  return (
    <section className="tr__panel">
      <div className="desk__head">
        <h2 className="obx__boxtitle">{stage.title}</h2>
        <Chip tone={STAGE_TONE[stage.tone]}>{p.status === 'opened' ? 'Open' : `${(p.progressBps / 100).toFixed(p.progressBps % 100 === 0 ? 0 : 1)}% pledged`}</Chip>
      </div>
      {stage.detail && <p className="tr__means">{stage.detail}</p>}
      {p.status === 'opened' && p.opened ? (
        <>
          <p className="tk__line"><span>Opened</span><b className="num">{utcDate(p.opened.openedAtSec)} at NEAR {fmtPrice(p.opened.sRef)}</b></p>
          <p className="tk__line"><span>Seed shares unlock</span><b className="num">{utcDate(p.opened.unlockAtSec)}</b></p>
          <Link href={marketHref(p.opened.scenarioId)} className="mk__btn mk__btn--buy gv__go">Trade market #{p.opened.scenarioId}</Link>
        </>
      ) : isTerminal(p.status) && p.pledgers === 0 ? null : (
        <div className="gv__stack">
          <PledgeProgress p={p} />
          <p className="tk__line"><span>Best mix to reach the goal</span><b className="num">≈ {fmtNear(p.idealWnear)} wNEAR + {fmt(p.idealUsdc, 0)} USDC</b></p>
          {needs && isLive(p.status) && <p className="pc__note">{needs === 'wnear' ? 'The pools take wNEAR and USDC together, so USDC pledged without wNEAR beside it waits for wNEAR before it counts as usable: more wNEAR pledges would help most right now.' : 'The pools take wNEAR and USDC together, so wNEAR pledged without USDC beside it waits for USDC before it counts as usable: more USDC pledges would help most right now.'}</p>}
        </div>
      )}
    </section>
  )
}

const Source = ({ s }: { s: string }) => (isWebSource(s) ? <a href={s} target="_blank" rel="noreferrer">{s}</a> : <>{s}</>)

function Questions({ p, events }: { p: ProposalT; events: EventState[] }) {
  const metas = useEventMetas(p.eventIds)
  if (p.kind === 'new_event' && !p.newEvent) {
    return (
      <section className="tr__panel">
        <h2 className="obx__boxtitle">The question</h2>
        <p className="tr__means">No longer stored: once a new event is rejected, cancelled or expires, the contract keeps only its numbers.</p>
      </section>
    )
  }
  if (p.newEvent) {
    const e = p.newEvent
    return (
      <section className="tr__panel">
        <h2 className="obx__boxtitle">The question</h2>
        <div className="mk__rules gv__rules">
          <div className="mk__rule">
            <div>
              <h3>{e.question}</h3>
              {e.rule && <p>{ruleText(e.rule)}</p>}
              <dl>
                <div><dt>Outcomes</dt><dd>{e.outcomeNames.join(' or ')}</dd></div>
                <div><dt>Deadline</dt><dd className="num">{utcDate(e.deadlineSec)}</dd></div>
                <div><dt>Category</dt><dd>{categoryName(e.category)}</dd></div>
                <div><dt>Opening chance</dt><dd className="num">{e.terms.odds0Bps / 100}% {e.outcomeNames[0]}</dd></div>
              </dl>
              {e.source && <p className="pc__note gv__src">Data source: <Source s={e.source} /></p>}
            </div>
          </div>
        </div>
      </section>
    )
  }
  return (
    <section className="tr__panel">
      <h2 className="obx__boxtitle">{p.eventIds.length === 1 ? 'The event' : `The ${p.eventIds.length} events`}</h2>
      <p className="tr__means">Each event keeps its own rule and source. Their {p.worldCount} combinations become the worlds.</p>
      <div className="mk__rules gv__rules">
        {p.eventIds.map((id) => {
          const e = events.find((x) => x.id === id)
          const src = metas.data?.get(id)?.source
          const img = e ? eventArt(e) : undefined
          return (
            <div key={id} className="mk__rule">
              {img ? <img src={img} alt="" width={36} height={36} className="art" /> : <span className="art art--blank" style={{ width: 36, height: 36 }} aria-hidden>{(e?.question ?? '#').slice(0, 1)}</span>}
              <div>
                <h3>{e?.question ?? `Event #${id}`}</h3>
                {e && <p>{ruleText(e.rule)}</p>}
                {e && (
                  <dl>
                    <div><dt>Outcomes</dt><dd>{e.outcomeNames.join(' or ')}</dd></div>
                    <div><dt>Deadline</dt><dd className="num">{utcDate(e.deadline)}</dd></div>
                    {e.finalized && <div><dt>Resolved</dt><dd>{e.outcomeNames[e.outcome]}</dd></div>}
                  </dl>
                )}
                {src && <p className="pc__note gv__src">Data source: <Source s={src} /></p>}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Preview({ p, labels, mp }: { p: ProposalT; labels?: string[]; mp: MarketParamsView }) {
  const v = p.preview!
  const label = (w: number) => labels?.[w] ?? `World ${w}`
  return (
    <section className="tr__panel">
      <div className="desk__head">
        <h2 className="obx__boxtitle">If it opened now</h2>
        <span className="pc__note">{v.sRef === null ? `No opening price yet${v.blocker ? `: ${humanError(v.blocker)}` : ''}` : `Opening NEAR price ${fmtPrice(v.sRef)}`}</span>
      </div>
      {v.prices.length > 0 && (
        <div className="desk__table gv__table4">
          <div className="desk__tr desk__tr--head"><span>World</span><span>Chance</span><span>NEAR price</span><span>Pool</span></div>
          {v.prices.map((price, w) => {
            const pool = v.worldPools.find((x) => x.world === w)
            return (
              <div key={w} className="desk__tr">
                <span className="desk__mk">{label(w)}</span>
                <span className="num">{v.odds[w] !== undefined ? pct(v.odds[w], 10n ** 18n, 1) : '–'}</span>
                <span className="num">{fmtPrice(price)}</span>
                <span className="num">{pool ? `${fmtNear(pool.wnear)} wNEAR + ${fmt(pool.usdc, 0)} USDC` : '–'}</span>
              </div>
            )
          })}
        </div>
      )}
      <div className="gv__lines">
        <p className="tk__line"><span>Usable value</span><b className="num">{fmt(v.usableValue, 0)} of {fmt(p.goal, 0)} USDC</b></p>
        <p className="tk__line"><span>Into the pools</span><b className="num">{fmtNear(v.usedWnear)} wNEAR + {fmt(v.usedUsdc)} USDC</b></p>
        <p className="tk__line"><span>Back to pledgers</span><b className="num">{fmtNear(v.unusedWnear)} wNEAR + {fmt(v.unusedUsdc)} USDC</b></p>
        <p className="tk__line"><span>Thinnest world pool</span><b className="num">{fmt(v.thinnestWorldUsdc, 0)} USDC (needs {fmt(mp.params.minOpenDepthUsdc, 0)})</b></p>
        <p className="tk__line"><span>Storage</span><b className="num">{nearText(v.storageEstimate)} of {nearText(v.reserveAvailable)} NEAR</b></p>
      </div>
    </section>
  )
}

// ---- the action column ----

function Side({ p, mp }: { p: ProposalT; mp: MarketParamsView }) {
  const { accountId } = useWallet()
  const owner = useIsOwner()
  const mine = usePledge(p.proposalId, accountId)
  const pl = mine.data ?? null
  const can = pledgeActions(p.status, pl)
  const isProposer = accountId !== null && accountId === p.proposer
  return (
    <>
      {p.status === 'ready' && <OpenBox p={p} />}
      {p.status === 'waiting' && <WaitingBox p={p} />}
      {can.pledge && (
        <section className="tr__panel mk__ticket">
          <h2 className="obx__boxtitle">Pledge</h2>
          <PledgeForm p={p} help />
          <p className="pc__note">When the market opens you get seed shares worth your pledge at the opening price, withdrawable with their fees after {spanWords(p.seedLockSec || mp.params.seedLockSec)}. The part the pools cannot use is yours to claim back.</p>
        </section>
      )}
      {pl && <MyPledge p={p} pl={pl} />}
      {isProposer && <ProposerBox p={p} />}
      {owner && p.kind === 'new_event' && (p.status === 'review' || p.status === 'pledging') && (
        <section className="tr__panel mk__ticket">
          <h2 className="obx__boxtitle">Owner check</h2>
          <p className="ticket__help">Only the contract owner sees this. Approving returns the proposer’s bond and lets pledges open the market.</p>
          <OwnerCheck p={p} params={mp.params} />
        </section>
      )}
      {p.status === 'opened' && p.opened && !pl && (
        <section className="tr__panel mk__ticket">
          <h2 className="obx__boxtitle">It opened</h2>
          <p className="ticket__help">The pledges became market #{p.opened.scenarioId}’s first liquidity. Its pledgers hold seed shares in its pools.</p>
          <Link href={marketHref(p.opened.scenarioId)} className="mk__btn mk__btn--buy">Trade market #{p.opened.scenarioId}</Link>
          <Link href={proposeHref()} className="mk__btn">Propose another market</Link>
        </section>
      )}
      {!can.pledge && !pl && p.status !== 'opened' && !isProposer && (
        <section className="tr__panel">
          <p className="tr__means">This proposal is closed. Pledgers get their refund here once they connect.</p>
          <Link href={proposeHref()} className="mk__btn gv__go">Propose a market</Link>
        </section>
      )}
    </>
  )
}

function OpenBox({ p }: { p: ProposalT }) {
  const actions = useActions()
  const [opened, setOpened] = useState<number>()
  return (
    <section className="tr__panel mk__ticket">
      <h2 className="obx__boxtitle">Ready to open</h2>
      <p className="ticket__help">The pledges reached the goal and every opening check passes. Anyone can open it; it costs only gas.</p>
      <TicketTx
        label="Open the market"
        busyLabel="Opening…"
        action="open_market"
        gas={GAS_MAX}
        deposit="0"
        run={() => actions.send(openMarket(CONTRACT_ID, p.proposalId), proposalAnnounce('Proposal', 'Opening the market…', 'The market is open'), { onOutcome: (o) => setOpened(openedMarketId(o)) })}
      />
      {opened !== undefined && <Link href={marketHref(opened)} className="mk__btn mk__btn--buy gv__go">Trade market #{opened}</Link>}
    </section>
  )
}

/** `OpenStorageShort(needed, available)`: the numbers T35 needs. */
function storageShort(blocker: string | null): { needed: bigint; available: bigint } | undefined {
  const e = blocker ? parseContractError(blocker) : undefined
  if (!e || e.name !== 'OpenStorageShort') return undefined
  const [a, b] = e.args
  if (!/^\d+$/.test(a ?? '') || !/^\d+$/.test(b ?? '')) return undefined
  return { needed: BigInt(a), available: BigInt(b) }
}

function WaitingBox({ p }: { p: ProposalT }) {
  const actions = useActions()
  const short = storageShort(p.blocker)
  if (!short) return null
  const deposit = topUpDeposit(short.needed, short.available)
  return (
    <section className="tr__panel mk__ticket">
      <h2 className="obx__boxtitle">Top up the reserve</h2>
      <p className="ticket__help">The new market needs a little more NEAR for its storage than the reserve holds. Anyone can add it; what the opening does not spend goes to the proposer.</p>
      <TicketTx
        label={`Add ${nearText(deposit)} NEAR`}
        busyLabel="Adding…"
        action="top_up_proposal"
        gas={GAS_LIGHT}
        deposit={deposit}
        run={() => actions.send(topUpProposal(CONTRACT_ID, p.proposalId, short.needed, short.available), proposalAnnounce('Proposal', 'Topping up the reserve…', 'Reserve topped up'))}
      />
    </section>
  )
}

function MyPledge({ p, pl }: { p: ProposalT; pl: Pledge }) {
  const [line, setLine] = useState<string>()
  const state = { pledged: 'Pledged', refundable: 'Refundable', seed: 'Seed shares' }[pl.state]
  return (
    <section className="tr__panel mk__ticket">
      <div className="desk__head">
        <h2 className="obx__boxtitle">Your pledge</h2>
        <Chip tone={pl.state === 'seed' ? 'final' : pl.state === 'refundable' ? 'live' : 'open'}>{state}</Chip>
      </div>
      <p className="tk__line"><span>Pledged</span><b className="num">{pledgeWords(pl)}</b></p>
      {pl.shares !== null && <p className="tk__line"><span>Seed shares</span><b className="num">{fmt(pl.shares)} · {fmt(pl.withdrawnShares)} withdrawn</b></p>}
      {pl.shares !== null && pl.unlockAtSec > 0 && <p className="tk__line"><span>Withdrawable from</span><b className="num">{utcDate(pl.unlockAtSec)}</b></p>}
      {p.status === 'opened' && !pl.unusedPaid && (pl.unusedUsdc > 0n || pl.unusedWnear > 0n) && <p className="tk__line"><span>Unused part</span><b className="num">{pledgeWords({ usdc: pl.unusedUsdc, wnear: pl.unusedWnear })}</b></p>}
      <PledgeExits p={p} pl={pl} onLine={setLine} />
      {pl.state === 'seed' && p.opened && <SeedWithdraw p={p} pl={pl} onLine={setLine} />}
      {line && <p className="pc__note gv__ok" role="status">{line}</p>}
    </section>
  )
}

function ProposerBox({ p }: { p: ProposalT }) {
  const actions = useActions()
  const back = storageToWithdraw(useStorageFree() ?? 0n)
  const live = p.status === 'review' || p.status === 'pledging'
  const hasPledges = p.pledgedUsdc > 0n || p.pledgedWnear > 0n
  const bondText =
    p.kind === 'market'
      ? `Cancelling a combination keeps its bond (${nearText(p.bond)} NEAR) for new markets’ storage; the reserve (${nearText(p.reserve)} NEAR) comes back.`
      : p.status === 'review'
        ? `In review, cancelling returns the bond (${nearText(p.bond)} NEAR) and the reserve (${nearText(p.reserve)} NEAR).`
        : `The bond came back at approval; cancelling returns the reserve (${nearText(p.reserve)} NEAR).`
  if (!live && back === 0n) return null
  return (
    <section className="tr__panel mk__ticket">
      <h2 className="obx__boxtitle">Your proposal</h2>
      {live && (
        <>
          <p className="ticket__help">{hasPledges ? 'Others have pledged, so it can no longer be cancelled.' : bondText}</p>
          <TicketTx
            tone="sell"
            label="Cancel the proposal"
            busyLabel="Cancelling…"
            blocker={hasPledges ? 'Has pledges' : undefined}
            action="cancel_proposal"
            gas={GAS_CALL}
            run={() => actions.send(cancelProposal(CONTRACT_ID, p.proposalId), proposalAnnounce('Proposal', 'Cancelling…', 'Cancelled; what comes back is in your storage balance'))}
          />
        </>
      )}
      {back > 0n && (
        <>
          <p className="ticket__help">You have {nearText(back + STORAGE_MARGIN)} NEAR free in your storage balance on the contract: left from registering, or a bond or reserve that came back. Take {nearText(back)} NEAR back; {nearText(STORAGE_MARGIN)} NEAR stays for your next proposal or pledge.</p>
          <TicketTx
            label={`Withdraw ${nearText(back)} NEAR`}
            busyLabel="Withdrawing…"
            action="storage_withdraw"
            gas={GAS_LIGHT}
            run={() => actions.send(call(CONTRACT_ID, 'storage_withdraw', { amount: back.toString() }, ONE_YOCTO, GAS_LIGHT), { kind: 'wallet', title: 'Storage', pending: 'Withdrawing free NEAR…', done: 'Free NEAR is back in your wallet' })}
          />
        </>
      )}
    </section>
  )
}

/** T32: seed shares back out of the market's pools once unlocked, with a 99.5% floor per world from the preview. */
function SeedWithdraw({ p, pl, onLine }: { p: ProposalT; pl: Pledge; onLine: (s: string | undefined) => void }) {
  const actions = useActions()
  const { accountId } = useWallet()
  const now = Number(useNowSeconds())
  const sid = p.opened!.scenarioId
  const { market } = useMarket(sid)
  const [text, setText] = useState('all')
  const all = text.trim().toLowerCase() === 'all' || text.trim() === ''
  const parsed = all ? undefined : parseAmount(text, 18)
  const shares: bigint | null = all ? null : (parsed ?? 0n)
  const debounced = useDebounced(shares, 350)
  const remaining = (pl.shares ?? 0n) - pl.withdrawnShares
  const locked = pl.unlockAtSec > now
  const preview = useSeedPreview(p.proposalId, accountId, debounced, remaining > 0n && !locked)
  const pv = preview.data
  const max = pv?.maxShares ?? pl.maxWithdrawableShares
  const want = all ? remaining : (parsed ?? 0n)

  let blocker: string | undefined
  if (remaining <= 0n) blocker = 'Every share is withdrawn'
  else if (pv && pv.lockedUntilSec > 0) blocker = `Locked until ${utcDate(pv.lockedUntilSec)}`
  else if (locked) blocker = `Locked until ${utcDate(pl.unlockAtSec)}`
  else if (!all && (parsed === undefined || parsed <= 0n)) blocker = 'Enter a number of shares, or all'
  else if (want > max) blocker = `Lenders depend on these pools: at most ${fmt(max)} shares now`
  else if (preview.error) blocker = humanError(preview.error.message)
  else if (!pv || !market) blocker = 'Pricing the withdrawal…'

  return (
    <div className="gv__seed">
      <h3 className="gv__h3">Withdraw seed shares</h3>
      <label className="tk__field"><span>Shares</span>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="all" aria-label="Seed shares to withdraw, or all" />
        <button type="button" className="tr__link" onClick={() => setText('all')}>all: {fmt(remaining)}</button>
      </label>
      {pv && <p className="pc__note">{fmt(pv.usdcOut)} USDC + {fmtNear(pv.wnearOut)} wNEAR now{pv.tokens.some((t) => t.amount > 0n) ? ', plus world tokens that stay in your holdings' : ''}.</p>}
      <TicketTx
        label={all ? 'Withdraw all shares' : `Withdraw ${text} shares`}
        busyLabel="Withdrawing…"
        blocker={blocker}
        action="seed_withdraw"
        gas={GAS_MAX}
        run={() => {
          const m = seedMinimums(pv!.perWorld, market!.worldCount, market!.possible)
          return actions.send(seedWithdraw(CONTRACT_ID, { proposalId: p.proposalId, shares, minWnearOut: m.wnear, minUsdcOut: m.usdc }), proposalAnnounce('Seed shares', 'Withdrawing seed shares…', 'Seed shares withdrawn'), {
            needs: { tokens: ['wnear', 'usdc'] },
            onOutcome: (o) => onLine(seedWithdrawnLine(o)),
          })
        }}
      />
    </div>
  )
}
