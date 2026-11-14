// The always-on keeper: one bounded round that
//   (a) posts the NEAR/USD reference through the contract's reporter path (`report_reference`,
//       signed by the reporter account) when the stored one is older than ~5 minutes, with the
//       guest's median of Coinbase, Kraken, Gemini and CoinGecko (nearusd.ts);
//   (b) liquidates every liquidatable loan of every lending market: discovery by `lending_tiers` +
//       `borrowers(max_health_factor = 1)`, sizing by `liquidation_quote`, cash-out only when the
//       proceeds cover the repayment (liquidator.ts), signed by the keeper account, which mints
//       itself testnet USDC from the faucet when its float runs low.
// It runs as a Vercel function (api/keeper.ts: a cron every minute and a ping from open pages)
// and from the command line (keeper.ts).
//
// There is no database. Overlapping rounds are kept apart by the chain: every transaction a key
// signs in a round carries a nonce of the round's block window, W x 1e6 + i, where W is the latest
// final height rounded down to a multiple of `windowBlocks` (100 blocks, about a minute on testnet).
// Two rounds in one window sign the same nonces, so only one copy of each lands; the other gets
// InvalidNonce, which costs no gas, and stops sending. A key whose nonce on chain is already at
// least W x 1e6 has sent in this window, so any later round in it sends nothing. The protocol
// accepts a nonce below (inclusion height) x 1e6, so W x 1e6 + i is always valid and always above
// every nonce of an earlier window.

import { actions, baseDecode, baseEncode, createTransaction, KeyPair, KeyPairSigner, type Action, type JsonRpcProvider, type KeyPairString, type PublicKey } from "near-api-js";
import { AccessKeyDoesNotExistError } from "near-api-js/rpc-errors";

import { multiverseItems } from "./events.ts";
import { decide, DEFAULT_DECIDE, type DecideOptions, type Decision } from "./liquidator.ts";
import { encodeMsg, type Tier } from "./msgs.ts";
import { checkOutcome, SendUnresolved, sendSigned, TxFailedError, txKnown, waitKnown, type SendDeps, type TxOutcome } from "./near.ts";
import { classifyRpcError, endpointsFor, errorText, RpcPool, systemClock } from "./rpc.ts";
import { fetchSources, formatWad, spotFrom, type FetchLike } from "./nearusd.ts";
import { parseNear, tgas } from "./units.ts";
import {
  decodeBorrowers,
  decodeLiquidationQuote,
  decodePauseView,
  decodeReference,
  decodeReferenceConfig,
  decodeStorageBalance,
  type BorrowerRow,
  type LiquidationQuote,
  type PauseView,
} from "./views.ts";

// Configuration

export interface Signing {
  accountId: string;
  key: KeyPairString;
}

export interface KeeperConfig {
  contractId: string;
  usdcId: string;
  usdcDecimals: number;
  rpcUrls: string[];
  /** Signs `report_reference`; absent = no reference step. */
  reporter?: Signing;
  /** Signs liquidations and faucet mints; absent = no liquidation step. */
  keeper?: Signing;
  windowBlocks: number;
  /** Whole round, and the point after which no new transaction starts. */
  budgetMs: number;
  sendCutoffMs: number;
  /** Refresh the reference once it is this old (capped below the contract's borrow_max_age_sec). */
  referenceRefreshSec: number;
  /** Refuse to post a price this far from a stored one younger than an hour. */
  fatFingerBps: number;
  maxPerRound: number;
  decide: DecideOptions;
  /** Faucet mints top the keeper's USDC up to this, in token units. */
  usdcFloat: bigint;
  /** Quote and decide, send nothing. */
  dryRun: boolean;
}

export const DEFAULTS = {
  usdcDecimals: 6,
  windowBlocks: 100,
  budgetMs: 45_000,
  sendCutoffMs: 35_000,
  referenceRefreshSec: 300,
  fatFingerBps: 1_500,
  maxPerRound: 10,
  decide: DEFAULT_DECIDE,
  usdcFloat: 5_000n * 10n ** 6n,
  dryRun: false,
} as const;

export const TESTNET_RPC_URLS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"];

/** The account ids of a deployment the keeper works on (defaults baked into the Vercel bundle). */
export interface KeeperTargets {
  contractId: string;
  usdcId: string;
  keeperId: string;
  reporterId: string;
  rpcUrls?: string[];
}

/** The config from the environment: KEEPER_KEY, REPORTER_KEY and optional overrides of `targets`. */
export function configFromEnv(env: NodeJS.ProcessEnv, targets: KeeperTargets): KeeperConfig {
  const key = (name: string): KeyPairString | undefined => {
    const v = env[name]?.trim();
    if (!v) return undefined;
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(v)) throw new Error(`${name} is not an ed25519 secret key`);
    return v as KeyPairString;
  };
  const keeperKey = key("KEEPER_KEY");
  const reporterKey = key("REPORTER_KEY");
  const listed = (env.NEAR_RPC_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    ...DEFAULTS,
    contractId: env.KEEPER_CONTRACT_ID || targets.contractId,
    usdcId: env.KEEPER_USDC_ID || targets.usdcId,
    rpcUrls: listed.length > 0 ? listed : (targets.rpcUrls ?? TESTNET_RPC_URLS),
    keeper: keeperKey ? { accountId: env.KEEPER_ACCOUNT_ID || targets.keeperId, key: keeperKey } : undefined,
    reporter: reporterKey ? { accountId: env.REPORTER_ACCOUNT_ID || targets.reporterId, key: reporterKey } : undefined,
    dryRun: env.KEEPER_DRY_RUN === "1",
  };
}

// Chain access

export interface AccessKeyNow {
  nonce: bigint;
  blockHeight: number;
  blockHash: string;
}

/** What a round needs from the chain; tests give a fake. */
export interface KeeperChain {
  view<T = unknown>(contractId: string, method: string, args?: Record<string, unknown>): Promise<T>;
  accessKey(accountId: string, publicKey: string): Promise<AccessKeyNow | null>;
  /** Balance minus the storage stake, in yoctoNEAR. */
  freeNear(accountId: string): Promise<bigint>;
  /** Sends signed bytes, re-broadcasting the same bytes on rate limits (near.ts sendSigned). */
  send(signed: Parameters<typeof sendSigned>[0], hash: string, signerId: string): Promise<TxOutcome>;
  known(hash: string, signerId: string): Promise<boolean>;
  wait(hash: string, signerId: string): Promise<TxOutcome>;
}

/** A chain over an RPC pool; every wait is bounded by `deadline` (epoch ms). */
export function rpcChain(pool: RpcPool<JsonRpcProvider>, deadline: () => number): KeeperChain {
  const left = (): number => Math.max(2_000, deadline() - Date.now());
  const deps = (): SendDeps => ({
    pool: pool as unknown as SendDeps["pool"],
    clock: systemClock,
    maxRebroadcasts: 3,
    rebroadcastWindowMs: left(),
    waitTimeoutMs: Math.min(30_000, left()),
    log: () => undefined,
  });
  return {
    view: async <T>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
      (await pool.run((p) => p.callFunction({ contractId, method, args, blockQuery: { finality: "final" } }), {
        label: `${contractId}.${method}`,
        maxWaitMs: left(),
      })) as T,
    accessKey: async (accountId, publicKey) => {
      try {
        const k = await pool.run((p) => p.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: "final" } }), { label: `access key ${accountId}`, maxWaitMs: left() });
        return { nonce: BigInt(k.nonce), blockHeight: k.block_height, blockHash: k.block_hash };
      } catch (err) {
        if (err instanceof AccessKeyDoesNotExistError || /does not exist/i.test(errorText(err))) return null;
        throw err;
      }
    },
    freeNear: async (accountId) => {
      const a = await pool.run((p) => p.viewAccount({ accountId, blockQuery: { finality: "final" } }), { label: `account ${accountId}`, maxWaitMs: left() });
      return BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n;
    },
    send: (signed, hash, signerId) => sendSigned(signed, hash, signerId, "EXECUTED_OPTIMISTIC", deps()),
    known: (hash, signerId) => txKnown(hash, signerId, deps()),
    wait: (hash, signerId) => waitKnown(hash, signerId, "EXECUTED_OPTIMISTIC", deps()),
  };
}

export function rpcPoolFor(urls: readonly string[], env: NodeJS.ProcessEnv = process.env): RpcPool<JsonRpcProvider> {
  return new RpcPool<JsonRpcProvider>(endpointsFor(urls, env));
}

// The window lock

export const NONCE_RANGE = 1_000_000n;
export const windowStart = (height: number, blocks: number): number => height - (height % blocks);
export const windowNonce = (start: number): bigint => BigInt(start) * NONCE_RANGE;
/** Whether a key with this on-chain nonce has already sent in the window starting at `start`. */
export const sentInWindow = (nonce: bigint, start: number): boolean => nonce >= windowNonce(start);

export type Sent =
  | { status: "ok"; hash: string; logs: string[]; returnText: string; gasTgas: number }
  | { status: "failed"; hash: string; error: string; logs: string[] }
  | { status: "lost" | "unresolved"; hash: string; error: string };

/** One key's transactions in one round, with window nonces. */
export class Lane {
  readonly accountId: string;
  private readonly signer: KeyPairSigner;
  private readonly publicKey: PublicKey;
  private next = 0n;
  private blockHash = "";
  open = false;
  window: number | null = null;
  reason = "not opened";

  constructor(s: Signing) {
    this.accountId = s.accountId;
    const kp = KeyPair.fromString(s.key);
    this.signer = new KeyPairSigner(kp);
    this.publicKey = kp.getPublicKey();
  }

  get publicKeyText(): string {
    return this.publicKey.toString();
  }

  /** Reads the key's nonce: open when the key has not sent in the current window. */
  async start(chain: KeeperChain, windowBlocks: number): Promise<this> {
    const ak = await chain.accessKey(this.accountId, this.publicKeyText);
    if (!ak) return this.close(`no access key ${this.publicKeyText} on ${this.accountId}`);
    const w = windowStart(ak.blockHeight, windowBlocks);
    this.window = w;
    if (sentInWindow(ak.nonce, w)) return this.close(`${this.accountId} already sent in window ${w}`);
    this.next = windowNonce(w);
    this.blockHash = ak.blockHash;
    this.open = true;
    this.reason = "";
    return this;
  }

  close(reason: string): this {
    this.open = false;
    this.reason = reason;
    return this;
  }

  async send(chain: KeeperChain, receiverId: string, txActions: Action[], label: string): Promise<Sent> {
    if (!this.open) throw new Error(`${label}: ${this.accountId} cannot send (${this.reason})`);
    const tx = createTransaction(this.accountId, this.publicKey, receiverId, this.next, txActions, baseDecode(this.blockHash));
    const { txHash, signedTransaction: signed } = await this.signer.signTransaction(tx);
    const hash = baseEncode(txHash);
    this.next += 1n;
    const finish = (outcome: TxOutcome): Sent => {
      try {
        const r = checkOutcome(outcome, label);
        return { status: "ok", hash, logs: r.logs, returnText: r.returnText, gasTgas: Number(r.gasBurnt / 10n ** 9n) / 1000 };
      } catch (err) {
        if (err instanceof TxFailedError) return { status: "failed", hash, error: err.message.split("\n")[0] ?? err.message, logs: err.logs };
        throw err;
      }
    };
    try {
      return finish(await chain.send(signed, hash, this.accountId));
    } catch (err) {
      const kind = err instanceof SendUnresolved ? "unresolved" : classifyRpcError(err);
      if (kind === "invalid_nonce" || kind === "expired") {
        if (await chain.known(hash, this.accountId)) return finish(await chain.wait(hash, this.accountId));
        this.close(`lost window ${this.window} to another round`);
        return { status: "lost", hash, error: errorText(err) };
      }
      // it may still land: nothing more from this key in this round
      this.close(`send unresolved: ${errorText(err).slice(0, 160)}`);
      return { status: "unresolved", hash, error: errorText(err) };
    }
  }
}

// The round

export interface ReferenceResult {
  action: "posted" | "skipped" | "failed" | "dry_run" | "lost" | "unresolved";
  reason?: string;
  stored?: { price: string; ageSec: number | null; source: string };
  price?: string;
  observedAt?: number;
  sourcesUsed?: number;
  spreadBps?: number;
  evidence?: string;
  tx?: string;
}

export interface LiquidationAction {
  scenarioId: number;
  tier: Tier;
  account: string;
  hf: string | null;
  decision: Decision["kind"];
  receive?: string;
  repay?: string;
  budget?: string;
  minOut?: string | null;
  quotedCash?: string | null;
  status: "sent" | "failed" | "skipped" | "dry_run" | "locked" | "deferred" | "lost" | "unresolved";
  reason?: string;
  tx?: string;
  repaid?: string;
  cash?: string;
  writtenOff?: string;
  checks?: { repaidWithinBudget: boolean; cashAtLeastMinOut: boolean | null };
}

export interface LiquidationResult {
  skipped?: string;
  markets: number;
  candidates: number;
  actions: LiquidationAction[];
  setup: { what: string; tx: string; status: string; error?: string }[];
}

export interface RoundSummary {
  ok: boolean;
  dryRun: boolean;
  contractId: string;
  startedAt: string;
  ms: number;
  window: number | null;
  reporter: { accountId: string; open: boolean; reason: string } | null;
  keeper: { accountId: string; open: boolean; reason: string } | null;
  reference: ReferenceResult | null;
  liquidations: LiquidationResult | null;
  errors: string[];
}

export interface RoundDeps {
  chain: KeeperChain;
  fetchFn?: FetchLike;
  now?: () => number;
}

const ONE_WAD = 10n ** 18n;
const TIERS: readonly Tier[] = ["safe", "normal", "bold"];
const str = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : v.toString());
const WAD_TO_USDC = (decimals: number): bigint => 10n ** BigInt(18 - decimals);
/** A 300 Tgas call needs 0.3 NEAR of prepaid gas at testnet's 1e9 yocto/gas, plus the margin. */
const GAS_FLOAT = parseNear("0.31");
const STORAGE_DEPOSIT = parseNear("0.25");

class Round {
  readonly errors: string[] = [];
  private registered = false;
  readonly cfg: KeeperConfig;
  readonly deps: RoundDeps;
  readonly started: number;
  readonly reporter: Lane | null;
  readonly keeper: Lane | null;

  constructor(cfg: KeeperConfig, deps: RoundDeps, started: number, reporter: Lane | null, keeper: Lane | null) {
    this.cfg = cfg;
    this.deps = deps;
    this.started = started;
    this.reporter = reporter;
    this.keeper = keeper;
  }

  now(): number {
    return (this.deps.now ?? Date.now)();
  }
  nowSec(): number {
    return Math.floor(this.now() / 1000);
  }
  elapsed(): number {
    return this.now() - this.started;
  }
  view<T>(method: string, args: Record<string, unknown> = {}, contractId = this.cfg.contractId): Promise<T> {
    return this.deps.chain.view<T>(contractId, method, args);
  }

  // (a) the reference

  async reference(pause: PauseView): Promise<ReferenceResult> {
    const lane = this.reporter;
    if (!lane) return { action: "skipped", reason: "no REPORTER_KEY" };
    const cfg = decodeReferenceConfig(await this.view("get_reference_config"));
    if (!cfg || !cfg.enabled) return { action: "skipped", reason: "the contract has no reference config, or it is off" };
    if (cfg.reporter_id !== lane.accountId) return { action: "skipped", reason: `the contract's reporter is ${cfg.reporter_id ?? "nobody"}, not ${lane.accountId}` };
    if (pause.paused.includes("oracle")) return { action: "skipped", reason: "the oracle flag is paused" };
    const ref = decodeReference(await this.view("get_reference"));
    const now = this.nowSec();
    const ageSec = ref && ref.price !== "0" ? Math.max(0, now - ref.observed_at) : null;
    const stored = ref ? { price: formatWad(BigInt(ref.price)), ageSec, source: ref.source } : undefined;
    if (ref?.pending) return { action: "skipped", reason: "an OutLayer request is in flight", stored };
    const refresh = Math.min(this.cfg.referenceRefreshSec, Math.max(60, cfg.borrow_max_age_sec - 120));
    if (ageSec !== null && ageSec < refresh) return { action: "skipped", reason: `fresh: ${ageSec} s old, refreshed after ${refresh} s`, stored };
    if (!lane.open) return { action: "skipped", reason: lane.reason, stored };

    const fetched = await fetchSources(this.deps.fetchFn, 5_000);
    const at = this.nowSec();
    const out = spotFrom(fetched, at, cfg.min_sources, cfg.max_spread_bps);
    const seen = { stored, evidence: out.evidence, sourcesUsed: out.sourcesUsed, spreadBps: out.spreadBps };
    if (out.priceWad === null) return { action: "failed", reason: "no median", ...seen };
    const price = out.priceWad;
    const reading = { ...seen, price: formatWad(price), observedAt: out.observedAt };
    // the contract's own checks (reference.rs reject), so a sure failure costs no gas
    const late = at - out.observedAt;
    if (late > cfg.max_result_delay_sec - 5) return { action: "skipped", reason: `the oldest source is ${late} s old; the contract takes at most ${cfg.max_result_delay_sec} s`, ...reading };
    if (ref && out.observedAt <= ref.observed_at) return { action: "skipped", reason: "not newer than the stored reference", ...reading };
    if (price < BigInt(cfg.min_price) || price > BigInt(cfg.max_price)) return { action: "failed", reason: "outside the contract's price bounds", ...reading };
    if (ref && ref.price !== "0" && ageSec !== null && ageSec < 3_600) {
      const old = BigInt(ref.price);
      const moved = price > old ? price - old : old - price;
      if (moved * 10_000n > old * BigInt(this.cfg.fatFingerBps)) {
        return { action: "failed", reason: `moved more than ${this.cfg.fatFingerBps} bps from the stored ${formatWad(old)} within an hour`, ...reading };
      }
    }
    if (this.cfg.dryRun) return { action: "dry_run", ...reading };
    const sent = await lane.send(
      this.deps.chain,
      this.cfg.contractId,
      [actions.functionCall("report_reference", { price: price.toString(), observed_at: out.observedAt }, tgas(30), 0n)],
      `${lane.accountId}: report_reference ${formatWad(price)}`,
    );
    if (sent.status === "ok") return { action: "posted", tx: sent.hash, ...reading };
    return { action: sent.status, tx: sent.hash, reason: sent.error, ...reading };
  }

  // (b) liquidations

  private async markets(): Promise<{ sid: number; tier: Tier }[]> {
    const count = Number(await this.view<number>("scenario_count"));
    const sids = Array.from({ length: count }, (_, i) => i + 1);
    const found: { sid: number; tier: Tier }[] = [];
    await Promise.all(
      sids.map(async (sid) => {
        try {
          const rows = await this.view<{ tier: Tier; market: { borrowers: number } }[]>("lending_tiers", { scenario_id: sid });
          for (const r of rows) if (r.market.borrowers > 0) found.push({ sid, tier: r.tier });
        } catch (err) {
          this.errors.push(`lending_tiers(${sid}): ${errorText(err).slice(0, 200)}`);
        }
      }),
    );
    return found.sort((a, b) => a.sid - b.sid || TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
  }

  private async candidates(sid: number, tier: Tier): Promise<BorrowerRow[]> {
    const out: BorrowerRow[] = [];
    for (let from: number | null = 0; from !== null; ) {
      const page = decodeBorrowers(
        await this.view("borrowers", { scenario_id: sid, tier, from_index: from, limit: 100, max_health_factor: ONE_WAD.toString() }),
      );
      out.push(...page.rows.filter((r) => r.liquidation === "liquidatable" || r.write_off_ready));
      from = page.next_index;
    }
    return out;
  }

  private quote(sid: number, tier: Tier, account: string, receive: "tokens" | "cash"): Promise<LiquidationQuote> {
    return this.view("liquidation_quote", { scenario_id: sid, account_id: account, tier, repay_amount: "max", receive }).then((x) => decodeLiquidationQuote(x));
  }

  /** Free NEAR for one more call with `deposit`, or why not. */
  private async gasOk(lane: Lane, deposit = 0n): Promise<string | null> {
    const free = await this.deps.chain.freeNear(lane.accountId);
    return free >= GAS_FLOAT + deposit ? null : `InsufficientGasFloat: ${lane.accountId} has ${free} yocto free, needs ${GAS_FLOAT + deposit}`;
  }

  /** NEP-145 registration with the contract, once per round, before the first liquidation. */
  private async ensureRegistered(lane: Lane, setup: LiquidationResult["setup"]): Promise<string | null> {
    if (this.registered) return null;
    const bal = decodeStorageBalance(await this.view("storage_balance_of", { account_id: lane.accountId }));
    if (bal && BigInt(bal.available) >= parseNear("0.05")) {
      this.registered = true;
      return null;
    }
    const why = await this.gasOk(lane, STORAGE_DEPOSIT);
    if (why) return why;
    const sent = await lane.send(
      this.deps.chain,
      this.cfg.contractId,
      [actions.functionCall("storage_deposit", { account_id: lane.accountId, registration_only: false }, tgas(30), STORAGE_DEPOSIT)],
      `${lane.accountId}: storage_deposit`,
    );
    setup.push({ what: "storage_deposit 0.25 NEAR", tx: sent.hash, status: sent.status, error: "error" in sent ? sent.error : undefined });
    if (sent.status !== "ok") return `storage_deposit ${sent.status}`;
    this.registered = true;
    return null;
  }

  /** Mints testnet USDC from the open faucet until the keeper holds `need` (token units). */
  private async ensureUsdc(lane: Lane, need: bigint, setup: LiquidationResult["setup"]): Promise<string | null> {
    const balance = BigInt(await this.view<string>("ft_balance_of", { account_id: lane.accountId }, this.cfg.usdcId).catch(() => "0"));
    if (balance >= need) return null;
    const cap = BigInt((await this.view<{ max_mint_per_call: string }>("faucet_config", {}, this.cfg.usdcId)).max_mint_per_call);
    const target = need > this.cfg.usdcFloat ? need : this.cfg.usdcFloat;
    // at most five capped mints in one transaction
    const amounts: bigint[] = [];
    for (let left = target - balance; left > 0n && amounts.length < 5; left -= cap) amounts.push(left < cap ? left : cap);
    const minted = amounts.reduce((s, x) => s + x, 0n);
    if (balance + minted < need) return `the faucet cap (${cap} per call) cannot cover ${need}`;
    const why = await this.gasOk(lane);
    if (why) return why;
    const mints = amounts.map((amount) => actions.functionCall("mint", { account_id: lane.accountId, amount: amount.toString() }, tgas(10), 0n));
    const sent = await lane.send(this.deps.chain, this.cfg.usdcId, mints, `${lane.accountId}: faucet mint ${minted}`);
    setup.push({ what: `faucet mint ${minted} USDC units`, tx: sent.hash, status: sent.status, error: "error" in sent ? sent.error : undefined });
    return sent.status === "ok" ? null : `faucet mint ${sent.status}`;
  }

  private async execute(lane: Lane, sid: number, tier: Tier, row: BorrowerRow, d: Decision, a: LiquidationAction, setup: LiquidationResult["setup"]): Promise<void> {
    const chain = this.deps.chain;
    if (d.kind === "write_off") {
      const why = await this.gasOk(lane);
      if (why) return void Object.assign(a, { status: "skipped", reason: why });
      const args = tier === "normal" ? { scenario_id: sid, account_id: row.account_id } : { scenario_id: sid, account_id: row.account_id, tier };
      const sent = await lane.send(chain, this.cfg.contractId, [actions.functionCall("write_off_bad_debt", args, tgas(150), 1n)], `write_off_bad_debt ${row.account_id}`);
      const bad = multiverseItems<{ debt: string }>(sent.status === "ok" ? sent.logs : [], "bad_debt")[0];
      Object.assign(a, { status: sent.status === "ok" ? "sent" : sent.status, tx: sent.hash, reason: "error" in sent ? sent.error : undefined, writtenOff: bad?.debt });
      return;
    }
    if (d.kind !== "liquidate") return;
    const unit = WAD_TO_USDC(this.cfg.usdcDecimals);
    const budgetRaw = d.budget / unit;
    for (const step of [() => this.ensureRegistered(lane, setup), () => this.ensureUsdc(lane, budgetRaw, setup), () => this.gasOk(lane)]) {
      const why = await step();
      if (why) return void Object.assign(a, { status: "skipped", reason: why });
      if (!lane.open) return void Object.assign(a, { status: "locked", reason: lane.reason });
    }
    const msg = encodeMsg(
      {
        action: "liquidate",
        scenario_id: sid,
        account_id: row.account_id,
        repay_amount: "max",
        tier,
        receive: d.receive === "cash" ? "cash" : undefined,
        min_out: d.minOut === null ? undefined : d.minOut.toString(),
      },
      2,
    );
    const sent = await lane.send(
      chain,
      this.cfg.usdcId,
      [actions.functionCall("ft_transfer_call", { receiver_id: this.cfg.contractId, amount: budgetRaw.toString(), memo: null, msg }, tgas(300), 1n)],
      `liquidate ${row.account_id} in ${sid}/${tier} (${d.receive})`,
    );
    a.tx = sent.hash;
    if (sent.status !== "ok") return void Object.assign(a, { status: sent.status, reason: sent.error });
    const liq = multiverseItems<{ repaid: string; written_off?: string }>(sent.logs, "liquidate")[0];
    const out = multiverseItems<{ cash: string }>(sent.logs, "cash_out")[0];
    if (!liq) return void Object.assign(a, { status: "failed", reason: "no liquidate event in the outcome" });
    const repaid = BigInt(liq.repaid);
    Object.assign(a, {
      status: "sent",
      repaid: liq.repaid,
      cash: out?.cash,
      writtenOff: liq.written_off,
      checks: { repaidWithinBudget: repaid <= d.budget, cashAtLeastMinOut: d.minOut === null ? null : out !== undefined && BigInt(out.cash) >= d.minOut },
    });
  }

  async liquidations(pause: PauseView): Promise<LiquidationResult> {
    const result: LiquidationResult = { markets: 0, candidates: 0, actions: [], setup: [] };
    const lane = this.keeper;
    if (!lane) return { ...result, skipped: "no KEEPER_KEY" };
    if (pause.paused.includes("liquidate")) return { ...result, skipped: "the liquidate flag is paused" };
    if (this.nowSec() < pause.liquidations_resume_at_sec) return { ...result, skipped: `liquidation grace until ${pause.liquidations_resume_at_sec}` };
    const mode = pause.paused.includes("trade") ? "tokens" : this.cfg.decide.mode;

    const markets = await this.markets();
    result.markets = markets.length;
    const rows: { sid: number; tier: Tier; row: BorrowerRow }[] = [];
    for (const m of markets) {
      try {
        for (const row of await this.candidates(m.sid, m.tier)) rows.push({ ...m, row });
      } catch (err) {
        this.errors.push(`borrowers(${m.sid}, ${m.tier}): ${errorText(err).slice(0, 200)}`);
      }
    }
    result.candidates = rows.length;
    // most underwater first; rows without a health factor (unpriced) last
    const hf = (r: BorrowerRow): bigint => (r.health_factor === null ? 1n << 127n : BigInt(r.health_factor));
    rows.sort((x, y) => (hf(x.row) < hf(y.row) ? -1 : hf(x.row) > hf(y.row) ? 1 : 0));

    for (const { sid, tier, row } of rows.slice(0, this.cfg.maxPerRound)) {
      const a: LiquidationAction = { scenarioId: sid, tier, account: row.account_id, hf: row.health_factor, decision: "skip", status: "skipped" };
      result.actions.push(a);
      if (this.elapsed() > this.cfg.sendCutoffMs) {
        Object.assign(a, { status: "deferred", reason: "round time used up; next round" });
        continue;
      }
      try {
        let d: Decision;
        if (row.write_off_ready) d = decide(true, await this.quote(sid, tier, row.account_id, "tokens"), null);
        else {
          const [qT, qC] = await Promise.all([this.quote(sid, tier, row.account_id, "tokens"), mode === "tokens" ? null : this.quote(sid, tier, row.account_id, "cash")]);
          d = decide(false, qT, qC, { ...this.cfg.decide, mode });
        }
        a.decision = d.kind;
        if (d.kind === "skip") {
          a.reason = d.reason;
          continue;
        }
        if (d.kind === "liquidate") Object.assign(a, { receive: d.receive, repay: str(d.repay), budget: str(d.budget), minOut: str(d.minOut), quotedCash: str(d.cash) });
        if (this.cfg.dryRun) {
          a.status = "dry_run";
          continue;
        }
        if (!lane.open) {
          Object.assign(a, { status: "locked", reason: lane.reason });
          continue;
        }
        await this.execute(lane, sid, tier, row, d, a, result.setup);
        // a cash-out the pools refused (prices moved, trade paused): once more as tokens
        if (a.status === "failed" && d.kind === "liquidate" && d.receive === "cash" && /CashOut|Paused\(trade\)/.test(a.reason ?? "") && lane.open) {
          const retry = decide(false, await this.quote(sid, tier, row.account_id, "tokens"), null, { ...this.cfg.decide, mode: "tokens" });
          const b: LiquidationAction = { ...a, decision: retry.kind, status: "skipped", reason: `retry after: ${a.reason}`, tx: undefined };
          result.actions.push(b);
          if (retry.kind === "liquidate") {
            Object.assign(b, { receive: retry.receive, repay: str(retry.repay), budget: str(retry.budget), minOut: null, quotedCash: null });
            await this.execute(lane, sid, tier, row, retry, b, result.setup);
          }
        }
      } catch (err) {
        Object.assign(a, { status: "failed", reason: errorText(err).slice(0, 300) });
      }
    }
    if (rows.length > this.cfg.maxPerRound) this.errors.push(`${rows.length - this.cfg.maxPerRound} liquidatable rows left for the next round`);
    return result;
  }
}

/** Opens a lane per configured key (one access-key read each). */
export async function openLanes(cfg: KeeperConfig, chain: KeeperChain): Promise<{ reporter: Lane | null; keeper: Lane | null }> {
  const make = async (s: Signing | undefined): Promise<Lane | null> => (s ? new Lane(s).start(chain, cfg.windowBlocks) : null);
  const [reporter, keeper] = await Promise.all([make(cfg.reporter), make(cfg.keeper)]);
  return { reporter, keeper };
}

/** One round: the reference, then the liquidations. Never throws; errors land in the summary. */
export async function runRound(cfg: KeeperConfig, deps: RoundDeps): Promise<RoundSummary> {
  const now = deps.now ?? Date.now;
  const started = now();
  const summary: RoundSummary = {
    ok: false,
    dryRun: cfg.dryRun,
    contractId: cfg.contractId,
    startedAt: new Date(started).toISOString(),
    ms: 0,
    window: null,
    reporter: null,
    keeper: null,
    reference: null,
    liquidations: null,
    errors: [],
  };
  try {
    const [lanes, pauseRaw] = await Promise.all([openLanes(cfg, deps.chain), deps.chain.view(cfg.contractId, "pause_state")]);
    const pause = decodePauseView(pauseRaw);
    const laneInfo = (l: Lane | null): RoundSummary["keeper"] => (l ? { accountId: l.accountId, open: l.open, reason: l.reason } : null);
    summary.reporter = laneInfo(lanes.reporter);
    summary.keeper = laneInfo(lanes.keeper);
    summary.window = lanes.keeper?.window ?? lanes.reporter?.window ?? null;
    const round = new Round(cfg, deps, started, lanes.reporter, lanes.keeper);
    summary.errors = round.errors;
    try {
      summary.reference = await round.reference(pause);
    } catch (err) {
      summary.reference = { action: "failed", reason: errorText(err).slice(0, 300) };
    }
    try {
      summary.liquidations = await round.liquidations(pause);
    } catch (err) {
      summary.errors.push(`liquidations: ${errorText(err).slice(0, 300)}`);
    }
    summary.reporter = laneInfo(lanes.reporter);
    summary.keeper = laneInfo(lanes.keeper);
  } catch (err) {
    summary.errors.push(errorText(err).slice(0, 300));
  }
  const failedActions = summary.liquidations?.actions.some((a) => a.status === "failed" || a.status === "unresolved") ?? false;
  summary.ok = summary.errors.length === 0 && summary.reference?.action !== "failed" && summary.reference?.action !== "unresolved" && !failedActions;
  summary.ms = now() - started;
  return summary;
}

/**
 * Whether a key has already sent in the current window: the cheap check a public ping makes
 * before it runs a round (one access-key read).
 */
export async function windowTaken(cfg: KeeperConfig, chain: KeeperChain): Promise<{ taken: boolean; window: number | null }> {
  const s = cfg.keeper ?? cfg.reporter;
  if (!s) return { taken: false, window: null };
  const lane = await new Lane(s).start(chain, cfg.windowBlocks);
  return { taken: !lane.open && lane.window !== null, window: lane.window };
}

/** BigInt-safe JSON. */
export const summaryJson = (s: unknown): string => JSON.stringify(s, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
