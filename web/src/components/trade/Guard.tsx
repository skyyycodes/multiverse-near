"use client";

import type { ReactNode } from "react";
import { HeroNumber, Screen } from "@/components/shell/Screen";
import { ChainWait, Notice } from "@/components/ui/Notice";
import { CONTRACT_ID } from "@/lib/data/client";
import type { AppConfig } from "@/lib/domain";
import { ENV } from "@/lib/env";
import { useAppConfig } from "@/lib/hooks/useData";

const MISSING = /does ?n[o']t exist|UnknownAccount|CodeDoesNotExist|NoContractCode|MethodNotFound|contract.*not.*deployed/i;

/**
 * Every screen needs the contract's config first: which tokens, and the demo record that names the scenarios. Until
 * it arrives the screen shows its frame with a reading state; without a contract or a seeded demo it says so.
 */
export function ConfigGuard({ children, needDemo = true }: { children: (config: AppConfig) => ReactNode; needDemo?: boolean }) {
  const config = useAppConfig();
  if (config.data) {
    const d = config.data.demo;
    if (needDemo && (!d || d.scenario2x2 === null || d.scenarioBinary === null)) {
      return (
        <Frame>
          <Notice title="Not seeded yet">
            The contract <span className="font-mono text-ink">{CONTRACT_ID}</span> is deployed on {ENV.network}, but the demo has not been
            seeded there yet.
          </Notice>
        </Frame>
      );
    }
    return <>{children(config.data)}</>;
  }
  if (config.error && MISSING.test(config.error.message)) {
    return (
      <Frame>
        <Notice title="No contract yet">
          The Multiverse contract <span className="font-mono text-ink">{CONTRACT_ID}</span> is not deployed on {ENV.network} yet.
        </Notice>
      </Frame>
    );
  }
  return (
    <Frame loading={!config.error}>
      <ChainWait error={config.error?.message} onRetry={() => void config.refetch()} />
    </Frame>
  );
}

/** The screen's frame around a guard: a reading state while the config loads, a plain title once the answer is in. */
function Frame({ children, loading }: { children: ReactNode; loading?: boolean }) {
  const hero = loading ? (
    <HeroNumber label="NEAR spot" value="—" loading />
  ) : (
    <div className="flex flex-col gap-2">
      <span className="label text-white/65">Multiverse Lending</span>
      <span className="font-display text-[30px] leading-tight font-medium tracking-[-0.01em]">Hedge the future you fear</span>
    </div>
  );
  return (
    <Screen hero={hero}>
      <div className="flex flex-col gap-4">{children}</div>
    </Screen>
  );
}
