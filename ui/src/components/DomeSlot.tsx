// Where the dome goes on the page. The 3D scene (Dome.tsx) loads only when this is near the screen.
import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'

const DomeCanvas = lazy(() => import('./Dome'))

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? null : this.props.children }
}

export function Dome() {
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
      {webgl && near && <SceneBoundary><Suspense fallback={null}><DomeCanvas /></Suspense></SceneBoundary>}
    </div>
  )
}
