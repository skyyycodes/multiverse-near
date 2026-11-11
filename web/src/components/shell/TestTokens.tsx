"use client";

import { useState } from "react";
import { TxButton } from "@/components/ui/TxButton";
import type { Tone } from "@/components/ui/Button";
import { CONTRACT_ID, readSource } from "@/lib/data/client";
import type { AppConfig } from "@/lib/domain";
import { ENV } from "@/lib/env";
import { capOf, dropLabel, faucetMints, mintLabel, mintTx, type FaucetConfig } from "@/lib/faucet";
import { useAppConfig, useBalances, useRegistration, type Balances } from "@/lib/hooks/useData";
import { registerTx, useSubmit } from "@/lib/hooks/useTx";
import { useWallet } from "@/lib/near/wallet";
import type { Asset, StorageBalance, StorageBounds } from "@/lib/types";
import { toInternal } from "@/lib/units";

/** The open mint exists on the testnet mock tokens only; design data signs nothing. */
export const FAUCET_ON = ENV.network === "testnet" && process.env.NEXT_PUBLIC_FIXTURES !== "1";

/** True for a connected wallet that holds no WETH and no USDC at all. */
export const walletEmpty = (b: Balances | undefined): boolean => Boolean(b && b.weth === 0n && b.usdc === 0n);

/** What the faucet did so far, one line per finished transaction. */
export function FaucetProgress({ done, dark }: { done: readonly string[]; dark?: boolean }) {
  if (done.length === 0) return null;
  return (
    <ul className={`flex flex-col gap-1 text-[12px] ${dark ? "text-white/80" : "text-ink"}`} data-demo="faucet-progress">
      {done.map((line) => (
        <li key={line} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={dark ? "text-pos-dark" : "text-pos"}>
            ✓
          </span>
          {line}
        </li>
      ))}
    </ul>
  );
}

/**
 * "Get test tokens": mints the drop of each mock token the wallet holds less than, to the connected account itself
 * (so the token registers it), then registers the account with Multiverse if it is not yet. Each is one transaction
 * the wallet asks to approve; a retry after a failure skips what already landed.
 */
export function GetTestTokens({ tone = "secondary", size = "md", dark, demo = "get-test-tokens" }: { tone?: Tone; size?: "lg" | "md" | "sm"; dark?: boolean; demo?: string }) {
  const wallet = useWallet();
  const config = useAppConfig();
  const cfg = config.data;
  const balances = useBalances(wallet.accountId, cfg?.weth, cfg?.usdc);
  const reg = useRegistration(wallet.accountId, cfg?.weth, cfg?.usdc);
  const submit = useSubmit();
  const [done, setDone] = useState<string[]>([]);

  if (!FAUCET_ON || wallet.fixtures) return null;

  const pending = cfg && balances.data ? faucetMints(cfg, balances.data) : undefined;
  const registered = reg.data ? reg.data.contract !== null : undefined;
  let blocker: string | undefined;
  if (!cfg || !pending || registered === undefined) blocker = "Reading your wallet…";
  else if (pending.length === 0 && registered) blocker = "Your wallet holds test tokens";

  return (
    <div className="flex flex-col gap-2">
      <TxButton
        demo={demo}
        tone={tone}
        size={size}
        label="Get test tokens"
        busyLabel="Getting test tokens…"
        blocker={blocker}
        run={async (step) => {
          setDone([]);
          return getTestTokens(cfg!, wallet.accountId!, step, submit, (line) => setDone((d) => [...d, line]));
        }}
      />
      <FaucetProgress done={done} dark={dark} />
      {cfg && (
        <p className={`text-[12px] leading-relaxed ${dark ? "text-white/60" : "text-mute"}`}>
          {dropLabel(cfg)} from the mock tokens&apos; open mint, plus Multiverse&apos;s 0.1 NEAR storage deposit if you have none. Testnet
          only; they have no value.
        </p>
      )}
    </div>
  );
}

async function getTestTokens(
  cfg: AppConfig,
  account: string,
  step: (label: string) => void,
  submit: ReturnType<typeof useSubmit>,
  finished: (line: string) => void,
): Promise<string> {
  const src = await readSource();
  // Fresh reads: the balances on screen may be a poll behind a mint that just landed.
  const [w, u, cw, cu, registered] = await Promise.all([
    src.view<string>(cfg.weth.tokenId, "ft_balance_of", { account_id: account }),
    src.view<string>(cfg.usdc.tokenId, "ft_balance_of", { account_id: account }),
    src.view<FaucetConfig>(cfg.weth.tokenId, "faucet_config").catch(() => undefined),
    src.view<FaucetConfig>(cfg.usdc.tokenId, "faucet_config").catch(() => undefined),
    src.view<StorageBalance | null>(CONTRACT_ID, "storage_balance_of", { account_id: account }),
  ]);
  const caps: Partial<Record<Asset, bigint>> = { weth: capOf(cw), usdc: capOf(cu) };
  const mints = faucetMints(cfg, { weth: toInternal(BigInt(w), cfg.weth.decimals), usdc: toInternal(BigInt(u), cfg.usdc.decimals) }, caps);
  let hash: string | undefined;
  for (const m of mints) {
    step(`Minting ${mintLabel(m)}…`);
    hash = await submit(mintTx(m.tokenId, account, m.amount));
    finished(`${mintLabel(m)} minted to your wallet`);
  }
  if (!registered) {
    const bounds = await src.view<StorageBounds>(CONTRACT_ID, "storage_balance_bounds");
    step("Registering with Multiverse…");
    hash = await submit(registerTx(bounds));
    finished("Registered with Multiverse");
  }
  if (!hash) throw new Error("Nothing to do: your wallet already holds test tokens and is registered.");
  return hash;
}

/** Home: a connected wallet with no WETH and no USDC is offered the faucet right under its balances. */
export function EmptyWalletHint({ balances }: { balances: Balances | undefined }) {
  const wallet = useWallet();
  if (!FAUCET_ON || wallet.fixtures || !wallet.accountId || !walletEmpty(balances)) return null;
  return (
    <div className="flex flex-col gap-3 rounded-[20px] border border-white/10 bg-white/8 p-4" data-demo="empty-wallet-hint">
      <p className="text-[13px] leading-relaxed text-white/85">
        Your wallet has no WETH or USDC yet. On testnet you can mint the demo tokens yourself.
      </p>
      <GetTestTokens tone="light" size="md" dark demo="hint-test-tokens" />
    </div>
  );
}
