"use client";

import { useIsDesktop } from "@/lib/hooks/useMedia";

export type ChipOption<T extends string> = { value: T; label: string; demo?: string; disabled?: boolean };

/**
 * One choice out of a row of chips (filters, tiers): a radio group that scrolls sideways edge to edge on a phone and
 * wraps on a desktop.
 */
export function ChipScroller<T extends string>({
  options,
  value,
  onChange,
  demo,
  label,
}: {
  options: readonly ChipOption<T>[];
  value: T;
  onChange: (v: T) => void;
  demo?: string;
  label?: string;
}) {
  const desktop = useIsDesktop();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-demo={demo}
      className={desktop ? "flex flex-wrap gap-2" : "no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4"}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            data-demo={o.demo}
            onClick={() => onChange(o.value)}
            className={`focus-ring min-h-9 shrink-0 rounded-full border px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
              on ? "border-ink bg-ink text-white" : "border-line-strong bg-sheet text-ink hover:border-ink/40"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
