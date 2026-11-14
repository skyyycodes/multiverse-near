// Split and merge (placeholder route; the trading track builds the screen): real wNEAR or USDC into one piece in every
// world still possible, and a full set of pieces back into the real token. Reached from a market's ticket.
import Link from 'next/link'
import { marketHref } from '../chain/links'
import { marketId } from '../chain/adapter'

export default function Split({ id }: { id: string }) {
  const sid = marketId(id)
  return (
    <div className="page tr desk">
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">Split</h1>
          <p className="tr__means">Turn real wNEAR or USDC into one piece in every world of a market, or merge a full set back into the real token.</p>
        </div>
      </header>
      <div className="tr__panel desk__empty">
        <p><b>Not open yet.</b> Splitting arrives with the next release of this page.</p>
        <Link href={sid ? marketHref(sid) : '/markets/'} className="mk__btn mk__btn--buy">{sid ? 'Back to the market' : 'See the markets'}</Link>
      </div>
    </div>
  )
}
