"use client";

import type { ReactNode } from "react";
import { useIsDesktop } from "@/lib/hooks/useMedia";

/**
 * A block of screen content. On desktop each block is its own white sheet floating on the navy stage; on a phone every
 * block already sits inside the one white sheet under the header, so it renders bare.
 */
export function Block({
  children,
  className = "",
  title,
  action,
  demo,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  action?: ReactNode;
  demo?: string;
}) {
  const desktop = useIsDesktop();
  return (
    <section
      data-demo={demo}
      className={`flex flex-col gap-4 ${desktop ? "rounded-[28px] bg-sheet p-6 shadow-card" : ""} ${className}`}
    >
      {(title || action) && (
        <div className="flex items-baseline justify-between gap-3">
          {title && <h2 className="font-display text-[20px] leading-tight font-medium tracking-[-0.01em] text-ink">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** A card that is always a white sheet (asides and nested panels): floating on desktop, outlined inside the phone's sheet. */
export function Sheet({ children, className = "", demo }: { children: ReactNode; className?: string; demo?: string }) {
  const desktop = useIsDesktop();
  return (
    <section
      data-demo={demo}
      className={`flex flex-col gap-4 rounded-[28px] bg-sheet ${desktop ? "p-6 shadow-card" : "border border-line p-5 shadow-[0_10px_30px_-24px_rgba(1,4,39,0.5)]"} ${className}`}
    >
      {children}
    </section>
  );
}

export function SheetTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="font-display text-[22px] leading-tight font-medium tracking-[-0.01em] text-ink">{children}</h2>
      {sub && <p className="text-[13px] leading-relaxed text-mute">{sub}</p>}
    </div>
  );
}

/** A quiet grey band inside a sheet: a step of a form ("Pick the worlds you fear"). */
export function Band({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-col gap-3 rounded-[20px] bg-tile p-4 ${className}`}>{children}</div>;
}
