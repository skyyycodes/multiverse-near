'use client'
// The ticket's Lend tab: what lenders earn in each tier of this market and the account's supply here, from
// lending_tiers, then the full Lend screen.
import { useLendingTiers } from '../../chain/hooks/useLending'
import { fmtCompactUsd, fmtUsd, pct } from '../../chain/format'
import { annualRate, WAD } from '../../chain/lending'
import { lendHref } from '../../chain/links'
import { useWallet } from '../../chain/near/wallet'
import { positionTier, TIER_LABEL } from '../../chain/tiers'
import { Button } from '../ui'
import type { PaneProps } from './types'

export function LendPane({ market }: PaneProps) {
  const { accountId } = useWallet()
  const tiers = useLendingTiers(market.lendable ? market.sid : undefined, accountId)
  if (!market.lendable) {
    return (
      <>
        <p className="ticket__help">Lending opens with borrowing, once every world of this market has a deep, priced pool.</p>
        <Button to={lendHref(market.sid)}>Open Lend</Button>
      </>
    )
  }
  const supplied = (tiers.data ?? []).filter((t) => t.account && t.account.supplied > 0n)
  return (
    <>
      <p className="ticket__help">Lend USDC to borrowers in this market, in the tier that suits you. Every loan is covered in every world.</p>
      {(tiers.data ?? []).map((t) => (
        <p key={t.tier} className="tk__line"><span>{TIER_LABEL[t.tier]} · {pct(t.market.utilization, WAD, 0)} lent out</span><b className="num">{pct(annualRate(t.market.supplyRatePerSec), WAD, 2)} a year · {fmtCompactUsd(t.market.totalSupply)} supplied</b></p>
      ))}
      {!tiers.data && <p className="pc__note">Reading the tiers…</p>}
      {supplied.map((t) => (
        <p key={`mine-${t.tier}`} className="tk__line"><span>You supply in {TIER_LABEL[t.tier]}</span><b className="num">{fmtUsd(t.account!.supplied)}</b></p>
      ))}
      <Button to={lendHref(market.sid, positionTier(tiers.data, 'lend'))}>Open Lend</Button>
    </>
  )
}
