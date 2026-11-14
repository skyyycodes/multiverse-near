// The ticket's Lend tab: supply USDC to one of the market's lending tiers (T10).
// Placeholder until the lending track builds it: says what the tab does and links to the full screen.
import { Button } from '../ui'
import type { PaneProps } from './types'

export function LendPane({ market }: PaneProps) {
  return (
    <>
      <p className="ticket__help">Lend USDC to borrowers in this market, in the tier that suits you.</p>
      <Button to={`/lend/?id=${market.sid}`}>Open Lend</Button>
    </>
  )
}
