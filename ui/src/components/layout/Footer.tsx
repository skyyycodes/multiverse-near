import Link from 'next/link'
import { links, site } from '../../config'

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer__brand">
        <img src="/logo-white.svg" alt="" width={22} height={22} />
        <span>{site.name}</span>
        <span className="muted">Built for the NEAR hackathon, 2026</span>
      </div>
      <nav className="footer__links">
        <Link href="/markets">Markets</Link>
        <Link href="/portfolio">Portfolio</Link>
        <Link href="/docs">How it works</Link>
        <Link href="/proposals">Proposals</Link>
        <Link href="/admin">Admin</Link>
        <a href={links.github} target="_blank" rel="noreferrer">GitHub</a>
        <a href={links.learn} target="_blank" rel="noreferrer">Guide from zero</a>
        <a href={links.paper} target="_blank" rel="noreferrer">The paper</a>
        <a href={links.near} target="_blank" rel="noreferrer">NEAR</a>
      </nav>
    </footer>
  )
}
