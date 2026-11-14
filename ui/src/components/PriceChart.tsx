// The price chart for one world's NEAR/USDC pool, drawn with TradingView's lightweight-charts: the pool's price after
// each of the market's recent swaps (the contract keeps the last 64, its Impact Meter), as a stepped line with a
// readout that follows the crosshair, and a depth view of the resting orders. Both read the chain; there are no
// candles, since the contract keeps no trade history to build them from.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ColorType, CrosshairMode, LineSeries, LineType, createChart, type IChartApi, type ISeriesApi, type MouseEventParams, type UTCTimestamp } from 'lightweight-charts'
import type { PricePoint } from '../chain/book'
import type { Order } from '../chain/orders'
import { toNum } from '../chain/adapter'

const UP = '#7dc9a5' // the trading screen's buy colour: a muted green that sits with the maroon brand
const DOWN = '#cf6b78' // its sell colour: the brand's rose, deepened
const p2 = (n: number) => n.toFixed(2)
const when = (sec: number) => new Date(sec * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

function Line({ points, color }: { points: PricePoint[]; color: string }) {
  const box = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const series = useRef<ISeriesApi<'Line'> | null>(null)
  const data = useMemo(() => points.map((p) => ({ time: p.at as UTCTimestamp, value: toNum(p.price) })), [points])
  const [hover, setHover] = useState<number | null>(null)
  const shown = hover ?? data.length - 1
  const first = data[0]?.value ?? 0
  const at = data[shown]
  const ch = at ? at.value - first : 0

  // build the chart once
  useEffect(() => {
    if (!box.current) return
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8e96a8', fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, rightOffset: 2 },
    })
    series.current = c.addSeries(LineSeries, { color, lineWidth: 2, lineType: LineType.WithSteps, priceFormat: { type: 'price', precision: 4, minMove: 0.0001 } })
    chart.current = c
    return () => { c.remove(); chart.current = null; series.current = null }
  }, [color])

  // feed it whenever the points change
  useEffect(() => {
    const s = series.current, c = chart.current
    if (!s || !c) return
    s.setData(data)
    c.timeScale().fitContent()
    const onMove = (e: MouseEventParams) => {
      const i = e.time === undefined ? -1 : data.findIndex((x) => x.time === e.time)
      setHover(i < 0 ? null : i)
    }
    c.subscribeCrosshairMove(onMove)
    return () => c.unsubscribeCrosshairMove(onMove)
  }, [data])

  return (
    <>
      <div className="pc__legend num">
        <span>Price <b>{at ? at.value.toFixed(4) : '–'}</b></span>
        <span>At <b>{at ? when(at.time) : '–'}</b></span>
        <span>Over these swaps <b className={ch >= 0 ? 'is-up' : 'is-down'}>{ch >= 0 ? '+' : ''}{first > 0 ? ((ch / first) * 100).toFixed(2) : '0.00'}%</b></span>
        <span>Swaps <b>{data.length}</b></span>
      </div>
      <div ref={box} className="pc__canvas" />
    </>
  )
}

// cumulative resting size away from the price: bids stepping down to the left, asks stepping up to the right
function Depth({ bids, asks, price }: { bids: Order[]; asks: Order[]; price: number }) {
  const W = 800, H = 300, pad = 28
  const sideOf = (os: Order[]) => { let run = 0; return os.map((o) => ({ p: toNum(o.price), q: (run += toNum(o.remaining)) })) }
  const b = sideOf(bids), a = sideOf(asks)
  const mid = price > 0 ? price : (b[0]?.p ?? a[0]?.p ?? 1)
  const lo = Math.min(mid * 0.9, ...b.map((x) => x.p)), hi = Math.max(mid * 1.1, ...a.map((x) => x.p))
  const top = Math.max(1, b.at(-1)?.q ?? 0, a.at(-1)?.q ?? 0) * 1.1
  const x = (p: number) => pad + ((p - lo) / (hi - lo)) * (W - pad * 2)
  const y = (q: number) => H - pad - (q / top) * (H - pad * 2)
  const steps = (pts: { p: number; q: number }[], dir: 1 | -1) => {
    if (!pts.length) return ''
    let d = `M${x(pts[0].p)},${y(0)}`
    let q = 0
    for (const pt of pts) { d += ` L${x(pt.p)},${y(q)} L${x(pt.p)},${y(pt.q)}`; q = pt.q }
    const edge = dir < 0 ? lo : hi
    return `${d} L${x(edge)},${y(q)} L${x(edge)},${y(0)} Z`
  }
  return (
    <svg className="pc__depth" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Depth: cumulative buy orders left of the price, sell orders right of it">
      <path d={steps(b, -1)} fill="rgba(125,201,165,0.14)" stroke={UP} strokeWidth="1.5" />
      <path d={steps(a, 1)} fill="rgba(207,107,120,0.16)" stroke={DOWN} strokeWidth="1.5" />
      {price > 0 && <line x1={x(price)} x2={x(price)} y1={pad} y2={H - pad} stroke="rgba(255,255,255,0.3)" strokeDasharray="4 4" />}
      {price > 0 && <text x={x(price)} y={pad - 8} textAnchor="middle" fill="#f2f2ee" fontSize="12">pool {p2(price)}</text>}
      {[lo, mid, hi].map((p) => <text key={p} x={x(p)} y={H - 8} textAnchor="middle" fill="#8e96a8" fontSize="11">{p2(p)}</text>)}
      <text x={W - pad} y={pad + 12} textAnchor="end" fill="#8e96a8" fontSize="11">{Math.round(top / 1.1).toLocaleString('en-US')} NEAR</text>
    </svg>
  )
}

export function PriceChart({ points, bids, asks, price, color = UP }: { points: PricePoint[]; bids: Order[]; asks: Order[]; price: bigint; color?: string }) {
  const [view, setView] = useState<'chart' | 'depth'>('chart')
  const empty = bids.length + asks.length === 0
  return (
    <section className="pc" aria-label="Price chart">
      <div className="pc__head">
        <div className="pc__tabs" role="group" aria-label="Chart or depth">
          <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>Chart</button>
          <button type="button" aria-pressed={view === 'depth'} onClick={() => setView('depth')}>Depth</button>
        </div>
        <span className="pc__note">{view === 'chart' ? 'Pool price after each recent swap in this market, from the chain' : 'Resting orders in this world, from the chain'}</span>
      </div>
      {view === 'chart'
        ? points.length < 2
          ? <p className="obx__empty pc__none">{points.length === 0 ? 'No swaps through this world’s pool yet.' : 'One swap so far: the line starts with the next one.'}</p>
          : <Line points={points} color={color} />
        : empty
          ? <p className="obx__empty pc__none">No resting orders in this world.</p>
          : <Depth bids={bids} asks={asks} price={toNum(price)} />}
    </section>
  )
}
