'use client'
// The header: an editorial top bar. Full width, no capsule, no blur. A plain wordmark, plain text
// links with a hairline that draws under the one you point at, a live 2x2 of your four worlds in the anchor market
// (white: you hold NEAR there, rose: only dollars, outline: nothing yet, faded: that world can no longer happen) and
// a square outline wallet button. A thin rule runs along its bottom; it gets a dark backing once the page scrolls.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useMarket, usePosition } from '../../chain/adapter'
import { useWallet } from '../../chain/near/wallet'
import { chain, isCurrent, nav, site } from '../../config'
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
        {nav.map((n) => (
          <Link key={n.to} href={n.to} className={isCurrent(pathname, n) ? 'is-active' : ''}>
            {n.label}
          </Link>
        ))}
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
