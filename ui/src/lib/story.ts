// Scroll progress of the landing story, shared between the page (which writes it)
// and the 3D scene (which reads it every frame). Plain object: no React re-renders.
export const story = {
  p: 0, // 0 at the top of the story, 1 at its end
  v: 0, // how fast the visitor is scrolling, smoothed
  hero: 0, // 1 while the landing hero is on the page: the background lights its blue bands
}

// the four beats of the story, as fractions of its scroll length
export const BEATS = [0, 0.3, 0.62, 1] as const
