// What each world counts for as collateral, drawn the same way as the landing's example: paper bars
// hold NEAR, blue bars hold dollars, the orange line is your floor (the weakest world). With a loan, a
// dashed line shows what the loan needs; the gap between the two lines is your safety margin.
import { usd } from '../lib/format'
import { LLTV, backing, has, type Scenario } from '../lib/scenario'
import type { Market } from '../lib/types'

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

export function CollateralBars({ m, s, scale }: { m: Market; s: Scenario; scale?: number }) {
  const live = m.worlds.map((_, b) => b).filter((b) => has(s.possible, b))
  const values = m.worlds.map((_, b) => (has(s.possible, b) ? backing(s, b) : 0))
  const floor = live.length ? Math.min(...live.map((b) => values[b])) : 0
  const needs = s.debt > 0 ? s.debt / LLTV : 0
  const top = scale ?? Math.max(1, ...values, needs) * 1.12 // a fixed scale lets two charts be compared
  const pos = (v: number) => `${(v / top) * 100}%`

  return (
    <div className="floor floor--static">
      <div className="floor__plot" style={{ gridTemplateColumns: `repeat(${m.worlds.length}, minmax(0, 1fr))` }}>
        {m.worlds.map((w, b) => {
          const dead = !has(s.possible, b)
          const near = s.near[b] > 0
          return (
            <div key={w.id} className={`floor__col${near ? '' : ' is-usdc'}${dead ? ' is-dead' : ''}${!dead && values[b] === floor ? ' is-weakest' : ''}`}>
              <span className="floor__track">
                <span className="floor__bar" style={{ height: dead ? '0%' : pos(values[b]) }}>
                  {!dead && <b>{near ? `${fmt(s.near[b])} NEAR` : `${fmt(s.usdc[b])} USDC`}</b>}
                  {!dead && <small>counts {usd(values[b])}</small>}
                </span>
              </span>
              <span className="floor__name">{w.outcome}</span>
              <span className="floor__meta">{dead ? 'Didn’t happen' : `NEAR at $${s.price[b]}`}</span>
            </div>
          )
        })}
        <div className="floor__lines" aria-hidden>
          {needs > 0 && <i className="floor__line floor__line--base" style={{ bottom: pos(needs) }}><span>Your loan needs {usd(needs)}</span></i>}
          {live.length > 0 && <i className="floor__line" style={{ bottom: pos(floor) }}><span>Your floor {usd(floor)}</span></i>}
        </div>
      </div>
    </div>
  )
}
