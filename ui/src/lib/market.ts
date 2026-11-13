// Demo price history for the landing's odds tickers (replace with real data from the pools later).

// a history that ends at today's chance
export function history(end: number, seed: string) {
  let s = [...seed].reduce((a, c) => a + c.charCodeAt(0), 0)
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280)
  const pts: number[] = []
  let v = Math.min(0.95, Math.max(0.05, end + (rnd() - 0.5) * 0.25))
  for (let i = 0; i < 30; i++) {
    v += (end - v) * 0.08 + (rnd() - 0.5) * 0.04
    pts.push(Math.min(1, Math.max(0, v)))
  }
  pts[pts.length - 1] = end
  return pts
}

// change in chance over the last 7 days of the demo history, in percentage points
export function weekMove(end: number, seed: string) {
  const h = history(end, seed)
  return (end - h[h.length - 8]) * 100
}
