// Split and merge (web 6.4, T44, T45): one real token becomes one token in every possible world, and a full set of
// single-world tokens merges back into the real token. The contract checks the partition; these mirror it.
import type { Asset } from "./types";

/** The single-world masks of `possible`, lowest world first (the contract's `single_worlds`). */
export function singleWorldMasks(possible: number): number[] {
  const out: number[] = [];
  for (let w = 0; w < 8; w++) if ((possible >> w) & 1) out.push(1 << w);
  return out;
}

/** The root mask of a market of `worldCount` worlds. */
export const rootMask = (worldCount: number): number => (1 << worldCount) - 1;

/** The most that merges back: the smallest single-world balance over the possible worlds (0 when one is missing). */
export function mergeMax(worlds: readonly { mask: number; userWnear: bigint; userUsdc: bigint }[], possible: number, asset: Asset): bigint {
  const masks = singleWorldMasks(possible);
  if (masks.length === 0) return 0n;
  let min: bigint | undefined;
  for (const m of masks) {
    const w = worlds.find((x) => x.mask === m);
    const bal = w ? (asset === "wnear" ? w.userWnear : w.userUsdc) : 0n;
    if (min === undefined || bal < min) min = bal;
  }
  return min ?? 0n;
}

/** Split and merge need two possible worlds at least: with one left, Close and redeem pays out. */
export const canSplit = (possible: number): boolean => singleWorldMasks(possible).length >= 2;
