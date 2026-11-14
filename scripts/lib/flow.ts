// The step framework of the end-to-end flows (moved out of e2e.ts): named steps, checks that print
// what held, expected failures, and steps reported as pending when the contract build lacks a part
// (it answers NotImplemented) together with every step that depends on them.

import { TxFailedError } from "./near.ts";

/** Thrown by a step to report it pending; the message names what is missing. */
export class Pending extends Error {}

export function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`    ok: ${what}`);
}

/** Runs `task`, which must fail; returns the failure text. */
export async function expectFailure(task: Promise<unknown>, pattern: RegExp, what: string): Promise<string> {
  try {
    await task;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (!pattern.test(text)) throw new Error(`${what}: failed, but not with ${pattern}: ${text}`);
    console.log(`    ok: ${what} (${pattern.exec(text)?.[0] ?? ""})`);
    return text;
  }
  throw new Error(`${what}: expected a failure, but it went through`);
}

/** The part a NotImplemented panic names, if `err` is one. */
export const notImplemented = (err: unknown): string | undefined =>
  err instanceof TxFailedError ? /NotImplemented\(([a-z_]+)\)/.exec(err.message)?.[1] : undefined;

export interface StepResult {
  name: string;
  status: "ok" | "pending" | "failed";
  detail: string;
}

export class Flow {
  readonly results: StepResult[] = [];
  private readonly missing = new Set<string>();
  private readonly after: ((name: string) => Promise<void>)[] = [];

  /** Runs after every step that went through (e.g. backing and books checks), as part of that step. */
  afterEach(hook: (name: string) => Promise<void>): void {
    this.after.push(hook);
  }

  async step(name: string, needs: string[], task: () => Promise<void>): Promise<void> {
    const blocked = needs.filter((n) => this.missing.has(n));
    console.log(`\n== ${name}`);
    if (blocked.length > 0) {
      console.log(`  pending: needs ${blocked.join(", ")}`);
      this.results.push({ name, status: "pending", detail: `needs ${blocked.join(", ")}` });
      this.missing.add(name);
      return;
    }
    try {
      await task();
      for (const hook of this.after) await hook(name);
      this.results.push({ name, status: "ok", detail: "" });
    } catch (err) {
      const missing = err instanceof Pending ? err.message : notImplemented(err);
      if (missing) {
        console.log(`  pending: ${missing} is not in this contract build`);
        this.results.push({ name, status: "pending", detail: `${missing} not implemented` });
        this.missing.add(name);
        return;
      }
      this.results.push({ name, status: "failed", detail: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /** Prints the summary; returns how many steps are pending. */
  summary(): number {
    console.log("\n== summary");
    for (const r of this.results) console.log(`  ${r.status.padEnd(7)} ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
    return this.results.filter((r) => r.status === "pending").length;
  }
}
