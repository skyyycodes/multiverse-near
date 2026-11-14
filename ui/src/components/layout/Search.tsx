'use client'
// Search, as on Polymarket and exchanges: a button in the header, or Ctrl/⌘+K anywhere, opens a palette that finds
// markets, single worlds and pages as you type. Arrow keys move, Enter opens, Escape closes.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { bitsOf, liveOdds, useStore } from '../../lib/scenario'
import { pct } from '../../lib/format'
import { MarketArt, WorldIcon } from '../Grand'

const PAGES = [
  { label: 'Markets', href: '/markets' }, { label: 'Portfolio', href: '/portfolio' }, { label: 'Borrow', href: '/borrow' },
  { label: 'Lend', href: '/lend' }, { label: 'Order book', href: '/orders' }, { label: 'Resolve', href: '/resolve' },
  { label: 'How it works', href: '/docs' }, { label: 'Propose a market', href: '/markets/new' }, { label: 'Admin', href: '/admin' },
]

export function Search() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const { markets, sc } = useStore()

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((v) => !v) }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])
  useEffect(() => { if (open) { setQ(''); setI(0); setTimeout(() => input.current?.focus(), 0) } }, [open])

  const results = useMemo(() => {
    const t = q.trim().toLowerCase()
    const hit = (s: string) => !t || s.toLowerCase().includes(t)
    const ms = markets.filter((m) => hit(`${m.question} ${m.category} ${(m.tags ?? []).join(' ')}`)).slice(0, 6)
      .map((m) => ({ key: m.id, href: `/markets/${m.id}`, kind: 'market' as const, m, w: -1 }))
    const ws = t ? markets.flatMap((m) => bitsOf(sc[m.id].possible, m.worlds.length).filter((w) => hit(m.worlds[w].outcome)).map((w) => ({ key: `${m.id}-${w}`, href: `/orders?m=${m.id}&w=${w}`, kind: 'world' as const, m, w }))).slice(0, 6) : []
    const ps = PAGES.filter((p) => hit(p.label)).map((p) => ({ key: p.href, href: p.href, kind: 'page' as const, label: p.label }))
    return [...ms, ...ws, ...ps]
  }, [q, markets, sc])

  const go = (href: string) => { setOpen(false); router.push(href) }

  return (
    <>
      <button type="button" className="topbar__search" onClick={() => setOpen(true)} aria-label="Search markets and worlds">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <span className="topbar__wide">Search</span><kbd className="topbar__wide">Ctrl K</kbd>
      </button>
      {open && (
        <div className="cmdk" role="dialog" aria-modal="true" aria-label="Search" onClick={() => setOpen(false)}>
          <div className="cmdk__box" onClick={(e) => e.stopPropagation()}>
            <input
              ref={input}
              className="cmdk__input"
              placeholder="Search markets, worlds and pages"
              value={q}
              onChange={(e) => { setQ(e.target.value); setI(0) }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(results.length - 1, x + 1)) }
                if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)) }
                if (e.key === 'Enter' && results[i]) go(results[i].href)
              }}
            />
            <ul className="cmdk__list">
              {results.length === 0 && <li className="cmdk__none">Nothing matches “{q}”.</li>}
              {results.map((r, k) => (
                <li key={r.key}>
                  <button type="button" className={`cmdk__item${k === i ? ' is-on' : ''}`} onMouseEnter={() => setI(k)} onClick={() => go(r.href)}>
                    {r.kind === 'page' ? <span className="cmdk__page" aria-hidden>→</span> : r.kind === 'world' ? <WorldIcon m={r.m} w={r.w} size={28} /> : <MarketArt m={r.m} size={28} />}
                    <span className="cmdk__text">
                      <b>{r.kind === 'page' ? r.label : r.kind === 'world' ? r.m.worlds[r.w].outcome : r.m.question}</b>
                      <small>{r.kind === 'page' ? 'Page' : r.kind === 'world' ? `World · trade NEAR/USDC · ${r.m.question}` : `Market · ${r.m.category}`}</small>
                    </span>
                    {r.kind === 'world' && <b className="num">{pct(liveOdds(r.m, sc[r.m.id])[r.w])}</b>}
                  </button>
                </li>
              ))}
            </ul>
            <p className="cmdk__foot">↑↓ to move · Enter to open · Esc to close</p>
          </div>
        </div>
      )}
    </>
  )
}
