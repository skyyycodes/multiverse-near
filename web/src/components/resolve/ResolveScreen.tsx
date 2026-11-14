"use client";

import { useState } from "react";
import { HeroNumber, Screen } from "@/components/shell/Screen";
import { FuturesList } from "@/components/trade/Home";
import { ConfigGuard } from "@/components/trade/Guard";
import { ChainWait } from "@/components/ui/Notice";
import { Block, Sheet, SheetTitle } from "@/components/ui/Surface";
import { TxButton } from "@/components/ui/TxButton";
import { WorldGrid } from "@/components/world/WorldGrid";
import { CONTRACT_ID } from "@/lib/data/client";
import type { AppConfig, EventState, Scenario } from "@/lib/domain";
import { countdown, fmtAsset } from "@/lib/format";
import { useChainClock } from "@/lib/hooks/useClock";
import { useBalances, useCellQuotes, useResolve, useScenarioId } from "@/lib/hooks/useData";
import { useIsDesktop } from "@/lib/hooks/useMedia";
import { useSubmit } from "@/lib/hooks/useTx";
import { call } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { spanWords } from "@/lib/proposals";
import { walletRedeemable } from "@/lib/settlement";
import type { Asset } from "@/lib/types";
import { ClosePanels } from "./ClosePanel";
import { EventCard } from "./EventCard";
import { EventOracle } from "./EventOracle";

/** Resolve and collapse: where each event stands, dead worlds fading, then one "Close and redeem". */
export function ResolveScreen() {
  return <ConfigGuard>{(config) => <Resolve config={config} />}</ConfigGuard>;
}

function Resolve({ config }: { config: AppConfig }) {
  const wallet = useWallet();
  const desktop = useIsDesktop();
  const sid = useScenarioId(config);
  const view = useResolve(sid, wallet.accountId);
  const balances = useBalances(wallet.accountId, config.wnear, config.usdc);
  const quotes = useCellQuotes(config, sid, wallet.accountId);
  const clock = useChainClock(view.data?.nowSec, view.dataUpdatedAt);
  const d = view.data;
  const s = d?.scenario;
  // While a grid event's result waits out its window, the countdown is the screen's number.
  const pending = d?.events.find((e) => e.proposalOpen);
  const pendingLeft = pending && clock.now !== undefined ? (pending.finalizableAt > clock.now ? pending.finalizableAt - clock.now : 0n) : undefined;

  const card = (e: EventState, kicker: string, inGrid = true) => (
    <EventCard key={e.id} event={e} kicker={kicker} now={clock.now} windowSec={config.disputeWindowSec} inGrid={inGrid}>
      <EventOracle event={e} />
      <FinalizeButton event={e} now={clock.now} blockTime={clock.blockTime} />
    </EventCard>
  );

  return (
    <Screen
      demo="resolve"
      asideFirst={Boolean(s && s.resolutionCount > 0)}
      hero={
        <HeroNumber
          demo="hero-resolved"
          label={pending ? "Dispute window" : "Events resolved"}
          loading={!s}
          value={pending ? countdown(pendingLeft ?? 0n) : s ? `${s.resolutionCount} of ${s.eventIds.length}` : "—"}
          tone={pending ? "text-warn-dark" : undefined}
          sub={
            s && (
              <span className="flex flex-col gap-1">
                {pending && (
                  <span>
                    {pending.outcomeNames[pending.proposedOutcome]} proposed for “{pending.question}” Anyone can finalize when the window closes.
                  </span>
                )}
                <span className="num" data-demo="scenario-status">
                  scenario {s.scenarioId} · {s.resolutionCount} of {s.eventIds.length} resolved
                  {s.halted ? " · paused: resolution pending" : ""}
                </span>
              </span>
            )
          }
        />
      }
      aside={
        s && d ? (
          // Keyed by scenario: a result shown for one scenario never carries over to another.
          <div key={`${CONTRACT_ID}:${sid}`} className="flex flex-col gap-5">
            <ClosePanels config={config} s={s} normal={d.account} walletUsdc={balances.data?.usdc ?? 0n} />
            <WalletRedeem s={s} />
          </div>
        ) : undefined
      }
    >
      {s && d ? (
        <>
          {desktop ? (
            <WorldGrid scenario={s} events={d.events} quotes={quotes} details={false} />
          ) : (
            <FuturesList scenario={s} quotes={quotes} demo="resolve-futures" />
          )}
          <Block demo="resolve-events">
            <Survivors scenario={s} />
            <ResolverNote windowSec={config.disputeWindowSec} />
            {d.events.map((e, i) => card(e, `Event ${String.fromCharCode(65 + i)}`))}
          </Block>
          {d.pastFedEvent && (
            <Block title="Real data: a past Fed decision" demo="past-fed">
              <p className="text-[13px] leading-relaxed text-mute">
                Read from FRED&apos;s federal funds target range (DFEDTARU and DFEDTARL must agree), by OutLayer running the
                reader in a secure enclave, or by the reporter. It is not part of the grid, so finalizing it removes no worlds.
              </p>
              {card(d.pastFedEvent, "Past Fed decision · FRED data", false)}
            </Block>
          )}
        </>
      ) : (
        <Block>
          <ChainWait error={view.error?.message} onRetry={() => void view.refetch()} />
        </Block>
      )}
    </Screen>
  );
}

/** Which worlds are still possible, in words. */
function Survivors({ scenario }: { scenario: Scenario }) {
  const live = scenario.worlds.filter((w) => w.possible);
  if (scenario.resolutionCount === 0) {
    return (
      <p className="text-[14px] leading-relaxed text-mute" data-demo="survivors">
        No event has resolved yet. When one does, the worlds it rules out fade from the grid and their tokens become
        worthless.
      </p>
    );
  }
  if (live.length === 1) {
    return (
      <p className="text-[14px] leading-relaxed text-ink" data-demo="survivors">
        Only <span className="font-semibold text-pos">{live[0].label}</span> is still possible: every token that pays in it
        is now worth the real asset 1:1.
      </p>
    );
  }
  return (
    <p className="text-[14px] leading-relaxed text-ink" data-demo="survivors">
      Still possible: <span className="font-semibold">{live.map((w) => w.label).join(", ")}</span>.
    </p>
  );
}

/** Who resolves the events, said plainly: the data source in each rule decides, and anyone may dispute or finalize. */
function ResolverNote({ windowSec }: { windowSec: number }) {
  return (
    <p className="text-[13px] leading-relaxed text-mute" data-demo="resolver-note">
      Each event resolves from the data source in its rule: OutLayer (TEE) for FRED questions, the reporter for the others.
      Anyone may dispute a proposed result within {spanWords(windowSec)}; after that anyone may finalize.
    </p>
  );
}

/** Anyone can finalize once the window has passed; gated on the last block's time, not the ticking estimate. */
function FinalizeButton({ event, now, blockTime }: { event: EventState; now?: bigint; blockTime?: bigint }) {
  const submit = useSubmit();
  if (!event.proposalOpen) return null;
  const blocker =
    now === undefined || blockTime === undefined
      ? "Reading chain time…"
      : now < event.finalizableAt
        ? `Finalize in ${countdown(event.finalizableAt - now)}`
        : blockTime < event.finalizableAt
          ? "Finalize opens with the next block"
          : undefined;
  return (
    <TxButton
      demo="finalize"
      action="finalize"
      tone="secondary"
      size="md"
      label="Finalize"
      busyLabel="Finalizing…"
      blocker={blocker}
      needs={{ contract: true }}
      run={() => submit(call(CONTRACT_ID, "finalize", { event_id: event.id }, "0"))}
    />
  );
}

/** Collapsed tokens held in the wallet (sold without lending, or returned by a close): one redeem each. */
function WalletRedeem({ s }: { s: Scenario }) {
  const wallet = useWallet();
  const submit = useSubmit();
  // A redeemed row leaves the list (its balance is now zero), so what was redeemed is kept here to confirm it.
  const [redeemed, setRedeemed] = useState<{ label: string; asset: Asset; amount: bigint; symbol: string }[]>([]);
  const rows = walletRedeemable(s);
  if (!wallet.accountId || (rows.length === 0 && redeemed.length === 0)) return null;
  return (
    <Sheet demo="wallet-redeem">
      <SheetTitle sub="Tokens in your wallet, not in a loan, whose world is the only one left: each redeems 1:1 for the real asset.">
        Redeem from your wallet
      </SheetTitle>
      {rows.map((r) => (
        <div key={r.tokenId} className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-[13px]">
            <div className="truncate font-semibold text-ink">{r.label}</div>
            <div className="num text-mute">
              {fmtAsset(r.asset, r.amount)} → {fmtAsset(r.asset, r.amount)} real {r.symbol}
            </div>
          </div>
          <div className="w-32 shrink-0">
            <TxButton
              size="md"
              tone="secondary"
              demo="redeem"
              action="redeem"
              label="Redeem"
              busyLabel="Redeeming…"
              needs={{ contract: true, tokens: [r.asset] }}
              run={async () => {
                const hash = await submit(
                  call(CONTRACT_ID, "redeem", { scenario_id: s.scenarioId, asset: r.asset, mask: r.mask, amount: r.amount.toString() }),
                );
                setRedeemed((x) => [...x, { label: r.label, asset: r.asset, amount: r.amount, symbol: r.symbol }]);
                return hash;
              }}
            />
          </div>
        </div>
      ))}
      {redeemed.map((x) => (
        <p key={x.label} className="num text-[13px] text-pos">
          Redeemed {fmtAsset(x.asset, x.amount)} {x.label} for real {x.symbol}.
        </p>
      ))}
    </Sheet>
  );
}
