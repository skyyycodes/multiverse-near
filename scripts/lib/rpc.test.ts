import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SignedTransaction, TxExecutionStatus } from "near-api-js";
import {
  InvalidNonceError,
  LackBalanceForStateActionError,
  NotEnoughBalanceError,
  TransactionExpiredError,
  TransactionTimeoutError,
  UnknownBlockError,
  UnknownTransactionError,
} from "near-api-js/rpc-errors";

import { SendUnresolved, sendSigned, signAndSend, type SendProvider, type TxOutcome } from "./near.ts";
import {
  backoffMs,
  classifyRpcError,
  defaultRps,
  endpointsFromEnv,
  headersFor,
  isMissingBlock,
  pooledProvider,
  RpcExhausted,
  RpcPool,
  type Clock,
  type Endpoint,
} from "./rpc.ts";

class FakeClock implements Clock {
  t = 1_000_000;
  readonly slept: number[] = [];
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.t += ms;
  }
}

const rateLimited = (): Error => new Error("Too Many Requests", { cause: 429 });
const badGateway = (): Error => new Error("https://x Bad Gateway", { cause: 502 });
const ep = (url: string, rps = 4): Endpoint => ({ url, headers: {}, rps });

interface Fake {
  url: string;
  calls: number;
}

/** A pool over fake providers; `behave(url, call#)` decides what each call does. */
function fakePool(urls: string[], clock: FakeClock, rand = (): number => 0.5, rps = 4): { pool: RpcPool<Fake>; fakes: Map<string, Fake> } {
  const fakes = new Map<string, Fake>();
  const pool = new RpcPool<Fake>(urls.map((u) => ep(u, rps)), clock, rand, (e) => {
    const f = { url: e.url, calls: 0 };
    fakes.set(e.url, f);
    return f;
  });
  return { pool, fakes };
}

describe("classifyRpcError", () => {
  const cases: [string, unknown, string][] = [
    ["429 from the library", rateLimited(), "rate_limited"],
    ["429 text only", new Error("429 Too Many Requests"), "rate_limited"],
    ["502", badGateway(), "transient"],
    ["503", new Error("https://x unavailable", { cause: 503 }), "transient"],
    ["500", new Error("Internal server error", { cause: 500 }), "transient"],
    ["408", new Error("Timeout error", { cause: 408 }), "transient"],
    ["fetch error", new TypeError("fetch failed"), "transient"],
    ["connection reset", new Error("read ECONNRESET"), "transient"],
    ["unknown block (node behind)", new UnknownBlockError(), "transient"],
    ["InvalidNonce", new InvalidNonceError(5, 3, "h", "b"), "invalid_nonce"],
    ["Expired", new TransactionExpiredError("h", "b"), "expired"],
    ["TIMEOUT_ERROR", new TransactionTimeoutError(), "timeout"],
    ["UNKNOWN_TRANSACTION", new UnknownTransactionError("h"), "unknown_tx"],
    ["NotEnoughBalance", new NotEnoughBalanceError(1n, 2n, "a.testnet", "h", "b"), "fatal"],
    ["LackBalanceForState", new LackBalanceForStateActionError("a.testnet", 5n, 0, "h", "b"), "fatal"],
    ["a contract panic", new Error("Smart contract panicked: PriceUnavailable(2)"), "fatal"],
  ];
  for (const [name, err, want] of cases) {
    it(`${name} -> ${want}`, () => assert.equal(classifyRpcError(err), want));
  }

  it("keeps the text of the fatal balance errors", () => {
    const err = new NotEnoughBalanceError(1n, 2n, "alice.ifverse-staging.testnet", "h", "b");
    assert.equal(classifyRpcError(err), "fatal");
    assert.match(err.message, /alice\.ifverse-staging\.testnet|balance/i);
  });

  it("tells a missing block from other errors", () => {
    assert.equal(isMissingBlock(new UnknownBlockError()), true);
    assert.equal(isMissingBlock(new Error("[-32000] Server error: DB Not Found Error: BLOCK HEIGHT: 1 UNKNOWN_BLOCK")), true);
    assert.equal(isMissingBlock(rateLimited()), false);
  });
});

describe("backoffMs", () => {
  it("doubles from 2 s with ±50% jitter", () => {
    assert.equal(backoffMs(1, () => 0), 1_000);
    assert.equal(backoffMs(1, () => 0.5), 2_000);
    assert.equal(backoffMs(2, () => 0.5), 4_000);
    assert.equal(backoffMs(3, () => 0.999), 11_992);
  });

  it("caps at 600 s before jitter", () => {
    assert.equal(backoffMs(20, () => 0.5), 600_000);
    assert.equal(backoffMs(60, () => 0), 300_000);
    assert.ok(backoffMs(60, () => 0.999_999) < 900_000);
  });
});

describe("endpoints", () => {
  it("sends the API key to fastnear hosts only", () => {
    assert.deepEqual(headersFor("https://test.rpc.fastnear.com", "k"), { Authorization: "Bearer k" });
    assert.deepEqual(headersFor("https://archival-rpc.testnet.fastnear.com", "k"), { Authorization: "Bearer k" });
    assert.deepEqual(headersFor("https://near-testnet.drpc.org", "k"), {});
    assert.deepEqual(headersFor("https://evil-fastnear.com.example.org", "k"), {});
    assert.deepEqual(headersFor("https://test.rpc.fastnear.com", undefined), {});
  });

  it("budgets 4 rps for fastnear, 2 for drpc, 50 for a local node", () => {
    assert.equal(defaultRps("https://rpc.testnet.fastnear.com"), 4);
    assert.equal(defaultRps("https://near-testnet.drpc.org"), 2);
    assert.equal(defaultRps("http://127.0.0.1:3030"), 50);
  });

  it("takes NEAR_RPC_URLS, then NEAR_RPC_URL, then the network's list", () => {
    const cfg = { rpcUrls: ["https://a.fastnear.com", "https://b.drpc.org"] };
    assert.deepEqual(endpointsFromEnv(cfg, {}).map((e) => [e.url, e.rps]), [["https://a.fastnear.com", 4], ["https://b.drpc.org", 2]]);
    assert.deepEqual(endpointsFromEnv(cfg, { NEAR_RPC_URL: "http://127.0.0.1:3030" }).map((e) => e.url), ["http://127.0.0.1:3030"]);
    assert.deepEqual(
      endpointsFromEnv(cfg, { NEAR_RPC_URL: "http://x", NEAR_RPC_URLS: " https://c.fastnear.com, https://d.org " }).map((e) => e.url),
      ["https://c.fastnear.com", "https://d.org"],
    );
    assert.deepEqual(endpointsFromEnv(cfg, { NEAR_RPC_RPS: "7" }).map((e) => e.rps), [7, 7]);
    assert.throws(() => endpointsFromEnv(cfg, { NEAR_RPC_RPS: "0" }), /NEAR_RPC_RPS must be a positive number/);
  });
});

describe("RpcPool", () => {
  it("lets a burst of 2 × rps through, then waits for tokens", async () => {
    const clock = new FakeClock();
    const { pool } = fakePool(["https://a"], clock, () => 0.5, 2);
    for (let i = 0; i < 4; i++) await pool.run(async () => i);
    assert.deepEqual(clock.slept, []);
    await pool.run(async () => 5);
    assert.deepEqual(clock.slept, [500]);
  });

  it("uses the primary while it is healthy", async () => {
    const clock = new FakeClock();
    const { pool, fakes } = fakePool(["https://a", "https://b"], clock);
    for (let i = 0; i < 3; i++) await pool.run(async (p) => (p.calls += 1));
    assert.equal(fakes.get("https://a")?.calls, 3);
    assert.equal(fakes.get("https://b")?.calls, 0);
  });

  it("fails over after a 429 and cools the endpoint by backoffMs", async () => {
    const clock = new FakeClock();
    const { pool } = fakePool(["https://a", "https://b"], clock, () => 0.5);
    const seen: string[] = [];
    const value = await pool.run(async (p) => {
      seen.push(p.url);
      if (p.url === "https://a") throw rateLimited();
      return "ok";
    });
    assert.equal(value, "ok");
    assert.deepEqual(seen, ["https://a", "https://b"]);
    const a = pool.stats().find((s) => s.url === "https://a");
    assert.equal(a?.rateLimited, 1);
    assert.equal(a?.coolingUntil, clock.now() + 2_000);
    // while a cools, b takes the calls; once it has cooled, a is the primary again
    seen.length = 0;
    await pool.run(async (p) => seen.push(p.url));
    clock.t += 2_001;
    await pool.run(async (p) => seen.push(p.url));
    assert.deepEqual(seen, ["https://b", "https://a"]);
  });

  it("grows the cooling with consecutive 429s and resets it after a success", async () => {
    const clock = new FakeClock();
    const { pool } = fakePool(["https://a"], clock, () => 0.5);
    let n = 0;
    const value = await pool.run(async () => {
      n += 1;
      if (n <= 3) throw rateLimited();
      return n;
    });
    assert.equal(value, 4);
    assert.deepEqual(clock.slept, [2_000, 4_000, 8_000]);
    await pool.run(async () => {
      throw rateLimited();
    }, { retry: false }).catch(() => undefined);
    assert.equal(pool.stats()[0]?.coolingUntil, clock.now() + 2_000);
  });

  it("waits for the earliest cooling endpoint and gives up after maxWaitMs", async () => {
    const clock = new FakeClock();
    const { pool } = fakePool(["https://a", "https://b"], clock, () => 0.5);
    await assert.rejects(
      pool.run(async () => {
        throw rateLimited();
      }, { maxWaitMs: 30_000, label: "t" }),
      (err: unknown) => err instanceof RpcExhausted && /RpcExhausted\(t\)/.test(err.message),
    );
    assert.ok(clock.slept.length > 0);
  });

  it("moves to the next endpoint after a transient error, at most a bounded number of times", async () => {
    const clock = new FakeClock();
    const { pool } = fakePool(["https://a", "https://b"], clock);
    const seen: string[] = [];
    assert.equal(
      await pool.run(async (p) => {
        seen.push(p.url);
        if (seen.length === 1) throw badGateway();
        return "ok";
      }),
      "ok",
    );
    assert.deepEqual(seen, ["https://a", "https://b"]);
    let calls = 0;
    await assert.rejects(
      pool.run(async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      }),
      /fetch failed/,
    );
    assert.equal(calls, 7);
  });

  it("hands a fatal error to the caller at once", async () => {
    const clock = new FakeClock();
    const { pool, fakes } = fakePool(["https://a", "https://b"], clock);
    await assert.rejects(
      pool.run(async (p) => {
        p.calls += 1;
        throw new Error("Smart contract panicked: NotOwner");
      }),
      /NotOwner/,
    );
    assert.equal(fakes.get("https://a")?.calls, 1);
    assert.equal(fakes.get("https://b")?.calls, 0);
  });

  it("with retry off, runs once and still cools the endpoint", async () => {
    const clock = new FakeClock();
    const { pool, fakes } = fakePool(["https://a", "https://b"], clock);
    await assert.rejects(
      pool.run(async (p) => {
        p.calls += 1;
        throw rateLimited();
      }, { retry: false }),
      /Too Many Requests/,
    );
    assert.equal(fakes.get("https://a")?.calls, 1);
    assert.equal(fakes.get("https://b")?.calls, 0);
    assert.ok((pool.stats()[0]?.coolingUntil ?? 0) > clock.now());
  });

  it("pooledProvider sends every provider method through the pool", async () => {
    const clock = new FakeClock();
    let n = 0;
    const pool = new RpcPool<{ viewBlock(q: unknown): Promise<string> }>([ep("https://a"), ep("https://b")], clock, () => 0.5, (e) => ({
      viewBlock: async (q: unknown) => {
        n += 1;
        if (e.url === "https://a") throw rateLimited();
        return `block from ${e.url} for ${JSON.stringify(q)}`;
      },
    }));
    const provider = pooledProvider(pool);
    assert.equal(await provider.viewBlock({ finality: "final" }), 'block from https://b for {"finality":"final"}' as unknown);
    assert.equal(n, 2);
    assert.equal((provider as unknown as { then?: unknown }).then, undefined, "awaiting the provider is not an RPC call");
  });
});

// The send loop of near.ts (3.3, S-5): a lost answer re-broadcasts the same signed bytes; a
// transaction the chain knows is waited for; nothing in the loop signs.

const SIGNED = { tag: "signed bytes" } as unknown as SignedTransaction;
const OUTCOME = { status: { SuccessValue: "" }, transaction_outcome: { id: "H" }, receipts_outcome: [] } as unknown as TxOutcome;

function sendPool(
  clock: FakeClock,
  send: (signed: SignedTransaction, n: number) => Promise<TxOutcome>,
  status: (waitUntil: TxExecutionStatus, n: number) => Promise<TxOutcome>,
): { pool: RpcPool<SendProvider>; sent: SignedTransaction[]; statuses: TxExecutionStatus[] } {
  const sent: SignedTransaction[] = [];
  const statuses: TxExecutionStatus[] = [];
  const pool = new RpcPool<SendProvider>([ep("https://a"), ep("https://b")], clock, () => 0.5, () => ({
    sendTransactionUntil: async (signed) => {
      sent.push(signed);
      return send(signed, sent.length);
    },
    viewTransactionStatusWithReceipts: async ({ waitUntil }) => {
      statuses.push(waitUntil);
      return status(waitUntil, statuses.length);
    },
  }));
  return { pool, sent, statuses };
}

describe("sendSigned", () => {
  it("after a 429 with an unknown hash, broadcasts the identical bytes again", async () => {
    const clock = new FakeClock();
    const { pool, sent, statuses } = sendPool(
      clock,
      async (_s, n) => {
        if (n === 1) throw rateLimited();
        return OUTCOME;
      },
      async () => {
        throw new UnknownTransactionError("H");
      },
    );
    const out = await sendSigned(SIGNED, "H", "alice.test.near", "FINAL", { pool, clock, log: () => undefined });
    assert.equal(out, OUTCOME);
    assert.equal(sent.length, 2);
    assert.ok(sent.every((s) => s === SIGNED), "the same signed bytes both times");
    assert.deepEqual(statuses.slice(0, 1), ["NONE"]);
  });

  it("with a known hash after a timeout, waits for it and never broadcasts again", async () => {
    const clock = new FakeClock();
    const { pool, sent, statuses } = sendPool(
      clock,
      async () => {
        throw new TransactionTimeoutError();
      },
      async (waitUntil) => {
        if (waitUntil === "NONE") return { final_execution_status: "INCLUDED" } as unknown as TxOutcome;
        return OUTCOME;
      },
    );
    const out = await sendSigned(SIGNED, "H", "alice.test.near", "FINAL", { pool, clock, log: () => undefined });
    assert.equal(out, OUTCOME);
    assert.equal(sent.length, 1);
    assert.deepEqual(statuses, ["NONE", "FINAL"]);
  });

  it("gives up after 6 re-broadcasts without signing anything new", async () => {
    const clock = new FakeClock();
    const { pool, sent } = sendPool(
      clock,
      async () => {
        throw badGateway();
      },
      async () => {
        throw new UnknownTransactionError("H");
      },
    );
    await assert.rejects(sendSigned(SIGNED, "H", "alice.test.near", "FINAL", { pool, clock, log: () => undefined }), (err: unknown) => err instanceof SendUnresolved && err.hash === "H");
    assert.equal(sent.length, 7);
    assert.ok(sent.every((s) => s === SIGNED));
  });

  it("passes a contract or nonce error straight to the caller", async () => {
    const clock = new FakeClock();
    const { pool, sent } = sendPool(
      clock,
      async () => {
        throw new InvalidNonceError(9, 9, "H", "b");
      },
      async () => OUTCOME,
    );
    await assert.rejects(sendSigned(SIGNED, "H", "alice.test.near", "FINAL", { pool, clock }), (err: unknown) => err instanceof InvalidNonceError);
    assert.equal(sent.length, 1);
  });
});

describe("signAndSend", () => {
  function steps(o: { failures: unknown[]; known: boolean }) {
    const log: string[] = [];
    let signatures = 0;
    return {
      log,
      steps: {
        sign: async () => {
          signatures += 1;
          log.push(`sign ${signatures}`);
          return { signed: SIGNED, hash: `H${signatures}` };
        },
        send: async (_s: SignedTransaction, hash: string) => {
          log.push(`send ${hash}`);
          const f = o.failures.shift();
          if (f !== undefined) throw f;
          return OUTCOME;
        },
        known: async (hash: string) => {
          log.push(`known? ${hash}`);
          return o.known;
        },
        wait: async (hash: string) => {
          log.push(`wait ${hash}`);
          return OUTCOME;
        },
        dropSigner: () => log.push("drop"),
      },
    };
  }

  it("re-signs after InvalidNonce when the chain does not know the hash", async () => {
    const s = steps({ failures: [new InvalidNonceError(5, 5, "H1", "b")], known: false });
    assert.equal(await signAndSend(s.steps), OUTCOME);
    assert.deepEqual(s.log, ["sign 1", "send H1", "known? H1", "drop", "sign 2", "send H2"]);
  });

  it("does not re-sign when the chain knows the hash: a copy landed", async () => {
    const s = steps({ failures: [new TransactionExpiredError("H1", "b")], known: true });
    assert.equal(await signAndSend(s.steps), OUTCOME);
    assert.deepEqual(s.log, ["sign 1", "send H1", "known? H1", "wait H1"]);
  });

  it("never re-signs an unresolved send or after a rate limit", async () => {
    const unresolved = steps({ failures: [new SendUnresolved("H1", "no answer")], known: false });
    await assert.rejects(signAndSend(unresolved.steps), SendUnresolved);
    assert.deepEqual(unresolved.log, ["sign 1", "send H1"]);
    const limited = steps({ failures: [rateLimited()], known: false });
    await assert.rejects(signAndSend(limited.steps), /Too Many Requests/);
    assert.deepEqual(limited.log, ["sign 1", "send H1"]);
  });

  it("stops after three signatures", async () => {
    const s = steps({ failures: [1, 2, 3].map((i) => new InvalidNonceError(i, i, `H${i}`, "b")), known: false });
    await assert.rejects(signAndSend(s.steps), InvalidNonceError);
    assert.equal(s.log.filter((l) => l.startsWith("sign")).length, 3);
  });
});
