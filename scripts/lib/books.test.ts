import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { booksCheck, booksPagesAt, judgeSurplus, sumBooks, surplus, surplusAt, totalMismatch } from "./books.ts";
import type { AssetName, ChainReader } from "./protocol.ts";
import type { BooksView } from "./views.ts";

const BOOKS = JSON.parse(readFileSync(new URL("./fixtures/v2/books.json", import.meta.url), "utf8")) as BooksView;

// Production, block 277535363 (ops 3.7): the token balances equal the books exactly.
const PROD_WNEAR_RAW = 706_000_000_000_000_000_000_649_000_000n; // 24 decimals
const PROD_WNEAR_TOTAL = 706_000_000_000_000_000_000_649n; // internal, 18 decimals
const PROD_USDC_RAW = 12_846_845_361_198n; // 6 decimals
const PROD_USDC_TOTAL = 12_846_845_361_198_000_000_000_000n;

/** A reader over fixed pages and balances, recording the blocks it was asked for. */
function reader(pages: BooksView[], raw: { wnear: bigint; usdc: bigint }): ChainReader & { blocks: number[] } {
  const blocks: number[] = [];
  return {
    contract: "app.test.near",
    blocks,
    async viewAt<T>(method: string, args: Record<string, unknown>, block: number | "final"): Promise<T> {
      if (method !== "books") throw new Error(`unexpected view ${method}`);
      blocks.push(block as number);
      const from = (args.from_scenario as number | null) ?? 1;
      const page = pages.find((p) => p.from_scenario === from);
      if (!page) throw new Error(`no page from ${from}`);
      return page as T;
    },
    async tokenViewAt<T>(asset: AssetName, method: string, args: Record<string, unknown>, block: number | "final"): Promise<T> {
      assert.equal(method, "ft_balance_of");
      assert.equal(args.account_id, "app.test.near");
      blocks.push(block as number);
      return raw[asset].toString() as T;
    },
    accountAt: async () => ({ amount: 0n, storageUsage: 0, codeHash: "" }),
    blockTimeSec: async () => 0,
    decimals: (asset) => (asset === "wnear" ? 24 : 6),
  };
}

describe("surplus", () => {
  it("scales the raw balance up below 18 decimals", () => {
    assert.equal(surplus(1_000_000n, 1_000_000_000_000_000_000n, 6), 0n);
    assert.equal(surplus(1_000_001n, 1_000_000_000_000_000_000n, 6), 1_000_000_000_000n);
  });

  it("scales the books total up above 18 decimals (wNEAR has 24)", () => {
    assert.equal(surplus(1_000_000_000_000_000_000_000_000n, 1_000_000_000_000_000_000n, 24), 0n);
    assert.equal(surplus(1_000_000_000_000_000_000_000_007n, 1_000_000_000_000_000_000n, 24), 7n);
  });

  it("gives 0 and 0 on the production snapshot", () => {
    assert.equal(surplus(PROD_WNEAR_RAW, PROD_WNEAR_TOTAL, 24), 0n);
    assert.equal(surplus(PROD_USDC_RAW, PROD_USDC_TOTAL, 6), 0n);
  });

  it("goes negative on a deficit", () => {
    assert.equal(surplus(PROD_USDC_RAW - 1n, PROD_USDC_TOTAL, 6), -1_000_000_000_000n);
  });
});

describe("judgeSurplus", () => {
  it("at_least accepts a transient surplus and flags a deficit", () => {
    assert.equal(judgeSurplus("usdc", 5n, 0n, "at_least", 9).ok, true);
    const deficit = judgeSurplus("usdc", -3n, 0n, "at_least", 9);
    assert.equal(deficit.ok, false);
    assert.match(deficit.detail, /deficit: the contract holds 3 units less usdc than its books/);
    assert.equal(judgeSurplus("wnear", 4n, 5n, "at_least", 9).ok, false, "below the baseline is a violation");
  });

  it("exact refuses any change from the baseline", () => {
    assert.equal(judgeSurplus("wnear", 0n, 0n, "exact", 9).ok, true);
    assert.equal(judgeSurplus("wnear", 1n, 0n, "exact", 9).ok, false);
  });
});

describe("books pages", () => {
  const page1: BooksView = { ...BOOKS, from_scenario: 1, next_scenario: 101 };
  const page2: BooksView = {
    from_scenario: 101,
    next_scenario: null,
    wnear: { reserves: "100", lending_cash: "0", insurance: "0", internal: "0", collateral: "0", spot_pool: "0", pledges: "0", total: "100" },
    usdc: { reserves: "50", lending_cash: "25", insurance: "5", internal: "0", collateral: "0", spot_pool: "0", pledges: "0", total: "75" },
  };

  it("sums every page per token", () => {
    const s = sumBooks([page1, page2]);
    assert.equal(s.wnear.total, PROD_WNEAR_TOTAL + 100n);
    assert.equal(s.usdc.total, PROD_USDC_TOTAL + 75n);
    assert.equal(s.usdc.insurance, 640_000_000_000_000_000_000n + 5n);
    assert.equal(totalMismatch(s.wnear), 0n);
    assert.equal(totalMismatch(s.usdc), 0n);
  });

  it("finds a page whose buckets do not add up", () => {
    const s = sumBooks([{ ...page2, usdc: { ...page2.usdc, total: "70" } }]);
    assert.equal(totalMismatch(s.usdc), 5n);
  });

  it("reads all pages and the balances at one pinned block", async () => {
    const r = reader([page1, page2], { wnear: PROD_WNEAR_RAW + 100_000_000n, usdc: PROD_USDC_RAW });
    assert.equal((await booksPagesAt(r, 277_535_363)).length, 2);
    const s = await surplusAt(r, 277_535_363);
    assert.equal(s.wnear, 0n);
    assert.equal(s.usdc, -75n, "page 2's 75 units are not covered");
    assert.ok(r.blocks.every((b) => b === 277_535_363));
  });

  it("booksCheck reports both tokens and the bucket sums", async () => {
    const r = reader([{ ...BOOKS, next_scenario: null }], { wnear: PROD_WNEAR_RAW, usdc: PROD_USDC_RAW + 1n });
    const results = await booksCheck(r, 42, { wnear: 0n, usdc: 0n }, "at_least");
    assert.deepEqual(results.map((c) => [c.name, c.ok, c.block]), [
      ["books.wnear (at_least)", true, 42],
      ["books.usdc (at_least)", true, 42],
      ["books.wnear.total", true, 42],
      ["books.usdc.total", true, 42],
    ]);
    const exact = await booksCheck(r, 42, { wnear: 0n, usdc: 0n }, "exact");
    assert.equal(exact[1]?.ok, false, "a surplus that grew fails the exact check");
  });
});
