# Integrating the redesign with v2

The partners' redesign (this folder) is the public Origami Verse site. Its design stays; its in-browser model is gone (UI-MERGE
removed `lib/scenario.ts` and the rest of it). Every screen reads `src/chain/adapter.ts` (the contract on testnet). It moved one screen at
a time. This file is the contract between the tracks doing that.

Rules that hold everywhere (DECISIONS 2026-11-14 12:10):

- **Their style.** A page or element v2 needs and they lack is built as if they made it: their classes, their copy
  tone (short, plain, sentence case), their empty, loading and error states. No Tailwind, no UI kit.
- **Origami Verse** is the name. Read it from `site.name` (config) or `BRAND` (`src/chain/brand.ts`), never a literal.
- **Real or hidden.** No seeded number may reach the screen as if it were real: odds and price history charts,
  candles, volume, P&L and cost basis, activity, holders, NEAR Intents quotes, decision markets. Build the real version
  where the chain has the data and it is cheap; else remove the element and keep the layout tidy. Decision markets stay
  only as a roadmap page with no numbers. A "what if NEAR moves" control is fine if it computes from the account's real
  holdings and says it is a what-if.
- **Money is bigint.** Amounts the user types are parsed with `parseAmount(input, token.decimals)` into the contract's
  18-decimal bigint and passed to actions as such. The adapter's plain numbers (`chance`, `nearPrice`, `usdc`, …) are
  for display and charts only.

## The adapter: `src/chain/adapter.ts`

Import from here (it re-exports `adapter-model.ts`). Worlds are always in the contract's bit order:
`world = a + 2b + 4c`, event A the lowest bit (`ChainWorld.digits` gives each event's outcome). The model listed them
in another order; its helpers are gone with it.

| Hook | Returns | Reads |
|---|---|---|
| `useMarkets()` | `{ markets?: ChainMarket[], isLoading, error }`, every listed market | `list_markets`, `get_events`, `event_meta`; 20 s |
| `useMarket(id)` | `{ market?, isLoading, notFound, error }`, listed or not | `get_market` + events; 15 s |
| `usePosition(id, tier = 'normal')` | `{ position?: Position, isLoading, error }` (zeros without a wallet) | `borrow_view`; 8 s |
| `useWalletBalances()` | wNEAR / USDC in the wallet (numbers and wads), inner balances | `ft_balance_of`, `real_balance_of`; 8 s |
| `useMyMarkets()` | market ids the account holds anything in | `markets_of`; 30 s |
| `useLoanSummary()` | markets, open loans, total debt, lowest health, supplied | `lending_tiers` per market; 30 s |
| `useIsOwner()` | the connected account owns the contract | `get_app_config` |
| `useBlocker(action, { gas, deposit })` | a pause of that action, or too little NEAR for gas, as button text | `pause_state`, `view_account` |
| `useEventMetas(ids)` | `event_meta` per event (source, category) | 5 min |
| `marketId(x)` | a positive integer id from a string or number, else `undefined` | |

`ChainMarket`: `sid`, `id` (string), `href` (`/market/?id=N`), `question` / `title` (questions joined by " × "), `events`,
`worlds`, `grid` (rows = event A, columns = the other events, cells = world indices), `category`, `categories`, `kind`
("Combination · 4 worlds"), `resolves` ("9 Dec 2026" or "Settled"), `deadlineSec`, `createdAtSec`, `status`,
`statusLabel`, `settled`, `winner`, `possible` (mask), `worldCount`, `liquidity` (USDC in its pools), `minWorldDepth`,
`impliedSpot`, `oddsKnown`, `lendable`, `tiers` (all three when lendable, none otherwise), `origin`, `proposalId`,
`listed`, and `card` (the decoded registry card).

`ChainEvent`: `id`, `name` / `question`, `outcomes` ("Ships"), `outcomeNames` ("SHIPS"), `rule` (machine tag
dropped), `sources`, `category`, `categoryName`, `deadlineSec`, `deadline` ("2027-03-31 23:59 UTC"), `image` (artwork
under `public/markets/` by the rule's tag), `finalized`, `outcome`, `proposalOpen`, `proposedOutcome`,
`finalizableAtSec`, `proposedBy`, `state`.

`ChainWorld`: `index`, `mask`, `id`, `label` ("SHIPS·CUTS"), `outcome` ("Ships & cuts"), `digits`, `possible`,
`chance` (0-1), `odds`, `nearPrice`, `price`.

`Position` (one market, one tier): `worlds` (per world: `near`, `usdc` = wallet pieces + posted collateral; the
`…Wad` parts; `value` = what this tier's collateral counts for there; `price`), `holdsAnything`, `debt`, `health`,
`borrowHealth`, `worstWorld`, `maxBorrow`, `borrowLimit`, `minLoan`, `liquidation`, `frozen`, `borrowBlock`,
`supplied`, `borrowApr`, `supplyApr`, `utilization`, `collateral` (pieces), `realNearWad`, `realUsdcWad`, and the
decoded `account` and `scenario`.

`useActions()` returns `busy` (the pending step, or null) and these, each `Promise<ActionResult>`
(`{ ok: true, hash } | { ok: false, error }`, never throws; the toast already shows the outcome):

| Action | Transaction (web design 5.2) |
|---|---|
| `faucet()` | mint the test-token drop of each token below it, then register (0.1 NEAR) |
| `split(market, asset, amount)` / `merge(market, asset, amount)` | T44 / T45 |
| `sell({ sid, mask, amount, plans, toLending?, tier?, from? })` | T1 / T2; `plans` from `useSalePlan` (hooks/useSalePlan.ts) |
| `postOrder({ sid, mask, side, price, amount, expirySec })`, `cancelOrder(id, sid?)` | T5 / T6, T7 |
| `takeOrder({ sid, worldCount, order, worldIndex, amount, usdc })` | T3 / T4 against one resting order |
| `supply(sid, tier, amount)`, `withdrawSupply(sid, tier, amount \| null)` | T10, T11 |
| `depositCollateral(sid, tier, asset, amount)`, `withdrawCollateral(sid, tier, piece, amount)` | T41, take back |
| `borrow(sid, tier, amount)`, `repay(sid, tier, amount \| 'all', debt, walletUsdc)` | T8, T9 |
| `redeem(sid, asset, mask, amount)`, `finalize(eventId, sid?)`, `dispute(eventId, sid?)` | T17, T14, T19 |
| `storageWithdraw()` | NEP-145 free storage (returned bonds) back to the wallet |
| `send(tx, announce, { needs?, expectUsed? })` | anything else: build it with `near/tx.ts` (proposals, pledges, admin, liquidation, close, Root LP) |

Each action connects the wallet first if none is, registers the account where the action needs it (`needs`), sends,
checks the outcome (a refund of an `ft_transfer_call` is a failure), refreshes every query and reports through the
Toaster: pending → done with the explorer link → or the contract's error in plain words (`errors.ts`).

Beyond the adapter, the whole chain layer from `web/src/lib` is under `src/chain/` with its tests: `hooks/useData.ts`
(`useTrade` for orders and events, `useLend`, `useResolve`, `useAdmin`, quotes, `useRegistration`), `hooks/useLending.ts`
(`useLendingTiers`, price check, reference), `hooks/useLiquidation.ts` (`useAtRisk`, quotes), `hooks/useProposal.ts`
(proposals, pledges, checks), `hooks/useOps.ts` (version, pause), `hooks/useScenario.tsx` (picked worlds and tier per
market), and the pure helpers (`lending.ts`, `orders.ts`, `liquidation.ts`, `proposals.ts`, `settlement.ts`,
`split.ts`, `tiers.ts`, `format.ts`, `units.ts`). Web's screens (`web/src/components`) show how each flow uses them.
Reuse them; don't re-derive the maths. A track that needs a new hook puts it in a new file under `src/chain/` (for
example `src/chain/orders-book.ts`); `adapter.ts` stays the foundation's.

## Shared pieces

- `components/ui/ActionButton.tsx`: the button every transaction goes through (`label`, `blocker`, `action`, `gas`,
  `deposit`, `run={() => actions.borrow(…)}`, `onDone`). It shows "Connect NEAR wallet", the blocker, or the step.
- `components/ticket/`: the market ticket's panes (`FundPane`, `HedgePane`, `BorrowPane`, `LendPane`,
  `LiquidityPane`, props `{ market, mask }`). Fund and Hedge are UI-C's, Borrow, Lend and Liquidity UI-B's.
- `components/SplitTicket.tsx`: split and merge, shared by the Split page and the Fund pane.
- `components/ui/ActionButton.tsx` also recovers from an `InsufficientStorage` refusal: the button turns into "Add N NEAR
  to storage" (`storageShortfall` in `chain/storage-floor.ts`), then back to the action. Before that, an action that
  writes to the contract already adds 0.1 NEAR when the free deposit is under 0.02 NEAR (`hooks/useTx.ts`).
- `components/Grand.tsx`: `MarketArt` and `WorldIcon` draw a `ChainMarket` (contract grid); `WorldTable` is its map.
- `components/layout/RoutePage.tsx`: every route that reads its query string renders its view through it (Suspense,
  needed by the static export). `PageLoading` is its fallback.
- `config.ts`: `site`, `nav`, `isCurrent`, `footerLinks`, `links`, `chain` (contract and token ids of this build, the
  anchor market).

## Routes

| Route | Screen | Track |
|---|---|---|
| `/` | landing (the scroll story) | UI-A |
| `/markets/` | the board | UI-A |
| `/market/?id=N` | one market: worlds, rules, resolution, the ticket | UI-A (ticket panes: UI-B, UI-C) |
| `/portfolio/` | your futures across markets | UI-B |
| `/borrow/?id=N&tier=…`, `/lend/?id=N&tier=…` | lending (tier omitted = Normal) | UI-B |
| `/liquidate/?id=N` | at-risk loans (from Borrow, Lend and the footer) | UI-B |
| `/orders/?id=N&w=W` | order book per world | UI-C |
| `/split/?id=N` | split and merge (from the market ticket) | UI-C |
| `/propose/?kind=event\|market&events=1,2` | propose an event or a market | UI-D |
| `/proposal/?p=N` | one proposal and its pledges | UI-D |
| `/proposals/` | the proposals board: pledge, withdraw, refund, claim | UI-D |
| `/decision-markets/` | decision markets, as a roadmap page with no numbers | UI-D |
| `/resolve/?id=N`, `/admin/?id=N` | resolution; the owner console (wallet menu for the owner, footer) | UI-D |
| `/docs/` | how it works | UI-A |

Links come from `src/chain/links.ts` (`marketHref`, `ordersHref`, `splitHref`, `borrowHref`, `lendHref`,
`liquidateHref`, `proposalHref`, `proposeHref`, `resolveHref`, `adminHref`). The header nav is `config.ts` `nav`:
Markets, Portfolio, Borrow, Lend, Order book, Propose, Resolve, How it works.

## Who owns which files

Edit only your files. Need a change in someone else's? Leave it in your notes for UI-MERGE.

| Track | Files |
|---|---|
| UI-F (foundation) | `config.ts`, `app/**` (route wrappers), `components/layout/**`, `components/ui/**`, `components/ticket/types.ts` + `index.ts`, `src/chain/adapter*.ts`, `src/chain/toasts.ts`, `styles/chain.css`, `next.config.ts`, `package.json`, `scripts/**`, `e2e/staging/chain.ts`, `../scripts/deploy-web.sh` |
| UI-A markets, landing, docs | `views/Landing.tsx`, `views/Markets.tsx`, `views/Market.tsx`, `views/Docs.tsx`, `views/NotFound.tsx`, `components/ScenarioMarket.tsx`, `components/Grand.tsx`, `components/Hero.tsx`, `Dome*.tsx`, `Orbit3D.tsx`, `WorldRings.tsx`, `WorldMap.tsx`, `CollateralBars.tsx`, `IntentsQuote.tsx`, `styles/v2-markets.css` |
| UI-B lending, liquidate, portfolio | `views/Borrow.tsx`, `views/Lend.tsx`, `views/Liquidate.tsx`, `views/Portfolio.tsx`, `components/ticket/{Borrow,Lend,Liquidity}Pane.tsx`, `styles/v2-lending.css` |
| UI-C orders, split, sell | `views/Orders.tsx`, `views/Split.tsx`, `components/PriceChart.tsx`, `components/ticket/{Fund,Hedge}Pane.tsx`, `styles/v2-trade.css` |
| UI-D propose, proposals, resolve, admin | `views/CreateMarket.tsx` (`/propose/`), `views/Proposal.tsx`, `views/Proposals.tsx`, `views/Resolve.tsx`, `views/Admin.tsx`, `styles/v2-governance.css` |
| UI-MERGE | removed the model (`lib/scenario.ts`, `client.ts`, `wallet.tsx`, `history.ts`, `futarchy.ts`, `pledges.ts`, `intents.ts`, `market.ts`, `types.ts`, `data/demo.ts`, `WalletBar.tsx`, `WorldMap.tsx`); `e2e/staging.spec.ts` |

The shared stylesheets (`tokens.css`, `system.css`, `unify.css`, `ui.css`, `landing.css`, `desk.css`, `global-ui.css`,
`layout.css`, `topbar.css`) are not edited: a new rule goes in your track's `styles/v2-*.css`, which loads after them.

## Building new elements in their style

Page frame: `<div className="page tr desk">`, then a header `<header className="tr__pair"><div className="tr__id">
<h1 className="mk__title">…</h1><p className="tr__means">…</p></div><dl className="tr__stats">…</dl></header>`.
Two columns: `mk__grid` with `mk__main` and `mk__side`. A panel: `section.tr__panel`, its head
`div.desk__head > h2.obx__boxtitle` (+ `a.tr__link` or `span.pc__note`). Rows of figures: `p.tk__line > span + b.num`.
Tables: `div.desk__table > div.desk__tr.desk__tr--head` then `div.desk__tr` (or `a.desk__tr`). Inputs:
`label.tk__field > span + input`. Segmented choices: `div.pc__tabs > button[aria-pressed]`. Buttons: `<Button>`
(`btn btn--primary` / `--ghost`), small ones `mk__btn` (`--buy` green, `--sell` rose). Notes: `p.pc__note`, ticket help
`p.ticket__help`. States: `span.rs__state.rs__state--open|live|final`; health `tone--safe|watch|risk`.

- Empty: `<div className="tr__panel desk__empty"><p><b>No loans yet.</b> One plain sentence.</p><Link className="mk__btn mk__btn--buy" …>Next step</Link></div>` (inside a panel: `p.obx__empty`).
- Loading: `<PageLoading />` for a page, "Reading the chain…"; inside a panel, `p.obx__empty` with what is being read.
- Error: the plain-words line from `errorLine()` in `p.pc__note` (failed transactions already toast).

Tokens: surfaces `--u-surface`, `--u-raise`; lines `--u-line`, `--u-line-2`; text `--u-ink`, `--u-soft`, `--u-muted`;
the one accent `--u-orange` / `--accent` (#bf888b) and `--accent-strong`; trading `--buy`, `--sell`, `--buy-bg`,
`--sell-bg`, `--watch`; radius `--u-r` (6px) for panels, `--radius` (4px) for controls. Type: General Sans
(`--font-sans`) for words, DM Mono (`--font-mono`, class `num`) for figures, Anton for the landing's display numbers
only. World colours: `WORLD_COLORS[index]` from `components/Grand.tsx`, by contract index.

## Trading on the order book

`/orders/` trades what you hold in the world (the partners' principle): `chain/book.ts` `worldTradeTx` batches up to
five `fill_order` calls and then a `swap` on the world's pool (exact in, `min_out` = quote less 0.5%) or a
`post_order` for a limit's rest, in one transaction. Pool quotes are computed from `get_pool` with the contract's
rounding (`book.test.ts` pins them to `quote_sell`). The chart is the pool price after each of the market's last 64
swaps; there are no candles, no 24 h figures and no tape of others' fills, because the chain keeps none.

## Reads

The browser reads testnet from dRPC first and FastNEAR after it (`chain/env.ts`): FastNEAR's edge now and then answers a
page's preflighted reads without CORS headers, which the browser logs as errors. At most six reads are in flight
(`MAX_IN_FLIGHT`, `near/rpc.ts`). Snapshots poll every 8 s (`POLL_MS`); your own transaction refreshes everything at once.

## Gates

```bash
pnpm -C ui typecheck && pnpm -C ui lint && pnpm -C ui test && pnpm -C ui build
```

All four must exit 0 (lint warnings are allowed, errors are not). Before a release: `pnpm -C ui build:staging` (it
writes `out-staging/` with `version.json`, the OutLayer guests and the demo-wallet bridge), then
`scripts/deploy-web.sh --dry-run` from the repo root (runs `scripts/check-release.mjs`).

## Running against staging

```bash
cd ui && pnpm install
pnpm dev                         # http://localhost:5173, staging by default; connect any testnet wallet
pnpm build:staging && pnpm serve:staging   # the release build on :3045
```

Get test tokens from the wallet menu. To sign with the staging test keys instead of a wallet (recorder, tests), use the
demo-wallet bridge: build with `NEXT_PUBLIC_DEMO_WALLET=1` (`build:staging` does) and drive the page with Playwright:

```ts
import { demoWallet, persona } from './staging/chain'
await demoWallet(context, persona('alice')) // window.__nearDemo signs as alice; connects on load
```

```bash
NEAR_KEYS_DIR=/path/to/multiverse-near/.keys/staging STAGING=1 pnpm e2e:staging            # e2e/*.spec.ts
NEAR_KEYS_DIR=… STAGING=1 BASE_URL=https://multiverse-lending.vercel.app pnpm e2e:staging  # a deployed site
```

`e2e/shell.spec.ts` is read-only. A spec that sends transactions uses the staging family's accounts only, never
reports or finalizes an event, and unpauses in a `finally` whatever it paused.

`e2e/staging.spec.ts` (`-g staging`) is the whole site as a new visitor: `judge-ui1.<root>` (made with 0.3 NEAR on the first
run, plus 0.2 NEAR once, because every 300 Tgas call reserves 0.3 NEAR of gas), connect through the wallet picker, test
tokens, split, hedge, an order placed and cancelled, supply and withdraw, borrow, portfolio, at-risk, repay, a
combination checked, resolve, the owner pausing one flag, and a phone pass at 390×844. Any console error fails it. The
harness reads from `STAGING_RPC` (default rpc.testnet.near.org), not the site's RPC.
