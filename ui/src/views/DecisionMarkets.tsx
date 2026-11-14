// Decision markets (futarchy), as a roadmap page: what they would add and how a decision would be made, in words
// only. The contract has no decision-market module yet, so nothing here is a number, a price or a result. What runs
// today (proposals funded by pledges) is one click away.
import Link from 'next/link'

export default function DecisionMarkets() {
  return (
    <div className="page tr desk gv">
      <header className="tr__pair">
        <div className="tr__id">
          <p className="mk__crumb"><span className="mk__tag">Roadmap</span><span className="mk__tag">Not in the contract yet</span>Nothing on this page trades</p>
          <h1 className="mk__title">Decision markets</h1>
          <p className="tr__means">A proposal splits the future in two: one world where it passes, one where it fails. Traders price NEAR in each; the proposal passes only if the market expects NEAR to do better with it than without it.</p>
        </div>
      </header>

      <div className="mk__grid">
        <div className="mk__main">
          <section className="tr__panel">
            <h2 className="obx__boxtitle">How a decision would be made</h2>
            <ol className="steps">
              <li><span className="steps__n">1</span><b>Split</b><p>Each USDC becomes one to trade if the proposal passes and one if it fails. Holding both is the same as holding the USDC.</p></li>
              <li><span className="steps__n">2</span><b>Trade both futures</b><p>Buy or sell NEAR in each branch at the price you expect it to have if the proposal passes, or if it fails.</p></li>
              <li><span className="steps__n">3</span><b>Averages decide</b><p>When trading closes, it passes only if the pass branch’s average price beats the fail branch’s by a set margin. The losing branch’s trades are undone.</p></li>
            </ol>
          </section>
          <section className="tr__panel">
            <h2 className="obx__boxtitle">Why it fits here</h2>
            <p className="tr__means gv__prose">The contract already splits money into worlds and prices NEAR in each one. A decision market is the same machine with two worlds, “passes” and “fails”, where the answer comes from the prices themselves instead of a data source. It would let a community, or the market proposals on this site, be decided by what traders expect rather than by a vote.</p>
          </section>
        </div>
        <aside className="mk__side">
          <section className="tr__panel">
            <h2 className="obx__boxtitle">What runs today</h2>
            <p className="tr__means">Anyone can propose a market and fund it with pledges. That is live on testnet now.</p>
            <div className="gv__stack">
              <Link href="/proposals/" className="mk__btn mk__btn--buy">See the proposals</Link>
              <Link href="/propose/" className="mk__btn">Propose a market</Link>
            </div>
          </section>
          <section className="tr__panel">
            <h2 className="obx__boxtitle">Not built yet</h2>
            <p className="tr__means">There is no decision-market module in the contract, so there is nothing to trade here and no result to show. This page describes the idea only.</p>
          </section>
        </aside>
      </div>
    </div>
  )
}
