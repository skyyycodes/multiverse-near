// Writes <outdir>/version.json after a build: what this web release is, which commit, which deployment it reads.
// Open tabs poll it (UpdateBanner) and check-release.mjs reads it.
//
//   node scripts/write-version.mjs <outdir> [network]      network defaults to NEXT_PUBLIC_NETWORK, else testnet
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitSha, networkEnv, webVersion } from "./network.mjs";

export function versionRecord(network, env = process.env, now = new Date()) {
  const e = networkEnv(network, env);
  return {
    web_version: webVersion(),
    git_sha: gitSha(env),
    network,
    contract_id: e.NEXT_PUBLIC_CONTRACT_ID,
    prelaunch: env.NEXT_PUBLIC_PRELAUNCH === "1",
    built_at: now.toISOString(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, network = process.env.NEXT_PUBLIC_NETWORK || "testnet"] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: node scripts/write-version.mjs <outdir> [network]");
    process.exit(2);
  }
  const out = resolve(dir);
  if (!existsSync(out)) {
    console.error(`${out} does not exist; build first`);
    process.exit(2);
  }
  const record = versionRecord(network);
  writeFileSync(join(out, "version.json"), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${join(out, "version.json")}: ${JSON.stringify(record)}`);
}
