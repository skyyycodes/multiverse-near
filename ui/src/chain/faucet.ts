// The testnet faucet: the mock wNEAR and USDC contracts (contracts/mock-ft) have an open `mint(account_id, amount)`.
// It takes no deposit, mints at most `max_mint_per_call` token units per call, and registers an unregistered
// receiver only when the caller mints to itself (or the caller is the token owner). So a visitor mints to their own
// account and needs no storage_deposit on the tokens.
import type { TokenCfg } from "./domain";
import { fmt, ONE } from "./format";
import { call, GAS_LIGHT, type Tx } from "./near/tx";
import type { Asset } from "./types";
import { toInternal } from "./units";

/** Whole tokens per click: enough for a sale, a borrow and a Root LP deposit. */
export const FAUCET_DROP: Record<Asset, bigint> = { wnear: 2_000n, usdc: 5_000n };

/** What `faucet_config` returns. */
export type FaucetConfig = { owner_id: string; max_mint_per_call: string };

export type FaucetMint = {
  asset: Asset;
  tokenId: string;
  symbol: string;
  /** Token units, as the mint call takes them. */
  amount: bigint;
  /** The same amount in the 18-decimal units every screen formats. */
  internal: bigint;
};

/** Token units of `whole` tokens. */
export const wholeTokens = (whole: bigint, decimals: number): bigint => whole * 10n ** BigInt(decimals);

/**
 * The mints one click sends: one per token whose wallet balance (18-decimal) is below the drop, never above the
 * token's per-call cap (token units) when it is known. A wallet that already holds the drop of both gets nothing.
 */
export function faucetMints(
  tokens: { wnear: TokenCfg; usdc: TokenCfg },
  balances: { wnear: bigint; usdc: bigint },
  caps: Partial<Record<Asset, bigint>> = {},
): FaucetMint[] {
  const out: FaucetMint[] = [];
  for (const asset of ["wnear", "usdc"] as const) {
    const token = tokens[asset];
    const drop = wholeTokens(FAUCET_DROP[asset], token.decimals);
    if (balances[asset] >= toInternal(drop, token.decimals)) continue;
    const cap = caps[asset];
    const amount = cap !== undefined && cap > 0n && cap < drop ? cap : drop;
    out.push({ asset, tokenId: token.tokenId, symbol: token.symbol, amount, internal: toInternal(amount, token.decimals) });
  }
  return out;
}

/** The open mint, to the caller's own account so the token registers it. No deposit: it does not take one. */
export const mintTx = (tokenId: string, accountId: string, amount: bigint): Tx =>
  call(tokenId, "mint", { account_id: accountId, amount: amount.toString() }, "0", GAS_LIGHT);

/** A cap read from `faucet_config`, or undefined when the answer makes no sense. */
export function capOf(cfg: FaucetConfig | null | undefined): bigint | undefined {
  if (!cfg || !/^\d+$/.test(cfg.max_mint_per_call)) return undefined;
  return BigInt(cfg.max_mint_per_call);
}

/** "2,000 wNEAR", "5,000 USDC"; two decimals when a cap cut the amount to a fraction. */
export const mintLabel = (m: Pick<FaucetMint, "internal" | "symbol">): string => `${fmt(m.internal, m.internal % ONE === 0n ? 0 : 2)} ${m.symbol}`;

/** "2,000 wNEAR and 5,000 USDC" for the standard drop of the two tokens. */
export function dropLabel(tokens: { wnear: TokenCfg; usdc: TokenCfg }): string {
  return (["wnear", "usdc"] as const)
    .map((a) => mintLabel({ internal: toInternal(wholeTokens(FAUCET_DROP[a], tokens[a].decimals), tokens[a].decimals), symbol: tokens[a].symbol }))
    .join(" and ");
}
