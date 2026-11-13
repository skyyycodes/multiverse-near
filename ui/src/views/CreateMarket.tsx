import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { WorldMap } from '../components/WorldMap'
import { Button } from '../components/ui'
import { actions, buildWorlds, fresh } from '../lib/scenario'
import type { Market, ScenarioEvent } from '../lib/types'

// A market asks one or two yes/no questions; every combination of answers is a world (up to four), as in the contract.
const MAX_QUESTIONS = 2
const blank = (): ScenarioEvent => ({ name: '', outcomes: ['Yes', 'No'], sources: ['', ''] })
const clean = (ev: ScenarioEvent, i: number): ScenarioEvent => ({
  name: ev.name.trim() || `Question ${i + 1}`,
  outcomes: [ev.outcomes[0].trim() || 'Yes', ev.outcomes[1].trim() || 'No'],
  sources: [ev.sources[0].trim(), ev.sources[1].trim()],
})

export default function CreateMarket() {
  const router = useRouter()
  const [question, setQuestion] = useState('')
  const [events, setEvents] = useState<ScenarioEvent[]>([blank()])
  const [resolves, setResolves] = useState('')
  const edit = (i: number, next: Partial<ScenarioEvent>) => setEvents(events.map((e, k) => (k === i ? { ...e, ...next } : e)))
  const valid = question.trim().length > 5 && events.every((e) => e.name.trim() && e.outcomes.every((o) => o.trim()) && e.sources.every((x) => x.trim()))

  // the market as it would be created, drawn live on the right
  const draft = useMemo(() => {
    const evs = events.map(clean)
    const m: Market = { id: 'draft', question: question.trim(), category: 'New', resolves: resolves.trim() || 'Not set', events: evs, worlds: buildWorlds(evs) }
    return { m, s: fresh(m) }
  }, [question, events, resolves])
  const missing = [
    question.trim().length <= 5 && 'the market question',
    events.some((e) => !e.name.trim()) && 'a name for each question',
    events.some((e) => e.sources.some((x) => !x.trim())) && 'two sources for each question',
  ].filter(Boolean) as string[]

  return (
    <div className="page page--wide create">
      <div className="page__head">
        <h1 className="page__title">Propose a market</h1>
        <p className="page__sub">Ask one or two yes-or-no questions. Every combination of answers becomes a world, up to four.</p>
        <p className="pg-roadmap">On the roadmap, not in the contract yet. Today only the owner account opens markets. The planned flow: propose with a rule and a public data source, pledge USDC on both sides, a check, then the market opens already funded. Here it opens a demo market in your browser.</p>
      </div>

      <div className="create__layout">
        <form
          className="create__form"
          onSubmit={(e) => {
            e.preventDefault()
            const m = actions.createMarket(question.trim(), events.map(clean), resolves.trim() || 'Not set')
            router.push(`/markets/${m.id}`)
          }}
        >
          <label className="create__field">
            <span>Market question</span>
            <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Does the proposal pass, and does NEAR list on the exchange?" />
          </label>

          {events.map((ev, i) => (
            <fieldset key={i} className="create__question">
              <legend>Question {i + 1}</legend>
              <label className="create__field">
                <span>What’s being decided</span>
                <input value={ev.name} onChange={(e) => edit(i, { name: e.target.value })} placeholder={i === 0 ? 'The proposal' : 'The listing'} />
              </label>
              <div className="create__pair">
                {ev.outcomes.map((o, k) => (
                  <label className="create__field" key={k}>
                    <span>{k === 0 ? 'If yes' : 'If no'}</span>
                    <input value={o} onChange={(e) => edit(i, { outcomes: ev.outcomes.map((x, j) => (j === k ? e.target.value : x)) as [string, string] })} />
                  </label>
                ))}
                {ev.sources.map((x, k) => (
                  <label className="create__field" key={`s${k}`}>
                    <span>Source {k + 1}</span>
                    <input value={x} onChange={(e) => edit(i, { sources: ev.sources.map((y, j) => (j === k ? e.target.value : y)) as [string, string] })} placeholder={k === 0 ? 'Official result' : 'Polymarket'} />
                  </label>
                ))}
              </div>
              {events.length > 1 && (
                <button type="button" className="create__remove" onClick={() => setEvents(events.filter((_, k) => k !== i))}>Remove question {i + 1}</button>
              )}
            </fieldset>
          ))}

          {events.length < MAX_QUESTIONS && (
            <button type="button" className="create__add" onClick={() => setEvents([...events, blank()])}>
              Add a question <span>{2 ** events.length} worlds become {2 ** (events.length + 1)}</span>
            </button>
          )}

          <label className="create__field">
            <span>Resolves on</span>
            <input value={resolves} onChange={(e) => setResolves(e.target.value)} placeholder="31 Dec 2026" />
          </label>

          <div className="create__submit">
            <Button type="submit" disabled={!valid}>Open as a demo market</Button>
            {!valid && missing.length > 0 && <p>Still needed: {missing.join(', ')}.</p>}
          </div>
        </form>

        <aside className="create__preview" aria-live="polite">
          <p className="create__count">{draft.m.worlds.length} worlds</p>
          <p className="create__q">{draft.m.question || 'Your market question'}</p>
          <WorldMap m={draft.m} s={draft.s} />
          <p className="create__note">Every world starts at even odds and today’s NEAR price. Trading in the pools moves them. A reporter proposes each result from the rule’s data source, then a dispute window runs.</p>
        </aside>
      </div>
    </div>
  )
}
