// What each world counts for as collateral, drawn the same way as the landing's example: paper bars hold NEAR, blue
// bars hold dollars, the orange line is your floor (the weakest world). With a loan, a dashed line shows what the loan
// needs; the gap between the two lines is your safety margin. Plain rows in: a chain position or a what-if from it.
import { usd } from '../lib/format'

export type BarWorld = {
  name: string
  /** What the world holds, in words ("2,000 NEAR", "6,423 USDC"). */
  hold: string
  /** True when it holds dollars there. */
  usdc: boolean
  /** What it counts for, USDC. */
  value: number
  /** NEAR's price in that world. */
  price: number
  /** The world can no longer happen. */
  dead?: boolean
}

export function CollateralBars({ worlds, needs = 0, scale }: { worlds: readonly BarWorld[]; needs?: number; scale?: number }) {
  const live = worlds.filter((w) => !w.dead)
  const floor = live.length ? Math.min(...live.map((w) => w.value)) : 0
  const top = scale ?? Math.max(1, ...worlds.map((w) => w.value), needs) * 1.12 // a fixed scale lets two charts be compared
  const pos = (v: number) => `${(v / top) * 100}%`

  return (
    <div className="floor floor--static">
      <div className="floor__plot" style={{ gridTemplateColumns: `repeat(${worlds.length}, minmax(0, 1fr))` }}>
        {worlds.map((w) => (
          <div key={w.name} className={`floor__col${w.usdc ? ' is-usdc' : ''}${w.dead ? ' is-dead' : ''}${!w.dead && w.value === floor ? ' is-weakest' : ''}`}>
            <span className="floor__track">
              <span className="floor__bar" style={{ height: w.dead ? '0%' : pos(w.value) }}>
                {!w.dead && <b>{w.hold}</b>}
                {!w.dead && <small>counts {usd(w.value)}</small>}
              </span>
            </span>
            <span className="floor__name">{w.name}</span>
            <span className="floor__meta">{w.dead ? 'Didn’t happen' : `NEAR at $${w.price.toFixed(2)}`}</span>
          </div>
        ))}
        <div className="floor__lines" aria-hidden>
          {needs > 0 && <i className="floor__line floor__line--base" style={{ bottom: pos(needs) }}><span>Your loan needs {usd(needs)}</span></i>}
          {live.length > 0 && <i className="floor__line" style={{ bottom: pos(floor) }}><span>Your floor {usd(floor)}</span></i>}
        </div>
      </div>
    </div>
  )
}
