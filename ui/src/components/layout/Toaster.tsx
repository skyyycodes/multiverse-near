'use client'
// Toasts, as every trading and lending app shows them: each action's message slides in at the bottom right, says
// what happened, links to where it happened, and goes away on its own after a few seconds. A transaction's toast
// stays while it is pending, then turns into the result: its explorer link, or the contract's error in plain words.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { onTxToast, type ToastKind } from '../../chain/toasts'
import { marketHref } from '../../chain/links'
import { onEvent } from '../../lib/scenario'

type Toast = {
  id: string
  kind: ToastKind
  state: 'pending' | 'done' | 'failed' | 'model'
  title: string
  text: string
  href?: string
  market?: string // a market page link
}
const ICON: Record<ToastKind, string> = { trade: '⇄', loan: '$', lend: '↗', resolve: '✓', wallet: '◎', other: '•' }
const TITLE: Record<ToastKind, string> = { trade: 'Trade', loan: 'Loan', lend: 'Lending', resolve: 'Resolution', wallet: 'Wallet', other: 'Done' }
const STAY: Record<Toast['state'], number> = { pending: 0, done: 7000, failed: 12000, model: 5000 }

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([])
  useEffect(() => {
    let n = 0
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const drop = (id: string) => setToasts((t) => t.filter((x) => x.id !== id))
    const show = (t: Toast) => {
      setToasts((all) => (all.some((x) => x.id === t.id) ? all.map((x) => (x.id === t.id ? t : x)) : [...all.slice(-3), t]))
      clearTimeout(timers.get(t.id))
      if (STAY[t.state] > 0) timers.set(t.id, setTimeout(() => drop(t.id), STAY[t.state]))
    }
    const offTx = onTxToast((t) => show({ id: `tx${t.id}`, kind: t.kind, state: t.state, title: t.title, text: t.text, href: t.href, market: t.market === undefined ? undefined : marketHref(t.market) }))
    // the in-browser model's messages, while screens still run on it
    const offModel = onEvent((e) => show({ id: `m${++n}`, kind: e.kind, state: 'model', title: TITLE[e.kind], text: e.text, market: e.scenario ? `/market/?id=${e.scenario}` : undefined }))
    return () => { offTx(); offModel(); timers.forEach((t) => clearTimeout(t)) }
  }, [])
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind} is-${t.state}`}>
          <span className="toast__icon" aria-hidden>{t.state === 'pending' ? <i className="toast__spin" /> : t.state === 'failed' ? '!' : ICON[t.kind]}</span>
          <div className="toast__body">
            <b>{t.title}{t.state === 'model' && <small> · demo, nothing signed</small>}</b>
            <p>{t.text}</p>
            {t.href && <a href={t.href} target="_blank" rel="noreferrer">View transaction ↗</a>}
            {!t.href && t.market && t.state !== 'pending' && <Link href={t.market}>View market</Link>}
          </div>
          <button type="button" className="toast__x" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>×</button>
        </div>
      ))}
    </div>
  )
}
