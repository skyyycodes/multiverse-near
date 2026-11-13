// The header: an editorial top bar. Full width, no capsule, no blur. A plain wordmark, plain text
// links with a hairline that draws under the one you point at, a live 2x2 of your four worlds
// (white: holding NEAR, blue: holding USDC, faded: closed) and a square outline wallet button.
// A thin rule runs along its bottom; it gets a dark backing once the page scrolls.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { nav, site } from '../../config'
import { has, useScenario } from '../../lib/scenario'
import { Flutes } from '../Flutes'
import { Search } from './Search'
import { WalletMenu } from './WalletMenu'

export function Header() {
  const s = useScenario('ships-fed')
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

  const worldsLeft = [0, 1, 2, 3].filter((b) => has(s.possible, b)).length

  return (
    <header className={`topbar${scrolled ? ' is-scrolled' : ''}${pathname === '/' ? ' is-landing' : ''}`}>
      {/* the page's shard background, drawn into the bar: it reads as one surface, but nothing scrolls under it */}
      <Flutes className="topbar__glow" strip />
      <Link href="/" className="topbar__mark">
        {/* on the landing, the butterfly flies into this spot at the end of the story */}
        <img className="topbar__logo" src="/logo-white.svg" alt="" width={24} height={24} />
        {site.name}
      </Link>
      <span className="topbar__net" title="Running on NEAR testnet with mock tokens">Testnet</span>

      <nav className={`topbar__nav${menu ? ' is-open' : ''}`} id="site-nav">
        {nav.map((n) => (
          <Link key={n.to} href={n.to} className={pathname === n.to || pathname.startsWith(`${n.to}/`) ? 'is-active' : ''}>
            {n.label}
          </Link>
        ))}
      </nav>

      <Link
        href="/markets/ships-fed"
        className="topbar__worlds"
        title={`Your four worlds: ${worldsLeft} still possible`}
        aria-label={`Your four worlds, ${worldsLeft} still possible. Open the world grid`}
      >
        <span className="topbar__grid">
          {[0, 1, 2, 3].map((b) => {
            const dead = !has(s.possible, b)
            return <i key={b} className={dead ? 'is-dead' : s.near[b] > 0 ? '' : 'is-usdc'} />
          })}
        </span>
        <span className="topbar__count">{worldsLeft}/4</span>
      </Link>

      <Search />
      <WalletMenu />

      <button className="topbar__menu" type="button" aria-expanded={menu} aria-controls="site-nav" onClick={() => setMenu((v) => !v)}>
        {menu ? 'Close' : 'Menu'}
      </button>
    </header>
  )
}
