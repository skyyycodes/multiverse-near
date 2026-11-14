'use client'
// The frame every page sits in: the background glow, header, the page itself, footer. Around it: the chain reads
// (React Query), the wallet (NEAR Connect, with the demo bridge in demo-wallet builds), the per-market picks and
// tiers, and the keeper pings of the hosted staging build.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { usePathname } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { ScenarioProvider } from '../../chain/hooks/useScenario'
import { startKeeperPings } from '../../chain/keeper-ping'
import { WalletProvider } from '../../chain/near/wallet'
import { useReveal } from '../../lib/reveal'
import { Flutes } from '../Flutes'
import { Footer } from './Footer'
import { Header } from './Header'
import { Onboarding } from './Onboarding'
import { Toaster } from './Toaster'

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  useReveal(pathname)
  // one client per visit; a snapshot counts as fresh for 2 s, so screens sharing a view don't refetch on mount
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 2_000 } } }))
  useEffect(() => startKeeperPings(), [])
  return (
    <QueryClientProvider client={client}>
      <WalletProvider>
        <ScenarioProvider>
          <Flutes className="site-glow" />
          <Header />
          <main>
            {/* keyed by page, so each page plays its entrance when you arrive */}
            <div key={pathname} className="route">{children}</div>
          </main>
          <Footer />
          <Toaster />
          <Onboarding />
        </ScenarioProvider>
      </WalletProvider>
    </QueryClientProvider>
  )
}
