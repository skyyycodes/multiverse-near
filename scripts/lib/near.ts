// Thin layer over near-api-js 7.4 for the scripts: one RPC provider, keys from key files, one
// in-flight transaction per signer, and outcome checks that treat any failed receipt as a failure.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
  baseEncode,
  type Action,
  type KeyPairString,
  type Provider,
  type TxExecutionStatus,
} from "near-api-js";
import {
  AccessKeyDoesNotExistError,
  AccountDoesNotExistError,
  InvalidNonceError,
  TransactionExpiredError,
  TransactionTimeoutError,
} from "near-api-js/rpc-errors";

import { tgas, u128 } from "./units.ts";

export { actions };
export type { Action };

export type Network = "testnet" | "sandbox";

export interface NetworkConfig {
  network: Network;
  rpcUrl: string;
  /** "" for the local sandbox, which has no explorer. */
  explorer: string;
  /** Parent of every account the scripts create. */
  defaultRoot: string;
}

export const NETWORKS: Record<Network, NetworkConfig> = {
  testnet: {
    network: "testnet",
    rpcUrl: "https://test.rpc.fastnear.com",
    explorer: "https://testnet.nearblocks.io",
    defaultRoot: "multiverse-lending.testnet",
  },
  sandbox: { network: "sandbox", rpcUrl: "http://127.0.0.1:3030", explorer: "", defaultRoot: "test.near" },
};

export function parseNetwork(value: string): Network {
  if (value === "testnet" || value === "sandbox") return value;
  throw new Error(`NEAR_NETWORK must be testnet or sandbox, not "${value}"`);
}

export const NETWORK: Network = parseNetwork(process.env.NEAR_NETWORK || "testnet");
export const NETWORK_CONFIG = NETWORKS[NETWORK];
export const DEFAULT_RPC_URL = NETWORK_CONFIG.rpcUrl;
export const RPC_URL = process.env.NEAR_RPC_URL || DEFAULT_RPC_URL;
export const EXPLORER = NETWORK_CONFIG.explorer;
export const explorerTx = (hash: string): string => (EXPLORER ? `${EXPLORER}/txns/${hash}` : hash);
export const explorerAccount = (id: string): string => (EXPLORER ? `${EXPLORER}/address/${id}` : id);

// EXECUTED_OPTIMISTIC already includes every receipt's outcome; FINAL waits a couple of blocks more.
export const WAIT_UNTIL: TxExecutionStatus = parseWaitUntil(process.env.NEAR_WAIT_UNTIL ?? "FINAL");

export const ONE_YOCTO = 1n;
export const DEFAULT_GAS = tgas(30);
export const FT_TRANSFER_CALL_GAS = tgas(300);

export const provider: Provider = new JsonRpcProvider({ url: RPC_URL });

export type TxOutcome = Awaited<ReturnType<Provider["sendTransactionUntil"]>>;

/**
 * Only the levels whose RPC answer carries the transaction and receipt outcomes. NONE, INCLUDED and
 * INCLUDED_FINAL come back without them, and checkOutcome could never see a failed receipt.
 */
export function parseWaitUntil(value: string): TxExecutionStatus {
  const allowed: TxExecutionStatus[] = ["EXECUTED_OPTIMISTIC", "EXECUTED", "FINAL"];
  const found = allowed.find((s) => s === value);
  if (!found) throw new Error(`NEAR_WAIT_UNTIL must be one of ${allowed.join(", ")}, not "${value}"`);
  return found;
}

// Keys

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** Where new keys are written: `<repo>/.keys/<network>/<account>.json` (gitignored). */
export const KEYS_DIR = process.env.NEAR_KEYS_DIR || join(REPO_ROOT, ".keys", NETWORK);
// near-cli keeps no sandbox keys, and a stale sandbox key there would only mislead.
const LEGACY_KEYCHAIN = NETWORK === "testnet" ? join(homedir(), ".near-credentials", NETWORK) : undefined;

/** near-cli's legacy keychain format, also read by `sign-with-access-key-file`. */
export interface KeyFile {
  account_id: string;
  public_key: string;
  private_key: string;
}

/**
 * `variant` names an extra key of the same account, e.g. "report" for the resolver's
 * function-call key in `resolver.<root>.report.json`. Only the repo's key dirs hold those.
 */
export function keyFileCandidates(accountId: string, variant?: string): string[] {
  const file = variant ? `${accountId}.${variant}.json` : `${accountId}.json`;
  const dirs = [KEYS_DIR, join(process.cwd(), ".keys", NETWORK), ...(variant || !LEGACY_KEYCHAIN ? [] : [LEGACY_KEYCHAIN])];
  return [...new Set(dirs)].map((dir) => join(dir, file));
}

export function findKeyFile(accountId: string, variant?: string): string | undefined {
  return keyFileCandidates(accountId, variant).find((path) => existsSync(path));
}

export async function loadKeyPair(accountId: string, variant?: string): Promise<KeyPair> {
  const path = findKeyFile(accountId, variant);
  if (!path) {
    const looked = keyFileCandidates(accountId, variant).join("\n  ");
    throw new Error(`no ${variant ? `"${variant}" ` : ""}key for ${accountId}; looked in:\n  ${looked}`);
  }
  return loadKeyPairFile(path, accountId);
}

/** Reads one key file in near-cli's legacy format and checks it belongs to `accountId`. */
export async function loadKeyPairFile(path: string, accountId: string): Promise<KeyPair> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<KeyFile> & { secret_key?: string };
  const secret = parsed.private_key ?? parsed.secret_key;
  if (!secret || !/^(ed25519|secp256k1):/.test(secret)) throw new Error(`${path} has no private_key`);
  if (parsed.account_id && parsed.account_id !== accountId) {
    throw new Error(`${path} belongs to ${parsed.account_id}, not ${accountId}`);
  }
  const keyPair = KeyPair.fromString(secret as KeyPairString);
  if (parsed.public_key && parsed.public_key !== keyPair.getPublicKey().toString()) {
    throw new Error(`${path}: public_key does not match private_key`);
  }
  return keyPair;
}

export const newKeyPair = (): KeyPair => KeyPair.fromRandom("ed25519");

/** Writes a key file (0600 in a 0700 dir). Refuses to replace a different key for the account. */
export async function saveKeyFile(accountId: string, keyPair: KeyPair, variant?: string): Promise<string> {
  const path = join(KEYS_DIR, variant ? `${accountId}.${variant}.json` : `${accountId}.json`);
  const body: KeyFile = {
    account_id: accountId,
    public_key: keyPair.getPublicKey().toString(),
    private_key: keyPair.toString(),
  };
  if (existsSync(path)) {
    const existing = JSON.parse(await readFile(path, "utf8")) as Partial<KeyFile>;
    if (existing.private_key === body.private_key) return path;
    throw new Error(`${path} already holds another key; move it away first`);
  }
  await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return path;
}

export async function removeKeyFile(accountId: string, variant?: string): Promise<void> {
  await rm(join(KEYS_DIR, variant ? `${accountId}.${variant}.json` : `${accountId}.json`), { force: true });
}

export type AccessKeyInfo = Awaited<ReturnType<Provider["viewAccessKey"]>>;

export async function accessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo | null> {
  try {
    return await provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: "final" } });
  } catch (err) {
    if (err instanceof AccessKeyDoesNotExistError) return null;
    throw err;
  }
}

// Accounts and sequential signing

const keyPairs = new Map<string, Promise<KeyPair>>();
// An Account caches the next nonce of its key, so it is dropped and rebuilt after a nonce error.
const signers = new Map<string, Account>();
const queues = new Map<string, Promise<unknown>>();
const signerKey = (accountId: string, variant?: string): string => (variant ? `${accountId}#${variant}` : accountId);

function keyPairFor(accountId: string, variant?: string): Promise<KeyPair> {
  const key = signerKey(accountId, variant);
  let keyPair = keyPairs.get(key);
  if (!keyPair) {
    keyPair = loadKeyPair(accountId, variant);
    keyPairs.set(key, keyPair);
    keyPair.catch(() => keyPairs.delete(key));
  }
  return keyPair;
}

export async function signerAccount(accountId: string, variant?: string): Promise<Account> {
  const key = signerKey(accountId, variant);
  const cached = signers.get(key);
  if (cached) return cached;
  const account = new Account(accountId, provider, new KeyPairSigner(await keyPairFor(accountId, variant)));
  signers.set(key, account);
  return account;
}

/** Signs for `accountId` with a key held in memory, e.g. one created moments ago. */
export function useKeyPair(accountId: string, keyPair: KeyPair, variant?: string): void {
  const key = signerKey(accountId, variant);
  keyPairs.set(key, Promise.resolve(keyPair));
  signers.delete(key);
}

// One transaction at a time per key: parallel sends from one key race for nonces.
function oneAtATime<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  queues.set(key, run.catch(() => undefined));
  return run;
}

export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId, blockQuery: { finality: "final" } });
    return true;
  } catch (err) {
    if (err instanceof AccountDoesNotExistError) return false;
    throw err;
  }
}

export interface NearBalance {
  total: bigint;
  locked: bigint;
  /** Bytes of state; NEAR locks 1e19 yocto per byte for it. */
  storageUsage: number;
  codeHash: string;
}

export async function nearBalance(accountId: string): Promise<NearBalance> {
  const view = await provider.viewAccount({ accountId, blockQuery: { finality: "final" } });
  return { total: BigInt(view.amount), locked: BigInt(view.locked), storageUsage: view.storage_usage, codeHash: view.code_hash };
}

export const STORAGE_BYTE_COST = 10n ** 19n;

/** Balance not locked for storage, i.e. what the account can actually spend or send. */
export const spendable = (b: NearBalance): bigint => b.total - BigInt(b.storageUsage) * STORAGE_BYTE_COST;

// Sending and checking

export interface TxResult {
  hash: string;
  outcome: TxOutcome;
  /** Logs of the transaction and every receipt, in execution order. */
  logs: string[];
  gasBurnt: bigint;
  /** The final SuccessValue, base64-decoded ("" when the call returned nothing). */
  returnText: string;
}

export class TxFailedError extends Error {
  readonly hash: string;
  readonly logs: string[];
  constructor(message: string, hash: string, logs: string[]) {
    super(`${message}\n  tx ${explorerTx(hash)}`);
    this.name = "TxFailedError";
    this.hash = hash;
    this.logs = logs;
  }
}

function describeFailure(failure: unknown): string {
  const text = JSON.stringify(failure);
  const panic = /"ExecutionError":"((?:[^"\\]|\\.)*)"/.exec(text);
  if (panic?.[1]) return JSON.parse(`"${panic[1]}"`) as string;
  return text;
}

function failureOf(status: unknown): unknown {
  if (typeof status === "object" && status !== null && "Failure" in status) return status.Failure;
  return undefined;
}

/**
 * Throws unless the transaction and every receipt it spawned succeeded. NEP-141 callbacks swallow
 * failures (a panicking ft_on_transfer is refunded and the transaction still ends in SuccessValue),
 * so the final status alone is not enough.
 */
export function checkOutcome(outcome: TxOutcome, label: string): TxResult {
  const hash = outcome.transaction_outcome.id;
  const all = [outcome.transaction_outcome, ...outcome.receipts_outcome];
  const logs = all.flatMap((o) => o.outcome.logs);
  const gasBurnt = all.reduce((sum, o) => sum + BigInt(o.outcome.gas_burnt), 0n);

  for (const o of all) {
    const failure = failureOf(o.outcome.status);
    if (failure !== undefined) {
      throw new TxFailedError(`${label}: receipt on ${o.outcome.executor_id} failed: ${describeFailure(failure)}`, hash, logs);
    }
  }
  const status: unknown = outcome.status;
  const finalFailure = failureOf(status);
  if (finalFailure !== undefined) throw new TxFailedError(`${label}: ${describeFailure(finalFailure)}`, hash, logs);
  if (typeof status !== "object" || status === null || !("SuccessValue" in status) || typeof status.SuccessValue !== "string") {
    throw new TxFailedError(`${label}: transaction not finished (status ${JSON.stringify(status)})`, hash, logs);
  }
  const returnText = Buffer.from(status.SuccessValue, "base64").toString("utf8");
  return { hash, outcome, logs, gasBurnt, returnText };
}

export interface SendOptions {
  waitUntil?: TxExecutionStatus;
  /** Sign with `<signer>.<keyVariant>.json` instead of the account's main key. */
  keyVariant?: string;
  /** Printed with the result; defaults to "signer -> receiver". */
  label?: string;
  quiet?: boolean;
}

export async function sendTransaction(
  signerId: string,
  receiverId: string,
  txActions: Action[],
  options: SendOptions = {},
): Promise<TxResult> {
  const waitUntil = options.waitUntil ?? WAIT_UNTIL;
  const label = options.label ?? `${signerId} -> ${receiverId}`;
  const key = signerKey(signerId, options.keyVariant);
  const outcome = await oneAtATime(key, async () => {
    for (let attempt = 1; ; attempt++) {
      const account = await signerAccount(signerId, options.keyVariant);
      const signed = await account.createSignedTransaction({ receiverId, actions: txActions });
      const hash = baseEncode(createHash("sha256").update(signed.transaction.encode()).digest());
      try {
        return await provider.sendTransactionUntil(signed, waitUntil);
      } catch (err) {
        if ((err instanceof InvalidNonceError || err instanceof TransactionExpiredError) && attempt < 3) {
          // Someone else used this key, or the block it references is too old (the sandbox can
          // skip blocks): forget the cached nonce and sign again over a fresh block hash.
          signers.delete(key);
          continue;
        }
        if (err instanceof TransactionTimeoutError) return waitForTransaction(hash, signerId, waitUntil);
        throw err;
      }
    }
  });
  const result = checkOutcome(outcome, label);
  if (!options.quiet) console.log(`  ${label}: ok (${formatTgas(result.gasBurnt)} Tgas) ${explorerTx(result.hash)}`);
  return result;
}

/** Polls the status of a transaction that the RPC gave up waiting for. */
export async function waitForTransaction(hash: string, signerId: string, waitUntil: TxExecutionStatus, timeoutMs = 90_000): Promise<TxOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await provider.viewTransactionStatusWithReceipts({ txHash: hash, accountId: signerId, waitUntil });
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`transaction ${hash} did not reach ${waitUntil} in ${timeoutMs / 1000} s: ${String(err)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

const formatTgas = (gas: bigint): string => (Number(gas / 10n ** 9n) / 1000).toFixed(1);

export interface CallOptions extends SendOptions {
  gas?: bigint;
  deposit?: bigint;
}

export interface CallResult<T> extends TxResult {
  value: T | undefined;
}

export async function call<T = unknown>(
  signerId: string,
  contractId: string,
  method: string,
  args: Record<string, unknown> = {},
  options: CallOptions = {},
): Promise<CallResult<T>> {
  const action = actions.functionCall(method, args, options.gas ?? DEFAULT_GAS, options.deposit ?? 0n);
  const result = await sendTransaction(signerId, contractId, [action], {
    ...options,
    label: options.label ?? `${signerId} -> ${contractId}.${method}`,
  });
  const value = result.returnText === "" ? undefined : (JSON.parse(result.returnText) as T);
  return { ...result, value };
}

export async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } })) as T;
}

export interface FtTransferCallOptions extends CallOptions {
  memo?: string;
  /** Accept a partial refund (e.g. repay with a buffer). Default: the receiver must use everything. */
  allowRefund?: boolean;
}

/**
 * The amount an `ft_transfer_call` actually delivered, i.e. the token's final return value.
 * Anything short of `sent` went back to the sender, so unless `allowRefund` is set that is an error
 * even when every receipt succeeded.
 */
export function transferCallUsed(result: TxResult, sent: bigint, label: string, allowRefund = false): bigint {
  let returned: unknown;
  try {
    returned = JSON.parse(result.returnText);
  } catch {
    returned = result.returnText;
  }
  const used = u128(returned, `${label}: used amount`);
  if (used > sent) throw new TxFailedError(`${label}: token reports ${used} used, more than the ${sent} sent`, result.hash, result.logs);
  if (!allowRefund && used !== sent) {
    throw new TxFailedError(`${label}: receiver used ${used} of ${sent}; the rest was refunded`, result.hash, result.logs);
  }
  return used;
}

/**
 * `ft_transfer_call` with 1 yocto. A receiver that panics is refunded in full by
 * `ft_resolve_transfer` while the transaction itself still ends in success, so this fails on the
 * receiver's failed receipt and on any amount that came back unused.
 */
export async function ftTransferCall(
  signerId: string,
  tokenId: string,
  receiverId: string,
  amount: bigint,
  msg: string,
  options: FtTransferCallOptions = {},
): Promise<CallResult<string> & { used: bigint }> {
  const label = options.label ?? `${signerId} -> ${tokenId}.ft_transfer_call(${receiverId}, ${amount})`;
  const result = await call<string>(
    signerId,
    tokenId,
    "ft_transfer_call",
    { receiver_id: receiverId, amount: amount.toString(), memo: options.memo ?? null, msg },
    { ...options, gas: options.gas ?? FT_TRANSFER_CALL_GAS, deposit: ONE_YOCTO, label },
  );
  return { ...result, used: transferCallUsed(result, amount, label, options.allowRefund) };
}

// NEP-145

export interface StorageBalance {
  total: string;
  available: string;
}

export async function storageBalanceOf(contractId: string, accountId: string): Promise<StorageBalance | null> {
  return view<StorageBalance | null>(contractId, "storage_balance_of", { account_id: accountId });
}

export interface EnsureStorageOptions {
  /** Deposit for a new registration. Default: the contract's minimum. */
  deposit?: bigint;
  /** Also top an existing registration up until at least this much is available for new bytes. */
  minAvailable?: bigint;
}

export interface StorageDepositPlan {
  amount: bigint;
  registrationOnly: boolean;
}

/** What ensureStorage deposits for an account with `current` balance, or null when nothing is needed. */
export function storageDepositPlan(current: StorageBalance | null, min: bigint, options: EnsureStorageOptions = {}): StorageDepositPlan | null {
  const { deposit, minAvailable } = options;
  if (current === null) {
    const amount = deposit ?? min;
    if (minAvailable === undefined) return { amount, registrationOnly: true };
    // the minimum pays for the registration record, the rest stays available
    const needed = min + minAvailable;
    return { amount: amount > needed ? amount : needed, registrationOnly: false };
  }
  if (minAvailable === undefined) return null;
  const available = u128(current.available, "storage_balance_of.available");
  return available >= minAvailable ? null : { amount: minAvailable - available, registrationOnly: false };
}

/**
 * Registers `accountId` on `contractId` (paid by `payerId`) unless it already is, and with
 * `minAvailable` tops an existing registration up. Returns true if it paid.
 */
export async function ensureStorage(
  payerId: string,
  contractId: string,
  accountId: string,
  options: EnsureStorageOptions = {},
): Promise<boolean> {
  const current = await storageBalanceOf(contractId, accountId);
  let min = 0n;
  if (current === null) {
    const bounds = await view<{ min: string; max: string | null }>(contractId, "storage_balance_bounds");
    min = u128(bounds.min, "storage_balance_bounds.min");
  }
  const plan = storageDepositPlan(current, min, options);
  if (plan === null) return false;
  await call(payerId, contractId, "storage_deposit", { account_id: accountId, registration_only: plan.registrationOnly }, {
    deposit: plan.amount,
    label: `${payerId} -> ${contractId}.storage_deposit(${accountId}${current ? ", top-up" : ""})`,
  });
  return true;
}
