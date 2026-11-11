// Deploys the Multiverse contract to app.<root> and wires it up. Safe to re-run: each step checks
// the chain first.
//
//   pnpm deploy:contract [--wasm ../target/near/multiverse_contract/multiverse_contract.wasm]
//                        [--dispute-window 30]
//
// 1. top up app.<root> so it can stake storage for its code;
// 2. deploy + new() in one transaction signed by the contract account (new() only accepts itself
//    as the caller), or replace the code in place when a different wasm is already there;
// 3. register the contract on both tokens, so payouts and refunds to it work;
// 4. make resolver.<root> the reporter and set the dispute window (both owner calls, only when
//    the contract differs);
// 5. give resolver.<root> a function-call key that can only call report_outcome and finalize
//    on the contract, saved as .keys/testnet/resolver.<root>.report.json.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { baseEncode } from "near-api-js";

import { requireDeployments, writeDeployments, type Deployments } from "./lib/deployments.ts";
import {
  accessKey,
  accountExists,
  actions,
  call,
  ensureStorage,
  explorerAccount,
  findKeyFile,
  loadKeyPair,
  nearBalance,
  newKeyPair,
  ONE_YOCTO,
  provider,
  REPO_ROOT,
  saveKeyFile,
  sendTransaction,
  STORAGE_BYTE_COST,
  view,
} from "./lib/near.ts";
import { formatNear, parseNear, tgas } from "./lib/units.ts";

const EMPTY_CODE_HASH = "11111111111111111111111111111111";
const REPORT_KEY = "report";
const REPORT_METHODS = ["report_outcome", "finalize"];
const REPORT_KEY_ALLOWANCE = parseNear("0.5");
// Free balance the contract keeps beyond its code, for its own state before deposits come in.
const STATE_HEADROOM = parseNear("2");

const { values: opts } = parseArgs({
  options: {
    wasm: {
      type: "string",
      default:
        process.env.MULTIVERSE_WASM || join(REPO_ROOT, "target", "near", "multiverse_contract", "multiverse_contract.wasm"),
    },
    "dispute-window": { type: "string", default: process.env.DISPUTE_WINDOW_SEC || "30" },
  },
});

interface FtMetadata {
  symbol: string;
  decimals: number;
}

interface AssetCfg {
  token_id: string;
  symbol: string;
  decimals: number;
}

async function assetCfg(tokenId: string): Promise<AssetCfg> {
  const meta = await view<FtMetadata>(tokenId, "ft_metadata");
  return { token_id: tokenId, symbol: meta.symbol, decimals: meta.decimals };
}

// The code travels inside one transaction, so it has to fit the protocol's transaction size limit
// (1.5 MiB on testnet today) with room left for the init arguments and the signature.
async function checkFitsInOneTransaction(wasmBytes: number): Promise<void> {
  const config = await provider.experimental_protocolConfig({ finality: "final" });
  const limits = config.runtime_config?.wasm_config?.limit_config;
  const maxTx = limits?.max_transaction_size ?? 1_572_864;
  const maxCode = limits?.max_contract_size ?? 4_194_304;
  if (wasmBytes > maxCode || wasmBytes + 4_096 > maxTx) {
    throw new Error(`the wasm is ${wasmBytes} bytes; one transaction carries at most ${maxTx} bytes and a contract may have ${maxCode}`);
  }
}

// The account must be able to stake its storage after the deploy: what it stores now, minus the
// code being replaced, plus the new code, plus some headroom for state.
async function fundForCode(d: Deployments, wasmBytes: number): Promise<void> {
  const b = await nearBalance(d.contractId);
  const oldCode =
    b.codeHash === EMPTY_CODE_HASH
      ? 0
      : (await provider.viewContractCode({ contractId: d.contractId, blockQuery: { finality: "final" } })).code.length;
  const need = BigInt(b.storageUsage - oldCode + wasmBytes) * STORAGE_BYTE_COST + STATE_HEADROOM;
  if (b.total >= need) return;
  await sendTransaction(d.root, d.contractId, [actions.transfer(need - b.total)], {
    label: `top up ${d.contractId} by ${formatNear(need - b.total)} NEAR for ${wasmBytes} bytes of code`,
  });
}

async function deployCode(d: Deployments, wasm: Uint8Array, disputeWindowSec: number): Promise<string> {
  const wasmHash = baseEncode(createHash("sha256").update(wasm).digest());
  const { codeHash } = await nearBalance(d.contractId);
  if (codeHash === wasmHash) {
    console.log(`  ${d.contractId} already runs ${wasmHash}`);
    return wasmHash;
  }
  await fundForCode(d, wasm.length);
  if (codeHash === EMPTY_CODE_HASH) {
    const init = {
      owner_id: d.root,
      reporter_id: d.reporter,
      weth: await assetCfg(d.weth),
      usdc: await assetCfg(d.usdc),
      dispute_window_sec: disputeWindowSec,
    };
    await sendTransaction(
      d.contractId,
      d.contractId,
      [actions.deployContract(wasm), actions.functionCall("new", init, tgas(100), 0n)],
      { label: `deploy ${wasm.length} bytes to ${d.contractId} and call new()` },
    );
  } else {
    await sendTransaction(d.contractId, d.contractId, [actions.deployContract(wasm)], {
      label: `replace the code on ${d.contractId} (${codeHash} -> ${wasmHash})`,
    });
  }
  try {
    await view(d.contractId, "get_app_config");
  } catch (err) {
    throw new Error(
      `${d.contractId} runs the new code but get_app_config fails (${String(err)}). If the state layout ` +
        `changed, deploy to a fresh account instead of upgrading in place.`,
    );
  }
  return wasmHash;
}

interface AppConfig {
  owner_id: string;
  reporter_id: string | null;
  weth: AssetCfg;
  usdc: AssetCfg;
  dispute_window_sec: number;
}

// A contract initialised by hand with other accounts would make every later script misbehave.
async function checkConfig(d: Deployments): Promise<AppConfig> {
  const config = await view<AppConfig>(d.contractId, "get_app_config");
  const mismatch =
    config.owner_id !== d.root || config.weth.token_id !== d.weth || config.usdc.token_id !== d.usdc;
  if (mismatch) {
    throw new Error(`${d.contractId} was initialised with other accounts: ${JSON.stringify(config)}`);
  }
  return config;
}

// new() already sets both; this matters when the code was replaced or someone changed them since.
async function ensureSettings(d: Deployments, disputeWindowSec: number): Promise<void> {
  const config = await checkConfig(d);
  if (config.reporter_id === d.reporter) {
    console.log(`  reporter is ${d.reporter}`);
  } else {
    await call(d.root, d.contractId, "set_reporter", { reporter_id: d.reporter }, { deposit: ONE_YOCTO });
  }
  if (config.dispute_window_sec === disputeWindowSec) {
    console.log(`  dispute window is ${disputeWindowSec} s`);
  } else {
    await call(d.root, d.contractId, "set_dispute_window", { dispute_window_sec: disputeWindowSec }, { deposit: ONE_YOCTO });
  }
}

function sameMethods(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

async function ensureReportKey(d: Deployments): Promise<string> {
  const keyPair = findKeyFile(d.reporter, REPORT_KEY) ? await loadKeyPair(d.reporter, REPORT_KEY) : newKeyPair();
  const publicKey = keyPair.getPublicKey().toString();
  const path = await saveKeyFile(d.reporter, keyPair, REPORT_KEY);
  const onChain = await accessKey(d.reporter, publicKey);
  if (onChain) {
    const p = onChain.permission;
    const scoped =
      typeof p === "object" && "FunctionCall" in p && p.FunctionCall.receiver_id === d.contractId &&
      sameMethods(p.FunctionCall.method_names, REPORT_METHODS);
    if (!scoped) throw new Error(`${publicKey} is on ${d.reporter} with a different permission: ${JSON.stringify(p)}`);
    console.log(`  report key ${publicKey} already on ${d.reporter}`);
    return path;
  }
  await sendTransaction(
    d.reporter,
    d.reporter,
    [actions.addFunctionCallAccessKey(keyPair.getPublicKey(), d.contractId, REPORT_METHODS, REPORT_KEY_ALLOWANCE)],
    { label: `add a ${REPORT_METHODS.join("/")} key on ${d.contractId} to ${d.reporter}` },
  );
  return path;
}

async function main(): Promise<void> {
  const d = await requireDeployments();
  const disputeWindowSec = Number(opts["dispute-window"]);
  if (!Number.isInteger(disputeWindowSec) || disputeWindowSec <= 0) throw new Error("--dispute-window must be a positive integer");
  if (!existsSync(opts.wasm)) {
    throw new Error(`contract wasm not found at ${opts.wasm}; run \`cargo near build non-reproducible-wasm\` in contracts/multiverse or pass --wasm`);
  }
  for (const id of [d.root, d.contractId, d.weth, d.usdc, d.reporter]) {
    if (!(await accountExists(id))) throw new Error(`${id} does not exist; run \`pnpm accounts\` first`);
  }
  const wasm = new Uint8Array(await readFile(opts.wasm));
  await checkFitsInOneTransaction(wasm.length);

  console.log(`contract ${d.contractId}`);
  const codeHash = await deployCode(d, wasm, disputeWindowSec);

  console.log("token registration");
  for (const token of [d.weth, d.usdc]) {
    if (!(await ensureStorage(d.root, token, d.contractId))) console.log(`  ${d.contractId} on ${token}: registered`);
  }

  console.log("settings");
  await ensureSettings(d, disputeWindowSec);
  const keyPath = await ensureReportKey(d);

  const previous = d.contract;
  await writeDeployments({
    ...d,
    contract: {
      accountId: d.contractId,
      codeHash,
      deployedAt: previous?.codeHash === codeHash ? previous.deployedAt : new Date().toISOString(),
      disputeWindowSec,
    },
  });
  const b = await nearBalance(d.contractId);
  console.log(`done: ${d.contractId} holds ${formatNear(b.total)} NEAR (${b.storageUsage} bytes stored)`);
  console.log(`report key: ${keyPath}`);
  console.log(`explorer: ${explorerAccount(d.contractId)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
