'use client'
// A tier's rates against how much of it is lent out, from the tier's own rate model (lending_tiers): the borrow rate
// (solid) and what lenders earn (green), the kink, and where the tier is now. Drawn like the borrow page's risk chart.
import type { TierConfig } from '../../chain/domain'
import { pct } from '../../chain/format'
import { annualRate, borrowRate, curvePoints, supplyRate, WAD } from '../../chain/lending'

const W = 1100, H = 240, L = 56, R = 16, T = 16, B = 30

export function RateCurve({ config, utilization }: { config: TierConfig; utilization: bigint }) {
  const pts = curvePoints(config, 41)
  const top = annualRate(pts[pts.length - 1].borrow)
  const yMax = top > 0n ? (top * 108n) / 100n : WAD
  const u = utilization > WAD ? WAD : utilization
  const x = (v: bigint) => L + (Number((v * 10_000n) / WAD) / 10_000) * (W - L - R)
  const y = (apr: bigint) => H - B - (Number((apr * 10_000n) / yMax) / 10_000) * (H - T - B)
  const line = (k: 'borrow' | 'supply') => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.u).toFixed(1)},${y(annualRate(p[k])).toFixed(1)}`).join(' ')
  const nowBorrow = annualRate(borrowRate(u, config))
  const nowSupply = annualRate(supplyRate(borrowRate(u, config), WAD, u, config.reserveFactor))
  const ticks = [0n, yMax / 4n, yMax / 2n, (yMax * 3n) / 4n]
  return (
    <svg className="risk__chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Borrow rate ${pct(nowBorrow, WAD, 2)} and lenders ${pct(nowSupply, WAD, 2)} at ${pct(u, WAD, 1)} lent out; ${pct(top, WAD, 1)} to borrow when all of it is lent`}>
      {ticks.map((t) => <g key={String(t)}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="rgba(255,255,255,0.05)" /><text x={L - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="#8e96a8">{pct(t, WAD, 0)}</text></g>)}
      {[0n, WAD / 4n, WAD / 2n, (WAD * 3n) / 4n, WAD].map((v) => <text key={String(v)} x={x(v)} y={H - 10} textAnchor={v === 0n ? 'start' : v === WAD ? 'end' : 'middle'} fontSize="10" fill="#8e96a8">{pct(v, WAD, 0)} lent</text>)}
      <line x1={x(config.rateKink)} x2={x(config.rateKink)} y1={T} y2={H - B} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 4" />
      <text x={x(config.rateKink) + 6} y={T + 10} fontSize="10" fill="#8e96a8">rates climb faster past {pct(config.rateKink, WAD, 0)}</text>
      <path d={line('borrow')} fill="none" stroke="rgba(233,227,216,0.55)" strokeWidth="2" />
      <path d={line('supply')} fill="none" stroke="#7dc9a5" strokeWidth="2.5" />
      <line x1={x(u)} x2={x(u)} y1={T} y2={H - B} stroke="#f0c05a" strokeOpacity="0.5" />
      <circle cx={x(u)} cy={y(nowBorrow)} r="4" fill="#f2f2ee" />
      <circle cx={x(u)} cy={y(nowSupply)} r="4" fill="#7dc9a5" />
    </svg>
  )
}
