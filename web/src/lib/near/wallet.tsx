"use client";

import type { NearConnector } from "@hot-labs/near-connect";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { readSource } from "../data/client";
import { ENV } from "../env";
import type { TxOutcome } from "./outcome";
import type { Tx } from "./tx";

export type WalletApi = {
  /** The signed-in NEAR account, e.g. alice.multiverse-near.testnet. */
  accountId: string | null;
  /** True once a previous session has been restored (or found absent). */
  ready: boolean;
  connecting: boolean;
  /** Design mode: transactions are simulated against the fixtures. */
  fixtures: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Signs and sends one transaction and resolves with its final outcome, receipts included. */
  send: (tx: Tx) => Promise<TxOutcome>;
  /** Fixtures only: the persona picker. */
  picker: { open: boolean; close: () => void; choose: (persona: string) => void };
};

export const WalletContext = createContext<WalletApi | null>(null);

export function useWallet(): WalletApi {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet outside WalletProvider");
  return ctx;
}

/** Wallets that answer with less than the full receipt list get their outcome read back from the chain. */
async function complete(outcome: TxOutcome, accountId: string): Promise<TxOutcome> {
  if (outcome.receipts_outcome !== undefined) return outcome;
  const hash = outcome.transaction?.hash ?? outcome.transaction_outcome?.id;
  if (!hash) return outcome;
  return (await readSource()).txStatus(hash, accountId);
}

// Design builds only: the literal test lets a real build drop the import and the fixtures with it.
const FixtureWallet = process.env.NEXT_PUBLIC_FIXTURES === "1" ? lazy(() => import("../fixtures/FixtureWallet")) : null;

export function WalletProvider({ children }: { children: ReactNode }) {
  if (FixtureWallet) {
    return (
      <Suspense fallback={null}>
        <FixtureWallet>{children}</FixtureWallet>
      </Suspense>
    );
  }
  return <NearWallet>{children}</NearWallet>;
}

/** The test-key wallet for the walkthrough recorder and the end-to-end run, in NEXT_PUBLIC_DEMO_WALLET=1 builds only. */
const loadDemoBridge = () => (process.env.NEXT_PUBLIC_DEMO_WALLET === "1" ? import("./demo-bridge") : Promise.resolve(null));

function NearWallet({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const connectorRef = useRef<NearConnector | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    let alive = true;
    const boot = async () => {
      const { NearConnector } = await import("@hot-labs/near-connect");
      const bridge = await loadDemoBridge();
      const demo = bridge?.hasDemoBridge() ? bridge : null;
      // With the demo bridge present the picker lists only the demo wallet: no remote manifest, nothing to click past.
      const connector = new NearConnector({
        network: ENV.walletNetwork,
        providers: { [ENV.walletNetwork]: ENV.rpcUrls },
        ...(demo ? { manifest: { wallets: [], version: "1.0.0" }, footerBranding: null } : {}),
      });
      if (demo && !connector.wallets.some((w) => w.manifest.id === demo.DEMO_WALLET_ID)) demo.injectDemoWallet(ENV.walletNetwork);
      connector.on("wallet:signIn", ({ accounts }) => {
        if (alive) setAccountId(accounts[0]?.accountId ?? null);
      });
      connector.on("wallet:signOut", () => {
        if (alive) setAccountId(null);
      });
      connectorRef.current = connector;
      try {
        const wallet = await connector.wallet();
        const accounts = await wallet.getAccounts();
        if (alive) setAccountId(accounts[0]?.accountId ?? null);
      } catch {
        // no previous session
      }
      if (alive) setReady(true);
      if (demo?.wantsAutoConnect()) {
        await connector.connect({ walletId: demo.DEMO_WALLET_ID }).catch(() => undefined);
      }
    };
    void boot();
    return () => {
      alive = false;
    };
  }, []);

  const connect = useCallback(async () => {
    const connector = connectorRef.current;
    if (!connector) return;
    setConnecting(true);
    try {
      await connector.connect();
    } catch {
      // closed the picker
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await connectorRef.current?.disconnect().catch(() => undefined);
    setAccountId(null);
    qc.removeQueries({ predicate: (q) => ["balances", "registration"].includes(String(q.queryKey[0])) });
  }, [qc]);

  const send = useCallback(
    async (tx: Tx): Promise<TxOutcome> => {
      const connector = connectorRef.current;
      if (!connector || !accountId) throw new Error("Connect a wallet first.");
      const wallet = await connector.wallet();
      const outcome = (await wallet.signAndSendTransaction({
        receiverId: tx.receiverId,
        actions: tx.actions,
      })) as unknown as TxOutcome;
      return complete(outcome, accountId);
    },
    [accountId],
  );

  const value = useMemo<WalletApi>(
    () => ({
      accountId,
      ready,
      connecting,
      fixtures: false,
      connect,
      disconnect,
      send,
      picker: { open: false, close: () => undefined, choose: () => undefined },
    }),
    [accountId, ready, connecting, connect, disconnect, send],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

