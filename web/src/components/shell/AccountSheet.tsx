"use client";

import { lazy, Suspense, useState } from "react";
import { IconCopy } from "@/components/brand/Icons";
import { Pill } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { TxButton } from "@/components/ui/TxButton";
import { CONTRACT_ID } from "@/lib/data/client";
import { accountUrl } from "@/lib/env";
import { fmt, fmtWeth } from "@/lib/format";
import { useAppConfig, useBalances, useRegistration } from "@/lib/hooks/useData";
import { useSubmit } from "@/lib/hooks/useTx";
import { call } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { FAUCET_ON, GetTestTokens } from "./TestTokens";
import { fmtNear, scaleOf } from "@/lib/units";

const FixtureControls =
  process.env.NEXT_PUBLIC_FIXTURES === "1" ? lazy(() => import("./FixturePicker").then((m) => ({ default: m.FixtureControls }))) : null;

/** The connected account: balances, the internal "In Multiverse" balance and its withdrawal, storage, sign out. */
export function AccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wallet = useWallet();
  const config = useAppConfig();
  const cfg = config.data;
  const balances = useBalances(wallet.accountId, cfg?.weth, cfg?.usdc);
  const reg = useRegistration(wallet.accountId, cfg?.weth, cfg?.usdc);
  const submit = useSubmit();
  const [copied, setCopied] = useState(false);
  const b = balances.data;
  const id = wallet.accountId;

  return (
    <Dialog open={open} onClose={onClose} title="Your account" demo="account-sheet">
      {id && (
        <div className="flex items-center justify-between gap-3 rounded-[18px] bg-tile p-4">
          <div className="min-w-0">
            <div className="label text-mute">NEAR account</div>
            <a
              href={wallet.fixtures ? undefined : accountUrl(id)}
              target="_blank"
              rel="noreferrer"
              className="block truncate font-mono text-[13px] text-ink"
              data-demo="account-id"
            >
              {id}
            </a>
          </div>
          <button
            type="button"
            aria-label="Copy account id"
            onClick={() =>
              navigator.clipboard.writeText(id).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
            className="focus-ring grid size-10 shrink-0 place-items-center rounded-full text-mute hover:bg-sheet hover:text-ink"
          >
            {copied ? <span className="text-[11px] text-pos">Copied</span> : <IconCopy size={18} />}
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Balance label="Wallet WETH" value={b ? fmtWeth(b.weth) : "—"} />
        <Balance label="Wallet USDC" value={b ? fmt(b.usdc) : "—"} />
      </div>

      {FAUCET_ON && !wallet.fixtures && id && (
        <div className="flex flex-col gap-2" data-demo="test-tokens">
          <div className="label text-mute">Test tokens</div>
          <GetTestTokens />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="label text-mute">In Multiverse</div>
        <p className="text-[12px] leading-relaxed text-mute">
          Real WETH and USDC the contract holds for you: payouts your wallet could not receive, sub-cent dust, deposits.
          Withdraw sends it to your wallet.
        </p>
        {(["weth", "usdc"] as const).map((asset) => {
          const amount = asset === "weth" ? (b?.innerWeth ?? 0n) : (b?.innerUsdc ?? 0n);
          const label = asset === "weth" ? `${fmtWeth(amount)} WETH` : `${fmt(amount)} USDC`;
          // The token moves whole units only: anything below one stays here, so only the whole part is sent.
          const token = asset === "weth" ? cfg?.weth : cfg?.usdc;
          const unit = token ? scaleOf(token.decimals) : 1n;
          const sendable = amount - (amount % unit);
          const dust = amount > 0n && sendable === 0n;
          const blocker = amount === 0n ? "Nothing here" : dust ? "Too small" : undefined;
          return (
            <div key={asset} className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 flex-col">
                <span className="num text-[14px] text-ink">{label}</span>
                {dust && (
                  <span className="text-[12px] text-mute" data-demo={`dust-${asset}`}>
                    Less than one {token?.symbol ?? asset.toUpperCase()} base unit: the token cannot send it, so it stays here.
                  </span>
                )}
              </span>
              <div className="w-36 shrink-0">
                <TxButton
                  size="sm"
                  tone="secondary"
                  label="Withdraw"
                  busyLabel="Withdrawing…"
                  blocker={blocker}
                  needs={{ tokens: [asset] }}
                  demo={`withdraw-inner-${asset}`}
                  run={() => submit(call(CONTRACT_ID, "withdraw", { asset, amount: sendable.toString() }))}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-1 rounded-[18px] border border-line p-4 text-[12px] leading-relaxed text-mute">
        <span className="label text-mute">Storage</span>
        {reg.data?.contract ? (
          <span>
            Registered with Multiverse:{" "}
            <span className="num text-ink">{fmtNear(BigInt(reg.data.contract.total))} NEAR</span> deposited,{" "}
            <span className="num text-ink">{fmtNear(BigInt(reg.data.contract.available))} NEAR</span> free. NEAR charges
            for the bytes your positions use; the deposit comes back when they are gone.
          </span>
        ) : (
          <span>Not registered yet. Your first action adds a refundable 0.1 NEAR storage deposit.</span>
        )}
      </div>

      {FixtureControls && (
        <Suspense fallback={null}>
          <FixtureControls />
        </Suspense>
      )}

      <Pill
        tone="secondary"
        size="md"
        onClick={() => {
          void wallet.disconnect();
          onClose();
        }}
        data-demo="disconnect"
      >
        Disconnect
      </Pill>
    </Dialog>
  );
}

function Balance({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[18px] bg-tile p-3.5">
      <span className="label text-mute">{label}</span>
      <span className="num text-[18px] text-ink">{value}</span>
    </div>
  );
}
