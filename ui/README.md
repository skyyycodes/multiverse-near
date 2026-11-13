# Multiverse UI (redesign)

A redesigned interface for Multiverse Lending, kept beside `web/` so the two can be compared without touching the
working app. It covers every screen `web/` has, plus a market list and a few more:

| Route | Screen |
|---|---|
| `/` | Landing: the scroll story, the four-world example, open markets, FAQ |
| `/markets` | Market board: featured market with its chance chart, search, categories, watchlist |
| `/markets/[id]` | One market: chance of each world over time, a row per world (hedge, trade, its order book), rules, resolution, activity, holders, and the fund / hedge / borrow / lend / liquidity ticket |
| `/orders` | Trading screen per world: candle chart (TradingView lightweight-charts), order book with spread, limit and market orders, trades |
| `/borrow` | Loan position, borrow capacity, liquidation price per world, collateral at risk, LTV slider |
| `/lend` | Supply and withdraw, rate history, where the pool is lent, underwriting every world |
| `/resolve` | Every event with its rule, sources, deadline and a proposed → dispute → final timeline |
| `/portfolio` | Guaranteed and average value, positions by world, open orders, trades, activity |
| `/admin` | Owner console: resolve events, move a world's price, mint test tokens, reseed |
| `/docs` | How it works, with the testnet run and its explorer links |
| `/markets/new`, `/proposals` | Roadmap ideas (pledge-funded markets, decision markets), labelled as not in the contract |

## Status

**It runs on an in-browser model of the protocol, not on the contract yet.** Every action works and is labelled as
demo data; nothing is signed. The demo wallet starts with 1,000 NEAR in the SPICE × Fed market. Numbers in the
copy (Alice's 4,881.88 USDC, health 1.22, the October Fed resolution) come from the testnet run in the main README.

Wiring it to `app.multiverse-near.testnet` means replacing `src/lib/client.ts` and the store reads in
`src/lib/scenario.ts` with `web/`'s data layer (`useData`, `useSubmit`, `call`, `ftTransferCall`). The screens
read the same shapes the contract views return: worlds by bit (world 0 SHIPS·CUTS, 1 DELAYED·CUTS, 2 SHIPS·HOLDS,
3 DELAYED·HOLDS), per-world prices and odds, the order book, the lending market and the events' state.

Known differences from the contract, to fix during the wiring:

- The demo lists the four worlds in the order Ships·Cuts, Ships·Holds, Delayed·Cuts, Delayed·Holds; the contract
  numbers them 0, 2, 1, 3.
- Lending is one shared pool here; the contract has one USDC market per scenario.
- The deposit form can show NEAR Intents (1Click) quotes from other chains. They are dry runs; the contract takes
  only wNEAR and USDC.

## Run it

Node 22 and pnpm 10.

```bash
cd ui
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # production build
pnpm typecheck
pnpm lint
```

`.env.example` lists the variables; leave the contract ids empty to run on the in-browser model.

## Layout

- `src/app/` routes (Next.js App Router), each a thin wrapper around a screen in `src/views/`
- `src/views/` one file per screen
- `src/components/` shared pieces: header, wallet menu, search (Ctrl/⌘+K), toasts, charts, market artwork
- `src/lib/scenario.ts` the in-browser model and its actions; `src/lib/history.ts` the seeded demo histories
- `src/data/demo.ts` the demo markets, with each event's rule, deadline and sources
- `src/styles/` the stylesheets; `public/markets/` the event artwork
