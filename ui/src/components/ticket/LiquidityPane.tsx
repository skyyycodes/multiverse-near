'use client'
// The ticket's Liquidity tab: Root liquidity for this market (T12b, T13), one deposit into every world's pool.
import { RootLp } from '../lending/RootLp'
import type { PaneProps } from './types'

export function LiquidityPane({ market }: PaneProps) {
  return (
    <>
      <p className="ticket__help">Add NEAR and USDC to every world’s pool at once, and earn the swap fees in each.</p>
      <RootLp market={market} />
    </>
  )
}
