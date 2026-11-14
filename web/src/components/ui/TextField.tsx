"use client";

import { useId, type ReactNode } from "react";
import { utf8Bytes } from "@/lib/format";

type Common = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** The contract's limit in UTF-8 bytes; the counter shows "n / max bytes" and turns red past it. */
  maxBytes?: number;
  placeholder?: string;
  demo?: string;
  invalid?: boolean;
  /** A quiet line under the field; an error replaces it. */
  hint?: string;
  error?: string;
};

function Frame({ id, label, counter, over, hint, error, children }: { id: string; label: string; counter?: string; over: boolean; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium text-ink">
          {label}
        </label>
        {counter && <span className={`num text-[12px] ${over ? "text-neg" : "text-mute"}`}>{counter}</span>}
      </div>
      {children}
      {(error || hint) && <p className={`text-[12px] leading-snug ${error ? "text-neg" : "text-mute"}`}>{error ?? hint}</p>}
    </div>
  );
}

const inputClass = (bad: boolean) =>
  `w-full min-w-0 rounded-[14px] border bg-sheet px-3.5 text-[16px] text-ink outline-none transition-colors focus:border-ink ${bad ? "border-neg" : "border-line-strong"}`;

/** A one-line text input with a UTF-8 byte counter (16 px text, so phones do not zoom). */
export function TextField({ label, value, onChange, maxBytes, placeholder, demo, invalid, hint, error }: Common) {
  const id = useId();
  const bytes = utf8Bytes(value);
  const over = maxBytes !== undefined && bytes > maxBytes;
  return (
    <Frame id={id} label={label} counter={maxBytes !== undefined ? `${bytes} / ${maxBytes} bytes` : undefined} over={over} hint={hint} error={error}>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        aria-invalid={over || invalid || Boolean(error) || undefined}
        data-demo={demo}
        className={`${inputClass(over || Boolean(invalid) || Boolean(error))} h-11`}
      />
    </Frame>
  );
}

/** A multi-line text input with the same counter. */
export function TextArea({ label, value, onChange, maxBytes, placeholder, demo, invalid, hint, error, rows = 4 }: Common & { rows?: number }) {
  const id = useId();
  const bytes = utf8Bytes(value);
  const over = maxBytes !== undefined && bytes > maxBytes;
  return (
    <Frame id={id} label={label} counter={maxBytes !== undefined ? `${bytes} / ${maxBytes} bytes` : undefined} over={over} hint={hint} error={error}>
      <textarea
        id={id}
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={over || invalid || Boolean(error) || undefined}
        data-demo={demo}
        className={`${inputClass(over || Boolean(invalid) || Boolean(error))} resize-y py-2.5 leading-relaxed`}
      />
    </Frame>
  );
}
