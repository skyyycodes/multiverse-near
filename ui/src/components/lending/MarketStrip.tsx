'use client'
// The markets you can borrow against or lend to, as the borrow page's strip of cards: each with its artwork and,
// from its tiers, what you have there.
import type { ChainMarket } from '../../chain/adapter'
import type { LendingTier } from '../../chain/domain'
import { fmtHf, fmtUsd, pct } from '../../chain/format'
import { annualRate, WAD } from '../../chain/lending'
import { MarketArt } from '../Grand'

function note(tiers: readonly LendingTier[] | undefined, mode: 'borrow' | 'lend'): string {
  if (!tiers) return 'Reading its tiers…'
  const accts = tiers.map((t) => t.account).filter((a) => a !== null)
  if (mode === 'borrow') {
    const debt = accts.reduce((s, a) => s + a.debt, 0n)
    const hfs = accts.filter((a) => a.debt > 0n && a.healthFactor !== null).map((a) => a.healthFactor as bigint)
    if (debt > 0n) return `Loan ${fmtUsd(debt)} · lowest health ${fmtHf(hfs.length ? hfs.reduce((m, h) => (h < m ? h : m)) : null)}`
    if (accts.some((a) => a.collateral.length > 0)) return 'Collateral posted, no loan'
    const low = tiers.map((t) => annualRate(t.market.borrowRatePerSec)).reduce((m, r) => (r < m ? r : m))
    return `Borrow from ${pct(low, WAD, 2)} a year`
  }
  const supplied = accts.reduce((s, a) => s + a.supplied, 0n)
  if (supplied > 0n) return `You supply ${fmtUsd(supplied)}`
  const high = tiers.map((t) => annualRate(t.market.supplyRatePerSec)).reduce((m, r) => (r > m ? r : m))
  return `Lenders earn up to ${pct(high, WAD, 2)}`
}

export function MarketStrip({ markets, sid, onPick, tiers, mode }: { markets: readonly ChainMarket[]; sid: number; onPick: (sid: number) => void; tiers: ReadonlyMap<number, LendingTier[]>; mode: 'borrow' | 'lend' }) {
  return (
    <div className="desk__cards" role="group" aria-label="Market">
      {markets.map((m) => (
        <button key={m.sid} type="button" aria-pressed={m.sid === sid} className="desk__card" onClick={() => onPick(m.sid)}>
          <MarketArt m={m} size={40} />
          <span className="desk__cardtext"><b>{m.question}</b><small>{note(tiers.get(m.sid), mode)}</small></span>
        </button>
      ))}
    </div>
  )
}
