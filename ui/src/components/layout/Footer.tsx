import Link from 'next/link'
import { BRAND } from '../../chain/brand'
import { accountUrl } from '../../chain/env'
import { chain, footerLinks, links, site } from '../../config'

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer__brand">
        <img src="/logo-white.svg" alt="" width={22} height={22} />
        <span>{site.name}</span>
        <span className="muted">{BRAND.testnetNote}</span>
      </div>
      <nav className="footer__links">
        {footerLinks.map((l) => <Link key={l.to} href={l.to}>{l.label}</Link>)}
        <a href={links.github} target="_blank" rel="noreferrer">GitHub</a>
        <a href={links.learn} target="_blank" rel="noreferrer">Guide from zero</a>
        <a href={links.roadmap} target="_blank" rel="noreferrer">Roadmap</a>
        <a href={links.paper} target="_blank" rel="noreferrer">The paper</a>
        <a href={accountUrl(chain.contractId)} target="_blank" rel="noreferrer" title={chain.contractId}>Contract</a>
        <a href={links.near} target="_blank" rel="noreferrer">NEAR</a>
      </nav>
    </footer>
  )
}
