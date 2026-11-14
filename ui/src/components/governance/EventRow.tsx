'use client'
// One event as Resolve and the owner console draw it (the desk's rs__event): artwork, question, state chip, the
// open → proposed → dispute window → final line read from the chain, the rule, deadline and source, and below it the
// actions a screen passes in (Finalize for anyone, the owner's tools in the console).
import type { ReactNode } from 'react'
import { type ChainEvent } from '../../chain/adapter'
import { eventChip, eventStatusLine, RESOLVE_STEPS, resolveStep } from '../../chain/governance'
import { isWebSource } from '../../chain/market'
import { Chip } from './Gov'

export function EventRow({ e, now, inGrid = true, rule = true, children }: { e: ChainEvent; now: bigint | undefined; inGrid?: boolean; rule?: boolean; children?: ReactNode }) {
  const chip = eventChip(e.state, now)
  const step = resolveStep(e.state, now)
  return (
    <article className="rs__event">
      {e.image ? <img src={e.image} alt="" width={36} height={36} className="art" /> : <span className="art art--blank" style={{ width: 36, height: 36 }} aria-hidden>{e.question.slice(0, 1)}</span>}
      <div className="rs__body">
        <div className="rs__line">
          <b>{e.question}</b>
          <Chip tone={chip.tone}>{chip.text}</Chip>
        </div>
        <ol className="rs__steps" aria-label="Where this event stands">
          {RESOLVE_STEPS.map((t, k) => <li key={t} className={k < step ? 'is-done' : k === step ? 'is-now' : ''}>{t}</li>)}
        </ol>
        {rule && e.rule && <p className="rs__rule">{e.rule}</p>}
        <p className="pc__note gv__src">
          Deadline {e.deadline}
          {e.sources.length > 0 && <> · Source: {e.sources.map((s) => (isWebSource(s) ? <a key={s} href={s} target="_blank" rel="noreferrer">{s}</a> : <span key={s}>{s}</span>))}</>}
        </p>
        <p className="pc__note">{eventStatusLine(e.state, inGrid)}</p>
        {children}
      </div>
    </article>
  )
}
