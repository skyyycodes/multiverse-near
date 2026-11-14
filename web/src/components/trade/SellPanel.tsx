"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { TierSelect } from "@/components/lending/TierSelect";
import { InlineButton } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Bits";
import { AmountField } from "@/components/ui/Field";
import { Band, SheetTitle } from "@/components/ui/Surface";
import { TxButton } from "@/components/ui/TxButton";
import { WorldGlyph } from "@/components/world/WorldBits";
import { WorldPicker } from "@/components/world/WorldGrid";
import { BRAND } from "@/lib/brand";
import { CONTRACT_ID } from "@/lib/data/client";
import type { AppConfig, EventState, Scenario } from "@/lib/domain";
import { fmt, fmtNear, fmtPrice, inputText, parseAmount } from "@/lib/format";
import type { Balances } from "@/lib/hooks/useData";
import { useQuoteSell } from "@/lib/hooks/useData";
import { useDebounced } from "@/lib/hooks/useDebounced";
import { useLendingTiers } from "@/lib/hooks/useLending";
import { useSalePlan } from "@/lib/hooks/useSalePlan";
import { useCollateralTier } from "@/lib/hooks/useScenario";
import { useSubmit } from "@/lib/hooks/useTx";
import { via, type Order, type WorldPlan } from "@/lib/orders";
import { planFills, planMinOut, sellFromInner, sellFromWallet } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { sellTier, TIER_LABEL } from "@/lib/tiers";
import { toTokenFloor } from "@/lib/units";

const ONE = 10n ** 18n;

type Props = {
  config: AppConfig;
  scenario: Scenario;
  events: readonly EventState[];
  orders: readonly Order[];
  nowSec: bigint;
  balances?: Balances;
  selected: number;
  onToggle: (mask: number) => void;
  onClear: () => void;
  /** Show the world picker inside the form (phone, and wherever the big grid is not on screen). */
  picker: boolean;
  /** Hide the heading when the screen's header already says it. */
  heading?: boolean;
  /** False on a trading-only market: no borrowing there, so the result always goes to the wallet. */
  lendable?: boolean;
};

/**
 * Sell NEAR in the worlds you fear, keep it everywhere else, in one transaction: the wNEAR travels with the instruction
 * (ft_transfer_call), so there is no approval step. Resting bids fill first in a world when they pay more than the pool
 * would for that part of the sale.
 */
export function SellPanel({ config, scenario, events, orders, nowSec, balances, selected, onToggle, onClear, picker, heading = true, lendable }: Props) {
  const wallet = useWallet();
  const qc = useQueryClient();
  const submit = useSubmit();
  const [input, setInput] = useState("2000");
  const [keepAsCollateral, setToLending] = useState(true);
  const toLending = lendable !== false && keepAsCollateral;
  const [from, setFrom] = useState<"wallet" | "inner">("wallet");
  const amount = parseAmount(input, config.wnear.decimals);
  const quoteAmount = useDebounced(amount, 350);
  const quote = useQuoteSell(scenario.scenarioId, quoteAmount, selected);
  const proceeds = quote.data;
  const plan = useSalePlan(scenario, selected, quoteAmount, proceeds, orders, wallet.accountId, nowSec);
  const tiers = useLendingTiers(toLending ? scenario.scenarioId : undefined, wallet.accountId);
  const remembered = useCollateralTier(`${CONTRACT_ID}:${scenario.scenarioId}`);
  const tier = sellTier(remembered.tier, tiers.data);
  const tierFrozen = Boolean(tiers.data?.find((t) => t.tier === tier)?.market.frozen);

  const innerWnear = balances?.innerWnear ?? 0n;
  const source = from === "inner" && innerWnear > 0n ? "inner" : "wallet";
  const available = source === "inner" ? innerWnear : (balances?.wnear ?? 0n);
  const possible = scenario.worlds.filter((w) => w.possible);
  const sold = possible.filter((w) => (selected & w.mask) !== 0);
  const quoteFresh = proceeds !== undefined && quoteAmount === amount;

  let blocker: string | undefined;
  if (scenario.halted) blocker = "Trading pauses while a resolution is pending";
  else if (sold.length === 0) blocker = "Tap the worlds you fear on the grid";
  else if (amount === undefined) blocker = "Enter an amount of NEAR";
  else if (amount > available) blocker = "Not enough wNEAR in this wallet";
  else if (!quoteFresh || !plan.ready) blocker = "Getting prices…";
  else if (sold.some((w) => !plan.plans[w.index]?.total)) blocker = "No price in one of the worlds";
  else if (toLending && tierFrozen) blocker = `The ${TIER_LABEL[tier]} tier is frozen: pick another tier`;

  async function run(): Promise<string> {
    const plans = planFills(plan.plans);
    const minOut = planMinOut(plan.plans);
    const p = { scenarioId: scenario.scenarioId, sellMask: selected, plans, minOut, toLending, tier };
    try {
      if (source === "inner") return await submit(sellFromInner(CONTRACT_ID, { ...p, amount: amount! }));
      const tokens = toTokenFloor(amount!, config.wnear.decimals);
      return await submit(sellFromWallet(config.wnear.tokenId, CONTRACT_ID, tokens, p), tokens);
    } catch (e) {
      // An order may have been taken first: refetch the book so the next attempt plans again.
      void qc.invalidateQueries({ queryKey: ["trade"] });
      throw e;
    }
  }

  return (
    <div className="flex flex-col gap-5" data-demo="sell-panel">
      {heading && (
        <SheetTitle sub="Your NEAR is split into one piece per world. The pieces in the worlds you pick are sold for dollars in those worlds; everywhere else you keep the NEAR. One transaction.">
          Sell in the worlds you fear
        </SheetTitle>
      )}
      {!heading && (
        <p className="text-[13px] leading-relaxed text-mute">
          Your NEAR is split into one piece per world. The pieces in the worlds you pick are sold for dollars in those
          worlds; everywhere else you keep the NEAR. One transaction.
        </p>
      )}

      {picker && (
        <Band>
          <div className="text-[13px] font-semibold text-ink">Pick the worlds you fear</div>
          <WorldPicker scenario={scenario} events={events} selected={selected} onToggle={onToggle} />
        </Band>
      )}

      {innerWnear > 0n && (
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-ink">From</span>
          <Segmented
            size="sm"
            value={source}
            onChange={setFrom}
            options={[
              { value: "wallet", label: `Wallet · ${fmtNear(balances?.wnear ?? 0n)}`, demo: "sell-from-wallet" },
              { value: "inner", label: `${BRAND.innerBalance} · ${fmtNear(innerWnear)}`, demo: "sell-from-inner" },
            ]}
          />
        </div>
      )}

      <AmountField
        label="Amount of NEAR"
        value={input}
        onChange={setInput}
        unit="wNEAR"
        ariaLabel="Amount of NEAR to split"
        demo="sell-amount"
        right={
          wallet.accountId ? (
            <InlineButton onClick={() => setInput(inputText(available, 2))} data-demo="sell-wallet">
              wallet: {fmtNear(available)} wNEAR
            </InlineButton>
          ) : undefined
        }
      />

      <div className="flex flex-col" data-demo="sell-preview">
        <div className="flex items-baseline justify-between border-b border-line pb-2">
          <span className="label text-mute">World</span>
          <span className="label text-mute">You get</span>
        </div>
        <ul className="flex flex-col">
          {possible.map((w) => {
            const isSold = (selected & w.mask) !== 0;
            const worldPlan = quoteFresh && plan.ready ? plan.plans[w.index] : undefined;
            const out = worldPlan?.total;
            const got = out !== undefined && amount ? (out * ONE) / amount : undefined;
            const cost = got !== undefined ? (w.wnearPrice > got ? w.wnearPrice - got : 0n) : undefined;
            return (
              <li key={w.mask} className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0" data-demo="sell-row" data-world={w.label}>
                <div className="flex items-center gap-3">
                  <WorldGlyph world={w} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold text-ink">{w.label}</div>
                    <div className="truncate text-[12px] text-mute">
                      {isSold ? via(worldPlan) : "keep → "}
                      <span className="num text-ink">
                        {isSold ? (out !== undefined ? `${fmt(out)} USDC` : "…") : amount ? `${fmtNear(amount)} NEAR` : "—"}
                      </span>
                    </div>
                  </div>
                  <div className="num shrink-0 text-right text-[15px] text-ink">
                    {isSold ? (got !== undefined ? fmtPrice(got) : "…") : <span className="text-[12px] text-mute">keeps NEAR</span>}
                  </div>
                </div>
                {isSold && (
                  <div className="grid grid-cols-3 gap-2 text-[11px] sm:ml-12">
                    <Mini label="Fair price" value={fmtPrice(w.wnearPrice)} />
                    <Mini label="You get" value={got !== undefined ? fmtPrice(got) : "—"} />
                    <Mini label="Cost / NEAR" value={cost !== undefined ? fmtPrice(cost) : "—"} tone="text-warn" />
                  </div>
                )}
                {isSold && worldPlan && worldPlan.fills.length > 0 && <PlanLegs plan={worldPlan} />}
              </li>
            );
          })}
        </ul>
      </div>

      <p className="text-[12px] leading-relaxed text-mute">
        Fair price is the pool price before your trade; the cost per NEAR is what this insurance costs you in that world
        (fee plus price impact). Resting bids fill first when they pay more than the pool would for that part of the
        sale. Each world must pay at least its plan, less 0.5% on the pool part, or nothing happens.
      </p>

      {lendable !== false && (
        <label className="flex cursor-pointer items-start gap-3 rounded-[16px] bg-tile p-3.5 text-[13px] leading-snug text-ink">
          <input
            type="checkbox"
            checked={toLending}
            onChange={(e) => setToLending(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-[var(--color-ink)]"
            data-demo="sell-to-lending"
          />
          <span>
            Keep the result as loan collateral in the {TIER_LABEL[tier]} tier, so you can borrow real USDC against it next
            (Borrow screen). Off: the tokens go to your wallet.
          </span>
        </label>
      )}
      {toLending && <TierSelect tiers={tiers.data} value={tier} onChange={remembered.setTier} />}

      <TxButton
        demo="sell-confirm"
        action={toLending ? "sell_to_collateral" : "sell"}
        label={`Sell in ${sold.length} world${sold.length === 1 ? "" : "s"}`}
        busyLabel="Selling…"
        connectText="Connect a wallet to sell"
        blocker={blocker}
        needs={{ contract: true }}
        run={run}
        onDone={onClear}
      />
    </div>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-[10px] bg-tile px-2 py-1.5">
      <span className="label text-[10px] text-mute">{label}</span>
      <span className={`num truncate text-[13px] ${tone ?? "text-ink"}`}>{value}</span>
    </div>
  );
}

/**
 * The plan in one world: the bids it fills, best first, then what goes to the pool. Full width on a phone, so a leg
 * like "bid #16 · 1,000.00 NEAR @ $2.4500" fits at 390 px; if it ever does not, it wraps between its parts instead of
 * being cut off.
 */
function PlanLegs({ plan }: { plan: WorldPlan }) {
  return (
    <ul className="num flex flex-col gap-1 rounded-[12px] bg-tile px-3 py-2 text-[12px] text-mute sm:ml-12" data-demo="plan-legs">
      {plan.fills.map((f) => (
        <li key={String(f.order.id)} className="flex items-baseline justify-between gap-2">
          <span className="min-w-0">
            <span className="font-semibold whitespace-nowrap text-pos">bid #{String(f.order.id)}</span> ·{" "}
            <span className="whitespace-nowrap">
              {fmtNear(f.amount)} NEAR @ {fmtPrice(f.order.price)}
            </span>
          </span>
          <span className="shrink-0 text-ink">{fmt(f.out)} USDC</span>
        </li>
      ))}
      {plan.poolAmount > 0n && (
        <li className="flex items-baseline justify-between gap-2">
          <span className="min-w-0">pool · {fmtNear(plan.poolAmount)} NEAR</span>
          <span className="shrink-0 text-ink">{fmt(plan.poolOut)} USDC</span>
        </li>
      )}
    </ul>
  );
}
