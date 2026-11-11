// The local sandbox node from the test's side: persona keys from .keys/sandbox, view calls, block time, fast-forward,
// and the demo wallet that signs what the app asks for with those keys.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Account, actions, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import type { BrowserContext } from "@playwright/test";

const REPO = join(__dirname, "..", "..", "..");
export const deployment = JSON.parse(readFileSync(join(REPO, "deployments", "sandbox.json"), "utf8")) as {
  rpcUrl: string;
  root: string;
  contractId: string;
  weth: string;
  usdc: string;
  personas: Record<string, string>;
};
const RPC = deployment.rpcUrl;
export const CONTRACT = deployment.contractId;
export const persona = (name: string): string => (name === "owner" ? deployment.root : deployment.personas[name]);

const provider = new JsonRpcProvider({ url: RPC });

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "e2e", method, params }) });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
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

type BlockHeader = { header: { height: number; timestamp_nanosec: string } };

export async function chainNowSec(): Promise<number> {
  const b = await rpc<BlockHeader>("block", { finality: "final" });
  return Number(BigInt(b.header.timestamp_nanosec) / 1_000_000_000n);
}

/**
 * The node answers sandbox_fast_forward before it has made the jump; a transaction signed over a final block from
 * before it would arrive expired, so this waits until the final block is past the jump.
 */
async function fastForward(blocks: number): Promise<void> {
  const target = (await rpc<BlockHeader>("block", { finality: "optimistic" })).header.height + blocks;
  await rpc("sandbox_fast_forward", { delta_height: blocks });
  const deadline = Date.now() + 60_000;
  while ((await rpc<BlockHeader>("block", { finality: "final" })).header.height < target) {
    if (Date.now() > deadline) throw new Error(`sandbox_fast_forward: no final block at height ${target} after 60 s`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Skips blocks until a final block is at or past `target` (unix seconds). */
export async function fastForwardTo(target: number): Promise<void> {
  let now = await chainNowSec();
  let secPerBlock = 0.5;
  while (now < target) {
    const blocks = Math.min(2_000, Math.max(2, Math.ceil((target - now) / secPerBlock) + 2));
    const before = now;
    await fastForward(blocks);
    now = await chainNowSec();
    if (now > before) secPerBlock = Math.max(0.05, (now - before) / blocks);
  }
}

function signer(accountId: string): Account {
  const file = join(REPO, ".keys", "sandbox", `${accountId}.json`);
  const key = JSON.parse(readFileSync(file, "utf8")) as { private_key: string };
  return new Account(accountId, provider, new KeyPairSigner(KeyPair.fromString(key.private_key as KeyPairString)));
}

/** Mints test tokens to a persona's wallet off camera (the mock tokens' mint is open and registers the receiver). */
export async function fund(accountId: string, amounts: { weth?: bigint; usdc?: bigint }): Promise<void> {
  const account = signer(accountId);
  for (const [token, amount] of [
    [deployment.weth, amounts.weth],
    [deployment.usdc, amounts.usdc],
  ] as const) {
    if (!amount) continue;
    const r = await account.signAndSendTransaction({
      receiverId: token,
      actions: [actions.functionCall("mint", { account_id: accountId, amount: amount.toString() }, 30_000_000_000_000n, 0n)],
      waitUntil: "FINAL",
    });
    if (typeof r.status === "object" && "Failure" in r.status) throw new Error(`mint on ${token} failed: ${JSON.stringify(r.status)}`);
  }
}

/** The resolver's report, as the resolver script sends it: opens a proposal that waits out the dispute window. */
export async function report(eventId: number, outcome: number): Promise<void> {
  const r = await signer(deployment.personas.resolver).signAndSendTransaction({
    receiverId: CONTRACT,
    actions: [actions.functionCall("report_outcome", { event_id: eventId, outcome, target: CONTRACT, evidence: "e2e" }, 30_000_000_000_000n, 0n)],
    waitUntil: "FINAL",
  });
  if (typeof r.status === "object" && "Failure" in r.status) throw new Error(`report_outcome failed: ${JSON.stringify(r.status)}`);
}

type WalletTx = {
  receiverId: string;
  actions: { type: string; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } }[];
};

/** Exposes `window.__nearDemo` signing as `accountId`, and connects it on load. Every signed transaction is logged. */
export async function demoWallet(context: BrowserContext, accountId: string, log: WalletTx[] = []): Promise<WalletTx[]> {
  const account = signer(accountId);
  const send = async (tx: WalletTx) => {
    log.push(tx);
    return account.signAndSendTransaction({
      receiverId: tx.receiverId,
      actions: tx.actions.map((a) => actions.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit))),
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
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
  await context.addInitScript(() => {
    (window as unknown as { __nearDemoAutoConnect: boolean }).__nearDemoAutoConnect = true;
    try {
      localStorage.setItem("multiverse.welcomed", "1");
    } catch {}
  });
  return log;
}

const WAD = 10n ** 18n;

/** As the app prints USDC amounts: truncated to cents, thousands separated. */
export function usd(wad: string | bigint): string {
  const v = BigInt(wad);
  const cents = (v * 100n) / WAD;
  const whole = (cents / 100n).toLocaleString("en-US");
  return `${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** A WAD ratio (a health factor) as two decimals, truncated. */
export const ratio = (wad: string | bigint): string => usd(wad);
