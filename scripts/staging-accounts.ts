// The staging accounts: funds and creates `ifverse-staging.testnet` and its sub-accounts, deploys
// the two mock tokens and writes deployments/staging.json. Safe to re-run: every step reads the
// chain first and only does what is missing.
//
//   NEAR_NETWORK=staging pnpm -C scripts staging:accounts [--dry-run] [--faucet 0] [--skip-sweep]
//
// Funding (SPEC.md 7.1, DECISIONS 2026-11-14 item 5): the abandoned `multiverse-lending.*`
// accounts send what they can spend by plain transfers (no deletions); each keeps 0.011 NEAR free
// above its storage. The root is created through the `testnet` registrar by
// `multiverse-lending.testnet`. `--faucet N` asks near-faucet.io's contract for up to N NEAR more
// (one request; the contract allows one per receiver per period).
//
// Amounts are "just enough": code and state at 1e19 yocto per byte, plus a gas float for every
// signer that sends 300 Tgas calls (testnet buys prepaid gas at 1e9 yocto/gas, so 0.3 NEAR must be
// free before such a call is accepted). deploy.ts tops `app.` up to its code size later.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  findKeyFile,
  KEYS_DIR,
  loadKeyPair,
  loadKeyPairFile,
  NETWORK,
  nearBalance,
  newKeyPair,
  REPO_ROOT,
  saveKeyFile,
  sendTransaction,
  spendable,
  storageBalanceOf,
  useKeyPair,
  view,
} from "./lib/near.ts";
import { formatNear, formatUnits, parseNear, parseUnits, tgas } from "./lib/units.ts";

const ROOT = "ifverse-staging.testnet";
const SPONSOR = "multiverse-lending.testnet";
const SOURCES = ["app", "usdc", "weth", "alice", "bob", "ravi", "sam", "uma", "carl", "leo", "resolver", "visitor"].map((n) => `${n}.${SPONSOR}`);
// the old deployment's keys sit next to this network's key dir: <keys>/testnet
const SOURCE_KEYS_DIR = process.env.SOURCE_KEYS_DIR || join(dirname(KEYS_DIR), "testnet");
/** Left free on every source account above its storage. */
const SOURCE_KEEP = parseNear("0.011");
const CREATE_GAS = tgas(60);
const FAUCET_CONTRACT = process.env.NEAR_FAUCET_CONTRACT || "v2.faucet.nonofficial.testnet";
const EMPTY_CODE_HASH = "11111111111111111111111111111111";

/**
 * NEAR each sub-account is created with. Tokens: 171,046 B of code (1.71) plus registrations of
 * self-minting visitors. Personas: a 300 Tgas float (0.31) plus the bond and reserve of the proposals
 * they make (seeding and the video). Keeper: liquidations and reference requests (300 Tgas, 0.005
 * deposit). The contract's NEP-145 deposits of the team are paid by the root.
 */
export const PLAN: ReadonlyArray<{ name: string; near: string; role: string }> = [
  { name: "app", near: "0.3", role: "contract (deploy.ts adds its code stake)" },
  { name: "wnear", near: "2.0", role: "mock wNEAR, 24 decimals, open capped faucet" },
  { name: "usdc", near: "2.0", role: "mock USDC, 6 decimals, open capped faucet" },
  { name: "resolver", near: "0.45", role: "reporter: outcomes and the NEAR/USD reference" },
  { name: "keeper", near: "0.9", role: "liquidator bot and reference requests" },
  { name: "maker", near: "0.35", role: "price tracker (team account)" },
  { name: "alice", near: "0.6", role: "persona" },
  { name: "bob", near: "0.5", role: "persona" },
  { name: "ravi", near: "0.65", role: "persona" },
  { name: "sam", near: "0.65", role: "persona" },
  { name: "uma", near: "0.7", role: "persona" },
  { name: "carl", near: "0.45", role: "persona" },
  { name: "leo", near: "0.7", role: "persona" },
];
/** What the root keeps after creating everything: gas, token registrations, the contract deposits. */
const ROOT_KEEP = parseNear("2.2");

const TOKENS = {
  wnear: { name: "Mock Wrapped NEAR", symbol: "wNEAR", decimals: 24, maxMintPerCall: parseUnits("1000000", 24) },
  usdc: { name: "Mock USD Coin", symbol: "USDC", decimals: 6, maxMintPerCall: parseUnits("10000000", 6) },
} as const;
type TokenKind = keyof typeof TOKENS;

const { values: opts } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    faucet: { type: "string", default: "0" },
    "skip-sweep": { type: "boolean", default: false },
    wasm: { type: "string", default: process.env.MOCK_FT_WASM || join(REPO_ROOT, "target", "deploy", "mock_ft.wasm") },
  },
});
const dry = opts["dry-run"];

async function useSourceKey(id: string): Promise<void> {
  const path = join(SOURCE_KEYS_DIR, `${id}.json`);
  if (!existsSync(path)) throw new Error(`no key file for ${id} at ${path}`);
  useKeyPair(id, await loadKeyPairFile(path, id));
}

const planTotal = (): bigint => PLAN.reduce((s, p) => s + parseNear(p.near), 0n);

async function createRoot(): Promise<void> {
  if (await accountExists(ROOT)) {
    const kp = await loadKeyPair(ROOT);
    const key = await accessKey(ROOT, kp.getPublicKey().toString());
    if (key?.permission !== "FullAccess") throw new Error(`the key found for ${ROOT} is not a full-access key of it`);
    console.log(`  ${ROOT}: exists (${formatNear((await nearBalance(ROOT)).total)} NEAR)`);
    return;
  }
  await useSourceKey(SPONSOR);
  const free = spendable(await nearBalance(SPONSOR));
  // the registrar call buys 60 Tgas at 1e9 yocto/gas up front (0.06), refunded after
  const amount = free - CREATE_GAS * 1_000_000_000n - parseNear("0.011");
  if (dry) {
    console.log(`  would create ${ROOT} with ${formatNear(amount)} NEAR from ${SPONSOR}`);
    return;
  }
  const keyPair = findKeyFile(ROOT) ? await loadKeyPair(ROOT) : newKeyPair();
  // saved before anything is sent, so a crash never leaves an account nobody can sign for
  await saveKeyFile(ROOT, keyPair);
  await call(SPONSOR, "testnet", "create_account", { new_account_id: ROOT, new_public_key: keyPair.getPublicKey().toString() }, {
    gas: CREATE_GAS,
    deposit: amount,
    label: `${SPONSOR} creates ${ROOT} with ${formatNear(amount)} NEAR`,
  });
  useKeyPair(ROOT, keyPair);
  for (let i = 0; i < 30 && !(await accountExists(ROOT)); i++) await new Promise((r) => setTimeout(r, 1_000));
  if (!(await accountExists(ROOT))) throw new Error(`${ROOT} did not show up on chain`);
}

/** Every source account sends what it can spend, keeping 0.011 NEAR free above its storage. */
async function sweepSources(): Promise<void> {
  for (const id of [...SOURCES, SPONSOR]) {
    if (!(await accountExists(id))) {
      console.log(`  ${id}: does not exist`);
      continue;
    }
    const free = spendable(await nearBalance(id));
    const amount = free - SOURCE_KEEP;
    if (amount < parseNear("0.01")) {
      console.log(`  ${id}: ${formatNear(free)} NEAR free, nothing to move`);
      continue;
    }
    if (dry) {
      console.log(`  would move ${formatNear(amount)} NEAR from ${id}`);
      continue;
    }
    await useSourceKey(id);
    await sendTransaction(id, ROOT, [actions.transfer(amount)], { label: `${id} sends ${formatNear(amount)} NEAR to ${ROOT}` });
  }
}

async function requestFaucet(totalNear: bigint): Promise<void> {
  if (totalNear <= 0n) return;
  for (const ask of [totalNear, totalNear / 2n, parseNear("5"), parseNear("2")]) {
    if (ask <= 0n || ask > totalNear) continue;
    if (dry) {
      console.log(`  would ask ${FAUCET_CONTRACT} for ${formatNear(ask)} NEAR`);
      return;
    }
    try {
      await call(ROOT, FAUCET_CONTRACT, "request_near", { receiver_id: ROOT, request_amount: ask.toString() }, {
        gas: tgas(30),
        label: `${FAUCET_CONTRACT}.request_near(${formatNear(ask)} NEAR to ${ROOT})`,
      });
      return;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      console.log(`  faucet refused ${formatNear(ask)} NEAR: ${text.split("\n")[0]?.slice(0, 200)}`);
      if (!/higher than the allowance|too large/.test(text)) return;
    }
  }
}

async function ensureSubAccount(name: string, amount: bigint): Promise<string> {
  const id = `${name}.${ROOT}`;
  if (await accountExists(id)) {
    if (!findKeyFile(id)) throw new Error(`${id} exists but no key for it was found in ${KEYS_DIR}`);
    console.log(`  ${id}: exists (${formatNear((await nearBalance(id)).total)} NEAR)`);
    return id;
  }
  if (dry) {
    console.log(`  would create ${id} with ${formatNear(amount)} NEAR`);
    return id;
  }
  const keyPair = findKeyFile(id) ? await loadKeyPair(id) : newKeyPair();
  await saveKeyFile(id, keyPair);
  await sendTransaction(ROOT, id, [actions.createAccount(), actions.transfer(amount), actions.addFullAccessKey(keyPair.getPublicKey())], {
    label: `create ${id} with ${formatNear(amount)} NEAR`,
  });
  useKeyPair(id, keyPair);
  return id;
}

const codeHashOf = (wasm: Uint8Array): string => baseEncode(createHash("sha256").update(wasm).digest());

async function ensureToken(kind: TokenKind, wasm: Uint8Array): Promise<TokenDeployment> {
  const id = `${kind}.${ROOT}`;
  const spec = TOKENS[kind];
  const { codeHash } = await nearBalance(id);
  if (codeHash === EMPTY_CODE_HASH) {
    const init = { owner_id: ROOT, name: spec.name, symbol: spec.symbol, decimals: spec.decimals, max_mint_per_call: spec.maxMintPerCall.toString() };
    await sendTransaction(id, id, [actions.deployContract(wasm), actions.functionCall("new", init, tgas(30), 0n)], {
      label: `deploy mock-ft to ${id} and init ${spec.symbol}`,
    });
  } else if (codeHash !== codeHashOf(wasm)) {
    console.log(`  ${id}: runs code ${codeHash}, the local wasm is ${codeHashOf(wasm)} (left as it is)`);
  } else {
    console.log(`  ${id}: mock-ft already deployed (${codeHash})`);
  }
  const meta = await view<{ name: string; symbol: string; decimals: number }>(id, "ft_metadata");
  const faucet = await view<{ owner_id: string; max_mint_per_call: string }>(id, "faucet_config");
  if (meta.symbol !== spec.symbol || meta.decimals !== spec.decimals || faucet.owner_id !== ROOT) {
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

async function report(ids: string[]): Promise<void> {
  for (const id of ids) {
    if (!(await accountExists(id))) {
      console.log(`  ${id.padEnd(36)} missing`);
      continue;
    }
    const b = await nearBalance(id);
    console.log(`  ${id.padEnd(36)} ${formatNear(b.total).padStart(9)} NEAR, ${formatNear(spendable(b)).padStart(9)} free, ${b.storageUsage} B${findKeyFile(id) ? "" : ", NO KEY"}`);
  }
}

async function main(): Promise<void> {
  if (NETWORK !== "staging") throw new Error("NEAR_NETWORK must be staging");
  console.log(`staging via ${DEFAULT_RPC_URL}; root ${ROOT}; keys in ${KEYS_DIR}${dry ? " (dry run)" : ""}`);
  if (!existsSync(opts.wasm)) throw new Error(`mock-ft wasm not found at ${opts.wasm}; run scripts/build-wasm.sh`);
  const wasm = new Uint8Array(await readFile(opts.wasm));

  console.log("root");
  await createRoot();
  if (!opts["skip-sweep"]) {
    console.log("transfers from the multiverse-lending accounts");
    await sweepSources();
  }
  await requestFaucet(parseNear(opts.faucet));

  const missing = await (async () => {
    let sum = 0n;
    for (const p of PLAN) if (!(await accountExists(`${p.name}.${ROOT}`))) sum += parseNear(p.near);
    return sum;
  })();
  const rootFree = (await accountExists(ROOT)) ? spendable(await nearBalance(ROOT)) : 0n;
  console.log(`plan: ${formatNear(planTotal())} NEAR to sub-accounts (${formatNear(missing)} still to send), root keeps ${formatNear(ROOT_KEEP)}; root has ${formatNear(rootFree)} free`);
  if (!dry && rootFree < missing + ROOT_KEEP) {
    throw new Error(`${ROOT} is ${formatNear(missing + ROOT_KEEP - rootFree)} NEAR short of the plan; run again with --faucet <NEAR>`);
  }

  console.log("sub-accounts");
  for (const p of PLAN) await ensureSubAccount(p.name, parseNear(p.near));
  if (dry) return;

  console.log("mock tokens");
  const wnear = await ensureToken("wnear", wasm);
  const usdc = await ensureToken("usdc", wasm);

  const ids = accountIds(ROOT);
  const ops = { keeper: `keeper.${ROOT}`, maker: `maker.${ROOT}` };
  console.log("token registrations, paid by the root");
  for (const token of [wnear, usdc]) {
    for (const account of [ROOT, ...PERSONAS.map((p) => ids.personas[p]), ops.keeper, ops.maker]) {
      if (!(await ensureStorage(ROOT, token.accountId, account))) console.log(`  ${account} on ${token.symbol}: registered`);
    }
  }

  const previous = await readDeployments();
  const deployments: Deployments = {
    ...(previous ?? {}),
    network: NETWORK,
    rpcUrl: DEFAULT_RPC_URL,
    explorer: EXPLORER,
    ...ids,
    tokens: { wnear, usdc },
    contract: previous?.contractId === ids.contractId ? previous.contract : null,
    ops: { ...(previous?.ops ?? {}), ...ops },
    updatedAt: "",
  };
  await writeDeployments(deployments);
  console.log(`deployments/${NETWORK}.json written`);
  console.log(
    `faucet caps: ${formatUnits(BigInt(wnear.maxMintPerCall), wnear.decimals)} wNEAR and ${formatUnits(BigInt(usdc.maxMintPerCall), usdc.decimals)} USDC per mint call`,
  );
  console.log("balances");
  await report([ROOT, ...PLAN.map((p) => `${p.name}.${ROOT}`)]);
  // registration status of the team on the tokens, for the record
  for (const t of [wnear, usdc]) {
    const missingReg: string[] = [];
    for (const a of [ROOT, ...Object.values(ids.personas), ops.keeper, ops.maker]) if (!(await storageBalanceOf(t.accountId, a))) missingReg.push(a);
    if (missingReg.length > 0) throw new Error(`not registered on ${t.symbol}: ${missingReg.join(", ")}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
