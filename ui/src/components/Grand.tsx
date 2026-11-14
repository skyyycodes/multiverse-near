// Shared pieces for the market, borrow, lend, resolve and admin pages: a market's artwork, a world's icon, a
// health gauge, and a chart of each world's chance over time.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AreaSeries, ColorType, LineSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import { oddsHistory } from '../lib/history'
import { gridOf, has } from '../lib/scenario'
import type { Market } from '../lib/types'
import type { ChainMarket } from '../chain/adapter-model'

/** One colour per world, in bit order, used by charts, legends and icons. */
export const WORLD_COLORS = ['#e9b8bb', '#7dc9a5', '#9b8cf0', '#f0c05a', '#6fb7e8', '#d77bd0', '#c9c9c9', '#ef8f5a']

/** A market's picture: its event's artwork, or two overlapping for a combined market. */
export function MarketArt({ m, size = 48 }: { m: Pick<Market | ChainMarket, 'question'> & { events: { image?: string }[] }; size?: number }) {
  const imgs = m.events.map((e) => e.image).filter(Boolean) as string[]
  if (imgs.length === 0) return <span className="art art--blank" style={{ width: size, height: size }} aria-hidden>{m.question.slice(0, 1)}</span>
  if (imgs.length === 1) return <img className="art" src={imgs[0]} alt="" width={size} height={size} />
  return (
    <span className="art art--pair" style={{ width: size, height: size }} aria-hidden>
      <img src={imgs[0]} alt="" width={size * 0.72} height={size * 0.72} />
      <img src={imgs[1]} alt="" width={size * 0.72} height={size * 0.72} />
    </span>
  )
}

/** A world's icon: the market's grid of worlds with this one lit, in its colour. A chain market (adapter) lays its
 *  worlds out in contract order, the in-browser model in its own. */
export function WorldIcon({ m, w, size = 36, possible }: { m: Market | ChainMarket; w: number; size?: number; possible?: number }) {
  const rows = 'grid' in m ? m.grid.rows.map((r) => r.worlds) : gridOf(m).rows.map((r) => r.bits)
  return (
    <span className="wicon" style={{ width: size, height: size, gridTemplateColumns: `repeat(${rows[0]?.length ?? 2}, 1fr)` }} aria-hidden>
      {rows.flatMap((row) => row.map((b) => (
        <i key={b} className={`${b === w ? 'is-on' : ''}${possible !== undefined && !has(possible, b) ? ' is-dead' : ''}`} style={b === w ? { background: WORLD_COLORS[w % WORLD_COLORS.length] } : undefined} />
      )))}
    </span>
  )
}

/** A half-circle gauge for a health factor: red below 1, amber to 1.5, green above. */
export function Gauge({ value, label }: { value: number | null; label: string }) {
  const v = value === null ? 3 : Math.min(3, value)
  const t = v / 3 // 0..1 along the arc
  const a = Math.PI * (1 - t)
  const x = 60 + 48 * Math.cos(a), y = 60 - 48 * Math.sin(a)
  const tone = value === null || value >= 1.5 ? '#7dc9a5' : value >= 1.1 ? '#f0c05a' : '#cf6b78'
  return (
    <svg className="gauge" viewBox="0 0 120 72" role="img" aria-label={`${label}: ${value === null ? 'no loan' : value.toFixed(2)}`}>
      <path d="M12 60a48 48 0 0 1 96 0" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="9" strokeLinecap="round" />
      <path d="M12 60a48 48 0 0 1 32 -45.2" fill="none" stroke="rgba(207,107,120,0.55)" strokeWidth="9" strokeLinecap="round" />
      {value !== null && <path d={`M12 60A48 48 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`} fill="none" stroke={tone} strokeWidth="9" strokeLinecap="round" />}
      <circle cx={x} cy={y} r="5" fill="#f2f2ee" />
      <text x="60" y="56" textAnchor="middle" fill="#f2f2ee" fontSize="20" fontWeight="600" fontFamily="var(--font-mono)">{value === null ? '∞' : value.toFixed(2)}</text>
      <text x="12" y="71" fill="#8e96a8" fontSize="7">0</text><text x="40" y="12" fill="#8e96a8" fontSize="7">1</text><text x="104" y="71" fill="#8e96a8" fontSize="7">3+</text>
    </svg>
  )
}

const RANGES = [{ id: '1D', pts: 8 }, { id: '1W', pts: 56 }, { id: '1M', pts: 160 }, { id: 'ALL', pts: 160 }] as const

/** Each world's chance over time, one line per world, with a legend of today's chances. */
export function OddsChart({ m, odds, possible }: { m: Market; odds: number[]; possible: number }) {
  const box = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const lines = useRef<ISeriesApi<'Line'>[]>([])
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('1M')
  const key = odds.map((x) => x.toFixed(4)).join(',') // redraw when the odds change, not on every render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hist = useMemo(() => oddsHistory(m.id, odds), [m.id, key])
  const live = m.worlds.map((_, b) => b).filter((b) => has(possible, b))

  useEffect(() => {
    if (!box.current) return
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8e96a8', fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: false },
      crosshair: { horzLine: { visible: false } },
      handleScroll: false, handleScale: false,
    })
    chart.current = c
    return () => { c.remove(); chart.current = null; lines.current = [] }
  }, [])

  useEffect(() => {
    const c = chart.current
    if (!c) return
    lines.current.forEach((l) => c.removeSeries(l))
    lines.current = live.map((b) => {
      const l = c.addSeries(LineSeries, { color: WORLD_COLORS[b % WORLD_COLORS.length], lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(0)}%` } })
      l.setData(hist.map((h) => ({ time: h.time as UTCTimestamp, value: h.p[b] * 100 })))
      return l
    })
    const n = RANGES.find((r) => r.id === range)!.pts
    c.timeScale().setVisibleLogicalRange({ from: hist.length - n, to: hist.length - 1 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hist, possible, range])

  return (
    <div className="odds">
      <div className="odds__legend">
        {live.map((b) => (
          <span key={b}><i style={{ background: WORLD_COLORS[b % WORLD_COLORS.length] }} />{m.worlds[b].outcome} <b>{Math.round(odds[b] * 100)}%</b></span>
        ))}
      </div>
      <div ref={box} className="odds__canvas" />
      <div className="odds__foot">
        <span className="pc__note">Chance of each world over time · demo history</span>
        <div className="pc__intervals" role="group" aria-label="Range">
          {RANGES.map((r) => <button key={r.id} type="button" aria-pressed={range === r.id} onClick={() => setRange(r.id)}>{r.id}</button>)}
        </div>
      </div>
    </div>
  )
}

/** A small area chart of one series, e.g. the lenders' rate over time. */
export function AreaChart({ data, color = '#7dc9a5', format = (v: number) => v.toFixed(2), height = 180 }: {
  data: { time: number; value: number }[]; color?: string; format?: (v: number) => string; height?: number
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!box.current) return
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8e96a8', fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false },
      handleScroll: false, handleScale: false,
    })
    const a = c.addSeries(AreaSeries, { lineColor: color, topColor: `${color}55`, bottomColor: `${color}00`, lineWidth: 2, priceFormat: { type: 'custom', formatter: format } })
    a.setData(data.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })))
    c.timeScale().fitContent()
    return () => c.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, color])
  return <div ref={box} style={{ height }} />
}
