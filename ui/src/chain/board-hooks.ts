"use client";

// Reads the markets track needs beyond the adapter: the world pools' swap fee (the decoded app config leaves it out).
import { useQuery } from "@tanstack/react-query";
import { CONTRACT_ID, readSource } from "./data/client";
import type { AppConfigView } from "./types";

export type Fees = { base: number; cap: number };

/** The world pools' fee, as fractions (0.003 = 0.30%), rising from `base` to `cap` when trading is one-sided. */
export function useFees() {
  return useQuery({
    queryKey: ["fees", CONTRACT_ID],
    queryFn: async (): Promise<Fees> => {
      const c = await (await readSource()).view<Pick<AppConfigView, "fee_base_pips" | "fee_cap_pips">>(CONTRACT_ID, "get_app_config", {});
      return { base: c.fee_base_pips / 1e6, cap: c.fee_cap_pips / 1e6 };
    },
    staleTime: 300_000,
    retry: 1,
  });
}

/** "0.30%": a fee fraction as the copy prints it. */
export const feeText = (f: number): string => `${(f * 100).toFixed(2)}%`;
