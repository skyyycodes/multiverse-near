'use client'
// The ticket's Fund tab: split real wNEAR or USDC into every world still possible (T44), so you hold it in each one.
// Merging back is on the Split page, linked under the button.
import { useState } from 'react'
import type { Asset } from '../../chain/types'
import { SplitTicket } from '../SplitTicket'
import type { PaneProps } from './types'

export function FundPane({ market }: PaneProps) {
  const [asset, setAsset] = useState<Asset>('wnear')
  if (market.settled || market.worlds.filter((w) => w.possible).length < 2) {
    return <p className="ticket__help">One world is left, so there is nothing to split into. What you hold in it redeems 1:1 on Resolve.</p>
  }
  return <SplitTicket market={market} mode="split" asset={asset} onAsset={setAsset} />
}
