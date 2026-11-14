import { BranchLines } from "@/components/brand/BranchLines";
import { Wordmark } from "@/components/brand/Mark";
import { BRAND } from "@/lib/brand";

/**
 * The pre-launch build (`build:staging:prelaunch`, WI-11): every route shows this one notice until the market list is
 * seeded, and nothing reads the chain. The OutLayer guests and version.json are served beside it unchanged.
 */
export function Prelaunch() {
  return (
    <main className="grain bg-landing relative isolate grid min-h-dvh place-items-center overflow-hidden px-5 py-16" data-demo="prelaunch">
      <BranchLines opacity={0.22} className="mix-blend-overlay" />
      <div className="relative flex max-w-[34rem] flex-col items-start gap-5 rounded-[28px] bg-sheet p-7 shadow-card">
        <Wordmark tone="dark" />
        <h1 className="font-display text-[30px] leading-[1.08] font-medium tracking-[-0.015em] text-ink" data-demo="prelaunch-title">
          {BRAND.name} opens soon
        </h1>
        <p className="text-[15px] leading-relaxed text-ink/80">
          {BRAND.headline} {BRAND.subline} {BRAND.explainer}
        </p>
        <p className="text-[13px] leading-relaxed text-mute">{BRAND.testnetNote}</p>
        <p className="text-[12px] leading-relaxed text-mute" data-demo="paradigm-credit">
          {BRAND.credit.text}:{" "}
          <a href={BRAND.credit.url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
            {BRAND.credit.url.replace(/^https:\/\/(www\.)?/, "")}
          </a>
        </p>
      </div>
    </main>
  );
}
