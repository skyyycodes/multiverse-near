// The landing story. The section is several screens tall; inside it a stage sticks to the screen
// while the visitor scrolls. Scroll progress (0 → 1) drives the butterfly: it grows to the centre, then its four wings shatter off together and
// each wing's own shape grows into a full panel. The four panels tile the page, split by a
// diagonal gap, with the butterfly's body left where the gaps meet.
import { useEffect, useRef, type CSSProperties } from 'react'
import { demoMarkets } from '../data/demo'
import { pct } from '../lib/format'
import { story } from '../lib/story'
import dynamic from 'next/dynamic'

// the rings are WebGL: loaded in the browser only
const WorldRings = dynamic(() => import('./WorldRings'), { ssr: false })

const scenario = demoMarkets[0] // the doc's 2x2 scenario: ships/delayed x cuts/holds
// the two questions behind the four worlds: rows are the first event (top: first outcome), columns the second
// (left: first outcome), so world i is row i >> 1, column i & 1
const [ROWS, COLS] = scenario.events

// ---------- the butterfly, built from the logo's triangles, cut into four wings ----------
// each wing is one quad (its two triangles together); points in the logo's 200×200 space
const UPPER: [number, number][] = [[100, 96], [158, 22], [188, 60], [160, 102]]
const LOWER: [number, number][] = [[100, 106], [162, 110], [150, 172], [118, 150]]
const TRI = {
  upper: ['100,96 158,22 188,60', '100,96 188,60 160,102'],
  lower: ['100,106 162,110 150,172', '100,106 150,172 118,150'],
}
const FAR = 'translate(0 -8) translate(100 0) scale(.52 1) translate(-100 0) translate(200 0) scale(-1 1)'
type Key = 'tl' | 'tr' | 'bl' | 'br'
const WINGS: { key: Key; part: 'upper' | 'lower'; far: boolean }[] = [
  { key: 'tl', part: 'upper', far: true },
  { key: 'bl', part: 'lower', far: true },
  { key: 'tr', part: 'upper', far: false },
  { key: 'br', part: 'lower', far: false },
]

// Maroon paper under one key light from the upper right: each fold of a wing has its own gradient,
// faces turned to the light are dusty rose, faces turned away deep maroon, and the lit edges catch a
// faint pale-rose rim. The far wings sit in shadow.
const PAPER = {
  nearLit: ['#d39aa3', '#9c4553'], // dusty rose where a fold faces the light
  nearShade: ['#6e1f2c', '#3a0c15'], // deep maroon where it turns away
  farLit: ['#8a3a47', '#4f1520'],
  farShade: ['#3a0e16', '#1c0609'],
}
function Butterfly() {
  return (
    <svg className="fly__svg" viewBox="0 0 200 200" aria-hidden>
      <defs>
        {Object.entries(PAPER).map(([id, [a, b]]) => (
          <linearGradient key={id} id={`paper-${id}`} x1="1" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={a} />
            <stop offset="1" stopColor={b} />
          </linearGradient>
        ))}
        <linearGradient id="paper-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e2b0b7" />
          <stop offset="1" stopColor="#7a2634" />
        </linearGradient>
      </defs>
      <g transform="translate(100 100) scale(.92) translate(-100 -100) translate(-18.8 11.9) rotate(-14 100 100)">
        {WINGS.map(({ key, part, far }) => {
          const side = far ? 'far' : 'near'
          // the upper wing's outer fold faces the light; on the lower wing it's the inner one
          const fills = part === 'upper' ? [`${side}Lit`, `${side}Shade`] : [`${side}Shade`, `${side}Lit`]
          return (
            <g key={key} className="wing" data-wing={key} data-part={part} transform={far ? FAR : undefined}>
              {/* the flap folds each wing toward the body; the measured wing (.wing) never moves */}
              <g className="flap">
                {TRI[part].map((pts, i) => (
                  <polygon
                    key={i}
                    points={pts}
                    fill={`url(#paper-${fills[i]})`}
                    stroke={!far && fills[i].endsWith('Lit') ? '#f0c6cc' : 'none'}
                    strokeWidth={0.7}
                    strokeOpacity={0.55}
                    strokeLinejoin="round"
                  />
                ))}
              </g>
            </g>
          )
        })}
        <polygon className="fly__body" points="100,68 104.5,100 100,138 95.5,100" fill="url(#paper-body)" />
      </g>
    </svg>
  )
}

// ---------- geometry ----------
type Pt = [number, number]
const clamp = (v: number) => Math.min(1, Math.max(0, v))
const ease = (t: number) => t * t * (3 - 2 * t)
const mix = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

// put four corners in a fixed order (clockwise from the top-left one) so a wing and its panel pair up corner to corner
function ordered(q: Pt[]): Pt[] {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4
  const byAngle = [...q].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx))
  const start = byAngle.reduce((best, p, i) => (p[0] + p[1] < byAngle[best][0] + byAngle[best][1] ? i : best), 0)
  return [...byAngle.slice(start), ...byAngle.slice(0, start)]
}

// The wings split the page along the butterfly's own lines: rays from the body through the slanted
// body axis (up, down) and through the slit between upper and lower wing on each side. Each wing's
// panel is the page region between its two rays, so the four tile the page with only hairline seams.
type Rays = { c: Pt; top: Pt; right: Pt; bottom: Pt; left: Pt }
const PERIM = (w: number, h: number): Pt[] => [[0, 0], [w, 0], [w, h], [0, h]] // corners, clockwise
function hit(c: Pt, d: Pt, w: number, h: number): Pt {
  const ts = [d[0] > 0 ? (w - c[0]) / d[0] : d[0] < 0 ? -c[0] / d[0] : Infinity, d[1] > 0 ? (h - c[1]) / d[1] : d[1] < 0 ? -c[1] / d[1] : Infinity]
  const t = Math.min(...ts)
  return [c[0] + d[0] * t, c[1] + d[1] * t]
}
// distance along the page edge, clockwise from the top-left corner
function along([x, y]: Pt, w: number, h: number) {
  const e = 0.5
  if (y <= e) return x
  if (x >= w - e) return w + y
  if (y >= h - e) return w + h + (w - x)
  return 2 * w + h + (h - y)
}
function region(r: Rays, a: Pt, b: Pt, w: number, h: number, gap: number): Pt[] {
  const ha = hit(r.c, a, w, h), hb = hit(r.c, b, w, h)
  const total = 2 * (w + h)
  const sa = along(ha, w, h)
  let sb = along(hb, w, h)
  if (sb < sa) sb += total
  const corners = PERIM(w, h)
    .map((p) => [p, along(p, w, h)] as const)
    .flatMap(([p, s]) => [[p, s], [p, s + total]] as const)
    .filter(([, s]) => s > sa && s < sb)
    .sort((x, y) => x[1] - y[1])
    .map(([p]) => p)
  // pull the edges on each ray in by half the seam, toward this panel
  const na: Pt = [-a[1] * gap, a[0] * gap], nb: Pt = [b[1] * gap, -b[0] * gap]
  const c: Pt = [r.c[0] + na[0] + nb[0], r.c[1] + na[1] + nb[1]]
  return [c, [ha[0] + na[0], ha[1] + na[1]], ...corners, [hb[0] + nb[0], hb[1] + nb[1]]]
}
function panels(w: number, h: number, r: Rays): Record<Key, Pt[]> {
  const g = 1.5
  return {
    tl: region(r, r.left, r.top, w, h, g),
    tr: region(r, r.top, r.right, w, h, g),
    br: region(r, r.right, r.bottom, w, h, g),
    bl: region(r, r.bottom, r.left, w, h, g),
  }
}

// give a polygon n points by splitting its longest edges, so any wing can morph into any panel
function densify(poly: Pt[], n: number): Pt[] {
  const out = [...poly]
  while (out.length < n) {
    let best = 0, len = -1
    out.forEach((p, i) => {
      const q = out[(i + 1) % out.length]
      const l = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (l > len) { len = l; best = i }
    })
    const p = out[best], q = out[(best + 1) % out.length]
    out.splice(best + 1, 0, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2])
  }
  return out
}
// clockwise, starting from the corner nearest the butterfly's body
function fromBody(q: Pt[], c: Pt): Pt[] {
  const o = ordered(q)
  const i = o.reduce((best, p, k) => (Math.hypot(p[0] - c[0], p[1] - c[1]) < Math.hypot(o[best][0] - c[0], o[best][1] - c[1]) ? k : best), 0)
  return [...o.slice(i), ...o.slice(0, i)]
}
const unit = (a: Pt, b: Pt): Pt => {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]
}

// a sharp polygon for clip-path: folded paper keeps its corners
const sharp = (pts: Pt[]) => `polygon(${pts.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(', ')})`

// point inside polygon (ray casting)
function inside([x, y]: Pt, poly: Pt[]) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

// Place a panel's words in the middle of its shape (its area centroid, kept clear of the header),
// shrinking them only if a corner of the box would leave the shape.
function centroid(poly: Pt[]): Pt {
  let a = 0, x = 0, y = 0
  poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length]
    const c = p[0] * q[1] - q[0] * p[1]
    a += c; x += (p[0] + q[0]) * c; y += (p[1] + q[1]) * c
  })
  return a ? [x / (3 * a), y / (3 * a)] : poly[0]
}
function place(poly: Pt[], cw: number, ch: number, top: number, margin: number) {
  const [cx, c0] = centroid(poly)
  for (let s = 1; s >= 0.4; s -= 0.04) {
    const w = cw * s, h = ch * s
    const cy = Math.max(c0, top + h / 2) // never under the header
    const box: Pt[] = [[cx - w / 2 - margin, cy - h / 2 - margin], [cx + w / 2 + margin, cy - h / 2 - margin], [cx + w / 2 + margin, cy + h / 2 + margin], [cx - w / 2 - margin, cy + h / 2 + margin]]
    if (box.every((p) => inside(p, poly))) return { s, x: cx - w / 2, y: cy - h / 2 }
  }
  return { s: 0.4, x: cx - (cw * 0.4) / 2, y: c0 - (ch * 0.4) / 2 }
}

// the split: when the wings break off, and how much scroll the growing takes
// The story, as fractions of its scroll:
//   0 to 0.24      the four world rings swing in and lock around the butterfly (WorldRings.tsx)
//   0.30 to 0.38   the rings flare away and the butterfly comes forward
//   0.38 to 0.58   it splits: each wing grows into one world's panel
//   0.58 to 0.70   the four worlds hold open
//   0.70 to 0.92   they pull apart to the corners over the orange
//   at the end     the butterfly's logo appears beside the wordmark
const RUN_ON = 0.8 // how much of a screen the story keeps playing after it unpins
const RING_SIZE = 0.42 // the butterfly's size inside the rings, against its full size of 1
const SPLIT_SIZE = 1.05 // ...and the size it comes forward to before splitting
const FORWARD_AT = 0.3 // the butterfly comes toward you as the rings flare out...
const FORWARD = 0.08
const SPLIT = 0.38 // ...then the wings break off...
const GROW = 0.2 // ...and take this much scroll to fill the page
const PULL_AT = 0.7 // the four worlds hold open, then pull apart to their corners
const PULL = 0.22
const DOCK_AT = 0.76 // the re-formed butterfly flies up beside the wordmark,
const DOCK = 0.24 // landing exactly as the story section ends

export function Hero() {
  const root = useRef<HTMLElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const panelEls = useRef<Partial<Record<Key, HTMLDivElement | null>>>({})
  const after = useRef<HTMLSpanElement>(null)

  // the line in the orange fills the screen's width exactly: measured once its font is in, and on resize
  useEffect(() => {
    const span = after.current, line = span?.parentElement
    if (!span || !line) return
    const fit = () => {
      line.style.fontSize = '100px'
      const w = span.getBoundingClientRect().width
      if (w > 0) line.style.fontSize = `${(100 * (window.innerWidth * 0.97)) / w}px`
    }
    document.fonts.load('400 100px Anton').then(fit, fit)
    document.fonts.ready.then(fit, fit)
    const late = window.setTimeout(fit, 1500)
    window.addEventListener('resize', fit)
    window.addEventListener('load', fit)
    return () => { window.clearTimeout(late); window.removeEventListener('resize', fit); window.removeEventListener('load', fit) }
  }, [])

  // every frame: ease toward the scroll position (a hard flick still glides), feed the 3D scene,
  // and reshape the four panels from wing to page
  useEffect(() => {
    let raf = 0, last = performance.now(), sp = 0, written = -1, size = ''
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // each wing's corners on screen and the rays that split the page, read once the butterfly is full size
    let wingQuads: Record<Key, Pt[]> | null = null
    let fitted = false
    let open = false // panels fully open: hovering one nudges it outward
    const shapes: Partial<Record<Key, Pt[]>> = {}
    const drawn: Record<Key, number> = { tl: -1, tr: -1, bl: -1, br: -1 } // the grow progress each clip shape was last drawn at
    let flyBase: DOMRect | null = null
    let measuredFs = 1 // the butterfly's size when its wings were measured
    let flyEl: HTMLElement | null = null, spotEl: HTMLElement | null = null // looked up once, not every frame
    let rays: Rays | null = null

    const measure = (sr: DOMRect) => {
      const st = stage.current
      const body = st?.querySelector<SVGPolygonElement>('.fly__body')?.getScreenCTM()
      if (!st || !body) return false
      const at = (m: DOMMatrix, x: number, y: number): Pt => {
        const p = new DOMPoint(x, y).matrixTransform(m)
        return [p.x - sr.left, p.y - sr.top]
      }
      const c = at(body, 100, 103)
      const quads = {} as Record<Key, Pt[]>
      const slit: Partial<Record<'near' | 'far', Pt>> = {}
      st.querySelectorAll<SVGGElement>('.wing').forEach((g) => {
        const m = g.getScreenCTM()
        if (!m) return
        const k = g.dataset.wing as Key
        quads[k] = (g.dataset.part === 'upper' ? UPPER : LOWER).map(([x, y]) => at(m, x, y))
        // the slit between this side's upper and lower wing
        if (g.dataset.part === 'upper') slit[k === 'tl' ? 'far' : 'near'] = at(m, 161, 106)
      })
      if (Object.keys(quads).length < 4 || !slit.near || !slit.far) return false
      rays = { c, top: unit(c, at(body, 100, 68)), bottom: unit(c, at(body, 100, 138)), right: unit(c, slit.near), left: unit(c, slit.far) }
      wingQuads = quads
      return true
    }

    const clearHover = () => (['tl', 'tr', 'bl', 'br'] as Key[]).forEach((k) => {
      const p = panelEls.current[k]
      p?.style.setProperty('--hx', '0px')
      p?.style.setProperty('--hy', '0px')
    })
    const onMove = (e: PointerEvent) => {
      const st = stage.current
      if (!open || !st || !rays) return
      const sr = st.getBoundingClientRect()
      const at: Pt = [e.clientX - sr.left, e.clientY - sr.top]
      const c = (rays as Rays).c
      ;(['tl', 'tr', 'bl', 'br'] as Key[]).forEach((k) => {
        const p = panelEls.current[k], shape = shapes[k]
        if (!p || !shape) return
        const on = inside(at, shape)
        const [mx, my] = centroid(shape)
        const [ux, uy] = unit(c, [mx, my])
        p.style.setProperty('--hx', `${on ? ux * 12 : 0}px`)
        p.style.setProperty('--hy', `${on ? uy * 12 : 0}px`)
      })
    }
    stage.current?.addEventListener('pointermove', onMove)
    stage.current?.addEventListener('pointerleave', clearHover)

    const tick = () => {
      const el = root.current, st = stage.current
      if (el && st) {
        // the story keeps playing for most of a screen after the stage unpins, while the next section comes up
        const travel = el.offsetHeight - window.innerHeight + window.innerHeight * RUN_ON
        const target = clamp(-el.getBoundingClientRect().top / Math.max(1, travel))
        const now = performance.now()
        const dt = Math.min(0.05, (now - last) / 1000)
        last = now
        const prev = sp
        sp = calm ? target : sp + (target - sp) * (1 - Math.exp(-dt * 10))
        if (Math.abs(target - sp) < 0.0004) sp = target
        story.v += (Math.abs(sp - prev) / Math.max(dt, 0.001) - story.v) * 0.15
        story.p = sp

        const sr = st.getBoundingClientRect()
        const key = `${Math.round(sr.width)}x${Math.round(sr.height)}`
        if (key !== size) { size = key; wingQuads = null; rays = null; written = -1; fitted = false; (Object.keys(drawn) as Key[]).forEach((k) => { drawn[k] = -1 }) }

        if (sp !== written) {
          written = sp
          const intro = ease(clamp(sp / 0.05))
          // the butterfly's size: small inside the rings, coming forward to full size to split, small again
          // as it re-forms and docks (the CSS reads it as --fs)
          const settle = ease(clamp((sp - PULL_AT) / 0.05))
          const fwd = ease(clamp((sp - FORWARD_AT) / FORWARD)) * (1 - settle)
          // beside the rings (not on phones) the butterfly starts tiny under the smallest arc and rises to the middle,
          // growing as the rings collapse in after it (WorldRings: RINGS_JOIN)
          const home = ease(clamp(sp / 0.16)) // it leads; the rings follow it in
          const base = sr.width < 761 ? 0.36 : 0.15
          const fs = (base + (sr.width < 761 ? intro : home) * (RING_SIZE - base)) * (1 + (SPLIT_SIZE / RING_SIZE - 1) * fwd)
          // dock: the butterfly shrinks and flies to the logo spot beside the wordmark (not on phones).
          // Layout is read only while docking, and before this frame writes any style, so the browser
          // never has to recalculate layout in the middle of a frame.
          const phone = sr.width < 761
          const d = phone ? 0 : ease(clamp((sp - DOCK_AT) / DOCK))
          if (!flyEl) flyEl = st.querySelector<HTMLElement>('.fly')
          if (!spotEl || !spotEl.isConnected) spotEl = document.querySelector<HTMLElement>('.topbar__logo')
          let to: DOMRect | null = null
          if (d > 0 && flyEl && spotEl) {
            // where the butterfly rests: centred on (offsetLeft, offsetTop), scaled by the intro (see .fly in Hero.css)
            const w = flyEl.offsetWidth * fs
            flyBase = new DOMRect(flyEl.offsetLeft - w / 2, flyEl.offsetTop - w / 2, w, w) // stage coordinates
            to = spotEl.getBoundingClientRect()
          }
          el.style.setProperty('--intro', String(intro))
          el.style.setProperty('--home', home.toFixed(4))
          // on the way up it drifts side to side, the swing dying out as it arrives
          el.style.setProperty('--sway', `${(Math.sin(home * Math.PI * 3) * 46 * (1 - home)).toFixed(1)}px`)
          // the butterfly comes forward before it splits, and settles back to its size as it re-forms
          el.style.setProperty('--fs', fs.toFixed(4))
          // the line beside the locked rings, and the line in the orange at the end
          el.style.setProperty('--cap', String(ease(clamp((sp - 0.14) / 0.08)) * (1 - ease(clamp((sp - FORWARD_AT) / 0.05)))))
          const pull = ease(clamp((sp - PULL_AT) / PULL))
          el.style.setProperty('--pull', pull.toFixed(4))
          el.classList.toggle('is-pulling', pull > 0)
          el.classList.toggle('is-past-intro', sp > 0.05)
          open = sp > SPLIT + GROW + 0.02 && sp < PULL_AT
          el.classList.toggle('is-end', open)
          if (!open) clearHover()

          // the butterfly is full size once the intro ends: read where its wings really are
          // the wings are measured just before they split, at the size they split at
          if (!wingQuads && sp >= SPLIT - 0.005 && measure(sr)) measuredFs = fs
          const r = rays as Rays | null
          const targets = r ? panels(sr.width, sr.height, r) : null
          // once per size: put each panel's words in the middle of its shape, whole
          if (targets && !fitted) {
            fitted = true
            const top = (sr.width < 761 ? 60 : 68) + 12
            ;(['tl', 'tr', 'bl', 'br'] as Key[]).forEach((k) => {
              const box = panelEls.current[k]?.querySelector<HTMLElement>('.pane__in')
              if (!box) return
              const { s: sc, x, y } = place(targets[k], box.offsetWidth, box.offsetHeight, top, 14)
              box.style.left = `${x}px`
              box.style.top = `${y}px`
              box.style.right = 'auto'
              box.style.bottom = 'auto'
              box.style.transformOrigin = 'left top'
              box.style.setProperty('--fit', sc.toFixed(3))
            })
          }
          // where the butterfly is now, as a move + shrink about its own centre (stage coordinates)
          if (flyBase && to && d > 0) {
            const fx = sr.left + flyBase.left + flyBase.width / 2, fy = sr.top + flyBase.top + flyBase.height / 2 // where it sits now, on screen
            const tx = to.left + to.width / 2, ty = to.top + to.height / 2
            const mx = (tx - fx) * d, my = (ty - fy) * d, ds = 1 + (to.width / flyBase.width - 1) * d
            el.style.setProperty('--dx', `${mx.toFixed(1)}px`)
            el.style.setProperty('--dy', `${my.toFixed(1)}px`)
            el.style.setProperty('--ds', ds.toFixed(4))
          } else {
            el.style.setProperty('--dx', '0px')
            el.style.setProperty('--dy', '0px')
            el.style.setProperty('--ds', '1')
          }
          ;(['tl', 'tr', 'bl', 'br'] as Key[]).forEach((k, i) => {
            const p = panelEls.current[k]
            if (!p) return
            const t = ease(clamp((sp - SPLIT - i * 0.01) / GROW))
            p.style.setProperty('--t', t.toFixed(4))
            if (!wingQuads || !targets || !r || t <= 0) { p.style.visibility = 'hidden'; drawn[k] = -1; return }
            p.style.visibility = 'visible'
            // grown: the shape stops changing, so it's set once instead of every frame
            if (t < 1 || drawn[k] !== 1) {
              const end = densify(targets[k], 6)
              // the wing it grows from, scaled up with the butterfly that has come forward
              const grown = fs / measuredFs // the wing it grows from, at the butterfly's size now
              const start = densify(fromBody(wingQuads[k], r.c), 6).map(([x, y]): Pt => [r.c[0] + (x - r.c[0]) * grown, r.c[1] + (y - r.c[1]) * grown])
              const shape = start.map((a, j) => mix(a, end[j], t))
              p.style.clipPath = sharp(shape)
              shapes[k] = shape
              drawn[k] = t
            }
            // pull apart: each world slides out toward its own corner, tilting a little, like a sheet pulled off a table
            const [mx, my] = centroid(targets[k])
            const [ux, uy] = unit(r.c, [mx, my])
            const reach = Math.hypot(sr.width, sr.height) * 1.05 * pull // far enough to clear the screen entirely
            p.style.setProperty('--px', `${(ux * reach).toFixed(1)}px`)
            p.style.setProperty('--py', `${(uy * reach).toFixed(1)}px`)
            p.style.setProperty('--pr', `${(Math.sign(ux * uy || 1) * 7 * pull).toFixed(2)}deg`)
          })
          // once it splits, the butterfly is gone: it has become the four worlds. The logo in the header
          // appears as they clear (the dock still runs underneath, so the logo lands where it belongs)
          el.style.setProperty('--split', String(ease(clamp((sp - SPLIT) / 0.03))))

          const docked = phone || d >= 0.999
          el.classList.toggle('is-docked', d >= 0.999)
          document.documentElement.classList.toggle('logo-docked', docked)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    // the landing always opens at the top, so the story plays from its start (a reload would otherwise
    // drop you mid-story); other pages keep the browser's own scroll restoration
    const restore = history.scrollRestoration
    history.scrollRestoration = 'manual'
    window.scrollTo(0, 0)
    raf = requestAnimationFrame(tick)
    story.hero = 1
    const st0 = stage.current
    return () => {
      cancelAnimationFrame(raf)
      st0?.removeEventListener('pointermove', onMove)
      st0?.removeEventListener('pointerleave', clearHover)
      history.scrollRestoration = restore
      document.documentElement.classList.remove('logo-docked')
      story.hero = 0
      story.p = 0
    }
  }, [])

  const panel = (k: Key) => (el: HTMLDivElement | null) => { panelEls.current[k] = el }

  return (
    <section className="story" ref={root} aria-label="How Origami works">
      <div className="story__stage" ref={stage}>
        {/* the four wings open into the scenario's four worlds: short, the same layout in each corner */}
        {(['tl', 'tr', 'bl', 'br'] as Key[]).map((k, i) => {
          const w = scenario.worlds[i]
          return (
            <div key={k} className={`pane pane--${k}`} ref={panel(k)}>
              <div className="pane__in">
                {/* which world: its row and its column, the same words as the axes along the creases */}
                <h3 className="pane__tag"><span>{ROWS.outcomes[i >> 1]}</span><i aria-hidden>×</i><span>{COLS.outcomes[i & 1]}</span></h3>
                <p className="pane__big" aria-label={`${pct(w.chance)} chance`}>{pct(w.chance)}</p>
                <p className="pane__near">NEAR here <b>${w.nearPrice.toFixed(2)}</b></p>
                <span className="pane__odds" style={{ '--p': w.chance } as CSSProperties} aria-hidden><i /></span>
              </div>
            </div>
          )
        })}

        {/* the creases between the four worlds light up once the wings are fully open */}
        {/* the four worlds as glass rings, locking around the butterfly on the first scroll */}
        <div className="story__rings" aria-hidden><WorldRings /></div>
        {/* the four worlds named around the formation, in the corners their panels will open into */}
        <ul className="ring-worlds" aria-label="The four worlds">
          {(['tl', 'tr', 'bl', 'br'] as Key[]).map((k, i) => {
            const w = scenario.worlds[i]
            return (
              <li key={k} className={`ring-tag ring-tag--${k}`}>
                <b>{w.outcome}</b>
                <span>{Math.round(w.chance * 100)}% chance, NEAR at ${w.nearPrice.toFixed(2)}</span>
              </li>
            )
          })}
        </ul>
        {/* between the labels on each side: what you're looking at (left), and what decides it (right) */}
        <p className="story__caption story__caption--lead">Your 1,000 NEAR exists in four futures at once.</p>
        <p className="story__caption story__caption--body">Two questions decide which one becomes real: does SPICE ship on mainnet, and does the Fed cut. Keep scrolling to open them.</p>

        {/* orange shows through the creases between the worlds, and fills the screen as they pull apart */}
        <div className="story__seams" aria-hidden />
        <p className="story__after" aria-hidden><span ref={after}>Your NEAR in all four</span></p>

        <div className="fly">
          <Butterfly />
        </div>

        <div className="story__hero">
          <h1>
            <span className="hero__line"><span>Lend inside</span></span>
            <span className="hero__line"><em>every future.</em></span>
          </h1>
          <p className="hero__tag">Multiverse lending on NEAR</p>
        </div>

      </div>
    </section>
  )
}
