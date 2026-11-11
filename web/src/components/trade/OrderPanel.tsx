"use client";

import { useState } from "react";
import { IconClose } from "@/components/brand/Icons";
import { Segmented } from "@/components/ui/Bits";
import { SmallField } from "@/components/ui/Field";
import { Band, SheetTitle } from "@/components/ui/Surface";
import { TxButton } from "@/components/ui/TxButton";
import { WorldPicker } from "@/components/world/WorldGrid";
import { CONTRACT_ID } from "@/lib/data/client";
import { txUrl } from "@/lib/env";
import type { AppConfig, EventState, Scenario, World } from "@/lib/domain";
import { accountLabel, fmt, fmtUsd, fmtWeth, inputText, parseAmount } from "@/lib/format";
import type { Balances } from "@/lib/hooks/useData";
import { useSubmit } from "@/lib/hooks/useTx";
import { call, ftTransferCall, singleOrderPlan } from "@/lib/near/tx";
import { useWallet } from "@/lib/near/wallet";
import { cellBook, closedReason, cost, proceeds, type Order, type Side } from "@/lib/orders";
import { scaleOf, toTokenCeil } from "@/lib/units";

const ONE = 10n ** 18n;
const TOP = 5;
const LIVES = [
  { label: "1 hour", seconds: 3_600n },
  { label: "1 day", seconds: 86_400n },
  { label: "7 days", seconds: 604_800n },
] as const;

type Common = {
  config: AppConfig;
  scenario: Scenario;
  balances?: Balances;
};

type Props = Common & {
  events: readonly EventState[];
  orders: readonly Order[];
  /** Chain time of the last snapshot and the wall clock, for expiries and open/closed checks. */
  chainNow: bigint;
  wallNow: bigint;
  /** The world whose book is open (a single-world mask), 0 for none. */
  mask: number;
  onOpen: (mask: number) => void;
  picker: boolean;
  heading?: boolean;
  /** Open the best ask's accept box (or the bid form) on arrival: "Back" from the home screen. */
  intent?: "buy";
};

/** One world's order book: the best bids and asks around the pool price; post, accept and cancel. */
export function OrderPanel({ config, scenario, events, orders, chainNow, wallNow, balances, mask, onOpen, picker, heading = true, intent }: Props) {
  const wallet = useWallet();
  const world = scenario.worlds.find((w) => w.mask === mask);
  const state = { scenarioId: scenario.scenarioId, possible: scenario.possible, resolutionCount: scenario.resolutionCount };
  const book = cellBook(orders, state, mask, wallNow);
  const me = wallet.accountId?.toLowerCase();
  const bestAskOther = book.asks.find((o) => o.maker.toLowerCase() !== me);
  // Accepting is per world: switching worlds closes the box. Arriving to buy ("Back", "Buy here") opens the best
  // ask of whichever world's book is open, until the box is closed.
  const [taking, setTaking] = useState<{ mask: number; id: bigint | null }>();
  // The accept box closes once its trade lands, so the outcome is shown under the ladder instead.
  const [traded, setTraded] = useState<{ mask: number; hash: string }>();
  const chosen = taking && taking.mask === mask ? taking.id : undefined;
  const takingId = chosen === undefined ? (intent === "buy" ? bestAskOther?.id : undefined) : (chosen ?? undefined);

  const pickerBlock = picker && (
    <Band>
      <div className="text-[13px] font-semibold text-ink">Pick a world to open its book</div>
      <WorldPicker scenario={scenario} events={events} selected={mask} onToggle={(m) => onOpen(m === mask ? 0 : m)} demo="book-pick" />
    </Band>
  );

  if (!config.orderBook) {
    return (
      <div className="flex flex-col gap-4" data-demo="order-panel">
        {heading && <SheetTitle>Order book</SheetTitle>}
        <p className="text-[13px] text-mute">The order book is not live on this deployment yet.</p>
      </div>
    );
  }
  if (!world) {
    return (
      <div className="flex flex-col gap-4" data-demo="order-panel">
        {heading && <SheetTitle>Order book</SheetTitle>}
        {pickerBlock}
        <p className="text-[13px] text-mute">Tap a world on the grid to open its book.</p>
      </div>
    );
  }

  const mine = orders.filter(
    (o) => o.scenarioId === scenario.scenarioId && o.mask === mask && o.maker.toLowerCase() === me && o.remaining > 0n,
  );
  const takingOrder = takingId === undefined ? undefined : [...book.bids, ...book.asks].find((o) => o.id === takingId);

  return (
    <div className="flex flex-col gap-5" data-demo="order-panel">
      {heading && <SheetTitle>{`Order book · ${world.label}`}</SheetTitle>}
      {pickerBlock}
      <p className="text-[13px] leading-relaxed text-mute">
        Bids and asks for ETH in this world, priced in this world&apos;s dollars. A trade happens only when someone takes
        an order; a counter-offer is a new order. Orders end when an event resolves.
      </p>
      <Ladder world={world} bids={book.bids} asks={book.asks} me={me} taking={takingOrder?.id} onTake={(id) => setTaking({ mask, id })} />
      {takingOrder && (
        <AcceptBox
          key={String(takingOrder.id)}
          config={config}
          scenario={scenario}
          balances={balances}
          world={world}
          order={takingOrder}
          onClose={() => setTaking({ mask, id: null })}
          onTraded={(hash) => setTraded({ mask, hash })}
        />
      )}
      {!takingOrder && traded?.mask === mask && (
        <p role="status" className="num text-[12px] text-pos" data-demo="accept-confirm-result">
          <a href={txUrl(traded.hash)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
            Done · {traded.hash.slice(0, 10)}…
          </a>
        </p>
      )}
      <PostForm
        key={`${mask}:${intent ?? ""}`}
        config={config}
        scenario={scenario}
        balances={balances}
        world={world}
        chainNow={chainNow}
        wallNow={wallNow}
        bestBid={book.bids.find((o) => o.maker.toLowerCase() !== me)}
        bestAsk={bestAskOther}
        onTake={(id) => setTaking({ mask, id })}
      />
      {mine.length > 0 && <MyOrders scenario={scenario} orders={mine} wallNow={wallNow} />}
    </div>
  );
}

/** Top asks above the pool price, top bids below it: the best of each side sits next to the pool line. */
function Ladder({
  world,
  bids,
  asks,
  me,
  taking,
  onTake,
}: {
  world: World;
  bids: Order[];
  asks: Order[];
  me: string | undefined;
  taking: bigint | undefined;
  onTake: (id: bigint) => void;
}) {
  const topAsks = asks.slice(0, TOP).reverse();
  const topBids = bids.slice(0, TOP);
  const row = (o: Order) => {
    const own = o.maker.toLowerCase() === me;
    return (
      <tr key={String(o.id)} className={`border-t border-line ${taking === o.id ? "bg-tile" : ""}`} data-demo="ladder-row" data-side={o.side}>
        <td className={`num py-2 pr-2 pl-3 text-[14px] ${o.side === "bid" ? "text-pos" : "text-neg"}`}>{fmtUsd(o.price)}</td>
        <td className="num px-2 py-2 text-right text-[13px] text-ink">{fmtWeth(o.remaining)}</td>
        <td className="px-2 py-1.5 text-[12px] leading-tight text-mute" title={o.maker}>
          <span className="num block">#{String(o.id)}</span>
          <span className="block truncate text-[11px]">{own ? "you" : accountLabel(o.maker)}</span>
        </td>
        <td className="py-1 pr-1.5 pl-1 text-right">
          {!own && (
            <button
              type="button"
              onClick={() => onTake(o.id)}
              data-demo="accept"
              className="focus-ring min-h-9 rounded-full px-3 text-[12px] font-semibold text-cobalt-ink hover:bg-cobalt/10"
            >
              Accept
            </button>
          )}
        </td>
      </tr>
    );
  };
  return (
    <div className="overflow-hidden rounded-[18px] border border-line" data-demo="ladder">
      <table className="w-full table-fixed text-left">
        <colgroup>
          <col className="w-[29%]" />
          <col className="w-[19%]" />
          <col />
          <col className="w-[76px]" />
        </colgroup>
        <thead className="bg-tile">
          <tr>
            <th className="label py-2 pr-2 pl-3 font-medium text-mute">Price</th>
            <th className="label px-2 py-2 text-right font-medium text-mute">ETH</th>
            <th className="label px-2 py-2 font-medium text-mute">Order</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {topAsks.length === 0 ? <EmptyRow text="no asks" /> : topAsks.map(row)}
          <tr className="border-t border-line bg-cobalt/8" data-demo="ladder-pool">
            <td className="num py-2 pr-2 pl-3 text-[14px] font-semibold text-cobalt-ink">{world.poolInitialized ? fmtUsd(world.wethPrice) : "—"}</td>
            <td colSpan={3} className="px-2 py-2 text-[12px] text-mute">
              pool price
            </td>
          </tr>
          {topBids.length === 0 ? <EmptyRow text="no bids" /> : topBids.map(row)}
        </tbody>
      </table>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <tr className="border-t border-line">
      <td colSpan={4} className="py-2 pl-3 text-[12px] text-mute">
        {text}
      </td>
    </tr>
  );
}

/** Take an order from real WETH or USDC in one transaction: a sale into a bid, or a buy from an ask. */
function AcceptBox({
  config,
  scenario,
  balances,
  world,
  order,
  onClose,
  onTraded,
}: Common & { world: World; order: Order; onClose: () => void; onTraded: (hash: string) => void }) {
  const submit = useSubmit();
  const sell = order.side === "bid"; // taking a bid sells ETH-if-w
  const wallWeth = balances?.weth ?? 0n;
  const wallUsdc = balances?.usdc ?? 0n;
  const affordable = sell ? wallWeth : (wallUsdc * ONE) / order.price;
  const start = order.remaining < affordable ? order.remaining : affordable;
  const [input, setInput] = useState(inputText(start, 4));
  const amount = parseAmount(input, config.weth.decimals);
  const usdc = amount === undefined ? undefined : sell ? proceeds(amount, order.price) : cost(amount, order.price);

  let blocker: string | undefined;
  if (scenario.halted) blocker = "Paused while a resolution is pending";
  else if (amount === undefined) blocker = "Enter an amount of ETH";
  else if (amount > order.remaining) blocker = "More than the order has left";
  else if (sell && amount > wallWeth) blocker = "Not enough WETH in this wallet";
  else if (!sell && usdc! > wallUsdc) blocker = "Not enough USDC in this wallet";
  else if (usdc === 0n) blocker = "Too small to pay anything";

  async function run(step: (s: string) => void): Promise<string> {
    const n = scenario.worldCount;
    step(sell ? "Selling into the bid…" : "Buying from the ask…");
    if (sell) {
      const tokens = amount! / scaleOf(config.weth.decimals);
      const p = singleOrderPlan(n, world.index, order.id, amount!, usdc!);
      return submit(
        ftTransferCall(config.weth.tokenId, CONTRACT_ID, tokens, {
          action: "conditional_sell",
          scenario_id: scenario.scenarioId,
          sell_mask: world.mask,
          plans: p.plans,
          min_out: p.min_out,
          to_lending: false,
        }),
        tokens,
      );
    }
    // The cost is rounded up to whole USDC units on the way in; the sub-unit remainder stays as internal dust.
    const tokens = toTokenCeil(usdc!, config.usdc.decimals);
    const p = singleOrderPlan(n, world.index, order.id, amount!, amount!);
    return submit(
      ftTransferCall(config.usdc.tokenId, CONTRACT_ID, tokens, {
        action: "conditional_buy",
        scenario_id: scenario.scenarioId,
        buy_mask: world.mask,
        plans: p.plans,
        min_out: p.min_out,
        to_lending: false,
      }),
      tokens,
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-[20px] border border-cobalt/35 bg-cobalt/5 p-4" data-demo="accept-box">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[14px] font-semibold text-ink">
          {sell ? "Sell into" : "Buy from"} {sell ? "bid" : "ask"} #{String(order.id)} at <span className="num">{fmtUsd(order.price)}</span>
        </span>
        <button type="button" onClick={onClose} aria-label="Close" className="focus-ring -mt-1 -mr-1 grid size-9 place-items-center rounded-full text-mute hover:bg-sheet hover:text-ink">
          <IconClose size={18} />
        </button>
      </div>
      <SmallField label="ETH" ariaLabel="Amount of ETH to trade with this order" value={input} onChange={setInput} demo="accept-amount" />
      {amount !== undefined && usdc !== undefined && (
        <p className="num text-[12px] leading-relaxed text-mute">
          {sell
            ? `Pay ${fmtWeth(amount)} WETH; get ${fmt(usdc)} USDC-if-${world.label} and keep ${fmtWeth(amount)} WETH in every other world.`
            : `Pay ${fmt(usdc)} USDC; get ${fmtWeth(amount)} WETH-if-${world.label} and keep ${fmt(usdc)} USDC in every other world.`}
        </p>
      )}
      <TxButton
        demo="accept-confirm"
        label="Confirm"
        busyLabel="Confirming…"
        blocker={blocker}
        needs={{ contract: true }}
        run={async (step) => {
          const hash = await run(step);
          onTraded(hash);
          return hash;
        }}
        onDone={onClose}
      />
    </div>
  );
}

/** Post a bid or ask from real USDC or WETH; the contract splits it and escrows this world's piece in the book. */
function PostForm({
  config,
  scenario,
  balances,
  world,
  chainNow,
  wallNow,
  bestBid,
  bestAsk,
  onTake,
}: Common & {
  world: World;
  chainNow: bigint;
  wallNow: bigint;
  bestBid: Order | undefined;
  bestAsk: Order | undefined;
  onTake: (id: bigint) => void;
}) {
  const submit = useSubmit();
  const [side, setSide] = useState<Side>("bid");
  const [priceInput, setPriceInput] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [life, setLife] = useState(1);
  const price = parseAmount(priceInput, 18);
  const amount = parseAmount(amountInput, config.weth.decimals);
  const bid = side === "bid";
  const escrow = price !== undefined && amount !== undefined ? (bid ? cost(amount, price) : amount) : undefined;
  const crossing =
    price === undefined ? undefined : bid ? (bestAsk && price >= bestAsk.price ? bestAsk : undefined) : bestBid && price <= bestBid.price ? bestBid : undefined;
  const pool = world.poolInitialized ? world.wethPrice : undefined;
  const throughPool = price !== undefined && pool !== undefined && (bid ? price > pool : price < pool);
  const wallUsdc = balances?.usdc ?? 0n;
  const wallWeth = balances?.weth ?? 0n;

  let blocker: string | undefined;
  if (scenario.halted) blocker = "Paused while a resolution is pending";
  else if (price === undefined) blocker = "Enter a price";
  else if (amount === undefined) blocker = "Enter an amount of ETH";
  else if (bid && escrow! > wallUsdc) blocker = "Not enough USDC in this wallet";
  else if (!bid && escrow! > wallWeth) blocker = "Not enough WETH in this wallet";

  async function run(step: (s: string) => void): Promise<string> {
    // The order lives from now (chain time or the wall clock, whichever is later) for the chosen period.
    const start = chainNow > wallNow ? chainNow : wallNow;
    const expiry = Number(start + LIVES[life].seconds);
    step(bid ? "Posting the bid…" : "Posting the ask…");
    const msg = {
      action: "post_order" as const,
      scenario_id: scenario.scenarioId,
      mask: world.mask,
      side,
      price: price!.toString(),
      amount: amount!.toString(),
      expiry_sec: expiry,
    };
    if (bid) {
      const tokens = toTokenCeil(escrow!, config.usdc.decimals);
      return submit(ftTransferCall(config.usdc.tokenId, CONTRACT_ID, tokens, msg), tokens);
    }
    const tokens = amount! / scaleOf(config.weth.decimals);
    return submit(ftTransferCall(config.weth.tokenId, CONTRACT_ID, tokens, msg), tokens);
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4" data-demo="post-form">
      <Segmented
        value={side}
        onChange={setSide}
        size="sm"
        options={[
          { value: "bid", label: "Post bid", demo: "post-bid-tab" },
          { value: "ask", label: "Post ask", demo: "post-ask-tab" },
        ]}
      />
      <div className="grid grid-cols-2 gap-2">
        <SmallField label="Price (USDC per ETH)" value={priceInput} onChange={setPriceInput} demo="post-price" />
        <SmallField label="Amount (ETH)" value={amountInput} onChange={setAmountInput} demo="post-amount" />
      </div>
      <label className="flex items-center justify-between gap-2 text-[13px] text-mute">
        <span>Good for</span>
        <select
          value={life}
          onChange={(e) => setLife(Number(e.target.value))}
          className="focus-ring h-10 rounded-full border border-line-strong bg-sheet px-3 text-[13px] text-ink"
          data-demo="post-life"
        >
          {LIVES.map((l, i) => (
            <option key={l.label} value={i}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      {escrow !== undefined && (
        <p className="num text-[12px] leading-relaxed text-mute">
          {bid
            ? `Locks ${fmt(escrow)} USDC-if-${world.label} from ${fmt(escrow)} real USDC; you keep ${fmt(escrow)} USDC in every other world. Cancel any time to get it back.`
            : `Locks ${fmtWeth(escrow)} WETH-if-${world.label} from ${fmtWeth(escrow)} real WETH; you keep ${fmtWeth(escrow)} WETH in every other world. Cancel any time to get it back.`}
        </p>
      )}
      {crossing && (
        <div className="flex items-center justify-between gap-3 rounded-[14px] border border-neg/30 bg-neg-bright/6 px-3 py-2 text-[12px] text-ink" role="alert">
          <span>
            This {bid ? "bid" : "ask"} crosses {bid ? "ask" : "bid"} #{String(crossing.id)} at <span className="num">{fmtUsd(crossing.price)}</span>, which is
            already there.
          </span>
          <button type="button" onClick={() => onTake(crossing.id)} className="focus-ring min-h-9 shrink-0 rounded-full px-2 font-semibold text-cobalt-ink hover:underline">
            Accept it instead
          </button>
        </div>
      )}
      {throughPool && !crossing && (
        <p className="text-[12px] text-mute">
          {bid ? "Above" : "Below"} the pool price ({fmtUsd(pool!)}): anyone can {bid ? "sell into" : "buy"} this at once through the pool.
        </p>
      )}
      <TxButton
        demo={bid ? "post-bid" : "post-ask"}
        tone="secondary"
        label={bid ? "Post bid" : "Post ask"}
        busyLabel="Posting…"
        blocker={blocker}
        needs={{ contract: true }}
        run={run}
        onDone={() => setAmountInput("")}
      />
      <p className="num text-[12px] text-mute">
        wallet {fmt(wallUsdc)} USDC · {fmtWeth(wallWeth)} WETH
      </p>
    </div>
  );
}

/** The account's orders in this world that still hold escrow, including ones that can no longer fill. */
function MyOrders({ scenario, orders, wallNow }: { scenario: Scenario; orders: Order[]; wallNow: bigint }) {
  const submit = useSubmit();
  const state = { scenarioId: scenario.scenarioId, possible: scenario.possible, resolutionCount: scenario.resolutionCount };
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4" data-demo="my-orders">
      <div className="label text-mute">Your orders here</div>
      {orders.map((o) => {
        const reason = closedReason(o, state, wallNow);
        return (
          <div key={String(o.id)} className="flex flex-col gap-2 rounded-[16px] bg-tile p-3">
            <div className="num flex flex-wrap justify-between gap-x-3 gap-y-1 text-[13px]">
              <span className="text-ink">
                #{String(o.id)} {o.side} {fmtUsd(o.price)}
              </span>
              <span className="text-mute">
                {fmtWeth(o.remaining)} of {fmtWeth(o.amount)} ETH left{reason ? ` · ${reason}` : ""}
              </span>
            </div>
            <TxButton
              size="md"
              tone="secondary"
              demo="cancel-order"
              label={reason ? "Cancel and take the escrow back" : "Cancel"}
              busyLabel="Cancelling…"
              needs={{ contract: true }}
              run={() => submit(call(CONTRACT_ID, "cancel_order", { order_id: o.id.toString() }))}
            />
          </div>
        );
      })}
    </div>
  );
}
