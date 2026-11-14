"use client";

/** A market kept for existing positions, out of the list (W-D3): it still trades, lends and closes by id. */
export function UnlistedBanner({ sid, compact }: { sid: number; compact?: boolean }) {
  return (
    <div
      role="status"
      data-demo="unlisted-banner"
      className={`rounded-[18px] border border-white/15 bg-white/8 leading-snug text-white/85 ${compact ? "px-3.5 py-2.5 text-[12px]" : "px-5 py-3 text-[13px]"}`}
    >
      <span className="font-semibold text-white">Unlisted market #{sid}:</span> kept for existing positions. It is not in the market list and takes no new
      pledges.
    </div>
  );
}
