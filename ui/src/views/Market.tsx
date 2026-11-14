import Link from 'next/link'
import { ScenarioMarket } from '../components/ScenarioMarket'
import { useStore } from '../lib/scenario'

// Every market is a scenario of yes/no events, so every market gets the world-grid page from the design doc.
// `id` comes from /market/?id=N (app/market/page.tsx). Still on the in-browser model until the markets track moves it
// to the adapter's useMarket(id).
export default function MarketPage({ id }: { id: string }) {
  const market = useStore().markets.find((m) => m.id === id)

  if (!market) {
    return (
      <div className="page">
        <h1 className="page__title">Market not found</h1>
        <p className="page__sub">It may have been removed, or the link is wrong. <Link href="/markets/">See all markets</Link></p>
      </div>
    )
  }
  return <ScenarioMarket key={market.id} market={market} />
}
