import { ENV } from "../env";
import { createRpcSource } from "../near/rpc";
import type { ReadSource } from "./source";

let source: Promise<ReadSource> | undefined;

/** The one read source for the session: the chain over JSON-RPC, with failover across ENV.rpcUrls. */
export function readSource(): Promise<ReadSource> {
  source ??= Promise.resolve(createRpcSource(ENV.rpcUrls));
  return source;
}

/** The Origami Verse contract the app talks to. */
export const CONTRACT_ID = ENV.contractId;
