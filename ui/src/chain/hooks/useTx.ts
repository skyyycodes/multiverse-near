"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { BRAND } from "../brand";
import { CONTRACT_ID, readSource } from "../data/client";
import type { AppConfig } from "../domain";
import { assertSuccess, type TxOutcome } from "../near/outcome";
import { storageDeposit, type Tx } from "../near/tx";
import { useWallet } from "../near/wallet";
import type { Asset, StorageBalance, StorageBounds } from "../types";
import { TOP_UP, needsTopUp } from "../storage-floor";
import { fmtYocto, nearToYocto } from "../units";

/** What an action needs before it can run: a NEP-145 balance on Multiverse, and accounts on the payout tokens. */
export type Needs = { contract?: boolean; tokens?: Asset[] };

/** Never register with less than this on Multiverse: positions, orders and collateral lists all take storage. */
const MIN_CONTRACT_DEPOSIT = nearToYocto("0.1");

export type Step = (label: string) => void;

/** The first NEP-145 deposit on Multiverse: the contract's minimum, and never less than 0.1 NEAR. */
export function registerTx(bounds: StorageBounds): Tx {
  const min = BigInt(bounds.min);
  return storageDeposit(CONTRACT_ID, min > MIN_CONTRACT_DEPOSIT ? min : MIN_CONTRACT_DEPOSIT, false);
}

/**
 * Sends one transaction and checks it did what was asked (see assertSuccess), then refreshes every query. Returns
 * the transaction hash.
 */
export function useSubmit() {
  const wallet = useWallet();
  const qc = useQueryClient();
  return useCallback(
    async (tx: Tx, expectUsed?: bigint | "nonzero", onOutcome?: (o: TxOutcome) => void): Promise<string> => {
      const outcome = await wallet.send(tx);
      // A transfer call always has to be checked for a refund, even where the caller did not say how much.
      const isTransferCall = tx.actions.some((a) => a.params.methodName === "ft_transfer_call");
      const hash = assertSuccess(outcome, { expectUsed: expectUsed ?? (isTransferCall ? "nonzero" : undefined), contractId: CONTRACT_ID });
      onOutcome?.(outcome);
      void qc.invalidateQueries();
      return hash;
    },
    [wallet, qc],
  );
}

/**
 * Runs the one-time storage registrations an action needs, each as its own transaction, before the action itself:
 * Multiverse charges every stored position to the account's NEP-145 balance, and a payout to an account without a
 * token balance record would fail (the contract then credits it to the internal balance instead).
 */
export function useEnsureRegistered(config: AppConfig | undefined) {
  const wallet = useWallet();
  const submit = useSubmit();
  return useCallback(
    async (needs: Needs | undefined, step: Step, cfg: AppConfig | undefined = config) => {
      const account = wallet.accountId;
      const config = cfg;
      if (!needs || !account || !config) return;
      const src = await readSource();
      if (needs.contract) {
        const bal = await src.view<StorageBalance | null>(CONTRACT_ID, "storage_balance_of", { account_id: account });
        if (!bal) {
          const bounds = await src.view<StorageBounds>(CONTRACT_ID, "storage_balance_bounds");
          step(`Registering with ${BRAND.name}…`);
          await submit(registerTx(bounds));
        } else if (needsTopUp(bal)) {
          // the free part of the storage deposit is nearly gone: the action itself would fail InsufficientStorage
          step(`Adding ${fmtYocto(TOP_UP)} NEAR to your ${BRAND.name} storage…`);
          await submit(topUpTx());
        }
      }
      for (const asset of needs.tokens ?? []) {
        const token = asset === "wnear" ? config.wnear : config.usdc;
        const bal = await src.view<StorageBalance | null>(token.tokenId, "storage_balance_of", { account_id: account });
        if (!bal) {
          const bounds = await src.view<StorageBounds>(token.tokenId, "storage_balance_bounds");
          step(`Registering on ${token.symbol}…`);
          await submit(storageDeposit(token.tokenId, BigInt(bounds.min), true));
        }
      }
    },
    [wallet.accountId, config, submit],
  );
}

/** Top up the Multiverse storage balance (low before an action, or after an InsufficientStorage refusal). */
export { TOP_UP };
export const topUpTx = () => storageDeposit(CONTRACT_ID, TOP_UP, false);
