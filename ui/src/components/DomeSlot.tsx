// Where the dome goes on the page. The 3D scene (Dome.tsx) loads only when this is near the screen.
import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Item } from './Orbit3D'

const DomeCanvas = lazy(() => import('./Dome'))

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? null : this.props.children }
}

/** `odds`: what the inner arch prints (the open markets' worlds and chances); it waits for them. */
export function Dome({ odds }: { odds: Item[] }) {
  const box = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [webgl, setWebgl] = useState(false)
  useEffect(() => {
    try { setWebgl(!!document.createElement('canvas').getContext('webgl2')) } catch { setWebgl(false) }
  }, [])
  useEffect(() => {
    const el = box.current
    if (!el || !('IntersectionObserver' in window)) { setNear(true); return }
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: '1200px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <div className="dome" ref={box} aria-hidden>
      {webgl && near && <SceneBoundary><Suspense fallback={null}><DomeCanvas odds={odds} /></Suspense></SceneBoundary>}
    </div>
  )
}
