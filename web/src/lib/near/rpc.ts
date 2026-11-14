import type { AccountInfo, ReadSource } from "../data/source";
import type { TxOutcome } from "./outcome";
import { cleanError } from "./outcome";

/** The RPC could not be reached or did not answer properly: worth asking the next one. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

/** The chain answered, and the answer is an error (no such account, a view that panicked). Every node says the same. */
export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainError";
  }
}

export const isTransportError = (e: unknown): boolean => e instanceof TransportError;

/** Node-side trouble that another node (or a moment later) may not have; everything else is the chain's answer. */
const NODE_TROUBLE = new Set(["INTERNAL_ERROR", "TIMEOUT_ERROR", "NO_SYNCED_BLOCKS", "NOT_SYNCED_YET", "UNAVAILABLE_SHARD", "UNKNOWN_BLOCK"]);

type RpcErrorBody = { name?: string; cause?: { name?: string; info?: Record<string, unknown> }; message?: string; data?: unknown };

function describe(e: RpcErrorBody): string {
  const info = e.cause?.info ?? {};
  const vm = info.vm_error ?? info.error_message;
  if (typeof vm === "string") return cleanError(vm);
  if (e.cause?.name === "UNKNOWN_ACCOUNT") return `Account ${String(info.requested_account_id ?? "")} does not exist`;
  if (e.cause?.name === "NO_CONTRACT_CODE") return `Contract code for ${String(info.contract_account_id ?? "")} does not exist`;
  if (typeof e.data === "string") return cleanError(e.data);
  return cleanError(e.cause?.name ?? e.message ?? JSON.stringify(e));
}

const TIMEOUT_MS = 10_000;

async function rpc<T>(url: string, method: string, params: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "mv", method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new TransportError(`${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new TransportError(`${url} answered HTTP ${res.status}`);
  let body: { result?: T; error?: RpcErrorBody };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new TransportError(`${url} did not answer with JSON`);
  }
  if (body.error) {
    const name = body.error.cause?.name ?? body.error.name ?? "";
    if (NODE_TROUBLE.has(name)) throw new TransportError(`${url}: ${name}`);
    throw new ChainError(describe(body.error));
  }
  if (body.result === undefined) throw new TransportError(`${url} answered without a result`);
  return body.result;
}

const toBase64 = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** View calls at optimistic finality (what a wallet just changed shows up on the next poll), across several RPCs. */
export function createRpcSource(urls: string[]): ReadSource {
  let preferred = 0;

  async function each<T>(run: (url: string) => Promise<T>): Promise<T> {
    let last: unknown;
    for (let k = 0; k < urls.length; k++) {
      const i = (preferred + k) % urls.length;
      try {
        const r = await run(urls[i]);
        preferred = i;
        return r;
      } catch (e) {
        if (!isTransportError(e)) throw e;
        last = e;
      }
    }
    throw new TransportError(`No RPC answered: ${last instanceof Error ? last.message : String(last)}`);
  }

  return {
    async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
      const r = await each((url) =>
        rpc<{ result?: number[]; error?: string }>(url, "query", {
          request_type: "call_function",
          finality: "optimistic",
          account_id: contractId,
          method_name: method,
          args_base64: toBase64(JSON.stringify(args)),
        }),
      );
      // Older nodes put a contract's panic inside the result instead of the error.
      if (typeof r.error === "string") throw new ChainError(cleanError(r.error));
      const bytes = r.result ?? [];
      if (bytes.length === 0) return null as T;
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as T;
    },
    async txStatus(hash: string, accountId: string): Promise<TxOutcome> {
      return each((url) => rpc<TxOutcome>(url, "tx", { tx_hash: hash, sender_account_id: accountId, wait_until: "FINAL" }));
    },
    async account(accountId: string): Promise<AccountInfo> {
      const r = await each((url) =>
        rpc<{ amount?: string; code_hash?: string; storage_usage?: number }>(url, "query", { request_type: "view_account", finality: "final", account_id: accountId }),
      );
      if (typeof r.amount !== "string" || typeof r.code_hash !== "string" || typeof r.storage_usage !== "number") {
        throw new ChainError(`view_account ${accountId}: unexpected answer`);
      }
      return { codeHash: r.code_hash, amount: r.amount, storageUsage: r.storage_usage };
    },
  };
}
