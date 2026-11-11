"use client";

import type { ReactNode } from "react";
import { Pill } from "./Button";

/** A guard message in place of a screen (nothing deployed, nothing seeded). */
export function Notice({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <div className="flex max-w-xl flex-col gap-2 rounded-[28px] bg-sheet p-6 text-[14px] leading-relaxed text-mute shadow-card">
      {title && <h2 className="font-display text-[20px] font-medium text-ink">{title}</h2>}
      <div>{children}</div>
    </div>
  );
}

/** Shown wherever a snapshot has not arrived: reading, or what went wrong and a way to try again. */
export function ChainWait({ error, onRetry, dark }: { error?: string; onRetry?: () => void; dark?: boolean }) {
  if (error) {
    return (
      <div role="alert" className={`flex flex-col items-start gap-3 rounded-[20px] p-4 text-[13px] ${dark ? "bg-white/8 text-white/85" : "bg-tile text-ink"}`}>
        <p className="break-words">Could not read the chain: {error}</p>
        {onRetry && (
          <Pill tone={dark ? "light" : "secondary"} size="sm" onClick={onRetry}>
            Try again
          </Pill>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <p className={`text-[13px] ${dark ? "text-white/70" : "text-mute"}`}>Reading the chain…</p>
      <div className={`h-24 rounded-[20px] ${dark ? "skeleton-dark" : "skeleton"}`} />
      <div className={`h-16 rounded-[20px] ${dark ? "skeleton-dark" : "skeleton"}`} />
    </div>
  );
}
