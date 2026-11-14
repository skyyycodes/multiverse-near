// The landing story, in 3D. Scroll drives it (lib/story.ts); the pointer does not move it.
// Two huge glass rings curve upward just under the header, one carrying the logos, one the odds.
// Each turns smoothly around its own centre like a wheel, then they float up and dim as the wings take over.
// Real logos come from public/logos. Near faces read clearly; far faces show dimly through the glass.
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { story } from '../lib/story'
import { chanceText } from '../chain/board'

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

// glass in white and blue: each band is a see-through tint with dark ink of the same hue
export const TEAL_INK = '#ffffff' // the white glass ring
export const TEAL_GLASS = 'rgba(255, 255, 255, 0.07)'
export const AZURE_INK = '#bf888c' // the blue glass ring
export const AZURE_GLASS = 'rgba(191, 136, 139, 0.16)'

// ---------- what's printed on the rings ----------
export type Item =
  | { kind: 'logo' }
  | { kind: 'brand'; src: string; text: string }
  | { kind: 'mark'; src: string } // a logo on its own, no text
  | { kind: 'text'; text: string; strong?: boolean }
  // a world and its chance (left out until the chain has answered); `move`, a change in points, only when one is known
  | { kind: 'odds'; name: string; chance?: number; move?: number }

// a logo bar: ours, NEAR, the chains NEAR Intents takes deposits from, and the stablecoins
const MARKS = ['/logo.svg', '/logos/near.svg', '/logos/btc.svg', '/logos/eth.svg', '/logos/sol.svg', '/logos/usdc.svg', '/logos/usdt.svg']
export const PROJECT_BAR: Item[] = [...MARKS, ...MARKS].map((src) => ({ kind: 'mark', src })) // twice per repeat, so the band stays dense
// ---------- drawing a ring's bar onto a canvas ----------
export const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })

// draw an SVG in one flat colour (the brand marks are single-colour icons)
function tinted(img: HTMLImageElement, color: string, size: number) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  g.drawImage(img, 0, 0, size, size)
  g.globalCompositeOperation = 'source-in'
  g.fillStyle = color
  g.fillRect(0, 0, size, size)
  return c
}

export async function drawBar(canvas: HTMLCanvasElement, items: Item[], ink: string, fill: string, textScale = 0.3) {
  const g = canvas.getContext('2d')!
  const W = canvas.width, H = canvas.height
  const srcs = [...new Set(items.flatMap((it) => (it.kind === 'logo' ? ['/logo.svg'] : it.kind === 'brand' || it.kind === 'mark' ? [it.src] : [])))]
  const imgs = new Map(await Promise.all(srcs.map(async (s) => [s, await loadImage(s).catch(() => null)] as const)))
  await document.fonts?.ready

  g.clearRect(0, 0, W, H)
  // glass: a see-through tint, a sheen across the band and a bright line just inside each edge
  g.fillStyle = fill
  g.fillRect(0, 0, W, H)
  const sheen = g.createLinearGradient(0, 0, 0, H)
  sheen.addColorStop(0, 'rgba(255,255,255,0.26)')
  sheen.addColorStop(0.22, 'rgba(255,255,255,0.05)')
  sheen.addColorStop(0.6, 'rgba(255,255,255,0)')
  sheen.addColorStop(1, 'rgba(255,255,255,0.1)')
  g.fillStyle = sheen
  g.fillRect(0, 0, W, H)
  const edge = Math.max(2, H * 0.025)
  g.fillStyle = 'rgba(255,255,255,0.45)'
  g.fillRect(0, edge, W, Math.max(1, edge * 0.6))
  g.fillRect(0, H - edge * 1.6, W, Math.max(1, edge * 0.6))
  // edges and dial ticks
  g.fillStyle = ink
  g.globalAlpha = 0.7
  g.fillRect(0, 0, W, edge)
  g.fillRect(0, H - edge, W, edge)
  g.globalAlpha = 1
  for (let x = 0; x < W; x += 16) {
    const major = x % 160 === 0
    const len = H * (major ? 0.17 : 0.08)
    g.globalAlpha = major ? 0.85 : 0.4
    g.fillRect(x, edge, 2, len)
    g.fillRect(x, H - edge - len, 2, len)
  }
  g.globalAlpha = 1

  let size = H * textScale
  const font = (strong?: boolean) => `${strong ? 600 : 500} ${Math.round(size)}px "DM Mono", monospace`
  const icon = () => size * 1.25
  const oddsText = (it: Extract<Item, { kind: 'odds' }>) => [
    `${it.name.toUpperCase()}${it.chance === undefined ? '' : ` ${chanceText(it.chance)}`}${it.move === undefined ? '' : ' '}`,
    it.move === undefined ? '' : `${it.move > 0 ? '▲' : '▼'}${Math.abs(it.move).toFixed(1)}`,
  ]
  const measure = () =>
    items.map((it) => {
      if (it.kind === 'logo') return icon() * 1.3
      if (it.kind === 'mark') return H * 0.6
      g.font = font(it.kind === 'text' && it.strong)
      if (it.kind === 'brand') return icon() + size * 0.6 + g.measureText(it.text).width
      if (it.kind === 'text') return g.measureText(it.text).width
      return g.measureText(oddsText(it).join('')).width
    })
  let widths = measure()
  const used = widths.reduce((s, w) => s + w, 0)
  if (used > W * 0.78) {
    size *= (W * 0.78) / used
    widths = measure()
  }
  const gap = (W - widths.reduce((s, w) => s + w, 0)) / items.length
  const mid = H / 2 + 1
  let x = gap / 2
  g.textBaseline = 'middle'
  items.forEach((it, i) => {
    if (it.kind === 'logo') {
      const img = imgs.get('/logo.svg')
      const s = icon() * 1.3
      if (img) g.drawImage(tinted(img, ink, 256), x, mid - s / 2, s, s)
    } else if (it.kind === 'mark') {
      const img = imgs.get(it.src)
      const s = H * 0.6
      if (img) g.drawImage(tinted(img, ink, 256), x, mid - s / 2, s, s)
    } else if (it.kind === 'brand') {
      const img = imgs.get(it.src)
      const s = icon()
      if (img) g.drawImage(tinted(img, ink, 256), x, mid - s / 2, s, s)
      g.font = font()
      g.fillStyle = ink
      g.fillText(it.text, x + s + size * 0.6, mid)
    } else if (it.kind === 'text') {
      g.font = font(it.strong)
      g.fillStyle = ink
      g.fillText(it.text, x, mid)
    } else {
      g.font = font()
      const [label, mv] = oddsText(it)
      g.fillStyle = ink
      g.fillText(label, x, mid)
      g.fillStyle = (it.move ?? 0) > 0 ? '#6ee7a0' : '#bf888d'
      g.fillText(mv, x + g.measureText(label).width, mid)
    }
    g.fillStyle = ink
    g.globalAlpha = 0.3
    g.fillRect(x + widths[i] + gap / 2 - 1, H * 0.3, 2, H * 0.4)
    g.globalAlpha = 1
    x += widths[i] + gap
  })
}

// ---------- a band all the way round a circle ----------
// u runs along the band, v across it. `flip` makes lettering upright on the near (lower) arc instead of the top one.
export function band(outer: number, width: number, tiles: number, flip: boolean, segments = 512) {
  const inner = outer - width
  const pos: number[] = [], uv: number[] = [], idx: number[] = []
  for (let i = 0; i <= segments; i++) {
    const k = i / segments
    const a = k * Math.PI * 2
    pos.push(Math.cos(a) * inner, Math.sin(a) * inner, 0, Math.cos(a) * outer, Math.sin(a) * outer, 0)
    const u = (flip ? k : 1 - k) * tiles
    uv.push(u, flip ? 1 : 0, u, flip ? 0 : 1)
    if (i < segments) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(idx)
  return geo
}

const ease = (t: number) => t * t * (3 - 2 * t)
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
// how present the sphere is as the story plays: full at the start, dimmed once the wings take over
const presence = (p: number) => 0.8 * (1 - 0.75 * ease(clamp01((p - 0.06) / 0.25))) // a touch dimmed, so the light behind can breathe

type BandProps = { items: Item[]; ink: string; fill: string; radius: number; width: number; rotation: [number, number, number]; flip?: boolean }

// one glass band of the sphere: its near face clear, its far face seen dimly through the glass
function GlassBand({ items, ink, fill, radius, width, rotation, flip = false, fixed = false }: BandProps & { fixed?: boolean }) {
  const front = useRef<THREE.MeshBasicMaterial>(null)
  const back = useRef<THREE.MeshBasicMaterial>(null)
  const tiles = Math.max(1, Math.round((2 * Math.PI * radius) / 11))
  const geo = useMemo(() => band(radius, width, tiles, flip), [radius, width, tiles, flip])
  const tex = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = 4096
    c.height = Math.round((4096 * width) / ((2 * Math.PI * (radius - width / 2)) / tiles))
    const t = new THREE.CanvasTexture(c)
    t.wrapS = THREE.RepeatWrapping
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 16
    return t
  }, [radius, width, tiles])
  useEffect(() => { drawBar(tex.image as HTMLCanvasElement, items, ink, fill).then(() => { tex.needsUpdate = true }) }, [items, ink, fill, tex])
  useEffect(() => () => { geo.dispose(); tex.dispose() }, [geo, tex])
  useFrame(() => {
    const o = fixed ? 0.85 : presence(story.p)
    if (front.current) front.current.opacity = o
    if (back.current) back.current.opacity = o * 0.32
  })
  return (
    <group rotation={rotation}>
      <mesh geometry={geo} renderOrder={1}>
        <meshBasicMaterial ref={back} map={tex} transparent side={THREE.BackSide} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh geometry={geo} renderOrder={2}>
        <meshBasicMaterial ref={front} map={tex} transparent side={THREE.FrontSide} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  )
}

const TILT = -0.42 // a gentle lean: the bottom of each ring comes toward you. Small, so rings stay round, not squished.

// One of the two big rings, shown as an upward curve just under the header: its centre sits high above
// the screen, so only its lower arc shows, dipping below the header and rising into the top corners. No sideways rotation, so nothing
// looks slanted. It turns like a wheel around its own centre, carrying its lettering along.
function Arc({ items, ink, fill, radius, low, side, speed, lean = 0, fixed = false }: { items: Item[]; ink: string; fill: string; radius: number; low: number; side: 1 | -1; speed: number; lean?: number; fixed?: boolean }) {
  const place = useRef<THREE.Group>(null)
  const wheel = useRef<THREE.Group>(null)
  const centre = low + radius * Math.cos(TILT) // where the centre sits so the lowest point lands at `low` (world units;
  // the tilt brings that point toward the camera, so on screen it shows a little higher than `low`)
  useFrame((_, dt) => {
    // in the story the rings float up and away and spin faster while you scroll; on their own they just turn
    const t = fixed ? 0 : ease(clamp01(story.p / 0.6))
    if (place.current) place.current.position.y = centre + 1.6 * t
    const boost = fixed ? 1 : 1 + Math.min(story.v * 20, 5)
    if (wheel.current && !still()) wheel.current.rotation.z += Math.min(dt, 0.05) * speed * side * boost
  })
  return (
    <group ref={place} rotation={[0, 0, lean]}>
      {/* lean: the ring swings a little around its own (high) centre, so its curve dips on one side and rises on the other */}
      <group rotation={[TILT, 0, 0]}>
        <group ref={wheel}>
          {/* flipped so the lettering reads upright along the lower arc */}
          <GlassBand items={items} ink={ink} fill={fill} radius={radius} width={0.4} rotation={[0, 0, 0]} flip fixed={fixed} />
        </group>
      </group>
    </group>
  )
}

// camera: fixed and straight on, a little further back on tall screens
function Rig() {
  const { camera, size } = useThree()
  useFrame(() => {
    camera.position.set(0, 0, size.width < size.height ? 22 : 14)
    camera.lookAt(0, 0, 0)
  })
  return null
}

// `fixed`: shown on its own (the landing's closing section), not driven by the scroll story
export default function Orbit3D({ odds = [], fixed = false, low = 1.45 }: { odds?: Item[]; fixed?: boolean; low?: number }) {
  return (
    <Canvas dpr={[1, 1.75]} camera={{ position: [0, 0, 14], fov: 35, near: 0.1, far: 100 }} gl={{ antialias: true, alpha: true }}>
      {/* the criss-cross: two equal rings leaning in mirror-opposite directions, crossing in an X at the centre */}
      <Arc items={odds} ink={AZURE_INK} fill={AZURE_GLASS} radius={11} low={low} side={-1} speed={0.02} lean={0.4} fixed={fixed} />
      <Arc items={PROJECT_BAR} ink={TEAL_INK} fill={TEAL_GLASS} radius={11} low={low} side={1} speed={0.02} lean={-0.4} fixed={fixed} />
      <Rig />
    </Canvas>
  )
}
