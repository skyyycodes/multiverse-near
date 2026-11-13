import { useId } from "react";
import { HUES } from "@/components/world/hues";
import { BRAND } from "@/lib/brand";

/**
 * The mark: a circle cut into four quarters by a thin plus-shaped gap. The quarters sit where their worlds sit on the
 * grid (rows SHIPS/DELAYED, columns CUTS/HOLDS), each in its world's hue. `bright` lifts one quarter: the future you
 * are looking at.
 */
export function Mark({ size = 28, bright, className }: { size?: number; bright?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  // Quadrant rectangles in grid order: world = a + 2b, a = row, b = column.
  const quads = [
    { w: 0, x: 0, y: 0 },
    { w: 1, x: 0, y: 16 },
    { w: 2, x: 16, y: 0 },
    { w: 3, x: 16, y: 16 },
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <clipPath id={`c${id}`}>
          <circle cx="16" cy="16" r="15.5" />
        </clipPath>
        <mask id={`m${id}`}>
          <rect width="32" height="32" fill="#fff" />
          <rect x="15.05" y="0" width="1.9" height="32" fill="#000" />
          <rect x="0" y="15.05" width="32" height="1.9" fill="#000" />
        </mask>
      </defs>
      <g clipPath={`url(#c${id})`} mask={`url(#m${id})`}>
        {quads.map((q) => (
          <rect
            key={q.w}
            x={q.x}
            y={q.y}
            width="16"
            height="16"
            fill={HUES[q.w]}
            opacity={bright === undefined || bright === q.w ? 1 : 0.5}
          />
        ))}
      </g>
    </svg>
  );
}

export function Wordmark({ tone = "light", className = "" }: { tone?: "light" | "dark"; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <Mark size={26} bright={0} />
      <span
        className={`font-display text-[19px] font-medium tracking-[-0.01em] ${tone === "light" ? "text-white" : "text-ink"}`}
      >
        {BRAND.name}
      </span>
    </span>
  );
}
