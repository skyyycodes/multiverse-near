// What merges back from a position: split.ts's `mergeMax` over the pieces the account holds outside lending (collateral
// posted in a tier does not merge until it is taken back).
import type { WorldHolding } from "./adapter-model";
import { mergeMax } from "./split";
import type { Asset } from "./types";

/** The largest full set of `asset` in `worlds` (one piece per world still possible); 0 when one world holds none. */
export function mergeable(worlds: readonly Pick<WorldHolding, "index" | "walletNearWad" | "walletUsdcWad">[] | undefined, possible: number, asset: Asset): bigint {
  if (!worlds) return 0n;
  return mergeMax(worlds.map((w) => ({ mask: 1 << w.index, userWnear: w.walletNearWad, userUsdc: w.walletUsdcWad })), possible, asset);
}
