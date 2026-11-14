// Build-time settings. Next inlines NEXT_PUBLIC_* where they are read literally, so each one is named in full here.
// next.config.ts fills them from deployments/<network>.json (scripts/network.mjs).

export type Network = "testnet" | "staging" | "sandbox" | "rehearsal";
export type Chain = "testnet" | "sandbox";

const NETWORKS: readonly Network[] = ["testnet", "staging", "sandbox", "rehearsal"];
// The browser reads testnet from dRPC first. FastNEAR's edge now and then answers a page's preflighted reads without
// CORS headers, which the browser logs as errors (the failover then recovers); its addresses stay as the fallbacks.
// The keeper and the scripts keep the deployment's own rpcUrl.
const TESTNET_FIRST = "https://near-testnet.drpc.org";
const TESTNET_FALLBACKS = ["https://rpc.testnet.fastnear.com"];

const network: Network = (NETWORKS as readonly string[]).includes(process.env.NEXT_PUBLIC_NETWORK ?? "")
  ? (process.env.NEXT_PUBLIC_NETWORK as Network)
  : "testnet";
/** Staging runs on the public testnet; rehearsal is a sandbox node with production's state imported. */
const chain: Chain = process.env.NEXT_PUBLIC_CHAIN === "sandbox" ? "sandbox" : "testnet";
const primaryRpc = process.env.NEXT_PUBLIC_RPC_URL || "https://test.rpc.fastnear.com";
const listedRpcs = (process.env.NEXT_PUBLIC_RPC_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const ENV = {
  /** Which deployment this build is for. */
  network,
  /** Where that deployment's chain runs. */
  chain,
  /** NEAR Connect only knows mainnet and testnet; wallets always sign on testnet, the RPC decides where reads go. */
  walletNetwork: "testnet" as const,
  contractId: process.env.NEXT_PUBLIC_CONTRACT_ID || "app.multiverse-near.testnet",
  wnearId: process.env.NEXT_PUBLIC_WNEAR_ID || "",
  usdcId: process.env.NEXT_PUBLIC_USDC_ID || "",
  /** Tried in order on transport errors. */
  rpcUrls: listedRpcs.length > 0 ? listedRpcs : chain === "testnet" ? [...new Set([TESTNET_FIRST, primaryRpc, ...TESTNET_FALLBACKS])] : [primaryRpc],
  explorer: process.env.NEXT_PUBLIC_EXPLORER || "",
  /** What the admin screen tells the operator to run to reset the demo; "" on staging and production (never reset). */
  resetCommand: process.env.NEXT_PUBLIC_RESET_COMMAND || "",
  /** web/package.json's version and the commit it was built from. */
  webVersion: process.env.NEXT_PUBLIC_WEB_VERSION || "dev",
  gitSha: process.env.NEXT_PUBLIC_GIT_SHA || "dev",
  /** The contract state version this build speaks. */
  stateVersion: Number(process.env.NEXT_PUBLIC_STATE_VERSION || "2"),
};

/** "testnet", "staging · testnet", "sandbox", "rehearsal · sandbox". */
export const networkLabel = (): string => (ENV.network === ENV.chain ? ENV.network : `${ENV.network} · ${ENV.chain}`);

/** Design-data build. Code that loads the fixtures tests the variable literally so a real build drops it. */
export const FIXTURES = process.env.NEXT_PUBLIC_FIXTURES === "1";

/** Pre-launch staging build: every route shows one notice and reads nothing (WI-11). */
export const PRELAUNCH = process.env.NEXT_PUBLIC_PRELAUNCH === "1";

export const txUrl = (hash: string): string | undefined => (ENV.explorer ? `${ENV.explorer}/txns/${hash}` : undefined);
export const accountUrl = (id: string): string | undefined => (ENV.explorer ? `${ENV.explorer}/address/${id}` : undefined);
