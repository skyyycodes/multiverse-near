// The site background: deep black, packed edge to edge with mismatched wing shards (irregular cells, each
// folded along its own crease). Blue light curls across them like smoke, so shards gently brighten and fall back to black.
// One small WebGL shader; a still frame when motion is reduced.
import { useEffect, useRef } from 'react'
import { story } from '../lib/story'

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`
const FRAG = `
precision highp float;
uniform vec2 r;
uniform float t;
uniform float b; // 0..1: the landing's opening glow
uniform float n; // shard density: fewer, bigger shards on the landing
uniform float e; // shard stretch: closer to 1 is thicker
uniform vec2 o; // where this canvas sits within the full-screen background (a strip of it, for the header)

mat2 transpose2(mat2 m){ return mat2(m[0][0], m[1][0], m[0][1], m[1][1]); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 hash2(vec2 p){ return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
// smooth value noise and a few layers of it
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), w.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), w.x), w.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 5; k++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
// smoke: noise warped by noise, drifting and curling slowly
float smoke(vec2 p){
  p += vec2(t * 0.045, t * 0.012);                // a steady, slow current, so the smoke travels across the screen
  vec2 q = vec2(fbm(p + vec2(0.0, t * 0.075)), fbm(p + vec2(5.2, 1.3) - vec2(t * 0.06, 0.0)));
  vec2 w = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + t * 0.05), fbm(p + 3.0 * q + vec2(8.3, 2.8) - t * 0.045));
  return fbm(p + 3.2 * w);
}

void main(){
  vec2 fc = gl_FragCoord.xy + o;
  vec2 u = fc / r;                                // 0,0 bottom-left
  vec3 black = vec3(0.006, 0.006, 0.01);
  // irregular wing shards: the page is cut into mismatched cells (each a different size and slant),
  // stretched along a diagonal so they read as wing pieces. They tile with no gaps and no overlap.
  float ang = 0.55;
  mat2 R = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  vec2 p = R * (fc / r.y * n);                    // small shards, many of them
  p.x *= e;                                        // elongate the shards
  vec2 ip = floor(p), fp = fract(p);
  float d1 = 9.0, d2 = 9.0;
  vec2 cell = vec2(0.0), seed = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 pt = o + hash2(ip + o) * 0.9 + 0.05;
    float d = length(fp - pt);
    if (d < d1) { d2 = d1; d1 = d; cell = ip + o; seed = pt; }
    else if (d < d2) { d2 = d; }
  }
  // each shard folds along its own random crease into a lit half and a shaded half
  float a = hash(cell) * 6.283;
  bool lit = dot(fp - seed, vec2(cos(a), sin(a))) > 0.0;
  float fold = lit ? 1.0 : 0.45;
  // light: smoke curling over the shards. Each shard takes mostly its own tone (so the folds show),
  // with some of the smooth smoke on top, so the wisps flow across them
  vec2 sp = fc / r.y * 1.6;
  vec2 cellScreen = (transpose2(R) * vec2((cell.x + 0.5) / e, cell.y + 0.5)) / n * 1.6;
  float sm = smoke(mix(cellScreen, sp, 0.35));   // one smoke sample per pixel, mostly at the shard's centre
  // the wisps light most of the shards they pass over, so there are always streaks of lit shards on screen
  float l = smoothstep(0.54, 0.84, sm) * (0.7 + 0.6 * hash(cell + 3.1));
  l *= step(0.58, hash(cell + 7.7));
  l = pow(l, 1.6);
  vec2 c = cell + 0.5;
  // colour moves too: electric blue, with cyan and violet passing through
  vec3 blue = vec3(0.32, 0.01, 0.04);             // deep maroon
  vec3 cyan = vec3(0.45, 0.05, 0.07);
  vec3 violet = vec3(0.26, 0.01, 0.08);
  float hc = 0.5 + 0.5 * sin(c.x * 0.07 - t * 0.5);
  float hv = 0.5 + 0.5 * sin(c.y * 0.09 + t * 0.4 + 1.5);
  vec3 hue = mix(mix(blue, cyan, hc * 0.35), violet, hv * 0.5);
  float seam = smoothstep(0.0, 0.06, d2 - d1);     // hairline seams between shards
  vec3 col = black + hue * l * 0.5 * fold * (0.35 + 0.65 * seam);
  // a faint glow on every shard, so the folded texture still shows between the wisps
  col += hue * (0.008 + 0.01 * hash(cell + 1.3)) * fold * (0.4 + 0.6 * seam);
  // the opening glow: two diagonal bands of brighter electric-blue shards framing the words,
  // waving slowly and streaked by the same smoke. Only on the landing, fading out as the story starts.
  if (b > 0.001) {
    vec2 q = (u - 0.5) * vec2(r.x / r.y, 1.0);
    vec2 dir = normalize(vec2(0.56, 1.0));
    vec2 n = vec2(-dir.y, dir.x);
    float along = dot(q, dir);
    float s = dot(q, n) + 0.07 * sin(along * 3.2 + t * 0.35) + 0.05 * (sm - 0.5);
    float off = mix(0.3, 0.56, clamp((r.x / r.y - 0.5) / 1.0, 0.0, 1.0)); // closer in on tall phone screens
    float band = exp(-pow((abs(s) - off) / 0.07, 2.0));
    band *= smoothstep(0.45, 0.75, sm) * step(0.42, hash(cell + 5.3)); // black between the wisps, and only some shards lit
    float lb = band * b * (0.35 + 0.65 * hash(cell + 3.1));
    vec3 electric = mix(vec3(0.55, 0.03, 0.07), vec3(0.62, 0.08, 0.1), hc * 0.5);
    col += electric * lb * 0.22 * fold * (0.3 + 0.7 * seam);
  }
  // a soft clear oval behind the words in the middle of the screen
  vec2 wv = (u - vec2(0.5, 0.42)) * vec2(1.5, 2.6);
  col = mix(col, black, 0.0 * exp(-dot(wv, wv) * 3.0)); // no dark patch in the middle: it read as a hard black hole
  gl_FragColor = vec4(col, 1.0);
}`

// one clock for every copy, so the header strip and the page background drift together
const T0 = typeof performance !== 'undefined' ? performance.now() : 0

// `strip`: draw only this canvas's part of the full-screen background (the header), lined up with the page's copy
export function Flutes({ className = '', strip = false }: { className?: string; strip?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const gl = canvas?.getContext('webgl', { antialias: false, premultipliedAlpha: false })
    if (!canvas || !gl) return
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      return sh
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    const uR = gl.getUniformLocation(prog, 'r'), uT = gl.getUniformLocation(prog, 't'), uB = gl.getUniformLocation(prog, 'b')
    const uN = gl.getUniformLocation(prog, 'n'), uE = gl.getUniformLocation(prog, 'e'), uO = gl.getUniformLocation(prog, 'o')

    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const scale = 0.6 // drawn smaller and stretched by CSS: it's a soft background, and this cuts its cost by almost two thirds
    let raf = 0, glow = 0
    const start = T0
    let last = 0
    const draw = (now = performance.now()) => {
      // a slow drift: 30 frames a second is plenty, and halves the cost of a full-screen shader
      if (!calm && now - last < 32) { raf = requestAnimationFrame(draw); return }
      last = now
      const w = Math.max(1, Math.round(canvas.clientWidth * scale)), h = Math.max(1, Math.round(canvas.clientHeight * scale))
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h) }
      // the strip uses the whole screen's size and its own offset in it, so its shards match the page's exactly
      const fullW = strip ? Math.max(1, Math.round(window.innerWidth * scale)) : w
      const fullH = strip ? Math.max(1, Math.round(window.innerHeight * scale)) : h
      gl.uniform2f(uR, fullW, fullH)
      gl.uniform2f(uO, 0, strip ? fullH - h : 0)
      gl.uniform1f(uT, calm ? 8 : (performance.now() - start) / 1000)
      // full glow at the top of the landing, gone a little way into the story
      const want = story.hero * (1 - Math.min(1, story.p / 0.12))
      glow = calm ? want : glow + (want - glow) * 0.06
      gl.uniform1f(uB, glow)
      // the landing gets thicker, broader blades; every other page keeps the fine ones
      const landing = window.location.pathname === '/'
      gl.uniform1f(uN, landing ? 34 : 52)
      gl.uniform1f(uE, landing ? 0.85 : 0.6)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      if (!calm) raf = requestAnimationFrame(draw)
    }
    draw()
    const onResize = () => { if (calm) draw() }
    window.addEventListener('resize', onResize)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); gl.deleteProgram(prog); gl.deleteBuffer(buf) }
  }, [])

  return <canvas ref={ref} className={`flutes ${className}`} aria-hidden />
}
