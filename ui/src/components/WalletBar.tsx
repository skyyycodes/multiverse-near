// What's in your wallet (real wNEAR and USDC, outside the contract), and the testnet faucet: "Get test tokens" mints
// 2,000 wNEAR and 5,000 USDC, skipping a token you already hold that much of, as the mock tokens on testnet do.
import { useState } from 'react'
import { FAUCET, useStore } from '../lib/scenario'
import { useClient, useWallet } from '../lib/wallet'

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

export function WalletBar({ compact = false }: { compact?: boolean }) {
  const { account } = useWallet()
  const { wallet } = useStore()
  const client = useClient()
  const [busy, setBusy] = useState(false)
  if (!account) return null
  const full = wallet.near >= FAUCET.near && wallet.usdc >= FAUCET.usdc
  const get = async () => {
    setBusy(true)
    try { await client.getTestTokens(account) } finally { setBusy(false) }
  }
  return (
    <div className={`walletbar${compact ? ' walletbar--compact' : ''}`}>
      <span className="walletbar__label">In your wallet</span>
      <span className="walletbar__bal"><b className="num">{fmt(wallet.near)}</b> wNEAR</span>
      <span className="walletbar__bal"><b className="num">{fmt(wallet.usdc)}</b> USDC</span>
      {!full && (
        <button type="button" className="walletbar__faucet" onClick={get} disabled={busy}>
          {busy ? 'Minting…' : 'Get test tokens'}
        </button>
      )}
    </div>
  )
}
