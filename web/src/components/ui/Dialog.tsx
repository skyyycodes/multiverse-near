"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconClose } from "@/components/brand/Icons";

/**
 * A sheet that rises from the bottom on a phone and sits centred on a desktop. Escape and the backdrop close it;
 * focus moves into it on open and back to the opener on close.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  demo,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  demo?: string;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => panel.current?.focus(), 30);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
      document.body.style.overflow = prev;
      opener?.focus?.();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" data-demo={demo}>
          <motion.button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-navy-950/55 backdrop-blur-[2px]"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={id}
            tabIndex={-1}
            className="relative z-10 flex max-h-[88dvh] w-full flex-col gap-4 overflow-y-auto rounded-t-[28px] bg-sheet p-5 pb-[max(20px,env(safe-area-inset-bottom))] shadow-card outline-none sm:max-w-md sm:rounded-[28px] sm:p-6"
            initial={reduce ? { opacity: 0 } : { y: 40, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { y: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { y: 24, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 id={id} className="font-display text-[20px] font-medium text-ink">
                {title}
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="focus-ring -mr-2 grid size-10 place-items-center rounded-full text-mute hover:bg-tile hover:text-ink"
              >
                <IconClose size={20} />
              </button>
            </div>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
