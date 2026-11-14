"use client";

import type { LendingTier, Tier } from "@/lib/domain";
import { fmtCompactUsd, fmtUsd, pct } from "@/lib/format";
import { annualRate, cushion, WAD } from "@/lib/lending";
import { TIER_LABEL, TIERS } from "@/lib/tiers";

/**
 * Safe / Normal / Bold for one market, on the dark hero: three pressed-button cards with the tier's own LTVs and rate
 * (from `lending_tiers`, never constants), the selected one's details in the caption below.
 */
export function TierPicker({
  tiers,
  value,
  onChange,
  mode,
}: {
  tiers: readonly LendingTier[] | undefined;
  value: Tier;
  onChange: (t: Tier) => void;
  mode: "borrow" | "lend";
}) {
  const selected = tiers?.find((t) => t.tier === value);
  return (
    <div className="flex flex-col gap-2" data-demo="tier-picker">
      <div className="grid grid-cols-3 gap-2">
        {TIERS.map((tier) => {
          const t = tiers?.find((x) => x.tier === tier);
          const on = tier === value;
          const c = t?.market.config;
          const apr = t ? annualRate(mode === "borrow" ? t.market.borrowRatePerSec : t.market.supplyRatePerSec) : undefined;
          const mine = t?.account ? (mode === "borrow" ? t.account.debt : t.account.supplied) : 0n;
          return (
            <button
              key={tier}
              type="button"
              aria-pressed={on}
              data-demo={`tier-${tier}`}
              onClick={() => onChange(tier)}
              className={`focus-ring flex min-w-0 flex-col items-start gap-1 rounded-[16px] border px-3 py-2.5 text-left transition-colors ${
                on ? "border-white bg-white text-ink" : "border-white/15 bg-white/6 text-white hover:bg-white/10"
              }`}
            >
              <span className="flex w-full items-center justify-between gap-1">
                <span className="text-[14px] font-semibold">{TIER_LABEL[tier]}</span>
                {t?.market.frozen && <span className={`text-[10px] font-semibold uppercase ${on ? "text-warn" : "text-warn-dark"}`}>Frozen</span>}
              </span>
              <span className={`num text-[12px] leading-tight ${on ? "text-mute" : "text-white/65"}`}>
                {c ? `${pct(c.borrowLtv, WAD, 0)} / ${pct(c.lltv, WAD, 0)}` : "— / —"}
              </span>
              <span className="num text-[13px] leading-tight">{apr !== undefined ? `APR ${pct(apr, WAD, 2)}` : "APR —"}</span>
              {mine > 0n && <span className={`num truncate text-[11px] leading-tight ${on ? "text-cobalt-ink" : "text-sky"}`}>yours {fmtUsd(mine)}</span>}
            </button>
          );
        })}
      </div>
      {selected && (
        <p className="num text-[12px] leading-snug text-white/70" data-demo="tier-caption">
          {TIER_LABEL[selected.tier]}: borrow up to {pct(selected.market.config.borrowLtv, WAD, 0)} · liquidated at {pct(selected.market.config.lltv, WAD, 0)} ·{" "}
          {fmtCompactUsd(selected.market.liquid)} available
          {mode === "borrow" ? ` · liquidated after a ${pct(cushion(selected.market.config), WAD, 1)} fall from your limit` : ""}
          {selected.market.frozen ? " · frozen: no new loans or deposits" : ""}
        </p>
      )}
    </div>
  );
}
