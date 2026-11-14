'use client'
// Safe, Normal or Bold for one market, as three cards in the desk's style: each tier's own borrow and liquidation
// limits and its rate (from lending_tiers, never constants), and what the account has in it. The picked tier's terms
// sit underneath in one plain line.
import type { LendingTier, Tier } from '../../chain/domain'
import { fmtCompactUsd, fmtUsd, pct } from '../../chain/format'
import { annualRate, cushion, WAD } from '../../chain/lending'
import { TIER_LABEL, TIERS } from '../../chain/tiers'

export function TierPick({ tiers, value, onChange, mode }: { tiers: readonly LendingTier[] | undefined; value: Tier; onChange: (t: Tier) => void; mode: 'borrow' | 'lend' }) {
  const picked = tiers?.find((t) => t.tier === value)
  return (
    <div className="tierpick">
      <div className="tierpick__row" role="group" aria-label="Lending tier">
        {TIERS.map((tier) => {
          const t = tiers?.find((x) => x.tier === tier)
          const c = t?.market.config
          const apr = t ? annualRate(mode === 'borrow' ? t.market.borrowRatePerSec : t.market.supplyRatePerSec) : undefined
          const mine = t?.account ? (mode === 'borrow' ? t.account.debt : t.account.supplied) : 0n
          return (
            <button key={tier} type="button" className="tierpick__tier" aria-pressed={tier === value} data-tier={tier} onClick={() => onChange(tier)}>
              <span className="tierpick__name"><b>{TIER_LABEL[tier]}</b>{t?.market.frozen && <em className="mk__flag">Frozen</em>}</span>
              <span className="tierpick__terms num">{c ? `${pct(c.borrowLtv, WAD, 0)} limit · ${pct(c.lltv, WAD, 0)} liquidation` : '–'}</span>
              <span className="tierpick__rate num">{apr !== undefined ? pct(apr, WAD, 2) : '–'}<small>{mode === 'borrow' ? ' to borrow' : ' to lenders'}</small></span>
              {mine > 0n && <small className="tierpick__mine num">{mode === 'borrow' ? 'Your loan' : 'You supply'} {fmtUsd(mine)}</small>}
            </button>
          )
        })}
      </div>
      <p className="pc__note">
        {picked
          ? `${TIER_LABEL[picked.tier]}: borrow up to ${pct(picked.market.config.borrowLtv, WAD, 0)} of your worst world, liquidated at ${pct(picked.market.config.lltv, WAD, 0)}${mode === 'borrow' ? ` (a ${pct(cushion(picked.market.config), WAD, 1)} fall from the limit)` : ''} · ${fmtCompactUsd(picked.market.liquid)} free to lend${picked.market.frozen ? ' · frozen: no new loans or deposits' : ''}`
          : 'Reading the tiers…'}
      </p>
    </div>
  )
}
