'use client'
// Pieces the Propose, Proposals, Proposal, Resolve and Admin screens share, in the desk's style: the status chip, the
// small and ticket-size transaction buttons, a proposal card for the board, the pledge ticket, your pledge and its
// ways back out, and the owner's check of a new event. Every button sends through the adapter (useActions().send) and
// the shared ActionButton, so the wallet, the pause flags, the gas check and the toasts behave as on every screen.
import { useState, type ComponentProps, type ReactNode } from 'react'
import Link from 'next/link'
import { useActions, useWalletBalances, type ActionResult } from '../../chain/adapter'
import { CONTRACT_ID } from '../../chain/data/client'
import type { MarketParams, Pledge, ProposalSummary } from '../../chain/domain'
import { humanError } from '../../chain/errors'
import { accountLabel, fmt, fmtNear, inputText, parseAmount, utcDate } from '../../chain/format'
import { PROPOSAL_CHIP, pledgeBar, pledgeWords, proposalAnnounce, STORAGE_MARGIN, storageTopUp, timeLeft, type ChipTone } from '../../chain/governance'
import { useAppConfig } from '../../chain/hooks/useData'
import { useStorageFree } from '../../chain/hooks/useStorageFree'
import { useDebounced } from '../../chain/hooks/useDebounced'
import { useMarketParams, usePledgePreview } from '../../chain/hooks/useProposal'
import { marketHref, proposalHref } from '../../chain/links'
import { categoryName, pledgedValue } from '../../chain/market'
import { pledgeResult, pledgeReturnedLine } from '../../chain/near/outcome'
import { approveProposal, claimUnused, GAS_CALL, GAS_MAX, ONE_YOCTO, pledge as pledgeTx, rejectProposal, storageDeposit, withdrawPledge } from '../../chain/near/tx'
import { normaliseTerms, pledgeActions, spanWords, STATUS_LABEL, termsProblem } from '../../chain/proposals'
import type { Asset } from '../../chain/types'
import { toTokenCeil } from '../../chain/units'
import { ActionButton } from '../ui/ActionButton'
import { MarketArt } from '../Grand'

/** A state chip in the desk's look: rs__state--open (grey), --live (amber), --final (green), --off (closed). */
export function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return <span className={`rs__state rs__state--${tone}`}>{children}</span>
}

type TxProps = ComponentProps<typeof ActionButton>

/** The screen's own blocker, else "Reading the contract…" until the config every action needs has arrived. */
function useReady(blocker: string | undefined): string | undefined {
  const cfg = useAppConfig().data
  return blocker ?? (cfg ? undefined : 'Reading the contract…')
}

/** A transaction button the size of the desk's small buttons (mk__btn), green for "go", rose for "back out". */
export function SmallTx({ tone = 'plain', blocker, ...props }: TxProps & { tone?: 'buy' | 'sell' | 'plain' }) {
  return <span className={`gv__tx gv__tx--${tone}`}><ActionButton {...props} blocker={useReady(blocker)} /></span>
}

/** A ticket's full-width button, in the trading screen's green (tk--buy) or maroon (tk--sell). */
export function TicketTx({ tone = 'buy', blocker, ...props }: TxProps & { tone?: 'buy' | 'sell' }) {
  return <div className={`tk tk--${tone}`}><ActionButton {...props} blocker={useReady(blocker)} /></div>
}

/** The proposal's status as a chip: "Collecting pledges · 12 d left", "In review", "Opened". */
export function ProposalChip({ p, nowSec }: { p: Pick<ProposalSummary, 'status' | 'expiresAtSec'>; nowSec: number }) {
  const left = p.status === 'pledging' ? timeLeft(p.expiresAtSec, nowSec) : undefined
  return <Chip tone={PROPOSAL_CHIP[p.status]}>{STATUS_LABEL[p.status]}{left ? ` · ${left}` : ''}</Chip>
}

/** Pledged USDC and wNEAR as two parts of one bar towards the goal, with the numbers under it. */
export function PledgeProgress({ p }: { p: Pick<ProposalSummary, 'pledgedUsdc' | 'pledgedWnear' | 'sHint' | 'goal' | 'pledgers'> }) {
  const bar = pledgeBar(p)
  return (
    <>
      <div className="pp__bar" role="img" aria-label={`${fmt(pledgedValue(p), 0)} of ${fmt(p.goal, 0)} USDC pledged`}>
        <i className="pp__take" style={{ width: `${bar.usdc}%` }} />
        <i className="pp__hedge" style={{ width: `${bar.wnear}%` }} />
      </div>
      <div className="pp__nums">
        <span><b className="num">${fmt(pledgedValue(p), 0)}</b> of ${fmt(p.goal, 0)}</span>
        <span><i className="pp__dot pp__dot--take" />USDC <b className="num gv__small">{fmt(p.pledgedUsdc, 0)}</b></span>
        <span><i className="pp__dot pp__dot--hedge" />wNEAR <b className="num gv__small">{fmtNear(p.pledgedWnear)}</b></span>
        <span>{p.pledgers} {p.pledgers === 1 ? 'pledger' : 'pledgers'}</span>
      </div>
    </>
  )
}

type ArtEvent = { image?: string }

/** One proposal on the board: what it asks, how far its pledges got, your pledge, and the next thing to do. */
export function ProposalCard({ p, title, art, nowSec, mine }: { p: ProposalSummary; title: string; art: ArtEvent[]; nowSec: number; mine?: Pledge }) {
  const [open, setOpen] = useState(false)
  const can = pledgeActions(p.status, mine ?? null)
  const terminal = PROPOSAL_CHIP[p.status] === 'off'
  return (
    <article className={`tr__panel pp${terminal ? ' is-closed' : ''}`}>
      <div className="pp__top">
        <MarketArt m={{ question: title, events: art }} size={44} />
        <div>
          <p className="mk__crumb">
            <span className="mk__tag">{p.kind === 'new_event' ? 'New event' : p.eventIds.length === 1 ? 'Existing event' : `Combines ${p.eventIds.length} events`}</span>
            #{p.proposalId}{p.kind === 'new_event' ? ` · ${categoryName(p.category)}` : ''}
          </p>
          <h3 className="pp__q"><Link className="gv__qlink" href={proposalHref(p.proposalId)}>{title}</Link></h3>
        </div>
        <ProposalChip p={p} nowSec={nowSec} />
      </div>
      {p.status !== 'opened' && !(terminal && p.pledgers === 0) && <PledgeProgress p={p} />}
      <p className="pc__note">
        {p.kind === 'new_event' ? `Two worlds · resolves ${utcDate(p.deadlineSec)}` : `${p.worldCount} worlds · resolves from its events`} · proposed by {accountLabel(p.proposer, 28)}
      </p>
      {mine && (mine.usdc > 0n || mine.wnear > 0n) && (
        <p className="tk__line"><span>Your pledge</span><b className="num">{pledgeWords(mine)}</b></p>
      )}
      <div className="pp__acts">
        {can.pledge && <button type="button" className="mk__btn mk__btn--buy" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Close' : 'Pledge'}</button>}
        {p.status === 'opened' && p.opened && <Link href={marketHref(p.opened.scenarioId)} className="mk__btn mk__btn--buy">Trade market #{p.opened.scenarioId}</Link>}
        <Link href={proposalHref(p.proposalId)} className="mk__btn">Details</Link>
        {mine && <PledgeExits p={p} pl={mine} compact />}
      </div>
      {open && can.pledge && (
        <div className="pp__form">
          <PledgeForm p={p} onDone={() => setOpen(false)} />
        </div>
      )}
    </article>
  )
}

/**
 * The pledge ticket: USDC or wNEAR, the amount, what the contract says the pledge would change (`pledge_preview`),
 * then T29. A pledge is real money locked until the market opens; until then it can all be withdrawn.
 */
export function PledgeForm({ p, onDone, help }: { p: Pick<ProposalSummary, 'proposalId'>; onDone?: () => void; help?: boolean }) {
  const actions = useActions()
  const cfg = useAppConfig().data
  const mp = useMarketParams().data
  const balances = useWalletBalances()
  const free = useStorageFree()
  const [asset, setAsset] = useState<Asset>('usdc')
  const [text, setText] = useState('')
  const [line, setLine] = useState<string>()
  const token = cfg ? (asset === 'wnear' ? cfg.wnear : cfg.usdc) : undefined
  const amount = token ? parseAmount(text, token.decimals) : undefined
  const debounced = useDebounced(amount, 350)
  const preview = usePledgePreview(p.proposalId, asset, debounced)
  const wallet = balances ? (asset === 'wnear' ? balances.nearWad : balances.usdcWad) : undefined
  const min = mp ? (asset === 'wnear' ? mp.params.minPledgeWnear : mp.params.minPledgeUsdc) : undefined
  const sym = asset === 'wnear' ? 'wNEAR' : 'USDC'
  const show = (x: bigint) => (asset === 'wnear' ? fmtNear(x) : fmt(x))

  let blocker: string | undefined
  if (!token) blocker = 'Reading the contract…'
  else if (text.trim() === '' || amount === undefined) blocker = 'Enter an amount'
  else if (min !== undefined && amount < min) blocker = `Smallest pledge ${show(min)} ${sym}`
  else if (wallet !== undefined && amount > wallet) blocker = `Your wallet holds ${show(wallet)} ${sym}`

  const pv = preview.data
  const pvLine = amount
    ? pv
      ? `Usable value ${fmt(pv.usableBefore, 0)} → ${fmt(pv.usableAfter, 0)} USDC; ${fmt(pv.deployedPart, 0)} of it goes into pools${pv.goalReachedAfter ? '. This pledge reaches the goal: the market opens by itself.' : '.'}`
      : preview.error
        ? humanError(preview.error.message, { asset })
        : 'Checking…'
    : min !== undefined && mp
      ? `Smallest pledge ${fmt(mp.params.minPledgeUsdc)} USDC or ${fmtNear(mp.params.minPledgeWnear)} wNEAR.`
      : ''

  return (
    <>
      <div className="pc__tabs" role="group" aria-label="Pledge in">
        {(['usdc', 'wnear'] as const).map((a) => (
          <button key={a} type="button" aria-pressed={asset === a} onClick={() => { setAsset(a); setText(''); setLine(undefined) }}>{a === 'usdc' ? 'USDC' : 'wNEAR'}</button>
        ))}
      </div>
      {help && <p className="ticket__help">Pledges become the market’s first liquidity. Until it opens you can take everything back; if it never opens, every pledge is refunded in full.</p>}
      <label className="tk__field"><span>Amount</span>
        <input inputMode="decimal" placeholder="0" value={text} onChange={(e) => setText(e.target.value.replace(/[^0-9.]/g, ''))} aria-label={`${sym} to pledge`} />
        <em>{sym}</em>
      </label>
      <p className="tk__line">
        <span>In your wallet</span>
        {wallet !== undefined
          ? <button type="button" className="tr__link" onClick={() => setText(inputText(wallet, asset === 'wnear' ? 4 : 6))}>{show(wallet)} {sym}</button>
          : <b className="num">–</b>}
      </p>
      {pvLine && <p className="pc__note">{pvLine}</p>}
      <TicketTx
        label={`Pledge ${text || '0'} ${sym}`}
        busyLabel="Pledging…"
        blocker={blocker}
        action="pledge"
        gas={GAS_MAX}
        deposit={ONE_YOCTO}
        run={async (): Promise<ActionResult> => {
          setLine(undefined)
          // a pledge is stored at the pledger's expense: top the free storage balance up first when it is nearly empty
          if (free !== undefined && free < STORAGE_MARGIN / 2n) {
            const top = await actions.send(storageDeposit(CONTRACT_ID, storageTopUp(free), false), proposalAnnounce('Storage', 'Adding a little NEAR to your storage balance…', 'Storage balance topped up'))
            if (!top.ok) return top
          }
          const tokens = toTokenCeil(amount!, token!.decimals)
          return actions.send(pledgeTx(token!.tokenId, CONTRACT_ID, tokens, p.proposalId), proposalAnnounce('Pledge', `Pledging ${text} ${sym}…`, 'Pledged'), {
            needs: { contract: true, tokens: [asset] },
            expectUsed: 'nonzero',
            onOutcome: (o) => {
              const r = pledgeResult(o)
              if (r.openScheduled) setLine('Goal reached: the market is opening. This page updates in a few seconds.')
              else if (r.openDeferred) setLine(`Pledged. The goal is reached, but the opening waits: ${humanError(r.openDeferred)}.`)
            },
          })
        }}
        onDone={() => { setText(''); onDone?.() }}
      />
      {line && <p className="pc__note gv__ok" role="status">{line}</p>}
    </>
  )
}

/**
 * Your way back out of a pledge, as the contract allows it for the proposal's status: withdraw while it is live,
 * the full refund once it closed without opening, the unused part once it opened. `compact` is the board's row.
 */
export function PledgeExits({ p, pl, compact, onLine }: { p: Pick<ProposalSummary, 'proposalId' | 'status'>; pl: Pledge; compact?: boolean; onLine?: (s: string | undefined) => void }) {
  const actions = useActions()
  const can = pledgeActions(p.status, pl)
  const tokens = { tokens: ['wnear', 'usdc'] as Asset[] }
  const Btn = compact ? SmallTx : TicketTx
  const back = (o: Parameters<typeof pledgeReturnedLine>[0]) => onLine?.(pledgeReturnedLine(o))
  return (
    <>
      {can.withdraw && (
        <Btn
          tone="sell"
          variant={compact ? 'ghost' : 'primary'}
          label={compact ? 'Withdraw pledge' : 'Withdraw everything'}
          busyLabel="Withdrawing…"
          action="withdraw_pledge"
          gas={GAS_CALL}
          run={() => actions.send(withdrawPledge(CONTRACT_ID, p.proposalId), proposalAnnounce('Pledge', 'Withdrawing your pledge…', 'Pledge withdrawn to your wallet'), { needs: tokens, onOutcome: back })}
        />
      )}
      {can.refund && (
        <Btn
          tone="buy"
          label="Get my refund"
          busyLabel="Refunding…"
          action="withdraw_pledge"
          gas={GAS_CALL}
          run={() => actions.send(withdrawPledge(CONTRACT_ID, p.proposalId), proposalAnnounce('Pledge', 'Refunding your pledge…', 'Refunded to your wallet'), { needs: tokens, onOutcome: back })}
        />
      )}
      {can.claim && (
        <Btn
          tone="buy"
          label={compact ? 'Claim unused part' : `Claim the unused part · ${pledgeWords({ usdc: pl.unusedUsdc, wnear: pl.unusedWnear })}`}
          busyLabel="Claiming…"
          action="claim_unused"
          gas={GAS_CALL}
          run={() => actions.send(claimUnused(CONTRACT_ID, p.proposalId), proposalAnnounce('Pledge', 'Claiming the unused part…', 'Unused part is in your wallet'), { needs: tokens, onOutcome: back })}
        />
      )}
    </>
  )
}

/**
 * The owner's check of a new event (T36 approve, T37 reject): the three checks, optional new opening terms, and the
 * bond's fate on a rejection. The ticks are the owner's own record and stay in this browser.
 */
export function OwnerCheck({ p, params }: { p: Pick<ProposalSummary, 'proposalId' | 'status' | 'newEvent'>; params: Pick<MarketParams, 'oddsClampBps' | 'multABps' | 'noticeSec'> }) {
  const actions = useActions()
  const [checks, setChecks] = useState({ binary: false, source: false, uncausable: false })
  const [odds, setOdds] = useState('')
  const [m0, setM0] = useState('')
  const [m1, setM1] = useState('')
  const [forfeit, setForfeit] = useState(false)
  const ne = p.newEvent
  if (!ne) return <p className="obx__empty">This proposal’s texts are no longer stored.</p>
  const [o0, o1] = ne.outcomeNames
  const reterm = odds.trim() !== '' || m0.trim() !== '' || m1.trim() !== ''
  const bps = (s: string, keep: number) => (s.trim() === '' ? keep : /^\d{1,3}$/.test(s.trim()) ? Number(s.trim()) * 100 : NaN)
  const terms = { odds0Bps: bps(odds, ne.terms.odds0Bps), multBps: [bps(m0, ne.terms.multBps[0]), bps(m1, ne.terms.multBps[1])] as [number, number] }
  const termsErr = reterm ? termsProblem(terms.odds0Bps, terms.multBps, params) : undefined
  const inReview = p.status === 'review'
  const all = checks.binary && checks.source && checks.uncausable
  let blocker: string | undefined
  if (!all) blocker = 'Tick the three checks first'
  else if (termsErr) blocker = termsErr
  else if (!inReview && !reterm) blocker = 'Approved already: change the terms to re-term it'
  const norm = normaliseTerms(terms.odds0Bps, terms.multBps)
  const box = (key: keyof typeof checks, text: string) => (
    <label className="wiz__confirm"><input type="checkbox" checked={checks[key]} onChange={(e) => setChecks((c) => ({ ...c, [key]: e.target.checked }))} />{text}</label>
  )
  return (
    <div className="gv__owner">
      {box('binary', 'The question has a clear yes or no answer by the deadline')}
      {box('source', 'The rule names a public data source anyone can read')}
      {box('uncausable', 'No trader can cause the outcome to win the market')}
      <p className="pc__note">Opening terms. Empty keeps the proposer’s: {ne.terms.odds0Bps / 100}% {o0}, NEAR at {ne.terms.multBps[0] / 100}% / {ne.terms.multBps[1] / 100}% of today.</p>
      <div className="gv__terms">
        <label className="tk__field"><span>Chance {o0}</span><input inputMode="numeric" placeholder={String(ne.terms.odds0Bps / 100)} value={odds} onChange={(e) => setOdds(e.target.value.replace(/[^0-9]/g, ''))} aria-label={`Chance of ${o0}, percent`} /><em>%</em></label>
        <label className="tk__field"><span>NEAR if {o0}</span><input inputMode="numeric" placeholder={String(ne.terms.multBps[0] / 100)} value={m0} onChange={(e) => setM0(e.target.value.replace(/[^0-9]/g, ''))} aria-label={`NEAR if ${o0}, percent of today`} /><em>%</em></label>
        <label className="tk__field"><span>NEAR if {o1}</span><input inputMode="numeric" placeholder={String(ne.terms.multBps[1] / 100)} value={m1} onChange={(e) => setM1(e.target.value.replace(/[^0-9]/g, ''))} aria-label={`NEAR if ${o1}, percent of today`} /><em>%</em></label>
      </div>
      {reterm && !termsErr && <p className="pc__note">Balanced: NEAR {norm[0] / 100}% of today if {o0}, {norm[1] / 100}% if {o1}. Openings then wait {spanWords(params.noticeSec)}.</p>}
      <TicketTx
        label={inReview ? (reterm ? 'Approve with these terms' : 'Approve') : 'Re-term'}
        busyLabel="Approving…"
        blocker={blocker}
        action="approve"
        gas={GAS_MAX}
        run={() => actions.send(approveProposal(CONTRACT_ID, p.proposalId, reterm ? terms : null), proposalAnnounce('Review', 'Approving…', inReview ? 'Approved: pledges can open it now' : 'Re-termed'))}
      />
      <label className="wiz__confirm"><input type="checkbox" checked={forfeit} onChange={(e) => setForfeit(e.target.checked)} />Keep the bond: this proposal was spam</label>
      <TicketTx
        tone="sell"
        label={forfeit ? 'Reject and keep the bond' : 'Reject'}
        busyLabel="Rejecting…"
        action="reject"
        gas={GAS_CALL}
        run={() => actions.send(rejectProposal(CONTRACT_ID, p.proposalId, forfeit), proposalAnnounce('Review', 'Rejecting…', forfeit ? 'Rejected; the bond is kept' : 'Rejected; bond and reserve go back'))}
      />
    </div>
  )
}
