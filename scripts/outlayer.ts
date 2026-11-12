// Resolution through OutLayer. `configure` pins the FRED guest on the contract and gives a FOMC
// event its two FRED dates (owner). `request` pays OutLayer for one run of the guest, follows the
// run until the contract proposes its answer or drops it, waits out the dispute window and
// finalizes (anyone may). OutLayer exists only on testnet.
//
//   NEAR_NETWORK=testnet pnpm outlayer configure --url <https url> --sha256 <hex>
//                                                [--event <id>] [--before <date>] [--after <date>]
//   NEAR_NETWORK=testnet pnpm outlayer request [--event <id>] [--as <account>]
//
// --event defaults to the demo record's past Fed event, the dates (YYYY-MM-DD) to the first day of
// its October 27-28, 2026 meeting and the day after it, and --as to Leo. configure downloads --url
// and refuses unless the bytes hash to --sha256; whatever is already set it leaves alone. request
// gives up after 15 minutes without an answer and never falls back to the reporter: an event
// OutLayer cannot resolve stays open.

import { parseArgs } from "node:util";

import { chainNowSec, waitForChainTime } from "./lib/chain.ts";
import { requireDeployments, type Deployments } from "./lib/deployments.ts";
import { actions, call, explorerTx, NETWORK, RPC_URL, sendIncluded, transactionStatus, type TxOutcome } from "./lib/near.ts";
import {
  configMatches,
  datesMatch,
  datesMisfit,
  outlayerResult,
  parseDates,
  parseSha256,
  parseWasmUrl,
  sha256Hex,
  type FomcDates,
  type OutLayerConfig,
} from "./lib/outlayer.ts";
import { Protocol, type EventView } from "./lib/protocol.ts";
import { formatNear, tgas, u128 } from "./lib/units.ts";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    sha256: { type: "string" },
    event: { type: "string" },
    before: { type: "string", default: "2026-10-27" },
    after: { type: "string", default: "2026-10-29" },
    as: { type: "string" },
  },
});

const REQUEST_GAS = tgas(300);
const ANSWER_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const utc = (): string => new Date().toISOString().replace(/\.\d+Z$/, "Z");

/**
 * Reads through a public RPC that can answer 429 for minutes. Retries with a pause instead of
 * failing the run; a transaction is never sent through here.
 */
async function patient<T>(what: string, task: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (err) {
      if (attempt >= 15) throw err;
      console.log(`    ${what} failed (${String(err).slice(0, 120)}); retrying in 20 s`);
      await sleep(20_000);
    }
  }
}

async function eventIdOf(p: Protocol): Promise<number> {
  if (opts.event !== undefined) {
    const id = Number(opts.event);
    if (!Number.isInteger(id) || id < 0) throw new Error(`--event must be an event id, not "${opts.event}"`);
    return id;
  }
  const id = (await patient("reading the demo record", () => p.demoRecord())).past_fed_event;
  if (id === null) throw new Error("the demo record has no past Fed event; pass --event");
  return id;
}

const readEvent = (p: Protocol, id: number): Promise<EventView> => patient(`reading event ${id}`, () => p.event(id));
const readConfig = (p: Protocol): Promise<OutLayerConfig | null> =>
  patient("reading the OutLayer config", () => p.view<OutLayerConfig | null>("get_outlayer_config"));
const readDates = (p: Protocol, id: number): Promise<FomcDates | null> =>
  patient(`reading the dates of event ${id}`, () => p.view<FomcDates | null>("get_outlayer_dates", { event_id: id }));

function describe(e: EventView): string {
  if (e.finalized) return `finalized ${e.outcome_names[e.outcome] ?? e.outcome}`;
  if (e.proposal_open) {
    return `${e.outcome_names[e.proposed_outcome] ?? e.proposed_outcome} proposed by ${e.proposed_by ?? "?"}, finalizable at ${e.finalizable_at_sec}`;
  }
  return "open, no proposal";
}

async function configure(p: Protocol, d: Deployments): Promise<void> {
  if (opts.url === undefined || opts.sha256 === undefined) throw new Error("configure needs --url and --sha256");
  const url = parseWasmUrl(opts.url);
  const sha256 = parseSha256(opts.sha256);
  const { before, after } = parseDates(opts.before, opts.after);
  const owner = (await patient("reading the app config", () => p.appConfig())).owner_id;
  if (owner !== d.root) throw new Error(`${p.contract} is owned by ${owner}, not ${d.root}`);

  const eventId = await eventIdOf(p);
  const e = await readEvent(p, eventId);
  console.log(`event ${eventId}: "${e.question}" (${describe(e)})`);
  const misfit = datesMisfit(e, before, after);
  if (misfit) throw new Error(misfit);

  // OutLayer fetches the file itself and wants it served directly, so a redirect counts as a failure.
  const res = await fetch(url, { redirect: "manual" });
  if (res.status !== 200) throw new Error(`${url} answered HTTP ${res.status}; OutLayer needs a direct 200`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256Hex(bytes);
  if (got !== sha256) throw new Error(`${url} (${bytes.length} bytes) hashes to ${got}, not ${sha256}; refusing to pin it`);
  console.log(`  ${url}: ${bytes.length} bytes, sha256 ${got}`);

  const config = await readConfig(p);
  if (configMatches(config, url, sha256)) {
    console.log("  guest already pinned");
  } else {
    // Omitted limits, OutLayer account and deposit take the contract's defaults.
    await p.call1y(owner, "set_outlayer_config", { wasm_url: url, wasm_sha256: sha256 }, `${owner}: set_outlayer_config`);
  }

  const dates = await readDates(p, eventId);
  if (datesMatch(dates, before, after)) {
    console.log(`  event ${eventId} already has the dates ${before} / ${after}`);
  } else {
    await p.call1y(owner, "set_outlayer_dates", { event_id: eventId, before, after }, `${owner}: set_outlayer_dates(${eventId}, ${before}, ${after})`);
  }

  const final = await readConfig(p);
  if (!final) throw new Error("get_outlayer_config is still empty");
  console.log(`  config: ${final.wasm_url} ${final.wasm_sha256} on ${final.outlayer_id}`);
  console.log(`          limits ${JSON.stringify(final.resource_limits)}, deposit ${formatNear(u128(final.deposit, "deposit"), 6)} NEAR`);
  console.log(`  dates:  ${JSON.stringify(await readDates(p, eventId))}`);
}

function receiptLogs(outcome: TxOutcome, executor?: string): string[] {
  return (outcome.receipts_outcome ?? [])
    .filter((o) => executor === undefined || o.outcome.executor_id === executor)
    .flatMap((o) => o.outcome.logs);
}

/** The panic of the contract's own receipt, if `request_resolution` failed. */
function contractFailure(outcome: TxOutcome, contract: string): string | undefined {
  for (const o of outcome.receipts_outcome ?? []) {
    const status: unknown = o.outcome.status;
    if (o.outcome.executor_id === contract && typeof status === "object" && status !== null && "Failure" in status) {
      return JSON.stringify(status.Failure);
    }
  }
  return undefined;
}

async function request(p: Protocol, d: Deployments): Promise<void> {
  const signer = opts.as ?? d.personas.leo;
  const eventId = await eventIdOf(p);
  const config = await readConfig(p);
  if (!config) throw new Error(`${p.contract} has no OutLayer config; run configure first`);
  const dates = await readDates(p, eventId);
  if (!dates) throw new Error(`event ${eventId} has no FRED dates; run configure first`);
  const e = await readEvent(p, eventId);
  console.log(`event ${eventId}: "${e.question}" (${describe(e)})`);
  console.log(`  dates ${dates.before} / ${dates.after}, last request ${dates.request}${dates.pending ? " (in flight)" : ""}`);
  if (e.finalized) return;
  if (e.proposal_open) {
    if (e.proposed_by !== "outlayer") throw new Error(`event ${eventId} already has a proposal from ${e.proposed_by ?? "?"}`);
    console.log("  OutLayer's earlier answer is in its dispute window; finalizing it");
    await finalizeOutLayer(p, signer, eventId);
    return;
  }
  if (dates.pending) throw new Error(`request ${dates.request} for event ${eventId} is still in flight`);

  const deposit = u128(config.deposit, "deposit");
  const requestNo = dates.request + 1;
  console.log(`[${utc()}] ${signer} requests run ${requestNo} with ${formatNear(deposit, 6)} NEAR and 300 Tgas`);
  const action = actions.functionCall("request_resolution", { event_id: eventId }, REQUEST_GAS, deposit);
  const hash = await sendIncluded(signer, p.contract, [action], `${signer}: request_resolution(${eventId})`);

  const started = Date.now();
  let lastNote = 0;
  let answered = false;
  while (Date.now() - started < ANSWER_TIMEOUT_MS) {
    await sleep(POLL_MS);
    const status = await transactionStatus(hash, signer).catch(() => undefined);
    const failure = status && contractFailure(status, p.contract);
    if (failure) throw new Error(`request_resolution failed (the deposit comes back): ${failure}\n  tx ${explorerTx(hash)}`);
    const now = await p.view<FomcDates | null>("get_outlayer_dates", { event_id: eventId }).catch(() => undefined);
    if (now && now.request > requestNo) throw new Error(`the dates of event ${eventId} were set again meanwhile; run ${requestNo} is stale`);
    if (now && now.request === requestNo && !now.pending) {
      answered = true;
      break;
    }
    if (Date.now() - lastNote >= 30_000) {
      lastNote = Date.now();
      const outlayerLogs = status ? receiptLogs(status, config.outlayer_id).length : 0;
      const phase = now?.request === requestNo ? "OutLayer is running the guest" : "waiting for the request to execute";
      console.log(`    ${Math.round((Date.now() - started) / 1000)} s: ${phase} (${outlayerLogs} OutLayer log lines so far)`);
    }
  }
  if (!answered) {
    process.exitCode = 1;
    console.log(`[${utc()}] no answer from OutLayer in ${ANSWER_TIMEOUT_MS / 60_000} minutes; event ${eventId} stays open`);
    console.log(`  tx ${explorerTx(hash)}`);
    return;
  }
  console.log(`[${utc()}] the contract's callback ran`);

  // Every receipt has run by now, so this answers at once.
  const outcome = await patient("reading the request's receipts", () => transactionStatus(hash, signer, "EXECUTED_OPTIMISTIC"));
  for (const line of receiptLogs(outcome, config.outlayer_id)) console.log(`    outlayer: ${line.length > 300 ? `${line.slice(0, 300)}...` : line}`);
  const result = outlayerResult(receiptLogs(outcome), eventId, requestNo);
  if (!result) throw new Error(`no outlayer_result for run ${requestNo} in the logs\n  tx ${explorerTx(hash)}`);
  const name = result.outcome === null ? "no outcome" : (e.outcome_names[result.outcome] ?? String(result.outcome));
  console.log(`  OutLayer answered ${name}; ${result.proposed ? "proposed" : "dropped"}`);
  console.log(`  ${result.proposed ? "evidence" : "note"}: ${result.note}`);
  if (!result.proposed) {
    process.exitCode = 1;
    console.log(`  event ${eventId} stays open`);
    return;
  }
  await finalizeOutLayer(p, signer, eventId);
}

async function finalizeOutLayer(p: Protocol, signer: string, eventId: number): Promise<void> {
  const e = await readEvent(p, eventId);
  console.log(`  event ${eventId}: ${describe(e)} (chain time now ${await patient("reading the latest block", chainNowSec)})`);
  await waitForChainTime(e.finalizable_at_sec, "the dispute window");
  const open = await readEvent(p, eventId);
  if (!open.proposal_open || open.proposed_by !== "outlayer") {
    console.log(`  event ${eventId}: ${describe(open)}; not finalizing`);
    return;
  }
  console.log(`[${utc()}] finalizing`);
  await call(signer, p.contract, "finalize", { event_id: eventId }, { gas: tgas(100), label: `${signer}: finalize(${eventId})` });
  const done = await readEvent(p, eventId);
  console.log(`[${utc()}] event ${eventId}: "${done.question}" ${describe(done)} (source ${done.proposed_by ?? "?"})`);
}

async function main(): Promise<void> {
  const [command, ...rest] = positionals;
  if (rest.length > 0 || (command !== "configure" && command !== "request")) {
    throw new Error("usage: pnpm outlayer configure|request [options]; see the top of outlayer.ts");
  }
  if (NETWORK !== "testnet") throw new Error("OutLayer runs only on testnet; set NEAR_NETWORK=testnet");
  const d = await requireDeployments();
  const p = new Protocol(d);
  console.log(`${NETWORK} via ${RPC_URL}; contract ${d.contractId}`);
  if (command === "configure") await configure(p, d);
  else await request(p, d);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
