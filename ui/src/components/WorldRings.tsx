// The four worlds as glass rings. At the top of the landing they stand among a dome of glass arches rising from the
// bottom of the screen, above a tiny butterfly; the first scroll lifts the butterfly to the middle and the four world rings
// collapse in after it, locking into a gyroscope: one position, held inside four possible futures. Each ring is
// printed with its own world (name, chance) and the two tokens you can hold there. As the butterfly splits, the
// rings flare out and fade.
import { Canvas, useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { demoMarkets } from '../data/demo'
import { weekMove } from '../lib/market'
import { story } from '../lib/story'
import { AZURE_GLASS, AZURE_INK, TEAL_GLASS, TEAL_INK, band, drawBar, type Item } from './Orbit3D'

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))
const clamp = (v: number) => Math.min(1, Math.max(0, v))

// when things happen, as fractions of the story's scroll (see Hero.tsx)
export const RINGS_JOIN = 0.24 // the rings have locked around the butterfly
export const RINGS_FLARE_AT = 0.3 // ...and start flaring out as it comes forward to split
const FLARE = 0.08

const R = 3.7 // the gyroscope's ring radius, in scene units
const scenario = demoMarkets[0]

// what each world's ring carries: its name and chance, between the marks of the two tokens
function itemsFor(k: number): Item[] {
  const w = scenario.worlds[k]
  const odds: Item = { kind: 'odds', name: w.outcome, chance: w.chance, move: weekMove(w.chance, w.id) }
  return [{ kind: 'mark', src: '/logo.svg' }, odds, { kind: 'mark', src: '/logos/near.svg' }, odds, { kind: 'mark', src: '/logos/usdc.svg' }]
}

const q = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z))
// the locked formation: four identical upright ovals, each turned a further 45 degrees around the view axis,
// so they read as one symmetric figure (upright, two steep diagonals, flat)
const OVAL = q(0, 0.95, 0)
const turned = (deg: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (deg * Math.PI) / 180).multiply(OVAL)
// At the top of the landing the rings stand as a dome, built like the one over the Markets section: round glass
// rings leaning back a little, centred below the screen so each shows as an arch, broad bands with a gap between
// them, fading out toward the bottom edge. Seven of them, nested, the smallest above the tiny butterfly; each turns at
// its own pace and the other way from the one next to it. Four are the world rings: as the butterfly rises to the
// middle they follow it in and lock into the gyroscope; the other three sink and fade. Grey glass and rose glass
// alternate.
type Spec = { world: number; mult: number; w: number; bare: boolean; spin: number; joins: boolean; order: number; to: THREE.Quaternion; ink: string; fill: string }
// outermost arch first: band width (a multiple of the base width), turning speed, and `world` for the four that lock
// in (grey worlds 0 and 2, rose worlds 1 and 3, placed so grey and rose glass still alternate down the dome)
// widths are mixed so neither glass is always the broad one; the gap between neighbouring arches is always GAP
const BANDS: { mult: number; speed: number; world?: number }[] = [
  { mult: 0.6, speed: 0.07 }, // the extra arch on top, outside the others (rose)
  { mult: 1.4, speed: 0.05, world: 0 }, // grey
  { mult: 0.6, speed: 0.08, world: 1 }, // rose
  { mult: 0.8, speed: 0.035 }, // grey
  { mult: 1.3, speed: 0.1, world: 3 }, // rose
  { mult: 0.5, speed: 0.06, world: 2 }, // grey
  { mult: 1, speed: 0.09 }, // rose
]
const GAP = 0.1 // the space between neighbouring arches, in scene units
const BASE_W = 0.35 // band width at a typical screen, in scene units (it scales with the screen's width)
const LOCK = [turned(90), turned(0), turned(45), turned(-45)] // each world's place in the gyroscope
let lockOrder = 0
const RINGS: Spec[] = BANDS.map(({ mult, speed, world }, i) => {
  const grey = i % 2 === 1 // the top arch is rose, so each world ring keeps its own glass
  const shown = world ?? (i + 1) % 4 // the extra arches print the worlds in turn
  return {
    world: shown, mult, w: BASE_W * mult,
    bare: false,
    joins: world !== undefined,
    order: world !== undefined ? lockOrder++ : 0, // the locking rings follow one after another, outermost first
    spin: (i % 2 ? -1 : 1) * speed, // neighbours turn opposite ways
    to: LOCK[shown],
    ink: grey ? TEAL_INK : AZURE_INK,
    fill: grey ? TEAL_GLASS : AZURE_GLASS,
  }
})
const HALF_H = 30 * Math.tan(((16.6 / 2) * Math.PI) / 180) // half the visible height at the rings' depth
const LEAN = -0.18 // the dome leans back a little, like the Markets one
const EXTRA_FADE = 0.12 // the extra rings are gone this far into the story

// each texture repeats TILES times around the gyroscope circle; on an oval it repeats as often as its length allows
const TILES = Math.max(1, Math.round((2 * Math.PI * R) / 7))
const SEG = 384
function printed(world: number, ink: string, fill: string, w: number, bare: boolean) {
  const c = document.createElement('canvas')
  c.width = 4096 // a big texture keeps the lettering crisp up close
  c.height = Math.round((4096 * w) / ((2 * Math.PI * (R - w / 2)) / TILES))
  const t = new THREE.CanvasTexture(c)
  t.wrapS = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 16
  drawBar(c, bare ? [] : itemsFor(world), ink, fill, 0.42).then(() => { t.needsUpdate = true })
  return t
}

// One band: an oval with outer radii (a, b) and constant width w, morphing toward a circle of radius R as m goes
// 0 to 1. The lettering is spaced by length along the band, so it never stretches at the top of a wide oval; it
// reads upright along the upper arcs (the arch) until halfway, then along the lower arcs (the gyroscope).
function shape(geo: THREE.BufferGeometry, a: number, b: number, w: number, m: number) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute
  const oa = a + (R - a) * m, ob = b + (R - b) * m // outer radii now
  const under = m >= 0.5
  // length along the middle of the band, for spacing the lettering
  const ma = oa - w / 2, mb = ob - w / 2
  const len: number[] = [0]
  for (let i = 1; i <= SEG; i++) {
    const t0 = ((i - 1) / SEG) * Math.PI * 2, t1 = (i / SEG) * Math.PI * 2
    len.push(len[i - 1] + Math.hypot(ma * (Math.cos(t1) - Math.cos(t0)), mb * (Math.sin(t1) - Math.sin(t0))))
  }
  const tileLen = (2 * Math.PI * (R - w / 2)) / TILES
  const tiles = Math.max(1, Math.round(len[SEG] / tileLen))
  for (let i = 0; i <= SEG; i++) {
    const t = (i / SEG) * Math.PI * 2
    const c = Math.cos(t), s = Math.sin(t)
    pos.setXYZ(i * 2, c * (oa - w), s * (ob - w), 0)
    pos.setXYZ(i * 2 + 1, c * oa, s * ob, 0)
    const k = len[i] / len[SEG]
    const u = (under ? k : 1 - k) * tiles
    uv.setXY(i * 2, u, under ? 1 : 0)
    uv.setXY(i * 2 + 1, u, under ? 0 : 1)
  }
  pos.needsUpdate = true
  uv.needsUpdate = true
  geo.computeBoundingSphere()
}

function Ring({ k, centre }: { k: number; centre: THREE.Vector3 }) {
  const ring = RINGS[k]
  const start = useMemo(() => new THREE.Vector3(), [])
  const place = useRef<THREE.Group>(null)
  const front = useRef<THREE.MeshBasicMaterial>(null)
  const back = useRef<THREE.MeshBasicMaterial>(null)
  const geo = useMemo(() => {
    const g = band(R, ring.w, TILES, false, SEG) // buffers of the right size; shape() fills them in
    ;(g.getAttribute('position') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage)
    ;(g.getAttribute('uv') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage)
    return g
  }, [ring.w])
  const tex = useMemo(() => printed(ring.world, ring.ink, ring.fill, ring.w, ring.bare), [ring.world, ring.ink, ring.fill, ring.w, ring.bare])
  useEffect(() => () => { geo.dispose(); tex.dispose() }, [geo, tex])
  const rot = useMemo(() => new THREE.Quaternion(), [])
  const flat = useMemo(() => q(LEAN, 0, 0), [])
  const drawn = useRef('')

  useFrame((state, dt) => {
    const g = place.current
    if (!g) return
    const p = story.p
    // sized to the screen's width, like the Markets dome: the outermost arch nearly spans it, peaking just under the
    // title, and the others nest inside with a gap between each
    const halfW = HALF_H * (state.size.width / Math.max(1, state.size.height))
    const r0 = halfW * 1.06
    // the bands are sized so that, with the same small gap between each, the smallest arch peaks about a fifth of
    // the way up from the bottom, clear of the butterfly. The top arch sits one gap outside the one under the title.
    let units = 0
    for (let i = 1; i < BANDS.length - 1; i++) units += BANDS[i].mult
    const unit = (0.6 * HALF_H - (BANDS.length - 2) * GAP) / units
    let r = r0 + BANDS[0].mult * unit + GAP
    for (let i = 0; i < k; i++) r -= BANDS[i].mult * unit + GAP
    const w = ring.mult * unit
    start.set(0, -0.02 * HALF_H - r0, 0)
    const flare = ease(clamp((p - RINGS_FLARE_AT) / FLARE))
    let o: number
    let m = 0
    if (ring.joins) {
      // the world rings rise after the butterfly, rounding into circles, and lock into the gyroscope
      const join = ease(clamp((p - 0.03 - ring.order * 0.015) / (RINGS_JOIN - 0.075)))
      m = join
      g.position.lerpVectors(start, centre, join)
      g.scale.setScalar(1 + 0.9 * flare)
      rot.slerpQuaternions(flat, ring.to, join)
      o = 1 - flare
    } else {
      // the extra rings sink away and fade
      const fade = ease(clamp(p / EXTRA_FADE))
      g.position.set(0, start.y - fade * 2.5, 0)
      g.scale.setScalar(1)
      rot.copy(flat)
      o = 1 - fade
    }
    g.quaternion.copy(rot)
    g.visible = o > 0.001
    if (front.current) front.current.opacity = o
    if (back.current) back.current.opacity = o * 0.2
    // reshape only when something changed; in the gyroscope every band has its full width
    const key = `${r.toFixed(3)}|${w.toFixed(3)}|${m.toFixed(3)}`
    if (key !== drawn.current) {
      drawn.current = key
      shape(geo, r, r, w + (ring.w - w) * m, m)
    }
    // each band runs along itself at its own pace; scrolling speeds it up a little
    if (!still()) tex.offset.x += Math.min(dt, 0.05) * ring.spin * 2 * (1 + Math.min(story.v * 12, 4))
  })

  return (
    <group ref={place}>
      <mesh geometry={geo} renderOrder={1}>
        <meshBasicMaterial ref={back} map={tex} transparent side={THREE.BackSide} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh geometry={geo} renderOrder={2}>
        <meshBasicMaterial ref={front} map={tex} transparent side={THREE.FrontSide} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  )
}

// a long lens from far away: the same size on screen as a near camera, but with almost no perspective,
// so the four ovals stay symmetric instead of swelling on their near sides
export default function WorldRings() {
  // render only while the rings can be seen: from the top of the story until they have flared away
  const [live, setLive] = useState(true)
  useEffect(() => {
    let raf = 0
    const check = () => {
      const on = story.hero > 0 && story.p < RINGS_FLARE_AT + FLARE + 0.01
      setLive((v) => (v === on ? v : on))
      raf = requestAnimationFrame(check)
    }
    raf = requestAnimationFrame(check)
    return () => cancelAnimationFrame(raf)
  }, [])
  // the butterfly rests a little below the stage's centre (top: 54%, see .fly), in the middle of the space
  // under the header, so the gyroscope does too
  const centre = useMemo(() => new THREE.Vector3(0, -0.35, 0), [])
  return (
    <Canvas frameloop={live ? 'always' : 'never'} dpr={[1, 2]} camera={{ position: [0, 0, 30], fov: 16.6, near: 0.1, far: 100 }} gl={{ antialias: true, alpha: true }}>
      {RINGS.map((_, k) => <Ring key={k} k={k} centre={centre} />)}
    </Canvas>
  )
}
