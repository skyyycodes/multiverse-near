// A local NEAR sandbox node with the whole deployment on it: test.near as the root, the personas
// as sub-accounts (alice.test.near, ...), both mock tokens (wnear.test.near with 24 decimals,
// usdc.test.near with 6) and the protocol contract, so seeding and the end-to-end flow run in
// seconds without testnet NEAR.
//
//   pnpm sandbox [start] [--fresh] [--wasm <multiverse.wasm>] [--mock-ft-wasm <mock_ft.wasm>]
//   pnpm sandbox stop | status
//
// The node runs in the background from .sandbox/ (data, node.log, node.pid). `start` reuses a
// running node and only deploys what is missing; `--fresh` wipes the chain and the sandbox keys.
// Afterwards run the other scripts with NEAR_NETWORK=sandbox.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { KeyPair, type KeyPairString } from "near-api-js";

import { REPO_ROOT } from "./lib/near.ts";

const RPC_PORT = Number(process.env.SANDBOX_RPC_PORT || "3030");
const NET_PORT = Number(process.env.SANDBOX_NET_PORT || "24577");
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const ROOT = "test.near";
const HOME = process.env.SANDBOX_HOME || join(REPO_ROOT, ".sandbox");
const KEYS = join(REPO_ROOT, ".keys", "sandbox");
const PID_FILE = join(HOME, "node.pid");
const LOG_FILE = join(HOME, "node.log");

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fresh: { type: "boolean", default: false },
    // nearcore 2.6.5 built with the sandbox feature; near-workspaces downloads the same binary.
    bin: { type: "string", default: process.env.NEAR_SANDBOX_BIN || "near-sandbox" },
    wasm: {
      type: "string",
      default:
        process.env.MULTIVERSE_WASM || join(REPO_ROOT, "target", "deploy", "multiverse_contract.wasm"),
    },
    "mock-ft-wasm": {
      type: "string",
      default: process.env.MOCK_FT_WASM || join(REPO_ROOT, "target", "deploy", "mock_ft.wasm"),
    },
  },
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function rpcUp(): Promise<boolean> {
  try {
    const res = await fetch(`${RPC_URL}/status`, { signal: AbortSignal.timeout(1_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function runningPid(): Promise<number | undefined> {
  if (!existsSync(PID_FILE)) return undefined;
  const pid = Number((await readFile(PID_FILE, "utf8")).trim());
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

async function stop(): Promise<void> {
  const pid = await runningPid();
  if (pid === undefined) {
    console.log("no sandbox node of ours is running");
    return;
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50 && (await runningPid()) !== undefined; i++) await sleep(200);
  await rm(PID_FILE, { force: true });
  console.log(`stopped the sandbox node (pid ${pid})`);
}

async function init(): Promise<void> {
  await rm(HOME, { recursive: true, force: true });
  // Keys of a previous chain are useless and would clash with the new root key.
  await rm(KEYS, { recursive: true, force: true });
  await mkdir(HOME, { recursive: true });
  const r = spawnSync(opts.bin, ["--home", HOME, "init"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sandbox init failed: ${r.stderr || r.stdout}`);
  // One block every 0.6-2 s makes every FINAL wait take seconds; a single local validator keeps up
  // with much faster blocks.
  const configPath = join(HOME, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { consensus: Record<string, unknown> };
  const ms = (n: number): { secs: number; nanos: number } => ({ secs: Math.floor(n / 1000), nanos: (n % 1000) * 1_000_000 });
  config.consensus.min_block_production_delay = ms(100);
  config.consensus.max_block_production_delay = ms(300);
  config.consensus.block_production_tracking_delay = ms(20);
  config.consensus.doomslug_step_period = ms(20);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function startNode(): Promise<void> {
  if (opts.bin.includes("/") && !existsSync(opts.bin)) throw new Error(`no sandbox binary at ${opts.bin}; pass --bin or NEAR_SANDBOX_BIN`);
  if (await rpcUp()) throw new Error(`something else already answers on ${RPC_URL}; set SANDBOX_RPC_PORT`);
  const log = openSync(LOG_FILE, "a");
  const child = spawn(
    opts.bin,
    ["--home", HOME, "run", "--rpc-addr", `127.0.0.1:${RPC_PORT}`, "--network-addr", `127.0.0.1:${NET_PORT}`],
    { detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  closeSync(log);
  await writeFile(PID_FILE, `${child.pid}\n`);
  for (let i = 0; i < 150; i++) {
    if (await rpcUp()) {
      console.log(`sandbox node up on ${RPC_URL} (pid ${child.pid}, log ${LOG_FILE})`);
      return;
    }
    if ((await runningPid()) === undefined) throw new Error(`the sandbox node exited; see ${LOG_FILE}`);
    await sleep(200);
  }
  throw new Error(`the sandbox node did not answer on ${RPC_URL}; see ${LOG_FILE}`);
}

/** The validator key of test.near, copied into the sandbox key dir the scripts sign from. */
async function installRootKey(): Promise<void> {
  const raw = JSON.parse(await readFile(join(HOME, "validator_key.json"), "utf8")) as {
    account_id: string;
    public_key: string;
    secret_key?: string;
    private_key?: string;
  };
  const secret = raw.secret_key ?? raw.private_key;
  if (raw.account_id !== ROOT || !secret) throw new Error(`unexpected validator key for ${raw.account_id}`);
  const keyPair = KeyPair.fromString(secret as KeyPairString);
  await mkdir(KEYS, { recursive: true, mode: 0o700 });
  const body = { account_id: ROOT, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() };
  await writeFile(join(KEYS, `${ROOT}.json`), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

function runScript(script: string, args: string[]): void {
  const r = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: join(REPO_ROOT, "scripts"),
    stdio: "inherit",
    env: { ...process.env, NEAR_NETWORK: "sandbox", NEAR_RPC_URL: RPC_URL, ROOT_ACCOUNT: ROOT },
  });
  if (r.status !== 0) throw new Error(`${script} failed`);
}

async function start(): Promise<void> {
  for (const [what, path] of [["contract", opts.wasm], ["mock-ft", opts["mock-ft-wasm"]]] as const) {
    if (!existsSync(path)) throw new Error(`${what} wasm not found at ${path}; build both with scripts/build-wasm.sh or pass its path`);
  }
  if (opts.fresh) await stop();
  const pid = await runningPid();
  if (pid !== undefined && (await rpcUp())) {
    console.log(`reusing the sandbox node (pid ${pid})`);
  } else {
    if (opts.fresh || !existsSync(join(HOME, "validator_key.json"))) await init();
    await startNode();
  }
  await installRootKey();
  runScript("accounts.ts", ["--root", ROOT, "--wasm", opts["mock-ft-wasm"]]);
  runScript("deploy.ts", ["--wasm", opts.wasm]);
  console.log("sandbox ready: run the other scripts with NEAR_NETWORK=sandbox");
}

async function main(): Promise<void> {
  const command = positionals[0] ?? "start";
  if (command === "start") return start();
  if (command === "stop") return stop();
  if (command === "status") {
    const pid = await runningPid();
    console.log(pid !== undefined && (await rpcUp()) ? `running (pid ${pid}) on ${RPC_URL}` : "not running");
    return;
  }
  throw new Error(`unknown command ${command}; use start, stop or status`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
