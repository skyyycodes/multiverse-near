// Wakes the hosted keeper while the site is open. The keeper (scripts/api/keeper.ts, deployed at /api/keeper/) posts
// the NEAR/USD reference and liquidates unhealthy loans; Vercel Cron calls it every minute when the plan allows, and
// these pings keep it running when the cron cannot. Fire-and-forget: at most one ping per minute per browser (shared
// by every tab through localStorage), only from a visible tab, only on the hosted staging build. The function decides
// from the chain whether a round is due, so a ping can never make it send twice.
import { ENV, FIXTURES, PRELAUNCH } from "./env";

/** With the trailing slash: the site redirects /api/keeper to it. */
export const KEEPER_PING_PATH = "/api/keeper/";
export const KEEPER_PING_EVERY_MS = 60_000;
const STORAGE_KEY = "ifverse.keeperPingAt";

/** Due when never pinged, a minute has passed, or the stored time is unreadable or in the future. */
export function pingDue(lastAt: number | null, now: number): boolean {
  if (lastAt === null || !Number.isFinite(lastAt) || lastAt > now) return true;
  return now - lastAt >= KEEPER_PING_EVERY_MS;
}

interface PingEnv {
  now: number;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  visible: boolean;
  send: (path: string) => Promise<unknown>;
}

/** Sends one ping if this build has a hosted keeper and none was sent in the last minute; true when it sent. */
export function pingKeeper(env: PingEnv, enabled = ENV.network === "staging" && !FIXTURES && !PRELAUNCH): boolean {
  if (!enabled || !env.visible) return false;
  let last: number | null = null;
  try {
    const raw = env.storage?.getItem(STORAGE_KEY);
    last = raw ? Number(raw) : null;
  } catch {
    // storage blocked: the per-tab interval still limits the rate
  }
  if (!pingDue(last, env.now)) return false;
  try {
    env.storage?.setItem(STORAGE_KEY, String(env.now));
  } catch {
    // as above
  }
  env.send(KEEPER_PING_PATH).catch(() => undefined);
  return true;
}

function browserEnv(): PingEnv {
  let storage: PingEnv["storage"] = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return {
    now: Date.now(),
    storage,
    visible: document.visibilityState === "visible",
    send: (path) => fetch(path, { method: "POST", keepalive: true, cache: "no-store" }),
  };
}

/** Pings now and every minute; returns the cleanup for a React effect. */
export function startKeeperPings(): () => void {
  const tick = () => {
    pingKeeper(browserEnv());
  };
  tick();
  const id = window.setInterval(tick, KEEPER_PING_EVERY_MS);
  document.addEventListener("visibilitychange", tick);
  return () => {
    window.clearInterval(id);
    document.removeEventListener("visibilitychange", tick);
  };
}
