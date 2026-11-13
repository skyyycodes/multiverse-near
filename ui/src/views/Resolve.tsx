// Resolve, in the trading screen's style: every event with its artwork, rule, deadline and sources, and a timeline of
// where it stands (open, proposed, in its dispute window, final). A reporter proposes, the owner can dispute for 30
// seconds on testnet, then anyone finalizes. Once one world is left, close and redeem pays out in one step.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { MarketArt } from '../components/Grand'
import { Button } from '../components/ui'
import { DISPUTE_MS, bitsOf, holdsAnything, useStore } from '../lib/scenario'
import { useClient } from '../lib/wallet'

const clock = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
const STEPS = ['Open', 'Proposed', 'Dispute window', 'Final'] as const

export default function Resolve() {
  const client = useClient()
  const { markets, sc, history } = useStore()
  const resolutions = history.filter((h) => h.kind === 'resolve')
  const [now, setNow] = useState(() => Date.now())
  const [filter, setFilter] = useState<'all' | 'open' | 'settled'>('all')
  const pending = markets.some((m) => sc[m.id].proposals.some(Boolean))
  useEffect(() => {
    if (!pending) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [pending])

  const events = markets.reduce((t, m) => t + m.events.length, 0)
  const final = markets.reduce((t, m) => t + sc[m.id].settled.filter((x) => x !== null).length, 0)
  const proposed = markets.reduce((t, m) => t + sc[m.id].proposals.filter(Boolean).length, 0)
  const shown = markets.filter((m) => {
    const done = bitsOf(sc[m.id].possible, m.worlds.length).length === 1
    return filter === 'all' || (filter === 'settled' ? done : !done)
  })

  return (
    <div className="page tr desk">
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">Resolve</h1>
          <p className="tr__means">When an event is decided, the worlds it rules out close and their pieces become worthless. The world left redeems 1:1 for real NEAR and USDC.</p>
        </div>
        <dl className="tr__stats">
          <div><dt>Events decided</dt><dd className="num">{final} of {events}</dd></div>
          <div><dt>In a dispute window</dt><dd className="num">{proposed}</dd></div>
          <div><dt>Dispute window</dt><dd className="num">{clock(DISPUTE_MS)}</dd></div>
        </dl>
      </header>

      <div className="mk__grid">
        <div className="mk__main">
          <div className="pc__tabs desk__filter" role="group" aria-label="Show">
            {(['all', 'open', 'settled'] as const).map((f) => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? 'All markets' : f === 'open' ? 'Open' : 'Settled'}</button>)}
          </div>

          {shown.map((m) => {
            const s = sc[m.id]
            const left = bitsOf(s.possible, m.worlds.length)
            const done = left.length === 1
            return (
              <section key={m.id} className="tr__panel rs">
                <div className="rs__head">
                  <MarketArt m={m} size={44} />
                  <div>
                    <Link href={`/markets/${m.id}`} className="rs__q">{m.question}</Link>
                    <p className="pc__note">{done ? `Settled: ${m.worlds[left[0]].outcome}` : `${left.length} of ${m.worlds.length} worlds still possible`}</p>
                  </div>
                  {done && holdsAnything(s) && !s.claimed && <div className="tk tk--buy rs__redeem"><Button onClick={() => client.claimAll(m.id)}>Close and redeem</Button></div>}
                  {s.claimed && <span className="sc__chip is-on">Redeemed</span>}
                </div>

                {m.events.map((ev, e) => {
                  const settled = s.settled[e]
                  const p = s.proposals[e]
                  const rem = p ? Math.min(DISPUTE_MS, p.at + DISPUTE_MS - now) : 0
                  const step = settled !== null ? 3 : p ? 2 : 0 // a proposal sits in its window until someone finalizes it
                  return (
                    <article key={ev.name} className="rs__event">
                      {ev.image && <img src={ev.image} alt="" width={36} height={36} className="art" />}
                      <div className="rs__body">
                        <div className="rs__line">
                          <b>{ev.name}</b>
                          <span className={`rs__state rs__state--${settled !== null ? 'final' : p ? 'live' : 'open'}`}>
                            {settled !== null ? `Final: ${ev.outcomes[settled]}` : p ? `Proposed ${ev.outcomes[p.outcome]} · ${rem > 0 ? clock(rem) : 'window closed'}` : 'Open'}
                          </span>
                        </div>
                        <ol className="rs__steps" aria-label="Where this event stands">
                          {STEPS.map((t, k) => <li key={t} className={k < step ? 'is-done' : k === step ? 'is-now' : ''}>{t}</li>)}
                        </ol>
                        {ev.rule && <p className="rs__rule">{ev.rule}</p>}
                        <p className="pc__note">{ev.deadline ? `Deadline ${ev.deadline} · ` : ''}Sources: {ev.sources.join(', ')}</p>
                        {m.id === 'fed-oct-2026' && <p className="pc__note">Settled on testnet from FRED by OutLayer in a secure enclave; no person typed the answer.</p>}
                        {settled === null && (
                          <div className="rs__acts">
                            {p ? (
                              <>
                                <button type="button" className="mk__btn mk__btn--sell" onClick={() => client.dispute(m.id, e)}>Dispute</button>
                                <button type="button" className="mk__btn mk__btn--buy" onClick={() => client.finalize(m.id, e)} disabled={rem > 0}>Finalize</button>
                              </>
                            ) : (
                              <>
                                <span className="pc__note">Reporter proposes (demo):</span>
                                {ev.outcomes.map((o, k) => <button key={o} type="button" className="mk__btn mk__btn--buy" onClick={() => client.propose(m.id, e, k)}>{o}</button>)}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </article>
                  )
                })}
              </section>
            )
          })}
        </div>

        <aside className="mk__side">
          <section className="tr__panel">
            <h2 className="obx__boxtitle">How an event is decided</h2>
            <ol className="steps steps--col">
              <li><span className="steps__n">1</span><b>A reporter proposes</b><p>The result and its evidence. For the Fed, OutLayer can read FRED in a secure enclave and propose it.</p></li>
              <li><span className="steps__n">2</span><b>Dispute window</b><p>{clock(DISPUTE_MS)} on testnet. Only the owner can cancel a wrong answer, and trading pauses.</p></li>
              <li><span className="steps__n">3</span><b>Anyone finalizes</b><p>The worlds the answer rules out close. A healthy loan can only get safer.</p></li>
              <li><span className="steps__n">4</span><b>Close and redeem</b><p>One transaction repays your loan and pays out the world that happened, 1:1.</p></li>
            </ol>
          </section>
          <section className="tr__panel">
            <h2 className="obx__boxtitle">Resolution history</h2>
            {resolutions.length === 0 ? <p className="obx__empty">No proposals or results yet in this session. The October Fed decision was settled on testnet before it.</p> : (
              <ol className="feed feed--compact">
                {resolutions.map((h, i) => <li key={i} className="feed__item feed__item--resolve"><time className="num">{new Date(h.at).toLocaleTimeString('en-GB', { hour12: false })}</time><span>{h.text}</span></li>)}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
