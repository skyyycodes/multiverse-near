// Every world keeps one hue everywhere it appears: cards, chips, bars, chart lines. A binary scenario uses the first
// two (SHIPS cyan, DELAYED violet). Eight worlds repeat the four hues, and worlds 4-7 (event C's second outcome) carry
// a diagonal hatch. Dead worlds lose their hue to slate.

const FOUR = ["#5EE6F0", "#8B7CFF", "#3D7BFF", "#C34BFF"] as const;
export const HUES = [...FOUR, ...FOUR] as const;
export const DEAD = "#5A6378";

export const hueOf = (index: number, alive = true): string => (alive ? (HUES[index] ?? HUES[((index % 4) + 4) % 4]) : DEAD);

/** Worlds 4-7 of an eight-world market: the same hue as world i - 4, told apart by a hatch. */
export const isHatched = (index: number): boolean => index >= 4;
export const HATCH = "repeating-linear-gradient(135deg, rgba(255,255,255,0.14) 0 2px, transparent 2px 7px)";

/** "DELAYED·HOLDS" → "D·H", "SHIPS·CUTS·YES" → "S·C·Y"; a one-outcome label keeps its first character ("SHIPS" → "S"). */
export function initials(label: string): string {
  const parts = label.split("·").filter(Boolean);
  if (parts.length > 1) return parts.map((p) => p[0]).join("·");
  return label.slice(0, 1);
}

/** "DELAYED·HOLDS" → "DELAYED · HOLDS" for display where there is room to breathe. */
export const spaced = (label: string) => label.split("·").join(" · ");

/** A translucent version of a hex colour, for tints and glows. */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
