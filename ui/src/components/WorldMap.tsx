// A small map of a market's worlds, laid out like the grid on its market page: one tile per world,
// shaded by its chance. Worlds that can no longer happen fade; once one is left it turns to paper.
import type { CSSProperties } from 'react'
import { pct } from '../lib/format'
import { count, gridOf, has, liveOdds, type Scenario } from '../lib/scenario'
import type { Market } from '../lib/types'

export function WorldMap({ m, s }: { m: Market; s: Scenario }) {
  const grid = gridOf(m)
  const odds = liveOdds(m, s)
  const settled = count(s.possible) === 1
  return (
    <span className="wmap" style={{ gridTemplateColumns: `repeat(${grid.cols.length}, minmax(0, 1fr))` } as CSSProperties} aria-hidden>
      {grid.rows.flatMap((row) => row.bits.map((b) => {
        const dead = !has(s.possible, b)
        return (
          <span
            key={b}
            className={`wmap__tile${dead ? ' is-dead' : ''}${settled && !dead ? ' is-real' : ''}`}
            style={{ '--p': odds[b] } as CSSProperties}
          >
            <span className="wmap__name">{m.worlds[b].outcome}</span>
            <b>{dead ? '0%' : pct(odds[b])}</b>
          </span>
        )
      }))}
    </span>
  )
}
