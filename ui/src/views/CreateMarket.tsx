// Propose a market, built from how user-created markets are usually made (Manifold's creation form: question, close
// date, rule, liquidity as a subsidy; Chomp's five-step wizard) and the pledge flow on the roadmap (LEARN.md):
// propose → pledge from both sides → check → open already funded → resolve from public data.
//   Browse   proposals being funded, with a two-sided pledge bar, goal, backers, days left and status
//   New      a five-step wizard (type, question, rule and source, checks, funding) with a live preview of the card
// Demo only: the contract lets only the owner open markets today.
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MarketArt, WorldIcon } from '../components/Grand'
import { WorldMap } from '../components/WorldMap'
import { Button } from '../components/ui'
import { DEPOSIT, MIN_GOAL, isFunded, pledges, usePledges, type PledgeKind, type PledgeProposal } from '../lib/pledges'
import { actions, buildWorlds, fresh, useStore } from '../lib/scenario'
import type { Market, ScenarioEvent } from '../lib/types'
import { useWallet } from '../lib/wallet'

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
const ART = ['/markets/spice.svg', '/markets/fed.svg', '/markets/near-price.svg', '/markets/fed-oct.svg']
const STEPS = ['Type', 'Question', 'Rule and source', 'Checks', 'Funding'] as const
const asMarket = (p: { question: string; category: string; events: ScenarioEvent[]; deadline: string }, id = 'draft'): Market =>
  ({ id, question: p.question || 'Your market question', category: p.category, resolves: p.deadline || 'Not set', events: p.events, worlds: buildWorlds(p.events) })

// one proposal on the board
function ProposalCard({ p }: { p: PledgeProposal }) {
  const { account, connectDemo } = useWallet()
  const { wallet } = useStore()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [side, setSide] = useState<'hedge' | 'take'>('hedge')
  const [amount, setAmount] = useState('')
  const a = Number(amount) || 0
  const total = p.pledged.hedge + p.pledged.take
  const m = asMarket(p, `p${p.id}`)
  const openMarket = () => {
    const mk = actions.createMarket(p.question, p.events, p.deadline)
    pledges.opened(p.id, mk.id)
    router.push(`/market/?id=${mk.id}`)
  }
  return (
    <article className={`tr__panel pp${p.status !== 'pledging' ? ` is-${p.status}` : ''}`}>
      <div className="pp__top">
        <MarketArt m={m} size={44} />
        <div>
          <p className="mk__crumb"><span className="mk__tag">{p.kind === 'combo' ? 'Combines existing events' : 'New event'}</span>{p.category}</p>
          <h3 className="pp__q">{p.question}</h3>
        </div>
        <span className={`rs__state ${p.status === 'open' ? 'rs__state--final' : p.status === 'review' ? 'rs__state--live' : 'rs__state--open'}`}>
          {p.status === 'open' ? 'Funded · opens' : p.status === 'review' ? 'Funded · owner check' : `${p.daysLeft} days left`}
        </span>
      </div>
      <div className="pp__bar" aria-label={`${fmt(total)} of ${fmt(p.goal)} USDC pledged`}>
        <i className="pp__hedge" style={{ width: `${Math.min(100, (p.pledged.hedge / p.goal) * 100)}%` }} />
        <i className="pp__take" style={{ width: `${Math.min(100 - Math.min(100, (p.pledged.hedge / p.goal) * 100), (p.pledged.take / p.goal) * 100)}%` }} />
      </div>
      <div className="pp__nums">
        <span><b className="num">${fmt(total)}</b> of ${fmt(p.goal)}</span>
        <span><i className="pp__dot pp__dot--hedge" />Hedgers ${fmt(p.pledged.hedge)}</span>
        <span><i className="pp__dot pp__dot--take" />Takers ${fmt(p.pledged.take)}</span>
        <span>{p.backers} backers</span>
      </div>
      <p className="pp__rule">{p.rule}</p>
      <p className="pc__note">Source: {p.source} · resolves {p.deadline} · proposed by {p.author.replace('.multiverse-near.testnet', '')}</p>
      {p.yours > 0 && <p className="tk__line"><span>Your pledge</span><b className="num">{fmt(p.yours)} USDC</b></p>}

      <div className="pp__acts">
        {p.status === 'pledging' && <button type="button" className="mk__btn mk__btn--buy" onClick={() => setOpen(!open)}>{open ? 'Close' : 'Pledge'}</button>}
        {p.status === 'review' && <button type="button" className="mk__btn mk__btn--buy" onClick={() => pledges.approve(p.id)}>Approve (owner, demo)</button>}
        {p.status === 'open' && (p.marketId
          ? <Link href={`/market/?id=${p.marketId}`} className="mk__btn mk__btn--buy">Open the market</Link>
          : <button type="button" className="mk__btn mk__btn--buy" onClick={openMarket}>Open it with the pledged money</button>)}
      </div>

      {open && p.status === 'pledging' && (
        <div className="pp__form">
          {!account ? <button type="button" className="mk__btn" onClick={connectDemo}>Use the demo wallet to pledge</button> : (
            <>
              <div className="pc__tabs" role="group" aria-label="Which side">
                <button type="button" aria-pressed={side === 'hedge'} onClick={() => setSide('hedge')}>I want to hedge</button>
                <button type="button" aria-pressed={side === 'take'} onClick={() => setSide('take')}>I’ll take the other side</button>
              </div>
              <p className="ticket__help">{side === 'hedge' ? 'You’ll want to sell NEAR in the worlds you fear once it opens.' : 'You’re happy to buy NEAR cheaply in the feared worlds, or add liquidity to them.'} The USDC is locked until the market opens, and comes back if it doesn’t.</p>
              <label className="tk__field"><span>Amount</span>
                <input inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="USDC to pledge" />
                <em>USDC</em>
              </label>
              <p className="tk__line"><span>In your wallet</span><b className="num">{fmt(wallet.usdc)} USDC</b></p>
              <div className={`tk ${side === 'hedge' ? 'tk--sell' : 'tk--buy'}`}>
                <Button onClick={() => { if (actions.pledge(a, p.question, side)) { pledges.pledge(p.id, side, a); setAmount(''); setOpen(false) } }} disabled={!(a > 0) || a > wallet.usdc + 1e-9}>
                  {a > wallet.usdc + 1e-9 ? 'More than your wallet holds (get test tokens)' : a > 0 ? `Pledge ${fmt(a)} USDC` : 'Enter an amount'}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </article>
  )
}

export default function CreateMarket() {
  const list = usePledges()
  const { markets, wallet } = useStore()
  const { account, connectDemo } = useWallet()
  const [tab, setTab] = useState<'browse' | 'new'>('browse')
  const [filter, setFilter] = useState<'all' | 'pledging' | 'funded'>('all')

  // the wizard
  const [step, setStep] = useState(0)
  const [kind, setKind] = useState<PledgeKind>('new')
  const existing = useMemo(() => [...new Map(markets.filter((m) => !m.settled).flatMap((m) => m.events).map((e) => [e.name, e])).values()], [markets])
  const [combo, setCombo] = useState<string[]>([])
  const [question, setQuestion] = useState('')
  const [category, setCategory] = useState('NEAR')
  const [image, setImage] = useState(ART[0])
  const [yes, setYes] = useState('Yes')
  const [no, setNo] = useState('No')
  const [rule, setRule] = useState('')
  const [source, setSource] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [deadline, setDeadline] = useState('')
  const [notCausable, setNotCausable] = useState(false)
  const [goal, setGoal] = useState('10000')
  const [done, setDone] = useState<number | null>(null)

  const events: ScenarioEvent[] = kind === 'combo'
    ? existing.filter((e) => combo.includes(e.name))
    : [{ name: question.trim().slice(0, 40) || 'The question', outcomes: [yes.trim() || 'Yes', no.trim() || 'No'], sources: [source.trim() || 'Source', sourceUrl.trim() || source.trim() || 'Source'], image, rule, deadline }]
  const q = kind === 'combo' ? (question.trim() || events.map((e) => e.name).join(' × ')) : question.trim()
  const deadlineOk = !!deadline && Date.parse(deadline) > Date.now()
  const g = Number(goal) || 0
  const checks = kind === 'combo'
    ? [['Two events chosen', combo.length === 2], ['Both already exist, with rules and sources', true], ['Opens on its own once funded', true]] as const
    : [
      ['Clear yes or no answer', yes.trim().length > 0 && no.trim().length > 0 && q.length > 10],
      ['Exact rule for deciding it', rule.trim().length > 30],
      ['Public data source given', source.trim().length > 2],
      ['Deadline after today', deadlineOk],
      ['Can’t easily be caused by a trader', notCausable],
    ] as const
  const stepOk = [true, kind === 'combo' ? combo.length === 2 : q.length > 10, kind === 'combo' || (rule.trim().length > 30 && source.trim().length > 2 && deadlineOk), checks.every(([, ok]) => ok), g >= MIN_GOAL]
  const draft = asMarket({ question: q, category: kind === 'combo' ? 'Combined' : category, events, deadline: kind === 'combo' ? 'Latest deadline' : deadline })
  const draftS = useMemo(() => fresh(draft), [draft.worlds.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const submit = () => {
    if (!actions.pledge(DEPOSIT, q, 'hedge')) return
    const id = pledges.propose({ question: q, kind, category: kind === 'combo' ? 'Combined' : category, events, rule: kind === 'combo' ? 'Combines two events that already exist, with their own rules and sources.' : rule.trim(), source: kind === 'combo' ? events.map((e) => e.sources[0]).join('; ') : source.trim(), deadline: kind === 'combo' ? 'the later deadline' : deadline, goal: g, author: account ?? 'you' })
    setDone(id); setTab('browse')
  }

  const shown = list.filter((p) => filter === 'all' || (filter === 'pledging' ? p.status === 'pledging' : p.status !== 'pledging'))
  const totalPledged = list.reduce((t, p) => t + p.pledged.hedge + p.pledged.take, 0)

  return (
    <div className="page tr desk">
      <header className="tr__pair">
        <div className="tr__id">
          <p className="mk__crumb"><span className="mk__tag">Roadmap</span><span className="mk__tag">Demo, not in the contract</span>Today only the owner account opens markets</p>
          <h1 className="mk__title">Propose a market</h1>
          <p className="tr__means">Propose a question with a rule and a public data source. People pledge USDC on both sides; once it’s funded and checked, the market opens with that money already inside.</p>
        </div>
        <dl className="tr__stats">
          <div><dt>Proposals</dt><dd className="num">{list.length}</dd></div>
          <div><dt>Pledged</dt><dd className="num">${fmt(totalPledged)}</dd></div>
          <div><dt>Funded</dt><dd className="num">{list.filter(isFunded).length}</dd></div>
        </dl>
      </header>

      <div className="pc__tabs desk__filter pp__tabs" role="group" aria-label="View">
        <button type="button" aria-pressed={tab === 'browse'} onClick={() => setTab('browse')}>Browse proposals</button>
        <button type="button" aria-pressed={tab === 'new'} onClick={() => { setTab('new'); setDone(null) }}>New proposal</button>
      </div>

      {tab === 'browse' ? (
        <div className="mk__grid">
          <div className="mk__main">
            {done !== null && <p className="ov__warn pp__done">Your proposal is up. It needs {fmt(g)} USDC of pledges; share it so both sides can back it.</p>}
            <div className="pc__tabs" role="group" aria-label="Filter">
              {(['all', 'pledging', 'funded'] as const).map((f) => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f === 'pledging' ? 'Being funded' : 'Funded'}</button>)}
            </div>
            {shown.map((p) => <ProposalCard key={p.id} p={p} />)}
          </div>
          <aside className="mk__side">
            <section className="tr__panel">
              <h2 className="obx__boxtitle">From idea to market</h2>
              <ol className="steps steps--col">
                <li><span className="steps__n">1</span><b>Propose</b><p>Question, exact rule, public data source and deadline, with a {DEPOSIT} USDC deposit against spam, refunded if accepted.</p></li>
                <li><span className="steps__n">2</span><b>Pledge</b><p>People who want to hedge and people happy to take the other side both lock USDC. A market needs both.</p></li>
                <li><span className="steps__n">3</span><b>Check</b><p>Clear yes or no, public data, and nothing a trader could easily cause. Combinations of existing events skip this.</p></li>
                <li><span className="steps__n">4</span><b>Open</b><p>The market starts with the pledged money as its first liquidity.</p></li>
                <li><span className="steps__n">5</span><b>Resolve</b><p>From the public data, through the reporter and its dispute window.</p></li>
              </ol>
            </section>
            <button type="button" className="mk__btn mk__btn--buy pp__new" onClick={() => setTab('new')}>Start a proposal</button>
          </aside>
        </div>
      ) : (
        <div className="mk__grid">
          <div className="mk__main">
            <ol className="wiz" aria-label="Steps">
              {STEPS.map((t, i) => (
                <li key={t}><button type="button" className={i === step ? 'is-now' : i < step ? 'is-done' : ''} onClick={() => i <= step || stepOk.slice(0, i).every(Boolean) ? setStep(i) : undefined}><span className="num">{i < step ? '✓' : i + 1}</span>{t}</button></li>
              ))}
            </ol>

            <section className="tr__panel wiz__panel">
              {step === 0 && (
                <>
                  <h2 className="obx__boxtitle">What kind of market?</h2>
                  <div className="wiz__choices">
                    <button type="button" aria-pressed={kind === 'new'} onClick={() => setKind('new')}><b>A new event</b><span>Your own yes/no question. Needs a rule, a public source and the owner’s check before it opens.</span></button>
                    <button type="button" aria-pressed={kind === 'combo'} onClick={() => setKind('combo')}><b>Combine two existing events</b><span>Like SPICE × Fed. The events are already checked, so it opens as soon as it’s funded.</span></button>
                  </div>
                </>
              )}
              {step === 1 && (kind === 'combo' ? (
                <>
                  <h2 className="obx__boxtitle">Pick two events</h2>
                  <p className="tr__means">Their four combinations become the worlds. At most two events per market.</p>
                  <div className="wiz__events">
                    {existing.map((e) => {
                      const on = combo.includes(e.name)
                      return (
                        <button key={e.name} type="button" aria-pressed={on} onClick={() => setCombo(on ? combo.filter((x) => x !== e.name) : combo.length < 2 ? [...combo, e.name] : [combo[1], e.name])}>
                          {e.image && <img src={e.image} alt="" width={32} height={32} className="art" />}<span><b>{e.name}</b><small>{e.outcomes.join(' or ')} · {e.deadline ?? ''}</small></span>
                        </button>
                      )
                    })}
                  </div>
                  <label className="create__field"><span>Market title (optional)</span><input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={events.map((e) => e.name).join(' × ') || 'e.g. SPICE × NEAR price'} /></label>
                </>
              ) : (
                <>
                  <h2 className="obx__boxtitle">The question</h2>
                  <label className="create__field"><span>Question</span><input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Will NEAR Intents pass $1B in monthly volume by 30 June 2027?" /></label>
                  <div className="wiz__row">
                    <label className="create__field"><span>If yes</span><input value={yes} onChange={(e) => setYes(e.target.value)} /></label>
                    <label className="create__field"><span>If no</span><input value={no} onChange={(e) => setNo(e.target.value)} /></label>
                    <label className="create__field"><span>Category</span>
                      <select value={category} onChange={(e) => setCategory(e.target.value)}>{['NEAR', 'Economy', 'Crypto', 'Tech', 'Other'].map((c) => <option key={c}>{c}</option>)}</select>
                    </label>
                  </div>
                  <span className="pc__note">Artwork</span>
                  <div className="wiz__art">{ART.map((src) => <button key={src} type="button" aria-pressed={image === src} onClick={() => setImage(src)}><img src={src} alt="" width={44} height={44} /></button>)}</div>
                </>
              ))}
              {step === 2 && (kind === 'combo' ? (
                <>
                  <h2 className="obx__boxtitle">Rules come from the events</h2>
                  {events.map((e) => <div key={e.name} className="mk__rule">{e.image && <img src={e.image} alt="" width={36} height={36} className="art" />}<div><h3>{e.name}</h3><p>{e.rule}</p><p className="pc__note">Sources: {e.sources.join(', ')} · deadline {e.deadline}</p></div></div>)}
                </>
              ) : (
                <>
                  <h2 className="obx__boxtitle">How it resolves</h2>
                  <label className="create__field"><span>Exact rule</span><textarea rows={4} value={rule} onChange={(e) => setRule(e.target.value)} placeholder={`${yes.toUpperCase()} if … on the source below, before the deadline; otherwise ${no.toUpperCase()}.`} /></label>
                  <div className="wiz__row">
                    <label className="create__field"><span>Public data source</span><input value={source} onChange={(e) => setSource(e.target.value)} placeholder="NEAR Intents explorer, monthly volume" /></label>
                    <label className="create__field"><span>Link (optional)</span><input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://" /></label>
                    <label className="create__field"><span>Deadline</span><input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></label>
                  </div>
                  <p className="pc__note">Trading stops at the deadline; the reporter proposes the answer from this source, with a dispute window.</p>
                </>
              ))}
              {step === 3 && (
                <>
                  <h2 className="obx__boxtitle">Checks before it can open</h2>
                  <ul className="wiz__checks">
                    {checks.map(([t, ok]) => <li key={t} className={ok ? 'is-ok' : ''}><i aria-hidden>{ok ? '✓' : '·'}</i>{t}</li>)}
                  </ul>
                  {kind === 'new' && (
                    <label className="wiz__confirm"><input type="checkbox" checked={notCausable} onChange={(e) => setNotCausable(e.target.checked)} />No trader could easily make this happen (a question like “will project X get hacked?” would be rejected).</label>
                  )}
                </>
              )}
              {step === 4 && (
                <>
                  <h2 className="obx__boxtitle">Funding goal</h2>
                  <p className="tr__means">How much USDC should be pledged before it opens. It becomes the market’s first liquidity, split across its worlds; thin markets give bad prices.</p>
                  <label className="tk__field"><span>Goal</span><input inputMode="decimal" value={goal} onChange={(e) => setGoal(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="Pledge goal in USDC" /><em>USDC</em></label>
                  <div className="tk__pcts">{[5_000, 10_000, 20_000, 50_000].map((v) => <button key={v} type="button" onClick={() => setGoal(String(v))}>{fmt(v / 1000)}K</button>)}</div>
                  <p className="tk__line"><span>Per world, at opening</span><b className="num">${fmt(g / draft.worlds.length)}</b></p>
                  <p className="tk__line"><span>Proposal deposit</span><b className="num">{DEPOSIT} USDC, refunded if accepted</b></p>
                  <p className="tk__line"><span>In your wallet</span><b className="num">{fmt(wallet.usdc)} USDC</b></p>
                  {g < MIN_GOAL && <p className="ov__warn">At least {fmt(MIN_GOAL)} USDC, so each world opens with real depth.</p>}
                </>
              )}

              <div className="wiz__nav">
                {step > 0 && <button type="button" className="mk__btn" onClick={() => setStep(step - 1)}>Back</button>}
                {step < STEPS.length - 1
                  ? <button type="button" className="mk__btn mk__btn--buy" disabled={!stepOk[step]} onClick={() => setStep(step + 1)}>Next: {STEPS[step + 1]}</button>
                  : !account
                    ? <button type="button" className="mk__btn mk__btn--buy" onClick={connectDemo}>Use the demo wallet to submit</button>
                    : <button type="button" className="mk__btn mk__btn--buy" disabled={!stepOk.every(Boolean) || wallet.usdc < DEPOSIT} onClick={submit}>{wallet.usdc < DEPOSIT ? `Needs ${DEPOSIT} USDC in your wallet` : `Submit with a ${DEPOSIT} USDC deposit`}</button>}
              </div>
            </section>
          </div>

          <aside className="mk__side">
            <section className="tr__panel">
              <h2 className="obx__boxtitle">Preview</h2>
              <div className="mk-card desk__mcard wiz__preview">
                <span className="mk-card__head"><MarketArt m={draft} size={44} /><span className="mk-card__q">{draft.question}</span></span>
                <span className="mk-card__worlds">
                  {draft.worlds.map((w, b) => <span key={w.id} className="mk-card__world"><span className="mk-card__name"><WorldIcon m={draft} w={b} size={16} />{w.outcome}</span><span className="mk-card__track"><i style={{ width: `${(1 / draft.worlds.length) * 100}%` }} /></span><b className="num">{Math.round(100 / draft.worlds.length)}%</b></span>)}
                </span>
                <span className="mk-card__foot"><span>{draft.category}</span><span>Goal <b className="num">${fmt(g)}</b></span><span>{draft.resolves}</span></span>
              </div>
              <p className="pc__note">Worlds open at even odds; trading moves them.</p>
            </section>
            <section className="tr__panel">
              <h2 className="obx__boxtitle">The worlds</h2>
              <WorldMap m={draft} s={draftS} />
            </section>
          </aside>
        </div>
      )}
    </div>
  )
}
