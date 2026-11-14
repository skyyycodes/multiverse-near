// Every internal link of the app (web design 3.2). Routes are query-param pages of the static export, so a market,
// a tier or a proposal lives in the URL and every visible page has a shareable address.
import type { Tier } from "./domain";

type Params = Record<string, string | number | undefined>;

/**
 * `path?k=v&…`, dropping undefined values, keeping insertion order and the trailing slash before `?`. Commas stay
 * readable (`events=7,8`).
 */
export function q(path: string, params: Params = {}): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v)).replace(/%2C/gi, ",")}`);
  return parts.length ? `${path}?${parts.join("&")}` : path;
}

/** Normal is a tier's default and never appears in a URL. */
const tierParam = (tier: Tier | undefined) => (tier === "normal" ? undefined : tier);

export const marketsHref = "/";
export const marketHref = (sid: number) => `/market/?id=${sid}`;
export const sellHref = (sid: number, o: { sel?: number; w?: number } = {}) => q("/sell/", { id: sid, sel: o.sel, w: o.w });
export const ordersHref = (sid: number, o: { w?: number; buy?: boolean } = {}) => q("/orders/", { id: sid, w: o.w, buy: o.buy ? 1 : undefined });
export const splitHref = (sid: number, o: { asset?: "wnear" | "usdc"; mode?: "split" | "merge" } = {}) => q("/split/", { id: sid, asset: o.asset, mode: o.mode });
export const worldHref = (sid: number, w: number) => `/world/?id=${sid}&w=${w}`;
export const borrowHref = (sid: number, tier?: Tier) => q("/borrow/", { id: sid, tier: tierParam(tier) });
export const lendHref = (sid: number, tier?: Tier) => q("/lend/", { id: sid, tier: tierParam(tier) });
export const resolveHref = (sid: number) => `/resolve/?id=${sid}`;
export const proposalHref = (pid: number) => `/proposal/?p=${pid}`;
export const proposeHref = (o: { kind?: "event" | "market"; events?: readonly number[] } = {}) =>
  q("/propose/", { kind: o.kind, events: o.events?.length ? o.events.join(",") : undefined });
export const liquidateHref = (sid?: number) => q("/liquidate/", { id: sid });
export const adminHref = (sid?: number) => q("/admin/", { id: sid });
export const welcomeHref = "/welcome/";

/** The absolute link "Share" copies: this site's origin plus the market's page. */
export const shareUrl = (sid: number, origin: string = typeof window === "undefined" ? "" : window.location.origin) => `${origin}${marketHref(sid)}`;
