// The ticket's Hedge tab: sell NEAR in the picked worlds for dollars of the same worlds (conditional sale, T1).
// Placeholder until the trading track builds it: says what the tab does and links to the full screen.
import { Button } from '../ui'
import type { PaneProps } from './types'

export function HedgePane({ market }: PaneProps) {
  return (
    <>
      <p className="ticket__help">Sell NEAR in the worlds you fear for dollars in those worlds, and keep it everywhere else.</p>
      <Button to={`/orders/?id=${market.sid}`}>Open the order book</Button>
    </>
  )
}
