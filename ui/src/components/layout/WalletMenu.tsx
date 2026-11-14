'use client'
// The account menu, as on every DeFi app: the button opens a panel with the account, its wallet balances, copy and
// explorer links, test tokens, quick links and disconnect. Before, clicking the account signed out at once.
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { short } from '../../lib/format'
import { actions, health, holdsAnything, useStore } from '../../lib/scenario'
import { useWallet } from '../../lib/wallet'

const EXPLORER = 'https://testnet.nearblocks.io/address/'

export function WalletMenu() {
  const { account, connect, disconnect, isDemo } = useWallet()
  const { wallet, markets, sc, pool } = useStore()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const pathname = usePathname()
  const [lastPath, setLastPath] = useState(pathname)
  if (pathname !== lastPath) { setLastPath(pathname); setOpen(false) }
  useEffect(() => {
    if (!open) return
    const on = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', on); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', on); document.removeEventListener('keydown', key) }
  }, [open])

  if (!account) {
    return <button className="topbar__wallet" type="button" onClick={connect}>Connect<span className="topbar__wide"> wallet</span></button>
  }
  const positions = markets.filter((m) => holdsAnything(sc[m.id])).length
  const hfs = markets.map((m) => health(sc[m.id])).filter((h): h is number => h !== null)
  const lowest = hfs.length ? Math.min(...hfs) : null

  return (
    <div className="wm" ref={box}>
      <button className="topbar__wallet" type="button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)}>
        <i className={`wm__dot${lowest !== null && lowest < 1.1 ? ' is-risk' : ''}`} aria-hidden />{short(account)} {isDemo && <em className="topbar__wide">demo</em>}
      </button>
      {open && (
        <div className="wm__panel" role="menu">
          <div className="wm__head">
            <span className="wm__avatar" aria-hidden>{account.slice(0, 1).toUpperCase()}</span>
            <div><b>{short(account)}</b><small>{isDemo ? 'Demo wallet · signs nothing' : 'NEAR testnet'}</small></div>
          </div>
          <div className="wm__bal">
            <div><span>wNEAR</span><b className="num">{Math.round(wallet.near).toLocaleString('en-US')}</b></div>
            <div><span>USDC</span><b className="num">{Math.round(wallet.usdc).toLocaleString('en-US')}</b></div>
            <div><span>Supplied</span><b className="num">{Math.round(pool.lent).toLocaleString('en-US')}</b></div>
          </div>
          <div className="wm__row">
            <button type="button" onClick={() => { navigator.clipboard?.writeText(account).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}>{copied ? 'Copied' : 'Copy address'}</button>
            {!isDemo && <a href={`${EXPLORER}${account}`} target="_blank" rel="noreferrer">Explorer ↗</a>}
            <button type="button" onClick={() => actions.faucet()}>Get test tokens</button>
          </div>
          <nav className="wm__links">
            <Link href="/portfolio">Portfolio <small>{positions} market{positions === 1 ? '' : 's'}</small></Link>
            <Link href="/borrow">Loans <small>{lowest === null ? 'none' : `lowest health ${lowest.toFixed(2)}`}</small></Link>
            <Link href="/lend">Lending <small>{Math.round(pool.lent).toLocaleString('en-US')} USDC</small></Link>
          </nav>
          <button type="button" className="wm__out" onClick={() => { setOpen(false); disconnect() }}>Disconnect</button>
        </div>
      )}
    </div>
  )
}
