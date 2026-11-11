"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useSyncExternalStore } from "react";
import { BranchLines } from "@/components/brand/BranchLines";
import { IconLend, IconProtect, IconResolve, IconSplit } from "@/components/brand/Icons";
import { Wordmark } from "@/components/brand/Mark";
import { useIsDesktop } from "@/lib/hooks/useMedia";
import { useWallet } from "@/lib/near/wallet";
import { SplitArt } from "./SplitArt";

const KEY = "multiverse.welcomed";
const listeners = new Set<() => void>();

function readWelcomed(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("welcome") === "0") return true;
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Whether this browser has seen the landing (a per-viewer convenience; losing it only shows the landing again). */
export function useWelcomed(): [boolean, () => void] {
  const seen = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    readWelcomed,
    () => true,
  );
  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(KEY, "1");
    } catch {
      // storage blocked: the landing just shows again next visit
    }
    listeners.forEach((l) => l());
  }, []);
  return [seen, dismiss];
}

/** The landing stands in for the home on a first, signed-out visit. Waits for a restored session before deciding. */
export function useLandingVisible(): boolean {
  const wallet = useWallet();
  const [seen] = useWelcomed();
  return wallet.ready && !wallet.accountId && !seen;
}

const STEPS = [
  {
    icon: <IconSplit />,
    title: "Split",
    body: "1 ETH becomes 1 ETH in each possible future. Nothing is lost: together the pieces are your ETH.",
  },
  {
    icon: <IconProtect />,
    title: "Sell the futures you fear",
    body: "Sell the pieces in the worlds you are afraid of for dollars in those worlds. Keep ETH everywhere else.",
  },
  {
    icon: <IconLend />,
    title: "Borrow against the worst one",
    body: "Your position is valued in the world where it is worth least, so lenders are repaid whatever happens.",
  },
  {
    icon: <IconResolve />,
    title: "One future happens",
    body: "When the events resolve, one world is left. Its pieces redeem 1:1 for real ETH and USDC; the rest are worth nothing.",
  },
];

/** First visit and the signed-out hero: what Multiverse is, in one screen, and the way in. */
export function Landing({ embedded }: { embedded?: boolean }) {
  const wallet = useWallet();
  const router = useRouter();
  const desktop = useIsDesktop();
  const [, dismiss] = useWelcomed();
  const lookAround = () => {
    dismiss();
    if (!embedded) router.push("/");
  };

  const ink = desktop; // dark type on the desktop's ice field, white type on the phone's deep lower half
  return (
    <main className="relative isolate min-h-dvh bg-navy-950" data-demo="landing">
      <section className={`grain relative overflow-hidden ${desktop ? "bg-landing-wide" : "bg-landing"}`}>
        <BranchLines opacity={0.22} className="mix-blend-overlay" />
        <div
          className={`relative mx-auto flex min-h-dvh max-w-[1240px] flex-col pt-[max(18px,env(safe-area-inset-top))] ${desktop ? "max-h-[920px] min-h-[720px] px-10 pb-16" : "px-5 pb-10"}`}
        >
          <div className="flex items-center justify-between">
            <Wordmark tone="dark" />
            {!embedded && (
              <Link href="/" className="focus-ring rounded-full px-3 py-2 text-[14px] font-medium text-ink/70 hover:text-ink">
                Open the app
              </Link>
            )}
          </div>

          <div className={`flex flex-1 ${desktop ? "flex-row-reverse items-center gap-16" : "flex-col justify-between gap-8"}`}>
            <div className={`flex justify-center ${desktop ? "flex-1" : "pt-8"}`}>
              <SplitArt size={desktop ? "lg" : "md"} />
            </div>

            <div className={`flex flex-col gap-5 ${desktop ? "max-w-[540px] flex-1" : ""}`}>
              <h1
                className={`font-display leading-[1.02] font-bold tracking-[-0.01em] uppercase ${ink ? "text-ink" : "text-white"} ${desktop ? "text-[60px]" : "text-[34px]"}`}
                data-demo="landing-headline"
              >
                Hedge the future you{" "}
                <span className={`font-serif font-normal tracking-normal normal-case italic ${desktop ? "text-[70px]" : "text-[40px]"}`}>fear</span>
              </h1>
              <p className={`max-w-[34rem] leading-relaxed ${ink ? "text-ink/80" : "text-white/85"} ${desktop ? "text-[18px]" : "text-[15px]"}`}>
                Sell your ETH only in the futures you&apos;re afraid of. Keep all of it in the ones you&apos;re not. Settled on NEAR.
              </p>
              <div className={`mt-2 flex gap-3 ${desktop ? "flex-row items-center" : "flex-col"}`}>
                {wallet.accountId ? (
                  <Link
                    href="/"
                    onClick={dismiss}
                    className={`focus-ring inline-flex min-h-[52px] items-center justify-center rounded-full px-7 text-[15px] font-semibold ${ink ? "bg-ink text-white hover:bg-[#1a2238]" : "bg-white text-ink hover:bg-ice"}`}
                    data-demo="landing-open"
                  >
                    Open the app
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => void wallet.connect()}
                    disabled={!wallet.ready || wallet.connecting}
                    className={`focus-ring inline-flex min-h-[52px] items-center justify-center rounded-full px-7 text-[15px] font-semibold disabled:opacity-60 ${ink ? "bg-ink text-white hover:bg-[#1a2238]" : "bg-white text-ink hover:bg-ice"}`}
                    data-demo="landing-connect"
                  >
                    {wallet.connecting ? "Connecting…" : "Connect NEAR wallet"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={lookAround}
                  className={`focus-ring min-h-11 rounded-full px-5 text-[15px] font-medium ${ink ? "text-ink hover:bg-white/40" : "text-white/90 hover:text-white"}`}
                  data-demo="welcome-skip"
                >
                  Look around first
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={`mx-auto max-w-[1240px] ${desktop ? "px-10 py-14" : "px-5 py-10"}`} aria-labelledby="how-title" data-demo="how-it-works">
        <h2 id="how-title" className="mb-5 font-display text-[22px] font-medium text-white">
          How it works
        </h2>
        <ol className={`grid gap-3 ${desktop ? "grid-cols-4" : "grid-cols-1"}`}>
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-3 rounded-[20px] border border-white/10 bg-white/6 p-4 text-white">
              <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-white text-ink">{s.icon}</span>
              <div className="min-w-0">
                <div className="text-[14px] font-semibold">
                  <span className="num mr-1.5 text-white/55">{i + 1}</span>
                  {s.title}
                </div>
                <p className="mt-1 text-[13px] leading-relaxed text-white/75">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
