// Alice's sell-and-borrow on the seeded demo, then her per-world holdings, the worst world and HF.
// Waits for a full TWAP window after seeding first (on the sandbox it skips blocks instead).
//
//   NEAR_NETWORK=sandbox|testnet pnpm demo-sale [--report-only]

import { parseArgs } from "node:util";

import { requireDeployments } from "./lib/deployments.ts";
import { NETWORK, RPC_URL } from "./lib/near.ts";
import { Protocol } from "./lib/protocol.ts";
import { printSaleReport, sellAndBorrow, waitForTwap } from "./lib/sale.ts";

const { values: opts } = parseArgs({ options: { "report-only": { type: "boolean", default: false } } });

async function main(): Promise<void> {
  const d = await requireDeployments();
  const p = new Protocol(d);
  console.log(`${NETWORK} via ${RPC_URL}; contract ${d.contractId}`);
  const record = await p.demoRecord();
  if (!opts["report-only"]) {
    await waitForTwap(p, record);
    await sellAndBorrow(p, record);
  }
  await printSaleReport(p, record);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
