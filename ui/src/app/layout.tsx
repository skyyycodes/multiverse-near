import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Shell } from '../components/layout/Shell'
import { BRAND } from '../chain/brand'
import { site } from '../config'
// Every stylesheet loads here, in one fixed order: base, then each part of the site, then the
// design system last so it wins. (Imported from components instead, Next.js would load those later
// and they would override system.css and unify.css.)
import '../index.css'
import '../components/layout/layout.css'
import '../components/layout/topbar.css'
import '../styles/docs.css'
import '../components/Hero.css'
import '../views/Landing.css'
import '../views/landing-flow.css'
import '../styles/scenario.css'
import '../styles/system.css'
import '../styles/unify.css'
import '../styles/landing.css'
import '../styles/desk.css'
import '../styles/borrow.css'
import '../styles/global-ui.css'
import '../styles/refine.css'
import '../styles/pages-research.css'
import '../styles/portfolio.css'
import '../styles/portfolio-v3.css'
// v2: one file per screen track, then the chain shell's own rules (ui/INTEGRATION.md)
import '../styles/v2-markets.css'
import '../styles/v2-lending.css'
import '../styles/v2-trade.css'
import '../styles/v2-governance.css'
import '../styles/chain.css'

export const metadata: Metadata = {
  title: BRAND.name,
  description: site.tagline,
  applicationName: BRAND.name,
  icons: { icon: '/favicon.svg' },
  openGraph: { title: BRAND.name, description: site.tagline, siteName: BRAND.name, type: 'website' },
  twitter: { card: 'summary', title: BRAND.name, description: site.tagline },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&display=swap" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=DM+Mono:wght@400;500&display=swap" />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  )
}
