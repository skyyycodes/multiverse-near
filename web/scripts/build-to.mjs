// Builds the app for one network into its own output directory, leaving the production build in out/ untouched.
// `next build` with a static export always writes out/, so without this a fixtures or demo build run after `pnpm build`
// would replace the production output (the web gate builds all three, then serves each).
//
//   node scripts/build-to.mjs <outdir> <network> [--guests] [KEY=VALUE ...]
//
// --guests copies the OutLayer guests first (scripts/copy-guest.mjs). KEY=VALUE pairs are set for the build, on top of
// the environment. The output gets its version.json (scripts/write-version.mjs).
import { spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyGuests } from "./copy-guest.mjs";
import { versionRecord } from "./write-version.mjs";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const [outDir, network] = args.filter((a) => !a.startsWith("--") && !a.includes("="));
if (!outDir || !network || outDir === "out") {
  console.error("usage: node scripts/build-to.mjs <outdir other than out> <network> [--guests] [KEY=VALUE ...]");
  process.exit(2);
}
const env = { ...process.env, NEXT_PUBLIC_NETWORK: network };
for (const pair of args.filter((a) => a.includes("=") && !a.startsWith("--"))) {
  const i = pair.indexOf("=");
  env[pair.slice(0, i)] = pair.slice(i + 1);
}
if (args.includes("--guests")) copyGuests();

const out = join(WEB, "out");
const target = join(WEB, outDir);
const kept = join(WEB, `.out-kept-${process.pid}`);
if (existsSync(out)) renameSync(out, kept);
let status = 1;
try {
  const r = spawnSync(join(WEB, "node_modules", ".bin", "next"), ["build"], { cwd: WEB, env, stdio: "inherit" });
  status = r.status ?? 1;
  if (status === 0) {
    rmSync(target, { recursive: true, force: true });
    renameSync(out, target);
    const record = versionRecord(network, env);
    writeFileSync(join(target, "version.json"), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`${join(target, "version.json")}: ${JSON.stringify(record)}`);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
  if (existsSync(kept)) renameSync(kept, out);
}
process.exit(status);
