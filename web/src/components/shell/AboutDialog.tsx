"use client";

import type { ReactNode } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { BRAND } from "@/lib/brand";
import { CONTRACT_ID } from "@/lib/data/client";
import { accountUrl, ENV, networkLabel } from "@/lib/env";
import { utcDate } from "@/lib/format";
import { useAppConfig } from "@/lib/hooks/useData";
import { useAccountInfo, useContractVersion } from "@/lib/hooks/useOps";

function Row({ label, children, demo }: { label: string; children: ReactNode; demo?: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-line py-2.5 last:border-b-0" data-demo={demo}>
      <dt className="label text-mute">{label}</dt>
      <dd className="text-[13px] break-all text-ink">{children}</dd>
    </div>
  );
}

/**
 * Which deployment this page talks to (W-D8): network, contract and its code hash, contract and web versions, tokens.
 * The code hash is what to compare with a release manifest.
 */
export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const config = useAppConfig();
  const version = useContractVersion();
  const code = useAccountInfo(open ? CONTRACT_ID : null);
  const v = version.data;
  const explorer = accountUrl(CONTRACT_ID);
  return (
    <Dialog open={open} onClose={onClose} title="About this deployment" demo="about-dialog">
      <dl className="flex flex-col">
        <Row label="Network">{networkLabel()}</Row>
        <Row label="Contract" demo="about-contract">
          {explorer ? (
            <a href={explorer} target="_blank" rel="noreferrer" className="font-mono underline-offset-2 hover:underline">
              {CONTRACT_ID}
            </a>
          ) : (
            <span className="font-mono">{CONTRACT_ID}</span>
          )}
        </Row>
        <Row label="Contract code hash" demo="about-code-hash">
          <span className="font-mono">{code.data?.codeHash ?? (code.error ? "could not read" : "reading…")}</span>
          <span className="block text-[12px] text-mute">Compare with the release manifest.</span>
        </Row>
        <Row label="Contract version" demo="about-version">
          {v ? (
            <span className="num">
              {v.codeVersion} · state {v.stateVersion}
              {v.upgradedAtSec > 0 ? ` · upgraded ${utcDate(v.upgradedAtSec)}` : ""}
              {v.upgradedFrom ? ` from ${v.upgradedFrom}` : ""}
            </span>
          ) : (
            "reading…"
          )}
        </Row>
        <Row label="Web" demo="about-web">
          <span className="num">
            {ENV.webVersion} · {ENV.gitSha}
          </span>
        </Row>
        <Row label="Tokens">
          <span className="font-mono">{config.data?.wnear.tokenId ?? ENV.wnearId}</span>
          <br />
          <span className="font-mono">{config.data?.usdc.tokenId ?? ENV.usdcId}</span>
        </Row>
      </dl>
      <p className="text-[12px] leading-relaxed text-mute" data-demo="paradigm-credit">
        {BRAND.credit.text}:{" "}
        <a href={BRAND.credit.url} target="_blank" rel="noreferrer" className="text-cobalt-ink underline-offset-2 hover:underline">
          {BRAND.credit.url.replace(/^https:\/\/(www\.)?/, "")}
        </a>
      </p>
      <p className="text-[12px] text-mute">{BRAND.testnetNote}</p>
    </Dialog>
  );
}
