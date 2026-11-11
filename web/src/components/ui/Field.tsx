"use client";

import { useId, type ReactNode } from "react";

/**
 * An amount input with big numerals: label on the left, an optional helper on the right ("wallet: 2.0000 WETH" as a
 * fill button), the unit inside the field.
 */
export function AmountField({
  label,
  value,
  onChange,
  unit,
  right,
  ariaLabel,
  placeholder = "0.00",
  size = "lg",
  demo,
  invalid,
  allowWords,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  right?: ReactNode;
  ariaLabel?: string;
  placeholder?: string;
  size?: "lg" | "md";
  demo?: string;
  invalid?: boolean;
  /** Accepts a keyword such as "all" besides numbers. */
  allowWords?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium text-ink">
          {label}
        </label>
        {right}
      </div>
      <div
        className={`flex items-baseline gap-2 rounded-[18px] border bg-sheet px-4 transition-colors focus-within:border-ink ${
          invalid ? "border-neg" : "border-line-strong"
        } ${size === "lg" ? "py-3" : "py-2.5"}`}
      >
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode={allowWords ? "text" : "decimal"}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          aria-label={ariaLabel ?? label}
          data-demo={demo}
          className={`numeral min-w-0 flex-1 bg-transparent text-ink outline-none ${size === "lg" ? "text-[34px]" : "text-[22px]"}`}
        />
        {unit && <span className="shrink-0 text-[13px] font-medium text-mute">{unit}</span>}
      </div>
    </div>
  );
}

/** A compact labelled input for two-up forms (price and amount of an order). */
export function SmallField({
  label,
  value,
  onChange,
  placeholder = "0.00",
  demo,
  ariaLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  demo?: string;
  ariaLabel?: string;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[12px] text-mute">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        aria-label={ariaLabel}
        data-demo={demo}
        className="num h-11 w-full min-w-0 rounded-[14px] border border-line-strong bg-sheet px-3 text-[16px] text-ink outline-none focus:border-ink"
      />
    </div>
  );
}
