// The release check: run on a build's output before it is published. Exits 1 and lists every failure, else exits 0.
//
//   node scripts/check-release.mjs <outdir> <network> [--prelaunch]
//
// It fails unless
//   1. the bundle inlines deployments/<network>.json's contractId (and no other network's), and version.json names the
//      same network and contract;
//   2. no file holds the fixture sentinel or the fixture persona list (WI-6: no design data in a real bundle);
//   3. no HTML or JS says "In Multiverse", and "Multiverse Lending" appears only inside "formerly Multiverse Lending";
//   4. the demo-wallet bridge (`__nearDemo`) is present for staging, rehearsal and sandbox, and absent for testnet;
//   5. testnet serves outlayer/fred-guest.wasm with the sha256 pinned on chain by OutLayerConfig; staging serves
//      outlayer/nearusd-guest.wasm (the bytes committed in oracle/nearusd-guest/dist when that file exists);
//   6. --prelaunch requires the pre-launch build, and without it the pre-launch build fails.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOYMENTS, NETWORKS, readDeployment } from "./network.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURE_SENTINEL = "__IFVERSE_FIXTURES__";
/** The fixture personas as a literal list, however the bundler quotes it. */
const PERSONA_LIST = /["'`]alice["'`],\s*["'`]bob["'`],\s*["'`]ravi["'`]/;
const TEXT = new Set([".html", ".js", ".mjs", ".txt", ".json", ".css", ".rsc"]);
const PRELAUNCH_MARK = 'data-demo="prelaunch"';

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const count = (s, needle) => s.split(needle).length - 1;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** The OutLayerConfig sha256 the contract pins, read at final from the deployment's RPC; null when none is set. */
export async function onChainFredSha(deployment) {
  const res = await fetch(deployment.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "check-release",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: deployment.contractId, method_name: "get_outlayer_config", args_base64: "e30=" },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json();
  if (body.error || !body.result?.result) throw new Error(`get_outlayer_config on ${deployment.contractId}: ${JSON.stringify(body.error ?? body.result)}`);
  const config = JSON.parse(Buffer.from(body.result.result).toString("utf8"));
  return config ? config.wasm_sha256 : null;
}

/**
 * Every failure of the release check, as text; empty when the output may be published. `fredSha` stands in for the
 * on-chain read in tests.
 */
export async function checkRelease(outDir, network, { prelaunch = false, deploymentsDir = DEPLOYMENTS, fredSha = onChainFredSha } = {}) {
  const failures = [];
  const out = resolve(outDir);
  if (!existsSync(out)) return [`${out} does not exist; build first`];
  let deployment;
  try {
    deployment = readDeployment(network, deploymentsDir);
  } catch (e) {
    return [e.message];
  }

  const files = walk(out).map((p) => ({ path: relative(out, p), ext: extname(p) }));
  const text = files.filter((f) => TEXT.has(f.ext)).map((f) => ({ ...f, body: readFileSync(join(out, f.path), "utf8") }));
  const js = text.filter((f) => f.ext === ".js" || f.ext === ".mjs");
  const pages = text.filter((f) => f.ext !== ".json");
  const html = text.filter((f) => f.ext === ".html");

  // 1. contract and version.json
  const expected = deployment.contractId;
  if (!js.some((f) => f.body.includes(`"${expected}"`))) failures.push(`no JS file inlines the contract id ${expected} of deployments/${network}.json`);
  for (const other of NETWORKS) {
    if (other === network || !existsSync(join(deploymentsDir, `${other}.json`))) continue;
    const id = readDeployment(other, deploymentsDir).contractId;
    if (!id || id === expected) continue;
    const hit = js.find((f) => f.body.includes(`"${id}"`));
    if (hit) failures.push(`${hit.path} inlines ${other}'s contract id ${id}`);
  }
  const versionFile = join(out, "version.json");
  let version;
  if (!existsSync(versionFile)) failures.push("version.json is missing (scripts/write-version.mjs)");
  else {
    version = JSON.parse(readFileSync(versionFile, "utf8"));
    if (version.network !== network) failures.push(`version.json names network ${version.network}, not ${network}`);
    if (version.contract_id !== expected) failures.push(`version.json names contract ${version.contract_id}, not ${expected}`);
    for (const key of ["web_version", "git_sha", "built_at"]) if (!version[key]) failures.push(`version.json has no ${key}`);
  }

  // 2. no design data
  for (const f of text) {
    if (f.body.includes(FIXTURE_SENTINEL)) failures.push(`${f.path} holds the fixture sentinel ${FIXTURE_SENTINEL}`);
    if (PERSONA_LIST.test(f.body)) failures.push(`${f.path} holds the fixture persona list`);
  }

  // 3. brand
  for (const f of pages) {
    if (f.body.includes("In Multiverse")) failures.push(`${f.path} says "In Multiverse"`);
    const old = count(f.body, "Multiverse Lending");
    const allowed = count(f.body, "formerly Multiverse Lending");
    if (old > allowed) failures.push(`${f.path} says "Multiverse Lending" outside "formerly Multiverse Lending" (${old - allowed}x)`);
  }

  // 4. demo-wallet bridge
  const bridge = js.some((f) => f.body.includes("__nearDemo"));
  if (network === "testnet" && bridge) failures.push("the demo-wallet bridge (__nearDemo) is in a testnet build");
  if (network !== "testnet" && !bridge) failures.push(`the demo-wallet bridge (__nearDemo) is missing from the ${network} build`);

  // 5. OutLayer guests
  if (network === "testnet") {
    const fred = join(out, "outlayer", "fred-guest.wasm");
    if (!existsSync(fred)) failures.push("outlayer/fred-guest.wasm is missing (scripts/copy-guest.mjs)");
    else {
      const served = sha256(readFileSync(fred));
      let pinned;
      try {
        pinned = await fredSha(deployment);
      } catch (e) {
        failures.push(`could not read the on-chain OutLayerConfig: ${e.message}`);
      }
      if (pinned === null) failures.push(`${expected} has no OutLayerConfig to compare outlayer/fred-guest.wasm with`);
      else if (pinned !== undefined && pinned !== served) failures.push(`outlayer/fred-guest.wasm sha256 ${served} differs from the on-chain OutLayerConfig ${pinned}`);
    }
  }
  if (network === "staging") {
    const guest = join(out, "outlayer", "nearusd-guest.wasm");
    const committed = join(REPO, "oracle", "nearusd-guest", "dist", "nearusd-guest.wasm");
    if (!existsSync(guest)) failures.push("outlayer/nearusd-guest.wasm is missing (build oracle/nearusd-guest, then scripts/copy-guest.mjs)");
    else if (existsSync(committed) && sha256(readFileSync(guest)) !== sha256(readFileSync(committed))) {
      failures.push("outlayer/nearusd-guest.wasm differs from oracle/nearusd-guest/dist/nearusd-guest.wasm");
    }
  }

  // 6. pre-launch
  const flagged = version?.prelaunch === true;
  const marked = html.some((f) => f.body.includes(PRELAUNCH_MARK));
  if (prelaunch) {
    if (!flagged) failures.push("--prelaunch given, but version.json does not say prelaunch: true (build:staging:prelaunch)");
    if (!marked) failures.push("--prelaunch given, but no page shows the pre-launch notice");
  } else if (flagged || marked) {
    failures.push("this is the pre-launch build; check it with --prelaunch, or build the full app");
  }

  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const prelaunch = args.includes("--prelaunch");
  const [outDir, network] = args.filter((a) => !a.startsWith("--"));
  if (!outDir || !network) {
    console.error("usage: node scripts/check-release.mjs <outdir> <network> [--prelaunch]");
    process.exit(2);
  }
  const failures = await checkRelease(outDir, network, { prelaunch });
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log(`release check passed: ${outDir} for ${network}${prelaunch ? " (pre-launch)" : ""}`);
}
