"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Screen } from "@/components/shell/Screen";
import { ConfigGuard } from "@/components/trade/Guard";
import { PillLink } from "@/components/ui/Button";
import { Chip, InfoRows, Segmented } from "@/components/ui/Bits";
import { Disclosure } from "@/components/ui/Disclosure";
import { AmountField } from "@/components/ui/Field";
import { ChainWait, Notice } from "@/components/ui/Notice";
import { ProgressBar } from "@/components/ui/Progress";
import { Block, Sheet, SheetTitle } from "@/components/ui/Surface";
import { TxButton } from "@/components/ui/TxButton";
import { CONTRACT_ID } from "@/lib/data/client";
import type { AppConfig, EventState, MarketParamsView, Pledge, Proposal } from "@/lib/domain";
import { humanError, parseContractError } from "@/lib/errors";
import { accountLabel, fmt, fmtNear, fmtPrice, inputText, parseAmount, pct, relTime, utcDate } from "@/lib/format";
import { useNowSeconds } from "@/lib/hooks/useClock";
import { useBalances } from "@/lib/hooks/useData";
import { useDebounced } from "@/lib/hooks/useDebounced";
import { useMarketCard } from "@/lib/hooks/useMarket";
import { useEvents, useMarketParams, usePledge, usePledgePreview, useProposal, useSeedPreview } from "@/lib/hooks/useProposal";
import { useSubmit } from "@/lib/hooks/useTx";
import { marketHref, proposeHref } from "@/lib/links";
import { openedMarketId, pledgeResult, pledgeReturnedLine, seedWithdrawnLine } from "@/lib/near/outcome";
import {
  approveProposal,
  cancelProposal,
  claimUnused,
  GAS_CALL,
  GAS_LIGHT,
  GAS_MAX,
  ONE_YOCTO,
  openMarket,
  pledge as pledgeTx,
  rejectProposal,
  seedWithdraw,
  topUpDeposit,
  topUpProposal,
  withdrawPledge,
} from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import {
  CATEGORIES,
  nearText,
  normaliseTerms,
  parseProposalParam,
  pledgeActions,
  progressLine,
  proposalStage,
  proposalTitle,
  seedMinimums,
  spanWords,
  STATUS_LABEL,
  STATUS_TONE,
  termsProblem,
  worldLabels,
} from "@/lib/proposals";
import type { Asset } from "@/lib/types";
import { toTokenCeil } from "@/lib/units";

/** The proposal page (web 6.9): stage, progress, opening preview, pledging and every way back out. */
export function ProposalScreen() {
  return <ConfigGuard>{(config) => <ProposalPage config={config} />}</ConfigGuard>;
}

function ProposalPage({ config }: { config: AppConfig }) {
  const search = useSearchParams();
  const pid = parseProposalParam(search.get("p"));
  const prop = useProposal(pid);
  const mp = useMarketParams();
  const p = prop.data;
  const events = useEvents(p?.eventIds ?? []);
  const evs = (p?.eventIds ?? []).map((id) => events.data?.find((e) => e.id === id)).filter((e): e is EventState => Boolean(e));

  if (pid === undefined) {
    return (
      <Screen demo="proposal" hero={<Hero title="Proposal" />}>
        <Notice title="Which proposal?">
          This link has no proposal number.{" "}
          <Link className="font-medium text-cobalt-ink underline-offset-2 hover:underline" href={proposeHref()}>
            See the proposals collecting pledges
          </Link>
          .
        </Notice>
      </Screen>
    );
  }
  if (p === null) {
    return (
      <Screen demo="proposal" hero={<Hero title={`Proposal #${pid}`} />}>
        <Notice title="No such proposal">
          There is no proposal #{pid} on this contract.{" "}
          <Link className="font-medium text-cobalt-ink underline-offset-2 hover:underline" href={proposeHref()}>
            Propose a market
          </Link>
          .
        </Notice>
      </Screen>
    );
  }
  if (!p || !mp.data) {
    return (
      <Screen demo="proposal" hero={<Hero title={`Proposal #${pid}`} />}>
        <ChainWait error={(prop.error ?? mp.error)?.message} onRetry={() => void (prop.error ? prop.refetch() : mp.refetch())} />
      </Screen>
    );
  }

  const labels = p.newEvent ? worldLabels([p.newEvent]) : evs.length === p.eventIds.length ? worldLabels(evs) : undefined;
  const title = proposalTitle(p, (id) => events.data?.find((e) => e.id === id)?.question);
  return (
    <Screen
      demo="proposal"
      hero={<Header p={p} title={title} />}
      asideFirst
      aside={<Actions p={p} config={config} mp={mp.data} labels={labels} />}
    >
      <StageBlock p={p} labels={labels} />
      <Questions p={p} events={evs} />
      {p.preview && <OpeningPreviewBlock p={p} labels={labels} mp={mp.data} />}
    </Screen>
  );
}

function Hero({ title }: { title: string }) {
  return <h1 className="font-display text-[34px] leading-[1.05] font-medium tracking-[-0.015em]">{title}</h1>;
}

function Header({ p, title }: { p: Proposal; title: string }) {
  const now = Number(useNowSeconds());
  const live = p.status === "review" || p.status === "pledging" || p.status === "ready" || p.status === "waiting";
  return (
    <div className="flex flex-col gap-3" data-demo="proposal-header">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label text-white/65">Proposal #{p.proposalId}</span>
        <Chip onDark tone="neutral">
          {p.kind === "new_event" ? "New event" : `Combination · ${p.worldCount} worlds`}
        </Chip>
        <span data-demo="proposal-status" data-status={p.status}>
          <Chip onDark tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Chip>
        </span>
      </div>
      <h1 className="font-display text-[28px] leading-[1.1] font-medium tracking-[-0.015em]">{title}</h1>
      <p className="num text-[13px] text-white/70">
        by {accountLabel(p.proposer, 28)} · created {utcDate(p.createdAtSec)}
        {live && p.expiresAtSec > 0 && ` · pledging closes ${relTime(p.expiresAtSec - now)} (${utcDate(p.expiresAtSec)})`}
      </p>
    </div>
  );
}

function StageBlock({ p, labels }: { p: Proposal; labels?: string[] }) {
  const stage = proposalStage(p, labels ? (w) => labels[w] ?? `#${w}` : undefined);
  const tone = { pos: "text-pos", neg: "text-neg", warn: "text-warn", neutral: "text-ink", info: "text-cobalt-ink" }[stage.tone];
  const needs = p.preview?.needs;
  return (
    <Block demo="proposal-stage">
      <div className="flex flex-col gap-1">
        <h2 className={`font-display text-[22px] leading-tight font-medium ${tone}`}>{stage.title}</h2>
        {stage.detail && <p className="text-[14px] leading-relaxed text-mute">{stage.detail}</p>}
        {p.status === "opened" && p.opened && (
          <Link href={marketHref(p.opened.scenarioId)} className="text-[14px] font-medium text-cobalt-ink underline-offset-2 hover:underline">
            Trade on market #{p.opened.scenarioId}
          </Link>
        )}
      </div>
      {p.status !== "opened" && (
        <>
          <ProgressBar demo="pledge-progress" valueBps={Math.min(p.progressBps, 10_000)} label={progressLine(p)} />
          <InfoRows
            rows={[
              { label: "Pledged", value: `${fmt(p.pledgedUsdc)} USDC + ${fmtNear(p.pledgedWnear)} wNEAR`, demo: "pledged-totals" },
              { label: "Pledgers", value: String(p.pledgers) },
              { label: "Best mix", value: `≈ ${fmtNear(p.idealWnear)} wNEAR + ${fmt(p.idealUsdc, 0)} USDC`, demo: "pledge-mix" },
            ]}
          />
          {needs && <p className="text-[13px] text-mute">More {needs === "wnear" ? "wNEAR" : "USDC"} pledges would help most right now.</p>}
        </>
      )}
    </Block>
  );
}

function Questions({ p, events }: { p: Proposal; events: EventState[] }) {
  if (p.newEvent) {
    const e = p.newEvent;
    return (
      <Block title="The question" demo="proposal-question">
        <p className="text-[15px] leading-snug font-medium text-ink">{e.question}</p>
        <InfoRows
          rows={[
            { label: "Outcomes", value: e.outcomeNames.join(" / ") },
            { label: "Deadline", value: utcDate(e.deadlineSec) },
            { label: "Category", value: CATEGORIES[e.category] ?? String(e.category) },
            { label: "Opening chance", value: `${e.terms.odds0Bps / 100}% ${e.outcomeNames[0]}` },
          ]}
        />
        {e.rule && (
          <div className="flex flex-col gap-1">
            <span className="label text-mute">Rule</span>
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{e.rule}</p>
          </div>
        )}
        {e.source && (
          <p className="text-[13px] break-words text-mute" data-demo="proposal-source">
            Data source: {/^https?:\/\//.test(e.source) ? <a className="text-cobalt-ink underline-offset-2 hover:underline" href={e.source} target="_blank" rel="noreferrer">{e.source}</a> : e.source}
          </p>
        )}
      </Block>
    );
  }
  return (
    <Block title={p.eventIds.length === 1 ? "The event" : `The ${p.eventIds.length} events`} demo="proposal-events">
      <ul className="flex flex-col gap-2">
        {p.eventIds.map((id) => {
          const e = events.find((x) => x.id === id);
          return (
            <li key={id} className="flex flex-col gap-1 rounded-[16px] border border-line p-3.5">
              <span className="text-[14px] leading-snug font-medium text-ink">{e?.question ?? `Event #${id}`}</span>
              {e && (
                <span className="num text-[12px] text-mute">
                  #{id} · {e.outcomeNames.join(" / ")} · deadline {utcDate(e.deadline)}
                  {e.finalized ? ` · resolved ${e.outcomeNames[e.outcome]}` : ""}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

function OpeningPreviewBlock({ p, labels, mp }: { p: Proposal; labels?: string[]; mp: MarketParamsView }) {
  const v = p.preview!;
  const label = (w: number) => labels?.[w] ?? `World ${w}`;
  return (
    <Block demo="opening-preview">
      <Disclosure title="If it opened now" defaultOpen>
        <div className="flex flex-col gap-3">
          {v.sRef === null ? (
            <p>No opening price yet{v.blocker ? `: ${humanError(v.blocker)}` : ""}.</p>
          ) : (
            <p className="text-ink">
              Opening NEAR price <span className="num font-semibold">{fmtPrice(v.sRef)}</span>
            </p>
          )}
          {v.prices.length > 0 && (
            <div className="overflow-x-auto">
              <table className="num w-full text-left text-[13px]">
                <thead className="text-mute">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">World</th>
                    <th className="py-1.5 pr-3 font-medium">Chance</th>
                    <th className="py-1.5 pr-3 font-medium">NEAR price</th>
                    <th className="py-1.5 font-medium">Pool</th>
                  </tr>
                </thead>
                <tbody className="text-ink">
                  {v.prices.map((price, w) => {
                    const pool = v.worldPools.find((x) => x.world === w);
                    return (
                      <tr key={w} className="border-t border-line">
                        <td className="py-1.5 pr-3">{label(w)}</td>
                        <td className="py-1.5 pr-3">{v.odds[w] !== undefined ? pct(v.odds[w], 10n ** 18n, 1) : "–"}</td>
                        <td className="py-1.5 pr-3">{fmtPrice(price)}</td>
                        <td className="py-1.5">{pool ? `${fmtNear(pool.wnear)} wNEAR + ${fmt(pool.usdc, 0)} USDC` : "–"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <InfoRows
            rows={[
              { label: "Usable value", value: `${fmt(v.usableValue, 0)} of ${fmt(p.goal, 0)} USDC` },
              { label: "Into pools", value: `${fmtNear(v.usedWnear)} wNEAR + ${fmt(v.usedUsdc)} USDC` },
              { label: "Returned to pledgers", value: `${fmtNear(v.unusedWnear)} wNEAR + ${fmt(v.unusedUsdc)} USDC` },
              { label: "Thinnest world pool", value: `${fmt(v.thinnestWorldUsdc, 0)} USDC (needs ${fmt(mp.params.minOpenDepthUsdc, 0)})` },
              { label: "Odds pools", value: String(v.oddsPools.length) },
              { label: "Storage", value: `${nearText(v.storageEstimate)} of ${nearText(v.reserveAvailable)} NEAR` },
            ]}
          />
        </div>
      </Disclosure>
    </Block>
  );
}

// ---- the action column ----

function Actions({ p, config, mp, labels }: { p: Proposal; config: AppConfig; mp: MarketParamsView; labels?: string[] }) {
  const wallet = useWallet();
  const acct = wallet.accountId;
  const mine = usePledge(p.proposalId, acct);
  const pl = mine.data ?? null;
  const can = pledgeActions(p.status, pl);
  const isOwner = acct !== null && acct === config.ownerId;
  const isProposer = acct !== null && acct === p.proposer;
  const live = can.pledge;
  return (
    <>
      {p.status === "ready" && <OpenBox p={p} />}
      {p.status === "waiting" && <WaitingBox p={p} />}
      {live && <PledgeForm p={p} config={config} mp={mp} />}
      {pl && <MyPledge p={p} pl={pl} can={can} config={config} labels={labels} />}
      {isProposer && live && <ProposerBox p={p} />}
      {isOwner && p.kind === "new_event" && (p.status === "review" || p.status === "pledging") && <OwnerBox p={p} mp={mp} />}
      {!live && !pl && p.status !== "opened" && (
        <Sheet>
          <p className="text-[13px] text-mute">This proposal is closed. Pledgers can take their refund here once they connect.</p>
          <PillLink href={proposeHref()} tone="secondary" size="sm" className="self-start">
            Propose a market
          </PillLink>
        </Sheet>
      )}
    </>
  );
}

function OpenBox({ p }: { p: Proposal }) {
  const submit = useSubmit();
  const [opened, setOpened] = useState<number>();
  return (
    <Sheet demo="open-box">
      <SheetTitle sub="The pledges reached the goal and every opening check passes. Anyone can open it; it costs only gas.">Ready to open</SheetTitle>
      <TxButton
        demo="open-market"
        action="open_market"
        label="Open the market"
        busyLabel="Opening…"
        gas={GAS_MAX}
        deposit="0"
        run={async () => {
          const hash = await submit(openMarket(CONTRACT_ID, p.proposalId), undefined, (o) => setOpened(openedMarketId(o)));
          return hash;
        }}
      />
      {opened !== undefined && (
        <Link href={marketHref(opened)} className="text-[14px] font-medium text-cobalt-ink underline-offset-2 hover:underline">
          Market #{opened} is open: trade it
        </Link>
      )}
    </Sheet>
  );
}

/** `OpenStorageShort(needed, available)` → the numbers T35 needs. */
function storageShort(blocker: string | null): { needed: bigint; available: bigint } | undefined {
  const e = blocker ? parseContractError(blocker) : undefined;
  if (!e || e.name !== "OpenStorageShort") return undefined;
  const [a, b] = e.args;
  if (!/^\d+$/.test(a ?? "") || !/^\d+$/.test(b ?? "")) return undefined;
  return { needed: BigInt(a), available: BigInt(b) };
}

function WaitingBox({ p }: { p: Proposal }) {
  const submit = useSubmit();
  const short = storageShort(p.blocker);
  if (!short) return null;
  const deposit = topUpDeposit(short.needed, short.available);
  return (
    <Sheet demo="waiting-box">
      <SheetTitle sub="The new market needs a little more NEAR for its storage than the reserve holds. Anyone can add it; what the opening does not spend goes to the proposer.">
        Top up the reserve
      </SheetTitle>
      <TxButton
        demo="top-up-proposal"
        action="top_up_proposal"
        label={`Add ${nearText(deposit)} NEAR`}
        busyLabel="Adding…"
        gas={GAS_LIGHT}
        deposit={deposit}
        run={() => submit(topUpProposal(CONTRACT_ID, p.proposalId, short.needed, short.available))}
      />
    </Sheet>
  );
}

function PledgeForm({ p, config, mp }: { p: Proposal; config: AppConfig; mp: MarketParamsView }) {
  const wallet = useWallet();
  const submit = useSubmit();
  const [asset, setAsset] = useState<Asset>("usdc");
  const [text, setText] = useState("");
  const [result, setResult] = useState<string>();
  const bal = useBalances(wallet.accountId, config.wnear, config.usdc);
  const token = asset === "wnear" ? config.wnear : config.usdc;
  const amount = parseAmount(text, 18);
  const debounced = useDebounced(amount, 350);
  const preview = usePledgePreview(p.proposalId, asset, debounced);
  const wallet18 = bal.data ? (asset === "wnear" ? bal.data.wnear : bal.data.usdc) : undefined;
  const min = asset === "wnear" ? mp.params.minPledgeWnear : mp.params.minPledgeUsdc;
  const sym = asset === "wnear" ? "wNEAR" : "USDC";
  const tokens = amount !== undefined ? toTokenCeil(amount, token.decimals) : 0n;

  let blocker: string | undefined;
  if (text.trim() === "") blocker = "Enter an amount";
  else if (amount === undefined || amount <= 0n) blocker = "Enter an amount";
  else if (amount < min) blocker = `Smallest pledge ${fmt(min)} ${sym}`;
  else if (wallet18 !== undefined && amount > wallet18) blocker = `Your wallet holds ${asset === "wnear" ? fmtNear(wallet18) : fmt(wallet18)} ${sym}`;

  const pv = preview.data;
  const pvError = preview.error ? humanError(preview.error.message, { asset }) : undefined;
  return (
    <Sheet demo="pledge-form">
      <SheetTitle
        sub={`Pledges become starting liquidity. When the market opens you receive seed shares worth your pledge at the opening price, withdrawable with their fees after ${spanWords(p.seedLockSec || mp.params.seedLockSec)} (earlier if the market fully resolves). The part the pools cannot use is yours to claim back. Until then you can withdraw everything.`}
      >
        Pledge
      </SheetTitle>
      <Segmented
        options={[
          { value: "usdc", label: "USDC", demo: "pledge-asset-usdc" },
          { value: "wnear", label: "wNEAR", demo: "pledge-asset-wnear" },
        ]}
        value={asset}
        onChange={(a) => {
          setAsset(a);
          setText("");
        }}
      />
      <AmountField
        label="Amount"
        value={text}
        onChange={setText}
        unit={sym}
        demo="pledge-amount"
        invalid={Boolean(text) && amount === undefined}
        right={
          wallet18 !== undefined ? (
            <button type="button" className="num text-[12px] text-cobalt-ink hover:underline" onClick={() => setText(inputText(wallet18, asset === "wnear" ? 4 : 6))}>
              wallet: {asset === "wnear" ? fmtNear(wallet18) : fmt(wallet18)} {sym}
            </button>
          ) : undefined
        }
      />
      <p className="text-[12px] leading-relaxed text-mute" data-demo="pledge-preview">
        {amount && amount > 0n
          ? pv
            ? `Usable value ${fmt(pv.usableBefore, 0)} → ${fmt(pv.usableAfter, 0)} USDC; ${fmt(pv.deployedPart, 0)} of this pledge would go into pools${pv.goalReachedAfter ? "; this pledge reaches the goal: the market opens by itself" : ""}.`
            : pvError
              ? pvError
              : "Checking…"
          : `Smallest pledge ${fmt(mp.params.minPledgeUsdc)} USDC or ${fmtNear(mp.params.minPledgeWnear)} wNEAR.`}
      </p>
      <TxButton
        demo="pledge-confirm"
        action="pledge"
        label={`Pledge ${text || "0"} ${sym}`}
        busyLabel="Pledging…"
        blocker={blocker}
        needs={{ contract: true, tokens: [asset] }}
        gas={GAS_MAX}
        deposit={ONE_YOCTO}
        run={async () => {
          setResult(undefined);
          const hash = await submit(pledgeTx(token.tokenId, CONTRACT_ID, tokens, p.proposalId), "nonzero", (o) => {
            const r = pledgeResult(o);
            if (!r.pledged) setResult("The pledge did not go through; your tokens were returned.");
            else if (r.openScheduled) setResult("Goal reached: the market is opening. This page updates in a few seconds.");
            else if (r.openDeferred) setResult(`Pledged. The goal is reached, but the opening waits: ${humanError(r.openDeferred)}.`);
            else setResult("Pledged.");
          });
          setText("");
          return hash;
        }}
      />
      {result && <p className="text-[13px] text-ink" role="status">{result}</p>}
    </Sheet>
  );
}

function MyPledge({
  p,
  pl,
  can,
  config,
  labels,
}: {
  p: Proposal;
  pl: Pledge;
  can: ReturnType<typeof pledgeActions>;
  config: AppConfig;
  labels?: string[];
}) {
  const submit = useSubmit();
  const [line, setLine] = useState<string>();
  const [wText, setWText] = useState("");
  const [uText, setUText] = useState("");
  const wAmt = parseAmount(wText, 18);
  const uAmt = parseAmount(uText, 18);
  const partial = wText.trim() !== "" || uText.trim() !== "";
  const partialBad = partial && ((wText.trim() !== "" && wAmt === undefined) || (uText.trim() !== "" && uAmt === undefined));
  const tokens = { tokens: ["wnear", "usdc"] as Asset[] };
  const stateChip = { pledged: "Pledged", refundable: "Refundable", seed: "Seed shares" }[pl.state];
  return (
    <Sheet demo="my-pledge">
      <div className="flex items-center justify-between gap-2">
        <SheetTitle>Your pledge</SheetTitle>
        <Chip tone={pl.state === "seed" ? "pos" : pl.state === "refundable" ? "warn" : "info"}>{stateChip}</Chip>
      </div>
      <InfoRows
        rows={[
          { label: "USDC", value: fmt(pl.usdc) },
          { label: "wNEAR", value: fmtNear(pl.wnear) },
          ...(pl.shares !== null ? [{ label: "Seed shares", value: `${fmt(pl.shares)} · ${fmt(pl.withdrawnShares)} withdrawn` }] : []),
          ...(p.status === "opened" && !pl.unusedPaid ? [{ label: "Unused part", value: `${fmt(pl.unusedUsdc)} USDC + ${fmtNear(pl.unusedWnear)} wNEAR` }] : []),
        ]}
      />
      {can.withdraw && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-mute">Withdraw everything, or name an amount per asset (an empty box keeps that asset pledged).</p>
          <div className="grid grid-cols-2 gap-3">
            <AmountField size="md" label="USDC" value={uText} onChange={setUText} placeholder="0" invalid={uText !== "" && uAmt === undefined} demo="pledge-withdraw-usdc" />
            <AmountField size="md" label="wNEAR" value={wText} onChange={setWText} placeholder="0" invalid={wText !== "" && wAmt === undefined} demo="pledge-withdraw-wnear" />
          </div>
          <TxButton
            demo="pledge-withdraw"
            action="withdraw_pledge"
            tone="secondary"
            label={partial ? "Withdraw these amounts" : "Withdraw everything"}
            busyLabel="Withdrawing…"
            blocker={partialBad ? "Check the amounts" : undefined}
            needs={tokens}
            gas={GAS_CALL}
            run={() =>
              submit(
                withdrawPledge(CONTRACT_ID, p.proposalId, partial ? { wnear: wAmt ?? 0n, usdc: uAmt ?? 0n } : { wnear: null, usdc: null }),
                undefined,
                (o) => setLine(pledgeReturnedLine(o)),
              ).then((h) => {
                setWText("");
                setUText("");
                return h;
              })
            }
          />
        </div>
      )}
      {can.refund && (
        <TxButton
          demo="pledge-refund"
          action="withdraw_pledge"
          label="Get my refund"
          busyLabel="Refunding…"
          needs={tokens}
          gas={GAS_CALL}
          run={() => submit(withdrawPledge(CONTRACT_ID, p.proposalId), undefined, (o) => setLine(pledgeReturnedLine(o)))}
        />
      )}
      {can.claim && (
        <TxButton
          demo="claim-unused"
          action="claim_unused"
          tone="secondary"
          label={`Claim the unused part · ${fmt(pl.unusedUsdc)} USDC + ${fmtNear(pl.unusedWnear)} wNEAR`}
          busyLabel="Claiming…"
          needs={tokens}
          gas={GAS_CALL}
          run={() => submit(claimUnused(CONTRACT_ID, p.proposalId), undefined, (o) => setLine(pledgeReturnedLine(o)))}
        />
      )}
      {can.seed && p.opened && <SeedWithdraw p={p} pl={pl} config={config} labels={labels} onLine={setLine} />}
      {line && (
        <p className="text-[13px] text-pos" role="status">
          {line}
        </p>
      )}
    </Sheet>
  );
}

function SeedWithdraw({ p, pl, labels, onLine }: { p: Proposal; pl: Pledge; config: AppConfig; labels?: string[]; onLine: (s: string | undefined) => void }) {
  const wallet = useWallet();
  const submit = useSubmit();
  const now = Number(useNowSeconds());
  const sid = p.opened!.scenarioId;
  const card = useMarketCard(sid);
  const [text, setText] = useState("all");
  const all = text.trim().toLowerCase() === "all" || text.trim() === "";
  const parsed = all ? undefined : parseAmount(text, 18);
  const shares: bigint | null = all ? null : (parsed ?? 0n);
  const debounced = useDebounced(shares, 350);
  const preview = useSeedPreview(p.proposalId, wallet.accountId, debounced);
  const pv = preview.data;
  const remaining = (pl.shares ?? 0n) - pl.withdrawnShares;
  const max = pv?.maxShares ?? pl.maxWithdrawableShares;
  const want = all ? remaining : (parsed ?? 0n);

  let blocker: string | undefined;
  if (remaining <= 0n) blocker = "Every share is withdrawn";
  else if (pv && pv.lockedUntilSec > 0) blocker = `Locked until ${utcDate(pv.lockedUntilSec)}`;
  else if (!pv && pl.unlockAtSec > now) blocker = `Locked until ${utcDate(pl.unlockAtSec)}`;
  else if (!all && (parsed === undefined || parsed <= 0n)) blocker = "Enter a number of shares or all";
  else if (want > max) blocker = `Lenders depend on these pools: at most ${fmt(max)} shares now`;
  else if (preview.error) blocker = humanError(preview.error.message);
  else if (!pv || !card.data) blocker = "Pricing the withdrawal…";

  const label = (w: number) => labels?.[w] ?? `world ${w}`;
  const extra = pv?.tokens.filter((t) => t.amount > 0n) ?? [];
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4" data-demo="seed-withdraw-box">
      <span className="text-[14px] font-semibold text-ink">Withdraw seed shares</span>
      <AmountField
        size="md"
        label="Shares"
        value={text}
        onChange={setText}
        allowWords
        placeholder="all"
        demo="seed-shares"
        right={
          <button type="button" className="num text-[12px] text-cobalt-ink hover:underline" onClick={() => setText("all")}>
            all: {fmt(remaining)}
          </button>
        }
      />
      {pv && (
        <p className="text-[12px] leading-relaxed text-mute" data-demo="seed-preview">
          {fmt(pv.usdcOut)} USDC + {fmtNear(pv.wnearOut)} wNEAR now
          {extra.length > 0 ? `, plus ${extra.length} world token${extra.length === 1 ? "" : "s"} that stay in your holdings` : ""}.
          {pv.perWorld.wnear.length > 1 && ` If a world wins: ${pv.perWorld.usdc.map((u, w) => `${label(w)} ${fmt(u)} USDC + ${fmtNear(pv.perWorld.wnear[w] ?? 0n)} wNEAR`).join("; ")}.`}
        </p>
      )}
      <TxButton
        demo="seed-withdraw"
        action="seed_withdraw"
        label={all ? "Withdraw all shares" : `Withdraw ${text} shares`}
        busyLabel="Withdrawing…"
        blocker={blocker}
        needs={{ tokens: ["wnear", "usdc"] }}
        gas={GAS_MAX}
        run={() => {
          const m = seedMinimums(pv!.perWorld, card.data!.worldCount, card.data!.possible);
          return submit(seedWithdraw(CONTRACT_ID, { proposalId: p.proposalId, shares, minWnearOut: m.wnear, minUsdcOut: m.usdc }), undefined, (o) =>
            onLine(seedWithdrawnLine(o)),
          );
        }}
      />
    </div>
  );
}

function ProposerBox({ p }: { p: Proposal }) {
  const submit = useSubmit();
  const hasPledges = p.pledgedUsdc > 0n || p.pledgedWnear > 0n;
  const bondText =
    p.kind === "market"
      ? `Cancelling a combination keeps its bond (${nearText(p.bond)} NEAR): it goes to the fund that pays new markets' storage. The reserve (${nearText(p.reserve)} NEAR) comes back to your storage balance.`
      : p.status === "review"
        ? `In review, cancelling returns the bond (${nearText(p.bond)} NEAR) and the reserve (${nearText(p.reserve)} NEAR) to your storage balance.`
        : `The bond came back at approval; cancelling returns the reserve (${nearText(p.reserve)} NEAR) to your storage balance.`;
  return (
    <Sheet demo="proposal-proposer">
      <SheetTitle sub={hasPledges ? "Others have pledged, so the proposal can no longer be cancelled." : bondText}>Your proposal</SheetTitle>
      <TxButton
        demo="cancel-proposal"
        action="cancel_proposal"
        tone="secondary"
        label="Cancel the proposal"
        busyLabel="Cancelling…"
        blocker={hasPledges ? "Has pledges" : undefined}
        gas={GAS_CALL}
        run={() => submit(cancelProposal(CONTRACT_ID, p.proposalId))}
      />
    </Sheet>
  );
}

function OwnerBox({ p, mp }: { p: Proposal; mp: MarketParamsView }) {
  const submit = useSubmit();
  const [checks, setChecks] = useState({ binary: false, source: false, uncausable: false });
  const [odds, setOdds] = useState("");
  const [m0, setM0] = useState("");
  const [m1, setM1] = useState("");
  const [forfeit, setForfeit] = useState(false);
  const ne = p.newEvent!;
  const reterm = odds.trim() !== "" || m0.trim() !== "" || m1.trim() !== "";
  const pctBps = (s: string, keep: number) => (s.trim() === "" ? keep : /^\d{1,3}$/.test(s.trim()) ? Number(s.trim()) * 100 : NaN);
  const terms = { odds0Bps: pctBps(odds, ne.terms.odds0Bps), multBps: [pctBps(m0, ne.terms.multBps[0]), pctBps(m1, ne.terms.multBps[1])] as [number, number] };
  const termsErr = reterm ? termsProblem(terms.odds0Bps, terms.multBps, mp.params) : undefined;
  const allChecked = checks.binary && checks.source && checks.uncausable;
  const inReview = p.status === "review";
  let approveBlocker: string | undefined;
  if (!allChecked) approveBlocker = "Tick the three checks first";
  else if (termsErr) approveBlocker = termsErr;
  else if (!inReview && !reterm) approveBlocker = "Already approved: change the terms to re-term it";
  const norm = normaliseTerms(terms.odds0Bps, terms.multBps);
  const box = (key: keyof typeof checks, text: string) => (
    <label className="flex items-start gap-2.5 text-[13px] text-ink">
      <input
        type="checkbox"
        className="mt-0.5 accent-ink"
        checked={checks[key]}
        onChange={(e) => setChecks((c) => ({ ...c, [key]: e.target.checked }))}
        data-demo={`check-${key}`}
      />
      <span>{text}</span>
    </label>
  );
  return (
    <Sheet demo="proposal-admin">
      <SheetTitle sub="Only the contract owner sees this. The checklist stays in this browser.">Admin check</SheetTitle>
      <div className="flex flex-col gap-2">
        {box("binary", "The question has a clear yes/no answer by the deadline")}
        {box("source", "The rule names a public data source anyone can read")}
        {box("uncausable", "Nobody can cause the outcome to win the market")}
      </div>
      <div className="flex flex-col gap-2 rounded-[18px] bg-tile p-3.5">
        <span className="text-[12px] text-mute">
          Opening terms (empty keeps the proposer&apos;s: {ne.terms.odds0Bps / 100}% {ne.outcomeNames[0]}, NEAR {ne.terms.multBps[0] / 100}% / {ne.terms.multBps[1] / 100}%)
        </span>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ["approve-odds", `Chance ${ne.outcomeNames[0]} %`, odds, setOdds],
              ["approve-mult-0", `NEAR if ${ne.outcomeNames[0]} %`, m0, setM0],
              ["approve-mult-1", `NEAR if ${ne.outcomeNames[1]} %`, m1, setM1],
            ] as const
          ).map(([demo, lbl, v, set]) => (
            <label key={demo} className="flex min-w-0 flex-col gap-1 text-[11px] text-mute">
              <span className="truncate">{lbl}</span>
              <input
                value={v}
                onChange={(e) => set(e.target.value)}
                inputMode="numeric"
                data-demo={demo}
                className="num h-10 min-w-0 rounded-[12px] border border-line-strong bg-sheet px-2.5 text-[15px] text-ink outline-none focus:border-ink"
              />
            </label>
          ))}
        </div>
        {reterm && !termsErr && (
          <span className="text-[12px] text-mute">
            Balanced: NEAR {norm[0] / 100}% of today if {ne.outcomeNames[0]}, {norm[1] / 100}% if {ne.outcomeNames[1]}. Openings then wait{" "}
            {spanWords(mp.params.noticeSec)}.
          </span>
        )}
      </div>
      <TxButton
        demo="approve-confirm"
        action="approve"
        label={inReview ? (reterm ? "Approve with these terms" : "Approve") : "Re-term"}
        busyLabel="Approving…"
        blocker={approveBlocker}
        gas={GAS_MAX}
        run={() => submit(approveProposal(CONTRACT_ID, p.proposalId, reterm ? terms : null))}
      />
      <label className="flex items-center gap-2.5 text-[13px] text-ink">
        <input type="checkbox" className="accent-ink" checked={forfeit} onChange={(e) => setForfeit(e.target.checked)} data-demo="reject-forfeit" />
        <span>Keep the bond: this proposal was spam</span>
      </label>
      <TxButton
        demo="reject-confirm"
        action="reject"
        tone="secondary"
        label={forfeit ? "Reject and keep the bond" : "Reject"}
        busyLabel="Rejecting…"
        gas={GAS_CALL}
        run={() => submit(rejectProposal(CONTRACT_ID, p.proposalId, forfeit))}
      />
    </Sheet>
  );
}
