// The price chart for one world's NEAR/USDC pool, drawn with TradingView's lightweight-charts: candles, volume under
// them, MA(7), MA(25) and MA(99), an OHLC readout that follows the crosshair, interval buttons, and a depth view
// of the resting orders. The candles are demo history (lib/history.ts), labelled as such.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, createChart,
  type IChartApi, type ISeriesApi, type MouseEventParams, type UTCTimestamp,
} from 'lightweight-charts'
import { INTERVALS, candles, type Candle, type Interval } from '../lib/history'
import type { Order } from '../lib/scenario'

const UP = '#7dc9a5' // the trading screen's buy colour: a muted green that sits with the maroon brand
const DOWN = '#cf6b78' // its sell colour: the brand's rose, deepened
const MAS = [{ n: 7, color: '#f0c05a' }, { n: 25, color: '#d77bd0' }, { n: 99, color: '#8f8cf2' }]
const p2 = (n: number) => n.toFixed(2)

const ma = (cs: Candle[], n: number) =>
  cs.flatMap((c, i) => (i < n - 1 ? [] : [{ time: c.time as UTCTimestamp, value: cs.slice(i - n + 1, i + 1).reduce((t, x) => t + x.close, 0) / n }]))

type Legend = { c: Candle; mas: (number | undefined)[] }

function Candles({ market, world, price }: { market: string; world: number; price: number }) {
  const box = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const series = useRef<{ k: ISeriesApi<'Candlestick'>; v: ISeriesApi<'Histogram'>; m: ISeriesApi<'Line'>[] } | null>(null)
  const [interval, setInterval_] = useState<Interval>('1H')
  const data = useMemo(() => candles(market, world, interval, price), [market, world, interval, price])
  const mas = useMemo(() => MAS.map((x) => ma(data, x.n)), [data])
  const last: Legend = { c: data[data.length - 1], mas: mas.map((x) => x.at(-1)?.value) }
  const [hover, setHover] = useState<Legend | null>(null)
  const legend = hover ?? last

  // build the chart once
  useEffect(() => {
    if (!box.current) return
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8e96a8', fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, rightOffset: 4 },
    })
    const k = c.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } })
    const v = c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false })
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
    const m = MAS.map((x) => c.addSeries(LineSeries, { color: x.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }))
    chart.current = c
    series.current = { k, v, m }
    return () => { c.remove(); chart.current = null; series.current = null }
  }, [])

  // feed it whenever the world, the interval or the price changes
  useEffect(() => {
    const s = series.current, c = chart.current
    if (!s || !c) return
    s.k.setData(data.map((x) => ({ time: x.time as UTCTimestamp, open: x.open, high: x.high, low: x.low, close: x.close })))
    s.v.setData(data.map((x) => ({ time: x.time as UTCTimestamp, value: x.volume, color: x.close >= x.open ? 'rgba(125,201,165,0.3)' : 'rgba(207,107,120,0.32)' })))
    s.m.forEach((line, i) => line.setData(mas[i]))
    const onMove = (e: MouseEventParams) => {
      if (!e.time || !e.point) { setHover(null); return }
      const i = data.findIndex((x) => x.time === e.time)
      if (i < 0) { setHover(null); return }
      setHover({ c: data[i], mas: mas.map((x) => x.find((y) => y.time === e.time)?.value) })
    }
    c.subscribeCrosshairMove(onMove)
    return () => c.unsubscribeCrosshairMove(onMove)
  }, [data, mas])

  // a new world or interval starts zoomed to the latest candles
  useEffect(() => { chart.current?.timeScale().setVisibleLogicalRange({ from: data.length - 90, to: data.length + 3 }) }, [market, world, interval, data.length])

  const ch = legend.c.close - legend.c.open
  return (
    <>
      <div className="pc__tools">
        <div className="pc__intervals" role="group" aria-label="Interval">
          {INTERVALS.map((x) => <button key={x} type="button" aria-pressed={interval === x} onClick={() => setInterval_(x)}>{x}</button>)}
        </div>
      </div>
      <div className="pc__legend num">
        <span>O <b className={ch >= 0 ? 'is-up' : 'is-down'}>{p2(legend.c.open)}</b></span>
        <span>H <b className={ch >= 0 ? 'is-up' : 'is-down'}>{p2(legend.c.high)}</b></span>
        <span>L <b className={ch >= 0 ? 'is-up' : 'is-down'}>{p2(legend.c.low)}</b></span>
        <span>C <b className={ch >= 0 ? 'is-up' : 'is-down'}>{p2(legend.c.close)}</b></span>
        <span>Change <b className={ch >= 0 ? 'is-up' : 'is-down'}>{ch >= 0 ? '+' : ''}{((ch / legend.c.open) * 100).toFixed(2)}%</b></span>
        <span>Vol <b>{legend.c.volume.toLocaleString('en-US')}</b></span>
      </div>
      <div className="pc__legend pc__legend--ma num">
        {MAS.map((x, i) => <span key={x.n} style={{ color: x.color }}>MA({x.n}) {legend.mas[i] === undefined ? '–' : p2(legend.mas[i]!)}</span>)}
      </div>
      <div ref={box} className="pc__canvas" />
    </>
  )
}

// cumulative resting size away from the price: bids stepping down to the left, asks stepping up to the right
function Depth({ bids, asks, price }: { bids: Order[]; asks: Order[]; price: number }) {
  const W = 800, H = 300, pad = 28
  const sideOf = (os: Order[]) => { let run = 0; return os.map((o) => ({ p: o.price, q: (run += o.amount) })) }
  const b = sideOf(bids), a = sideOf(asks)
  const lo = Math.min(price * 0.9, ...b.map((x) => x.p)), hi = Math.max(price * 1.1, ...a.map((x) => x.p))
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
      <line x1={x(price)} x2={x(price)} y1={pad} y2={H - pad} stroke="rgba(255,255,255,0.3)" strokeDasharray="4 4" />
      <text x={x(price)} y={pad - 8} textAnchor="middle" fill="#f2f2ee" fontSize="12">pool {p2(price)}</text>
      {[lo, price, hi].map((p) => <text key={p} x={x(p)} y={H - 8} textAnchor="middle" fill="#8e96a8" fontSize="11">{p2(p)}</text>)}
      <text x={W - pad} y={pad + 12} textAnchor="end" fill="#8e96a8" fontSize="11">{Math.round(top / 1.1).toLocaleString('en-US')} NEAR</text>
    </svg>
  )
}

export function PriceChart({ market, world, price, bids, asks }: { market: string; world: number; price: number; bids: Order[]; asks: Order[] }) {
  const [view, setView] = useState<'chart' | 'depth'>('chart')
  return (
    <section className="pc" aria-label="Price chart">
      <div className="pc__head">
        <div className="pc__tabs" role="group" aria-label="Chart or depth">
          <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>Chart</button>
          <button type="button" aria-pressed={view === 'depth'} onClick={() => setView('depth')}>Depth</button>
        </div>
        <span className="pc__note">Demo history, generated in the browser</span>
      </div>
      {view === 'chart' ? <Candles market={market} world={world} price={price} /> : <Depth bids={bids} asks={asks} price={price} />}
    </section>
  )
}
