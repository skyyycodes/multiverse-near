"use client";

import { useState } from "react";
import { txUrl } from "@/lib/env";
import { errorLine } from "@/lib/errors";
import { useNowSeconds } from "@/lib/hooks/useClock";
import { useAppConfig } from "@/lib/hooks/useData";
import { useAccountInfo, usePauseState } from "@/lib/hooks/useOps";
import { topUpTx, useEnsureRegistered, useSubmit, type Needs, type Step } from "@/lib/hooks/useTx";
import { GAS_FT_CALL, gasFloat, ONE_YOCTO } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { pauseBlocker, type AppAction } from "@/lib/pause";
import { pillClass, Spinner, type Tone } from "./Button";

type Props = {
  label: string;
  busyLabel: string;
  blocker?: string;
  tone?: Tone;
  /** Runs the transaction (after any registration it needs) and resolves with its hash. */
  run: (step: Step) => Promise<string>;
  onDone?: () => void;
  needs?: Needs;
  /** What the button does, for the pause mapping: it is blocked only by that action's flags (WI-3). */
  action?: AppAction;
  /** The transaction's prepaid gas and attached deposit (yocto), for the gas float; default the maximum, 1 yocto. */
  gas?: string;
  deposit?: bigint | string;
  /** What the button says while no wallet is connected. Clicking it opens the wallet picker. */
  connectText?: string;
  demo?: string;
  size?: "lg" | "md" | "sm";
};

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * One confirm: shows each step (registration, then the action), then the transaction hash or the contract's error in
 * plain words with its exact text after them. The button text is the step, else the first blocker in order (a pause of
 * this action, the screen's own blocker, too little NEAR for the gas), else the label.
 */
export function TxButton({
  label,
  busyLabel,
  blocker,
  tone = "primary",
  run,
  onDone,
  needs,
  action,
  gas = GAS_FT_CALL,
  deposit = ONE_YOCTO,
  connectText = "Connect a wallet",
  demo,
  size = "lg",
}: Props) {
  const wallet = useWallet();
  const config = useAppConfig();
  const ensure = useEnsureRegistered(config.data);
  const submit = useSubmit();
  const pause = usePauseState();
  const now = useNowSeconds();
  const connected = Boolean(wallet.accountId);
  const signer = useAccountInfo(connected ? wallet.accountId : null);
  const [step, setStep] = useState<string>();
  const [result, setResult] = useState<{ ok: boolean; text: string; hash?: string }>();
  const [toppingUp, setToppingUp] = useState(false);

  // An unreadable balance blocks nothing: the wallet still refuses a transaction it cannot pay for.
  const float = signer.data ? gasFloat(signer.data, gas, deposit) : undefined;
  const short = float?.short ? `You need at least ${float.needText} NEAR in your wallet for this action` : undefined;
  const reason = connected ? ((action ? pauseBlocker(action, pause.data, now) : undefined) ?? blocker ?? short) : undefined;

  async function click() {
    if (!connected) {
      await wallet.connect();
      return;
    }
    setResult(undefined);
    try {
      setStep(busyLabel);
      await ensure(needs, setStep);
      setStep(busyLabel);
      const hash = await run(setStep);
      setResult({ ok: true, text: `Done · ${hash.slice(0, 10)}…`, hash });
      onDone?.();
    } catch (e) {
      setResult({ ok: false, text: errorLine(errorText(e)) });
    } finally {
      setStep(undefined);
    }
  }

  async function topUp() {
    setToppingUp(true);
    try {
      await submit(topUpTx());
      setResult({ ok: true, text: "Storage topped up. Try again." });
    } catch (e) {
      setResult({ ok: false, text: errorLine(errorText(e)) });
    } finally {
      setToppingUp(false);
    }
  }

  const text = step ?? (connected ? (reason ?? label) : connectText);
  const storageShort = result && !result.ok && /InsufficientStorage/.test(result.text);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        data-demo={demo}
        data-tx={action ?? ""}
        disabled={(connected && Boolean(reason)) || Boolean(step) || (!connected && (!wallet.ready || wallet.connecting))}
        onClick={click}
        className={`${pillClass(tone, size)} w-full`}
      >
        {step && <Spinner />}
        <span>{text}</span>
      </button>
      {result && (
        <p
          role={result.ok ? "status" : "alert"}
          data-demo={demo ? `${demo}-result` : undefined}
          className={`text-[12px] leading-snug break-words ${result.ok ? "num text-pos" : "text-neg"}`}
        >
          {result.hash && !wallet.fixtures ? (
            <a href={txUrl(result.hash)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
              {result.text}
            </a>
          ) : (
            result.text
          )}
        </p>
      )}
      {storageShort && (
        <button type="button" onClick={topUp} disabled={toppingUp} className={`${pillClass("secondary", "sm")} self-start`}>
          {toppingUp ? "Adding storage…" : "Add 0.1 NEAR of storage"}
        </button>
      )}
    </div>
  );
}
