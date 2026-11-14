// NEAR Intents through the 1Click API: deposits from other chains arrive on NEAR as wNEAR or USDC.
// There is no Intents testnet, so this build only asks for dry-run quotes (`dry: true`): real prices,
// fees and timing, but no deposit address, so nothing can be sent. Unauthenticated requests pay the
// API's own fee; a JWT (NEXT_PUBLIC_ONECLICK_JWT) removes it.
const API = 'https://1click.chaindefuser.com/v0'
const JWT = process.env.NEXT_PUBLIC_ONECLICK_JWT ?? ''

export type IntentsToken = { assetId: string; symbol: string; blockchain: string; decimals: number; price: number }

// where you can deposit from in this build. Refund addresses are placeholders in each chain's format: a dry
// run needs one, but nothing is ever sent to it.
export const SOURCES = [
  { id: 'usdc-eth', label: 'USDC on Ethereum', decimals: 6, assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', refundTo: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D' },
  { id: 'usdc-arb', label: 'USDC on Arbitrum', decimals: 6, assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', refundTo: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D' },
  { id: 'usdc-base', label: 'USDC on Base', decimals: 6, assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', refundTo: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D' },
  { id: 'usdc-sol', label: 'USDC on Solana', decimals: 6, assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', refundTo: '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK' },
  { id: 'eth', label: 'ETH on Ethereum', decimals: 18, assetId: 'nep141:eth.omft.near', refundTo: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D' },
  { id: 'sol', label: 'SOL on Solana', decimals: 9, assetId: 'nep141:sol.omft.near', refundTo: '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK' },
] as const
export type SourceId = (typeof SOURCES)[number]['id']

// what arrives on NEAR
export const DESTINATIONS = {
  near: { assetId: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24 },
  usdc: { assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', symbol: 'USDC', decimals: 6 },
} as const

// the swap's states, in order, as the status endpoint reports them
export const STATUSES = ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'INCOMPLETE_DEPOSIT', 'REFUNDED', 'FAILED'] as const
export type SwapStatus = (typeof STATUSES)[number]

export type DryQuote = {
  amountInFormatted: string
  amountInUsd: string
  amountOutFormatted: string
  amountOutUsd: string
  minAmountOut: string
  timeEstimate: number // seconds
  refundFee?: string
}

const headers = (): HeadersInit => ({ 'Content-Type': 'application/json', ...(JWT ? { Authorization: `Bearer ${JWT}` } : {}) })

// whole units to the token's smallest unit, as a string
function units(amount: number, decimals: number) {
  const [whole, frac = ''] = amount.toFixed(Math.min(decimals, 12)).split('.')
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString()
}

let tokens: Promise<IntentsToken[]> | null = null
export const listTokens = () => (tokens ??= fetch(`${API}/tokens`).then((r) => r.json() as Promise<IntentsToken[]>))

// ask what it costs to land `amount` of NEAR or USDC on NEAR, paid from `source` (an EXACT_OUTPUT dry run)
export async function dryQuote(source: SourceId, asset: keyof typeof DESTINATIONS, amount: number, recipient: string, signal?: AbortSignal): Promise<DryQuote> {
  const src = SOURCES.find((s) => s.id === source)!
  const dst = DESTINATIONS[asset]
  const res = await fetch(`${API}/quote`, {
    method: 'POST',
    headers: headers(),
    signal,
    body: JSON.stringify({
      dry: true,
      swapType: 'EXACT_OUTPUT',
      slippageTolerance: 100, // 1%, in basis points
      originAsset: src.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: dst.assetId,
      amount: units(amount, dst.decimals),
      refundTo: src.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.message ?? `Quote failed (${res.status})`)
  return json.quote as DryQuote
}

// the live status of a real swap; only reachable with a deposit address, which dry runs never get
export async function swapStatus(depositAddress: string, signal?: AbortSignal): Promise<SwapStatus> {
  const res = await fetch(`${API}/status?depositAddress=${encodeURIComponent(depositAddress)}`, { headers: headers(), signal })
  const json = await res.json()
  if (!res.ok) throw new Error(json.message ?? `Status failed (${res.status})`)
  return json.status as SwapStatus
}
