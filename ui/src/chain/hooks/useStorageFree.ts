"use client";

import { useWallet } from "../near/wallet";
import { useAppConfig, useRegistration } from "./useData";

/**
 * The free part of the connected account's storage balance on the contract (yocto), undefined until read or when it
 * is not registered (registering puts 0.1 NEAR there, which is plenty).
 */
export function useStorageFree(): bigint | undefined {
  const { accountId } = useWallet();
  const cfg = useAppConfig().data;
  const reg = useRegistration(accountId, cfg?.wnear, cfg?.usdc).data;
  return reg?.contract ? BigInt(reg.contract.available) : undefined;
}
