// The account's storage deposit with the contract (NEP-145). Every position, order and collateral entry it adds is
// paid from that deposit's free part; once that runs out the contract refuses the action (InsufficientStorage). An
// action that writes to the contract tops the deposit up first when the free part is this low (hooks/useTx.ts).
import type { StorageBalance } from "./types";
import { nearToYocto } from "./units";

/** Below this much free deposit, the next action adds TOP_UP first: a 64-order book or an 8-world split fits in it. */
export const STORAGE_FLOOR = nearToYocto("0.02");
/** What one top-up adds to the deposit. */
export const TOP_UP = nearToYocto("0.1");

/** A registered account whose free deposit is below the floor; an unregistered one registers instead. */
export const needsTopUp = (b: StorageBalance | null | undefined): boolean => Boolean(b) && BigInt(b!.available) < STORAGE_FLOOR;
