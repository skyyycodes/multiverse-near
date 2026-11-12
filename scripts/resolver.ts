// The reporter. Reads FRED for the past FOMC event and deployments/demo-outcomes.json for the demo
// grid events, proposes through report_outcome, and with --finalize closes each proposal once its
// dispute window is over. It signs with resolver.<root>'s function-call key, which can call only
// report_outcome and finalize on the contract (created by deploy.ts).
//
//   NEAR_NETWORK=sandbox|testnet pnpm resolver [--target fomc|team|all] [--finalize]
//                                              [--every <seconds>] [--outcomes <file>]
//
// --target defaults to fomc, the real-data event, so running it by accident never resolves the
// demo grid. --every repeats the pass on a fixed schedule.

import { join } from "node:path";
import { parseArgs } from "node:util";

import { waitForChainTime } from "./lib/chain.ts";
import { requireDeployments } from "./lib/deployments.ts";
import { NETWORK, REPO_ROOT, RPC_URL } from "./lib/near.ts";
import { Protocol } from "./lib/protocol.ts";
import { reporterDeps } from "./lib/reporter.ts";
import { parseTarget, resolveOnce, resolverEvents, type ResolverDeps } from "./lib/resolver.ts";

const { values: opts } = parseArgs({
  options: {
    target: { type: "string", default: "fomc" },
    finalize: { type: "boolean", default: false },
    every: { type: "string" },
    outcomes: { type: "string", default: join(REPO_ROOT, "deployments", "demo-outcomes.json") },
  },
});

async function pass(p: Protocol, deps: ResolverDeps): Promise<void> {
  const demo = await p.demoRecord();
  const events = resolverEvents(demo, parseTarget(opts.target));
  if (events.length === 0) {
    console.log("nothing to look after");
    return;
  }
  const run = await resolveOnce(events, deps, opts.finalize);
  if (!opts.finalize || run.proposed.length === 0) return;
  const last = Math.max(...run.proposed.map((r) => r.finalizableAt));
  await waitForChainTime(last, "the dispute window");
  for (const { eventId } of run.proposed) {
    const e = await p.event(eventId);
    if (e.proposal_open) await deps.finalize(eventId);
    else console.log(`  event ${eventId}: no longer open (disputed or resolved meanwhile), not finalizing`);
  }
}

async function main(): Promise<void> {
  const d = await requireDeployments();
  const p = new Protocol(d);
  console.log(`${NETWORK} via ${RPC_URL}; contract ${d.contractId}; reporter ${d.reporter}; target ${opts.target}`);
  const deps = reporterDeps(p, opts.outcomes);
  const every = opts.every === undefined ? 0 : Number(opts.every);
  if (!Number.isInteger(every) || every < 0) throw new Error("--every must be a whole number of seconds");
  for (;;) {
    await pass(p, deps);
    if (every === 0) return;
    await new Promise((resolve) => setTimeout(resolve, every * 1_000));
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
