# Selectors for the walkthrough recorder and end-to-end tests

Everything a script needs to drive the web app: how to sign in with test keys, which URL parameters exist, and a
stable `data-demo` hook for every element worth clicking, typing into, waiting for or spotlighting. Prefer the hooks
over visible text: copy may change, hooks will not. `e2e/` uses exactly these hooks and is the working example.

## 1. Signing in with test keys: `window.__nearDemo`

The app uses NEAR Connect. When the page has a function `window.__nearDemo`, the app registers a wallet called
"Demo wallet (test keys)" (id `multiverse-demo`) through NEAR Connect's injected-wallet event, and skips the remote
wallet list so it is the only entry. Real visitors never have the function, and only builds made with
`NEXT_PUBLIC_DEMO_WALLET=1` (`pnpm build:live` for the sandbox, `pnpm build:demo` for testnet) contain the bridge at
all. `e2e/live/chain.ts` is a working signer for the sandbox personas.

Expose it before the page loads (Playwright `page.exposeFunction`, Puppeteer `page.exposeFunction`):

```js
await page.exposeFunction("__nearDemo", async (method, paramsJson) => {
  const params = JSON.parse(paramsJson);
  switch (method) {
    case "signIn":
    case "getAccounts":            return JSON.stringify([{ accountId: "alice.multiverse-near.testnet" }]);
    case "signOut":                return "";
    case "signAndSendTransaction":  // { receiverId, actions: [{ type: "FunctionCall", params: { methodName, args, gas, deposit } }], network }
      return JSON.stringify(await signWithNearApiJs(params)); // the FinalExecutionOutcome, receipts included
    case "signAndSendTransactions": // { transactions: [...] } → array of outcomes
    case "signMessage":             // { message, recipient, nonce: number[] }
  }
});
```

- Return JSON strings (or plain objects). `gas` and `deposit` arrive as decimal strings, `args` as a plain object
  (`args.msg` of `ft_transfer_call` is itself a JSON string).
- Return the full outcome (`status`, `transaction.hash`, `receipts_outcome`). If `receipts_outcome` is missing the app
  reads the transaction back from the RPC by hash.
- Connect on camera: click `[data-demo="connect"]` (header) or `[data-demo="landing-connect"]`, then the picker entry
  `.connect-item[data-type="multiverse-demo"]` (NEAR Connect's own modal, appended to `body`).
- Connect without the picker: set `window.__nearDemoAutoConnect = true` in an init script.
- The session survives a reload as long as the function is exposed again.

## 2. URLs

| Path | Screen |
|---|---|
| `/` | Trade. Phone: home (spot, futures strip, action tiles, possible futures). Desktop: grid of worlds + Sell / Order book sheet |
| `/sell/` | Sell form (phone); on desktop the same as `/` with the Sell tab |
| `/orders/` | Order book (phone); on desktop `/` with the Order book tab |
| `/world/?w=3` | One world: card carousel, price, world info |
| `/borrow/`, `/lend/`, `/resolve/`, `/admin/` | Borrow, Lend + Root LP, Resolve + close, Admin |
| `/welcome/` | Landing ("How it works") |

Query parameters:

| Param | Effect |
|---|---|
| `sel=14` | Preselect worlds to sell by mask (14 = DELAYED or HOLDS, the L-shape) on `/` and `/sell/` |
| `w=3` | Preselect one world: to sell (`/sell/`), its book (`/orders/`), its card (`/world/`) |
| `buy=1` | On `/orders/`: open the best ask's accept box (or the bid form when there is none) |
| `welcome=0` | Skip the first-visit landing on `/` (also remembered in `localStorage["multiverse.welcomed"]`) |
| `fx=<stage>`, `as=<persona>` | Design-fixture builds only (`NEXT_PUBLIC_FIXTURES=1`): the story stage (`seeded`, `sold`, `borrowed`, `book`, `lp`, `pushed`, `proposed`, `fed`, `collapsed`) and who is signed in (`alice`, `bob`, `ravi`, `sam`, `uma`, `carl`, `dana`, `owner`) |

The first visit to `/` while signed out shows the landing instead of the home; `[data-demo="welcome-skip"]`
("Look around first") or `welcome=0` dismisses it.

## 3. Phone or desktop

The layout is chosen in script at 1024 px, so each screen renders one tree and there are no hidden duplicates.

- Phone (< 1024 px, e.g. 390 × 844): the grid on `/` is replaced by the futures strip and list; picking worlds happens
  in the picker on `/sell/` (`[data-demo="world-pick"]`) and `/orders/` (`[data-demo="book-pick"]`). Navigation is
  the floating pill at the bottom (`nav-trade`, `nav-sell`, `nav-borrow`, `nav-more` → `more-*`).
- Desktop: the grid cards (`[data-demo="world-card"]`) are the order form; the top bar has six links (`nav-trade`,
  `nav-orders`, `nav-borrow`, `nav-lend`, `nav-resolve`, `nav-admin`).

World-specific elements carry `data-world="<LABEL>"` (e.g. `[data-demo="world-card"][data-world="DELAYED·HOLDS"]`).
Ladder rows carry `data-side="bid|ask"`; event cards `data-event="<id>"`.

## 4. Transactions: one per action

There are no approvals on NEAR: every real-token action is a single `ft_transfer_call` (the tokens travel with the
instruction; unused tokens come back), so expect one signature per action.
Exceptions: the Root LP deposit is two (wNEAR deposit, then `lp_deposit`) unless the wNEAR already sits in the internal
balance; an account's first action adds a one-time NEP-145 storage registration (register personas off camera to
avoid it). Every transaction button (`TxButton`) shows its outcome in `[data-demo="<button hook>-result"]`:
`Done · <first 10 chars of the hash>…` (a link to nearblocks; plain text on the sandbox) or the contract's own error,
e.g. `StaleOrder(1, 0, 1)`. The accept box closes when its trade lands, so `accept-confirm-result` then sits under the
ladder. Owner "Resolve now" finalizes at once and its controls go away: wait for `event-badge` "Resolved: …". A
proposal with a countdown comes from the resolver's `report_outcome`.

## 5. Hooks by screen

### Shell
| Hook | What |
|---|---|
| `scenario-switch` | Scenario pill; opens a list with `scenario-2x2` ("SPICE × Fed (4 worlds)") and `scenario-binary` ("SPICE only (2 worlds)") |
| `connect`, `account` | Connect button / signed-in account button (`aria-label="Account <id>"`); `account` opens `account-sheet` |
| `account-sheet`, `account-id`, `disconnect`, `withdraw-inner-wnear`, `withdraw-inner-usdc` | Account sheet: id, balances, internal "In IfVerse" balance and its withdrawal |
| `test-tokens`, `get-test-tokens`, `faucet-progress` | Account sheet, testnet builds without design data: "Get test tokens" (mints 2,000 wNEAR and 5,000 USDC to the account itself, then registers it with IfVerse if needed) and one line per finished step |
| `status-bell` | Link to Resolve; shows a pulsing dot while a result is in its dispute window |
| `help` | Link to `/welcome/` |
| `fixture-picker`, `persona-<name>` | Design fixtures only: the "Sign in as" list |

### Landing (`/welcome/`, first visit to `/`)
`landing`, `landing-headline` ("HEDGE THE FUTURE YOU fear"), `split-art`, `landing-connect`, `landing-open`,
`welcome-skip`, `how-it-works`.

### Trade (`/`, `/sell/`, `/orders/`)
| Hook | What, and the text it carries |
|---|---|
| `trade` / `sell` / `orders` | The screen's `main` |
| `hero-spot` | "NEAR SPOT" numeral ("$3.0376" on the seeded chain, "$3.0378" in the design fixtures) and "implied by the four futures: $3.0376 ✓" (or the difference) |
| `balance-chips` | Wallet wNEAR, USDC, and "In IfVerse" when non-zero |
| `empty-wallet-hint`, `hint-test-tokens` | Testnet, connected wallet with no wNEAR and no USDC: the same "Get test tokens" button under the balances |
| `scenario-status` | "scenario {id} · {n} resolved", plus " · paused: resolution pending" while halted |
| `futures-strip`, `world-thumb` | Phone: small world cards (link to `/world/`) |
| `action-tiles`, `tile-protect`, `tile-back`, `tile-borrow`, `tile-lend` | Phone: Protect (sell), Back (buy), Borrow, Lend |
| `futures-list`, `future-row` | Phone: "Possible futures" rows, then "Resolved away" |
| `world-grid`, `grid-axes`, `axis-label`, `world-card`, `world-details` | Desktop grid: `grid-axes` names the rows' and the columns' question once, in full; `axis-label` is an outcome over a column or beside a row (the question in its `title`); card = `button[aria-pressed]` whose first line is the world label; "SELL"/"BOOK" tag when selected; `world-details` opens the world screen |
| `spot-stats`, `stat-actual-spot`, `stat-implied-spot`, `stat-impact`, `stat-backing` | "ACTUAL SPOT", "IMPLIED SPOT" ("odds × world prices …"), "IMPACT METER" ("gap between …", sparkline `role=img` "Impact meter history"), "EVERY WORLD BALANCES" ("✓ all backed") |
| `rules` | One paragraph per event: question, then the rule |
| `trade-aside`, `tab-sell`, `tab-book` | Desktop sheet with `button[role=tab]` "Sell" / "Order book" |
| `sell-panel`, `world-pick-grid`, `world-pick` | Sell form; phone picker pills = `button[aria-pressed]` with `data-world` |
| `sell-amount` | Amount input (`aria-label="Amount of NEAR to split"`), default "2000" |
| `sell-wallet` | "wallet: 2,000.00 wNEAR" (fills the input) |
| `sell-from-wallet`, `sell-from-inner` | Source switch, only when the internal wNEAR balance is non-zero |
| `sell-preview`, `sell-row` (`data-world`) | Per-world rows: "sell via a bid + pool → 4,881.88 USDC" / "keep → 2,000.00 NEAR", Fair price, You get, Cost / NEAR (prices to four decimals) |
| `plan-legs` | "bid #1 · 1,000.00 NEAR @ $2.4500 … 2,450.00 USDC", "pool · 1,000.00 NEAR … 2,431.88 USDC" |
| `sell-to-lending` | "Keep the result as loan collateral…" checkbox |
| `sell-confirm` | "Sell in 3 worlds" (or its blocker); result in `sell-confirm-result` |
| `order-panel`, `book-pick-grid`, `book-pick` | Order book; phone picker |
| `ladder`, `ladder-row` (`data-side`), `ladder-pool`, `accept` | Ladder: asks above "pool price", bids below; `accept` per row ("Accept") |
| `accept-box`, `accept-amount`, `accept-confirm` | "Buy from ask #2 at $3.7500" / "Sell into bid …"; input `aria-label="Amount of NEAR to trade with this order"`; "Confirm" |
| `post-form`, `post-bid-tab`, `post-ask-tab`, `post-price`, `post-amount`, `post-life`, `post-bid`, `post-ask` | "Post bid" / "Post ask"; "Price (USDC per NEAR)", "Amount (NEAR)", "Good for"; the crossing warning "This bid crosses ask #… at $…, which is already there." sits in `post-form` |
| `my-orders`, `cancel-order` | "Your orders here"; "Cancel" / "Cancel and take the escrow back" |

### World (`/world/?w=3`)
`world`, `world-carousel`, `world-detail-card` (`data-world`), `world-info` (price, "World info" rows),
`world-sell-here`, `world-buy-here`, `world-order-book`.

### Borrow (`/borrow/`)
| Hook | What |
|---|---|
| `hero-hf` | "HEALTH FACTOR (WORST WORLD)", the HF numeral ("∞", "1.22"), "worst world: DELAYED·HOLDS" |
| `badge-liquidatable`, `badge-paused` | "Liquidatable" / "Liquidation paused" |
| `borrow-stats` | debt, LLTV, borrow APR (fixed) |
| `borrow-worlds`, `collateral-bars` (`li[data-world]`), `liquidatable-banner` | "Collateral by world", bars with the dashed HF 1 line; "Health factor below 1: this loan can be liquidated…" |
| `posted-collateral` | "Posted collateral" list |
| `borrow-card`, `borrow-amount`, `borrow-max`, `hf-after`, `borrow-confirm` | "Borrow real USDC", "Amount (USDC)", "max $…", "health factor after", "Borrow" |
| `repay-card`, `repay-amount`, `repay-all`, `repay-confirm` | "Repay", "Amount (USDC), or “all”", "debt $…", "Repay" |

### Lend (`/lend/`)
`hero-supply-apr`, `lend-stats` with `stat-utilization` ("UTILIZATION"), `stat-supplied` ("YOU SUPPLIED"),
`stat-earned` ("YOU EARNED"); `supply-card`, `supply-amount`, `supply-confirm` ("Supply"); `withdraw-card`,
`withdraw-amount`, `withdraw-all`, `withdraw-confirm`; Root LP: `root-lp` ("Underwrite every world"), `lp-deposit`,
`lp-wnear` ("Amount (NEAR)"), `lp-usdc` ("Amount (USDC)"), `lp-deposit-confirm` ("Underwrite every world"),
`lp-position`, `lp-withdraw-all` ("Withdraw all"), `lp-table`.

### Resolve (`/resolve/`)
`hero-resolved`, `scenario-status` ("… · paused: resolution pending"), `resolve-futures` (phone list),
`world-grid` (desktop, read-only: no `aria-pressed`), `resolve-events`, `survivors` ("Only DELAYED·HOLDS is still
possible…"), `resolver-note`, `event-card` (`article`, `h3` question, `data-event`), `event-badge` ("Proposed: HOLDS",
"Resolved: HOLDS", "Open"), `dispute-ring` (`role=timer`), `event-status`, `finalize` ("Finalize in 0:21" → "Finalize
opens with the next block" → "Finalize"), `past-fed`; aside: `close-panel` ("Close and redeem"), `close-pieces`
("collapsed: redeemed 1:1 for real USDC"), `close-receive`, `close-confirm`, `close-result` ("Repaid $3,000.41;
redeemed 4,881.88 real USDC."), `wallet-redeem`, `redeem`.

### Admin (`/admin/`)
`owner-status` ("✓ Connected as the oracle owner"), `admin-events`, `resolve-controls`, `resolve-outcome` (outcome
chips, `aria-pressed`), `resolve-now` ("Resolve now: HOLDS"), `dispute` ("Dispute the proposal"); `price-push`,
`push-pick` (phone picker), `push-amount` (`aria-label="Amount of NEAR to sell in the picked world"`), `push-confirm`
("Push DELAYED·HOLDS down"), `push-result` ("DELAYED·HOLDS: $x → $y"), `mint-wnear` ("Mint 3,000.00 test wNEAR to my
wallet"); `demo-reset`, `reset-command`.

## 6. Load-bearing strings

The recorder may wait for these: the world labels with "·"; "wallet: 2,000.00 wNEAR"; "Sell in N world(s)";
"bid #"; "Keep the result as loan collateral"; "Done ·"; "You hold … here · loan collateral"; "Health factor",
"HEALTH FACTOR (WORST WORLD)", "worst world:"; "Liquidatable", "Health factor below 1"; "Borrow real USDC", "Amount
(USDC)", "Supply USDC", "UTILIZATION", "YOU SUPPLIED", "YOU EARNED"; tab "Order book" (`button[role=tab]`, desktop),
"Order book · SHIPS·CUTS", "Post ask", "Post bid", "Price (USDC per NEAR)", "Amount (NEAR)", "Buy from ask", "Confirm";
"Underwrite every world", "Amount (NEAR)", "Withdraw all"; "Connected as the oracle owner", "Mint 3,000.00 test wNEAR",
"Push DELAYED·HOLDS down", "DELAYED·HOLDS: $"; "Finalize in", "Finalize", "Resolved", "paused: resolution pending",
"Only DELAYED·HOLDS is still possible", "collapsed: redeemed 1:1", "Close and redeem", "Repaid $", "Demo reset";
"ACTUAL SPOT"/"real wNEAR", "IMPLIED SPOT"/"odds ×", "IMPACT METER"/"gap between", "EVERY WORLD BALANCES"/"live tokens";
"SPICE × Fed (4 worlds)", "SPICE only (2 worlds)" (inside the scenario list); the event questions and
rules come from the chain.
