'use client'
// The ticket's Borrow tab: what borrowing costs in each tier of this market and the account's loans here, from
// lending_tiers, then the full Borrow screen (tiers, liquidation price per world, sell and borrow).
import { useLendingTiers } from '../../chain/hooks/useLending'
import { fmtHf, fmtUsd, hfTone, pct } from '../../chain/format'
import { annualRate, WAD } from '../../chain/lending'
import { borrowHref } from '../../chain/links'
import { useWallet } from '../../chain/near/wallet'
import { positionTier, TIER_LABEL } from '../../chain/tiers'
import { Button } from '../ui'
import type { PaneProps } from './types'

const TONE = { ok: 'safe', warn: 'watch', bad: 'risk' } as const

export function BorrowPane({ market }: PaneProps) {
  const { accountId } = useWallet()
  const tiers = useLendingTiers(market.lendable ? market.sid : undefined, accountId)
  if (!market.lendable) {
    return (
      <>
        <p className="ticket__help">Borrowing isn’t open in this market yet: every world needs a deep, priced pool first.</p>
        <Button to={borrowHref(market.sid)}>Open Borrow</Button>
      </>
    )
  }
  const loans = (tiers.data ?? []).filter((t) => t.account && t.account.debt > 0n)
  return (
    <>
      <p className="ticket__help">Borrow real USDC against your worst world. Lenders count only that one.</p>
      {(tiers.data ?? []).map((t) => (
        <p key={t.tier} className="tk__line"><span>{TIER_LABEL[t.tier]} · up to {pct(t.market.config.borrowLtv, WAD, 0)}</span><b className="num">{pct(annualRate(t.market.borrowRatePerSec), WAD, 2)} a year</b></p>
      ))}
      {!tiers.data && <p className="pc__note">Reading the tiers…</p>}
      {loans.map((t) => (
        <p key={`loan-${t.tier}`} className="tk__line"><span>Your {TIER_LABEL[t.tier]} loan</span><b className="num">{fmtUsd(t.account!.debt)} · <span className={`tone--${TONE[hfTone(t.account!.healthFactor)]}`}>health {fmtHf(t.account!.healthFactor)}</span></b></p>
      ))}
      <Button to={borrowHref(market.sid, positionTier(tiers.data, 'borrow'))}>Open Borrow</Button>
    </>
  )
}
