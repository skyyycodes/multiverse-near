"use client";

import { useState } from "react";
import { HeroNumber, Screen } from "@/components/shell/Screen";
import { FuturesList } from "@/components/trade/Home";
import { ConfigGuard } from "@/components/trade/Guard";
import { InfoRows } from "@/components/ui/Bits";
import { ChainWait } from "@/components/ui/Notice";
import { Block, Sheet, SheetTitle } from "@/components/ui/Surface";
import { TxButton } from "@/components/ui/TxButton";
import { WorldGrid } from "@/components/world/WorldGrid";
import { CONTRACT_ID } from "@/lib/data/client";
import type { Account, AppConfig, EventState, Scenario } from "@/lib/domain";
import { countdown, fmt, fmtAsset, fmtNear, fmtUsd } from "@/lib/format";
import { useChainClock } from "@/lib/hooks/useClock";
import { useBalances, useCellQuotes, useResolve, useScenarioId } from "@/lib/hooks/useData";
import { useIsDesktop } from "@/lib/hooks/useMedia";
import { useSubmit } from "@/lib/hooks/useTx";
import { eventsOf } from "@/lib/near/outcome";
import { call, ftTransferCall } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { fateText, planClose, summarizeClose, walletRedeemable, type CloseSummary } from "@/lib/settlement";
import type { Asset } from "@/lib/types";
import { toTokenCeil } from "@/lib/units";
import { EventCard } from "./EventCard";

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
            <ClosePanel config={config} s={s} v={d.account} walletUsdc={balances.data?.usdc ?? 0n} />
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
            <ResolverNote events={s.eventIds.length} pastFed={Boolean(d.pastFedEvent)} />
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

/** Who resolves the grid's events during the hackathon, said plainly. */
function ResolverNote({ events, pastFed }: { events: number; pastFed: boolean }) {
  const what =
    events > 1
      ? "both grid events from an outcomes file the team controls (the December Fed meeting comes after the hackathon)"
      : "the grid's event from an outcomes file the team controls";
  return (
    <p className="text-[13px] leading-relaxed text-mute" data-demo="resolver-note">
      During the hackathon a resolver script resolves {what}. Each result waits out a dispute window, then anyone can
      finalize it.{pastFed ? " Real data resolves the past Fed decision below." : ""}
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

/** Repay, withdraw and redeem in one transaction, with what the account gets shown first. */
// What a close paid out, per account and scenario, for the rest of the session: the panel is rebuilt when the layout
// switches between phone and desktop, and the position it describes is gone once the close lands.
const closes = new Map<string, CloseSummary>();

function ClosePanel({ config, s, v, walletUsdc }: { config: AppConfig; s: Scenario; v: Account; walletUsdc: bigint }) {
  const wallet = useWallet();
  const submit = useSubmit();
  const closeKey = `${CONTRACT_ID}:${s.scenarioId}:${wallet.accountId ?? ""}`;
  const [closed, setClosedState] = useState<CloseSummary | undefined>(() => closes.get(closeKey));
  const setClosed = (c: CloseSummary | undefined) => {
    if (c) closes.set(closeKey, c);
    setClosedState(c);
  };
  const plan = planClose(v.collateral, s.possible);
  const hasPosition = v.debt > 0n || v.collateral.length > 0;

  let blocker: string | undefined;
  if (!hasPosition) blocker = "Nothing to close";
  else if (s.resolutionCount === 0) blocker = "Opens once an event resolves";
  else if (v.debt > walletUsdc) blocker = `Needs ${fmt(v.debt)} USDC in your wallet to repay`;

  async function run(step: (s: string) => void): Promise<string> {
    step("Closing…");
    const record = (o: Parameters<typeof eventsOf>[0]) => {
      const summary = summarizeClose(eventsOf(o));
      // Design data has no logs; it reports the plan it showed.
      setClosed(summary ?? (wallet.fixtures ? { repaid: v.debt, usdc: plan.realUsdc, wnear: plan.realWnear } : undefined));
    };
    if (v.debt > 0n) {
      // The debt grows by a few seconds of interest before this lands: send 0.1% more, bounded by the wallet; the
      // contract returns what it does not use.
      const cap = v.debt + v.debt / 1000n;
      const tokens = toTokenCeil(cap > walletUsdc ? walletUsdc : cap, config.usdc.decimals);
      return submit(
        ftTransferCall(config.usdc.tokenId, CONTRACT_ID, tokens, { action: "close_after_resolution", scenario_id: s.scenarioId }),
        "nonzero",
        record,
      );
    }
    return submit(call(CONTRACT_ID, "close_after_resolution", { scenario_id: s.scenarioId }), undefined, record);
  }

  return (
    <Sheet demo="close-panel">
      <SheetTitle sub="One transaction: repay the whole loan from your wallet, withdraw every piece of collateral, and redeem each piece that has collapsed (it covers every world still possible) for the real asset 1:1. Live pieces come back as they are; dead pieces too, worth nothing.">
        Close and redeem
      </SheetTitle>

      {hasPosition && (
        <>
          <div className="flex flex-col" data-demo="close-pieces">
            <div className="flex items-baseline justify-between border-b border-line pb-2">
              <span className="label text-mute">Collateral</span>
              <span className="label text-mute">Amount</span>
            </div>
            {plan.pieces.map((p) => (
              <div key={p.tokenId} className={`flex items-start justify-between gap-3 border-b border-line py-2.5 last:border-b-0 ${p.fate === "dead" ? "opacity-60" : ""}`}>
                <div className="min-w-0">
                  <div className={`truncate text-[13px] font-semibold text-ink ${p.fate === "dead" ? "line-through" : ""}`}>{p.label}</div>
                  <div className={`text-[12px] ${p.fate === "redeems" ? "text-pos" : "text-mute"}`}>{fateText(p)}</div>
                </div>
                <span className="num shrink-0 text-[13px] text-ink">{fmtAsset(p.asset, p.amount)}</span>
              </div>
            ))}
          </div>
          <InfoRows
            rows={[
              { label: "You repay (loan plus interest)", value: fmtUsd(v.debt) },
              {
                label: "You receive, real",
                value: `${fmt(plan.realUsdc)} USDC${plan.realWnear > 0n ? ` + ${fmtNear(plan.realWnear)} wNEAR` : ""}`,
                tone: "text-pos",
                demo: "close-receive",
              },
              { label: "Wallet USDC now → after", value: `${fmtUsd(walletUsdc)} → ${fmtUsd(walletUsdc - v.debt + plan.realUsdc)}` },
            ]}
          />
        </>
      )}
      {wallet.accountId && !hasPosition && !closed && <p className="text-[13px] text-mute">This wallet has no loan or collateral in this scenario.</p>}

      <TxButton
        demo="close-confirm"
        action="close"
        label="Close and redeem"
        busyLabel="Closing…"
        blocker={blocker}
        needs={{ contract: true, tokens: ["usdc", "wnear"] }}
        run={run}
      />
      {closed && (
        <p className="num text-[13px] text-pos" data-demo="close-result">
          Repaid {fmtUsd(closed.repaid)}; redeemed {fmt(closed.usdc)} real USDC
          {closed.wnear > 0n ? ` and ${fmtNear(closed.wnear)} real wNEAR` : ""}.
        </p>
      )}
    </Sheet>
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
