'use client'
// The account menu, as on every DeFi app: the button opens a panel with the account, its real wNEAR and USDC, copy
// and explorer links, test tokens (testnet's open mint plus the contract's storage registration), quick links and
// disconnect. The owner also gets the admin console here.
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useActions, useIsOwner, useLoanSummary, useWalletBalances } from '../../chain/adapter'
import { accountUrl, ENV } from '../../chain/env'
import { dropLabel, faucetMints } from '../../chain/faucet'
import { useAppConfig, useRegistration } from '../../chain/hooks/useData'
import { useAccountInfo } from '../../chain/hooks/useOps'
import { gasFloat, GAS_FT_ROUTINE, ONE_YOCTO } from '../../chain/near/tx'
import { useWallet } from '../../chain/near/wallet'
import { short } from '../../lib/format'

const whole = (n: number) => Math.floor(n).toLocaleString('en-US')
/** The first storage deposit on the contract (useTx registerTx), paid by "Get test tokens" when there is none. */
const REGISTRATION = 10n ** 23n

export function WalletMenu() {
  const { accountId, connect, ready, connecting } = useWallet()
  const [open, setOpen] = useState(false)
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
  // the dot turns red while a loan is close to liquidation (read only while the menu is closed is fine: it polls slowly)
  const loans = useLoanSummary(Boolean(accountId))

  if (!accountId) {
    return (
      <button className="topbar__wallet" type="button" onClick={() => void connect()} disabled={!ready || connecting}>
        {connecting ? 'Connecting…' : <>Connect<span className="topbar__wide"> wallet</span></>}
      </button>
    )
  }
  const risky = loans?.lowest !== null && loans?.lowest !== undefined && loans.lowest < 1.1

  return (
    <div className="wm" ref={box}>
      <button className="topbar__wallet" type="button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)}>
        <i className={`wm__dot${risky ? ' is-risk' : ''}`} aria-hidden /><span className="wm__name">{short(accountId)}</span>
      </button>
      {open && <Panel account={accountId} close={() => setOpen(false)} />}
    </div>
  )
}

function Panel({ account, close }: { account: string; close: () => void }) {
  const { disconnect } = useWallet()
  const balances = useWalletBalances()
  const loans = useLoanSummary()
  const owner = useIsOwner()
  const actions = useActions()
  const cfg = useAppConfig().data
  const reg = useRegistration(account, cfg?.wnear, cfg?.usdc).data
  const info = useAccountInfo(account).data
  const [copied, setCopied] = useState(false)
  const explorer = accountUrl(account)

  // what "Get test tokens" would still do: mint a token you hold less than the drop of, or register you
  const mints = cfg && balances ? faucetMints(cfg, { wnear: balances.nearWad, usdc: balances.usdcWad }) : undefined
  const registered = reg ? reg.contract !== null : undefined
  const faucetOn = ENV.chain === 'testnet'
  const nothingToDo = mints !== undefined && registered !== undefined && mints.length === 0 && registered
  const faucetLabel = actions.busy ?? (nothingToDo ? 'Test tokens in wallet' : 'Get test tokens')
  // too little NEAR for the next step: a routine action's gas, plus the 0.1 NEAR registration while there is none
  const lowNear = info !== undefined && registered !== undefined && gasFloat(info, GAS_FT_ROUTINE, registered ? ONE_YOCTO : REGISTRATION).short

  return (
    <div className="wm__panel" role="menu">
      <div className="wm__head">
        <span className="wm__avatar" aria-hidden>{account.slice(0, 1).toUpperCase()}</span>
        <div><b>{short(account)}</b><small>NEAR testnet{owner ? ' · owner' : ''}</small></div>
      </div>
      <div className="wm__bal">
        <div><span>wNEAR</span><b className="num">{balances ? whole(balances.near) : '–'}</b></div>
        <div><span>USDC</span><b className="num">{balances ? whole(balances.usdc) : '–'}</b></div>
        <div><span>Supplied</span><b className="num">{loans ? whole(loans.supplied) : '–'}</b></div>
      </div>
      <div className="wm__row">
        <button type="button" onClick={() => { navigator.clipboard?.writeText(account).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}>{copied ? 'Copied' : 'Copy address'}</button>
        {explorer && <a href={explorer} target="_blank" rel="noreferrer">Explorer ↗</a>}
        {faucetOn && (
          <button type="button" disabled={Boolean(actions.busy) || nothingToDo || mints === undefined} onClick={() => void actions.faucet()} title={cfg ? `Mints ${dropLabel(cfg)} of test tokens, then registers you with the contract. Up to three wallet approvals.` : undefined}>
            {faucetLabel}
          </button>
        )}
      </div>
      {faucetOn && !nothingToDo && <p className="wm__note">Test tokens have no value. Each mint costs a tiny fee but needs about 0.03 NEAR free to sign; registering keeps 0.1 NEAR as storage.</p>}
      {faucetOn && lowNear && <p className="wm__note">Need testnet NEAR? near-faucet.io tops up a top-level .testnet account that already holds about 0.03 NEAR; with none, NEAR CLI&apos;s <code>near account create-account sponsor-by-faucet-service &lt;name&gt;.testnet</code> creates a new account holding 10 NEAR.</p>}
      <nav className="wm__links">
        <Link href="/portfolio/">Portfolio <small>{loans ? `${loans.markets} market${loans.markets === 1 ? '' : 's'}` : '…'}</small></Link>
        <Link href="/borrow/">Loans <small>{!loans ? '…' : loans.lowest === null ? 'none' : `lowest health ${loans.lowest.toFixed(2)}`}</small></Link>
        <Link href="/lend/">Lending <small>{loans ? `${whole(loans.supplied)} USDC` : '…'}</small></Link>
        {owner && <Link href="/admin/">Admin <small>owner console</small></Link>}
      </nav>
      <button type="button" className="wm__out" onClick={() => { close(); void disconnect() }}>Disconnect</button>
    </div>
  )
}
