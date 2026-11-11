// Resets the demo for a new take: fresh events and scenarios (ids keep growing), every pool seeded
// again, the existing spot pool moved to the new implied spot, Bob's supply, Ravi's bid, Alice's
// wallet and the on-chain record; then, unless --no-sale, Alice's sale once the pools are old
// enough to price lending. The old scenarios stay on chain untouched.
//
//   NEAR_NETWORK=sandbox|testnet pnpm reset [--spot-from 2x2|binary] [--no-sale] [--no-ravi]

import { parseArgs } from "node:util";

import { ODDS_SHIPS_BPS } from "./lib/demo.ts";
import { requireDeployments } from "./lib/deployments.ts";
import { NETWORK, RPC_URL } from "./lib/near.ts";
import { fedCutsOdds } from "./lib/polymarket.ts";
import { Protocol } from "./lib/protocol.ts";
import { printSaleReport, sellAndBorrow, waitForTwap } from "./lib/sale.ts";
import { printSeedReport, seedDemo } from "./lib/seed.ts";

const { values: opts } = parseArgs({
  options: {
    "spot-from": { type: "string", default: process.env.SPOT_FROM || "2x2" },
    "no-sale": { type: "boolean", default: process.env.RUN_SALE === "false" },
    "no-ravi": { type: "boolean", default: false },
  },
});

async function main(): Promise<void> {
  const spotFrom = opts["spot-from"];
  if (spotFrom !== "2x2" && spotFrom !== "binary") throw new Error("SPOT_FROM must be 2x2 or binary");
  const d = await requireDeployments();
  if (!d.contract) throw new Error(`no contract in deployments/${NETWORK}.json; run deploy.ts first`);
  const p = new Protocol(d);
  console.log(`${NETWORK} via ${RPC_URL}; contract ${d.contractId}`);
  const previous = (await p.appConfig()).demo;
  if (previous) console.log(`previous demo: scenarios ${previous.scenario_2x2} and ${previous.scenario_binary}`);
  const odds = await fedCutsOdds();
  const record = await seedDemo(p, {
    shipsBps: Number(process.env.ODDS_SHIPS_BPS || ODDS_SHIPS_BPS),
    cutsBps: odds.cutsBps,
    oddsSource: odds.source,
    spotFrom,
    withRavi: !opts["no-ravi"],
  });
  await printSeedReport(p, record);
  if (opts["no-sale"]) return;
  await waitForTwap(p, record);
  await sellAndBorrow(p, record);
  await printSaleReport(p, record);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
