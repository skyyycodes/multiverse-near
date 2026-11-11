"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { PERSONAS, personaAccount, STAGES, type Persona, type Stage } from "@/lib/fixtures/golden";
import { fixtureStage, setFixtureStage } from "@/lib/fixtures/session";
import { useWallet } from "@/lib/near/wallet";

const ROLES: Record<Persona, string> = {
  alice: "Hedges her ETH against a delay and a hold",
  bob: "Lends USDC to every market",
  ravi: "Makes markets in the order book",
  sam: "Backs one future he believes in",
  uma: "Underwrites every world as Root LP",
  carl: "Hedged the wrong world and borrowed close to the limit",
  dana: "New account, not registered yet",
  owner: "Oracle owner: resolves, disputes, pushes prices",
};

/** Design mode's stand-in for a wallet picker: sign in as one of the demo story's people. */
export function FixturePicker() {
  const wallet = useWallet();
  if (!wallet.fixtures) return null;
  return (
    <Dialog open={wallet.picker.open} onClose={wallet.picker.close} title="Sign in as" demo="fixture-picker">
      <p className="text-[12px] leading-relaxed text-mute">
        Design data: these accounts and numbers replay the seeded demo. Nothing is signed or sent.
      </p>
      <ul className="flex flex-col gap-1">
        {PERSONAS.map((p) => (
          <li key={p}>
            <button
              type="button"
              data-demo={`persona-${p}`}
              onClick={() => wallet.picker.choose(p)}
              className="focus-ring flex min-h-14 w-full items-center gap-3 rounded-[16px] px-3 text-left hover:bg-tile"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-ink font-display text-[15px] text-white uppercase">
                {p[0]}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-mono text-[13px] text-ink">{personaAccount(p)}</span>
                <span className="block text-[12px] text-mute">{ROLES[p]}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** Design mode: jump to any stage of the demo story. */
export function FixtureControls() {
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage>(() => fixtureStage());
  return (
    <label className="flex flex-col gap-1.5 rounded-[18px] border border-dashed border-line-strong p-4 text-[12px] text-mute">
      <span className="label">Fixture stage (design data)</span>
      <select
        value={stage}
        onChange={(e) => {
          const s = e.target.value as Stage;
          setStage(s);
          setFixtureStage(s);
          void qc.invalidateQueries();
        }}
        className="h-10 rounded-[12px] border border-line-strong bg-sheet px-3 text-[14px] text-ink"
      >
        {STAGES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </label>
  );
}
