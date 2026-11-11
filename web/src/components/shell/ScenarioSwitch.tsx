"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IconCheck, IconChevronDown } from "@/components/brand/Icons";
import { Mark } from "@/components/brand/Mark";
import { useScenarioChoice, type ScenarioChoice } from "@/lib/hooks/useScenario";

const OPTIONS: { value: ScenarioChoice; label: string; short: string; demo: string }[] = [
  { value: "2x2", label: "Glamsterdam × Fed (4 worlds)", short: "Glamsterdam × Fed", demo: "scenario-2x2" },
  { value: "binary", label: "Glamsterdam only (2 worlds)", short: "Glamsterdam", demo: "scenario-binary" },
];

/** The scenario picker: a dark pill in the header that opens a two-item list. */
export function ScenarioSwitch() {
  const { which, setWhich } = useScenarioChoice();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = OPTIONS.find((o) => o.value === which) ?? OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative min-w-0">
      <button
        type="button"
        data-demo="scenario-switch"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="focus-ring flex h-10 max-w-full min-w-0 items-center gap-2 rounded-full border border-white/12 bg-white/8 pr-3 pl-1.5 text-[14px] font-medium text-white backdrop-blur-sm transition-colors hover:bg-white/14"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-navy-950/60">
          <Mark size={18} bright={which === "2x2" ? 3 : 1} />
        </span>
        <span className="truncate">{current.short}</span>
        <IconChevronDown size={16} className={`shrink-0 text-white/70 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Scenario"
          className="absolute top-12 left-0 z-40 w-72 overflow-hidden rounded-[20px] bg-sheet p-1.5 shadow-card"
        >
          {OPTIONS.map((o) => (
            <li key={o.value} role="option" aria-selected={o.value === which}>
              <button
                type="button"
                data-demo={o.demo}
                onClick={() => {
                  setWhich(o.value);
                  setOpen(false);
                }}
                className="focus-ring flex min-h-11 w-full items-center justify-between gap-3 rounded-[14px] px-3 text-left text-[14px] text-ink hover:bg-tile"
              >
                <span>{o.label}</span>
                {o.value === which && <IconCheck size={18} className="text-cobalt-ink" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
