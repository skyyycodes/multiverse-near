// One real transaction for each flow of the app on the staging contract, on the anchor market
// (`spice-fed`), each with its hash, and the smoke positions closed again afterwards so the seeded
// go-live state is what remains. Proposals (Kind A + approve, Kind B + pledges) are covered by the
// seeding itself (deployments/staging.seed.json).
//
//   NEAR_NETWORK=staging pnpm -C scripts smoke:staging [--only <name>] [--out <file.json>]
//
// Signers: sam (faucet, split, trades, the order book, supply and withdraw in every tier), uma
// (borrow and repay in every tier), the root (pause and unpause one flag).

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { chainNowSec } from "./lib/chain.ts";
import { requireDeployments } from "./lib/deployments.ts";
import { call, DEFAULT_RPC_URL, NETWORK, REPO_ROOT, view, type TxResult } from "./lib/near.ts";
import type { Tier } from "./lib/msgs.ts";
import { Protocol } from "./lib/protocol.ts";
import { fetchNearUsd, wadText } from "./lib/spot.ts";
import { u128, WAD } from "./lib/units.ts";

const { values: opts } = parseArgs({
  options: {
    only: { type: "string" },
    out: { type: "string", default: join(REPO_ROOT, "logs", "staging", `smoke-${new Date().toISOString().replace(/[:.]/g, "")}.json`) },
    sid: { type: "string" },
  },
});

const e18 = (n: bigint): bigint => n * WAD;
const TIERS: Tier[] = ["safe", "normal", "bold"];

interface Result {
  flow: string;
  ok: boolean;
  txs: string[];
  note?: string;
  error?: string;
}

const results: Result[] = [];

async function flow(name: string, fn: (txs: string[]) => Promise<string | void>): Promise<void> {
  if (opts.only && !name.startsWith(opts.only)) return;
  const txs: string[] = [];
  try {
    const note = await fn(txs);
    results.push({ flow: name, ok: true, txs, ...(note ? { note } : {}) });
    console.log(`PASS ${name}${note ? `: ${note}` : ""}`);
  } catch (err) {
    const error = err instanceof Error ? err.message.split("\n")[0] : String(err);
    results.push({ flow: name, ok: false, txs, error });
    console.log(`FAIL ${name}: ${error}`);
  }
}

const h = (txs: string[], r: TxResult): TxResult => {
  txs.push(r.hash);
  return r;
};

async function main(): Promise<void> {
  if (NETWORK !== "staging") throw new Error("NEAR_NETWORK must be staging");
  const d = await requireDeployments();
  const p = new Protocol(d);
  const journal = JSON.parse(await (await import("node:fs/promises")).readFile(join(REPO_ROOT, "deployments", "staging.seed.json"), "utf8")) as {
    markets: Record<string, { sid?: number; orders?: string[] }>;
  };
  const sid = Number(opts.sid ?? journal.markets["spice-fed"]?.sid);
  const sam = d.personas.sam;
  const uma = d.personas.uma;
  const root = d.root;
  console.log(`${NETWORK} via ${DEFAULT_RPC_URL}; contract ${d.contractId}; market ${sid}`);

  await flow("version view", async () => {
    const v = await p.version(true);
    if (v.state_version !== 2) throw new Error(`state_version ${v.state_version}`);
    return `code ${v.code_version}, state ${v.state_version}, events ${v.event_version}`;
  });

  await flow("faucet mint (self, no owner)", async (txs) => {
    h(txs, await call(sam, d.usdc, "mint", { account_id: sam, amount: (1_500n * 10n ** 6n).toString() }, { label: "sam mints 1,500 USDC" }));
    h(txs, await call(sam, d.wnear, "mint", { account_id: sam, amount: (50n * 10n ** 24n).toString() }, { label: "sam mints 50 wNEAR" }));
    return `wallet ${await p.walletBalance("usdc", sam)} USDC base units`;
  });

  await flow("split", async (txs) => {
    h(txs, await p.sendMsg(sam, "wnear", e18(20n), { action: "split", scenario_id: sid, to_masks: [1, 2, 4, 8] }));
    h(txs, await p.sendMsg(sam, "usdc", e18(60n), { action: "split", scenario_id: sid, to_masks: [1, 2, 4, 8] }));
    return `wNEAR-if-SHIPS·CUTS ${wadText(await p.verseBalance(sam, sid, "wnear", 1), 2)}`;
  });

  await flow("sell (conditional_sell, DELAYED·HOLDS)", async (txs) => {
    const quote = await p.quoteSell(sid, e18(10n), 0x8);
    const min = ((quote[3] ?? 0n) * 99n) / 100n;
    h(txs, await p.sendMsg(sam, "wnear", e18(10n), { action: "conditional_sell", scenario_id: sid, sell_mask: 0x8, plans: [[], [], [], []], min_out: ["0", "0", "0", min.toString()], to_lending: false }));
    return `10 wNEAR -> ${wadText(quote[3] ?? 0n, 4)} USDC-if-DELAYED·HOLDS quoted`;
  });

  await flow("buy (conditional_buy, SHIPS·CUTS)", async (txs) => {
    h(txs, await p.sendMsg(sam, "usdc", e18(20n), { action: "conditional_buy", scenario_id: sid, buy_mask: 0x1, plans: [[], [], [], []], min_out: ["0", "0", "0", "0"], to_lending: false }));
    return `wNEAR-if-SHIPS·CUTS now ${wadText(await p.verseBalance(sam, sid, "wnear", 1), 4)}`;
  });

  await flow("order place + cancel", async (txs) => {
    const pools = await p.worldPools(sid);
    const price = (u128(pools.get(1)?.price) * 3n) / 2n;
    const expiry = (await chainNowSec()) + 3_600;
    const id = await p.postOrder(sam, sid, 0x2, "ask", price, e18(5n), expiry);
    txs.push(`(post_order -> order ${id}; hash in the log line above)`);
    h(txs, await p.cancelOrder(sam, id));
    return `ask ${id} for 5 wNEAR-if-DELAYED·CUTS at ${wadText(price, 4)} placed and cancelled`;
  });

  await flow("order fill (Ravi's SHIPS·CUTS ask)", async (txs) => {
    const orderId = journal.markets["spice-fed"]?.orders?.[1];
    if (!orderId) throw new Error("no Ravi ask in the journal");
    const o = await p.order(orderId);
    if (!o) throw new Error(`order ${orderId} is gone`);
    h(txs, await p.fillOrder(sam, orderId, e18(5n), u128(o.price)));
    const after = await p.order(orderId);
    return `filled 5 of order ${orderId} at ${wadText(u128(o.price), 4)}; remaining ${after ? wadText(u128(after.remaining), 2) : "0"}`;
  });

  for (const tier of TIERS) {
    await flow(`supply + withdraw (${tier})`, async (txs) => {
      h(txs, await p.supply(sam, sid, e18(150n), tier));
      const bal = await p.supplyBalance(sid, sam, tier);
      h(txs, await p.withdrawSupply(sam, sid, null, tier));
      const left = await p.supplyBalance(sid, sam, tier);
      if (left !== 0n) throw new Error(`supply left ${left}`);
      return `150 USDC in, ${wadText(bal, 6)} out`;
    });
  }

  await flow("reference report (reporter key)", async (txs) => {
    const r = await fetchNearUsd();
    h(txs, await p.reportReference(d.reporter, r.priceWad, r.observedAtSec));
    return `${wadText(r.priceWad, 4)} from ${r.used} sources, spread ${r.spreadBps} bps`;
  });

  for (const tier of TIERS) {
    await flow(`borrow + repay (${tier})`, async (txs) => {
      const collateral = e18(150n);
      if (u128(await view<string>(d.wnear, "ft_balance_of", { account_id: uma })) < collateral * 10n ** 6n) {
        h(txs, await call(uma, d.wnear, "mint", { account_id: uma, amount: (450n * 10n ** 24n).toString() }, { label: "uma mints 450 wNEAR" }));
      }
      if (u128(await view<string>(d.usdc, "ft_balance_of", { account_id: uma })) < 120n * 10n ** 6n) {
        h(txs, await call(uma, d.usdc, "mint", { account_id: uma, amount: (30n * 10n ** 6n).toString() }, { label: "uma mints 30 USDC for interest" }));
      }
      h(txs, await p.depositCollateralMsg(uma, "wnear", sid, collateral, tier));
      const v = await p.accountView(sid, uma, tier);
      if (v?.borrow_block) throw new Error(`borrow_block ${v.borrow_block}`);
      const amount = e18(110n);
      h(txs, await p.borrow(uma, sid, amount, tier));
      const debt = await p.debt(sid, uma, tier);
      h(txs, await p.repay(uma, sid, e18(112n), { all: true, tier }));
      const left = await p.debt(sid, uma, tier);
      if (left !== 0n) throw new Error(`debt left ${left}`);
      h(txs, await p.withdrawCollateral(uma, sid, "wnear", collateral, tier));
      return `150 wNEAR collateral, max_borrow ${wadText(u128(v?.max_borrow), 2)}, borrowed 110, debt ${wadText(debt, 6)}, repaid all, collateral back`;
    });
  }

  await flow("pause + unpause one flag (pledge)", async (txs) => {
    h(txs, await p.pause(root, ["pledge"], "staging smoke test"));
    const paused = (await p.pauseState()).paused;
    h(txs, await p.unpause(root, ["pledge"]));
    const after = (await p.pauseState()).paused;
    if (after.length !== 0) throw new Error(`still paused: ${after.join(", ")}`);
    return `paused [${paused.join(", ")}], then []`;
  });

  await writeFile(opts.out, `${JSON.stringify({ at: new Date().toISOString(), contract: d.contractId, market: sid, results }, null, 2)}\n`).catch(async () => {
    await (await import("node:fs/promises")).mkdir(join(opts.out, ".."), { recursive: true });
    await writeFile(opts.out, `${JSON.stringify({ at: new Date().toISOString(), contract: d.contractId, market: sid, results }, null, 2)}\n`);
  });
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed; ${opts.out}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
