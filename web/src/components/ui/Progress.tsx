"use client";

/** Progress toward a goal in basis points; past 100% the bar stays full and turns the positive tone. */
export function ProgressBar({ valueBps, label, tone, demo }: { valueBps: number; label?: string; tone?: "pos" | "warn"; demo?: string }) {
  const pctValue = Math.max(0, Math.min(100, Math.floor(valueBps / 100)));
  const done = valueBps >= 10_000;
  const fill = tone === "warn" ? "bg-warn-bright" : done || tone === "pos" ? "bg-pos-bright" : "bg-cobalt";
  return (
    <div className="flex flex-col gap-1.5" data-demo={demo}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pctValue}
        aria-label={label}
        className="h-2.5 w-full overflow-hidden rounded-full bg-tile"
      >
        <div className={`h-full rounded-full transition-[width] duration-300 ${fill}`} style={{ width: `${pctValue}%` }} />
      </div>
      {label && <span className="num text-[12px] text-mute">{label}</span>}
    </div>
  );
}
