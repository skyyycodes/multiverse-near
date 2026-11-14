"use client";

import type { LendingTier, Tier } from "@/lib/domain";
import { pct } from "@/lib/format";
import { WAD } from "@/lib/lending";
import { TIER_LABEL, TIERS } from "@/lib/tiers";

/**
 * The tier a sale keeps its collateral in (web 6.4, `sell-tier`): three options labelled from `lending_tiers`
 * ("Safe · borrow up to 50%"); a frozen tier is disabled.
 */
export function TierSelect({ tiers, value, onChange }: { tiers: readonly LendingTier[] | undefined; value: Tier; onChange: (t: Tier) => void }) {
  return (
    <div role="radiogroup" aria-label="Lending tier" data-demo="sell-tier" className="grid grid-cols-3 gap-1 rounded-[14px] bg-tile p-1">
      {TIERS.map((tier) => {
        const t = tiers?.find((x) => x.tier === tier);
        const frozen = Boolean(t?.market.frozen);
        const on = tier === value;
        return (
          <button
            key={tier}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={frozen}
            data-demo={`sell-tier-${tier}`}
            onClick={() => onChange(tier)}
            className={`focus-ring flex min-h-11 min-w-0 flex-col items-center justify-center rounded-[11px] px-2 py-1 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
              on ? "bg-ink text-white shadow-sm" : "text-mute hover:text-ink"
            }`}
          >
            <span className="text-[13px] font-semibold">{TIER_LABEL[tier]}</span>
            <span className="num truncate text-[11px]">{frozen ? "frozen" : t ? `borrow up to ${pct(t.market.config.borrowLtv, WAD, 0)}` : "—"}</span>
          </button>
        );
      })}
    </div>
  );
}
