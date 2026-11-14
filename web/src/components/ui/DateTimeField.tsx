"use client";

import { useId } from "react";
import { parseUtcInput, utcInputValue } from "@/lib/format";

/** A date and time read and written in UTC (the contract's clock), never in the viewer's zone; `minSec` is enforced. */
export function DateTimeField({
  label,
  valueSec,
  onChange,
  minSec,
  demo,
  hint,
}: {
  label: string;
  valueSec: number | undefined;
  onChange: (sec: number | undefined) => void;
  minSec?: number;
  demo?: string;
  hint?: string;
}) {
  const id = useId();
  const tooSoon = valueSec !== undefined && minSec !== undefined && valueSec < minSec;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      <div className={`flex items-center gap-2 rounded-[14px] border bg-sheet px-3.5 focus-within:border-ink ${tooSoon ? "border-neg" : "border-line-strong"}`}>
        <input
          id={id}
          type="datetime-local"
          value={valueSec === undefined ? "" : utcInputValue(valueSec)}
          min={minSec === undefined ? undefined : utcInputValue(minSec)}
          onChange={(e) => onChange(parseUtcInput(e.target.value))}
          aria-invalid={tooSoon || undefined}
          data-demo={demo}
          className="num h-11 min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none"
        />
        <span className="shrink-0 text-[13px] font-medium text-mute">UTC</span>
      </div>
      {(tooSoon || hint) && (
        <p className={`text-[12px] leading-snug ${tooSoon ? "text-neg" : "text-mute"}`}>{tooSoon ? `Pick ${utcInputValue(minSec!).replace("T", " ")} UTC or later` : hint}</p>
      )}
    </div>
  );
}
