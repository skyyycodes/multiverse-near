import { describe, expect, it } from "vitest";
import type { Account, LendingTier, Tier } from "./domain";
import { defaultTier, parseTier, positionTier, resolveTier, sellTier, TIERS } from "./tiers";

const acct = (p: Partial<Account>) => ({ debt: 0n, collateral: [], supplied: 0n, ...p }) as unknown as Account;
const tiers = (accounts: Partial<Record<Tier, Partial<Account> | null>>): LendingTier[] =>
  TIERS.map((tier) => ({ tier, market: {} as LendingTier["market"], account: accounts[tier] ? acct(accounts[tier]!) : null }));
const piece = [{ tokenId: "usdc", label: "USDC", asset: "usdc" as const, mask: 3, isReal: true, amount: 1n }];

describe("tiers", () => {
  it("reads only the three tier names from a URL", () => {
    expect(parseTier("safe")).toBe("safe");
    expect(parseTier("bold")).toBe("bold");
    expect(parseTier("Bold")).toBeUndefined();
    expect(parseTier(null)).toBeUndefined();
  });

  it("opens Borrow on the first tier with debt, else with collateral, else Normal", () => {
    expect(defaultTier(tiers({ safe: { collateral: piece }, bold: { debt: 5n } }), "borrow")).toBe("bold");
    expect(defaultTier(tiers({ bold: { collateral: piece } }), "borrow")).toBe("bold");
    expect(defaultTier(tiers({}), "borrow")).toBe("normal");
    expect(defaultTier(undefined, "borrow")).toBe("normal");
  });

  it("opens Lend on the first tier with supply", () => {
    expect(positionTier(tiers({ normal: { debt: 1n }, bold: { supplied: 9n } }), "lend")).toBe("bold");
    expect(defaultTier(tiers({ safe: { debt: 1n } }), "lend")).toBe("normal");
  });

  it("prefers the URL, then the remembered tier, then the position", () => {
    const t = tiers({ bold: { debt: 1n } });
    expect(resolveTier("safe", "normal", t, "borrow")).toBe("safe");
    expect(resolveTier(null, "normal", t, "borrow")).toBe("normal");
    expect(resolveTier("junk", undefined, t, "borrow")).toBe("bold");
  });

  it("keeps a sale's collateral in the remembered tier, else where the debt is, else Normal", () => {
    expect(sellTier("safe", tiers({ bold: { debt: 1n } }))).toBe("safe");
    expect(sellTier(undefined, tiers({ bold: { debt: 1n } }))).toBe("bold");
    expect(sellTier(undefined, undefined)).toBe("normal");
  });
});
