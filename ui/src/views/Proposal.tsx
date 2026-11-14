// One market proposal (placeholder route; the proposals track builds the screen): its events, the pledges toward its
// goal, the admin's check and the opening. Reached from Propose and from the markets that list live proposals.
import Link from 'next/link'

export default function Proposal({ id }: { id: string }) {
  return (
    <div className="page tr desk">
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">Proposal{/^\d+$/.test(id) ? ` #${id}` : ''}</h1>
          <p className="tr__means">A market someone proposed: pledge NEAR or USDC toward its goal, and it opens already funded.</p>
        </div>
      </header>
      <div className="tr__panel desk__empty">
        <p><b>Not open yet.</b> Proposal pages arrive with the next release of this page.</p>
        <Link href="/propose/" className="mk__btn mk__btn--buy">Go to Propose</Link>
      </div>
    </div>
  )
}
