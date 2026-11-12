// Build-time network settings from the deployment record the scripts package writes (deployments/<network>.json).
// next.config.ts calls networkEnv() on every dev start and build, so the same app runs against the local sandbox node
// or testnet by switching NEXT_PUBLIC_NETWORK. A value already set in the environment wins over the file.
//
//   node scripts/network.mjs [testnet|sandbox]     prints what the build would use
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEPLOYMENTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deployments");
const NETWORKS = ["testnet", "sandbox"];

export function networkEnv(network = process.env.NEXT_PUBLIC_NETWORK || "testnet", env = process.env) {
  if (!NETWORKS.includes(network)) throw new Error(`NEXT_PUBLIC_NETWORK must be one of ${NETWORKS.join(", ")}, not "${network}"`);
  const file = join(DEPLOYMENTS, `${network}.json`);
  if (!existsSync(file)) {
    const hint = network === "sandbox" ? "start the local node first: pnpm -C scripts sandbox start" : "run pnpm -C scripts accounts";
    throw new Error(`${file} is missing; ${hint}`);
  }
  const d = JSON.parse(readFileSync(file, "utf8"));
  const pick = (key, value) => env[key] || value || "";
  return {
    NEXT_PUBLIC_NETWORK: network,
    NEXT_PUBLIC_RPC_URL: pick("NEXT_PUBLIC_RPC_URL", d.rpcUrl),
    NEXT_PUBLIC_CONTRACT_ID: pick("NEXT_PUBLIC_CONTRACT_ID", d.contractId),
    NEXT_PUBLIC_WNEAR_ID: pick("NEXT_PUBLIC_WNEAR_ID", d.wnear),
    NEXT_PUBLIC_USDC_ID: pick("NEXT_PUBLIC_USDC_ID", d.usdc),
    NEXT_PUBLIC_EXPLORER: pick("NEXT_PUBLIC_EXPLORER", d.explorer),
    NEXT_PUBLIC_RPC_URLS: env.NEXT_PUBLIC_RPC_URLS || "",
    // Always set, so the build inlines them and drops the code they guard when they are off.
    NEXT_PUBLIC_FIXTURES: env.NEXT_PUBLIC_FIXTURES === "1" ? "1" : "0",
    NEXT_PUBLIC_DEMO_WALLET: env.NEXT_PUBLIC_DEMO_WALLET === "1" ? "1" : "0",
    NEXT_PUBLIC_RESET_COMMAND: pick("NEXT_PUBLIC_RESET_COMMAND", "RUN_SALE=false pnpm -C scripts reset"),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = networkEnv(process.argv[2]);
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
}
