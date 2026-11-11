"use client";

import { useState } from "react";
import { Screen } from "@/components/shell/Screen";
import { EventCard } from "@/components/resolve/EventCard";
import { ConfigGuard } from "@/components/trade/Guard";
import { InfoRows } from "@/components/ui/Bits";
import { pillClass } from "@/components/ui/Button";
import { AmountField } from "@/components/ui/Field";
import { ChainWait } from "@/components/ui/Notice";
import { Block, Sheet, SheetTitle } from "@/components/ui/Surface";
import { TxButton } from "@/components/ui/TxButton";
import { WorldGrid, WorldPicker } from "@/components/world/WorldGrid";
import { CONTRACT_ID } from "@/lib/data/client";
import type { AppConfig, EventState, Scenario } from "@/lib/domain";
import { ENV } from "@/lib/env";
import { fmt, fmtUsd, fmtWeth, parseAmount, shortAccount } from "@/lib/format";
import { useChainClock } from "@/lib/hooks/useClock";
import { useAdmin, useBalances, useQuoteSell, useScenarioId } from "@/lib/hooks/useData";
import { useIsDesktop } from "@/lib/hooks/useMedia";
import { useSubmit } from "@/lib/hooks/useTx";
import { call, ftTransferCall } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { scaleOf } from "@/lib/units";

const ONE = 10n ** 18n;
const SLIPPAGE_BPS = 50n; // the push must return at least 0.5% under its quote

/** Admin: resolve override and dispute per event, a price push by a real swap, and the demo reset command. */
export function AdminScreen() {
  return <ConfigGuard>{(config) => <Admin config={config} />}</ConfigGuard>;
}

function Admin({ config }: { config: AppConfig }) {
  const wallet = useWallet();
  const desktop = useIsDesktop();
  const sid = useScenarioId(config);
  const view = useAdmin(sid, wallet.accountId);
  const clock = useChainClock(view.data?.nowSec, view.dataUpdatedAt);
  const d = view.data;
  const s = d?.scenario;
  const owner = d?.ownerId ?? config.ownerId;
  const isOwner = Boolean(wallet.accountId && owner && wallet.accountId.toLowerCase() === owner.toLowerCase());
  // The world picked for a price push belongs to one scenario.
  const pickKey = `${CONTRACT_ID}:${sid}`;
  const [pick, setPick] = useState({ key: pickKey, mask: 0 });
  const picked = (pick.key === pickKey ? pick.mask : 0) & (s?.possible ?? 0);
  const toggle = (m: number) => setPick({ key: pickKey, mask: picked === m ? 0 : m });

  const card = (e: EventState, kicker: string) => (
    <EventCard key={e.id} event={e} kicker={kicker} now={clock.now} windowSec={config.disputeWindowSec}>
      <ResolveControls event={e} now={clock.now} isOwner={isOwner} />
    </EventCard>
  );

  return (
    <Screen
      demo="admin"
      hero={
        <div className="flex flex-col gap-3">
          <span className="label text-white/65">Oracle and demo controls</span>
          <h1 className="font-display text-[34px] leading-none font-medium tracking-[-0.015em]">Admin</h1>
          <OwnerStatus owner={owner} isOwner={isOwner} connected={Boolean(wallet.accountId)} />
        </div>
      }
      aside={
        <>
          {s && <PricePush key={pickKey} config={config} s={s} mask={picked} isOwner={isOwner} onPick={toggle} picker={!desktop} events={d.events} />}
          <ResetCommand />
        </>
      }
    >
      {s && d ? (
        <>
          {desktop && <WorldGrid scenario={s} events={d.events} selected={picked} onToggle={toggle} details={false} />}
          <Block demo="admin-events">
            <p className="text-[13px] leading-relaxed text-mute">
              Tap one world to push its price down with a real swap ({desktop ? "right" : "below"}).
            </p>
            <p className="text-[13px] leading-relaxed text-mute">
              Resolve now proposes and finalizes in one transaction through the same functions as the resolver&apos;s path,
              replacing any open proposal: the override for when the resolver cannot run. Dispute cancels an open proposal
              inside its window.
            </p>
            {d.events.map((e, i) => card(e, `Event ${String.fromCharCode(65 + i)}`))}
            {d.pastFedEvent && card(d.pastFedEvent, "Past Fed decision · resolver reads FRED")}
          </Block>
        </>
      ) : (
        <Block>
          <ChainWait error={view.error?.message} onRetry={() => void view.refetch()} />
        </Block>
      )}
    </Screen>
  );
}

function OwnerStatus({ owner, isOwner, connected }: { owner?: string; isOwner: boolean; connected: boolean }) {
  if (!owner) return null;
  if (isOwner)
    return (
      <span className="text-[14px] text-pos-dark" data-demo="owner-status">
        ✓ Connected as the oracle owner
      </span>
    );
  return (
    <span className="text-[14px] text-white/75" data-demo="owner-status">
      {connected ? "Read-only: actions need" : "Connect"} the oracle owner&apos;s wallet <span className="font-mono text-white">{shortAccount(owner)}</span>
    </span>
  );
}

/** admin_resolve (propose and finalize at once) with an outcome picker, and dispute for a proposal inside its window. */
function ResolveControls({ event: e, now, isOwner }: { event: EventState; now?: bigint; isOwner: boolean }) {
  const submit = useSubmit();
  const [outcome, setOutcome] = useState<number>();
  const owner = isOwner ? undefined : "Oracle owner only";
  const inWindow = e.proposalOpen && now !== undefined && now < e.finalizableAt;
  if (e.finalized) return null;
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3.5" data-demo="resolve-controls">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-mute">Resolve as</span>
        {e.outcomeNames.map((name, i) => (
          <button
            key={name}
            type="button"
            aria-pressed={outcome === i}
            onClick={() => setOutcome(i)}
            data-demo="resolve-outcome"
            className={`focus-ring num min-h-9 rounded-full border px-3.5 text-[12px] font-medium tracking-[0.06em] ${
              outcome === i ? "border-ink bg-ink text-white" : "border-line-strong text-ink hover:border-ink"
            }`}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <TxButton
          demo="resolve-now"
          needs={{ contract: true }}
          size="md"
          label={outcome === undefined ? "Resolve now" : `Resolve now: ${e.outcomeNames[outcome]}`}
          busyLabel="Resolving…"
          blocker={owner ?? (outcome === undefined ? "Pick an outcome" : undefined)}
          run={() => submit(call(CONTRACT_ID, "admin_resolve", { event_id: e.id, outcome: outcome! }))}
        />
        <TxButton
          demo="dispute"
          needs={{ contract: true }}
          size="md"
          tone="secondary"
          label="Dispute the proposal"
          busyLabel="Disputing…"
          blocker={owner ?? (!e.proposalOpen ? "No proposal to dispute" : !inWindow ? "Dispute window over" : undefined)}
          run={() => submit(call(CONTRACT_ID, "dispute", { event_id: e.id }))}
        />
      </div>
    </div>
  );
}

/** A real swap by the owner's wallet in one world's pool: a conditional sale in that world only, nothing into lending. */
function PricePush({
  config,
  s,
  mask,
  isOwner,
  onPick,
  picker,
  events,
}: {
  config: AppConfig;
  s: Scenario;
  mask: number;
  isOwner: boolean;
  onPick: (m: number) => void;
  picker: boolean;
  events: readonly EventState[];
}) {
  const wallet = useWallet();
  const submit = useSubmit();
  const balances = useBalances(wallet.accountId, config.weth, config.usdc);
  const [input, setInput] = useState("1");
  const [last, setLast] = useState<{ mask: number; label: string; before: bigint }>();
  const amount = parseAmount(input, config.weth.decimals);
  const world = s.worlds.find((w) => w.mask === mask);
  const quote = useQuoteSell(s.scenarioId, amount, mask, Boolean(world) && !s.halted);
  const out = world ? quote.data?.[world.index] : undefined;
  const walletWeth = balances.data?.weth ?? 0n;
  const lastWorld = last && s.worlds.find((w) => w.mask === last.mask);

  let blocker: string | undefined;
  if (!isOwner) blocker = "Oracle owner only";
  else if (!world) blocker = "Tap a world on the grid";
  else if (s.halted) blocker = "Pools pause while a resolution is pending";
  else if (!amount) blocker = "Enter an amount of WETH";
  else if (amount > walletWeth) blocker = "Not enough WETH: mint test WETH below";
  else if (out === undefined) blocker = quote.isError ? "No quote for that world" : "Getting a quote…";
  else if (out === 0n) blocker = "No price in that world";

  return (
    <Sheet demo="price-push">
      <SheetTitle sub="Sells WETH-if-w for USDC-if-w in one world's pool, inside the Multiverse contract, from this wallet. The price moves because a real swap happened, never because someone typed a number. You keep WETH-if-w in the other worlds.">
        Price push
      </SheetTitle>
      {picker && <WorldPicker scenario={s} events={events} selected={mask} onToggle={onPick} demo="push-pick" />}
      <InfoRows rows={[{ label: "World", value: world ? world.label : "none picked" }]} />
      <AmountField
        label="WETH to sell there"
        size="md"
        value={input}
        onChange={setInput}
        unit="WETH"
        ariaLabel="Amount of WETH to sell in the picked world"
        demo="push-amount"
        right={<span className="num text-[12px] text-mute">wallet: {fmtWeth(walletWeth)} WETH</span>}
      />
      <InfoRows
        rows={[
          { label: "Pool price now", value: world ? fmtUsd(world.wethPrice) : "—" },
          { label: "Quote", value: out !== undefined ? `${fmt(out)} USDC-if-w` : "—" },
          { label: "Average price of the push", value: out !== undefined && amount ? fmtUsd((out * ONE) / amount) : "—", tone: "text-warn" },
        ]}
      />
      <TxButton
        demo="push-confirm"
        label={world ? `Push ${world.label} down` : "Push the price down"}
        busyLabel="Pushing…"
        blocker={blocker}
        needs={{ contract: true }}
        run={async (step) => {
          const before = world!.wethPrice;
          step("Swapping…");
          const tokens = amount! / scaleOf(config.weth.decimals);
          const minOut = s.worlds.map((w) => (w.index === world!.index ? (out! - (out! * SLIPPAGE_BPS) / 10_000n).toString() : "0"));
          const hash = await submit(
            ftTransferCall(config.weth.tokenId, CONTRACT_ID, tokens, {
              action: "conditional_sell",
              scenario_id: s.scenarioId,
              sell_mask: mask,
              plans: s.worlds.map(() => []),
              min_out: minOut,
              to_lending: false,
            }),
            tokens,
          );
          setLast({ mask, label: world!.label, before });
          return hash;
        }}
      />
      {last && lastWorld && (
        <p className="num text-[13px] text-ink" data-demo="push-result">
          {last.label}: {fmtUsd(last.before)} → {fmtUsd(lastWorld.wethPrice)}
        </p>
      )}
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <TxButton
          demo="mint-weth"
          tone="secondary"
          size="md"
          label={amount ? `Mint ${fmtWeth(amount)} test WETH to my wallet` : "Mint test WETH to my wallet"}
          busyLabel="Minting…"
          blocker={!isOwner ? "Oracle owner only" : !amount ? "Enter an amount of WETH" : undefined}
          run={() =>
            submit(call(config.weth.tokenId, "mint", { account_id: wallet.accountId, amount: (amount! / scaleOf(config.weth.decimals)).toString() }, "0"))
          }
        />
        <p className="text-[12px] text-mute">Testnet mock: the demo WETH has an open mint and no value.</p>
      </div>
    </Sheet>
  );
}

/** The one command that resets the demo. It runs on the machine with the demo keys, never from the browser. */
function ResetCommand() {
  const [copied, setCopied] = useState<"yes" | "failed">();
  const command = ENV.resetCommand;
  return (
    <Sheet demo="demo-reset">
      <SheetTitle sub={<>Run from the repo root, on the machine with the demo keys in <span className="font-mono">.keys/</span>.</>}>Demo reset</SheetTitle>
      <div className="flex items-stretch gap-2">
        <code className="min-w-0 flex-1 rounded-[14px] bg-navy-950 px-3 py-2.5 font-mono text-[12px] break-words text-ice select-all" data-demo="reset-command">
          {command}
        </code>
        <button
          type="button"
          onClick={() =>
            navigator.clipboard.writeText(command).then(
              () => setCopied("yes"),
              () => setCopied("failed"),
            )
          }
          className={`${pillClass("secondary", "sm")} shrink-0 self-center`}
        >
          {copied === "yes" ? "Copied" : copied === "failed" ? "Select it" : "Copy"}
        </button>
      </div>
      <ul className="flex list-disc flex-col gap-1.5 pl-4 text-[12px] leading-relaxed text-mute">
        <li>Creates fresh events and scenarios, reseeds every pool and reloads Alice&apos;s wallet; the contract stays where it is.</li>
        <li>RUN_SALE=false leaves Alice&apos;s sale and borrow for the stage; without it the script runs them too.</li>
        <li>The app reads the new scenario ids from the contract&apos;s demo record, so an open page picks them up within a minute: no restart.</li>
      </ul>
    </Sheet>
  );
}
