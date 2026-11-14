"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Screen } from "@/components/shell/Screen";
import { Segmented } from "@/components/ui/Bits";
import { AmountField } from "@/components/ui/Field";
import { ChainWait } from "@/components/ui/Notice";
import { Sheet, SheetTitle } from "@/components/ui/Surface";
import { TxButton } from "@/components/ui/TxButton";
import { CONTRACT_ID } from "@/lib/data/client";
import type { AppConfig, Scenario } from "@/lib/domain";
import { fmt, fmtNear, inputText, parseAmount } from "@/lib/format";
import { useBalances, useScenarioId, useTrade } from "@/lib/hooks/useData";
import { useSubmit } from "@/lib/hooks/useTx";
import { marketHref, resolveHref, splitHref } from "@/lib/links";
import { GAS_CALL, merge, split } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { canSplit, mergeMax, rootMask, singleWorldMasks } from "@/lib/split";
import type { Asset } from "@/lib/types";
import { toTokenCeil } from "@/lib/units";
import { ConfigGuard } from "./Guard";

type Mode = "split" | "merge";

/** `/split/?id=N&asset=&mode=` (web 6.4): split a real token into one per possible world, or merge a full set back. */
export function SplitScreen() {
  return <ConfigGuard>{(config) => <SplitPage config={config} />}</ConfigGuard>;
}

function SplitPage({ config }: { config: AppConfig }) {
  const wallet = useWallet();
  const sid = useScenarioId(config);
  const trade = useTrade(sid, wallet.accountId);
  const s = trade.data?.scenario;
  return (
    <Screen
      demo="split"
      back={sid !== undefined ? { href: marketHref(sid), label: "Market" } : undefined}
      hero={
        <div className="flex flex-col gap-3">
          <span className="label text-white/65">Market #{sid}</span>
          <h1 className="font-display text-[34px] leading-[1.05] font-medium tracking-[-0.015em]">Split and merge</h1>
          <p className="max-w-xl text-[14px] leading-relaxed text-white/75">
            1 NEAR becomes 1 NEAR in every possible world. Together the pieces are worth exactly your NEAR; merge them back any time.
          </p>
        </div>
      }
    >
      {s ? <SplitPanel config={config} s={s} /> : <ChainWait error={trade.error?.message} onRetry={() => void trade.refetch()} />}
    </Screen>
  );
}

export function SplitPanel({ config, s }: { config: AppConfig; s: Scenario }) {
  const wallet = useWallet();
  const router = useRouter();
  const params = useSearchParams();
  const submit = useSubmit();
  const balances = useBalances(wallet.accountId, config.wnear, config.usdc);
  const mode: Mode = params.get("mode") === "merge" ? "merge" : "split";
  const asset: Asset = params.get("asset") === "usdc" ? "usdc" : "wnear";
  const [text, setText] = useState("");
  const go = (o: { mode?: Mode; asset?: Asset }) => {
    setText("");
    router.replace(splitHref(s.scenarioId, { mode: o.mode ?? mode, asset: o.asset ?? asset }), { scroll: false });
  };
  const sym = asset === "wnear" ? "wNEAR" : "USDC";
  const token = asset === "wnear" ? config.wnear : config.usdc;
  const show = (x: bigint) => (asset === "wnear" ? fmtNear(x) : fmt(x));
  const amount = parseAmount(text, 18);
  const parts = singleWorldMasks(s.possible);
  const worlds = parts.map((m) => s.worlds.find((w) => w.mask === m)).filter((w) => w !== undefined);
  const max = mode === "split" ? (balances.data ? (asset === "wnear" ? balances.data.wnear : balances.data.usdc) : undefined) : mergeMax(s.worlds, s.possible, asset);

  let blocker: string | undefined;
  if (!canSplit(s.possible)) blocker = "One world is left: use Close and redeem";
  else if (!amount || amount <= 0n) blocker = "Enter an amount";
  else if (max !== undefined && amount > max) blocker = mode === "split" ? `Your wallet holds ${show(max)} ${sym}` : `You can merge at most ${show(max)} ${sym}`;

  return (
    <Sheet demo="split-panel">
      <SheetTitle>{mode === "split" ? "Split into every world" : "Merge back into real tokens"}</SheetTitle>
      <Segmented
        options={[
          { value: "split", label: "Split", demo: "split-mode-split" },
          { value: "merge", label: "Merge", demo: "split-mode-merge" },
        ]}
        value={mode}
        onChange={(m) => go({ mode: m })}
      />
      <Segmented
        size="sm"
        options={[
          { value: "wnear", label: "wNEAR", demo: "split-asset-wnear" },
          { value: "usdc", label: "USDC", demo: "split-asset-usdc" },
        ]}
        value={asset}
        onChange={(a) => go({ asset: a })}
      />
      <AmountField
        label={mode === "split" ? `${sym} to split` : `${sym} to merge`}
        value={text}
        onChange={setText}
        unit={sym}
        demo="split-amount"
        right={
          max !== undefined ? (
            <button type="button" className="num text-[12px] text-cobalt-ink hover:underline" onClick={() => setText(inputText(max, asset === "wnear" ? 4 : 6))}>
              {mode === "split" ? "wallet" : "max"}: {show(max)} {sym}
            </button>
          ) : undefined
        }
      />
      {!canSplit(s.possible) ? (
        <p className="text-[13px] text-mute">
          Only one world is still possible.{" "}
          <Link className="text-cobalt-ink underline-offset-2 hover:underline" href={resolveHref(s.scenarioId)}>
            Close and redeem
          </Link>{" "}
          pays it out.
        </p>
      ) : (
        <ul className="num flex flex-col gap-1 text-[13px] text-ink" data-demo="split-preview">
          {mode === "split" ? (
            worlds.map((w) => (
              <li key={w.mask}>
                You get {amount ? show(amount) : "0"} {sym}-if-{w.label}
              </li>
            ))
          ) : (
            <li>
              You get {amount ? show(amount) : "0"} real {sym} back, for {amount ? show(amount) : "0"} of each: {worlds.map((w) => `${sym}-if-${w.label}`).join(", ")}
            </li>
          )}
        </ul>
      )}
      {mode === "split" ? (
        <TxButton
          demo="split-confirm"
          action="split"
          label={`Split ${text || "0"} ${sym}`}
          busyLabel="Splitting…"
          blocker={blocker}
          needs={{ contract: true }}
          run={() => submit(split(token.tokenId, CONTRACT_ID, toTokenCeil(amount!, token.decimals), { scenarioId: s.scenarioId, toMasks: parts }))}
        />
      ) : (
        <TxButton
          demo="merge-confirm"
          action="merge"
          label={`Merge ${text || "0"} ${sym}`}
          busyLabel="Merging…"
          blocker={blocker}
          needs={{ tokens: [asset] }}
          gas={GAS_CALL}
          run={() => submit(merge(CONTRACT_ID, { scenarioId: s.scenarioId, asset, fromMasks: parts, toMask: rootMask(s.worldCount), amount: amount! }))}
        />
      )}
    </Sheet>
  );
}
