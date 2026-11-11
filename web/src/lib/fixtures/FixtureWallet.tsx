"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { WalletContext, type WalletApi } from "../near/wallet";
import type { Tx } from "../near/tx";
import { personaAccount, personaOf, PERSONAS, type Persona } from "./golden";
import { fixturePersona, setFixturePersona } from "./session";
import { fixtureSend } from "./wallet";

/** Design mode's wallet: sign in as one of the demo story's people; transactions are simulated against the fixtures. */
export default function FixtureWallet({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [accountId, setAccountId] = useState<string | null>(() => {
    const p = fixturePersona();
    return p ? personaAccount(p) : null;
  });
  const [pickerOpen, setPickerOpen] = useState(false);

  const choose = useCallback(
    (name: string) => {
      const p = PERSONAS.find((x) => x === name) as Persona | undefined;
      if (!p) return;
      setFixturePersona(p);
      setAccountId(personaAccount(p));
      setPickerOpen(false);
      void qc.invalidateQueries();
    },
    [qc],
  );

  const value = useMemo<WalletApi>(
    () => ({
      accountId,
      ready: true,
      connecting: false,
      fixtures: true,
      connect: async () => setPickerOpen(true),
      disconnect: async () => {
        setFixturePersona(null);
        setAccountId(null);
      },
      send: async (tx: Tx) => {
        const out = await fixtureSend(tx, personaOf(accountId) ?? null);
        await qc.invalidateQueries();
        return out;
      },
      picker: { open: pickerOpen, close: () => setPickerOpen(false), choose },
    }),
    [accountId, pickerOpen, choose, qc],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
