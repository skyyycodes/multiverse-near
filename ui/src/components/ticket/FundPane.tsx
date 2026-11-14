// The ticket's Fund tab: split real wNEAR or USDC into every world still possible (split, T44).
// Placeholder until the trading track builds it: says what the tab does and links to the full screen.
import { Button } from '../ui'
import type { PaneProps } from './types'

export function FundPane({ market }: PaneProps) {
  return (
    <>
      <p className="ticket__help">Split real wNEAR or USDC into every world still possible, so you hold it in each one.</p>
      <Button to={`/split/?id=${market.sid}`}>Split into every world</Button>
    </>
  )
}
