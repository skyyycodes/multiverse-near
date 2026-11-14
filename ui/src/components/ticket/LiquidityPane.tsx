// The ticket's Liquidity tab: one deposit adds depth to every world's pool (Root LP, T12b).
// Placeholder until the lending track builds it: says what the tab does and links to the full screen.
import { Button } from '../ui'
import type { PaneProps } from './types'

export function LiquidityPane({ market }: PaneProps) {
  return (
    <>
      <p className="ticket__help">Add USDC and NEAR to every world's pool at once, and earn the swap fees.</p>
      <Button to={`/lend/?id=${market.sid}`}>Open Lend</Button>
    </>
  )
}
