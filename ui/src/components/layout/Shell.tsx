'use client'
// The frame every page sits in: the background glow, header, the page itself, footer.
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { useReveal } from '../../lib/reveal'
import { WalletProvider } from '../../lib/wallet'
import { Flutes } from '../Flutes'
import { Footer } from './Footer'
import { Header } from './Header'
import { Onboarding } from './Onboarding'
import { Toaster } from './Toaster'

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  useReveal(pathname)
  return (
    <WalletProvider>
      <Flutes className="site-glow" />
      <Header />
      <main>
        {/* keyed by page, so each page plays its entrance when you arrive */}
        <div key={pathname} className="route">{children}</div>
      </main>
      <Footer />
      <Toaster />
      <Onboarding />
    </WalletProvider>
  )
}
