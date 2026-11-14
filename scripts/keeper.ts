// Runs keeper rounds from a laptop: the same round the Vercel function runs (lib/keeper.ts).
//
//   NEAR_NETWORK=staging pnpm -C scripts keeper [--dry-run] [--every <s>] [--deployments <file>]
//                                               [--no-reference] [--no-liquidations] [--no-maker]
//
// Account ids come from deployments/<network>.json (or --deployments): the contract, the USDC and
// wNEAR tokens, `ops.keeper` (default keeper.<root>), `ops.maker` (default maker.<root>) and the
// reporter. Keys come from KEEPER_KEY, REPORTER_KEY and MAKER_KEY when set, else from the key files:
// <keeper>.json, <maker>.json and <reporter>.reference.json (or <reporter>.json) in NEAR_KEYS_DIR /
// .keys/<network>/. MAKER_THRESHOLD_BPS overrides the maker's band (400). Prints each round's JSON summary.

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { requireDeployments } from "./lib/deployments.ts";
import { configFromEnv, rpcChain, rpcPoolFor, runRound, summaryJson, type KeeperTargets } from "./lib/keeper.ts";
import { findKeyFile, NETWORK, NETWORK_CONFIG, NETWORK_EXPLICIT, type KeyFile } from "./lib/near.ts";
import { endpointsFromEnv } from "./lib/rpc.ts";

const { values: opts } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    every: { type: "string" },
    deployments: { type: "string" },
    "no-reference": { type: "boolean", default: false },
    "no-liquidations": { type: "boolean", default: false },
    "no-maker": { type: "boolean", default: false },
  },
});

if (!NETWORK_EXPLICIT) {
  console.error("set NEAR_NETWORK (staging, sandbox, ...): the keeper sends transactions");
  process.exit(2);
}

async function secretOf(accountId: string, variants: (string | undefined)[]): Promise<string | undefined> {
  for (const v of variants) {
    const path = findKeyFile(accountId, v);
    if (!path) continue;
    const file = JSON.parse(await readFile(path, "utf8")) as Partial<KeyFile> & { secret_key?: string };
    const secret = file.private_key ?? file.secret_key;
    if (secret) {
      console.error(`key for ${accountId}: ${path}`);
      return secret;
    }
  }
  return undefined;
}

const d = await requireDeployments(opts.deployments);
const targets: KeeperTargets = {
  contractId: d.contractId,
  usdcId: d.usdc,
  wnearId: d.wnear,
  keeperId: d.ops?.keeper ?? `keeper.${d.root}`,
  reporterId: d.reporter,
  makerId: d.ops?.maker ?? `maker.${d.root}`,
  rpcUrls: endpointsFromEnv(NETWORK_CONFIG).map((e) => e.url),
};
const env: NodeJS.ProcessEnv = { ...process.env };
if (!opts["no-liquidations"]) env.KEEPER_KEY ||= await secretOf(targets.keeperId, [undefined]);
else delete env.KEEPER_KEY;
if (!opts["no-reference"]) env.REPORTER_KEY ||= await secretOf(targets.reporterId, ["reference", undefined]);
else delete env.REPORTER_KEY;
if (!opts["no-maker"]) env.MAKER_KEY ||= await secretOf(targets.makerId as string, [undefined]);
else delete env.MAKER_KEY;
if (opts["dry-run"]) env.KEEPER_DRY_RUN = "1";

const cfg = configFromEnv(env, targets);
console.error(
  `keeper on ${NETWORK}: contract ${cfg.contractId}, keeper ${cfg.keeper?.accountId ?? "(no key)"}, reporter ${cfg.reporter?.accountId ?? "(no key)"}, maker ${cfg.maker?.accountId ?? "(no key)"}${cfg.dryRun ? ", dry run" : ""}`,
);
const pool = rpcPoolFor(cfg.rpcUrls);
const every = opts.every ? Number(opts.every) : 0;
for (;;) {
  const started = Date.now();
  const summary = await runRound(cfg, { chain: rpcChain(pool, () => started + cfg.budgetMs) });
  console.log(summaryJson(summary));
  if (!(every > 0)) process.exit(summary.ok ? 0 : 1);
  await new Promise((r) => setTimeout(r, Math.max(1_000, every * 1000 - (Date.now() - started))));
}
