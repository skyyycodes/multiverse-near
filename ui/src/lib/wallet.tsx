'use client'
// The redesign's wallet hook, now a thin view of the real one: NEAR Connect on testnet (src/chain/near/wallet.tsx),
// with the demo bridge in NEXT_PUBLIC_DEMO_WALLET=1 builds for the recorder and the tests. There is no in-browser
// demo wallet any more: `connectDemo` opens the wallet picker like `connect`, and `isDemo` is always false.
// New code reads `useWallet` from src/chain/near/wallet.tsx directly.
import { useMemo } from 'react'
import { WalletProvider as ChainWalletProvider, useWallet as useChainWallet } from '../chain/near/wallet'
import { mockClient, type ModelClient } from './client'

export const WalletProvider = ChainWalletProvider

type Wallet = {
  account: string | null
  isDemo: boolean
  ready: boolean
  connect: () => Promise<void>
  connectDemo: () => void
  disconnect: () => Promise<void>
}

export function useWallet(): Wallet {
  const w = useChainWallet()
  return useMemo(
    () => ({ account: w.accountId, isDemo: false, ready: w.ready, connect: w.connect, connectDemo: () => void w.connect(), disconnect: w.disconnect }),
    [w.accountId, w.ready, w.connect, w.disconnect],
  )
}

// the model client, for the screens still on the in-browser model
export function useClient(): ModelClient {
  return mockClient
}
