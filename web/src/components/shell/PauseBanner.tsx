"use client";

import { BRAND } from "@/lib/brand";
import { countdown, utcDate } from "@/lib/format";
import { useNowSeconds } from "@/lib/hooks/useClock";
import { usePauseState } from "@/lib/hooks/useOps";
import { FLAG_LABEL, graceLeft } from "@/lib/pause";

/** "a", "a and b", "a, b and c". */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The banner's sentence for a pause state, or undefined when nothing is paused and no liquidation grace runs. */
export function pauseText(paused: readonly (keyof typeof FLAG_LABEL)[], graceSec: bigint): { title: string; detail: string } | undefined {
  if (paused.length === 0 && graceSec <= 0n) return undefined;
  const grace = graceSec > 0n ? ` Liquidations resume in ${countdown(graceSec)}.` : "";
  if (paused.length === 0) return { title: `${BRAND.name} is back from maintenance.`, detail: grace.trim() };
  const stillWork = paused.includes("exit") ? "Repay and adding collateral still work." : "Repay, adding collateral and withdrawals still work.";
  return { title: `${BRAND.name} is paused for maintenance: ${joinWords(paused.map((f) => FLAG_LABEL[f]))}.`, detail: `${stillWork}${grace}` };
}

/**
 * Names the paused flags in plain words (W-D7). Desktop: a band under the top bar; phone: inside the screen's header.
 * Buttons of the paused actions say the same thing on their own (TxButton).
 */
export function PauseBanner({ compact }: { compact?: boolean }) {
  const pause = usePauseState();
  const now = useNowSeconds();
  const p = pause.data;
  const text = p ? pauseText(p.paused, graceLeft(p, now)) : undefined;
  if (!p || !text) return null;
  return (
    <div
      role="status"
      data-demo="pause-banner"
      className={`flex flex-col gap-1 rounded-[18px] border border-warn-dark/40 bg-warn-dark/10 text-white ${compact ? "px-3.5 py-2.5 text-[12px]" : "px-5 py-3 text-[13px]"}`}
    >
      <span className="font-semibold text-warn-dark">{text.title}</span>
      <span className="leading-snug text-white/80">
        {text.detail}
        {p.paused.length > 0 && p.sinceSec > 0n && <span className="num text-white/60"> Since {utcDate(p.sinceSec)}.</span>}
      </span>
    </div>
  );
}
