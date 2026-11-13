'use client'
// Wallet login through NEAR Connect on testnet. The connector touches window and IndexedDB,
// so it is created in the browser only. A demo wallet stays available so the site can be
// explored without a NEAR account; it never signs anything.
import type { NearConnector, NearWalletBase } from '@hot-labs/near-connect'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { chain } from '../config'
import { pickClient } from './client'

export const DEMO_ACCOUNT = 'demo-user.testnet'

type Wallet = {
  account: string | null
  isDemo: boolean
  ready: boolean // the connector has loaded its wallet list
  wallet: NearWalletBase | null // the connected NEAR wallet, for signing; null for the demo wallet
  connect: () => Promise<void>
  connectDemo: () => void
  disconnect: () => Promise<void>
}

const WalletContext = createContext<Wallet | null>(null)

export function WalletProvider({ children }: { children: ReactNode }) {
  const connector = useRef<NearConnector | null>(null)
  const [account, setAccount] = useState<string | null>(null)
  const [wallet, setWallet] = useState<NearWalletBase | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    import('@hot-labs/near-connect').then(async ({ NearConnector }) => {
      const c = new NearConnector({ network: chain.network, features: { testnet: chain.network === 'testnet' }, footerBranding: null })
      connector.current = c
      c.on('wallet:signIn', async (e) => {
        if (!alive) return
        setAccount(e.accounts[0]?.accountId ?? null)
        setWallet(await c.wallet())
      })
      c.on('wallet:signOut', () => {
        if (!alive) return
        setAccount(null)
        setWallet(null)
      })
      await c.whenManifestLoaded
      if (!alive) return
      setReady(true)
      // restore a session from an earlier visit
      try {
        const { wallet: w, accounts } = await c.getConnectedWallet()
        if (alive && accounts[0]) { setWallet(w); setAccount(accounts[0].accountId) }
      } catch { /* not signed in */ }
    })
    return () => { alive = false }
  }, [])

  const connect = useCallback(async () => {
    const c = connector.current
    if (!c) return
    await c.whenManifestLoaded
    try { await c.connect() } catch { /* the visitor closed the wallet picker */ }
  }, [])

  // the demo wallet is remembered in this browser, so a reload doesn't sign you out of it
  const DEMO_KEY = 'ov-demo-wallet'
  useEffect(() => {
    try { if (localStorage.getItem(DEMO_KEY) === '1') setAccount((a) => a ?? DEMO_ACCOUNT) } catch { /* storage blocked */ }
  }, [])
  const connectDemo = useCallback(() => {
    setWallet(null); setAccount(DEMO_ACCOUNT)
    try { localStorage.setItem(DEMO_KEY, '1') } catch { /* kept for this visit only */ }
  }, [])

  const disconnect = useCallback(async () => {
    if (wallet && connector.current) await connector.current.disconnect(wallet).catch(() => undefined)
    setWallet(null)
    setAccount(null)
    try { localStorage.removeItem(DEMO_KEY) } catch { /* fine */ }
  }, [wallet])

  const value: Wallet = { account, isDemo: account === DEMO_ACCOUNT, ready, wallet, connect, connectDemo, disconnect }
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet() {
  const w = useContext(WalletContext)
  if (!w) throw new Error('useWallet must be used inside WalletProvider')
  return w
}

// the client for whoever is signed in: on-chain for a real wallet once contracts are set, else the model
export function useClient() {
  const { wallet } = useWallet()
  return useMemo(() => pickClient(wallet), [wallet])
}
