// The version gate's rule (W-D6, WI-2): this build speaks one contract state version. An older contract gets the
// upgrade notice and no screen (so nothing v2-only is ever sent to it); a newer one gets the app and a reload banner.
import type { ContractVersion } from "./domain";

export type VersionCheck = "old" | "ok" | "newer";

export function checkVersion(v: Pick<ContractVersion, "stateVersion">, expected: number): VersionCheck {
  if (v.stateVersion < expected) return "old";
  if (v.stateVersion > expected) return "newer";
  return "ok";
}

/** A view that does not exist on the contract: `contract_version` on a v1 contract. */
export const isMethodNotFound = (message: string): boolean => /MethodNotFound|MethodResolveError/.test(message);
