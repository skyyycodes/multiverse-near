// A cutting-mat grid laid flat into the distance, drawn as true perspective lines.
const W = 1600
const H = 520
const VP = { x: W / 2, y: -420 } // vanishing point, above the top edge

const rays = Array.from({ length: 41 }, (_, i) => {
  const xb = W / 2 + (i - 20) * 110 // where the line meets the bottom edge
  const t = (0 - H) / (VP.y - H) // where it crosses the top edge
  return { x1: xb, y1: H, x2: xb + (VP.x - xb) * t, y2: 0 }
})

// rows get closer together with distance
const rows = Array.from({ length: 16 }, (_, k) => H - H * (1 - 1 / (1 + k * 0.42)) * 1.7).filter((y) => y > 0)

export function GridFloor({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" aria-hidden>
      <g stroke="var(--grid)" strokeWidth="1">
        {rays.map((r, i) => <line key={`r${i}`} {...r} vectorEffect="non-scaling-stroke" />)}
        {rows.map((y, i) => <line key={`h${i}`} x1={0} y1={y} x2={W} y2={y} vectorEffect="non-scaling-stroke" />)}
      </g>
    </svg>
  )
}
