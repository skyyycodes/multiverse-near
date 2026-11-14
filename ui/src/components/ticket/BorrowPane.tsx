// The ticket's Borrow tab: borrow real USDC against the worst world, in a tier (T8, T41).
// Placeholder until the lending track builds it: says what the tab does and links to the full screen.
import { Button } from '../ui'
import type { PaneProps } from './types'

export function BorrowPane({ market }: PaneProps) {
  return (
    <>
      <p className="ticket__help">Borrow real USDC against your worst world. Lenders count only that one.</p>
      <Button to={`/borrow/?id=${market.sid}`}>Open Borrow</Button>
    </>
  )
}
