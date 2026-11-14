"use client";

// Operations reads: the contract's version (the version gate), the pause state (banner and TxButton), an account's
// balance and code hash (gas float, About dialog), and the deployed web's version.json (update banner).
import { useQuery } from "@tanstack/react-query";
import { CONTRACT_ID, readSource } from "../data/client";
import type { AccountInfo } from "../data/source";
import { decodePause, decodeVersion, V1_CONTRACT_VERSION } from "../decode";
import type { ContractVersion, PauseState } from "../domain";
import { ENV, FIXTURES } from "../env";
import type { ContractVersionJson, PauseStateJson } from "../types";
import { checkVersion, isMethodNotFound } from "../version";

const view = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> => (await readSource()).view<T>(CONTRACT_ID, method, args);

/** `contract_version()`; a contract without the view (MethodNotFound) is v1. Polls every 30 s while too old. */
export function useContractVersion() {
  return useQuery({
    queryKey: ["version", CONTRACT_ID],
    queryFn: async (): Promise<ContractVersion> => {
      try {
        return decodeVersion(await view<ContractVersionJson>("contract_version"));
      } catch (e) {
        if (e instanceof Error && isMethodNotFound(e.message)) return V1_CONTRACT_VERSION;
        throw e;
      }
    },
    staleTime: 300_000,
    refetchInterval: (q) => (q.state.data && checkVersion(q.state.data, ENV.stateVersion) === "old" ? 30_000 : 300_000),
    retry: 1,
  });
}

/**
 * `pause_state()` every 15 s. Only read from a contract that has it (the version gate keeps v1 contracts away), so a
 * failed read leaves the state unknown and blocks nothing; the contract still refuses a paused action.
 */
export function usePauseState() {
  const version = useContractVersion();
  const v2 = version.data !== undefined && version.data.stateVersion >= 2;
  return useQuery({
    queryKey: ["pause", CONTRACT_ID],
    enabled: v2,
    queryFn: async (): Promise<PauseState> => decodePause(await view<PauseStateJson>("pause_state")),
    refetchInterval: 15_000,
    retry: 1,
  });
}

/** RPC `view_account` at final, every 5 min (the gas float refreshes after every transaction through invalidation). */
export function useAccountInfo(accountId: string | null | undefined) {
  return useQuery({
    queryKey: ["accountInfo", accountId ?? ""],
    enabled: Boolean(accountId),
    queryFn: async (): Promise<AccountInfo> => (await readSource()).account(accountId!),
    staleTime: 60_000,
    refetchInterval: 300_000,
    retry: 1,
  });
}

export type WebVersion = { webVersion: string; gitSha: string; network: string; contractId: string; builtAt: string };

/** `/version.json` of the deployed web, every 5 min; off in design-data and dev builds (they have no release). */
export function useWebUpdate() {
  return useQuery({
    queryKey: ["webVersion"],
    enabled: !FIXTURES && ENV.gitSha !== "dev" && process.env.NODE_ENV === "production",
    queryFn: async (): Promise<WebVersion> => {
      const res = await fetch("/version.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`/version.json answered HTTP ${res.status}`);
      const v = (await res.json()) as { web_version?: string; git_sha?: string; network?: string; contract_id?: string; built_at?: string };
      return { webVersion: v.web_version ?? "", gitSha: v.git_sha ?? "", network: v.network ?? "", contractId: v.contract_id ?? "", builtAt: v.built_at ?? "" };
    },
    refetchInterval: 300_000,
    retry: false,
  });
}
