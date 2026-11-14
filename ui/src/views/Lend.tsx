// Lend, in the trading screen's style: a header with the pool's rates, a chart of what lenders earn, how much of the
// pool is lent out, every market you can underwrite (Root LP) as cards with their artwork, and where the risk sits.
// On the right: the supply ticket and your position.
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AreaChart, MarketArt, WorldIcon } from '../components/Grand'
import { Button } from '../components/ui'
import { pct, usd } from '../lib/format'
import { series } from '../lib/history'
import { actions, bitsOf, liveOdds, rates, useStore } from '../lib/scenario'
import { useClient, useWallet } from '../lib/wallet'

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
const compact = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`)

export default function Lend() {
  const { account, connect, connectDemo } = useWallet()
  const client = useClient()
  const { markets, sc, pool, wallet } = useStore()
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<'supply' | 'withdraw'>('supply')
  const a = Number(amount) || 0
  const canOut = Math.max(0, Math.min(pool.lent, pool.supplied - pool.borrowed))
  // where the pool's USDC is lent: your loans by market, and everyone else's (the demo's other borrowers)
  const yourLoans = markets.filter((m) => sc[m.id].debt > 0)
  const othersBorrowed = Math.max(0, pool.borrowed - yourLoans.reduce((t, m) => t + sc[m.id].debt, 0))
  const r = rates(pool)
  const open = markets.filter((m) => bitsOf(sc[m.id].possible, m.worlds.length).length > 1)
  const supplyKey = r.supply.toFixed(6)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const apr = useMemo(() => series('lend:apr', r.supply * 100, 90, 0.05), [supplyKey])
  const after = rates({ ...pool, supplied: pool.supplied + a })

  return (
    <div className="page tr desk">
      <header className="tr__pair">
        <div className="tr__id">
          <h1 className="mk__title">Lend</h1>
          <p className="tr__means">Every borrower is limited by the world where their collateral is worth least, so each loan is covered in every world that can still happen. Lenders earn what borrowers pay.</p>
        </div>
        <div className="tr__quote">
          <b className="num is-up">{pct(r.supply, 2)}</b>
          <span className="pc__note">lenders earn, a year</span>
        </div>
        <dl className="tr__stats">
          <div><dt>Borrow rate</dt><dd className="num">{pct(r.borrow, 2)} fixed</dd></div>
          <div><dt>Pool</dt><dd className="num">{compact(pool.supplied)}</dd></div>
          <div><dt>Lent out</dt><dd className="num">{compact(pool.borrowed)}</dd></div>
          <div><dt>You supplied</dt><dd className="num">{usd(pool.lent)}</dd></div>
        </dl>
      </header>

      <div className="mk__grid">
        <div className="mk__main">
          <section className="tr__panel">
            <div className="desk__head">
              <h2 className="obx__boxtitle">What lenders earn</h2>
              <span className="pc__note">Last 90 days · demo history</span>
            </div>
            <AreaChart data={apr} color="#7dc9a5" format={(v) => `${v.toFixed(2)}%`} height={220} />
            <div className="util">
              <div className="util__bar"><i style={{ width: pct(r.use, 1) }} /></div>
              <div className="util__legend">
                <span><i className="is-lent" />Lent out <b className="num">{pct(r.use, 1)}</b> · {usd(pool.borrowed)}</span>
                <span><i />Free to withdraw <b className="num">{usd(pool.supplied - pool.borrowed)}</b></span>
              </div>
              <p className="pc__note">Lenders earn the borrow rate × the share lent out: {pct(r.borrow, 0)} × {pct(r.use, 1)} = {pct(r.supply, 2)}.</p>
            </div>
          </section>

          <section className="tr__panel">
            <div className="desk__head"><h2 className="obx__boxtitle">Where the pool is lent</h2><span className="pc__note">Every loan is sized by its worst world</span></div>
            <div className="alloc">
              {[...yourLoans.map((m) => ({ key: m.id, m, label: m.question, v: sc[m.id].debt })), { key: 'others', m: null, label: 'Other borrowers (demo)', v: othersBorrowed }, { key: 'idle', m: null, label: 'Not lent out', v: pool.supplied - pool.borrowed }]
                .filter((x) => x.v > 0)
                .map((x, i) => (
                  <div key={x.key} className="alloc__row">
                    <span className="desk__mk">{x.m ? <MarketArt m={x.m} size={24} /> : <span className={`alloc__sw alloc__sw--${i % 3}`} />}{x.label}</span>
                    <span className="alloc__bar"><i style={{ width: pct(x.v / pool.supplied, 1) }} className={x.key === 'idle' ? 'is-idle' : ''} /></span>
                    <b className="num">{usd(x.v)}</b>
                    <small className="num">{pct(x.v / pool.supplied, 1)}</small>
                  </div>
                ))}
            </div>
          </section>

          <section className="tr__panel">
            <div className="desk__head">
              <h2 className="obx__boxtitle">Underwrite every world</h2>
              <span className="pc__note">Root liquidity: earn the swap fees</span>
            </div>
            <p className="tr__means">One deposit is split into every world of a market and added to each world’s pool at its own price. You take the other side of every conditional sale and earn the fees (0.30%, more when trading is one-sided). When one world is left, its share comes back as real tokens.</p>
            <div className="lend__markets">
              {open.map((m) => {
                const s = sc[m.id], o = liveOdds(m, s)
                const live = bitsOf(s.possible, m.worlds.length)
                const depth = live.reduce((t, w) => t + s.poolUsdc[w], 0)
                return (
                  <Link key={m.id} href={`/markets/${m.id}`} className="lend__card">
                    <div className="lend__top"><MarketArt m={m} size={44} /><b>{m.question}</b></div>
                    <div className="lend__worlds">
                      {live.map((w) => <span key={w}><WorldIcon m={m} w={w} size={18} />{m.worlds[w].outcome}<b className="num">{pct(o[w])}</b></span>)}
                    </div>
                    <dl>
                      <div><dt>Pools</dt><dd className="num">{compact(depth)}</dd></div>
                      <div><dt>You added</dt><dd className="num">{usd(s.lp)}</dd></div>
                      <div><dt>Fees earned</dt><dd className="num is-up">{usd(s.lpFees)}</dd></div>
                    </dl>
                    <span className="mk__btn mk__btn--buy">Add liquidity</span>
                  </Link>
                )
              })}
            </div>
          </section>
        </div>

        <aside className="mk__side">
          <section className="tr__panel mk__ticket">
            <div className="pc__tabs" role="group" aria-label="Supply or withdraw">
              <button type="button" aria-pressed={mode === 'supply'} onClick={() => { setMode('supply'); setAmount('') }}>Supply</button>
              <button type="button" aria-pressed={mode === 'withdraw'} onClick={() => { setMode('withdraw'); setAmount('') }} disabled={pool.lent <= 0}>Withdraw</button>
            </div>
            {account && mode === 'withdraw' ? (
              <>
                <p className="ticket__help">Take your USDC back from the part of the pool that isn’t lent out.</p>
                <label className="tk__field"><span>Amount</span>
                  <input aria-label="USDC to withdraw" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
                  <em>USDC</em>
                </label>
                <div className="tk__pcts">
                  {[0.25, 0.5, 0.75, 1].map((k) => <button key={k} type="button" onClick={() => setAmount(String(Math.floor(canOut * k)))}>{k === 1 ? 'Max' : `${k * 100}%`}</button>)}
                </div>
                <p className="tk__line"><span>You supplied</span><b className="num">{usd(pool.lent)}</b></p>
                <p className="tk__line"><span>Free to withdraw now</span><b className="num">{usd(canOut)}</b></p>
                <div className="tk tk--sell">
                  <Button onClick={() => { actions.withdraw(a); setAmount('') }} disabled={!(a > 0) || a > canOut + 1e-9}>
                    {a > canOut + 1e-9 ? 'More than you can withdraw now' : a > 0 ? `Withdraw ${fmt(a)} USDC` : 'Enter an amount'}
                  </Button>
                </div>
              </>
            ) : !account ? (
              <div className="tr__gate">
                <Button onClick={connect}>Connect NEAR wallet</Button>
                <button type="button" className="ticket__switch" onClick={connectDemo}>or explore with the demo wallet</button>
              </div>
            ) : (
              <>
                <p className="ticket__help">Supply real USDC to the lending pool. You earn on the part that’s lent out, and can withdraw what isn’t.</p>
                <label className="tk__field"><span>Amount</span>
                  <input aria-label="USDC to supply" inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
                  <em>USDC</em>
                </label>
                <div className="tk__pcts">
                  {[0.25, 0.5, 0.75, 1].map((k) => <button key={k} type="button" onClick={() => setAmount(String(Math.floor(wallet.usdc * k)))}>{k * 100}%</button>)}
                </div>
                <p className="tk__line"><span>In your wallet</span><b className="num">{fmt(wallet.usdc)} USDC</b></p>
                <p className="tk__line"><span>Rate after</span><b className="num">{pct(after.supply, 2)}</b></p>
                <p className="tk__line"><span>Earns about</span><b className="num">{usd(a * after.supply)} a year</b></p>
                <div className="tk tk--buy">
                  <Button onClick={() => { client.supply(a); setAmount('') }} disabled={!(a > 0) || a > wallet.usdc + 1e-9}>
                    {a > wallet.usdc + 1e-9 ? `You have ${fmt(wallet.usdc)} USDC in your wallet` : a > 0 ? `Supply ${fmt(a)} USDC` : 'Supply USDC'}
                  </Button>
                </div>
              </>
            )}
          </section>

          <section className="tr__panel">
            <h2 className="obx__boxtitle">Where the risk sits</h2>
            <ul className="risk">
              <li className="is-ok"><b>Any one future</b> The worst world still pays every loan back.</li>
              <li className="is-ok"><b>An event being answered</b> Removing worlds can’t make the worst one worse.</li>
              <li className="is-warn"><b>A very fast crash</b> Faster than liquidators can act, the loss falls on lenders. An insurance fund is on the roadmap.</li>
              <li><b>Withdrawals</b> Come from USDC that isn’t lent out.</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}
