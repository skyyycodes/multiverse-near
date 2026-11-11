import { describe, expect, it } from "vitest";
import type { TokenCfg } from "./domain";
import { capOf, dropLabel, faucetMints, mintLabel, mintTx, wholeTokens } from "./faucet";
import { GAS_LIGHT } from "./near/tx";

const E18 = 10n ** 18n;
const tokens: { weth: TokenCfg; usdc: TokenCfg } = {
  weth: { tokenId: "weth.multiverse-lending.testnet", decimals: 18, symbol: "WETH" },
  usdc: { tokenId: "usdc.multiverse-lending.testnet", decimals: 6, symbol: "USDC" },
};

describe("the testnet faucet", () => {
  it("mints 2 WETH and 5,000 USDC in token units to an empty wallet", () => {
    const mints = faucetMints(tokens, { weth: 0n, usdc: 0n });
    expect(mints.map((m) => [m.asset, m.tokenId, m.amount])).toEqual([
      ["weth", "weth.multiverse-lending.testnet", 2n * E18],
      ["usdc", "usdc.multiverse-lending.testnet", 5_000_000_000n],
    ]);
    expect(mints.map((m) => m.internal)).toEqual([2n * E18, 5_000n * E18]);
    expect(mints.map(mintLabel)).toEqual(["2 WETH", "5,000 USDC"]);
  });

  it("skips a token the wallet already holds the drop of, and both once it holds both", () => {
    expect(faucetMints(tokens, { weth: 2n * E18, usdc: 4_999n * E18 }).map((m) => m.asset)).toEqual(["usdc"]);
    expect(faucetMints(tokens, { weth: 2n * E18 - 1n, usdc: 5_000n * E18 }).map((m) => m.asset)).toEqual(["weth"]);
    expect(faucetMints(tokens, { weth: 3n * E18, usdc: 9_000n * E18 })).toEqual([]);
  });

  it("never asks for more than the per-call cap", () => {
    const mints = faucetMints(tokens, { weth: 0n, usdc: 0n }, { weth: E18 / 2n, usdc: 10_000_000_000_000n });
    expect(mints.map((m) => m.amount)).toEqual([E18 / 2n, 5_000_000_000n]);
    expect(mintLabel(mints[0])).toBe("0.5000 WETH");
    // A zero or missing cap leaves the drop alone: the contract has the last word.
    expect(faucetMints(tokens, { weth: 0n, usdc: 0n }, { weth: 0n }).map((m) => m.amount)[0]).toBe(2n * E18);
  });

  it("calls mint on the token for the caller itself, with no deposit", () => {
    const tx = mintTx("usdc.multiverse-lending.testnet", "visitor.testnet", 5_000_000_000n);
    expect(tx).toEqual({
      receiverId: "usdc.multiverse-lending.testnet",
      actions: [
        {
          type: "FunctionCall",
          params: { methodName: "mint", args: { account_id: "visitor.testnet", amount: "5000000000" }, gas: GAS_LIGHT, deposit: "0" },
        },
      ],
    });
  });

  it("reads the cap from faucet_config and rejects nonsense", () => {
    expect(capOf({ owner_id: "multiverse-lending.testnet", max_mint_per_call: "10000000000000" })).toBe(10_000_000_000_000n);
    expect(capOf({ owner_id: "x", max_mint_per_call: "-1" })).toBeUndefined();
    expect(capOf({ owner_id: "x", max_mint_per_call: "1e9" })).toBeUndefined();
    expect(capOf(undefined)).toBeUndefined();
    expect(capOf(null)).toBeUndefined();
  });

  it("names the drop", () => {
    expect(dropLabel(tokens)).toBe("2 WETH and 5,000 USDC");
    expect(wholeTokens(5_000n, 6)).toBe(5_000_000_000n);
  });
});
