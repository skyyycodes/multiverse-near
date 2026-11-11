"use client";

import type { ReactNode } from "react";

/** A stat tile: quiet uppercase label, value in display numerals, a note. */
export function StatTile({
  label,
  value,
  note,
  tone,
  children,
  demo,
}: {
  label: string;
  value?: ReactNode;
  note?: ReactNode;
  tone?: "pos" | "neg" | "warn";
  children?: ReactNode;
  demo?: string;
}) {
  const color = tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div data-demo={demo} className="flex min-w-0 flex-col gap-1.5 rounded-[18px] bg-tile p-4">
      <span className="label text-mute">{label}</span>
      {value !== undefined && <span className={`num text-[20px] leading-tight ${color}`}>{value}</span>}
      {children}
      {note && <span className="text-[12px] leading-snug text-mute">{note}</span>}
    </div>
  );
}

/** Segmented control. `role` tab for the aside switch (Sell / Order book), pressed buttons otherwise. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  tabs,
  size = "md",
  demo,
}: {
  options: readonly { value: T; label: string; demo?: string }[];
  value: T;
  onChange: (v: T) => void;
  tabs?: boolean;
  size?: "md" | "sm";
  demo?: string;
}) {
  return (
    <div role={tabs ? "tablist" : undefined} data-demo={demo} className="flex gap-1 rounded-full bg-tile p-1">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role={tabs ? "tab" : undefined}
            aria-selected={tabs ? on : undefined}
            aria-pressed={tabs ? undefined : on}
            data-demo={o.demo}
            onClick={() => onChange(o.value)}
            className={`focus-ring flex-1 rounded-full font-medium transition-colors ${size === "md" ? "min-h-10 px-4 text-[14px]" : "min-h-9 px-3 text-[13px]"} ${
              on ? "bg-ink text-white shadow-sm" : "text-mute hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A status chip: backed / unbacked, proposed, resolved, liquidatable. */
export function Chip({
  tone = "neutral",
  children,
  onDark,
  title,
  className = "",
}: {
  tone?: "pos" | "neg" | "warn" | "neutral" | "info";
  children: ReactNode;
  onDark?: boolean;
  title?: string;
  className?: string;
}) {
  const light = {
    pos: "bg-pos-bright/12 text-pos",
    neg: "bg-neg-bright/12 text-neg",
    warn: "bg-warn-bright/18 text-warn",
    neutral: "bg-tile text-mute",
    info: "bg-cobalt/12 text-cobalt-ink",
  }[tone];
  const dark = {
    pos: "bg-pos-dark/15 text-pos-dark",
    neg: "bg-neg-dark/15 text-neg-dark",
    warn: "bg-warn-dark/15 text-warn-dark",
    neutral: "bg-white/10 text-white/75",
    info: "bg-sky/20 text-white",
  }[tone];
  return (
    <span
      title={title}
      className={`num inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] leading-none font-medium whitespace-nowrap ${onDark ? dark : light} ${className}`}
    >
      {children}
    </span>
  );
}

/** Label / value rows ("World info", summaries). */
export function InfoRows({ rows, className = "" }: { rows: { label: ReactNode; value: ReactNode; tone?: string; demo?: string }[]; className?: string }) {
  return (
    <dl className={`flex flex-col ${className}`}>
      {rows.map((r, i) => (
        <div key={i} data-demo={r.demo} className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 last:border-b-0">
          <dt className="text-[13px] text-mute">{r.label}</dt>
          <dd className={`num text-right text-[14px] whitespace-nowrap ${r.tone ?? "text-ink"}`}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`label text-mute ${className}`}>{children}</div>;
}
