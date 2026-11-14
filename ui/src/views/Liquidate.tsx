// At-risk loans (placeholder route; the lending track builds the screen): every open loan close to liquidation,
// across markets and tiers, with a quote and the liquidate action. Reached from Borrow, Lend and the footer.
import Link from 'next/link'

export default function Liquidate({ id }: { id: string }) {
  void id // ?id=N narrows the list to one market
  return (
    <div className="page tr desk">
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">At-risk loans</h1>
          <p className="tr__means">Loans whose worst world no longer covers the debt can be repaid by anyone, for a share of the collateral.</p>
        </div>
      </header>
      <div className="tr__panel desk__empty">
        <p><b>Not open yet.</b> The list of at-risk loans arrives with the next release of this page.</p>
        <Link href="/borrow/" className="mk__btn mk__btn--buy">Go to Borrow</Link>
      </div>
    </div>
  )
}
