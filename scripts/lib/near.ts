// Thin layer over near-api-js 7.4 for the scripts: four networks on two chains, every RPC call
// through one endpoint pool (rpc.ts), keys from key files, one in-flight transaction per signer,
// sends that survive rate limits without ever re-signing a transaction that may still land, a gas
// float check before signing, block-pinned reads with an archival fallback, and outcome checks
// that treat any failed receipt as a failure.

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Account,
  KeyPair,
  KeyPairSigner,
  actions,
  baseEncode,
  type Action,
  type JsonRpcProvider,
  type KeyPairString,
  type Provider,
  type SignedTransaction,
  type TxExecutionStatus,
} from "near-api-js";
import { AccessKeyDoesNotExistError, AccountDoesNotExistError } from "near-api-js/rpc-errors";

import {
  classifyRpcError,
  endpointsFor,
  endpointsFromEnv,
  errorText,
  isMissingBlock,
  pooledProvider,
  RpcPool,
  systemClock,
  type Clock,
  type RunOptions,
} from "./rpc.ts";
import { parseNear, tgas, u128 } from "./units.ts";

export { actions };
export type { Action };

// Networks

/** `testnet` is the live production deployment; `staging` the live v2 app on the same chain. */
export type Network = "testnet" | "staging" | "sandbox" | "rehearsal";
/** What the network runs on: name checks that are really about the chain test this. */
export type Chain = "testnet" | "sandbox";

export interface NetworkConfig {
  network: Network;
  chain: Chain;
  /** First = primary. */
  rpcUrls: readonly string[];
  /** "" on sandbox chains, which have no explorer. */
  explorer: string;
  /** Parent of every account the scripts create. */
  defaultRoot: string;
  /** Whether near-cli's `~/.near-credentials/testnet` may hold keys: production only. */
  legacyKeychain: boolean;
}

const TESTNET_RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"] as const;
const LOCAL_RPC = ["http://127.0.0.1:3030"] as const;

export const NETWORKS: Record<Network, NetworkConfig> = {
  testnet: {
    network: "testnet",
    chain: "testnet",
    rpcUrls: TESTNET_RPCS,
    explorer: "https://testnet.nearblocks.io",
    defaultRoot: "multiverse-near.testnet",
    legacyKeychain: true,
  },
  staging: {
    network: "staging",
    chain: "testnet",
    rpcUrls: TESTNET_RPCS,
    explorer: "https://testnet.nearblocks.io",
    defaultRoot: "ifverse-staging.testnet",
    legacyKeychain: false,
  },
  sandbox: { network: "sandbox", chain: "sandbox", rpcUrls: LOCAL_RPC, explorer: "", defaultRoot: "test.near", legacyKeychain: false },
  rehearsal: {
    network: "rehearsal",
    chain: "sandbox",
    rpcUrls: LOCAL_RPC,
    explorer: "",
    defaultRoot: "multiverse-near.testnet",
    legacyKeychain: false,
  },
};

export const NETWORK_NAMES = Object.keys(NETWORKS) as Network[];

export function parseNetwork(value: string): Network {
  const found = NETWORK_NAMES.find((n) => n === value);
  if (!found) throw new Error(`NEAR_NETWORK must be one of ${NETWORK_NAMES.join(", ")}, not "${value}"`);
  return found;
}

/** Whether NEAR_NETWORK was set. Read-only commands default to testnet; state-changing ones refuse. */
export const NETWORK_EXPLICIT = (process.env.NEAR_NETWORK ?? "") !== "";
export const NETWORK: Network = parseNetwork(process.env.NEAR_NETWORK || "testnet");
export const NETWORK_CONFIG = NETWORKS[NETWORK];
export const CHAIN: Chain = NETWORK_CONFIG.chain;
export const DEFAULT_RPC_URL = NETWORK_CONFIG.rpcUrls[0] ?? "";
/** One URL for code that needs a single endpoint (sandbox-only RPC methods). */
export const RPC_URL = process.env.NEAR_RPC_URL || endpointsFromEnv(NETWORK_CONFIG)[0]?.url || DEFAULT_RPC_URL;
export const EXPLORER = NETWORK_CONFIG.explorer;
export const explorerTx = (hash: string): string => (EXPLORER ? `${EXPLORER}/txns/${hash}` : hash);
export const explorerAccount = (id: string): string => (EXPLORER ? `${EXPLORER}/address/${id}` : id);

// EXECUTED_OPTIMISTIC already includes every receipt's outcome; FINAL waits a couple of blocks more.
export const WAIT_UNTIL: TxExecutionStatus = parseWaitUntil(process.env.NEAR_WAIT_UNTIL ?? "FINAL");

export const ONE_YOCTO = 1n;
export const DEFAULT_GAS = tgas(30);
export const FT_TRANSFER_CALL_GAS = tgas(300);

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

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** The local node's home (data, config.json, node.pid): sandbox.ts and the rehearsal tools share it. */
export const SANDBOX_HOME = process.env.SANDBOX_HOME || join(REPO_ROOT, ".sandbox");

// The write guard

/** The owner's go-ahead for state-changing commands against the production deployment (R-8). */
export const PRODUCTION_APPROVAL_PATH = join(REPO_ROOT, "releases", "v2.0.0", "production", "APPROVAL");

export interface WriteGuardInput {
  /** NEAR_NETWORK was set. */
  explicit: boolean;
  network: Network;
  /** The production approval file exists and is not empty. */
  approvalPresent: boolean;
  /** The command has its own approval gate (upgrade.ts). */
  exempt: boolean;
}

/** Why a state-changing command must not send, or null when it may. */
export function writeRefusal(input: WriteGuardInput): string | null {
  if (!input.explicit) {
    return `NEAR_NETWORK is not set: a state-changing command needs the network named (${NETWORK_NAMES.join(", ")})`;
  }
  if (input.network === "testnet" && !input.approvalPresent && !input.exempt) {
    return `testnet is the production deployment: state-changing commands need the owner's approval file ${relative(REPO_ROOT, PRODUCTION_APPROVAL_PATH)}`;
  }
  return null;
}

/** A state-changing command refused before it sent anything. The process exits 2. */
export class WriteRefusedError extends Error {
  readonly exitCode = 2;
  constructor(reason: string) {
    super(`refused: ${reason}`);
    this.name = "WriteRefusedError";
  }
}

let testnetWritesExempt = false;
let exit2Hooked = false;

/** For upgrade.ts only, which checks its own production approval before it gets here. */
export function exemptFromTestnetApproval(): void {
  testnetWritesExempt = true;
}

function approvalPresent(): boolean {
  try {
    return statSync(PRODUCTION_APPROVAL_PATH).size > 0;
  } catch {
    return false;
  }
}

/** Throws WriteRefusedError (and makes the process exit 2) unless this process may send. */
export function assertWritable(): void {
  const why = writeRefusal({ explicit: NETWORK_EXPLICIT, network: NETWORK, approvalPresent: approvalPresent(), exempt: testnetWritesExempt });
  if (why === null) return;
  if (!exit2Hooked) {
    exit2Hooked = true;
    // the command's own catch usually sets exit code 1; a refusal is 2 whatever it does
    process.on("exit", () => {
      process.exitCode = 2;
    });
  }
  throw new WriteRefusedError(why);
}

// The RPC pool

/** Every RPC call of this process goes through this pool (rpc.ts). */
export const rpcPool: RpcPool = new RpcPool(endpointsFromEnv(NETWORK_CONFIG));
export const provider: Provider = pooledProvider(rpcPool);

const DEFAULT_ARCHIVAL = "https://archival-rpc.testnet.fastnear.com";

function archivalUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const listed = (env.NEAR_ARCHIVAL_RPC_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (listed.length > 0) return listed;
  return CHAIN === "testnet" ? [DEFAULT_ARCHIVAL] : [];
}

/** Archival endpoints (testnet chains; sandbox chains keep everything and have none). */
export const archivalPool: RpcPool | null = (() => {
  const urls = archivalUrls();
  return urls.length > 0 ? new RpcPool(endpointsFor(urls)) : null;
})();

/** Non-archival nodes keep about 35 h; older blocks and hashes are read from the archival pool. */
export const ARCHIVAL_AFTER_BLOCKS = 150_000;

export type TxOutcome = Awaited<ReturnType<Provider["sendTransactionUntil"]>>;

let headCache: { height: number; at: number } | undefined;

/** The latest final height, cached for 30 s (only used to route old reads). */
async function cachedFinalHeight(): Promise<number> {
  const now = Date.now();
  if (headCache && now - headCache.at < 30_000) return headCache.height;
  const block = await provider.viewBlock({ finality: "final" });
  headCache = { height: block.header.height, at: now };
  return headCache.height;
}

async function isOld(block: number): Promise<boolean> {
  return archivalPool !== null && (await cachedFinalHeight()) - block > ARCHIVAL_AFTER_BLOCKS;
}

/** Runs a read at `block` on the main pool, or on the archival pool for an old or unknown block. */
async function runAt<T>(block: BlockRef, task: (p: JsonRpcProvider) => Promise<T>, label: string): Promise<T> {
  if (typeof block === "number" && archivalPool && (await isOld(block))) return archivalPool.run(task, { label: `${label} (archival)` });
  try {
    return await rpcPool.run(task, { label });
  } catch (err) {
    if (typeof block === "number" && archivalPool && isMissingBlock(err)) return archivalPool.run(task, { label: `${label} (archival)` });
    throw err;
  }
}

// Block-pinned reads

/** A block height, or the latest final block. */
export type BlockRef = number | "final";

/** A JSON-RPC method near-api-js has no typed wrapper for. */
function rawRpc<T>(p: JsonRpcProvider, method: string, params: unknown): Promise<T> {
  return (p.sendJsonRpc as unknown as (m: string, params: unknown) => Promise<T>).call(p, method, params);
}

const blockQuery = (block: BlockRef): { finality: "final" } | { blockId: number } =>
  block === "final" ? { finality: "final" } : { blockId: block };

/** A view call at one block, so every view of a check reads the same state (S-4). */
export async function viewAt<T>(contractId: string, method: string, args: Record<string, unknown>, block: BlockRef): Promise<T> {
  return (await runAt(block, (p) => p.callFunction({ contractId, method, args, blockQuery: blockQuery(block) }), `${contractId}.${method}`)) as T;
}

export interface RawStateEntry {
  /** base64 */
  key: string;
  /** base64 */
  value: string;
}

/** The contract's raw key-value state at a block (RPC `view_state`, base64 as the node returns it). */
export async function viewStateAt(accountId: string, block: number): Promise<RawStateEntry[]> {
  const res = await runAt(
    block,
    (p) =>
      rawRpc<{ values: RawStateEntry[] }>(p, "query", {
        request_type: "view_state",
        account_id: accountId,
        prefix_base64: "",
        include_proof: false,
        block_id: block,
      }),
    `view_state ${accountId}`,
  );
  return res.values.map((v) => ({ key: v.key, value: v.value }));
}

export interface DataChange {
  /** What caused it: `receipt_processing` with `receipt_hash`, `transaction_processing` with `tx_hash`, ... */
  cause: { type: string; receipt_hash?: string; tx_hash?: string };
  type: "data_update" | "data_deletion";
  /** base64 */
  key: string;
  /** base64; null for a deletion */
  value: string | null;
}

interface RawChange {
  cause: { type: string; receipt_hash?: string; tx_hash?: string };
  type: string;
  change: { account_id: string; key_base64: string; value_base64?: string };
}

/** Every raw state change of `accountId` in `block`, in order (`EXPERIMENTAL_changes`, data_changes). */
export async function dataChangesAt(accountId: string, block: number): Promise<DataChange[]> {
  const res = await runAt(
    block,
    (p) =>
      rawRpc<{ changes: RawChange[] }>(p, "EXPERIMENTAL_changes", {
        changes_type: "data_changes",
        account_ids: [accountId],
        key_prefix_base64: "",
        block_id: block,
      }),
    `changes ${accountId}@${block}`,
  );
  return parseDataChanges(res.changes, accountId);
}

export function parseDataChanges(changes: readonly RawChange[], accountId: string): DataChange[] {
  return changes
    .filter((c) => c.change.account_id === accountId)
    .map((c) => {
      if (c.type !== "data_update" && c.type !== "data_deletion") throw new Error(`unexpected change type ${c.type}`);
      return {
        cause: c.cause,
        type: c.type,
        key: c.change.key_base64,
        value: c.type === "data_update" ? (c.change.value_base64 ?? "") : null,
      };
    });
}

/** The height of a block given its hash. */
export async function blockHeightOf(hash: string): Promise<number> {
  const task = (p: JsonRpcProvider): Promise<number> => p.viewBlock({ blockId: hash }).then((b) => b.header.height);
  try {
    return await rpcPool.run(task, { label: `block ${hash}` });
  } catch (err) {
    if (archivalPool && isMissingBlock(err)) return archivalPool.run(task, { label: `block ${hash} (archival)` });
    throw err;
  }
}

/** The highest block any receipt of the transaction executed in: the block to pin a post-check to. */
export async function lastReceiptHeight(outcome: TxOutcome, heightOf: (hash: string) => Promise<number> = blockHeightOf): Promise<number> {
  const hashes = new Set([outcome.transaction_outcome.block_hash, ...outcome.receipts_outcome.map((r) => r.block_hash)]);
  let max = 0;
  for (const hash of hashes) max = Math.max(max, await heightOf(hash));
  return max;
}

export interface ReceiptLogStat {
  id: string;
  executor: string;
  lines: number;
  /** UTF-8 bytes of all log lines of the receipt (the runtime's 16,384-byte budget). */
  bytes: number;
  gasTgas: number;
}

export interface ReceiptLogStats {
  maxLines: number;
  maxBytes: number;
  maxGasTgas: number;
  receipts: number;
  perReceipt: ReceiptLogStat[];
}

const toTgas = (gas: bigint | number | string): number => Number(BigInt(gas) / 1_000_000_000n) / 1000;

/** Log lines, log bytes and gas of every receipt, and the largest of each (the 100-line / 16 KiB limits). */
export function receiptLogStats(outcome: TxOutcome): ReceiptLogStats {
  const perReceipt = outcome.receipts_outcome.map((r) => ({
    id: r.id,
    executor: r.outcome.executor_id,
    lines: r.outcome.logs.length,
    bytes: r.outcome.logs.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8"), 0),
    gasTgas: toTgas(r.outcome.gas_burnt),
  }));
  return {
    maxLines: Math.max(0, ...perReceipt.map((r) => r.lines)),
    maxBytes: Math.max(0, ...perReceipt.map((r) => r.bytes)),
    maxGasTgas: Math.max(0, ...perReceipt.map((r) => r.gasTgas)),
    receipts: perReceipt.length,
    perReceipt,
  };
}

// Keys

/** Where new keys are written: `<repo>/.keys/<network>/<account>.json` (gitignored). */
export const KEYS_DIR = process.env.NEAR_KEYS_DIR || join(REPO_ROOT, ".keys", NETWORK);

/**
 * The directories a key of `cfg`'s network is looked up in, in order. near-cli's legacy keychain
 * (`~/.near-credentials/testnet`) only for production: it holds no sandbox or staging keys, and a
 * stale key there would only mislead. Variant keys live only in the repo's key dirs.
 */
export function keyDirsFor(cfg: NetworkConfig, keysDir: string, cwd: string, variant?: string, home: string = homedir()): string[] {
  const legacy = cfg.legacyKeychain && !variant ? [join(home, ".near-credentials", "testnet")] : [];
  return [...new Set([keysDir, join(cwd, ".keys", cfg.network), ...legacy])];
}

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
  return keyDirsFor(NETWORK_CONFIG, KEYS_DIR, process.cwd(), variant).map((dir) => join(dir, file));
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

// The gas float: testnet sells prepaid gas at min_gas_purchase_price (1e9 yocto/gas), so a 300 Tgas
// call needs 0.3 NEAR free before it is even accepted.

/** Kept free on top of the gas and deposits. */
export const GAS_FLOAT_MARGIN = parseNear("0.01");
export const DEFAULT_GAS_PURCHASE_PRICE = 1_000_000_000n;

export interface GasFloat {
  prepaidGas: bigint;
  deposits: bigint;
  /** prepaid gas × price + deposits + 0.01 NEAR */
  minFree: bigint;
}

/** What a signer must have free to send `txActions`: every function call's gas at `gasPrice`, plus every deposit. */
export function gasFloatOf(txActions: readonly Action[], gasPrice: bigint): GasFloat {
  let prepaidGas = 0n;
  let deposits = 0n;
  for (const a of txActions) {
    if (a.functionCall) {
      prepaidGas += BigInt(a.functionCall.gas);
      deposits += BigInt(a.functionCall.deposit);
    }
    if (a.transfer) deposits += BigInt(a.transfer.deposit);
    if (a.stake) deposits += BigInt(a.stake.stake);
  }
  return { prepaidGas, deposits, minFree: prepaidGas * gasPrice + deposits + GAS_FLOAT_MARGIN };
}

/** The signer cannot buy the transaction's prepaid gas (S-12): nothing was signed or sent. */
export class InsufficientGasFloat extends Error {
  readonly account: string;
  readonly free: bigint;
  readonly minFree: bigint;
  constructor(account: string, free: bigint, minFree: bigint) {
    super(`InsufficientGasFloat(${account}, ${free}, ${minFree}): ${account} has ${formatYocto(free)} NEAR free, needs ${formatYocto(minFree)}`);
    this.name = "InsufficientGasFloat";
    this.account = account;
    this.free = free;
    this.minFree = minFree;
  }
}

const formatYocto = (yocto: bigint): string => {
  const negative = yocto < 0n;
  const abs = negative ? -yocto : yocto;
  const whole = abs / 10n ** 24n;
  const frac = (abs % 10n ** 24n).toString().padStart(24, "0").slice(0, 4);
  return `${negative ? "-" : ""}${whole}.${frac}`;
};

let gasPurchasePrice: Promise<bigint> | undefined;

/** `runtime_config.min_gas_purchase_price`, read once per process (1e9 when the node does not report it). */
export function minGasPurchasePrice(): Promise<bigint> {
  gasPurchasePrice ??= provider
    .experimental_protocolConfig({ finality: "final" })
    .then((cfg) => {
      const raw = (cfg as unknown as { runtime_config?: { min_gas_purchase_price?: string | number } }).runtime_config?.min_gas_purchase_price;
      return raw === undefined ? DEFAULT_GAS_PURCHASE_PRICE : BigInt(raw);
    })
    .catch((err: unknown) => {
      console.log(`    protocol config unreadable (${errorText(err).slice(0, 120)}); gas float at ${DEFAULT_GAS_PURCHASE_PRICE} yocto/gas`);
      return DEFAULT_GAS_PURCHASE_PRICE;
    });
  return gasPurchasePrice;
}

/** Throws InsufficientGasFloat when `signerId` could not pay for `txActions` (checked before signing). */
export async function assertGasFloat(signerId: string, txActions: readonly Action[]): Promise<GasFloat> {
  const float = gasFloatOf(txActions, await minGasPurchasePrice());
  const free = spendable(await nearBalance(signerId));
  if (free < float.minFree) throw new InsufficientGasFloat(signerId, free, float.minFree);
  return float;
}

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

/**
 * The send loop could not tell whether the transaction landed: it was broadcast, every answer was
 * lost and the chain never confirmed it either way. It may still land, so it must not be signed
 * again (S-5); check its hash later (`transactionStatus` falls back to the archival node).
 */
export class SendUnresolved extends Error {
  readonly hash: string;
  constructor(hash: string, why: string) {
    super(`SendUnresolved(${hash}): ${why}; do not sign it again until its status is known\n  tx ${explorerTx(hash)}`);
    this.name = "SendUnresolved";
    this.hash = hash;
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

/** The two provider methods a send needs; tests give fakes. */
export interface SendProvider {
  sendTransactionUntil(signed: SignedTransaction, waitUntil: TxExecutionStatus): Promise<TxOutcome>;
  viewTransactionStatusWithReceipts(args: { txHash: string; accountId: string; waitUntil: TxExecutionStatus }): Promise<TxOutcome>;
}

export interface SendDeps {
  pool: { run<T>(task: (p: SendProvider) => Promise<T>, opts?: RunOptions): Promise<T> };
  clock: Clock;
  /** Re-broadcasts of the same bytes before giving up (default 6), within `rebroadcastWindowMs` (10 min). */
  maxRebroadcasts?: number;
  rebroadcastWindowMs?: number;
  /** How long to wait for a known transaction to reach the wanted level (default 120 s). */
  waitTimeoutMs?: number;
  log?: (line: string) => void;
}

const defaultSendDeps = (): SendDeps => ({ pool: rpcPool as unknown as SendDeps["pool"], clock: systemClock });

/** Whether any node of the pool knows the transaction (waitUntil NONE answers at once). */
export async function txKnown(hash: string, signerId: string, deps: SendDeps): Promise<boolean> {
  try {
    await deps.pool.run((p) => p.viewTransactionStatusWithReceipts({ txHash: hash, accountId: signerId, waitUntil: "NONE" }), {
      label: `status ${hash}`,
      maxWaitMs: 120_000,
    });
    return true;
  } catch (err) {
    if (classifyRpcError(err) !== "unknown_tx") (deps.log ?? console.log)(`    status of ${hash} unreadable (${errorText(err).slice(0, 120)})`);
    return false;
  }
}

/** Polls a transaction the chain knows until it reaches `waitUntil`. */
export async function waitKnown(hash: string, signerId: string, waitUntil: TxExecutionStatus, deps: SendDeps): Promise<TxOutcome> {
  const timeout = deps.waitTimeoutMs ?? 120_000;
  const deadline = deps.clock.now() + timeout;
  for (;;) {
    try {
      return await deps.pool.run((p) => p.viewTransactionStatusWithReceipts({ txHash: hash, accountId: signerId, waitUntil }), {
        label: `wait ${hash}`,
        maxWaitMs: timeout,
      });
    } catch (err) {
      if (deps.clock.now() > deadline) throw new SendUnresolved(hash, `known to the chain but not ${waitUntil} after ${timeout / 1000} s (${errorText(err).slice(0, 120)})`);
      await deps.clock.sleep(2_000);
    }
  }
}

/**
 * Sends signed bytes until the chain answers (3.3). A rate limit, a transient failure or a timeout
 * checks the hash first: a known transaction is waited for; an unknown one gets the SAME bytes again
 * (same hash, so at most one copy lands), up to 6 times within 10 minutes. Nothing here re-signs.
 */
export async function sendSigned(
  signed: SignedTransaction,
  hash: string,
  signerId: string,
  waitUntil: TxExecutionStatus,
  deps: SendDeps = defaultSendDeps(),
): Promise<TxOutcome> {
  const maxRebroadcasts = deps.maxRebroadcasts ?? 6;
  const window = deps.rebroadcastWindowMs ?? 600_000;
  const started = deps.clock.now();
  for (let rebroadcasts = 0; ; ) {
    try {
      return await deps.pool.run((p) => p.sendTransactionUntil(signed, waitUntil), { label: `send ${hash}`, retry: false });
    } catch (err) {
      const kind = classifyRpcError(err);
      if (kind !== "rate_limited" && kind !== "transient" && kind !== "timeout") throw err;
      if (await txKnown(hash, signerId, deps)) return waitKnown(hash, signerId, waitUntil, deps);
      if (rebroadcasts >= maxRebroadcasts || deps.clock.now() - started > window) {
        throw new SendUnresolved(hash, `no answer after ${rebroadcasts + 1} broadcasts (last: ${kind}, ${errorText(err).slice(0, 120)})`);
      }
      rebroadcasts += 1;
      (deps.log ?? console.log)(`    ${kind} sending ${hash}; the chain does not know it: broadcasting the same bytes again (${rebroadcasts}/${maxRebroadcasts})`);
      await deps.clock.sleep(Math.min(30_000, 2_000 * rebroadcasts));
    }
  }
}

export interface SignAndSendSteps {
  sign(): Promise<{ signed: SignedTransaction; hash: string }>;
  send(signed: SignedTransaction, hash: string): Promise<TxOutcome>;
  /** Whether the chain knows `hash` (a copy may have landed despite the error). */
  known(hash: string): Promise<boolean>;
  wait(hash: string): Promise<TxOutcome>;
  /** Forgets the cached nonce so the next `sign` reads it again. */
  dropSigner(): void;
}

/**
 * Signs and sends; re-signs only after InvalidNonce or Expired AND only when the chain does not know
 * the hash (at most 3 signatures). An unknown hash with an invalid nonce or an expired block hash
 * can never land, so a new signature cannot make the action run twice.
 */
export async function signAndSend(steps: SignAndSendSteps, maxSignatures = 3): Promise<TxOutcome> {
  for (let attempt = 1; ; attempt++) {
    const { signed, hash } = await steps.sign();
    try {
      return await steps.send(signed, hash);
    } catch (err) {
      if (err instanceof SendUnresolved) throw err;
      const kind = classifyRpcError(err);
      if (kind !== "invalid_nonce" && kind !== "expired") throw err;
      if (await steps.known(hash)) return steps.wait(hash);
      if (attempt >= maxSignatures) throw err;
      // Someone else used this key, or the block it references is too old (the sandbox can skip
      // blocks): forget the cached nonce and sign again over a fresh block hash.
      steps.dropSigner();
    }
  }
}

export interface SendOptions {
  waitUntil?: TxExecutionStatus;
  /** Sign with `<signer>.<keyVariant>.json` instead of the account's main key. */
  keyVariant?: string;
  /** Printed with the result; defaults to "signer -> receiver". */
  label?: string;
  quiet?: boolean;
}

const hashOf = (signed: SignedTransaction): string => baseEncode(createHash("sha256").update(signed.transaction.encode()).digest());

async function sendOne(
  signerId: string,
  receiverId: string,
  txActions: Action[],
  waitUntil: TxExecutionStatus,
  keyVariant?: string,
): Promise<{ outcome: TxOutcome; hash: string }> {
  assertWritable();
  const key = signerKey(signerId, keyVariant);
  return oneAtATime(key, async () => {
    await assertGasFloat(signerId, txActions);
    const deps = defaultSendDeps();
    let hash = "";
    const outcome = await signAndSend({
      sign: async () => {
        const account = await signerAccount(signerId, keyVariant);
        const signed = await account.createSignedTransaction({ receiverId, actions: txActions });
        hash = hashOf(signed);
        return { signed, hash };
      },
      send: (signed, h) => sendSigned(signed, h, signerId, waitUntil, deps),
      known: (h) => txKnown(h, signerId, deps),
      wait: (h) => waitKnown(h, signerId, waitUntil, deps),
      dropSigner: () => signers.delete(key),
    });
    return { outcome, hash };
  });
}

export async function sendTransaction(
  signerId: string,
  receiverId: string,
  txActions: Action[],
  options: SendOptions = {},
): Promise<TxResult> {
  const waitUntil = options.waitUntil ?? WAIT_UNTIL;
  const label = options.label ?? `${signerId} -> ${receiverId}`;
  const { outcome } = await sendOne(signerId, receiverId, txActions, waitUntil, options.keyVariant);
  const result = checkOutcome(outcome, label);
  if (!options.quiet) console.log(`  ${label}: ok (${formatTgas(result.gasBurnt)} Tgas) ${explorerTx(result.hash)}`);
  return result;
}

/**
 * Sends and returns the hash once the transaction is in a final block, without waiting for its
 * receipts. For calls that yield (NEP-519) and resume minutes later, which every other wait level
 * would sit through; the caller follows the receipts itself with `transactionStatus`.
 */
export async function sendIncluded(signerId: string, receiverId: string, txActions: Action[], label: string): Promise<string> {
  const { hash } = await sendOne(signerId, receiverId, txActions, "INCLUDED_FINAL");
  console.log(`  ${label}: sent ${explorerTx(hash)}`);
  return hash;
}

/**
 * Whatever the chain knows of a transaction now: the receipts executed so far, with their logs.
 * A hash the regular nodes no longer know is looked up on the archival node.
 */
export async function transactionStatus(hash: string, signerId: string, waitUntil: TxExecutionStatus = "NONE"): Promise<TxOutcome> {
  const task = (p: JsonRpcProvider): Promise<TxOutcome> => p.viewTransactionStatusWithReceipts({ txHash: hash, accountId: signerId, waitUntil });
  try {
    return await rpcPool.run(task, { label: `status ${hash}` });
  } catch (err) {
    if (archivalPool && classifyRpcError(err) === "unknown_tx") return archivalPool.run(task, { label: `status ${hash} (archival)` });
    throw err;
  }
}

/** Polls the status of a transaction that the RPC gave up waiting for. */
export async function waitForTransaction(hash: string, signerId: string, waitUntil: TxExecutionStatus, timeoutMs = 90_000): Promise<TxOutcome> {
  return waitKnown(hash, signerId, waitUntil, { ...defaultSendDeps(), waitTimeoutMs: timeoutMs });
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
