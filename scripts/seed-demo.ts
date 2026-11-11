// Seeds the demo on the deployed contract and prints the report the video and the web app are
// checked against.
//
//   NEAR_NETWORK=sandbox|testnet pnpm seed [--spot-from 2x2|binary] [--no-ravi]
//
// Fed odds: ODDS_CUTS_BPS if set, else Polymarket, else 100 bps (the 2026-11-06 reading).
// ODDS_SHIPS_BPS defaults to 6667 (no Glamsterdam market exists).

import { parseArgs } from "node:util";

import { ODDS_SHIPS_BPS } from "./lib/demo.ts";
import { requireDeployments } from "./lib/deployments.ts";
import { NETWORK, RPC_URL } from "./lib/near.ts";
import { fedCutsOdds } from "./lib/polymarket.ts";
import { Protocol } from "./lib/protocol.ts";
import { printSeedReport, seedDemo } from "./lib/seed.ts";

const { values: opts } = parseArgs({
  options: {
    "spot-from": { type: "string", default: process.env.SPOT_FROM || "2x2" },
    "no-ravi": { type: "boolean", default: false },
  },
});

async function main(): Promise<void> {
  const spotFrom = opts["spot-from"];
  if (spotFrom !== "2x2" && spotFrom !== "binary") throw new Error("SPOT_FROM must be 2x2 or binary");
  const d = await requireDeployments();
  if (!d.contract) throw new Error(`no contract in deployments/${NETWORK}.json; run deploy.ts first`);
  console.log(`${NETWORK} via ${RPC_URL}; contract ${d.contractId}`);
  const odds = await fedCutsOdds();
  const p = new Protocol(d);
  const record = await seedDemo(p, {
    shipsBps: Number(process.env.ODDS_SHIPS_BPS || ODDS_SHIPS_BPS),
    cutsBps: odds.cutsBps,
    oddsSource: odds.source,
    spotFrom,
    withRavi: !opts["no-ravi"],
  });
  await printSeedReport(p, record);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
