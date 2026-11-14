# IfVerse UI

The public IfVerse site: the redesigned interface, now the frontend of v2 on NEAR testnet (it replaces `web/`, which
stays in the repo but is no longer deployed). It covers every screen `web/` has, plus a market list and a few more:

| Route | Screen |
|---|---|
| `/` | Landing: the scroll story, the four worlds of the anchor market, a 1,000 NEAR what-if at today's prices, open markets, FAQ |
| `/markets/` | Market board: the anchor featured with its map of worlds, search, categories, watchlist, proposals collecting pledges |
| `/market/?id=N` | One market: a row per world (chance, NEAR price, what you hold, its order book), rules, resolution, checks, your loan, and the fund / hedge / borrow / lend / liquidity ticket |
| `/orders/?id=N&w=W` | Order book per world: pool price after each swap, depth, limit and market orders from what you hold in the world, pool trades, your orders |
| `/split/?id=N` | Split real wNEAR or USDC into every world, or merge a full set back |
| `/borrow/?id=N&tier=T` | Loan per tier: worst world, liquidation price per world, collateral at risk (a what-if), sell NEAR into collateral, borrow and repay |
| `/lend/?id=N&tier=T` | Supply and withdraw per tier, the tier's rate curve, who it is lent to, insurance, Root liquidity |
| `/liquidate/` | At-risk loans across markets and tiers, with the contract's quote |
| `/portfolio/` | The range of futures you hold (with a labelled "what if NEAR moves" control), loans and supply by tier, positions, open orders |
| `/propose/`, `/proposals/`, `/proposal/?p=N` | Propose an event or a combination, the proposals board, one proposal and its pledges |
| `/resolve/?id=N` | Every event with its rule, sources and the chain's proposed → dispute → final line |
| `/admin/?id=N` | Owner console: review proposals, pause flags, resolve now, dispute, the NEAR/USD reference |
| `/docs/` | How it works, with live tiers, two live loans and the staging transactions |
| `/decision-markets/` | Roadmap page for decision markets, no numbers |

## Status

Every screen reads the contract on testnet through the chain adapter (`src/chain/adapter.ts`); the in-browser model is
gone. Anything the chain has no data for (price history, volume, P&L, activity, holders, Intents quotes) is hidden.
[INTEGRATION.md](INTEGRATION.md) has the adapter API, the routes, the classes for new elements and the gates.

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
- `src/styles/` the stylesheets; `public/markets/` the event artwork
