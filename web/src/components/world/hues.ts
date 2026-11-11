// Every world keeps one hue everywhere it appears: cards, chips, bars, chart lines. A binary scenario uses the first
// two (SHIPS cyan, DELAYED violet). Dead worlds lose their hue to slate.

export const HUES = ["#5EE6F0", "#8B7CFF", "#3D7BFF", "#C34BFF"] as const;
export const DEAD = "#5A6378";

export const hueOf = (index: number, alive = true): string => (alive ? (HUES[index] ?? HUES[0]) : DEAD);

/** "DELAYED·HOLDS" → "D·H", "SHIPS" → "S"; anything else keeps its first two characters. */
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
