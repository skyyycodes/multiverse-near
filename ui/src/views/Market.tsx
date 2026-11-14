import Link from 'next/link'
import { PageLoading } from '../components/layout/PageLoading'
import { ScenarioMarket } from '../components/ScenarioMarket'
import { useMarket } from '../chain/adapter'
import { errorLine } from '../chain/errors'
import { marketsHref } from '../chain/links'

// Every market is a scenario of yes/no events, so every market gets the world-grid page from the design doc.
// `id` comes from /market/?id=N (app/market/page.tsx); the market is read from the contract (`get_market`), listed or not.
export default function MarketPage({ id }: { id: string }) {
  const { market, isLoading, notFound, error } = useMarket(id)

  if (market) return <ScenarioMarket key={market.id} market={market} />
  if (isLoading) return <PageLoading label="Reading the market…" />
  if (notFound) {
    return (
      <div className="page tr desk">
        <div className="tr__panel desk__empty">
          <p><b>Market not found.</b> {id ? `There is no market #${id} on this contract.` : 'The link names no market.'} It may be mistyped.</p>
          <Link className="mk__btn mk__btn--buy" href={marketsHref}>See all markets</Link>
        </div>
      </div>
    )
  }
  return (
    <div className="page tr desk">
      <div className="tr__panel desk__empty">
        <p><b>Couldn’t read this market.</b> {error ? errorLine(error.message) : 'The chain didn’t answer; try again in a moment.'}</p>
        <Link className="mk__btn mk__btn--buy" href={marketsHref}>See all markets</Link>
      </div>
    </div>
  )
}
