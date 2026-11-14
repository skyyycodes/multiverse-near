"use client";

// The one door between the redesign's views and the chain. Views import from here (and from the pure helpers this
// re-exports), never from decode.ts or the RPC directly:
//   useMarkets()            every listed market as the board draws it
//   useMarket(id)           one market (the /market/?id=N page)
//   usePosition(id, tier?)  what the connected account holds there: per-world pieces, collateral, debt, health
//   useActions()            typed functions that build web's transactions, send them through the wallet and report
//                           pending → done (explorer link) / failed (plain words) through the Toaster
// plus small reads the shell needs (balances, owner, the account's markets). INTEGRATION.md lists the whole API.
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { CONTRACT_ID, readSource } from "./data/client";
import { decodeBorrow, decodeEventMeta, decodeMarketCardOrNull } from "./decode";
import type { AppConfig, EventMeta, EventState, Tier } from "./domain";
import { txUrl } from "./env";
import { errorLine } from "./errors";
import { capOf, faucetMints, mintLabel, mintTx, type FaucetConfig } from "./faucet";
import { cost } from "./orders";
import { useNowSeconds } from "./hooks/useClock";
import { appConfigQuery, POLL_MS, useAppConfig, useBalances, keepWithin } from "./hooks/useData";
import { fetchLendingTiers } from "./hooks/useLending";
import { useEventTexts, useMarketList, useMarketsOf } from "./hooks/useMarkets";
import { useAccountInfo, usePauseState } from "./hooks/useOps";
import { registerTx, useEnsureRegistered, useSubmit, type Needs } from "./hooks/useTx";
import { eventIdsOf } from "./market";
import {
  borrow as borrowTx,
  cancelOrder as cancelOrderTx,
  depositCollateral as depositCollateralTx,
  dispute as disputeTx,
  finalize as finalizeTx,
  ftTransferCall,
  GAS_FT_ROUTINE,
  gasFloat,
  merge as mergeTx,
  ONE_YOCTO,
  planFills,
  planMinOut,
  redeem as redeemTx,
  repay as repayTx,
  sellFromInner,
  sellFromWallet,
  singleOrderPlan,
  split as splitTx,
  storageWithdraw as storageWithdrawTx,
  supply as supplyTx,
  withdrawCollateral as withdrawCollateralTx,
  withdrawSupply as withdrawSupplyTx,
  type Tx,
} from "./near/tx";
import { TxError, type TxOutcome } from "./near/outcome";
import { useWallet } from "./near/wallet";
import type { WorldPlan, Order, Side } from "./orders";
import { pauseBlocker, type AppAction } from "./pause";
import { repayAllSend } from "./lending";
import { singleWorldMasks, rootMask } from "./split";
import { txToast, type ToastKind } from "./toasts";
import type { Asset, BorrowViewJson, EventMetaJson, MarketCardJson, StorageBalance, StorageBounds } from "./types";
import { toInternal, toTokenCeil, toTokenFloor } from "./units";
import { chainMarket, positionOf, toNum, type ChainMarket, type Position } from "./adapter-model";

export * from "./adapter-model";

const view = async <T>(method: string, args: Record<string, unknown> = {}, contractId = CONTRACT_ID): Promise<T> =>
  (await readSource()).view<T>(contractId, method, args);

/** A market id from the URL or a prop: a positive integer, else undefined. */
export function marketId(id: number | string | null | undefined): number | undefined {
  if (typeof id === "number") return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  if (typeof id !== "string" || !/^[1-9]\d*$/.test(id)) return undefined;
  const n = Number(id);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** `event_meta` of each event (source, category), texts that never change; a missing one reads as null. */
export function useEventMetas(ids: readonly number[]) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  return useQuery({
    queryKey: ["eventMetas", CONTRACT_ID, sorted.join(",")],
    enabled: sorted.length > 0,
    queryFn: async (): Promise<Map<number, EventMeta | null>> => {
      const rows = await Promise.all(
        sorted.map((id) =>
          view<EventMetaJson | null>("event_meta", { event_id: id })
            .then((m) => decodeEventMeta(m))
            .catch(() => null),
        ),
      );
      return new Map(sorted.map((id, i) => [id, rows[i]]));
    },
    staleTime: 300_000,
    placeholderData: (prev) => prev,
  });
}

export type MarketsResult = {
  /** Undefined while the first read is on its way. */
  markets: ChainMarket[] | undefined;
  isLoading: boolean;
  error: Error | null;
};

/** Every listed market (registry order, at most 120), each once its events' texts have loaded; every 20 s. */
export function useMarkets(opts: { listedOnly?: boolean } = {}): MarketsResult {
  const list = useMarketList(opts.listedOnly ?? true);
  const ids = eventIdsOf(list.data ?? []);
  const texts = useEventTexts(ids);
  const metas = useEventMetas(ids);
  const markets = useMemo(() => {
    if (!list.data) return undefined;
    if (ids.length > 0 && !texts.data) return undefined;
    const t = texts.data ?? new Map<number, EventState>();
    return list.data.map((c) => chainMarket(c, t, metas.data)).filter((m): m is ChainMarket => m !== undefined);
  }, [list.data, ids.length, texts.data, metas.data]);
  return { markets, isLoading: list.isLoading || (ids.length > 0 && texts.isLoading), error: list.error ?? texts.error ?? null };
}

export type MarketResult = {
  market: ChainMarket | undefined;
  isLoading: boolean;
  /** The id is not a market on this contract (or not an id at all). */
  notFound: boolean;
  error: Error | null;
};

/** One market by id (`get_market`, listed or not), every 15 s. */
export function useMarket(id: number | string | null | undefined): MarketResult {
  const sid = marketId(id);
  const card = useQuery({
    queryKey: ["market", CONTRACT_ID, String(sid)],
    enabled: sid !== undefined,
    queryFn: async () => decodeMarketCardOrNull(await view<MarketCardJson | null>("get_market", { scenario_id: sid })),
    refetchInterval: 15_000,
    retry: 1,
  });
  const ids = card.data?.eventIds ?? [];
  const texts = useEventTexts(ids);
  const metas = useEventMetas(ids);
  const market = useMemo(
    () => (card.data && texts.data ? chainMarket(card.data, texts.data, metas.data) : undefined),
    [card.data, texts.data, metas.data],
  );
  return {
    market,
    isLoading: sid !== undefined && (card.isLoading || (ids.length > 0 && texts.isLoading)),
    notFound: sid === undefined || card.data === null,
    error: card.error ?? texts.error ?? null,
  };
}

export type PositionResult = {
  /** Undefined while loading or without a market id. With no wallet connected every amount is zero. */
  position: Position | undefined;
  isLoading: boolean;
  error: Error | null;
};

/** What the connected account holds in a market, for one lending tier (Normal by default); every 8 s. */
export function usePosition(id: number | string | null | undefined, tier: Tier = "normal"): PositionResult {
  const sid = marketId(id);
  const { accountId } = useWallet();
  const q = useQuery({
    queryKey: ["borrow", CONTRACT_ID, String(sid), accountId ?? "", tier],
    enabled: sid !== undefined,
    queryFn: async () =>
      decodeBorrow(await view<BorrowViewJson>("borrow_view", tier === "normal" ? { scenario_id: sid, account_id: accountId } : { scenario_id: sid, account_id: accountId, tier })),
    refetchInterval: POLL_MS,
    placeholderData: keepWithin(sid, tier),
  });
  const position = useMemo(() => (q.data ? positionOf(q.data, tier) : undefined), [q.data, tier]);
  return { position, isLoading: q.isLoading, error: q.error };
}

export type WalletBalances = {
  /** wNEAR and USDC in the wallet (outside IfVerse). */
  near: number;
  usdc: number;
  nearWad: bigint;
  usdcWad: bigint;
  /** Real tokens the contract holds for the account (refunds, dust), 18-decimal. */
  innerNearWad: bigint;
  innerUsdcWad: bigint;
};

/** The connected wallet's wNEAR and USDC (undefined while loading or disconnected); every 8 s. */
export function useWalletBalances(): WalletBalances | undefined {
  const { accountId } = useWallet();
  const cfg = useAppConfig().data;
  const b = useBalances(accountId, cfg?.wnear, cfg?.usdc).data;
  return useMemo(
    () =>
      b && accountId
        ? { near: toNum(b.wnear), usdc: toNum(b.usdc), nearWad: b.wnear, usdcWad: b.usdc, innerNearWad: b.innerWnear, innerUsdcWad: b.innerUsdc }
        : undefined,
    [b, accountId],
  );
}

/** Market ids the connected account holds anything in (`markets_of`); empty when disconnected. */
export function useMyMarkets(): number[] {
  const { accountId } = useWallet();
  return useMarketsOf(accountId).data ?? [];
}

export type LoanSummary = {
  /** Markets the account holds anything in. */
  markets: number;
  /** Loans open across those markets and their tiers. */
  loans: number;
  /** Total owed, USDC. */
  debt: number;
  /** The lowest health factor of any open loan; null without one. */
  lowest: number | null;
  /** USDC supplied to lending, every market and tier. */
  supplied: number;
};

/**
 * The account's lending at a glance (the wallet menu): `lending_tiers` of each market it holds anything in, every
 * 30 s. Undefined while loading or disconnected. Pass `enabled: false` to read nothing (a closed menu).
 */
export function useLoanSummary(enabled = true): LoanSummary | undefined {
  const { accountId } = useWallet();
  const mine = useMarketsOf(enabled ? accountId : null).data;
  const tiers = useQueries({
    queries: (enabled && accountId ? (mine ?? []) : []).map((sid) => ({
      queryKey: ["tiers", CONTRACT_ID, String(sid), accountId ?? ""],
      queryFn: () => fetchLendingTiers(sid, accountId),
      refetchInterval: 30_000,
      retry: 1,
    })),
  });
  if (!enabled || !accountId || !mine) return undefined;
  const accounts = tiers.flatMap((q) => (q.data ?? []).map((t) => t.account).filter((a) => a !== null));
  const open = accounts.filter((a) => a.debt > 0n);
  const hfs = open.map((a) => a.healthFactor).filter((h): h is bigint => h !== null);
  const lowest = hfs.length ? hfs.reduce((m, h) => (h < m ? h : m)) : null;
  return {
    markets: mine.length,
    loans: open.length,
    debt: toNum(open.reduce((t, a) => t + a.debt, 0n)),
    lowest: lowest === null ? null : toNum(lowest),
    supplied: toNum(accounts.reduce((t, a) => t + a.supplied, 0n)),
  };
}

/** True when the connected account owns the contract (the wallet menu and footer then show Admin). */
export function useIsOwner(): boolean {
  const { accountId } = useWallet();
  const cfg = useAppConfig().data;
  return Boolean(accountId && cfg && accountId === cfg.ownerId);
}

/**
 * Why an action cannot run right now, in the words a button shows, or undefined: a pause of that action, then too
 * little NEAR for its gas and deposit. Mirrors web's TxButton; the screen adds its own blockers (amount, balance) first.
 * Without a `gas`, the action is a routine one (150 Tgas, so about 0.16 NEAR free); the heavy ones pass GAS_MAX.
 */
export function useBlocker(action: AppAction, o: { gas?: string; deposit?: bigint | string } = {}): string | undefined {
  const { accountId } = useWallet();
  const pause = usePauseState();
  const now = useNowSeconds();
  const signer = useAccountInfo(accountId);
  if (!accountId) return undefined;
  const paused = pauseBlocker(action, pause.data, now);
  if (paused) return paused;
  const float = signer.data ? gasFloat(signer.data, o.gas ?? GAS_FT_ROUTINE, o.deposit ?? ONE_YOCTO) : undefined;
  return float?.short ? `You need at least ${float.needText} NEAR in your wallet for this action` : undefined;
}

/** How a transaction is announced: the toast's kind and title, what it says while pending and once done. */
export type Announce = { kind: ToastKind; title: string; pending: string; done: string; market?: number };

/**
 * `run`'s answer: the transaction hash (the last one, for a multi-step action), or the error in plain words. It never
 * throws: a failure is already in its toast.
 */
export type ActionResult = { ok: true; hash: string } | { ok: false; error: string };

type Step = (line: string) => void;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A market as the actions need it: its id and which worlds are still possible. */
export type MarketRef = Pick<ChainMarket, "sid" | "possible" | "worldCount">;

/**
 * Typed actions over web's transaction builders (near/tx.ts). Amounts are bigint in the contract's 18 decimals (parse
 * a typed amount with `parseAmount(input, token.decimals)`); prices too. Each action connects the wallet first when
 * none is, registers the account where the action needs it, sends, checks the outcome, refreshes every query and
 * reports through the Toaster. `busy` names the action in flight (for a button's label).
 */
export function useActions() {
  const wallet = useWallet();
  const config = useAppConfig().data;
  const ensure = useEnsureRegistered(config);
  const submit = useSubmit();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async (a: Announce, needs: Needs | undefined, go: (step: Step, cfg: AppConfig, account: string) => Promise<string>): Promise<ActionResult> => {
      if (!wallet.accountId) {
        await wallet.connect();
        return { ok: false, error: "Connect a wallet first." };
      }
      const t = txToast(a.kind, a.title, a.pending, a.market);
      setBusy(a.pending);
      try {
        // pressed before the contract's configuration arrived: read it now instead of doing nothing
        const cfg: AppConfig = config ?? (await qc.fetchQuery<AppConfig>(appConfigQuery));
        await ensure(needs, t.step, cfg);
        t.step(a.pending);
        const hash = await go(t.step, cfg, wallet.accountId);
        t.done(a.done, txUrl(hash));
        return { ok: true, hash };
      } catch (e) {
        const error = errorLine(errorText(e));
        // a transaction that landed and failed links to itself on the explorer
        t.failed(error, e instanceof TxError && e.hash ? txUrl(e.hash) : undefined);
        return { ok: false, error };
      } finally {
        setBusy(null);
      }
    },
    [wallet, config, ensure, qc],
  );

  return useMemo(() => {
    const token = (cfg: AppConfig, asset: Asset) => (asset === "wnear" ? cfg.wnear : cfg.usdc);
    const sym = (asset: Asset) => (asset === "wnear" ? "wNEAR" : "USDC");

    return {
      busy,
      /**
       * Any transaction, announced as told (admin, proposals, liquidations: anything without a typed wrapper below).
       * `onOutcome` reads the landed transaction (a new proposal's id, a pledge's result) before the toast says done.
       */
      send: (tx: Tx, a: Announce, o: { needs?: Needs; expectUsed?: bigint | "nonzero"; onOutcome?: (outcome: TxOutcome) => void } = {}) =>
        run(a, o.needs, () => submit(tx, o.expectUsed, o.onOutcome)),

      /** "Get test tokens": mint the drop of each mock token the wallet holds less of, then register with the contract. */
      faucet: () =>
        run({ kind: "wallet", title: "Test tokens", pending: "Getting test tokens…", done: "Test tokens are in your wallet" }, undefined, async (step, cfg, account) => {
          const src = await readSource();
          const [w, u, cw, cu, registered] = await Promise.all([
            src.view<string>(cfg.wnear.tokenId, "ft_balance_of", { account_id: account }),
            src.view<string>(cfg.usdc.tokenId, "ft_balance_of", { account_id: account }),
            src.view<FaucetConfig>(cfg.wnear.tokenId, "faucet_config").catch(() => undefined),
            src.view<FaucetConfig>(cfg.usdc.tokenId, "faucet_config").catch(() => undefined),
            src.view<StorageBalance | null>(CONTRACT_ID, "storage_balance_of", { account_id: account }),
          ]);
          const mints = faucetMints(cfg, { wnear: toInternal(BigInt(w), cfg.wnear.decimals), usdc: toInternal(BigInt(u), cfg.usdc.decimals) }, { wnear: capOf(cw), usdc: capOf(cu) });
          let hash: string | undefined;
          for (const m of mints) {
            step(`Minting ${mintLabel(m)}…`);
            hash = await submit(mintTx(m.tokenId, account, m.amount));
          }
          if (!registered) {
            const bounds = await src.view<StorageBounds>(CONTRACT_ID, "storage_balance_bounds");
            step("Registering with IfVerse…");
            hash = await submit(registerTx(bounds));
          }
          if (!hash) throw new Error("Nothing to do: your wallet already holds test tokens and is registered.");
          return hash;
        }),

      /** T44: real wNEAR or USDC into one piece in every world still possible. */
      split: (m: MarketRef, asset: Asset, amount: bigint) =>
        run({ kind: "trade", title: "Split", pending: `Splitting ${sym(asset)} into every world…`, done: `Split into ${singleWorldMasks(m.possible).length} worlds`, market: m.sid }, { contract: true }, (_s, cfg) => {
          const t = token(cfg, asset);
          const tokens = toTokenCeil(amount, t.decimals);
          return submit(splitTx(t.tokenId, CONTRACT_ID, tokens, { scenarioId: m.sid, toMasks: singleWorldMasks(m.possible) }), tokens);
        }),

      /** T45: a full set of single-world pieces back into the real token. */
      merge: (m: MarketRef, asset: Asset, amount: bigint) =>
        run({ kind: "trade", title: "Merge", pending: `Merging ${sym(asset)} back…`, done: `Merged back into real ${sym(asset)}`, market: m.sid }, { tokens: [asset] }, () =>
          submit(mergeTx(CONTRACT_ID, { scenarioId: m.sid, asset, fromMasks: singleWorldMasks(m.possible), toMask: rootMask(m.worldCount), amount })),
        ),

      /**
       * T1/T2: sell NEAR in the worlds of `mask` for USDC of the same worlds, one transaction. `plans` is the router's plan
       * per world index (`useSalePlan`: resting bids first, then the pool, each world's minimum = plan − 0.5% of its
       * pool part). `toLending` keeps the proceeds as collateral in `tier`.
       */
      sell: (p: { sid: number; mask: number; amount: bigint; plans: readonly (WorldPlan | undefined)[]; toLending?: boolean; tier?: Tier; from?: "wallet" | "inner" }) =>
        run({ kind: "trade", title: "Sale", pending: "Selling…", done: p.toLending ? "Sold; the dollars are loan collateral" : "Sold; the dollars are in your wallet", market: p.sid }, { contract: true }, async (_s, cfg) => {
          const plan = { scenarioId: p.sid, sellMask: p.mask, plans: planFills(p.plans), minOut: planMinOut(p.plans), toLending: Boolean(p.toLending), tier: p.tier };
          try {
            if (p.from === "inner") return await submit(sellFromInner(CONTRACT_ID, { ...plan, amount: p.amount }));
            const tokens = toTokenFloor(p.amount, cfg.wnear.decimals);
            return await submit(sellFromWallet(cfg.wnear.tokenId, CONTRACT_ID, tokens, plan), tokens);
          } catch (e) {
            void qc.invalidateQueries({ queryKey: ["trade"] }); // an order may have been taken first: plan again
            throw e;
          }
        }),

      /** T5/T6: rest an order for NEAR in one world. A bid escrows USDC (amount × price), an ask escrows wNEAR. */
      postOrder: (p: { sid: number; mask: number; side: Side; price: bigint; amount: bigint; expirySec: number }) =>
        run({ kind: "trade", title: p.side === "bid" ? "Bid" : "Ask", pending: p.side === "bid" ? "Posting the bid…" : "Posting the ask…", done: p.side === "bid" ? "Bid posted" : "Ask posted", market: p.sid }, { contract: true }, (_s, cfg) => {
          const msg = { action: "post_order" as const, scenario_id: p.sid, mask: p.mask, side: p.side, price: p.price.toString(), amount: p.amount.toString(), expiry_sec: p.expirySec };
          if (p.side === "bid") {
            const tokens = toTokenCeil(cost(p.amount, p.price), cfg.usdc.decimals);
            return submit(ftTransferCall(cfg.usdc.tokenId, CONTRACT_ID, tokens, msg), tokens);
          }
          const tokens = toTokenFloor(p.amount, cfg.wnear.decimals);
          return submit(ftTransferCall(cfg.wnear.tokenId, CONTRACT_ID, tokens, msg), tokens);
        }),

      /** T7 */
      cancelOrder: (orderId: bigint, sid?: number) =>
        run({ kind: "trade", title: "Order", pending: "Cancelling the order…", done: "Order cancelled; the escrow came back", market: sid }, { contract: true }, () => submit(cancelOrderTx(CONTRACT_ID, orderId))),

      /** T3/T4: take `amount` NEAR of someone's resting order in its world (sell into a bid, buy from an ask). */
      takeOrder: (p: { sid: number; worldCount: number; order: Order; worldIndex: number; amount: bigint; usdc: bigint }) =>
        run({ kind: "trade", title: "Trade", pending: p.order.side === "bid" ? "Selling into the bid…" : "Buying from the ask…", done: p.order.side === "bid" ? "Sold into the bid" : "Bought from the ask", market: p.sid }, { contract: true }, (_s, cfg) => {
          const mask = 1 << p.worldIndex;
          if (p.order.side === "bid") {
            const tokens = toTokenFloor(p.amount, cfg.wnear.decimals);
            const plan = singleOrderPlan(p.worldCount, p.worldIndex, p.order.id, p.amount, p.usdc);
            return submit(ftTransferCall(cfg.wnear.tokenId, CONTRACT_ID, tokens, { action: "conditional_sell", scenario_id: p.sid, sell_mask: mask, plans: plan.plans, min_out: plan.min_out, to_lending: false }), tokens);
          }
          const tokens = toTokenCeil(p.usdc, cfg.usdc.decimals);
          const plan = singleOrderPlan(p.worldCount, p.worldIndex, p.order.id, p.amount, p.amount);
          return submit(ftTransferCall(cfg.usdc.tokenId, CONTRACT_ID, tokens, { action: "conditional_buy", scenario_id: p.sid, buy_mask: mask, plans: plan.plans, min_out: plan.min_out, to_lending: false }), tokens);
        }),

      /** T10: lend USDC to one tier of a market. */
      supply: (sid: number, tier: Tier, amount: bigint) =>
        run({ kind: "lend", title: "Lending", pending: "Supplying USDC…", done: "Supplied; it earns from now", market: sid }, { contract: true }, (_s, cfg) => {
          const tokens = toTokenCeil(amount, cfg.usdc.decimals);
          return submit(supplyTx(cfg.usdc.tokenId, CONTRACT_ID, tokens, { scenarioId: sid, tier }), tokens);
        }),

      /** T11: `amount` null takes everything back. */
      withdrawSupply: (sid: number, tier: Tier, amount: bigint | null) =>
        run({ kind: "lend", title: "Lending", pending: "Withdrawing USDC…", done: "Withdrawn to your wallet", market: sid }, { contract: true, tokens: ["usdc"] }, () =>
          submit(withdrawSupplyTx(CONTRACT_ID, { scenarioId: sid, amount, tier })),
        ),

      /** T41: post real wNEAR or USDC as collateral in a tier. */
      depositCollateral: (sid: number, tier: Tier, asset: Asset, amount: bigint) =>
        run({ kind: "loan", title: "Collateral", pending: `Posting ${sym(asset)} as collateral…`, done: "Collateral posted", market: sid }, { contract: true }, (_s, cfg) => {
          const t = token(cfg, asset);
          const tokens = asset === "wnear" ? toTokenFloor(amount, t.decimals) : toTokenCeil(amount, t.decimals);
          return submit(depositCollateralTx(t.tokenId, CONTRACT_ID, tokens, { scenarioId: sid, tier }), tokens);
        }),

      /** Take a posted piece back ("wnear" / "usdc" for real collateral, else the world token's id). */
      withdrawCollateral: (sid: number, tier: Tier, piece: { tokenId: string; isReal: boolean; asset: Asset }, amount: bigint) =>
        run({ kind: "loan", title: "Collateral", pending: "Taking collateral back…", done: "Collateral back in your wallet", market: sid }, { contract: true, tokens: piece.isReal ? [piece.asset] : undefined }, () =>
          submit(withdrawCollateralTx(CONTRACT_ID, { scenarioId: sid, piece: piece.tokenId, amount, tier })),
        ),

      /** T8: borrow real USDC against the worst world. */
      borrow: (sid: number, tier: Tier, amount: bigint) =>
        run({ kind: "loan", title: "Loan", pending: "Borrowing USDC…", done: "Borrowed; the USDC is in your wallet", market: sid }, { contract: true, tokens: ["usdc"] }, () =>
          submit(borrowTx(CONTRACT_ID, { scenarioId: sid, amount, tier })),
        ),

      /** T9: repay `amount`, or everything ("all": the debt plus 0.1% for interest, refunded above the debt). */
      repay: (sid: number, tier: Tier, amount: bigint | "all", debt: bigint, walletUsdc: bigint) =>
        run({ kind: "loan", title: "Loan", pending: "Repaying…", done: amount === "all" ? "Loan repaid" : "Repaid", market: sid }, { contract: true }, (_s, cfg) => {
          const all = amount === "all";
          const tokens = toTokenCeil(all ? repayAllSend(debt, walletUsdc) : amount, cfg.usdc.decimals);
          return submit(repayTx(cfg.usdc.tokenId, CONTRACT_ID, tokens, { scenarioId: sid, all, tier }), "nonzero");
        }),

      /** T17: a world piece whose world is the only one left, 1:1 for the real token. */
      redeem: (sid: number, asset: Asset, mask: number, amount: bigint) =>
        run({ kind: "resolve", title: "Redeem", pending: `Redeeming ${sym(asset)}…`, done: `Redeemed for real ${sym(asset)}`, market: sid }, { contract: true, tokens: [asset] }, () =>
          submit(redeemTx(CONTRACT_ID, { scenarioId: sid, asset, mask, amount })),
        ),

      /** T14: anyone may finalize a proposal whose dispute window has passed. */
      finalize: (eventId: number, sid?: number) =>
        run({ kind: "resolve", title: "Resolution", pending: "Finalizing…", done: "Finalized; the other worlds closed", market: sid }, { contract: true }, () => submit(finalizeTx(CONTRACT_ID, eventId))),

      /** T19 (owner, during the dispute window). */
      dispute: (eventId: number, sid?: number) =>
        run({ kind: "resolve", title: "Resolution", pending: "Disputing…", done: "Disputed; the proposal is withdrawn", market: sid }, { contract: true }, () => submit(disputeTx(CONTRACT_ID, eventId))),

      /** NEP-145: the free part of the storage deposit (returned bonds) back to the wallet. */
      storageWithdraw: () =>
        run({ kind: "wallet", title: "Storage", pending: "Withdrawing free NEAR…", done: "Free NEAR is back in your wallet" }, undefined, () => submit(storageWithdrawTx(CONTRACT_ID))),
    };
  }, [busy, run, submit, qc]);
}

