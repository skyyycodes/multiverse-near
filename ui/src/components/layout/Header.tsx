'use client'
// The header: an editorial top bar. Full width, no capsule, no blur. A plain wordmark, plain text
// links with a hairline that draws under the one you point at, a live 2x2 of your four worlds in the anchor market
// (white: you hold NEAR there, rose: only dollars, outline: nothing yet, faded: that world can no longer happen) and
// a square outline wallet button. A thin rule runs along its bottom; it gets a dark backing once the page scrolls.
import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useMarket, usePosition } from '../../chain/adapter'
import { useWallet } from '../../chain/near/wallet'
import { chain, isCurrent, nav, site, type NavItem } from '../../config'
import { Flutes } from '../Flutes'
import { Search } from './Search'
import { WalletMenu } from './WalletMenu'

export function Header() {
  const pathname = usePathname()
  const [scrolled, setScrolled] = useState(false)
  const [menu, setMenu] = useState(false)
  // close the phone menu whenever the page changes
  const [lastPath, setLastPath] = useState(pathname)
  if (pathname !== lastPath) { setLastPath(pathname); setMenu(false) }
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])

  return (
    <header className={`topbar${scrolled ? ' is-scrolled' : ''}${pathname === '/' ? ' is-landing' : ''}`}>
      {/* the page's shard background, drawn into the bar: it reads as one surface, but nothing scrolls under it */}
      <Flutes className="topbar__glow" strip />
      <Link href="/" className="topbar__mark">
        {/* on the landing, the butterfly flies into this spot at the end of the story */}
        <img className="topbar__logo" src="/logo-white.svg" alt="" width={24} height={24} />
        {site.name}
      </Link>
      <span className="topbar__net" title="Running on NEAR testnet with test tokens">Testnet</span>

      <nav className={`topbar__nav${menu ? ' is-open' : ''}`} id="site-nav">
        {nav.map((n) =>
          n.menu ? (
            <NavMenu key={n.to} item={n} active={isCurrent(pathname, n)} pathname={pathname} />
          ) : (
            <Link key={n.to} href={n.to} className={isCurrent(pathname, n) ? 'is-active' : ''}>
              {n.label}
            </Link>
          ),
        )}
      </nav>

      <YourWorlds />
      <Search />
      <WalletMenu />

      <button className="topbar__menu" type="button" aria-expanded={menu} aria-controls="site-nav" onClick={() => setMenu((v) => !v)}>
        {menu ? 'Close' : 'Menu'}
      </button>
    </header>
  )
}

// A header item with a menu under it (How it works: Docs, Whitepaper). A button opens it; Escape, a click outside, a
// choice or leaving it with Tab closes it, and arrow keys move between its links. On phones it opens in place inside
// the page menu.
function NavMenu({ item, active, pathname }: { item: NavItem; active: boolean; pathname: string | null }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const id = useId()
  const [lastPath, setLastPath] = useState(pathname)
  if (pathname !== lastPath) { setLastPath(pathname); setOpen(false) }
  useEffect(() => {
    if (!open) return
    const on = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus() } }
    document.addEventListener('mousedown', on); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', on); document.removeEventListener('keydown', key) }
  }, [open])
  const items = () => Array.from(box.current?.querySelectorAll<HTMLAnchorElement>('.navm__panel a') ?? [])
  const move = (step: number) => {
    const all = items()
    const at = all.indexOf(document.activeElement as HTMLAnchorElement)
    all[(at + step + all.length) % all.length]?.focus()
  }
  return (
    <div
      className={`navm${open ? ' is-open' : ''}`}
      ref={box}
      onBlur={(e) => { if (open && !box.current?.contains(e.relatedTarget as Node | null)) setOpen(false) }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); requestAnimationFrame(() => move(1)) }
        if (e.key === 'ArrowUp' && open) { e.preventDefault(); move(-1) }
      }}
    >
      <button
        ref={button}
        type="button"
        className={`navm__btn${active ? ' is-active' : ''}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        {item.label}
        <svg className="navm__caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>
      <div className="navm__panel" id={id} hidden={!open}>
        {item.menu?.map((m) =>
          m.external ? (
            <a key={m.href} href={m.href} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
              <b>{m.label} <span aria-hidden>↗</span></b><small>{m.note}</small>
            </a>
          ) : (
            <Link key={m.href} href={m.href} onClick={() => setOpen(false)} aria-current={pathname === m.href ? 'page' : undefined}>
              <b>{m.label}</b><small>{m.note}</small>
            </Link>
          ),
        )}
      </div>
    </div>
  )
}

// The connected account's worlds in the anchor market, laid out as its grid (rows: the first event, columns: the
// second). Hidden without a wallet, and until the market and the position have loaded.
function YourWorlds() {
  const { accountId } = useWallet()
  const id = accountId ? chain.anchorMarket : undefined
  const { market } = useMarket(id)
  const { position } = usePosition(id)
  if (!accountId || !market || !position) return null
  const cells = market.grid.rows.flatMap((r) => r.worlds)
  const left = market.worlds.filter((w) => w.possible).length
  const held = position.worlds.filter((w) => w.possible && (w.nearWad > 0n || w.usdcWad > 0n)).length
  const state = (w: number) => {
    const h = position.worlds[w]
    if (!h?.possible) return 'is-dead'
    if (h.nearWad > 0n) return ''
    return h.usdcWad > 0n ? 'is-usdc' : 'is-empty'
  }
  return (
    <Link
      href={market.href}
      className="topbar__worlds"
      title={`Your worlds in ${market.question}: you hold something in ${held} of ${left} still possible`}
      aria-label={`Your worlds in the anchor market: ${held} of ${left} still possible. Open the market`}
    >
      <span className="topbar__grid" style={{ gridTemplateColumns: `repeat(${market.grid.rows[0]?.worlds.length ?? 2}, 7px)` }}>
        {cells.map((w) => <i key={w} className={state(w)} />)}
      </span>
      <span className="topbar__count">{left}/{market.worldCount}</span>
    </Link>
  )
}
