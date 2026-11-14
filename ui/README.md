# IfVerse UI

The public IfVerse site: the redesigned interface, now the frontend of v2 on NEAR testnet (it replaces `web/`, which
stays in the repo but is no longer deployed). It covers every screen `web/` has, plus a market list and a few more:

| Route | Screen |
|---|---|
| `/` | Landing: the scroll story, the four-world example, open markets, FAQ |
| `/markets` | Market board: featured market with its chance chart, search, categories, watchlist |
| `/market/?id=N` | One market: chance of each world over time, a row per world (hedge, trade, its order book), rules, resolution, activity, holders, and the fund / hedge / borrow / lend / liquidity ticket |
| `/orders` | Trading screen per world: candle chart (TradingView lightweight-charts), order book with spread, limit and market orders, trades |
| `/borrow` | Loan position, borrow capacity, liquidation price per world, collateral at risk, LTV slider |
| `/lend` | Supply and withdraw, rate history, where the pool is lent, underwriting every world |
| `/resolve` | Every event with its rule, sources, deadline and a proposed → dispute → final timeline |
| `/portfolio` | The range of futures you hold (worst to best world, with a "what if NEAR moves" control), value and P&L against cost, positions, orders, trades, activity, allocation |
| `/admin` | Owner console: resolve events, move a world's price, mint test tokens, reseed |
| `/docs` | How it works, with the testnet run and its explorer links |
| `/propose/` | Propose an event or a market, pledge from both sides, owner check, open already funded (`/proposal/?p=N`: one proposal) |
| `/split/?id=N` | Split real wNEAR or USDC into every world, or merge a full set back |
| `/liquidate/` | At-risk loans across markets and tiers |
| `/proposals` | Roadmap: decision markets, pass vs fail time-weighted prices against a +3% threshold, as MetaDAO decides |

## Status

Screens move from the in-browser model (`src/lib/scenario.ts`) to the contract on testnet through the chain adapter
(`src/chain/adapter.ts`), one by one; the shell (wallet, balances, test tokens, search, toasts) already runs on the
chain. [INTEGRATION.md](INTEGRATION.md) has the adapter API, the routes, the classes for new elements, who owns which
file and the gates. Anything without real data is built for real or hidden.

## Run it

Node 22 and pnpm 10.

```bash
cd ui
pnpm install
pnpm dev          # http://localhost:5173, against the staging deployment
pnpm build        # static export in out/
pnpm build:staging  # the release build in out-staging/ (scripts/deploy-web.sh publishes it)
pnpm typecheck
pnpm lint
pnpm test
```

The contract, token ids and RPC come from `deployments/<network>.json` (`NEXT_PUBLIC_NETWORK`, staging by default).

## Layout

- `src/app/` routes (Next.js App Router), each a thin wrapper around a screen in `src/views/`
- `src/views/` one file per screen
- `src/components/` shared pieces: header, wallet menu, search (Ctrl/⌘+K), toasts, charts, market artwork
- `src/chain/` the v2 chain layer (from `web/src/lib`) and the adapter the views read
- `src/lib/scenario.ts` the in-browser model, until every screen is off it; `src/lib/history.ts` its seeded histories
- `src/data/demo.ts` the demo markets, with each event's rule, deadline and sources
- `src/styles/` the stylesheets; `public/markets/` the event artwork
