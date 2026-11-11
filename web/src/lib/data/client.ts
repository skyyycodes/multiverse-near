import { ENV } from "../env";
import { createRpcSource } from "../near/rpc";
import type { ReadSource } from "./source";

let source: Promise<ReadSource> | undefined;

/**
 * The one read source for the session: the chain over JSON-RPC, or the design fixtures in a NEXT_PUBLIC_FIXTURES=1
 * build. The fixtures are imported only behind the literal flag, so a real build does not contain them.
 */
export function readSource(): Promise<ReadSource> {
  source ??=
    process.env.NEXT_PUBLIC_FIXTURES === "1"
      ? import("../fixtures/source").then((m) => m.createFixtureSource())
      : Promise.resolve(createRpcSource(ENV.rpcUrls));
  return source;
}

/** The Multiverse contract the app talks to (the fixtures answer for the testnet deploy's account ids). */
export const CONTRACT_ID = ENV.contractId;
