import { useEffect, useState } from 'react'
import { Button } from '../components/ui'
import { BRANCHES, futarchy, leader, price, quoteBuy, quoteSell, useProposal, type Branch } from '../lib/futarchy'
import { useWallet } from '../lib/wallet'

const fmt = (n: number, d = 2) => n.toLocaleString('en-US', { maximumFractionDigits: d })
const LABEL: Record<Branch, string> = { pass: 'If it passes', fail: 'If it fails' }
const clock = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

// one branch: its NEAR price, what you hold in it, and a buy / sell form
function BranchSheet({ b }: { b: Branch }) {
  const p = useProposal()
  const { account } = useWallet()
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('')
  const a = Number(amount) || 0
  const pool = p.pools[b], h = p.held[b]
  const leading = leader(p) === b
  const decided = p.decided
  const out = side === 'buy' ? quoteBuy(pool, a) : quoteSell(pool, a)
  const max = side === 'buy' ? h.usdc : h.near
  const lost = decided && decided !== b

  return (
    <section className={`branch branch--${b}${leading && !decided ? ' is-leading' : ''}${decided === b ? ' is-won' : ''}${lost ? ' is-lost' : ''}`}>
      <p className="branch__label">{LABEL[b]}</p>
      <p className="branch__price">${price(pool).toFixed(2)}</p>
      <p className="branch__sub">NEAR in this future</p>
      {leading && !decided && <span className="branch__tag">Deciding</span>}
      {decided === b && <span className="branch__tag">Became real</span>}
      {lost && <span className="branch__tag branch__tag--lost">Undone</span>}
      <dl className="branch__held">
        <div><dt>You hold here</dt><dd>{fmt(h.near)} NEAR</dd></div>
        <div><dt>and</dt><dd>{fmt(h.usdc)} USDC</dd></div>
      </dl>
      {!decided && account && (
        <div className="branch__trade">
          <div className="sc__seg" role="group" aria-label="Buy or sell">
            {(['buy', 'sell'] as const).map((x) => <button key={x} type="button" aria-pressed={side === x} onClick={() => { setSide(x); setAmount('') }}>{x === 'buy' ? 'Buy NEAR' : 'Sell NEAR'}</button>)}
          </div>
          <div className="field">
            <div className="field__box">
              <input aria-label={side === 'buy' ? 'USDC to spend' : 'NEAR to sell'} inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
              <span className="field__unit">{side === 'buy' ? 'USDC' : 'NEAR'}</span>
            </div>
            <div className="field__quick"><button type="button" onClick={() => setAmount(String(Math.floor(max * 100) / 100))}>Max</button></div>
          </div>
          <Button
            onClick={() => { if (side === 'buy') futarchy.buy(b, a); else futarchy.sell(b, a); setAmount('') }}
            disabled={!(a > 0) || a > max + 1e-9}
          >
            {!(a > 0) ? (side === 'buy' ? 'Buy NEAR' : 'Sell NEAR') : a > max + 1e-9 ? `You have ${fmt(max)} ${side === 'buy' ? 'USDC' : 'NEAR'} here` : side === 'buy' ? `Get ${fmt(out)} NEAR` : `Get ${fmt(out)} USDC`}
          </Button>
        </div>
      )}
    </section>
  )
}

export default function Proposals() {
  const p = useProposal()
  const { account, connect, connectDemo } = useWallet()
  const [split, setSplit] = useState('')
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  // trading closes on its own when the clock runs out
  useEffect(() => { if (now && !p.decided && now >= p.closesAt) futarchy.decide() }, [now, p.decided, p.closesAt])
  const s = Number(split) || 0
  const w = p.decided

  return (
    <div className="page page--wide proposals">
      <div className="page__head">
        <p className="proposals__kind">Decision market · demo only, not in the contract yet</p>
        <h1 className="page__title">{p.question}</h1>
        <p className="page__sub">{p.detail}</p>
      </div>

      <div className="proposals__rule">
        <p>Trade NEAR in the future where it passes and the future where it fails. When trading closes, the future where NEAR is worth more decides, and every trade in the other one is undone.</p>
        <div className="proposals__clock">
          {w ? <b>Decided: it {w === 'pass' ? 'passes' : 'fails'}</b> : <><span>Trading closes in</span><b className="num">{now ? clock(p.closesAt - now) : '–'}</b></>}
          {!w && <Button variant="ghost" onClick={futarchy.decide}>Decide now (demo)</Button>}
          {w && <Button variant="ghost" onClick={futarchy.reset}>Start over</Button>}
        </div>
      </div>

      {!account ? (
        <div className="proposals__gate">
          <Button onClick={connect}>Connect NEAR wallet</Button>
          <button type="button" className="ticket__switch" onClick={connectDemo}>or explore with the demo wallet</button>
        </div>
      ) : !w && (
        <div className="proposals__split">
          <p>Split USDC into both futures. Each USDC becomes one to trade if it passes and one if it fails. <b>{fmt(p.wallet)} USDC</b> in your wallet.</p>
          <div className="field">
            <div className="field__box">
              <input aria-label="USDC to split" inputMode="decimal" placeholder="0" value={split} onChange={(e) => setSplit(e.target.value.replace(/[^0-9.]/g, ''))} />
              <span className="field__unit">USDC</span>
            </div>
          </div>
          <Button onClick={() => { futarchy.split(s); setSplit('') }} disabled={!(s > 0) || s > p.wallet}>{s > 0 ? `Split ${fmt(s)} USDC` : 'Split USDC'}</Button>
        </div>
      )}

      <div className="proposals__branches">
        {BRANCHES.map((b) => <BranchSheet key={b} b={b} />)}
      </div>

      {w && (
        <p className="proposals__result">
          You now hold <b>{fmt(p.held[w].near)} NEAR</b> and <b>{fmt(p.held[w].usdc + p.wallet)} USDC</b>: what you held where it {w === 'pass' ? 'passes' : 'fails'}, plus anything you never split.
        </p>
      )}
      {p.log.length > 0 && <ol className="sc__log">{p.log.map((l, i) => <li key={i}>{l}</li>)}</ol>}
    </div>
  )
}
