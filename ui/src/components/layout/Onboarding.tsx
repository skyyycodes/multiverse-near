'use client'
// A first-visit intro, as Polymarket shows one: three short steps on what a world is, hedging and borrowing, with
// the wallet one click away. Shown once per browser on any page but the landing (which tells the story itself).
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useWallet } from '../../chain/near/wallet'

const KEY = 'ov-intro-seen'
const STEPS = [
  { t: 'One market, several worlds', p: 'Two yes-or-no events make four worlds, one for each way things can turn out. Only one becomes real. Your NEAR is split into a piece for each.', art: 'grid' },
  { t: 'Sell NEAR only where you fear', p: 'Swap your NEAR for dollars in the worlds you’re worried about, and keep it in the rest. One click, one signature.', art: 'split' },
  { t: 'Borrow against the worst world', p: 'Lenders count only your weakest world, and you borrow real USDC against it. Hedged worlds don’t fall with NEAR.', art: 'floor' },
] as const

function Art({ kind }: { kind: (typeof STEPS)[number]['art'] }) {
  const cell = (x: number, y: number, fill: string, label: string) => (
    <g key={`${x}${y}`}><rect x={x} y={y} width="70" height="44" rx="5" fill={fill} /><text x={x + 35} y={y + 27} textAnchor="middle" fontSize="11" fontFamily="monospace" fill="#f2f2ee">{label}</text></g>
  )
  return (
    <svg viewBox="0 0 160 110" className="intro__art" aria-hidden>
      {kind === 'grid' && [cell(6, 6, '#3a0d12', 'S·C'), cell(84, 6, '#3a0d12', 'S·H'), cell(6, 58, '#3a0d12', 'D·C'), cell(84, 58, '#3a0d12', 'D·H')]}
      {kind === 'split' && [cell(6, 6, '#3a0d12', 'NEAR'), cell(84, 6, '#1f4d3d', 'USDC'), cell(6, 58, '#1f4d3d', 'USDC'), cell(84, 58, '#1f4d3d', 'USDC')]}
      {kind === 'floor' && (
        <g>
          {[70, 60, 55, 48].map((h, i) => <rect key={i} x={10 + i * 37} y={100 - h} width="30" height={h} rx="3" fill={i === 0 ? '#e9e3d8' : '#7dc9a5'} opacity={i === 0 ? 0.85 : 0.7} />)}
          <line x1="4" x2="156" y1="58" y2="58" stroke="#f0c05a" strokeDasharray="4 3" />
          <text x="156" y="52" textAnchor="end" fontSize="9" fill="#f0c05a">worst world sets the limit</text>
        </g>
      )}
    </svg>
  )
}

export function Onboarding() {
  const pathname = usePathname()
  const { accountId, connect } = useWallet()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)
  useEffect(() => {
    // the landing tells the story itself
    if (pathname === '/') return
    try { if (!localStorage.getItem(KEY)) setOpen(true) } catch { /* storage blocked: skip the intro */ }
  }, [pathname])
  const close = () => { setOpen(false); try { localStorage.setItem(KEY, '1') } catch { /* fine */ } }
  if (!open) return null
  const s = STEPS[step]
  return (
    <div className="intro" role="dialog" aria-modal="true" aria-labelledby="intro-title" onClick={close}>
      <div className="intro__box" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="toast__x intro__x" aria-label="Close" onClick={close}>×</button>
        <Art kind={s.art} />
        <p className="intro__step">Step {step + 1} of {STEPS.length}</p>
        <h2 id="intro-title">{s.t}</h2>
        <p>{s.p}</p>
        <div className="intro__dots" aria-hidden>{STEPS.map((_, i) => <i key={i} className={i === step ? 'is-on' : ''} />)}</div>
        <div className="intro__acts">
          {step > 0 && <button type="button" className="mk__btn" onClick={() => setStep(step - 1)}>Back</button>}
          {step < STEPS.length - 1
            ? <button type="button" className="mk__btn mk__btn--buy" onClick={() => setStep(step + 1)}>Next</button>
            : <button type="button" className="mk__btn mk__btn--buy" onClick={() => { close(); if (!accountId) void connect() }}>{accountId ? 'Start' : 'Connect a wallet'}</button>}
        </div>
        <p className="pc__note">NEAR testnet with test tokens: once connected, “Get test tokens” in the wallet menu fills your wallet. Nothing here is real money.</p>
      </div>
    </div>
  )
}
