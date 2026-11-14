// The dome over the Markets section: two thin glass rings seen as arches, a smaller one and a bigger one
// a little higher, like the top of a half-sphere. The inner ring carries every open market's odds; the
// outer one carries the chains and coins IfVerse speaks and what the protocol does. Both turn slowly,
// in opposite directions. The section heading sits underneath, in the middle of the dome.
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { demoMarkets } from '../data/demo'
import { band, drawBar, type Item } from './Orbit3D'

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

// ---------- what's printed on the rings ----------
const mark = (src: string): Item => ({ kind: 'mark', src })
const ODDS: Item[] = demoMarkets
  .filter((m) => !m.settled)
  .flatMap((m) => m.worlds.flatMap((w): Item[] => [{ kind: 'text', text: `${w.outcome}  ${Math.round(w.chance * 100)}%` }, mark('/logo.svg')]))
// what the testnet contract actually does: it takes only wNEAR and USDC (no other chains or tokens)
const PROTOCOL: Item[] = [
  { kind: 'brand', src: '/logos/near.svg', text: 'NEAR' },
  { kind: 'text', text: 'One token per world (NEP-245)' },
  { kind: 'brand', src: '/logos/usdc.svg', text: 'USDC' },
  { kind: 'text', text: 'Health measured in your worst world' },
  { kind: 'text', text: 'Live on NEAR testnet' },
  { kind: 'text', text: 'Fed decision settled from FRED by OutLayer' },
  { kind: 'brand', src: '/logos/near.svg', text: 'NEAR' },
  { kind: 'text', text: 'Answers only remove worlds: health can only rise' },
  { kind: 'brand', src: '/logos/usdc.svg', text: 'USDC' },
  { kind: 'text', text: 'Every world balances: all backed' },
]

// ---------- one arch ----------
function Arch({ items, ink, fill, radius, width, y, lean, speed, text }: {
  items: Item[]; ink: string; fill: string; radius: number; width: number; y: number; lean: number; speed: number; text: number
}) {
  const wheel = useRef<THREE.Group>(null)
  const tiles = Math.max(1, Math.round((2 * Math.PI * radius) / 40)) // the strip repeats only a few times, so each item gets room
  const geo = useMemo(() => band(radius, width, tiles, false), [radius, width, tiles])
  // made once its artwork is drawn (resizing an uploaded texture can silently fail in WebGL)
  const [tex, setTex] = useState<THREE.CanvasTexture | null>(null)
  useEffect(() => {
    let live = true
    let made: THREE.CanvasTexture | null = null
    const c = document.createElement('canvas')
    c.width = 8192
    c.height = Math.round((8192 * width) / ((2 * Math.PI * (radius - width / 2)) / tiles))
    Promise.all([document.fonts.load('500 40px "DM Mono"').catch(() => null)]).then(() => drawBar(c, items, ink, fill, text)).then(() => {
      if (!live) return
      made = new THREE.CanvasTexture(c)
      made.wrapS = THREE.RepeatWrapping
      made.colorSpace = THREE.SRGBColorSpace
      made.anisotropy = 16
      setTex(made)
    })
    return () => { live = false; made?.dispose() }
  }, [items, ink, fill, radius, width, tiles, text])
  useEffect(() => () => geo.dispose(), [geo])
  useFrame((_, dt) => { if (wheel.current && !still()) wheel.current.rotation.z += Math.min(dt, 0.05) * speed })
  if (!tex) return null
  return (
    <group position={[0, y, 0]} rotation={[lean, 0, 0]}>
      <group ref={wheel}>
        <mesh geometry={geo} renderOrder={1}>
          <meshBasicMaterial map={tex} transparent side={THREE.BackSide} opacity={0.25} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh geometry={geo} renderOrder={2}>
          <meshBasicMaterial map={tex} transparent side={THREE.FrontSide} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
    </group>
  )
}

// ---------- the dome: sized to the frame so the bigger arch nearly spans it ----------
const DIST = 40, FOV = 18
function Scene() {
  const { camera, size } = useThree()
  const group = useRef<THREE.Group>(null)
  useFrame(() => {
    camera.position.set(0, 0, DIST)
    camera.lookAt(0, 0, 0)
    const halfH = Math.tan(((FOV / 2) * Math.PI) / 180) * DIST
    const halfW = halfH * (size.width / Math.max(1, size.height))
    // the outer arch reaches ~94% of the width where it leaves the bottom edge
    group.current?.scale.setScalar(Math.max(0.36, Math.min(1.6, halfW / 17.5)))
  })
  // world units: the outer ring (radius 19) sits a little higher than the inner one (radius 14.5)
  return (
    <group ref={group}>
      <Arch items={PROTOCOL} ink="#ffffff" fill="rgba(255, 255, 255, 0.06)" radius={19} width={1.2} y={-14.7} lean={-0.18} speed={-0.012} text={0.4} />
      <Arch items={ODDS} ink="#bf888c" fill="rgba(191, 136, 139, 0.14)" radius={14.5} width={1.1} y={-13.1} lean={-0.18} speed={0.016} text={0.4} />
    </group>
  )
}

// the canvas itself; loaded lazily by DomeSlot so three.js only downloads near the section
export default function DomeCanvas() {
  return (
    <Canvas dpr={[1, 1.25]} camera={{ position: [0, 0, DIST], fov: FOV, near: 0.1, far: 200 }} gl={{ antialias: true, alpha: true }}>
      <Scene />
    </Canvas>
  )
}
