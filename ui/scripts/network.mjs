// Build-time network settings from the deployment record the scripts package writes (deployments/<network>.json).
// next.config.ts calls networkEnv() on every dev start and build, so the same app runs against production testnet,
// the staging deployment, a local sandbox node or a sandbox holding production's imported state by switching
// NEXT_PUBLIC_NETWORK. A value already set in the environment wins over the file.
//
//   node scripts/network.mjs [testnet|staging|sandbox|rehearsal]     prints what the build would use
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UI = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEPLOYMENTS = join(UI, "..", "deployments");

export const NETWORKS = ["testnet", "staging", "sandbox", "rehearsal"];
/** Where each network's chain runs: staging is on the public testnet, rehearsal is a local sandbox node. */
export const CHAIN = { testnet: "testnet", staging: "testnet", sandbox: "sandbox", rehearsal: "sandbox" };
const HINT = {
  testnet: "run pnpm -C scripts accounts",
  staging: "run NEAR_NETWORK=staging pnpm -C scripts accounts --root ifverse-staging.testnet",
  sandbox: "start the local node first: pnpm -C scripts sandbox start",
  rehearsal: "import production state first: NEAR_NETWORK=rehearsal pnpm -C scripts rehearse import",
};
/** Only the local networks are ever reset; staging and production never are. */
const RESET = {
  sandbox: "NEAR_NETWORK=sandbox RUN_SALE=false pnpm -C scripts reset",
  rehearsal: "NEAR_NETWORK=rehearsal pnpm -C scripts rehearse import",
};

/** The contract state version this build speaks (the version gate compares it with `contract_version()`). */
export const STATE_VERSION = "2";

/** ui/package.json's version: the ui release this build is. */
export function webVersion() {
  return JSON.parse(readFileSync(join(UI, "package.json"), "utf8")).version;
}

/** `GIT_SHA` from the environment, else the checkout's short HEAD, else "dev" (no git, or not a checkout). */
export function gitSha(env = process.env, cwd = UI) {
  if (env.GIT_SHA) return env.GIT_SHA.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev";
  } catch {
    return "dev";
  }
}

/** deployments/<network>.json, or an error that says how to create it. */
export function readDeployment(network, dir = DEPLOYMENTS) {
  if (!NETWORKS.includes(network)) throw new Error(`NEXT_PUBLIC_NETWORK must be one of ${NETWORKS.join(", ")}, not "${network}"`);
  const file = join(dir, `${network}.json`);
  if (!existsSync(file)) throw new Error(`${file} is missing; ${HINT[network]}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export function networkEnv(network = process.env.NEXT_PUBLIC_NETWORK || "staging", env = process.env, dir = DEPLOYMENTS) {
  const d = readDeployment(network, dir);
  const pick = (key, value) => env[key] || value || "";
  const fixtures = env.NEXT_PUBLIC_FIXTURES === "1";
  // The design-data build shows the reset block as the sandbox would; real testnet and staging builds have none.
  const reset = RESET[network] ?? (fixtures ? RESET.sandbox : "");
  return {
    NEXT_PUBLIC_NETWORK: network,
    NEXT_PUBLIC_CHAIN: CHAIN[network],
    NEXT_PUBLIC_RPC_URL: pick("NEXT_PUBLIC_RPC_URL", d.rpcUrl),
    NEXT_PUBLIC_CONTRACT_ID: pick("NEXT_PUBLIC_CONTRACT_ID", d.contractId),
    NEXT_PUBLIC_WNEAR_ID: pick("NEXT_PUBLIC_WNEAR_ID", d.wnear),
    NEXT_PUBLIC_USDC_ID: pick("NEXT_PUBLIC_USDC_ID", d.usdc),
    NEXT_PUBLIC_EXPLORER: pick("NEXT_PUBLIC_EXPLORER", d.explorer),
    NEXT_PUBLIC_RPC_URLS: env.NEXT_PUBLIC_RPC_URLS || "",
    NEXT_PUBLIC_WEB_VERSION: webVersion(),
    NEXT_PUBLIC_GIT_SHA: gitSha(env),
    NEXT_PUBLIC_STATE_VERSION: STATE_VERSION,
    NEXT_PUBLIC_RESET_COMMAND: RESET[network] ? pick("NEXT_PUBLIC_RESET_COMMAND", reset) : reset,
    // Always set, so the build inlines them and drops the code they guard when they are off.
    NEXT_PUBLIC_FIXTURES: fixtures ? "1" : "0",
    NEXT_PUBLIC_DEMO_WALLET: env.NEXT_PUBLIC_DEMO_WALLET === "1" ? "1" : "0",
    NEXT_PUBLIC_PRELAUNCH: env.NEXT_PUBLIC_PRELAUNCH === "1" ? "1" : "0",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = networkEnv(process.argv[2]);
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
}
