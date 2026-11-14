// Optional alerts from the bots, the watcher and the soak: when NOTIFY_WEBHOOK_URL is set, POST
// `{level, source, text}` as JSON. A failed or slow webhook never stops the caller: the alert is
// also printed, and the result says whether it was delivered.

export type NotifyLevel = "info" | "warn" | "critical";

export interface NotifyResult {
  delivered: boolean;
  /** Why it was not delivered: no webhook configured, an HTTP status, or the error. */
  reason?: string;
}

const TIMEOUT_MS = 5_000;

/** Webhook URLs must be https (http only for a local listener), so alerts never travel in the clear. */
export function webhookUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.NOTIFY_WEBHOOK_URL ?? "").trim();
  if (raw === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("NOTIFY_WEBHOOK_URL is not a URL");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("NOTIFY_WEBHOOK_URL must be https (or http on localhost)");
  return url.toString();
}

export async function notify(
  level: NotifyLevel,
  source: string,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyResult> {
  console.log(`[${level}] ${source}: ${text}`);
  let url: string | null;
  try {
    url = webhookUrl(env);
  } catch (err) {
    return { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (url === null) return { delivered: false, reason: "no webhook configured" };
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level, source, text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { delivered: false, reason: `HTTP ${res.status}` };
    return { delivered: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`  (webhook not reached: ${reason})`);
    return { delivered: false, reason };
  }
}
