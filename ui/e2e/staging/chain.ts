// The staging deployment on the public testnet from the test's side (adapted from web/e2e/staging/chain.ts for the ui): keys from NEAR_KEYS_DIR (or the repo's
// gitignored .keys/staging), rate-limit-tolerant view calls, a fresh sub-account for the first-visit flow, and the demo
// wallet that signs what the app asks for. Nothing here fast-forwards: staging runs in real time.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, actions, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import type { BrowserContext } from "@playwright/test";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
export const deployment = JSON.parse(readFileSync(join(REPO, "deployments", "staging.json"), "utf8")) as {
  rpcUrl: string;
  root: string;
  contractId: string;
  wnear: string;
  usdc: string;
  personas: Record<string, string>;
};
// Not the page's first RPC (dRPC, ui/src/chain/env.ts): the harness's own polling would spend the page's rate limit,
// and a 429 from it arrives without CORS headers, which the browser logs as a console error. FastNEAR, the page's
// fallback, from docs.near.org's provider list; rpc.testnet.near.org is deprecated and throttled.
const RPC = process.env.STAGING_RPC || "https://test.rpc.fastnear.com";
export const CONTRACT = deployment.contractId;
export const ROOT = deployment.root;
export const persona = (name: string): string => (name === "owner" ? deployment.root : (deployment.personas[name] ?? `${name}.${deployment.root}`));

/** Where existing keys are read from, and where keys of accounts the spec creates are written (NEAR_KEYS_DIR first, so a
 *  worktree keeps them with the others; both gitignored). */
const KEY_DIRS = [process.env.NEAR_KEYS_DIR, join(REPO, ".keys", "staging")].filter((d): d is string => Boolean(d));
const NEW_KEYS = process.env.NEAR_KEYS_DIR || join(REPO, ".keys", "staging");

const provider = new JsonRpcProvider({ url: RPC });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The public RPC's "slow down": nothing was processed, so the same call may simply be sent again. */
const RATE_LIMITED = /Rate limits exceeded|-429|HTTP 429|Too Many Requests/;

/** Retries a call the RPC turned away for rate limiting, with backoff (about a minute in all). */
async function patient<T>(f: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await f();
    } catch (e) {
      if (attempt >= 6 || !RATE_LIMITED.test(String((e as Error)?.message ?? e))) throw e;
      await sleep(1_000 * 2 ** Math.min(attempt, 4));
    }
  }
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "e2e", method, params }) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: unknown };
      if (body.error) throw Object.assign(new Error(`${method}: ${JSON.stringify(body.error)}`), { rpc: !RATE_LIMITED.test(JSON.stringify(body.error)) });
      return body.result as T;
    } catch (e) {
      if ((e as { rpc?: boolean }).rpc || attempt >= 8) throw e;
      await sleep(Math.min(10_000, 500 * 2 ** attempt));
    }
  }
}

export async function view<T>(method: string, args: Record<string, unknown> = {}, contractId = CONTRACT): Promise<T> {
  const r = await rpc<{ result?: number[]; error?: string }>("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (r.error) throw new Error(r.error);
  return JSON.parse(Buffer.from(r.result ?? []).toString() || "null") as T;
}

export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await rpc("query", { request_type: "view_account", finality: "final", account_id: accountId });
    return true;
  } catch {
    return false;
  }
}

/** Free NEAR (yocto) of an account. */
export async function nearBalance(accountId: string): Promise<bigint> {
  const a = await rpc<{ amount: string }>("query", { request_type: "view_account", finality: "final", account_id: accountId });
  return BigInt(a.amount);
}

function keyFile(accountId: string): string {
  for (const dir of KEY_DIRS) {
    const f = join(dir, `${accountId}.json`);
    if (existsSync(f)) return f;
  }
  throw new Error(`no key for ${accountId} in ${KEY_DIRS.join(", ")}`);
}

export { patient };

export function signer(accountId: string): Account {
  const key = JSON.parse(readFileSync(keyFile(accountId), "utf8")) as { private_key: string };
  return new Account(accountId, provider, new KeyPairSigner(KeyPair.fromString(key.private_key as KeyPairString)));
}

type Outcome = { status: unknown; transaction: { hash: string } };
const failed = (r: Outcome) => typeof r.status === "object" && r.status !== null && "Failure" in r.status;

/**
 * A sub-account of the staging root with `near` yocto and a full-access key written to the gitignored key dir.
 * An account that already exists (a re-run) is reused as is.
 */
export async function ensureSubAccount(name: string, near: bigint): Promise<{ accountId: string; created: boolean; hash?: string }> {
  const accountId = `${name}.${ROOT}`;
  if (await accountExists(accountId)) return { accountId, created: false };
  const kp = KeyPair.fromRandom("ed25519");
  mkdirSync(NEW_KEYS, { recursive: true });
  writeFileSync(join(NEW_KEYS, `${accountId}.json`), JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  const r = (await patient(() =>
    signer(ROOT).signAndSendTransaction({
      receiverId: accountId,
      actions: [actions.createAccount(), actions.transfer(near), actions.addFullAccessKey(kp.getPublicKey())],
      waitUntil: "FINAL",
    }),
  )) as unknown as Outcome;
  if (failed(r)) throw new Error(`create ${accountId} failed: ${JSON.stringify(r.status)}`);
  return { accountId, created: true, hash: r.transaction.hash };
}

/** Sends `near` yocto from the root to an account (a top-up for a heavy call). */
export async function topUp(accountId: string, near: bigint): Promise<string> {
  const r = (await patient(() => signer(ROOT).signAndSendTransaction({ receiverId: accountId, actions: [actions.transfer(near)], waitUntil: "FINAL" }))) as unknown as Outcome;
  if (failed(r)) throw new Error(`top-up ${accountId} failed`);
  return r.transaction.hash;
}

let sending = 0;
/** Resolves once no demo-wallet transaction is still waiting for its final outcome (the chain views lead by a block). */
export async function walletIdle(ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (sending > 0 && Date.now() < end) await sleep(250);
}

export type WalletTx = {
  receiverId: string;
  actions: { type: string; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } }[];
};
export type Signed = { tx: WalletTx; hash: string; ok: boolean; error?: string };

/**
 * Exposes `window.__nearDemo` signing as `accountId`, and connects it on load. Every signed transaction is logged.
 * `welcomed: false` leaves the first-visit intro (Onboarding) in place; `autoConnect: false` leaves the page
 * disconnected until the visitor presses Connect and picks the demo wallet.
 */
export async function demoWallet(context: BrowserContext, accountId: string, log: Signed[] = [], o: { welcomed?: boolean; autoConnect?: boolean } = {}): Promise<Signed[]> {
  const account = signer(accountId);
  const send = async (tx: WalletTx) => {
    sending++;
    try {
      return await sendNow(tx);
    } finally {
      sending--;
    }
  };
  const sendNow = async (tx: WalletTx) => {
    const r = (await patient(() =>
      account.signAndSendTransaction({
        receiverId: tx.receiverId,
        actions: tx.actions.map((a) => actions.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit))),
        waitUntil: "FINAL",
        throwOnFailure: false,
      }),
    )) as unknown as Outcome;
    log.push({ tx, hash: r.transaction.hash, ok: !failed(r), error: failed(r) ? JSON.stringify(r.status).slice(0, 400) : undefined });
    return r;
  };
  await context.exposeFunction("__nearDemo", async (method: string, json: string) => {
    const params = JSON.parse(json || "{}") as { transactions?: WalletTx[] } & WalletTx;
    switch (method) {
      case "signIn":
      case "getAccounts":
        return JSON.stringify([{ accountId }]);
      case "signOut":
        return "";
      case "signAndSendTransaction":
        return JSON.stringify(await send(params));
      case "signAndSendTransactions": {
        const out = [];
        for (const tx of params.transactions ?? []) out.push(await send(tx));
        return JSON.stringify(out);
      }
      default:
        throw new Error(`The test wallet does not do ${method}`);
    }
  });
  await context.addInitScript(([welcomed, auto]: [boolean, boolean]) => {
    (window as unknown as { __nearDemoAutoConnect: boolean }).__nearDemoAutoConnect = auto;
    try {
      if (welcomed) localStorage.setItem("ov-intro-seen", "1");
    } catch {}
  }, [o.welcomed ?? true, o.autoConnect ?? true] as [boolean, boolean]);
  return log;
}

const WAD = 10n ** 18n;
/** As the app prints USDC amounts: truncated to cents, thousands separated. */
export function usd(wad: string | bigint): string {
  const v = BigInt(wad);
  const cents = (v * 100n) / WAD;
  return `${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}
export const toWad = (whole: number | bigint): bigint => BigInt(whole) * WAD;
