"use client";

import type { ReactNode } from "react";
import { HeroNumber, Screen } from "@/components/shell/Screen";
import { ChainWait, Notice } from "@/components/ui/Notice";
import { BRAND } from "@/lib/brand";
import { CONTRACT_ID } from "@/lib/data/client";
import type { AppConfig, ContractVersion } from "@/lib/domain";
import { ENV, networkLabel } from "@/lib/env";
import { useAppConfig } from "@/lib/hooks/useData";
import { useContractVersion } from "@/lib/hooks/useOps";
import { checkVersion } from "@/lib/version";

const MISSING = /does ?n[o']t exist|UnknownAccount|CodeDoesNotExist|NoContractCode|MethodNotFound|contract.*not.*deployed/i;

/**
 * Every screen needs the contract's config first (which tokens), then the version gate: a contract older than this
 * build gets the upgrade notice and no screen, so no transaction can be built against it (WI-2). Until both arrive the
 * screen shows its frame with a reading state; without a contract it says so.
 */
export function ConfigGuard({ children }: { children: (config: AppConfig) => ReactNode }) {
  const config = useAppConfig();
  const version = useContractVersion();
  if (config.data && version.data) {
    return <VersionGate version={version.data}>{children(config.data)}</VersionGate>;
  }
  const error = config.error ?? version.error;
  if (config.error && MISSING.test(config.error.message)) {
    return (
      <Frame>
        <Notice title="No contract yet">
          The {BRAND.name} contract <span className="font-mono text-ink">{CONTRACT_ID}</span> is not deployed on {networkLabel()} yet.
        </Notice>
      </Frame>
    );
  }
  return (
    <Frame loading={!error}>
      <ChainWait
        error={error?.message}
        onRetry={() => {
          void config.refetch();
          void version.refetch();
        }}
      />
    </Frame>
  );
}

/** Older contract: the upgrade notice in place of the screen. Equal or newer: the screen (a newer one gets a banner). */
export function VersionGate({ version, children }: { version: ContractVersion; children: ReactNode }) {
  if (checkVersion(version, ENV.stateVersion) !== "old") return <>{children}</>;
  return (
    <Frame>
      <UpgradeNotice version={version} />
    </Frame>
  );
}

export function UpgradeNotice({ version }: { version: ContractVersion }) {
  return (
    <div data-demo="upgrade-notice">
      <Notice title={`${BRAND.name} is being upgraded`}>
        The contract on {networkLabel()} still runs version {version.codeVersion}. This app needs version {ENV.stateVersion}; it opens by itself once
        the upgrade lands.
      </Notice>
    </div>
  );
}

/** The screen's frame around a guard: a reading state while the config loads, a plain title once the answer is in. */
function Frame({ children, loading }: { children: ReactNode; loading?: boolean }) {
  const hero = loading ? (
    <HeroNumber label="NEAR spot" value="—" loading />
  ) : (
    <div className="flex flex-col gap-2">
      <span className="label text-white/65">{BRAND.name}</span>
      <span className="font-display text-[30px] leading-tight font-medium tracking-[-0.01em]">{BRAND.headline}</span>
    </div>
  );
  return (
    <Screen hero={hero}>
      <div className="flex flex-col gap-4">{children}</div>
    </Screen>
  );
}
