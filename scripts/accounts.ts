// Creates the testnet accounts, deploys the two mock tokens and writes deployments/testnet.json.
// Safe to re-run: every step checks the chain first and only does what is missing, so a later run
// also tops accounts up to their full amounts once the root has the NEAR for it.
//
//   pnpm accounts [--root multiverse-near.testnet] [--root-keep 12] [--max-faucet 4]
//                 [--faucet-request 5] [--max-faucet-requests 8]
//                 [--sponsor <account.testnet> --sponsor-key <key.json> --sponsor-amount 5]
//                 [--wasm ../target/deploy/mock_ft.wasm] [--upgrade-tokens]
//
// The root asks for what the sub-accounts are missing from their full amounts plus `--root-keep`
// NEAR for itself (deploy top-ups, storage deposits); about 35 NEAR from scratch. Funding uses
// free testnet NEAR only, in this order:
// 1. the faucet services behind near-cli's `create-account sponsor-by-faucet-service` and the
//    docs.near.org faucet page. They create a new account holding 10 NEAR; the root is made that
//    way, and further throwaway accounts are deleted into the root. Both answer HTTP 429 for about
//    ten hours after an account from the same IP.
// 2. the faucet contract behind near-faucet.io (`request_near`), which sends NEAR to an existing
//    top-level .testnet account; the root pays the gas.
// `--sponsor` creates or funds the root from another testnet account you hold instead.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { baseEncode } from "near-api-js";

import {
  accountIds,
  PERSONAS,
  readDeployments,
  writeDeployments,
  type Deployments,
  type TokenDeployment,
} from "./lib/deployments.ts";
import {
  accessKey,
  accountExists,
  actions,
  call,
  DEFAULT_RPC_URL,
  ensureStorage,
  EXPLORER,
  explorerAccount,
  findKeyFile,
  KEYS_DIR,
  loadKeyPair,
  loadKeyPairFile,
  NETWORK,
  NETWORK_CONFIG,
  nearBalance,
  newKeyPair,
  REPO_ROOT,
  removeKeyFile,
  RPC_URL,
  saveKeyFile,
  sendTransaction,
  spendable,
  storageBalanceOf,
  useKeyPair,
  view,
} from "./lib/near.ts";
import { formatNear, formatUnits, parseNear, parseUnits, tgas } from "./lib/units.ts";

// near-contract-helper under the host near-cli uses and the one the docs.near.org faucet page uses.
// When we hit both from one IP they seemed to share a single limit, but each is tried once a run in
// case they do not. NEAR_FAUCET_URL takes a comma-separated list.
const FAUCET_URLS = (process.env.NEAR_FAUCET_URL || "https://helper.nearprotocol.com/account,https://helper.testnet.near.org/account")
  .split(",")
  .map((url) => url.trim())
  .filter((url) => url !== "");
const refusedFaucets = new Map<string, string>();
const EMPTY_CODE_HASH = "11111111111111111111111111111111";
const THROWAWAY = /^(mvl-tmp-[a-z0-9-]+\.testnet)\.json$/;
// Kept on the root for gas and the token registrations it pays for.
const ROOT_RESERVE = parseNear("0.5");
const FAUCET_CONTRACT = process.env.NEAR_FAUCET_CONTRACT || "v2.faucet.nonofficial.testnet";

// NEAR per account. `full` is the comfortable amount; `minimum` is what works today (a token needs
// ~1.73 NEAR to stake its own code). When the root cannot pay the full amounts the minimums are
// used, and a later run tops up. The protocol contract is topped up by deploy.ts once its wasm
// size is known.
const PLAN: ReadonlyArray<{ name: string; full: string; minimum: string }> = [
  { name: "app", full: "6", minimum: "0.2" },
  { name: "wnear", full: "3", minimum: "2" },
  { name: "usdc", full: "3", minimum: "2" },
  { name: "resolver", full: "1", minimum: "0.2" },
  { name: "alice", full: "2", minimum: "0.2" },
  { name: "bob", full: "2", minimum: "0.2" },
  { name: "ravi", full: "2", minimum: "0.2" },
  { name: "sam", full: "1", minimum: "0.2" },
  { name: "uma", full: "1", minimum: "0.2" },
  { name: "carl", full: "1", minimum: "0.2" },
  { name: "leo", full: "1", minimum: "0.2" },
];

const TOKENS = {
  wnear: { name: "Mock Wrapped NEAR", symbol: "wNEAR", decimals: 24, maxMintPerCall: parseUnits("1000000", 24) },
  usdc: { name: "Mock USD Coin", symbol: "USDC", decimals: 6, maxMintPerCall: parseUnits("10000000", 6) },
} as const;
type TokenKind = keyof typeof TOKENS;

const { values: opts } = parseArgs({
  options: {
    root: { type: "string", default: process.env.ROOT_ACCOUNT || NETWORK_CONFIG.defaultRoot },
    "root-keep": { type: "string", default: "12" },
    "max-faucet": { type: "string", default: "4" },
    "faucet-request": { type: "string", default: "5" },
    "max-faucet-requests": { type: "string", default: "8" },
    sponsor: { type: "string" },
    "sponsor-key": { type: "string" },
    "sponsor-amount": { type: "string", default: "5" },
    wasm: { type: "string", default: process.env.MOCK_FT_WASM || join(REPO_ROOT, "target", "deploy", "mock_ft.wasm") },
    "upgrade-tokens": { type: "boolean", default: false },
  },
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForAccount(accountId: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (await accountExists(accountId)) return;
    await sleep(1_000);
  }
  throw new Error(`${accountId} did not show up on chain`);
}

async function rootKeyPair(accountId: string): Promise<ReturnType<typeof newKeyPair>> {
  const keyPair = findKeyFile(accountId) ? await loadKeyPair(accountId) : newKeyPair();
  // Saved before anything is sent, so a crash never leaves an account nobody can sign for.
  await saveKeyFile(accountId, keyPair);
  return keyPair;
}

/** Creates a top-level .testnet account funded by a faucet, trying each faucet service once per run. */
async function faucetCreate(accountId: string): Promise<void> {
  const keyPair = await rootKeyPair(accountId);
  for (const url of FAUCET_URLS) {
    if (refusedFaucets.has(url)) continue;
    const host = new URL(url).host;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keyPair.getPublicKey().toString() }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${body.replace(/\s+/g, " ").slice(0, 160)}`);
      const tx = /"transaction_outcome":\{[^}]*?"id":"(\w+)"/.exec(body)?.[1];
      console.log(`  ${host} created ${accountId}${tx ? ` (tx ${tx})` : ""}`);
    } catch (err) {
      // A slow answer can still have created the account; then it is ours, with the saved key.
      if (!(await accountExists(accountId))) {
        refusedFaucets.set(url, err instanceof Error ? err.message : String(err));
        console.log(`  ${host} refused ${accountId}: ${refusedFaucets.get(url)}`);
        continue;
      }
    }
    useKeyPair(accountId, keyPair);
    await waitForAccount(accountId);
    return;
  }
  throw new Error(`no faucet would create ${accountId}`);
}

/** Creates a top-level .testnet account through the `testnet` registrar, paid by the sponsor. */
async function sponsorCreate(sponsor: string, accountId: string, amount: bigint): Promise<void> {
  const keyPair = await rootKeyPair(accountId);
  await call(
    sponsor,
    "testnet",
    "create_account",
    { new_account_id: accountId, new_public_key: keyPair.getPublicKey().toString() },
    { gas: tgas(60), deposit: amount, label: `${sponsor} creates ${accountId} with ${formatNear(amount)} NEAR` },
  );
  useKeyPair(accountId, keyPair);
  await waitForAccount(accountId);
}

async function deleteInto(accountId: string, beneficiary: string): Promise<void> {
  try {
    await sendTransaction(accountId, accountId, [actions.deleteAccount(beneficiary)], {
      label: `delete ${accountId} into ${beneficiary}`,
    });
  } catch (err) {
    // A resend after a timeout finds the account already deleted by the first attempt.
    if (await accountExists(accountId)) throw err;
    console.log(`  ${accountId} is gone: deleted into ${beneficiary}`);
  }
}

async function prepareSponsor(): Promise<string | undefined> {
  const sponsor = opts.sponsor;
  if (!sponsor) return undefined;
  if (opts["sponsor-key"]) useKeyPair(sponsor, await loadKeyPairFile(opts["sponsor-key"], sponsor));
  return sponsor;
}

async function ensureRoot(root: string, sponsor: string | undefined): Promise<void> {
  if (await accountExists(root)) {
    const keyPair = await loadKeyPair(root);
    const key = await accessKey(root, keyPair.getPublicKey().toString());
    if (key?.permission !== "FullAccess") throw new Error(`the key found for ${root} is not a full-access key of it`);
    console.log(`  ${root}: exists (${formatNear((await nearBalance(root)).total)} NEAR)`);
    return;
  }
  if (!/^[a-z0-9_-]+\.testnet$/.test(root)) throw new Error(`${root} must be a top-level .testnet account`);
  if (sponsor) await sponsorCreate(sponsor, root, parseNear(opts["sponsor-amount"]));
  else await faucetCreate(root);
}

/** Leftovers from an interrupted run still hold faucet NEAR: hand it to the root. */
async function sweepThrowaways(root: string): Promise<void> {
  const files = existsSync(KEYS_DIR) ? await readdir(KEYS_DIR) : [];
  for (const file of files) {
    const id = THROWAWAY.exec(file)?.[1];
    if (!id) continue;
    if (await accountExists(id)) await deleteInto(id, root);
    await removeKeyFile(id);
  }
}

async function fundRoot(root: string, target: bigint, maxFaucet: number, sponsor: string | undefined, rootIsNew: boolean): Promise<void> {
  let balance = await nearBalance(root);
  if (sponsor && !rootIsNew && spendable(balance) < target) {
    const amount = parseNear(opts["sponsor-amount"]);
    await sendTransaction(sponsor, root, [actions.transfer(amount)], { label: `${sponsor} sends ${formatNear(amount)} NEAR to ${root}` });
    balance = await nearBalance(root);
  }
  for (let round = 1; spendable(balance) < target && round <= maxFaucet && refusedFaucets.size < FAUCET_URLS.length; round++) {
    const tmp = `mvl-tmp-${Date.now().toString(36)}-${round}.testnet`;
    try {
      await faucetCreate(tmp);
    } catch (err) {
      await removeKeyFile(tmp);
      console.log(`  stopping faucet rounds: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    const got = (await nearBalance(tmp)).total;
    await deleteInto(tmp, root);
    await removeKeyFile(tmp);
    balance = await nearBalance(root);
    console.log(`  faucet round ${round}: ${formatNear(got)} NEAR moved, ${root} holds ${formatNear(balance.total)} NEAR`);
  }
  const perRequest = parseNear(opts["faucet-request"]);
  const maxRequests = Number(opts["max-faucet-requests"]);
  for (let n = 1; spendable(balance) < target && n <= maxRequests; n++) {
    if (n > 1) await sleep(3_000);
    try {
      await call(root, FAUCET_CONTRACT, "request_near", { receiver_id: root, request_amount: perRequest.toString() }, {
        gas: tgas(30),
        label: `${FAUCET_CONTRACT}.request_near(${formatNear(perRequest)} NEAR to ${root})`,
      });
    } catch (err) {
      console.log(`  stopping faucet requests: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    balance = await nearBalance(root);
  }
  if (spendable(balance) < target) {
    console.log(`  ${root} holds ${formatNear(balance.total)} NEAR, short of the ${formatNear(target)} NEAR it needs now`);
  } else {
    console.log(`  ${root} holds ${formatNear(balance.total)} NEAR, enough for the plan (${formatNear(target)})`);
  }
}

async function subAccountBalances(root: string): Promise<Map<string, bigint>> {
  const current = new Map<string, bigint>();
  for (const { name } of PLAN) {
    const id = `${name}.${root}`;
    current.set(name, (await accountExists(id)) ? (await nearBalance(id)).total : 0n);
  }
  return current;
}

/** NEAR the root must send to bring every sub-account up to the plan's amounts. */
function shortfall(current: Map<string, bigint>, pick: "full" | "minimum"): bigint {
  return PLAN.reduce((sum, p) => {
    const want = parseNear(p[pick]);
    const have = current.get(p.name) ?? 0n;
    return sum + (have + parseNear("0.1") < want ? want - have : 0n);
  }, 0n);
}

/** Full amounts if the root can pay for all of them, otherwise the minimums. */
async function fundingPlan(root: string, current: Map<string, bigint>): Promise<Map<string, bigint>> {
  const available = spendable(await nearBalance(root)) - ROOT_RESERVE;
  const mode = available >= shortfall(current, "full") ? "full" : "minimum";
  if (mode === "minimum") {
    console.log(`  ${root} can spend ${formatNear(available)} NEAR, short of the full plan (${formatNear(shortfall(current, "full"))}); funding minimums now`);
    if (available < shortfall(current, "minimum")) {
      throw new Error(`${root} needs ${formatNear(shortfall(current, "minimum") + ROOT_RESERVE)} NEAR to spend for the minimum plan`);
    }
  }
  return new Map(PLAN.map((p) => [p.name, parseNear(p[mode])]));
}

async function ensureSubAccount(root: string, name: string, target: bigint): Promise<string> {
  const id = `${name}.${root}`;
  if (await accountExists(id)) {
    if (!findKeyFile(id)) console.log(`  ${id}: exists, but no key for it was found locally`);
    const { total } = await nearBalance(id);
    if (total + parseNear("0.1") < target) {
      await sendTransaction(root, id, [actions.transfer(target - total)], { label: `top up ${id} to ${formatNear(target)} NEAR` });
    } else {
      console.log(`  ${id}: exists (${formatNear(total)} NEAR)`);
    }
    return id;
  }
  const keyPair = findKeyFile(id) ? await loadKeyPair(id) : newKeyPair();
  await saveKeyFile(id, keyPair);
  await sendTransaction(
    root,
    id,
    [actions.createAccount(), actions.transfer(target), actions.addFullAccessKey(keyPair.getPublicKey())],
    { label: `create ${id} with ${formatNear(target)} NEAR` },
  );
  useKeyPair(id, keyPair);
  return id;
}

const codeHashOf = (wasm: Uint8Array): string => baseEncode(createHash("sha256").update(wasm).digest());

async function ensureToken(root: string, kind: TokenKind, wasm: Uint8Array): Promise<TokenDeployment> {
  const id = `${kind}.${root}`;
  const spec = TOKENS[kind];
  const wasmHash = codeHashOf(wasm);
  const { codeHash } = await nearBalance(id);
  if (codeHash === EMPTY_CODE_HASH) {
    const init = {
      owner_id: root,
      name: spec.name,
      symbol: spec.symbol,
      decimals: spec.decimals,
      max_mint_per_call: spec.maxMintPerCall.toString(),
    };
    await sendTransaction(id, id, [actions.deployContract(wasm), actions.functionCall("new", init, tgas(30), 0n)], {
      label: `deploy mock-ft to ${id} and init ${spec.symbol}`,
    });
  } else if (codeHash !== wasmHash) {
    if (opts["upgrade-tokens"]) {
      await sendTransaction(id, id, [actions.deployContract(wasm)], { label: `upgrade mock-ft code on ${id}` });
    } else {
      console.log(`  ${id}: runs code ${codeHash}, local wasm is ${wasmHash}; pass --upgrade-tokens to replace it`);
    }
  } else {
    console.log(`  ${id}: mock-ft already deployed (${codeHash})`);
  }

  const meta = await view<{ name: string; symbol: string; decimals: number }>(id, "ft_metadata");
  const faucet = await view<{ owner_id: string; max_mint_per_call: string }>(id, "faucet_config");
  if (meta.symbol !== spec.symbol || meta.decimals !== spec.decimals || faucet.owner_id !== root) {
    throw new Error(`${id} is initialised differently: ${JSON.stringify({ meta, faucet })}`);
  }
  return {
    accountId: id,
    name: meta.name,
    symbol: meta.symbol,
    decimals: meta.decimals,
    maxMintPerCall: faucet.max_mint_per_call,
    codeHash: (await nearBalance(id)).codeHash,
  };
}

async function report(d: Deployments): Promise<void> {
  const rows: string[][] = [["account", "NEAR", "of which storage", "on wNEAR", "on USDC", "key file"]];
  const ids = [d.root, d.contractId, d.wnear, d.usdc, ...Object.values(d.personas)];
  for (const id of [...new Set(ids)]) {
    const b = await nearBalance(id);
    const reg = async (token: string): Promise<string> => ((await storageBalanceOf(token, id)) ? "registered" : "-");
    rows.push([id, formatNear(b.total), formatNear(b.total - spendable(b)), await reg(d.wnear), await reg(d.usdc), findKeyFile(id) ? "yes" : "NO"]);
  }
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  for (const r of rows) console.log(`  ${r.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join("  ")}`);
}

async function main(): Promise<void> {
  const root = opts.root;
  const ids = accountIds(root);
  console.log(`${NETWORK} via ${RPC_URL}; root ${root}; keys in ${KEYS_DIR}`);

  if (!existsSync(opts.wasm)) {
    throw new Error(`mock-ft wasm not found at ${opts.wasm}; build it with scripts/build-wasm.sh or pass --wasm`);
  }
  const wasm = new Uint8Array(await readFile(opts.wasm));
  const sponsor = await prepareSponsor();

  console.log("root account");
  const rootIsNew = !(await accountExists(root));
  await ensureRoot(root, sponsor);
  await sweepThrowaways(root);
  const current = await subAccountBalances(root);
  const target = shortfall(current, "full") + parseNear(opts["root-keep"]) + ROOT_RESERVE;
  await fundRoot(root, target, Number(opts["max-faucet"]), sponsor, rootIsNew);

  console.log("sub-accounts");
  const plan = await fundingPlan(root, current);
  for (const { name } of PLAN) await ensureSubAccount(root, name, plan.get(name) ?? 0n);

  console.log("mock tokens");
  const wnear = await ensureToken(root, "wnear", wasm);
  const usdc = await ensureToken(root, "usdc", wasm);

  console.log("token registration, paid by the root");
  for (const token of [wnear, usdc]) {
    for (const account of [root, ...PERSONAS.map((p) => ids.personas[p])]) {
      if (!(await ensureStorage(root, token.accountId, account))) console.log(`  ${account} on ${token.symbol}: registered`);
    }
  }

  const previous = await readDeployments();
  const deployments: Deployments = {
    network: NETWORK,
    rpcUrl: DEFAULT_RPC_URL,
    explorer: EXPLORER,
    ...ids,
    tokens: { wnear, usdc },
    contract: previous?.contractId === ids.contractId ? previous.contract : null,
    updatedAt: "",
  };
  await writeDeployments(deployments);
  console.log(`deployments/${NETWORK}.json written`);

  console.log("balances");
  await report(deployments);
  console.log(
    `faucet caps: ${formatUnits(BigInt(wnear.maxMintPerCall), wnear.decimals)} wNEAR and ` +
      `${formatUnits(BigInt(usdc.maxMintPerCall), usdc.decimals)} USDC per mint call`,
  );
  console.log(`explorer: ${explorerAccount(root)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
