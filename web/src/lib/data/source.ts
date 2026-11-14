import type { TxOutcome } from "../near/outcome";

/** Where screens read from: the chain over JSON-RPC, or the design fixtures. */
export interface ReadSource {
  view<T>(contractId: string, method: string, args?: Record<string, unknown>): Promise<T>;
  /** The final outcome of a transaction, for wallets that answer with less than the full receipt list. */
  txStatus(hash: string, accountId: string): Promise<TxOutcome>;
  /** RPC `view_account` at final: the code hash (About dialog) and the free balance (the TxButton gas float). */
  account(accountId: string): Promise<AccountInfo>;
}

/** `amount` in yoctoNEAR; `codeHash` base58 ("11111111111111111111111111111111" for an account without code). */
export type AccountInfo = { codeHash: string; amount: string; storageUsage: number };
