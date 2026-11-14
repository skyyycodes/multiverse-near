'use client'
// Propose a market, as their five-step wizard (type, question, rule and source, checks, funding) with a live preview
// of the card, on the contract's two kinds of proposal:
//   A new event   your own yes/no question, rule, public source, deadline and opening terms; the owner checks it,
//                 pledges fund it, it opens as a two-world market (T28, bond + reserve attached)
//   Combination   one to three events that already trade; no check needed, it opens as soon as pledges reach the goal
//                 (T27)
// The contract prices both before anything is sent (`event_check`, `market_check`): the goal, the opening prices,
// the deposit, and anything that blocks it. On success the page moves to the new proposal.
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ProposalChip, TicketTx } from '../components/governance/Gov'
import { MarketArt } from '../components/Grand'
import { eventArt, useActions, useMarkets, type ChainEvent } from '../chain/adapter'
import { CONTRACT_ID } from '../chain/data/client'
import type { MarketParamsView } from '../chain/domain'
import { errorLine, humanError } from '../chain/errors'
import { fmt, fmtNear, fmtPrice, parseUtcInput, utcDate, utcInputValue, utf8Bytes } from '../chain/format'
import { PROPOSE_CATEGORIES, proposalAnnounce } from '../chain/governance'
import { useNowSeconds } from '../chain/hooks/useClock'
import { useDebounced } from '../chain/hooks/useDebounced'
import { useEventCheck, useMarketCheck, useMarketParams, useProposalList } from '../chain/hooks/useProposal'
import { marketHref, proposalHref } from '../chain/links'
import { categoryName } from '../chain/market'
import { createdProposalId } from '../chain/near/outcome'
import { GAS_MAX, proposeEvent, proposeMarket } from '../chain/near/tx'
import {
  deadlineSpreadNote,
  eventFormErrors,
  LIMITS,
  MAX_EVENTS,
  nearText,
  normaliseTerms,
  parseEventsParam,
  proposalDeposit,
  proposalTitle,
  togglePick,
  worldLabels,
  worldsOf,
  type EventForm,
} from '../chain/proposals'

type Kind = 'event' | 'market'
const STEPS = ['Type', 'Question', 'Rule and source', 'Checks', 'Funding'] as const
const DRAFT_KEY = 'ifverse.propose.draft'

const blank = (): EventForm => ({ question: '', outcomes: ['YES', 'NO'], rule: '', source: '', deadlineSec: undefined, category: 1, odds0Bps: 5_000, multBps: [11_000, 9_000] })

function loadDraft(): EventForm {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY)
    if (!raw) return blank()
    const d = JSON.parse(raw) as Partial<EventForm>
    const b = blank()
    return {
      question: typeof d.question === 'string' ? d.question : b.question,
      outcomes: Array.isArray(d.outcomes) && d.outcomes.length === 2 ? [String(d.outcomes[0]), String(d.outcomes[1])] : b.outcomes,
      rule: typeof d.rule === 'string' ? d.rule : b.rule,
      source: typeof d.source === 'string' ? d.source : b.source,
      deadlineSec: typeof d.deadlineSec === 'number' ? d.deadlineSec : undefined,
      category: typeof d.category === 'number' ? d.category : b.category,
      odds0Bps: typeof d.odds0Bps === 'number' ? d.odds0Bps : b.odds0Bps,
      multBps: Array.isArray(d.multBps) && d.multBps.length === 2 ? [Number(d.multBps[0]), Number(d.multBps[1])] : b.multBps,
    }
  } catch {
    return blank()
  }
}

function saveDraft(f: EventForm | null) {
  try {
    if (f) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(f))
    else sessionStorage.removeItem(DRAFT_KEY)
  } catch {
    // blocked storage only loses the draft
  }
}

/** A whole percentage typed by the viewer, as bps; anything else is NaN so the check names it. */
const pctToBps = (s: string) => (/^\d{1,3}$/.test(s.trim()) ? Number(s.trim()) * 100 : NaN)
const bytes = (v: string, max: number) => <small className="gv__bytes">{utf8Bytes(v)} / {max}</small>

export default function CreateMarket() {
  const router = useRouter()
  const search = useSearchParams()
  const initialEvents = useMemo(() => parseEventsParam(search.get('events')), [search])
  const actions = useActions()
  const mp = useMarketParams()
  const nowSec = Number(useNowSeconds())
  const proposals = useProposalList('all', 50)

  // ---- the wizard ----
  const [kind, setKind] = useState<Kind>(search.get('kind') === 'market' || initialEvents.length > 0 ? 'market' : 'event')
  const [step, setStep] = useState(initialEvents.length > 0 ? 1 : 0)

  // Kind A: the form, kept in this tab's session storage while it is written
  // (the page renders in the browser only, under RoutePage's Suspense, so the draft is read on the first render)
  const [f, setF] = useState<EventForm>(loadDraft)
  useEffect(() => saveDraft(f), [f])
  const set = (patch: Partial<EventForm>) => setF((x) => ({ ...x, ...patch }))
  const [mult, setMult] = useState<[string, string]>(() => [String(Math.round(f.multBps[0] / 100)), String(Math.round(f.multBps[1] / 100))])
  const [notCausable, setNotCausable] = useState(false)

  // Kind B: events of the listed markets, still open
  const { markets, isLoading: marketsLoading, error: marketsError } = useMarkets()
  const [picked, setPicked] = useState<number[]>(initialEvents)
  const [refused, setRefused] = useState(false)
  const candidates = useMemo(() => {
    const byId = new Map<number, ChainEvent>()
    for (const m of markets ?? []) for (const e of m.events) if (!e.finalized && !byId.has(e.id)) byId.set(e.id, e)
    return [...byId.values()].sort((a, b) => a.id - b.id)
  }, [markets])
  const marketsOf = (id: number) => (markets ?? []).filter((m) => m.events.some((e) => e.id === id)).length
  const pickedEvents = picked.map((id) => candidates.find((e) => e.id === id)).filter((e): e is ChainEvent => Boolean(e))
  const check = useMarketCheck(kind === 'market' ? picked : [])
  const c = check.data && check.data.canonical.join(',') === [...picked].sort((a, b) => a - b).join(',') ? check.data : undefined

  // Kind A checks against the contract, once the parts it prices are valid
  const p = mp.data
  const errors = p ? eventFormErrors(f, nowSec, p.params) : {}
  const earliest = p ? nowSec + p.params.minPledgeWindowSec + p.params.minMarketLifeSec : undefined
  const checkArgs = useDebounced(
    kind === 'event' && !errors.question && !errors.deadline && !errors.terms && f.deadlineSec !== undefined
      ? { question: f.question, terms: { odds0Bps: f.odds0Bps, multBps: f.multBps }, deadlineSec: f.deadlineSec }
      : undefined,
    400,
  )
  const ec = useEventCheck(checkArgs).data
  const o0 = f.outcomes[0].trim() || 'outcome 1'
  const o1 = f.outcomes[1].trim() || 'outcome 2'

  // what a submit attaches, and what stops it
  const W = kind === 'event' ? 2 : (c?.worldCount ?? worldsOf(Math.max(1, picked.length)))
  const deposit = kind === 'event' ? (ec ? ec.bond + ec.reserve : p ? proposalDeposit('new_event', 2, p).total : undefined) : c ? c.bond + c.reserve : p ? proposalDeposit('market', W, p).total : undefined
  const checks: readonly (readonly [string, boolean, string?])[] = kind === 'event'
    ? [
      ['A clear question with two outcomes', !errors.question && !errors.outcome0 && !errors.outcome1, errors.question ?? errors.outcome0 ?? errors.outcome1],
      ['An exact rule for deciding it', !errors.rule, errors.rule],
      ['A public data source', !errors.source, errors.source],
      ['A deadline far enough out', !errors.deadline, errors.deadline],
      ['Not proposed already', ec ? ec.liveProposal === null : false, ec?.liveProposal != null ? `Proposal #${ec.liveProposal} asks the same question` : undefined],
      ['The contract can price it today', ec ? ec.blocker === null : false, ec?.blocker ? humanError(ec.blocker) : undefined],
      ['No trader could easily make it happen', notCausable],
    ]
    : [
      [`One to ${MAX_EVENTS} open events`, picked.length > 0 && picked.length <= MAX_EVENTS],
      ['Not a market already', c ? c.listedMarket === null : false, c?.listedMarket != null ? `Market #${c.listedMarket} is this combination` : undefined],
      ['Not proposed already', c ? c.liveProposal === null : false, c?.liveProposal != null ? `Proposal #${c.liveProposal} is collecting pledges for it` : undefined],
      ['The contract can price it today', c ? c.blocker === null : false, c?.blocker ? humanError(c.blocker) : check.isError ? 'Could not check this combination' : undefined],
    ]
  const termsOk = !errors.terms
  const stepOk = kind === 'event'
    ? [true, checks[0][1], checks[1][1] && checks[2][1] && checks[3][1], checks.every(([, ok]) => ok), termsOk && Boolean(ec) && ec?.blocker === null && ec?.liveProposal === null]
    : [true, checks[0][1], true, checks.every(([, ok]) => ok), checks.every(([, ok]) => ok)]
  const submitBlocker = !p ? 'Reading the contract…' : !stepOk.every(Boolean) ? (kind === 'event' ? (Object.values(errors)[0] ?? (ec ? 'Finish the checks' : 'Pricing the opening…')) : picked.length === 0 ? 'Pick one to three events' : !c ? 'Checking…' : 'Finish the checks') : undefined

  const submit = () =>
    actions.send(
      kind === 'event'
        ? proposeEvent(CONTRACT_ID, { question: f.question, outcomeNames: [f.outcomes[0], f.outcomes[1]], rule: f.rule, source: f.source, deadlineSec: f.deadlineSec!, category: f.category, terms: { odds0Bps: f.odds0Bps, multBps: f.multBps } }, deposit!)
        : proposeMarket(CONTRACT_ID, picked, deposit!),
      proposalAnnounce('Proposal', 'Proposing…', 'Proposed: pledges can start'),
      {
        needs: { contract: true },
        onOutcome: (o) => {
          const pid = createdProposalId(o)
          if (kind === 'event') saveDraft(null)
          if (pid !== undefined) router.push(proposalHref(pid))
        },
      },
    )

  // the preview card
  const title = kind === 'event' ? f.question.trim() || 'Your question' : pickedEvents.map((e) => e.question).join(' × ') || 'Pick the events'
  const art = kind === 'event' ? [{ image: eventArt({ rule: '', question: f.question, finalized: false }) }] : pickedEvents.map((e) => ({ image: e.image }))
  const previewWorlds = kind === 'event' ? worldLabels([{ outcomeNames: [o0, o1] }]) : pickedEvents.length ? worldLabels(pickedEvents.map((e) => ({ outcomeNames: e.outcomes }))) : []
  const chances = kind === 'event' && termsOk ? [f.odds0Bps / 10_000, 1 - f.odds0Bps / 10_000] : undefined
  const goal = kind === 'event' ? ec?.goal : c?.goal
  const resolves = kind === 'event' ? (f.deadlineSec ? utcDate(f.deadlineSec) : 'Not set') : pickedEvents.length ? utcDate(pickedEvents.reduce((t, e) => Math.max(t, e.deadlineSec), 0)) : '–'

  const live = (proposals.data?.proposals ?? []).filter((x) => x.status === 'pledging' || x.status === 'review')
  const all = proposals.data?.proposals ?? []

  return (
    <div className="page tr desk gv">
      <header className="tr__pair">
        <div className="tr__id">
          <p className="mk__crumb"><span className="mk__tag">Pledge-funded markets</span>Anyone can propose; the contract opens it once pledges reach the goal</p>
          <h1 className="mk__title">Propose a market</h1>
          <p className="tr__means">Ask a new yes/no question with a rule and a public data source, or combine events that already trade. People pledge USDC or wNEAR; at the goal the market opens with that money already inside.</p>
        </div>
        <dl className="tr__stats">
          <div><dt>Proposals</dt><dd className="num">{proposals.data ? all.length : '–'}</dd></div>
          <div><dt>Collecting</dt><dd className="num">{proposals.data ? live.length : '–'}</dd></div>
          <div><dt>Opened</dt><dd className="num">{proposals.data ? all.filter((x) => x.status === 'opened').length : '–'}</dd></div>
        </dl>
      </header>

      <div className="pc__tabs desk__filter pp__tabs" role="group" aria-label="View">
        <button type="button" aria-pressed={false} onClick={() => router.push('/proposals/')}>Browse proposals</button>
        <button type="button" aria-pressed>New proposal</button>
      </div>

      <div className="mk__grid">
        <div className="mk__main">
          <ol className="wiz" aria-label="Steps">
            {STEPS.map((t, i) => (
              <li key={t}>
                <button type="button" className={i === step ? 'is-now' : i < step ? 'is-done' : ''} aria-current={i === step ? 'step' : undefined} onClick={() => (i <= step || stepOk.slice(0, i).every(Boolean) ? setStep(i) : undefined)}>
                  <span className="num">{i < step ? '✓' : i + 1}</span>{kind === 'market' && i === 1 ? 'Events' : kind === 'market' && i === 2 ? 'Rules' : t}
                </button>
              </li>
            ))}
          </ol>

          <section className="tr__panel wiz__panel">
            {!p ? (
              <p className="obx__empty" role="status">{mp.error ? errorLine(mp.error.message) : 'Reading the contract’s rules for proposals…'}</p>
            ) : (
              <>
                {step === 0 && (
                  <>
                    <h2 className="obx__boxtitle">What kind of market?</h2>
                    <div className="wiz__choices">
                      <button type="button" aria-pressed={kind === 'event'} onClick={() => setKind('event')}>
                        <b>A new event</b>
                        <span>Your own yes/no question. It needs an exact rule, a public source and the owner’s check before pledges can open it. Two worlds.</span>
                      </button>
                      <button type="button" aria-pressed={kind === 'market'} onClick={() => setKind('market')}>
                        <b>Combine events</b>
                        <span>One to three events that already trade, like SPICE × the Fed. They are checked already, so it opens as soon as it is funded. Each event doubles the worlds.</span>
                      </button>
                    </div>
                    <p className="pc__note">
                      You attach {kind === 'event' ? nearText(p.params.bondNewEvent + p.reserveW2) : `${nearText(p.params.bondMarket + p.reserveW2)} to ${nearText(p.params.bondMarket + p.reserveW8)}`} NEAR: a bond, back {kind === 'event' ? 'at approval' : 'when it opens or ends normally'}, plus a storage reserve for the new market.
                    </p>
                  </>
                )}

                {step === 1 && (kind === 'market' ? (
                  <>
                    <h2 className="obx__boxtitle">Pick one to three events</h2>
                    <p className="tr__means">Order does not matter: A × B and B × A are the same market. Their combinations become the worlds.</p>
                    {marketsLoading && !markets ? (
                      <p className="obx__empty" role="status">Reading the events…</p>
                    ) : marketsError && !markets ? (
                      <p className="pc__note">{errorLine(marketsError.message)}</p>
                    ) : candidates.length === 0 ? (
                      <p className="obx__empty">No open event to combine yet.</p>
                    ) : (
                      <div className="wiz__events">
                        {candidates.map((e) => (
                          <button key={e.id} type="button" aria-pressed={picked.includes(e.id)} onClick={() => { const r = togglePick(picked, e.id); setRefused(r.refused); setPicked(r.next) }}>
                            {e.image ? <img src={e.image} alt="" width={32} height={32} className="art" /> : <span className="art art--blank" style={{ width: 32, height: 32 }} aria-hidden>{e.question.slice(0, 1)}</span>}
                            <span><b>{e.question}</b><small>{e.outcomes.join(' or ')} · {e.deadline} · in {marketsOf(e.id)} {marketsOf(e.id) === 1 ? 'market' : 'markets'}</small></span>
                          </button>
                        ))}
                      </div>
                    )}
                    {refused && <p className="ov__warn">At most {MAX_EVENTS} events: a market has up to {worldsOf(MAX_EVENTS)} worlds.</p>}
                  </>
                ) : (
                  <>
                    <h2 className="obx__boxtitle">The question</h2>
                    <label className="create__field"><span>Question {bytes(f.question, LIMITS.question)}</span>
                      <input value={f.question} onChange={(e) => set({ question: e.target.value })} placeholder="Will NEAR Intents pass $1B in monthly volume by 30 June 2027?" aria-invalid={Boolean(f.question && errors.question) || undefined} />
                    </label>
                    {f.question && errors.question && <p className="pc__note gv__err">{errors.question}</p>}
                    <div className="wiz__row">
                      <label className="create__field"><span>First outcome</span><input value={f.outcomes[0]} onChange={(e) => set({ outcomes: [e.target.value, f.outcomes[1]] })} /></label>
                      <label className="create__field"><span>Second outcome</span><input value={f.outcomes[1]} onChange={(e) => set({ outcomes: [f.outcomes[0], e.target.value] })} /></label>
                      <label className="create__field"><span>Category</span>
                        <select value={f.category} onChange={(e) => set({ category: Number(e.target.value) })}>{PROPOSE_CATEGORIES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
                      </label>
                    </div>
                    {(errors.outcome0 || errors.outcome1) && <p className="pc__note gv__err">{errors.outcome0 ?? errors.outcome1}</p>}
                    <p className="pc__note">The first outcome is the one your opening chance is about. Names are shown in capitals on the market, like SHIPS or CUTS.</p>
                  </>
                ))}

                {step === 2 && (kind === 'market' ? (
                  <>
                    <h2 className="obx__boxtitle">Rules come from the events</h2>
                    {pickedEvents.length === 0 ? <p className="obx__empty">Pick the events first.</p> : (
                      <div className="mk__rules">
                        {pickedEvents.map((e) => (
                          <div key={e.id} className="mk__rule">
                            {e.image ? <img src={e.image} alt="" width={36} height={36} className="art" /> : <span className="art art--blank" style={{ width: 36, height: 36 }} aria-hidden>{e.question.slice(0, 1)}</span>}
                            <div>
                              <h3>{e.question}</h3>
                              <p>{e.rule}</p>
                              <p className="pc__note">{e.sources.length ? `Source: ${e.sources.join(', ')} · ` : ''}deadline {e.deadline}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {deadlineSpreadNote(pickedEvents.map((e) => ({ question: e.question, deadline: e.state.deadline }))) && (
                      <p className="ov__warn">{deadlineSpreadNote(pickedEvents.map((e) => ({ question: e.question, deadline: e.state.deadline })))}</p>
                    )}
                  </>
                ) : (
                  <>
                    <h2 className="obx__boxtitle">How it resolves</h2>
                    <label className="create__field"><span>Exact rule {bytes(f.rule, LIMITS.rule)}</span>
                      <textarea rows={5} value={f.rule} onChange={(e) => set({ rule: e.target.value })} placeholder={`${o0.toUpperCase()} if … on the source below, as of … UTC; otherwise ${o1.toUpperCase()}.`} />
                    </label>
                    {f.rule && errors.rule && <p className="pc__note gv__err">{errors.rule}</p>}
                    <div className="wiz__row">
                      <label className="create__field"><span>Public data source {bytes(f.source, LIMITS.source)}</span>
                        <input value={f.source} onChange={(e) => set({ source: e.target.value })} placeholder="https://… or a named public dataset" />
                      </label>
                      <label className="create__field"><span>Deadline (UTC)</span>
                        <input type="datetime-local" value={f.deadlineSec === undefined ? '' : utcInputValue(f.deadlineSec)} min={earliest === undefined ? undefined : utcInputValue(earliest)} onChange={(e) => set({ deadlineSec: parseUtcInput(e.target.value) })} />
                      </label>
                    </div>
                    {f.source && errors.source && <p className="pc__note gv__err">{errors.source}</p>}
                    <p className={`pc__note${f.deadlineSec !== undefined && errors.deadline ? ' gv__err' : ''}`}>
                      {f.deadlineSec !== undefined && errors.deadline ? errors.deadline : `At least ${earliest ? utcDate(earliest) : '…'}: the pledging window plus the market’s shortest life. Trading stops at the deadline; the result comes from this source, with a dispute window.`}
                    </p>
                  </>
                ))}

                {step === 3 && (
                  <>
                    <h2 className="obx__boxtitle">Checks before it can open</h2>
                    <ul className="wiz__checks">
                      {checks.map(([t, ok, why]) => (
                        <li key={t} className={ok ? 'is-ok' : ''}><i aria-hidden>{ok ? '✓' : '·'}</i><span>{t}{!ok && why ? <small className="gv__why">{why}</small> : null}</span></li>
                      ))}
                    </ul>
                    {kind === 'event' && (
                      <label className="wiz__confirm"><input type="checkbox" checked={notCausable} onChange={(e) => setNotCausable(e.target.checked)} />No trader could easily make this happen. A question like “will project X get hacked?” is rejected.</label>
                    )}
                    {kind === 'market' && c?.listedMarket != null && <p className="tk__line"><span>This market already exists</span><Link className="tr__link" href={marketHref(c.listedMarket)}>Open market #{c.listedMarket}</Link></p>}
                    {kind === 'market' && c?.liveProposal != null && <p className="tk__line"><span>Proposed already</span><Link className="tr__link" href={proposalHref(c.liveProposal)}>Pledge to #{c.liveProposal} instead</Link></p>}
                    {kind === 'event' && ec?.liveProposal != null && <p className="tk__line"><span>Proposed already</span><Link className="tr__link" href={proposalHref(ec.liveProposal)}>Pledge to #{ec.liveProposal} instead</Link></p>}
                    <p className="pc__note">{kind === 'event' ? 'The owner checks three things before pledges can open it: a clear answer, a public source, and that nobody can cause the outcome. Pledging may start while it is reviewed.' : 'A combination of listed events needs no owner check: the contract prices it from the events’ own markets.'}</p>
                  </>
                )}

                {step === 4 && (kind === 'event' ? (
                  <EventFunding f={f} set={set} mult={mult} setMult={setMult} p={p} o0={o0} o1={o1} ec={ec} errors={errors.terms} />
                ) : (
                  <>
                    <h2 className="obx__boxtitle">Funding goal</h2>
                    <p className="tr__means">The contract sets the goal from how deep the new pools must be. Pledges become the market’s first liquidity, split across its worlds.</p>
                    {!c ? <p className="obx__empty" role="status">{picked.length ? 'Checking the combination…' : 'Pick the events first.'}</p> : (
                      <>
                        <p className="tk__line"><span>Worlds · pools</span><b className="num">{c.worldCount} worlds · {2 * c.worldCount - 1} pools</b></p>
                        <p className="tk__line"><span>Pledge goal</span><b className="num">{fmt(c.goal, 0)} USDC</b></p>
                        <p className="tk__line"><span>Best mix</span><b className="num">≈ {fmtNear(c.idealWnear)} wNEAR + {fmt(c.idealUsdc, 0)} USDC</b></p>
                        <p className="tk__line"><span>Pledging closes</span><b className="num">{c.expiresAtSec ? utcDate(c.expiresAtSec) : '–'}</b></p>
                        <p className="tk__line"><span>You attach now</span><b className="num">{nearText(c.bond + c.reserve)} NEAR</b></p>
                        <p className="pc__note">Bond {nearText(c.bond)} NEAR, back when it opens or ends normally, and kept if you cancel it. Reserve {nearText(c.reserve)} NEAR pays the new market’s storage; the rest comes back.</p>
                      </>
                    )}
                  </>
                ))}

                <div className="wiz__nav">
                  {step > 0 && <button type="button" className="mk__btn" onClick={() => setStep(step - 1)}>Back</button>}
                  {step < STEPS.length - 1 ? (
                    <button type="button" className="mk__btn mk__btn--buy" disabled={!stepOk[step]} onClick={() => setStep(step + 1)}>Next: {kind === 'market' && step + 1 === 1 ? 'Events' : kind === 'market' && step + 1 === 2 ? 'Rules' : STEPS[step + 1]}</button>
                  ) : (
                    <TicketTx
                      label={deposit !== undefined ? `Propose · ${nearText(deposit)} NEAR` : 'Propose'}
                      busyLabel="Proposing…"
                      blocker={submitBlocker}
                      action="propose"
                      gas={GAS_MAX}
                      deposit={deposit ?? 0n}
                      run={submit}
                    />
                  )}
                </div>
              </>
            )}
          </section>
        </div>

        <aside className="mk__side">
          <section className="tr__panel">
            <h2 className="obx__boxtitle">Preview</h2>
            <div className="mk-card desk__mcard wiz__preview">
              <span className="mk-card__head"><MarketArt m={{ question: title, events: art }} size={44} /><span className="mk-card__q">{title}</span></span>
              <span className="mk-card__worlds">
                {previewWorlds.length === 0 ? <span className="pc__note">The worlds appear as you pick events.</span> : previewWorlds.map((w, i) => (
                  <span key={w} className="mk-card__world">
                    <span className="mk-card__name">{w.split('·').map((x) => x.charAt(0) + x.slice(1).toLowerCase()).join(' & ')}</span>
                    {chances ? <><span className="mk-card__track"><i style={{ width: `${chances[i] * 100}%` }} /></span><b className="num">{Math.round(chances[i] * 100)}%</b></> : <><span /><b className="num gv__dim">–</b></>}
                  </span>
                ))}
              </span>
              <span className="mk-card__foot">
                <span>{kind === 'event' ? categoryName(f.category) : 'Combination'}</span>
                <span>Goal <b className="num">{goal !== undefined ? `$${fmt(goal, 0)}` : '–'}</b></span>
                <span>{resolves}</span>
              </span>
            </div>
            <p className="pc__note">{kind === 'event' ? 'The two worlds open at the chance you set; trading moves it from there.' : 'Each world opens at the odds the events’ own markets give at that moment.'}</p>
          </section>

          <section className="tr__panel">
            <div className="desk__head"><h2 className="obx__boxtitle">Collecting pledges</h2><Link className="tr__link" href="/proposals/">All proposals</Link></div>
            {proposals.isPending ? <p className="obx__empty" role="status">Reading the proposals…</p> : live.length === 0 ? <p className="obx__empty">No proposal is collecting pledges right now.</p> : (
              <div className="gv__list">
                {live.slice(0, 6).map((x) => (
                  <Link key={x.proposalId} href={proposalHref(x.proposalId)} className="gv__row">
                    <span><b>{proposalTitle(x, (id) => candidates.find((e) => e.id === id)?.question)}</b><small>#{x.proposalId} · {x.kind === 'new_event' ? 'new event' : `${x.worldCount} worlds`} · {(x.progressBps / 100).toFixed(0)}% of {fmt(x.goal, 0)} USDC</small></span>
                    <ProposalChip p={x} nowSec={nowSec} />
                  </Link>
                ))}
              </div>
            )}
            <p className="pc__note">Pledge to one of these instead of proposing it again.</p>
          </section>

          <RulesPanel p={p} />
        </aside>
      </div>
    </div>
  )
}

/** Step 5 of a new event: the opening terms (chance, NEAR in each world as a share of today) and what they cost. */
function EventFunding({ f, set, mult, setMult, p, o0, o1, ec, errors }: {
  f: EventForm
  set: (patch: Partial<EventForm>) => void
  mult: [string, string]
  setMult: (m: [string, string]) => void
  p: MarketParamsView
  o0: string
  o1: string
  ec: ReturnType<typeof useEventCheck>['data']
  errors?: string
}) {
  const norm = normaliseTerms(f.odds0Bps, f.multBps)
  const clamp = p.params.oddsClampBps / 100
  return (
    <>
      <h2 className="obx__boxtitle">Opening terms and goal</h2>
      <p className="tr__means">Where the market starts: the chance of {o0}, and NEAR’s price in each world as a share of today’s. The contract balances them to today’s price and sets the goal from them.</p>
      <label className="create__field gv__range">
        <span>Chance of {o0} <b className="num">{f.odds0Bps / 100}%</b></span>
        <input type="range" min={Math.max(1, clamp)} max={Math.min(99, 100 - clamp)} step={1} value={f.odds0Bps / 100} onChange={(e) => set({ odds0Bps: Number(e.target.value) * 100 })} aria-label={`Chance of ${o0}`} />
      </label>
      <div className="wiz__row">
        {[0, 1].map((i) => (
          <label key={i} className="tk__field"><span>NEAR if {i === 0 ? o0 : o1}</span>
            <input inputMode="numeric" value={mult[i]} onChange={(e) => {
              const next: [string, string] = i === 0 ? [e.target.value, mult[1]] : [mult[0], e.target.value]
              setMult(next)
              set({ multBps: [pctToBps(next[0]), pctToBps(next[1])] })
            }} aria-label={`NEAR if ${i === 0 ? o0 : o1}, percent of today`} />
            <em>% of today</em>
          </label>
        ))}
      </div>
      <p className={`pc__note${errors ? ' gv__err' : ''}`}>{errors ?? `Balanced: NEAR ${norm[0] / 100}% of today if ${o0}, ${norm[1] / 100}% if ${o1}. Each must stay between ${p.params.multABps[0] / 100}% and ${p.params.multABps[1] / 100}%.`}</p>
      {ec && ec.sRef !== null ? (
        <>
          <p className="tk__line"><span>Today’s NEAR price</span><b className="num">{fmtPrice(ec.sRef)}</b></p>
          <p className="tk__line"><span>Opening price if {o0}</span><b className="num">{fmtPrice(ec.prices[0])}</b></p>
          <p className="tk__line"><span>Opening price if {o1}</span><b className="num">{fmtPrice(ec.prices[1])}</b></p>
          <p className="tk__line"><span>Pledge goal</span><b className="num">{fmt(ec.goal, 0)} USDC</b></p>
          <p className="tk__line"><span>Best mix</span><b className="num">≈ {fmtNear(ec.idealWnear)} wNEAR + {fmt(ec.idealUsdc, 0)} USDC</b></p>
          <p className="tk__line"><span>You attach now</span><b className="num">{nearText(ec.bond + ec.reserve)} NEAR</b></p>
          <p className="pc__note">Bond {nearText(ec.bond)} NEAR, back at approval (kept only if the owner rejects it as spam). Reserve {nearText(ec.reserve)} NEAR pays the new market’s storage; the rest comes back.</p>
          {ec.blocker && <p className="ov__warn">{humanError(ec.blocker)}</p>}
        </>
      ) : (
        <p className="obx__empty" role="status">{errors ? 'Fix the terms to price the opening.' : 'Pricing the opening…'}</p>
      )}
    </>
  )
}

function RulesPanel({ p }: { p: MarketParamsView | undefined }) {
  if (!p) return null
  return (
    <section className="tr__panel">
      <h2 className="obx__boxtitle">How proposals work</h2>
      <ol className="steps steps--col">
        <li><span className="steps__n">1</span><b>Bond and reserve</b><p>A refundable bond plus a storage reserve. The bond is kept only if a combination is cancelled, or a proposal ends with less than {p.params.spamFloorBps / 100}% of its goal.</p></li>
        <li><span className="steps__n">2</span><b>Pledges are real money</b><p>Locked until the market opens; until then every pledger can withdraw everything.</p></li>
        <li><span className="steps__n">3</span><b>It opens by itself</b><p>At the goal, a combination opens at once and a new event once the owner approved it. Pledges become the starting liquidity.</p></li>
        <li><span className="steps__n">4</span><b>Or every pledge comes back</b><p>If it expires, is rejected, or an event resolves first, every pledge is refunded in full.</p></li>
      </ol>
    </section>
  )
}
