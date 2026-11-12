// Build-time settings. Next inlines NEXT_PUBLIC_* where they are read literally, so each one is named in full here.
// next.config.ts fills the network ones from deployments/<network>.json (scripts/network.mjs).

const TESTNET_FALLBACKS = ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"];

const network: "testnet" | "sandbox" = process.env.NEXT_PUBLIC_NETWORK === "sandbox" ? "sandbox" : "testnet";
const primaryRpc = process.env.NEXT_PUBLIC_RPC_URL || "https://test.rpc.fastnear.com";
const listedRpcs = (process.env.NEXT_PUBLIC_RPC_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const ENV = {
  /** Where the deployment lives: the public testnet or a local sandbox node. */
  network,
  /** NEAR Connect only knows mainnet and testnet; wallets always sign on testnet, the RPC decides where reads go. */
  walletNetwork: "testnet" as const,
  contractId: process.env.NEXT_PUBLIC_CONTRACT_ID || "app.multiverse-lending.testnet",
  wnearId: process.env.NEXT_PUBLIC_WNEAR_ID || "",
  usdcId: process.env.NEXT_PUBLIC_USDC_ID || "",
  /** Tried in order on transport errors. */
  rpcUrls: listedRpcs.length > 0 ? listedRpcs : network === "testnet" ? [primaryRpc, ...TESTNET_FALLBACKS] : [primaryRpc],
  explorer: process.env.NEXT_PUBLIC_EXPLORER || "",
  /** What the admin screen tells the operator to run to reset the demo (scripts/ owns the command). */
  resetCommand: process.env.NEXT_PUBLIC_RESET_COMMAND || "RUN_SALE=false pnpm -C scripts reset",
};

/** Design-data build. Code that loads the fixtures tests the variable literally so a real build drops it. */
export const FIXTURES = process.env.NEXT_PUBLIC_FIXTURES === "1";

export const txUrl = (hash: string): string | undefined => (ENV.explorer ? `${ENV.explorer}/txns/${hash}` : undefined);
export const accountUrl = (id: string): string | undefined => (ENV.explorer ? `${ENV.explorer}/address/${id}` : undefined);
