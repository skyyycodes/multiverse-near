"use client";

import { useId, useState, type ReactNode } from "react";

/** A titled section that opens and closes (`button[aria-expanded]`). */
export function Disclosure({ title, children, demo, defaultOpen = false }: { title: ReactNode; children: ReactNode; demo?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="flex flex-col" data-demo={demo}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="focus-ring flex min-h-11 items-center justify-between gap-3 rounded-[14px] text-left text-[14px] font-semibold text-ink"
      >
        <span>{title}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={`shrink-0 text-mute transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div id={id} className="pt-1 pb-2 text-[13px] leading-relaxed text-mute">
          {children}
        </div>
      )}
    </div>
  );
}
