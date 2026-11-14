'use client'
// Toasts, as every trading and lending app shows them: each action's message slides in at the bottom right, says
// what happened, links to where it happened, and goes away on its own after a few seconds.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { onEvent, type Event } from '../../lib/scenario'

type Toast = Event & { id: number }
const ICON: Record<Event['kind'], string> = { trade: '⇄', loan: '$', lend: '↗', resolve: '✓', wallet: '◎', other: '•' }
const TITLE: Record<Event['kind'], string> = { trade: 'Trade', loan: 'Loan', lend: 'Lending', resolve: 'Resolution', wallet: 'Wallet', other: 'Done' }

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([])
  useEffect(() => {
    let n = 0
    return onEvent((e) => {
      const id = ++n
      setToasts((t) => [...t.slice(-3), { ...e, id }])
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000)
    })
  }, [])
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <span className="toast__icon" aria-hidden>{ICON[t.kind]}</span>
          <div className="toast__body">
            <b>{TITLE[t.kind]} <small>· demo, nothing signed</small></b>
            <p>{t.text}</p>
            {t.scenario && <Link href={`/markets/${t.scenario}`}>View market</Link>}
          </div>
          <button type="button" className="toast__x" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>×</button>
        </div>
      ))}
    </div>
  )
}
