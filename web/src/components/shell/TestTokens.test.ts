import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Balances } from "@/lib/hooks/useData";
import { WalletContext, type WalletApi } from "@/lib/near/wallet";
import { EmptyWalletHint, FAUCET_ON, FaucetProgress, hintShown, walletEmpty } from "./TestTokens";

const E18 = 10n ** 18n;
const empty: Balances = { weth: 0n, usdc: 0n, innerWeth: 0n, innerUsdc: 0n };

function wallet(accountId: string | null, fixtures = false): WalletApi {
  return {
    accountId,
    ready: true,
    connecting: false,
    fixtures,
    connect: async () => undefined,
    disconnect: async () => undefined,
    send: async () => {
      throw new Error("not in this test");
    },
    picker: { open: false, close: () => undefined, choose: () => undefined },
  };
}

/** Server-renders `el` inside a wallet and a query client that never fetches. */
function render(el: ReactElement, w: WalletApi): string {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(WalletContext.Provider, { value: w }, el)));
}

describe("get test tokens", () => {
  it("is on for the testnet build", () => {
    expect(FAUCET_ON).toBe(true);
  });

  it("counts a wallet as empty only when it holds no WETH and no USDC", () => {
    expect(walletEmpty(undefined)).toBe(false);
    expect(walletEmpty(empty)).toBe(true);
    expect(walletEmpty({ ...empty, innerUsdc: E18 })).toBe(true);
    expect(walletEmpty({ ...empty, weth: 1n })).toBe(false);
    expect(walletEmpty({ ...empty, usdc: 1n })).toBe(false);
  });

  it("keeps the home hint once pressed, though the first mint already filled the wallet", () => {
    expect(hintShown(empty, false)).toBe(true);
    expect(hintShown({ ...empty, weth: 2n * E18 }, false)).toBe(false);
    expect(hintShown({ ...empty, weth: 2n * E18 }, true)).toBe(true);
    expect(hintShown(undefined, true)).toBe(true);
  });

  it("offers the faucet on the home screen to a connected, empty wallet", () => {
    const html = render(createElement(EmptyWalletHint, { balances: empty }), wallet("visitor.testnet"));
    expect(html).toContain('data-demo="empty-wallet-hint"');
    expect(html).toContain('data-demo="hint-test-tokens"');
    // Until the config and balances are read, the button waits instead of minting blind.
    expect(html).toContain("Reading your wallet…");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-demo="hint-test-tokens"|<button[^>]*data-demo="hint-test-tokens"[^>]*disabled=""/);
  });

  it("stays out of the way for a wallet with tokens, a signed-out visitor and design data", () => {
    expect(render(createElement(EmptyWalletHint, { balances: { ...empty, usdc: 5n } }), wallet("visitor.testnet"))).toBe("");
    expect(render(createElement(EmptyWalletHint, { balances: undefined }), wallet("visitor.testnet"))).toBe("");
    expect(render(createElement(EmptyWalletHint, { balances: empty }), wallet(null))).toBe("");
    expect(render(createElement(EmptyWalletHint, { balances: empty }), wallet("alice.multiverse-lending.testnet", true))).toBe("");
  });

  it("lists each finished step, and nothing before the first", () => {
    expect(render(createElement(FaucetProgress, { done: [] }), wallet(null))).toBe("");
    const html = render(createElement(FaucetProgress, { done: ["2 WETH minted to your wallet", "Registered with Multiverse"] }), wallet(null));
    expect(html).toContain('data-demo="faucet-progress"');
    expect(html).toContain("2 WETH minted to your wallet");
    expect(html).toContain("Registered with Multiverse");
    expect(html.match(/<li/g)).toHaveLength(2);
  });
});
