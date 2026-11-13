// The owner console, in the trading screen's style: pick a market by its artwork, then resolve its events (propose,
// dispute, finalize, or resolve at once), move NEAR's price in one world, mint test tokens and seed it again. On
// testnet only the owner account can do these; here they run on the demo model.
import { useEffect, useState } from 'react'
import { MarketArt, WorldIcon } from '../components/Grand'
import { Button } from '../components/ui'
import { DISPUTE_MS, actions, bitsOf, liveOdds, useStore } from '../lib/scenario'
import { pct } from '../lib/format'
import { useWallet } from '../lib/wallet'

const clock = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

export default function Admin() {
  const { account, connect, connectDemo } = useWallet()
  const { markets, sc, wallet } = useStore()
  const [mid, setMid] = useState(markets[0]?.id ?? '')
  const m = markets.find((x) => x.id === mid) ?? markets[0]
  const s = sc[m.id]
  const live = bitsOf(s.possible, m.worlds.length)
  const odds = liveOdds(m, s)
  const [prices, setPrices] = useState<Record<number, string>>({})
  const [now, setNow] = useState(0)
  useEffect(() => { setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])

  return (
    <div className="page tr desk">
      <header className="tr__pair">
        <div className="tr__id">
          <p className="mk__crumb"><span className="mk__tag">Owner only on testnet</span><span className="mk__tag">Demo model here</span></p>
          <h1 className="mk__title">Owner console</h1>
          <p className="tr__means">Resolve events, move NEAR’s price in a world, mint test tokens and seed a market again.</p>
        </div>
        <dl className="tr__stats">
          <div><dt>Markets</dt><dd className="num">{markets.length}</dd></div>
          <div><dt>Wallet wNEAR</dt><dd className="num">{Math.round(wallet.near).toLocaleString('en-US')}</dd></div>
          <div><dt>Wallet USDC</dt><dd className="num">{Math.round(wallet.usdc).toLocaleString('en-US')}</dd></div>
        </dl>
      </header>

      {!account ? (
        <section className="tr__panel tr__gate">
          <p className="tr__means">Connect the owner account to use the console.</p>
          <Button onClick={connect}>Connect NEAR wallet</Button>
          <button type="button" className="ticket__switch" onClick={connectDemo}>or explore with the demo wallet</button>
        </section>
      ) : (
        <>
          <div className="desk__cards" role="group" aria-label="Market">
            {markets.map((x) => (
              <button key={x.id} type="button" aria-pressed={x.id === m.id} className="desk__card" onClick={() => { setMid(x.id); setPrices({}) }}>
                <MarketArt m={x} size={40} />
                <span className="desk__cardtext"><b>{x.question}</b><small>{x.category} · {bitsOf(sc[x.id].possible, x.worlds.length).length} of {x.worlds.length} worlds open</small></span>
              </button>
            ))}
          </div>

          <div className="mk__grid">
            <div className="mk__main">
              <section className="tr__panel">
                <div className="desk__head"><h2 className="obx__boxtitle">Events</h2><span className="pc__note">Dispute window {clock(DISPUTE_MS)}</span></div>
                <p className="tr__means">The reporter proposes; during the window only the owner can dispute and trading pauses; then anyone can finalize. Resolving at once skips the window.</p>
                {m.events.map((ev, e) => {
                  const settled = s.settled[e], p = s.proposals[e]
                  const left = p ? Math.min(DISPUTE_MS, p.at + DISPUTE_MS - now) : 0
                  return (
                    <article key={ev.name} className="rs__event">
                      {ev.image && <img src={ev.image} alt="" width={36} height={36} className="art" />}
                      <div className="rs__body">
                        <div className="rs__line">
                          <b>{ev.name}</b>
                          <span className={`rs__state rs__state--${settled !== null ? 'final' : p ? 'live' : 'open'}`}>
                            {settled !== null ? `Final: ${ev.outcomes[settled]}` : p ? `Proposed ${ev.outcomes[p.outcome]} · ${left > 0 ? clock(left) : 'window closed'}` : 'Open'}
                          </span>
                        </div>
                        {settled === null && (
                          <div className="rs__acts">
                            {p ? (
                              <>
                                <button type="button" className="mk__btn mk__btn--sell" onClick={() => actions.dispute(m.id, e)}>Dispute</button>
                                <button type="button" className="mk__btn mk__btn--buy" onClick={() => actions.finalize(m.id, e)}>Finalize</button>
                              </>
                            ) : (
                              <>
                                <span className="pc__note">Propose:</span>
                                {ev.outcomes.map((o, k) => <button key={o} type="button" className="mk__btn mk__btn--buy" onClick={() => actions.propose(m.id, e, k)}>{o}</button>)}
                                <span className="pc__note">Resolve now:</span>
                                {ev.outcomes.map((o, k) => <button key={`r${o}`} type="button" className="mk__btn mk__btn--sell" onClick={() => actions.adminResolve(m.id, e, k)}>{o}</button>)}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </article>
                  )
                })}
              </section>

              <section className="tr__panel">
                <div className="desk__head"><h2 className="obx__boxtitle">World prices</h2><span className="pc__note">Lending reads the 30-minute average</span></div>
                <p className="tr__means">Move NEAR’s price in one world. On testnet the owner does this by trading into that world’s pool.</p>
                <div className="adm__prices">
                  {live.map((w) => {
                    const v = prices[w] ?? ''
                    const n = Number(v)
                    return (
                      <div key={w} className="adm__price">
                        <WorldIcon m={m} w={w} size={28} possible={s.possible} />
                        <span className="adm__name"><b>{m.worlds[w].outcome}</b><small>{pct(odds[w])} chance</small></span>
                        <b className="num adm__now">${s.price[w].toFixed(2)}</b>
                        <input className="adm__range" type="range" min={0.5} max={8} step={0.05} value={v || s.price[w]} onChange={(e) => setPrices({ ...prices, [w]: e.target.value })} aria-label={`NEAR price in ${m.worlds[w].outcome}`} />
                        <label className="tk__field adm__input"><input inputMode="decimal" placeholder={s.price[w].toFixed(2)} value={v} onChange={(e) => setPrices({ ...prices, [w]: e.target.value.replace(/[^0-9.]/g, '') })} aria-label={`New NEAR price in ${m.worlds[w].outcome}`} /><em>USDC</em></label>
                        <button type="button" className="mk__btn mk__btn--buy" disabled={!(n > 0)} onClick={() => { actions.setPrice(m.id, w, n); setPrices({ ...prices, [w]: '' }) }}>Set</button>
                      </div>
                    )
                  })}
                </div>
              </section>
            </div>

            <aside className="mk__side">
              <section className="tr__panel mk__ticket">
                <h2 className="obx__boxtitle">Test tokens and seeding</h2>
                <p className="ticket__help">Mint test wNEAR and USDC to this wallet, or put this market back to its seeded state: pools, the demo position and the resting orders.</p>
                <div className="tk tk--buy"><Button onClick={() => actions.faucet()}>Mint test tokens</Button></div>
                <Button variant="ghost" onClick={() => actions.reset(m.id)}>Seed this market again</Button>
              </section>
              <section className="tr__panel">
                <h2 className="obx__boxtitle">Log</h2>
                {s.log.length === 0 ? <p className="obx__empty">Nothing yet.</p> : <ol className="sc__log">{s.log.slice(0, 8).map((l, i) => <li key={i}>{l}</li>)}</ol>}
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  )
}
