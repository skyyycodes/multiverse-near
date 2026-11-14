// The keeper round against a fake chain: the window lock (two rounds, one landing), the reference
// rules (fresh, stale, the contract's checks before sending), liquidation sizing and the faucet
// top-up, and the HTTP handler's callers (cron, ping, refused).

import assert from "node:assert/strict";
import { test } from "node:test";

import { KeyPair, type KeyPairString } from "near-api-js";

import { callerOf, handle, PING_EVERY_MS, type HandlerState } from "../api/keeper.ts";
import { configFromEnv, DEFAULTS, Lane, runRound, sentInWindow, windowNonce, windowStart, type KeeperChain, type KeeperConfig } from "./keeper.ts";
import type { TxOutcome } from "./near.ts";
import type { SourceName } from "./nearusd.ts";

const KEEPER_KEY = KeyPair.fromRandom("ed25519").toString() as KeyPairString;
const REPORTER_KEY = KeyPair.fromRandom("ed25519").toString() as KeyPairString;
const NOW_SEC = 1_794_630_000;
const HEIGHT = 277_606_154;
const WAD = 10n ** 18n;

interface Sent {
  signer: string;
  receiver: string;
  nonce: bigint;
  actions: { method: string; args: Record<string, unknown>; deposit: bigint }[];
}

function outcome(hash: string, logs: string[], value: string): TxOutcome {
  const o = { id: hash, outcome: { logs, status: { SuccessValue: "" }, gas_burnt: 5_000_000_000_000, executor_id: "x", receipt_ids: [], tokens_burnt: "0" }, block_hash: "", proof: [] };
  return { transaction_outcome: o, receipts_outcome: [], status: { SuccessValue: Buffer.from(value).toString("base64") } } as unknown as TxOutcome;
}

/** A chain with one contract, a USDC token and per-key nonces; sends enforce nonce order. */
class FakeChain implements KeeperChain {
  nonces = new Map<string, bigint>();
  views = new Map<string, (args: Record<string, unknown>) => unknown>();
  sent: Sent[] = [];
  logsFor: (s: Sent) => string[] = () => [];
  height = HEIGHT;

  async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const f = this.views.get(`${contractId}.${method}`) ?? this.views.get(method);
    if (!f) throw new Error(`no fake view ${contractId}.${method}`);
    return f(args) as T;
  }
  async accessKey(accountId: string, publicKey: string) {
    const nonce = this.nonces.get(`${accountId}/${publicKey}`);
    return nonce === undefined ? null : { nonce, blockHeight: this.height, blockHash: "11111111111111111111111111111111" };
  }
  async freeNear(): Promise<bigint> {
    return 5n * 10n ** 24n;
  }
  async send(signed: Parameters<KeeperChain["send"]>[0], hash: string): Promise<TxOutcome> {
    const tx = signed.transaction;
    const key = `${tx.signerId}/${tx.publicKey.toString()}`;
    const current = this.nonces.get(key) ?? 0n;
    if (tx.nonce <= current) throw Object.assign(new Error(`InvalidNonce { tx_nonce: ${tx.nonce}, ak_nonce: ${current} }`), { name: "InvalidNonceError" });
    this.nonces.set(key, tx.nonce);
    const s: Sent = {
      signer: tx.signerId,
      receiver: tx.receiverId,
      nonce: tx.nonce,
      actions: tx.actions.map((a) => {
        const fc = a.functionCall;
        if (!fc) throw new Error("not a function call");
        return { method: fc.methodName, args: JSON.parse(Buffer.from(fc.args).toString()) as Record<string, unknown>, deposit: BigInt(fc.deposit) };
      }),
    };
    this.sent.push(s);
    const value = s.actions[0]?.method === "ft_transfer_call" ? JSON.stringify(s.actions[0].args.amount) : "";
    return outcome(hash, this.logsFor(s), value);
  }
  async known(): Promise<boolean> {
    return false;
  }
  async wait(): Promise<TxOutcome> {
    throw new Error("not known");
  }
}

const pk = (key: KeyPairString): string => KeyPair.fromString(key).getPublicKey().toString();

function config(over: Partial<KeeperConfig> = {}): KeeperConfig {
  return {
    ...DEFAULTS,
    contractId: "app.t",
    usdcId: "usdc.t",
    rpcUrls: ["http://127.0.0.1:1"],
    keeper: { accountId: "keeper.t", key: KEEPER_KEY },
    reporter: { accountId: "resolver.t", key: REPORTER_KEY },
    ...over,
  };
}

const REF_CONFIG = {
  enabled: true,
  guest: null,
  reporter_id: "resolver.t",
  min_sources: 3,
  max_spread_bps: 200,
  max_result_delay_sec: 300,
  borrow_max_age_sec: 3_600,
  liquidation_max_age_sec: 900,
  min_price: "100000000000000000",
  max_price: "100000000000000000000",
};

/** Exchange bodies around 3.34, observed within the last 40 s of NOW_SEC. */
const BODIES: Record<SourceName, string> = {
  coinbase: JSON.stringify({ price: "3.3429", time: "2026-11-14T04:19:50.000Z" }),
  kraken: JSON.stringify({ error: [], result: { NEARUSD: { c: ["3.33970", "1"] } } }),
  gemini: JSON.stringify({ last: "3.3477", volume: { timestamp: (NOW_SEC - 30) * 1000 } }),
  coingecko: `{"near":{"usd":3.34,"last_updated_at":${NOW_SEC - 35}}}`,
};
const fakeFetch = async (url: string) => {
  const source = (Object.keys(BODIES) as SourceName[]).find((s) => url.includes(s === "coinbase" ? "coinbase" : s));
  return { ok: true, status: 200, text: async () => (source ? BODIES[source] : "{}") };
};

function chainWith(opts: { reference?: unknown; borrowers?: unknown[]; quote?: (args: Record<string, unknown>) => unknown; usdc?: string } = {}): FakeChain {
  const c = new FakeChain();
  c.nonces.set(`keeper.t/${pk(KEEPER_KEY)}`, 277_000_000n * 1_000_000n + 5n);
  c.nonces.set(`resolver.t/${pk(REPORTER_KEY)}`, 277_000_000n * 1_000_000n + 9n);
  c.views.set("pause_state", () => ({ paused: [], since_sec: 0, liquidations_resume_at_sec: 0, guardian_id: null, pending_owner_id: null }));
  c.views.set("get_reference_config", () => REF_CONFIG);
  c.views.set("get_reference", () => opts.reference ?? null);
  c.views.set("scenario_count", () => 2);
  c.views.set("lending_tiers", (a) => [
    { tier: "safe", market: { borrowers: 0 } },
    { tier: "normal", market: { borrowers: 0 } },
    { tier: "bold", market: { borrowers: a.scenario_id === 1 && opts.borrowers ? opts.borrowers.length : 0 } },
  ]);
  c.views.set("borrowers", (a) => ({ scenario_id: a.scenario_id, tier: a.tier, total: opts.borrowers?.length ?? 0, from_index: 0, next_index: null, now_sec: NOW_SEC, rows: opts.borrowers ?? [] }));
  c.views.set("liquidation_quote", (a) => (opts.quote ? opts.quote(a) : null));
  c.views.set("storage_balance_of", () => ({ total: "500000000000000000000000", available: "400000000000000000000000" }));
  c.views.set("usdc.t.ft_balance_of", () => opts.usdc ?? "0");
  c.views.set("usdc.t.faucet_config", () => ({ owner_id: "usdc.t", max_mint_per_call: "1000000000" }));
  return c;
}

const deps = (chain: KeeperChain) => ({ chain, fetchFn: fakeFetch, now: () => NOW_SEC * 1000 });

test("window arithmetic: nonces of a window sit above every earlier window's and below the height bound", () => {
  const w = windowStart(HEIGHT, 100);
  assert.equal(w, 277_606_100);
  assert.equal(windowNonce(w), 277_606_100_000_000n);
  assert.ok(windowNonce(w) + 999_999n < BigInt(HEIGHT + 1) * 1_000_000n);
  assert.ok(windowNonce(windowStart(HEIGHT + 100, 100)) > windowNonce(w) + 999_999n);
  assert.equal(sentInWindow(windowNonce(w) - 1n, w), false);
  assert.equal(sentInWindow(windowNonce(w), w), true);
});

test("two rounds in one window: one transaction lands, the other round loses the nonce and stops", async () => {
  const c = chainWith();
  const a = await new Lane({ accountId: "keeper.t", key: KEEPER_KEY }).start(c, 100);
  const b = await new Lane({ accountId: "keeper.t", key: KEEPER_KEY }).start(c, 100);
  assert.ok(a.open && b.open);
  const first = await a.send(c, "app.t", [], "first");
  const second = await b.send(c, "app.t", [], "second");
  assert.equal(first.status, "ok");
  assert.equal(second.status, "lost");
  assert.equal(b.open, false);
  assert.equal(c.sent.length, 1);
  // a third round later in the same window does not even open
  const late = await new Lane({ accountId: "keeper.t", key: KEEPER_KEY }).start(c, 100);
  assert.equal(late.open, false);
  assert.match(late.reason, /already sent in window 277606100/);
  // the next window opens again
  c.height = HEIGHT + 100;
  assert.equal((await new Lane({ accountId: "keeper.t", key: KEEPER_KEY }).start(c, 100)).open, true);
});

test("a stale reference is replaced by the four-source median through report_reference", async () => {
  const c = chainWith({ reference: { price: "3300000000000000000", observed_at: NOW_SEC - 400, stored_at: NOW_SEC - 399, age_sec: 400, source: "reporter", sources_used: 0, spread_bps: 0, request: 0, pending: false } });
  const s = await runRound(config({ keeper: undefined }), deps(c));
  assert.equal(s.reference?.action, "posted", JSON.stringify(s.reference));
  assert.equal(s.reference?.price, "3.34145");
  assert.equal(c.sent.length, 1);
  const tx = c.sent[0];
  assert.equal(tx?.signer, "resolver.t");
  assert.equal(tx?.nonce, windowNonce(277_606_100));
  assert.deepEqual(tx?.actions[0]?.args, { price: "3341450000000000000", observed_at: NOW_SEC - 35 });
  assert.equal(s.ok, true);
});

test("a fresh reference, a pending OutLayer request, or another reporter: nothing is sent", async () => {
  const fresh = { price: "3340000000000000000", observed_at: NOW_SEC - 100, stored_at: NOW_SEC - 99, age_sec: 100, source: "reporter", sources_used: 0, spread_bps: 0, request: 0, pending: false };
  for (const [reference, reason] of [
    [fresh, /fresh: 100 s old/],
    [{ ...fresh, observed_at: NOW_SEC - 1000, pending: true }, /in flight/],
  ] as const) {
    const c = chainWith({ reference });
    const s = await runRound(config({ keeper: undefined }), deps(c));
    assert.equal(s.reference?.action, "skipped");
    assert.match(s.reference?.reason ?? "", reason);
    assert.equal(c.sent.length, 0);
  }
  const c = chainWith();
  c.views.set("get_reference_config", () => ({ ...REF_CONFIG, reporter_id: "someone.t" }));
  const s = await runRound(config({ keeper: undefined }), deps(c));
  assert.match(s.reference?.reason ?? "", /reporter is someone\.t/);
});

test("the contract's checks run before sending: too old for max_result_delay_sec, or a 15% jump within the hour", async () => {
  const c = chainWith();
  c.views.set("get_reference_config", () => ({ ...REF_CONFIG, max_result_delay_sec: 30 }));
  const s = await runRound(config({ keeper: undefined }), deps(c));
  assert.equal(s.reference?.action, "skipped");
  assert.match(s.reference?.reason ?? "", /oldest source is 35 s old/);
  assert.equal(c.sent.length, 0);
  const jump = chainWith({ reference: { price: "2800000000000000000", observed_at: NOW_SEC - 600, stored_at: 0, age_sec: 600, source: "reporter", sources_used: 0, spread_bps: 0, request: 0, pending: false } });
  const t = await runRound(config({ keeper: undefined }), deps(jump));
  assert.equal(t.reference?.action, "failed");
  assert.match(t.reference?.reason ?? "", /moved more than 1500 bps/);
  assert.equal(jump.sent.length, 0);
});

const ROW = {
  index: 0,
  account_id: "leo.t",
  debt: (900n * WAD).toString(),
  health_factor: "950000000000000000",
  worst_world: 1,
  c_min: "0",
  liquidation: "liquidatable",
  unpriced_world: null,
  max_repay: (450n * WAD).toString(),
  full_seize_repay: (900n * WAD).toString(),
  write_off_ready: false,
};

function quoteOf(repay: bigint, cash: bigint | null) {
  return (a: Record<string, unknown>) => ({
    error: null,
    liquidation: "liquidatable",
    debt: (900n * WAD).toString(),
    health_factor: "950000000000000000",
    cap: repay.toString(),
    full_seize_repay: (900n * WAD).toString(),
    repay: repay.toString(),
    target: "0",
    seize_all: false,
    written_off: "0",
    price_factor: WAD.toString(),
    pieces: [],
    cash: a.receive === "cash" && cash !== null ? { sold: [], received: [], merged: "0", real_usdc: "0", redeemed: "0", cash: cash.toString(), left_usdc: [], dead: [], guard_ok: true } : null,
  });
}

test("a liquidatable Bold loan: faucet top-up, then a cash liquidation sized by the quote", async () => {
  const c = chainWith({ borrowers: [ROW], quote: quoteOf(450n * WAD, 470n * WAD) });
  c.logsFor = (s) =>
    s.actions[0]?.method === "ft_transfer_call"
      ? [
          `EVENT_JSON:${JSON.stringify({ standard: "multiverse", version: "2.0.0", event: "liquidate", data: [{ repaid: (450n * WAD).toString(), written_off: "0" }] })}`,
          `EVENT_JSON:${JSON.stringify({ standard: "multiverse", version: "2.0.0", event: "cash_out", data: [{ cash: (469n * WAD).toString() }] })}`,
        ]
      : [];
  const s = await runRound(config({ reporter: undefined }), deps(c));
  const a = s.liquidations?.actions[0];
  assert.equal(a?.status, "sent", JSON.stringify(s, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
  assert.equal(a?.receive, "cash");
  // 450 + 10 bps of 900 = 450.9 USDC
  assert.equal(a?.budget, ((4509n * WAD) / 10n).toString());
  assert.deepEqual(a?.checks, { repaidWithinBudget: true, cashAtLeastMinOut: true });
  assert.equal(c.sent.length, 2);
  const [mint, liq] = c.sent;
  assert.equal(mint?.receiver, "usdc.t");
  assert.deepEqual(
    mint?.actions.map((x) => x.args.amount),
    ["1000000000", "1000000000", "1000000000", "1000000000", "1000000000"],
  );
  assert.equal(liq?.receiver, "usdc.t");
  assert.equal(liq?.nonce, (mint?.nonce ?? 0n) + 1n);
  assert.equal(liq?.actions[0]?.args.amount, "450900000");
  const msg = JSON.parse(String(liq?.actions[0]?.args.msg)) as Record<string, unknown>;
  assert.deepEqual(msg, { action: "liquidate", scenario_id: 1, account_id: "leo.t", repay_amount: "max", tier: "bold", receive: "cash", min_out: ((470n * WAD * 9950n) / 10000n).toString() });
});

test("a dry run quotes and decides but signs nothing", async () => {
  const c = chainWith({ borrowers: [ROW], quote: quoteOf(450n * WAD, 300n * WAD) });
  const s = await runRound(config({ dryRun: true }), deps(c));
  assert.equal(c.sent.length, 0);
  const a = s.liquidations?.actions[0];
  assert.equal(a?.status, "dry_run");
  assert.equal(a?.receive, "tokens");
  assert.equal(s.reference?.action, "dry_run");
});

test("paused liquidations, or a key that already sent in this window, send nothing", async () => {
  const c = chainWith({ borrowers: [ROW], quote: quoteOf(450n * WAD, 470n * WAD) });
  c.views.set("pause_state", () => ({ paused: ["liquidate"], since_sec: 0, liquidations_resume_at_sec: 0, guardian_id: null, pending_owner_id: null }));
  const s = await runRound(config({ reporter: undefined }), deps(c));
  assert.equal(s.liquidations?.skipped, "the liquidate flag is paused");
  const d = chainWith({ borrowers: [ROW], quote: quoteOf(450n * WAD, 470n * WAD), usdc: "9000000000" });
  d.nonces.set(`keeper.t/${pk(KEEPER_KEY)}`, windowNonce(277_606_100) + 3n);
  const t = await runRound(config({ reporter: undefined }), deps(d));
  assert.equal(t.liquidations?.actions[0]?.status, "locked");
  assert.equal(d.sent.length, 0);
});

test("callers: cron with the secret, ping without a header, anything else refused", () => {
  assert.equal(callerOf("Bearer s3cret", "s3cret"), "cron");
  assert.equal(callerOf(null, "s3cret"), "ping");
  assert.equal(callerOf("Bearer nope", "s3cret"), "denied");
  assert.equal(callerOf("Bearer s3cret", undefined), "denied");
});

test("the handler: a ping right after a round is answered from memory; a refused caller gets 401 without a round", async () => {
  let rounds = 0;
  const state: HandlerState = { running: null, lastAt: 0, last: null };
  let now = NOW_SEC * 1000;
  const c = chainWith();
  const h = {
    env: { CRON_SECRET: "s3cret", KEEPER_KEY, REPORTER_KEY } as NodeJS.ProcessEnv,
    now: () => now,
    chainFor: () => c,
    round: async (cfg: KeeperConfig) => {
      rounds += 1;
      return runRound({ ...cfg, dryRun: true }, deps(c));
    },
    state,
  };
  const req = (auth?: string) => new Request("https://x/api/keeper", { headers: auth ? { authorization: auth } : {} });
  assert.equal((await handle(req("Bearer wrong"), h)).status, 401);
  assert.equal(rounds, 0);
  const cron = await handle(req("Bearer s3cret"), h);
  assert.equal(cron.status, 200);
  const body = await cron.text();
  assert.equal(rounds, 1);
  assert.ok(!body.includes(KEEPER_KEY) && !body.includes("s3cret"), "no secret in the answer");
  now += 10_000;
  const ping = (await (await handle(req(), h)).json()) as { skipped?: string };
  assert.equal(ping.skipped, "recent");
  assert.equal(rounds, 1);
  now += PING_EVERY_MS;
  await handle(req(), h);
  assert.equal(rounds, 2);
});

test("configFromEnv refuses a malformed key and never needs one", () => {
  const targets = { contractId: "app.t", usdcId: "usdc.t", keeperId: "keeper.t", reporterId: "resolver.t" };
  assert.throws(() => configFromEnv({ KEEPER_KEY: "nope" }, targets), /KEEPER_KEY is not an ed25519 secret key/);
  const cfg = configFromEnv({}, targets);
  assert.equal(cfg.keeper, undefined);
  assert.equal(cfg.reporter, undefined);
  assert.equal(configFromEnv({ REPORTER_KEY }, targets).reporter?.accountId, "resolver.t");
});

// The maker

const MAKER_KEY = KeyPair.fromRandom("ed25519").toString() as KeyPairString;

/** One lendable 2-world market: odds 0.6 / 0.4, world prices 3.80 and 2.70, implied 3.36. */
function makerChain(reference: unknown, over: { registered?: boolean } = {}): FakeChain {
  const c = chainWith({ reference });
  c.nonces.set(`maker.t/${pk(MAKER_KEY)}`, 277_000_000n * 1_000_000n + 3n);
  const card = {
    scenario_id: 1, listed: true, origin: "owner", proposal_id: null, event_ids: [1, 2], world_count: 2, possible: 3, status: "open",
    categories: [1], deadline_sec: NOW_SEC + 86_400, created_at_sec: NOW_SEC - 86_400, odds: [(6n * WAD / 10n).toString(), (4n * WAD / 10n).toString()],
    odds_known: true, world_prices: ["3800000000000000000", "2700000000000000000"], implied_spot: "3360000000000000000", pool_value: "0",
    min_world_depth: "0", pool_count: 3, lendable: true, seed: null,
  };
  c.views.set("list_markets", () => ({ markets: [card, { ...card, scenario_id: 2, lendable: false }], next_from: null }));
  c.views.set("price_check", (a) => ({
    scenario_id: a.scenario_id,
    config: { min_age_sec: 1_800, min_depth: "0", reference: true, max_deviation: (WAD / 10n).toString(), max_haircut: "0" },
    reference: null, implied_twap_spot: "3350000000000000000", ratio: null, borrow_block: null, borrow_factor: WAD.toString(), liquidation_factor: WAD.toString(), liquidation_guard: false,
  }));
  const pool = (id: number, world: number, wnear: bigint, price: bigint, fee: number) => ({
    id, kind: "within", scenario_id: 1, world, mask0: 1 << world, mask1: 1 << world, token0: `1:wnear:${1 << world}`, token1: `1:usdc:${1 << world}`,
    wnear_reserve: wnear.toString(), usdc_reserve: ((wnear * price) / WAD).toString(), price: price.toString(), fee_pips: fee,
  });
  c.views.set("pools_of", () => [pool(1, 0, 100_000n * WAD, 380n * WAD / 100n, 15_000), pool(2, 1, 60_000n * WAD, 270n * WAD / 100n, 4_306)]);
  c.views.set("mt_batch_balance_of", (a) => (a.token_ids as string[]).map(() => "0"));
  if (!over.registered) c.views.set("storage_balance_of", (a) => (a.account_id === "maker.t" ? null : { total: "500000000000000000000000", available: "400000000000000000000000" }));
  c.views.set("usdc.t.faucet_config", () => ({ owner_id: "usdc.t", max_mint_per_call: "10000000000000" }));
  return c;
}
const stored = (price: bigint, ageSec: number) => ({ price: price.toString(), observed_at: NOW_SEC - ageSec, stored_at: NOW_SEC - ageSec, age_sec: ageSec, source: "reporter", sources_used: 3, spread_bps: 50, request: 0, pending: false });
const makerCfg = (over: Partial<KeeperConfig> = {}) => config({ keeper: undefined, reporter: undefined, wnearId: "wnear.t", maker: { accountId: "maker.t", key: MAKER_KEY }, ...over });

test("the maker follows the reference posted in the same round and sends nothing inside the 4% band", async () => {
  const c = makerChain(stored(3_300_000_000_000_000_000n, 400));
  const s = await runRound(makerCfg({ reporter: { accountId: "resolver.t", key: REPORTER_KEY } }), deps(c));
  assert.equal(s.reference?.action, "posted");
  assert.deepEqual(s.maker?.reference, { price: "3.34145", ageSec: 35, postedThisRound: true });
  assert.equal(s.maker?.markets.length, 1, "only the lendable market");
  assert.equal(s.maker?.markets[0]?.action, "within");
  assert.equal(s.maker?.markets[0]?.offBps, 55);
  assert.deepEqual(c.sent.map((t) => t.signer), ["resolver.t"]);
  assert.equal(s.ok, true);
});

test("past 4% the maker registers, mints, splits and swaps every world in one transaction; a second round in the window is locked", async () => {
  const ref = (3_360_000_000_000_000_000n * 106n) / 100n;
  const dry = makerChain(stored(ref, 100));
  const d = await runRound(makerCfg({ dryRun: true }), deps(dry));
  assert.equal(d.maker?.markets[0]?.action, "dry_run");
  assert.equal(d.maker?.markets[0]?.moves?.length, 2);
  assert.equal(dry.sent.length, 0);

  const c = makerChain(stored(ref, 100));
  const s = await runRound(makerCfg(), deps(c));
  const row = s.maker?.markets[0];
  assert.equal(row?.action, "sent", JSON.stringify(s.maker));
  assert.equal(row?.offBps, 600);
  assert.deepEqual(row?.moves?.map((m) => m.pay), ["usdc", "usdc"]);
  const w = windowNonce(277_606_100);
  assert.deepEqual(
    c.sent.map((t) => [t.receiver, t.actions.map((a) => a.method).join("+"), t.nonce - w]),
    [["app.t", "storage_deposit", 0n], ["usdc.t", "mint", 1n], ["usdc.t", "ft_transfer_call", 2n], ["app.t", "swap+swap", 3n]],
  );
  assert.equal(c.sent[0]?.actions[0]?.deposit, 10n ** 23n, "0.1 NEAR, the contract's minimum");
  const split = c.sent[2]?.actions[0]?.args;
  assert.deepEqual(JSON.parse(split?.msg as string), { action: "split", scenario_id: 1, to_masks: [1, 2] });
  assert.equal(split?.amount, c.sent[1]?.actions[0]?.args.amount, "mints exactly what the split needs");
  const swaps = c.sent[3]?.actions ?? [];
  assert.deepEqual(swaps.map((a) => [a.args.pool_id, a.args.zero_for_one, a.deposit]), [[1, false, 1n], [2, false, 1n]]);
  for (const a of swaps) assert.ok(BigInt(a.args.min_out as string) > 0n, "every swap has a min_out");
  assert.equal(s.ok, true);

  const again = await runRound(makerCfg(), deps(c));
  assert.equal(again.maker?.markets[0]?.action, "locked");
  assert.equal(c.sent.length, 4);
});

test("the maker leaves a stale reference and a jump past 25% alone", async () => {
  const stale = await runRound(makerCfg(), deps(makerChain(stored(3_560_000_000_000_000_000n, 1_000))));
  assert.match(stale.maker?.skipped ?? "", /1000 s old/);
  const far = makerChain(stored(4_500_000_000_000_000_000n, 60));
  const s = await runRound(makerCfg(), deps(far));
  assert.equal(s.maker?.markets[0]?.action, "too_far");
  assert.equal(far.sent.length, 0);
});

test("configFromEnv: MAKER_KEY signs as the maker target; MAKER_THRESHOLD_BPS moves the band", () => {
  const targets = { contractId: "app.t", usdcId: "usdc.t", keeperId: "keeper.t", reporterId: "resolver.t", makerId: "maker.t", wnearId: "wnear.t" };
  const cfg = configFromEnv({ MAKER_KEY, MAKER_THRESHOLD_BPS: "250" }, targets);
  assert.equal(cfg.maker?.accountId, "maker.t");
  assert.equal(cfg.makerPlan.thresholdBps, 250);
  assert.equal(configFromEnv({}, targets).makerPlan.thresholdBps, 400);
  assert.throws(() => configFromEnv({ MAKER_THRESHOLD_BPS: "4%" }, targets), /MAKER_THRESHOLD_BPS/);
  assert.throws(() => configFromEnv({ MAKER_KEY }, { ...targets, makerId: undefined }), /maker account is unknown/);
});
