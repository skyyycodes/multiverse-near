import { useId } from "react";

/**
 * The background motif: thin luminous lines that leave one point, split in two, then in four (one future becoming
 * several). Purely decorative and very low contrast.
 */
export function BranchLines({ className = "", opacity = 0.14 }: { className?: string; opacity?: number }) {
  const id = `bl${useId().replace(/:/g, "")}`;
  return (
    <svg
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
      viewBox="0 0 800 500"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.25" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      <g fill="none" stroke={`url(#${id})`} strokeWidth="1" opacity={opacity} strokeLinecap="round">
        <path d="M-20 250 H240" />
        <path d="M240 250 C330 250 350 150 450 150" />
        <path d="M240 250 C330 250 350 350 450 350" />
        <path d="M450 150 C540 150 560 80 820 70" />
        <path d="M450 150 C540 150 560 220 820 230" />
        <path d="M450 350 C540 350 560 280 820 270" />
        <path d="M450 350 C540 350 560 420 820 430" />
        <path d="M120 250 C200 250 230 40 420 20" opacity="0.5" />
        <path d="M120 250 C200 250 230 460 420 480" opacity="0.5" />
      </g>
    </svg>
  );
}
