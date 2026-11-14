'use client'
// Search, as on Polymarket and exchanges: a button in the header, or Ctrl/⌘+K anywhere, opens a palette that finds
// markets, single worlds and pages as you type. Arrow keys move, Enter opens, Escape closes. Markets and worlds are
// the contract's own, read when the palette opens.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMarkets, type ChainMarket } from '../../chain/adapter'
import { ordersHref } from '../../chain/links'
import { fold } from '../../chain/market'
import { footerLinks, nav } from '../../config'
import { pct } from '../../lib/format'
import { MarketArt, WorldIcon } from '../Grand'

const PAGES = [...nav.map((n) => ({ label: n.label, href: n.to })), ...footerLinks.filter((l) => !nav.some((n) => n.to === l.to)).map((l) => ({ label: l.label, href: l.to }))]

export function Search() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((v) => !v) }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  return (
    <>
      <button type="button" className="topbar__search" onClick={() => setOpen(true)} aria-label="Search markets and worlds">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <span className="topbar__wide">Search</span><kbd className="topbar__wide">Ctrl K</kbd>
      </button>
      {open && <Palette close={() => setOpen(false)} />}
    </>
  )
}

type Result =
  | { key: string; href: string; kind: 'market'; m: ChainMarket }
  | { key: string; href: string; kind: 'world'; m: ChainMarket; w: number }
  | { key: string; href: string; kind: 'page'; label: string }

function Palette({ close }: { close: () => void }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const { markets, isLoading, error } = useMarkets()
  useEffect(() => { input.current?.focus() }, [])

  const results = useMemo((): Result[] => {
    const t = fold(q)
    const hit = (s: string) => !t || fold(s).includes(t)
    const all = markets ?? []
    const byId = /^#\d+$/.test(t) // "#5" finds market 5, never 50
    const ms = all
      .filter((m) => (byId ? t === `#${m.sid}` : hit(`${m.question} ${m.categories.join(' ')} ${m.kind}`)))
      .slice(0, 6)
      .map((m): Result => ({ key: m.id, href: m.href, kind: 'market', m }))
    const ws = t
      ? all.flatMap((m) => m.worlds.filter((w) => w.possible && !m.settled && (hit(w.outcome) || hit(w.label))).map((w): Result => ({ key: `${m.id}-${w.index}`, href: ordersHref(m.sid, { w: w.index }), kind: 'world', m, w: w.index }))).slice(0, 6)
      : []
    const ps = PAGES.filter((p) => hit(p.label)).map((p): Result => ({ key: p.href, href: p.href, kind: 'page', label: p.label }))
    return [...ms, ...ws, ...ps]
  }, [q, markets])

  const go = (href: string) => { close(); router.push(href) }

  return (
    <div className="cmdk" role="dialog" aria-modal="true" aria-label="Search" onClick={close}>
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
          {isLoading && <li className="cmdk__none">Reading the markets…</li>}
          {error && !markets && <li className="cmdk__none">Couldn’t read the markets right now. Pages still work.</li>}
          {!isLoading && results.length === 0 && <li className="cmdk__none">Nothing matches “{q}”.</li>}
          {results.map((r, k) => (
            <li key={r.key}>
              <button type="button" className={`cmdk__item${k === i ? ' is-on' : ''}`} onMouseEnter={() => setI(k)} onClick={() => go(r.href)}>
                {r.kind === 'page' ? <span className="cmdk__page" aria-hidden>→</span> : r.kind === 'world' ? <WorldIcon m={r.m} w={r.w} size={28} /> : <MarketArt m={r.m} size={28} />}
                <span className="cmdk__text">
                  <b>{r.kind === 'page' ? r.label : r.kind === 'world' ? r.m.worlds[r.w].outcome : r.m.question}</b>
                  <small>{r.kind === 'page' ? 'Page' : r.kind === 'world' ? `World · trade NEAR/USDC · ${r.m.question}` : `Market · ${r.m.category} · ${r.m.settled ? 'settled' : r.m.kind}`}</small>
                </span>
                {r.kind === 'world' && <b className="num">{pct(r.m.worlds[r.w].chance)}</b>}
              </button>
            </li>
          ))}
        </ul>
        <p className="cmdk__foot">↑↓ to move · Enter to open · Esc to close</p>
      </div>
    </div>
  )
}
