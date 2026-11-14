// The keeper as a Vercel function: GET or POST /api/keeper runs one keeper round (lib/keeper.ts) and
// answers with its JSON summary. scripts/deploy-web.sh bundles this file into api/keeper.js of the
// deploy directory, with the deployment's account ids baked in as KEEPER_TARGETS.
//
// Two callers:
// - Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`: always a full round.
// - Open pages of the site ping it without credentials (web/src/lib/keeper-ping.ts, at most once a
//   minute per browser). A ping is answered without a round when this instance ran one less than
//   55 s ago, or when the keeper key has already sent in the current block window (one access-key
//   read). Sends are gated by the window either way, so however often the URL is hit, the keys
//   sign at most one round's transactions per window (about a minute).
// A wrong Authorization header is refused. Keys come only from the environment: KEEPER_KEY,
// REPORTER_KEY, MAKER_KEY (and CRON_SECRET); nothing here prints them.

import { timingSafeEqual } from "node:crypto";

import { configFromEnv, rpcChain, rpcPoolFor, runRound, summaryJson, windowTaken, type KeeperChain, type KeeperConfig, type KeeperTargets, type RoundSummary } from "../lib/keeper.ts";

declare const KEEPER_TARGETS: KeeperTargets | undefined;

/** The staging deployment unless the bundle was built with other targets. */
export const TARGETS: KeeperTargets =
  typeof KEEPER_TARGETS === "undefined"
    ? {
        contractId: "app.ifverse-staging.testnet",
        usdcId: "usdc.ifverse-staging.testnet",
        wnearId: "wnear.ifverse-staging.testnet",
        keeperId: "keeper.ifverse-staging.testnet",
        reporterId: "resolver.ifverse-staging.testnet",
        makerId: "maker.ifverse-staging.testnet",
      }
    : KEEPER_TARGETS;

export const PING_EVERY_MS = 55_000;
/** Answer before Vercel's maxDuration (60 s) even if an RPC call hangs. */
const HARD_STOP_MS = 50_000;

export type Caller = "cron" | "ping" | "denied";

/** Cron when the header carries CRON_SECRET; no header = a public ping; anything else is refused. */
export function callerOf(authorization: string | null, secret: string | undefined): Caller {
  if (!authorization) return "ping";
  if (!secret) return "denied";
  const want = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(authorization);
  return got.length === want.length && timingSafeEqual(got, want) ? "cron" : "denied";
}

export interface HandlerState {
  running: Promise<RoundSummary> | null;
  lastAt: number;
  last: unknown;
}

export interface HandlerDeps {
  env: NodeJS.ProcessEnv;
  now: () => number;
  chainFor: (cfg: KeeperConfig, deadline: () => number) => KeeperChain;
  round: (cfg: KeeperConfig, chain: KeeperChain) => Promise<RoundSummary>;
  state: HandlerState;
}

const json = (status: number, body: unknown): Response =>
  new Response(summaryJson(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** The short form a ping gets back: what happened, without the per-row detail. */
function brief(s: RoundSummary): unknown {
  return {
    ok: s.ok,
    startedAt: s.startedAt,
    ms: s.ms,
    window: s.window,
    reference: s.reference ? { action: s.reference.action, reason: s.reference.reason, price: s.reference.price, tx: s.reference.tx } : null,
    maker: s.maker
      ? { skipped: s.maker.skipped, markets: s.maker.markets.map((m) => ({ scenarioId: m.scenarioId, offBps: m.offBps, action: m.action, tx: m.tx })) }
      : null,
    liquidations: s.liquidations
      ? { skipped: s.liquidations.skipped, candidates: s.liquidations.candidates, sent: s.liquidations.actions.filter((a) => a.status === "sent").map((a) => a.tx) }
      : null,
    errors: s.errors.length,
  };
}

function withHardStop(p: Promise<RoundSummary>, ms: number, startedAt: number): Promise<RoundSummary> {
  return Promise.race([
    p,
    new Promise<RoundSummary>((resolve) =>
      setTimeout(
        () =>
          resolve({
            ok: false,
            dryRun: false,
            contractId: "",
            startedAt: new Date(startedAt).toISOString(),
            ms,
            window: null,
            reporter: null,
            keeper: null,
            reference: null,
            maker: null,
            liquidations: null,
            errors: [`the round did not finish within ${ms / 1000} s; the next one picks up from the chain`],
          }),
        ms,
      ).unref?.(),
    ),
  ]);
}

export async function handle(request: Request, deps: HandlerDeps): Promise<Response> {
  const caller = callerOf(request.headers.get("authorization"), deps.env.CRON_SECRET);
  if (caller === "denied") return json(401, { error: "unauthorized" });
  let cfg: KeeperConfig;
  try {
    cfg = configFromEnv(deps.env, TARGETS);
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : "bad configuration" });
  }
  if (!cfg.keeper && !cfg.reporter && !cfg.maker) return json(503, { error: "none of KEEPER_KEY, REPORTER_KEY, MAKER_KEY is set" });
  const st = deps.state;
  const now = deps.now();
  if (st.running) return json(200, { caller, skipped: "a round is already running in this instance" });
  if (caller === "ping") {
    if (now - st.lastAt < PING_EVERY_MS) return json(200, { caller, skipped: "recent", last: st.last });
    st.lastAt = now;
    const w = await windowTaken(cfg, deps.chainFor(cfg, () => now + 10_000)).catch(() => ({ taken: false, window: null }));
    if (w.taken) {
      st.last = { skipped: "window", window: w.window };
      return json(200, { caller, skipped: `the keys already sent in window ${w.window}` });
    }
  }
  const chain = deps.chainFor(cfg, () => now + cfg.budgetMs);
  st.running = withHardStop(deps.round(cfg, chain), HARD_STOP_MS, now);
  try {
    const summary = await st.running;
    st.lastAt = deps.now();
    st.last = brief(summary);
    return json(200, caller === "cron" ? { caller, ...summary } : { caller, ...(brief(summary) as object) });
  } finally {
    st.running = null;
  }
}

// One RPC pool per warm instance, so its rate-limit memory carries over between invocations.
let pool: ReturnType<typeof rpcPoolFor> | null = null;
const state: HandlerState = { running: null, lastAt: 0, last: null };

const live: HandlerDeps = {
  env: process.env,
  now: () => Date.now(),
  chainFor: (cfg, deadline) => {
    pool ??= rpcPoolFor(cfg.rpcUrls);
    return rpcChain(pool, deadline);
  },
  round: (cfg, chain) => runRound(cfg, { chain }),
  state,
};

export function GET(request: Request): Promise<Response> {
  return handle(request, live);
}

export function POST(request: Request): Promise<Response> {
  return handle(request, live);
}
