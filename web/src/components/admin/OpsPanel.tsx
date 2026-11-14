"use client";

import Link from "next/link";
import { useState } from "react";
import { Chip, InfoRows } from "@/components/ui/Bits";
import { Disclosure } from "@/components/ui/Disclosure";
import { ChainWait } from "@/components/ui/Notice";
import { Block, Sheet, SheetTitle } from "@/components/ui/Surface";
import { TextField } from "@/components/ui/TextField";
import { TxButton } from "@/components/ui/TxButton";
import { CONTRACT_ID } from "@/lib/data/client";
import type { AppConfig, MarketParams } from "@/lib/domain";
import { fmt, fmtBps, fmtPrice, relTime, shortAccount, utcDate, utf8Bytes } from "@/lib/format";
import { useNowSeconds } from "@/lib/hooks/useClock";
import { useMarketCard } from "@/lib/hooks/useMarket";
import { useContractVersion, usePauseState } from "@/lib/hooks/useOps";
import { useMarketParams, useProposalList, useReference, useReferenceConfig } from "@/lib/hooks/useProposal";
import { useSubmit } from "@/lib/hooks/useTx";
import { proposalHref } from "@/lib/links";
import { GAS_LIGHT, GAS_MAX, pauseTx, requestReference, setMarketListing, unpauseTx } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { FLAG_LABEL, PAUSE_FLAGS, type PauseFlag } from "@/lib/pause";
import { nearText, proposalTitle, spanWords, STATUS_LABEL, STATUS_TONE } from "@/lib/proposals";

const MAX_REASON_BYTES = 256;
const MAX_GRACE_SEC = 86_400;

/** Who the connected wallet is to the contract: owner, guardian or nobody special. */
export function useRole(config: AppConfig) {
  const wallet = useWallet();
  const pause = usePauseState();
  const a = wallet.accountId?.toLowerCase();
  const guardian = pause.data?.guardianId ?? config.guardianId;
  return { isOwner: Boolean(a && a === config.ownerId.toLowerCase()), isGuardian: Boolean(a && guardian && a === guardian.toLowerCase()) };
}

/** Operations (web 6.11 `ops`): contract version, pause state, and the pause / unpause controls. */
export function OpsBlock({ config }: { config: AppConfig }) {
  const version = useContractVersion();
  const pause = usePauseState();
  const now = Number(useNowSeconds());
  const v = version.data;
  const p = pause.data;
  return (
    <Block title="Operations" demo="ops">
      {!v ? (
        <ChainWait error={version.error?.message} onRetry={() => void version.refetch()} />
      ) : (
        <InfoRows
          rows={[
            { label: "Contract version", value: `code ${v.codeVersion} · state ${v.stateVersion}`, demo: "ops-version" },
            { label: "Upgraded", value: v.upgradedAtSec > 0 ? `${utcDate(v.upgradedAtSec)} from ${v.upgradedFrom || "–"}` : "fresh deployment" },
            { label: "Event log version", value: v.eventVersion },
            { label: "Legacy markets", value: String(v.legacyScenarioCount) },
          ]}
        />
      )}
      <div className="flex flex-col gap-2" data-demo="ops-pause">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] text-mute">Paused:</span>
          {!p ? (
            <span className="text-[13px] text-mute">{pause.isError ? "unknown" : "reading…"}</span>
          ) : p.paused.length === 0 ? (
            <Chip tone="pos">nothing</Chip>
          ) : (
            p.paused.map((f) => (
              <Chip key={f} tone="warn">
                {FLAG_LABEL[f]}
              </Chip>
            ))
          )}
        </div>
        {p && (
          <p className="num text-[12px] text-mute">
            {p.paused.length > 0 && p.sinceSec > 0n ? `Since ${utcDate(p.sinceSec)} · ` : ""}
            Guardian {p.guardianId ? shortAccount(p.guardianId) : "none"} · owner {shortAccount(config.ownerId)}
            {p.pendingOwnerId ? ` · pending owner ${shortAccount(p.pendingOwnerId)}` : ""}
            {p.liquidationsResumeAtSec > BigInt(now) ? ` · liquidations resume ${relTime(Number(p.liquidationsResumeAtSec) - now)}` : ""}
          </p>
        )}
      </div>
      <PauseControls config={config} paused={p?.paused ?? []} />
    </Block>
  );
}

function PauseControls({ config, paused }: { config: AppConfig; paused: readonly PauseFlag[] }) {
  const submit = useSubmit();
  const { isOwner, isGuardian } = useRole(config);
  const [flags, setFlags] = useState<PauseFlag[]>([]);
  const [reason, setReason] = useState("");
  const [grace, setGrace] = useState("1800");
  if (!isOwner && !isGuardian) {
    return <p className="text-[12px] text-mute">Pausing needs the owner&apos;s or the guardian&apos;s wallet; unpausing needs the owner&apos;s.</p>;
  }
  const choices = PAUSE_FLAGS.filter((f) => isOwner || f !== "exit");
  const toPause = flags.filter((f) => !paused.includes(f));
  const toUnpause = flags.filter((f) => paused.includes(f));
  const graceSec = /^\d{1,6}$/.test(grace.trim()) ? Number(grace.trim()) : NaN;
  const toggle = (f: PauseFlag) => setFlags((xs) => (xs.includes(f) ? xs.filter((x) => x !== f) : [...xs, f]));
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <span className="text-[13px] font-medium text-ink">Pick flags</span>
      <div className="flex flex-wrap gap-2">
        {choices.map((f) => (
          <label key={f} className="flex min-h-9 items-center gap-2 rounded-full border border-line-strong px-3 text-[12px] text-ink">
            <input type="checkbox" className="accent-ink" checked={flags.includes(f)} onChange={() => toggle(f)} data-demo={`pause-flag-${f}`} />
            <span>
              {f}
              {paused.includes(f) ? " (paused)" : ""}
            </span>
          </label>
        ))}
      </div>
      <TextField label="Reason" value={reason} onChange={setReason} maxBytes={MAX_REASON_BYTES} demo="pause-reason" placeholder="What is being fixed" />
      <TxButton
        demo="pause-confirm"
        action="pause"
        size="md"
        label={toPause.length ? `Pause ${toPause.join(", ")}` : "Pause"}
        busyLabel="Pausing…"
        blocker={toPause.length === 0 ? "Pick a flag that is running" : utf8Bytes(reason) > MAX_REASON_BYTES ? "Reason too long" : undefined}
        gas={GAS_LIGHT}
        deposit="0"
        run={async () => {
          const h = await submit(pauseTx(CONTRACT_ID, toPause, reason));
          setFlags([]);
          return h;
        }}
      />
      {isOwner && (
        <>
          <TextField
            label="Liquidation grace after unpausing (seconds)"
            value={grace}
            onChange={setGrace}
            demo="unpause-grace"
            hint="Applies when liquidate is unpaused; at most 86,400"
          />
          <TxButton
            demo="unpause-confirm"
            action="unpause"
            size="md"
            tone="secondary"
            label={toUnpause.length ? `Unpause ${toUnpause.join(", ")}` : "Unpause"}
            busyLabel="Unpausing…"
            blocker={toUnpause.length === 0 ? "Pick a paused flag" : !(graceSec >= 0 && graceSec <= MAX_GRACE_SEC) ? "Grace: 0 to 86,400 seconds" : undefined}
            gas={GAS_LIGHT}
            run={async () => {
              const h = await submit(unpauseTx(CONTRACT_ID, toUnpause, toUnpause.includes("liquidate") ? graceSec : undefined));
              setFlags([]);
              return h;
            }}
          />
        </>
      )}
    </div>
  );
}

/** Proposals waiting for the admin's check (`list_proposals("review")`); approve and reject live on each page. */
export function ProposalQueue() {
  const list = useProposalList("review", 20);
  const rows = list.data?.proposals ?? [];
  return (
    <Sheet demo="admin-proposals">
      <SheetTitle sub="New events wait here for the three checks. Open one to approve or reject it.">Proposals to review</SheetTitle>
      {list.isError ? (
        <ChainWait error={list.error.message} onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <ChainWait />
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-mute">Nothing to review.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((p) => (
            <li key={p.proposalId}>
              <Link
                href={proposalHref(p.proposalId)}
                data-demo="admin-proposal"
                data-proposal={p.proposalId}
                className="focus-ring flex flex-col gap-1.5 rounded-[16px] border border-line p-3.5 hover:border-ink/30"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="num text-[12px] text-mute">
                    #{p.proposalId} · by {shortAccount(p.proposer)}
                  </span>
                  <Chip tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Chip>
                </span>
                <span className="text-[14px] leading-snug font-medium text-ink">{proposalTitle(p)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

/** Whether the market in the URL shows in the market list (T48, owner). */
export function MarketListing({ config, sid }: { config: AppConfig; sid: number | undefined }) {
  const submit = useSubmit();
  const card = useMarketCard(sid);
  const { isOwner } = useRole(config);
  const c = card.data;
  if (sid === undefined) return null;
  return (
    <Sheet demo="market-listing">
      <SheetTitle sub="Only listed markets appear in the market list and can anchor or price new proposals.">Market #{sid} listing</SheetTitle>
      <InfoRows
        rows={[
          { label: "Listed", value: c ? (c.listed ? "yes" : "no") : card.isPending ? "reading…" : "not in the registry" },
          ...(c ? [{ label: "Origin", value: c.origin }, { label: "Status", value: c.status.replace("_", " ") }] : []),
        ]}
      />
      <TxButton
        demo="listing-toggle"
        action="listing"
        size="md"
        tone="secondary"
        label={c?.listed ? "Unlist this market" : "List this market"}
        busyLabel="Saving…"
        blocker={!isOwner ? "Owner only" : !c ? "Reading the market…" : undefined}
        gas={GAS_LIGHT}
        run={() => submit(setMarketListing(CONTRACT_ID, sid, !c!.listed))}
      />
    </Sheet>
  );
}

/** The NEAR/USD reference (`get_reference`) and a refresh through OutLayer (T42; anyone). */
export function ReferenceBox() {
  const submit = useSubmit();
  const ref = useReference();
  const cfg = useReferenceConfig();
  const r = ref.data;
  const deposit = cfg.data?.guest?.deposit;
  return (
    <Sheet demo="ops-reference">
      <SheetTitle sub="The outside NEAR/USD price that borrowing, liquidations and openings compare the markets with.">NEAR/USD reference</SheetTitle>
      {ref.isPending ? (
        <ChainWait />
      ) : !r ? (
        <p className="text-[13px] text-mute">{ref.isError ? `Could not read it: ${ref.error.message}` : "No reference price stored yet."}</p>
      ) : (
        <InfoRows
          rows={[
            { label: "Price", value: fmtPrice(r.price) },
            { label: "Source", value: `${r.source} · ${r.sourcesUsed} exchanges · spread ${fmtBps(r.spreadBps)}` },
            { label: "Observed", value: `${utcDate(r.observedAt)} (${spanWords(r.ageSec)} old)` },
            ...(r.pending ? [{ label: "Request", value: `#${r.request} pending` }] : []),
          ]}
        />
      )}
      {cfg.data && (
        <TxButton
          demo="refresh-reference"
          action="request_reference"
          size="md"
          tone="secondary"
          label={deposit !== undefined ? `Refresh from OutLayer · ${nearText(deposit)} NEAR` : "Refresh from OutLayer"}
          busyLabel="Requesting…"
          blocker={!cfg.data.enabled || !cfg.data.guest ? "The OutLayer reference is not configured" : r?.pending ? "A request is in flight" : undefined}
          gas={GAS_MAX}
          deposit={deposit ?? 0n}
          run={() => submit(requestReference(CONTRACT_ID, deposit!))}
        />
      )}
    </Sheet>
  );
}

/** `market_params()` read-only (owner setters stay in scripts). */
export function MarketParamsBox() {
  const mp = useMarketParams();
  if (!mp.data) return null;
  const p: MarketParams = mp.data.params;
  const usd = (x: bigint) => `${fmt(x, 0)} USDC`;
  return (
    <Sheet demo="ops-market-params">
      <Disclosure title="Market parameters">
        <InfoRows
          rows={[
            { label: "Bond: new event / combination", value: `${nearText(p.bondNewEvent)} / ${nearText(p.bondMarket)} NEAR` },
            { label: "Reserve at 2 / 4 / 8 worlds", value: `${nearText(mp.data.reserveW2)} / ${nearText(mp.data.reserveW4)} / ${nearText(mp.data.reserveW8)} NEAR` },
            { label: "Storage fund", value: `${nearText(mp.data.storageFund)} NEAR` },
            { label: "Pledging window / review", value: `${spanWords(p.proposalTtlSec)} / ${spanWords(p.reviewTtlSec)}` },
            { label: "Minimum market life", value: spanWords(p.minMarketLifeSec) },
            { label: "Seed lock / notice", value: `${spanWords(p.seedLockSec)} / ${spanWords(p.noticeSec)}` },
            { label: "Spam floor", value: fmtBps(p.spamFloorBps) },
            { label: "Goal depth / minimum goal", value: `${usd(p.goalDepthUsdc)} / ${usd(p.minGoalUsdc)}` },
            { label: "Minimum opening depth", value: usd(p.minOpenDepthUsdc) },
            { label: "Smallest pledge", value: `${fmt(p.minPledgeUsdc)} USDC / ${fmt(p.minPledgeWnear)} wNEAR` },
            { label: "Anchors", value: p.anchors.filter((a) => a > 0).map((a) => `#${a}`).join(", ") || "none" },
            { label: "Outside price required", value: p.requireExternal ? `yes (within ${fmtBps(p.maxExternalDivergenceBps)})` : "no" },
            { label: "Per account: pledges / live proposals", value: `${p.maxPledgesPerAccount} / ${p.maxActivePerAccount}` },
            { label: "Live proposals per event", value: String(p.maxLivePerEvent) },
          ]}
        />
      </Disclosure>
    </Sheet>
  );
}
