// The contract's books against the tokens it actually holds (OPS-1): per token, the raw balance
// scaled to internal units must cover the sum of every books bucket. All pages are read at one
// pinned block (S-4).
//
// Transient states only ever make the surplus larger: an ft_transfer_call in flight (tokens
// arrived, ft_on_transfer not yet run), a payout in flight (internal debited, transfer pending) or
// a refund in flight. So after a transaction the check is `at_least` (surplus ≥ baseline, a deficit
// is a violation) and `exact` only at a quiescent block.

import type { AssetName, ChainReader } from "./protocol.ts";
import { u128 } from "./units.ts";
import type { BooksSideView, BooksView } from "./views.ts";
import { decodeBooksView } from "./views.ts";

export interface BooksSide {
  reserves: bigint;
  lending_cash: bigint;
  insurance: bigint;
  internal: bigint;
  collateral: bigint;
  spot_pool: bigint;
  pledges: bigint;
  total: bigint;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  block: number;
}

const BUCKETS = ["reserves", "lending_cash", "insurance", "internal", "collateral", "spot_pool", "pledges", "total"] as const;

const zeroSide = (): BooksSide => ({ reserves: 0n, lending_cash: 0n, insurance: 0n, internal: 0n, collateral: 0n, spot_pool: 0n, pledges: 0n, total: 0n });

/** Sums the pages of `books` per token (global buckets come only on the first page, so a plain sum is right). */
export function sumBooks(pages: readonly BooksView[]): { wnear: BooksSide; usdc: BooksSide } {
  const out = { wnear: zeroSide(), usdc: zeroSide() };
  for (const [i, page] of pages.entries()) {
    for (const asset of ["wnear", "usdc"] as const) {
      const side: BooksSideView = page[asset];
      for (const b of BUCKETS) out[asset][b] += u128(side[b], `books[${i}].${asset}.${b}`);
    }
  }
  return out;
}

/**
 * Every bucket but `total` and `insurance` adds up to `total` (insurance is inside lending_cash and
 * shown for information, SPEC-C 3.9). A page that breaks this is a contract bug, not a balance one.
 */
export function totalMismatch(side: BooksSide): bigint {
  return side.reserves + side.lending_cash + side.internal + side.collateral + side.spot_pool + side.pledges - side.total;
}

/** Reads every page of `books` at `block`. */
export async function booksPagesAt(p: ChainReader, block: number): Promise<BooksView[]> {
  const pages: BooksView[] = [];
  let from: number | null = null;
  for (;;) {
    const page = decodeBooksView(await p.viewAt<unknown>("books", { from_scenario: from, limit: 100 }, block));
    pages.push(page);
    if (page.next_scenario === null) return pages;
    if (from !== null && page.next_scenario <= from) throw new Error(`books: next_scenario ${page.next_scenario} does not advance past ${from}`);
    from = page.next_scenario;
  }
}

export async function booksAt(p: ChainReader, block: number): Promise<{ wnear: BooksSide; usdc: BooksSide; pages: number }> {
  const pages = await booksPagesAt(p, block);
  return { ...sumBooks(pages), pages: pages.length };
}

/**
 * The token's raw balance against the books total, in the finer of the two units; ≥ 0 when sound.
 * Up to 18 decimals the raw balance is scaled up; above (wNEAR has 24) the total is.
 */
export function surplus(raw: bigint, total: bigint, decimals: number): bigint {
  return decimals <= 18 ? raw * 10n ** BigInt(18 - decimals) - total : raw - total * 10n ** BigInt(decimals - 18);
}

/** The surplus of both tokens at `block`. */
export async function surplusAt(p: ChainReader, block: number): Promise<{ wnear: bigint; usdc: bigint; books: { wnear: BooksSide; usdc: BooksSide } }> {
  const books = await booksAt(p, block);
  const raw = async (asset: AssetName): Promise<bigint> =>
    u128(await p.tokenViewAt<string>(asset, "ft_balance_of", { account_id: p.contract }, block), `${asset}.ft_balance_of`);
  const [w, u] = await Promise.all([raw("wnear"), raw("usdc")]);
  return {
    wnear: surplus(w, books.wnear.total, p.decimals("wnear")),
    usdc: surplus(u, books.usdc.total, p.decimals("usdc")),
    books: { wnear: books.wnear, usdc: books.usdc },
  };
}

/** One token's verdict: `at_least` after a transaction, `exact` at a quiescent block. */
export function judgeSurplus(asset: AssetName, value: bigint, baseline: bigint, mode: "exact" | "at_least", block: number): CheckResult {
  const ok = mode === "exact" ? value === baseline : value >= baseline;
  const delta = value - baseline;
  const detail =
    value < 0n
      ? `deficit: the contract holds ${-value} units less ${asset} than its books (baseline ${baseline})`
      : `surplus ${value} (baseline ${baseline}, ${delta >= 0n ? "+" : ""}${delta})`;
  return { name: `books.${asset} (${mode})`, ok, detail, block };
}

export async function booksCheck(
  p: ChainReader,
  block: number,
  baseline: { wnear: bigint; usdc: bigint },
  mode: "exact" | "at_least",
): Promise<CheckResult[]> {
  const s = await surplusAt(p, block);
  const out = [judgeSurplus("wnear", s.wnear, baseline.wnear, mode, block), judgeSurplus("usdc", s.usdc, baseline.usdc, mode, block)];
  for (const asset of ["wnear", "usdc"] as const) {
    const off = totalMismatch(s.books[asset]);
    out.push({ name: `books.${asset}.total`, ok: off === 0n, detail: off === 0n ? "buckets add up to total" : `buckets differ from total by ${off}`, block });
  }
  return out;
}
