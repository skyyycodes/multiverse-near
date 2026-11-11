import type { TxOutcome } from "../near/outcome";

/** Where screens read from: the chain over JSON-RPC, or the design fixtures. */
export interface ReadSource {
  view<T>(contractId: string, method: string, args?: Record<string, unknown>): Promise<T>;
  /** The final outcome of a transaction, for wallets that answer with less than the full receipt list. */
  txStatus(hash: string, accountId: string): Promise<TxOutcome>;
}
