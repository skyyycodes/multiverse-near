import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanError } from "./outcome";
import { ChainError, createRpcSource, limiter, MAX_IN_FLIGHT, TransportError } from "./rpc";

const A = "https://a.example";
const B = "https://b.example";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const bytes = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));

function serve(answers: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return answers[url]();
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("which RPC errors are worth another node", () => {
  it("moves on when a node is down, rate-limited or broken", async () => {
    for (const bad of [
      () => Promise.reject(new TypeError("fetch failed")),
      () => json({}, 429),
      () => json({}, 503),
      () => json({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } } }),
    ]) {
      const calls = serve({ [A]: bad, [B]: () => json({ result: { result: bytes("7") } }) });
      await expect(createRpcSource([A, B]).view("app.test.near", "debt_of")).resolves.toBe("7");
      expect(calls).toEqual([A, B]);
    }
  });

  it("returns a contract panic at once, in the contract's words, even when it looks like an HTTP status", async () => {
    const panic = { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR", info: { vm_error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "InsufficientOutput(3, 500, 502)" })' } } };
    const calls = serve({ [A]: () => json({ jsonrpc: "2.0", error: panic }), [B]: () => json({ result: { result: bytes("1") } }) });
    const err = await createRpcSource([A, B]).view("app.test.near", "quote_sell").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainError);
    expect((err as Error).message).toBe("InsufficientOutput(3, 500, 502)");
    expect(calls).toEqual([A]);
  });

  it("reads a panic that older nodes put inside the result", async () => {
    serve({ [A]: () => json({ result: { error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "DepositTooSmall" })', logs: [] } }) });
    await expect(createRpcSource([A]).view("app.test.near", "preview_lp_deposit")).rejects.toThrow(/^DepositTooSmall$/);
  });

  it("treats a missing account as an answer", async () => {
    const calls = serve({
      [A]: () => json({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: "app.x.testnet" } } } }),
      [B]: () => json({ result: { result: bytes(1) } }),
    });
    await expect(createRpcSource([A, B]).view("app.x.testnet", "get_app_config")).rejects.toThrow("Account app.x.testnet does not exist");
    expect(calls).toEqual([A]);
  });

  it("says so when no node answers", async () => {
    serve({ [A]: () => json({}, 502), [B]: () => json({}, 502) });
    await expect(createRpcSource([A, B]).view("app.test.near", "get_app_config")).rejects.toBeInstanceOf(TransportError);
  });

  it("decodes an empty return as null", async () => {
    serve({ [A]: () => json({ result: { result: [] } }) });
    await expect(createRpcSource([A]).view("app.test.near", "storage_balance_of")).resolves.toBeNull();
  });

  it("keeps only the contract's words from a view panic", () => {
    expect(cleanError('wasm execution failed with error: HostError(GuestPanic { panic_msg: "DepositTooSmall" })')).toBe("DepositTooSmall");
    expect(cleanError('wasm execution failed with error: HostError(GuestPanic { panic_msg: "PoolNotInitialized(3)" })')).toBe("PoolNotInitialized(3)");
  });
});

describe("the account read (About dialog, gas float)", () => {
  it("reads view_account at final, from the next node when one is down", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      if (url === A) return json({}, 503);
      return json({ result: { amount: "2500000000000000000000000", code_hash: "G6GtUs6AqHfxRb8YCdBx5dv1bgiQ3c1gDhPE9ygQTkEt", storage_usage: 934321, block_height: 1 } });
    });
    await expect(createRpcSource([A, B]).account("app.multiverse-near.testnet")).resolves.toEqual({
      codeHash: "G6GtUs6AqHfxRb8YCdBx5dv1bgiQ3c1gDhPE9ygQTkEt",
      amount: "2500000000000000000000000",
      storageUsage: 934321,
    });
    expect(bodies[1]).toMatchObject({ method: "query", params: { request_type: "view_account", finality: "final", account_id: "app.multiverse-near.testnet" } });
  });

  it("says when the account does not exist", async () => {
    serve({ [A]: () => json({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: "nobody.testnet" } } } }) });
    await expect(createRpcSource([A]).account("nobody.testnet")).rejects.toThrow("Account nobody.testnet does not exist");
  });
});

describe("reads in flight", () => {
  it("runs at most the limit at once, in order, and hands each slot on", async () => {
    const run = limiter(2);
    let now = 0;
    let most = 0;
    const order: number[] = [];
    const job = (i: number) => run(async () => {
      most = Math.max(most, ++now);
      order.push(i);
      await new Promise((r) => setTimeout(r, 5));
      now--;
      return i;
    });
    await expect(Promise.all([1, 2, 3, 4, 5].map(job))).resolves.toEqual([1, 2, 3, 4, 5]);
    expect(most).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("frees the slot when a job fails", async () => {
    const run = limiter(1);
    await expect(run(() => Promise.reject(new Error("no")))).rejects.toThrow("no");
    await expect(run(async () => 1)).resolves.toBe(1);
  });

  it("keeps a page's burst of view calls under the limit", async () => {
    let now = 0;
    let most = 0;
    vi.stubGlobal("fetch", async () => {
      most = Math.max(most, ++now);
      await new Promise((r) => setTimeout(r, 2));
      now--;
      return json({ result: { result: bytes(1) } });
    });
    const src = createRpcSource([A]);
    await Promise.all(Array.from({ length: 20 }, () => src.view("app.test.near", "get_market")));
    expect(most).toBe(MAX_IN_FLIGHT);
  });
});
