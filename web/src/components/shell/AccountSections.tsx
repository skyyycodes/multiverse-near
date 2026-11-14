"use client";

import Link from "next/link";
import { Chip } from "@/components/ui/Bits";
import type { Holding, Pledge } from "@/lib/domain";
import { fmt, fmtNear } from "@/lib/format";
import { useMarketTitles } from "@/lib/hooks/useMarkets";
import { useHoldings, useMarketsOf, usePledges, useVerseLabel } from "@/lib/hooks/useProposal";
import { marketHref, proposalHref } from "@/lib/links";

const PLEDGE_STATE: Record<Pledge["state"], { text: string; tone: "info" | "warn" | "pos" }> = {
  pledged: { text: "Pledged", tone: "info" },
  refundable: { text: "Refund ready", tone: "warn" },
  seed: { text: "Seed shares", tone: "pos" },
};

const popcount = (m: number) => {
  let n = 0;
  for (let x = m; x; x >>= 1) n += x & 1;
  return n;
};

/** The account sheet's v2 sections (web 6.1): pledges, markets held, and multi-world pieces no market screen shows. */
export function AccountSections({ account, onNavigate }: { account: string; onNavigate: () => void }) {
  const pledges = usePledges(account);
  const markets = useMarketsOf(account);
  const holdings = useHoldings(account);
  const others = (holdings.data ?? []).filter((h) => popcount(h.mask) >= 2);
  const title = useMarketTitles([...(markets.data ?? []), ...others.map((h) => h.scenarioId)]);
  const link = "focus-ring flex items-center justify-between gap-3 rounded-[14px] border border-line px-3.5 py-2.5 text-[13px] text-ink hover:border-ink/30";
  return (
    <>
      <section className="flex flex-col gap-2" data-demo="account-pledges">
        <div className="label text-mute">Your pledges</div>
        {(pledges.data ?? []).length === 0 ? (
          <p className="text-[12px] text-mute">{pledges.isPending ? "Reading…" : "No pledges."}</p>
        ) : (
          pledges.data!.map((p) => (
            <Link key={p.proposalId} href={proposalHref(p.proposalId)} onClick={onNavigate} className={link} data-demo="account-pledge" data-proposal={p.proposalId}>
              <span className="num min-w-0 truncate">
                #{p.proposalId} · {fmt(p.usdc)} USDC + {fmtNear(p.wnear)} wNEAR
              </span>
              <Chip tone={PLEDGE_STATE[p.state].tone}>{PLEDGE_STATE[p.state].text}</Chip>
            </Link>
          ))
        )}
      </section>
      <section className="flex flex-col gap-2" data-demo="account-markets">
        <div className="label text-mute">Your markets</div>
        {(markets.data ?? []).length === 0 ? (
          <p className="text-[12px] text-mute">{markets.isPending ? "Reading…" : "No positions yet."}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {markets.data!.map((sid) => (
              <Link
                key={sid}
                href={marketHref(sid)}
                onClick={onNavigate}
                title={title(sid)}
                className="focus-ring max-w-full truncate rounded-full border border-line-strong px-3 py-1.5 text-[12px] text-ink hover:border-ink"
              >
                {title(sid)}
              </Link>
            ))}
          </div>
        )}
      </section>
      {others.length > 0 && (
        <section className="flex flex-col gap-2" data-demo="account-holdings">
          <div className="label text-mute">Other holdings</div>
          <p className="text-[12px] leading-relaxed text-mute">Pieces that cover several worlds at once, for example from a seed withdrawal.</p>
          {others.map((h) => (
            <HoldingRow key={h.tokenId} h={h} market={title(h.scenarioId)} onNavigate={onNavigate} className={link} />
          ))}
        </section>
      )}
    </>
  );
}

function HoldingRow({ h, market, onNavigate, className }: { h: Holding; market: string; onNavigate: () => void; className: string }) {
  const label = useVerseLabel(h.scenarioId, h.mask);
  const sym = h.asset === "wnear" ? "wNEAR" : "USDC";
  return (
    <Link href={marketHref(h.scenarioId)} onClick={onNavigate} className={className}>
      <span className="num min-w-0 truncate">
        {h.asset === "wnear" ? fmtNear(h.amount) : fmt(h.amount)} {sym}-if-{label.data ?? "…"}
      </span>
      <span className="min-w-0 max-w-[50%] truncate text-[12px] text-mute" title={market}>
        {market}
      </span>
    </Link>
  );
}
