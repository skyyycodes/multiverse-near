# Multiverse NEAR: roadmap ideas (not built)

Ideas for after the hackathon. None of this is in the contract; today only the owner creates events,
scenarios and pools (`assert_owner()` in `oracle.rs`, `core.rs`, `amm/create.rs`).

## 1. User-proposed, crowd-funded markets

Problem: if a user's fear has no event listed, they cannot hedge it. Only the admin lists markets.

Flow:

1. **Propose**: question + exact yes/no rule + public data source + deadline.
   A small deposit stops spam; it is returned if the market is accepted.
2. **Pledge**: people lock real money ("500 USDC if it opens"), not free upvotes.
   Both sides pledge: the fearful (want protection) and the confident (want to buy cheap).
3. **Check**: admin checklist: clear yes/no? public data source? can anyone fake or cause the outcome?
4. **Open**: the market starts with the pledged money already in its pools.
5. **Resolve**: from the public data (as the October Fed event did through OutLayer + FRED), not a person.

Holes this closes:

- Fake upvotes (Sybil): voting costs locked money.
- Empty markets: pledges become the starting liquidity.
- One-sided markets: both sides are invited to pledge, so hedgers have someone to trade with.
- Self-caused outcomes ("will X get hacked"): rejected at the check step.
- Admin deciding results: data-source requirement.

Still open: the admin is still the gate at step 3 (could become a DAO / multisig vote later).


### Two kinds of proposal

Users can propose both:

| | A. Brand-new event | B. Combination of existing events |
|---|---|---|
| Example | "Will NEAR hit 1B transactions by June?" | "SPICE x Fed" from two events that already exist |
| Check step | Full admin check: clear yes/no, public data source, nobody can cause the outcome | None needed: both events were already checked |
| Opens when | Admin approves AND pledges reach the goal | Pledges reach the goal, **automatically, no admin** |
| Contract change | Permissionless proposal + pledge escrow | Same, plus a permissionless `create_scenario` for pledge-funded combos (today it is owner-only) |

Rules for B (combinations):

- Both events must still be open; `create_scenario` fails with `EventNotOpen` if either is finalized or has an
  open proposal. If one resolves before pledging finishes, refund every pledge.
- Order is part of a scenario's identity in the contract ("SPICE x Fed" and "Fed x SPICE" are different
  scenarios), so the proposal flow must catch duplicates in either order and send people to the existing market.
- At most 16 scenarios per event (`MAX_SCENARIOS_PER_EVENT`). If a popular event fills up, the most-pledged
  proposals open first.
- Show both events' deadlines before anyone pledges: if one resolves much sooner, the combo soon becomes a
  single-event market.

Where it lives in the app (idea 4): on a market page, under "Related markets", a "+ Combine this event with
another" button (B) next to the open and pledging combos; on the market list, a "Propose a new market"
button (A).

## 2. More than 2 events per scenario

### Today: at most 2 events (4 worlds)

`contracts/multiverse/src/masks.rs` sets `MAX_WORLDS = 4` and `MAX_EVENTS = 2`; `create_scenario` in `core.rs`
refuses more with `BadEventCount` or `TooManyWorlds`. Separate scenarios are unlimited (the demo runs a 2x2
SPICE x Fed scenario and a SPICE-only scenario side by side), but one scenario cannot combine 3 events.

### Why worlds are the cost

Every yes/no event doubles the worlds: 1 event = 2, 2 = 4, 3 = 8, 4 = 16, 5 = 32, 10 = 1,024.

Every world needs its own world pool, and the odds pools form a tree with one pool per split (worlds - 1).
So a full scenario needs `2 x worlds - 1` pools:

| Events | Worlds | World pools | Odds pools | Pools to fund |
|---|---|---|---|---|
| 1 | 2 | 2 | 1 | 3 |
| 2 | 4 | 4 | 3 | 7 |
| 3 | 8 | 8 | 7 | 15 |
| 4 | 16 | 16 | 15 | 31 |
| 5 | 32 | 32 | 31 | 63 |

Four costs grow with the worlds:

1. **Thin money (the main one).** The same starting money is split across every pool. $100,000 gives $25,000
   per world at 4 worlds, $12,500 at 8, $6,250 at 16. Thin pools give bad prices: even today, 2,000 NEAR into the
   DELAYED·HOLDS pool alone averaged 2.3741 against a listed 2.50 (about 5% less).
2. **Work per transaction (gas).** One click splits into every world, trades in several pools, and the loan
   check values every collateral piece in every world to find the worst one. More worlds, more work in one
   transaction. Not measured beyond 4 worlds.
3. **Screens people can read.** A 2x2 grid fits a phone. 3 events is two 2x2 grids side by side (still
   readable). 4 events is a 16-cell grid of four-part names: almost nobody can reason about it.
4. **Real fears are about 1 or 2 things.** "SPICE slips AND the Fed holds" is a normal worry; "A and B and C
   and D" is rare.

### Why 3 is the next step

- **The world sets already have room for 8 worlds.** A set of worlds is stored as an 8-bit mask (`u8` in
  `masks.rs`): one bit per world, so 8 worlds = 3 binary events fits the existing format and the existing
  token ids (`{scenario}:{asset}:{mask}`, mask up to 255).
- **The money roughly doubles, it does not explode.** 15 pools instead of 7.
- **It is still explainable.** Two 2x2 grids: "the SPICE x Fed grid if the ETF is approved, and the same grid
  if it is not."
- **Not a one-line change.** Raising the two constants is the start; the odds tree, the views, the web grid and
  the tests were written for 4 worlds or fewer and must be checked, and gas must be measured at 8 worlds.

### Why not more than 3

- **The format runs out.** 16 worlds needs 16 bits per world set: every mask, token id, storage key and
  view changes (`u8` to `u16`). That is a redesign, not a constant.
- **The money runs out.** 31 pools at 4 events, 63 at 5; each needs real money in it or it is useless.
- **The screen runs out.** No grid a person can read on a phone.
- **The gas is unknown.** Every per-world loop in one transaction doubles again.

### How to go past it later

1. **Group worlds instead of opening every world.** The contract already supports vouchers on several worlds at
   once (Alice's sale uses mask 14 = three worlds). Open pools only on the groups people trade ("everything
   bad" vs "everything good") instead of one pool per world.
2. **Tie it to pledges (idea 1).** A 3-event scenario opens only once enough money is pledged to fill all 15
   pools.


## 3. Lending and liquidation before real money

What the code does today (checked 13 Nov):

- Anyone can liquidate: `ft_transfer_call` on the USDC token with the action `liquidate` (scenario, borrower,
  repay amount or max = half the debt). No owner check (`liquidate_for` in `contracts/multiverse/src/lending.rs`).
- A bot can check one account with `liquidation_status(scenario, account)` (None / Liquidatable / PausedHalted /
  PausedNoPrice) and `health_factor(scenario, account)`.
- `scripts/e2e.ts` runs a liquidation (Leo liquidates Carl) and can serve as a template.
- The liquidator pays its own USDC and receives the same fraction of every collateral piece, worth repay x 1.05.
  The borrower pays the bonus; the protocol pays nothing. All interest goes to lenders; there is no reserve.

### Gaps

| # | Gap | Who it hurts | Where |
|---|---|---|---|
| G1 | No list of borrowers: a bot must rebuild it from `borrow` events | Liquidators | no view exists |
| G2 | No bot script, no Liquidate button (the app only shows a "Liquidatable" badge on your own Borrow screen) | Liquidators | `scripts/`, `web/src/components/borrow/BorrowScreen.tsx` |
| G3 | Liquidator is paid in verse tokens; turning them into real USDC before resolution takes extra trades and a matching merge | Liquidators | `liquidate_for` |
| G4 | Lending reads a 30-minute TWAP, so liquidation lags a fast crash | Lenders | ECON-1/2 in `docs/SECURITY.md` |
| G5 | Liquidation pauses while a proposal is open or a world has no price (depth < 10,000 USDC-if-w or tick > 953 from TWAP) | Lenders | `liquidation_status` |
| G6 | Liquidations that cannot clear rounding dust fail (`LiquidationTooSmall`); small loans pay a tiny bonus | Lenders | `risk::is_too_small` |
| G7 | Bad debt is never written off: leftover debt stays on the account and still counts as owed | Lenders | `liquidate_for` |
| G8 | Lenders withdraw only idle USDC (`InsufficientLiquidity`): first out gets paid, last out waits | Lenders | `withdraw_supply_for` |
| G9 | Prices come only from in-protocol pools: holding one world down for a full TWAP window can liquidate a healthy borrower (accepted residual risk) | Borrowers | ECON-2 |

### Fixes (not built)

| # | Fix | Closes | Cost | Effort |
|---|---|---|---|---|
| F1 | Borrower index view, paginated, with an "HF below x" filter | G1 | storage per borrower (NEP-145 deposit) | small |
| F2 | Open-source `scripts/liquidator.ts` + an "At-risk loans" page with a Liquidate button; the team runs a backup keeper | G2 | none | small |
| F3 | `receive: "cash"` option: sell seized NEAR pieces in world pools, merge matching USDC-if-w into real USDC, pay out, with `min_out` | G3 | more gas; slippage in thin pools | medium |
| F4 | Borrow against min(spot, TWAP); keep TWAP for liquidation but lower LLTV 0.75 → 0.65 | G4 | borrowers get less per voucher | small |
| F5 | When a world has no trusted price, value it at a haircut (e.g. 20% under the lowest recent price) instead of pausing; keep the dispute-window halt (swaps stop too) | G5 | conservative valuations | medium |
| F6 | Sanity check: implied spot vs an outside NEAR feed (e.g. Pyth); > ~10% apart pauses new borrowing; raise depth gate 10,000 → 50,000 | G9 | depends on an outside feed | medium |
| F7 | Minimum loan (e.g. $100); allow 100% liquidation when the loan is small or HF < 0.9 | G6 | small borrowers excluded | small |
| F8 | Insurance fund (e.g. 10% of interest) absorbs bad debt first; then write off the rest across all lenders at once | G7, G8 | lenders earn ~4.5% instead of 5% | medium |
| F9 | Utilization-based rate (low when cash is plentiful, 50%+ near empty) instead of the fixed 5% | G8 | variable rate for borrowers | medium |

Priority before real money: F8, F9, F7, F1+F2, F4, then F3/F5/F6.


## 4. Separate markets per event, related markets, and a market list instead of a dropdown

### The idea

- Each event can also be its own market. Someone who only cares about SPICE trades "SPICE only"; someone who only
  cares about the Fed trades "Fed only"; someone who fears the combination trades "SPICE x Fed". Nobody is forced
  into worlds they do not care about.
- On a market's page, show **related markets** below it: every other market that uses one of the same events
  (SPICE only → SPICE x Fed, SPICE x ETF, ...).
- Replace the header dropdown with a **browsable market list**: one card per market, a page per market.

### What the code already supports (checked 13 Nov)

- **Contract: yes.** A scenario may have 1 or 2 events, so the owner can already create a Fed-only scenario next
  to SPICE x Fed (`create_scenario` in `core.rs`). The demo already runs SPICE x Fed (4 worlds) and SPICE only
  (2 worlds). Up to 16 scenarios may use one event (`MAX_SCENARIOS_PER_EVENT`).
- **Contract views for a list exist:** `scenario_count`, `get_scenario(id)`, `event_count`, `get_event(id)`, and
  `scenarios_of_event(event_id)`, which is exactly "related markets".
- **Web app: no.** `web/src/components/shell/ScenarioSwitch.tsx` is a header pill with two hard-coded options
  ("SPICE × Fed (4 worlds)", "SPICE only (2 worlds)"), and `useScenario.tsx` types the choice as
  `"2x2" | "binary"`. A new scenario on-chain never appears in the app without a code change.

### Note: separate markets do not share money

Each scenario has its own pools, odds, order book and lending market. A Fed-only market and SPICE x Fed do not
share liquidity, so every extra market needs its own starting money (see idea 1 pledges and idea 2 costs).

### UI proposal (prediction-market style browsing, own design)

Home = market list:

- One card per market: the question(s), the odds of each outcome, NEAR's price in each world (or the implied
  spot), money in the pools, deadline, status (open / deciding / resolved).
- Filters and search: single event vs combination, category (NEAR ecosystem, macro, ...), open vs resolved,
  sort by money in pools, by deadline, by newest.
- Cards come from the contract views above, not a hard-coded list.

Market page:

- Top: the question, the resolution rule and data source, the deadline, the odds.
- Middle: the existing world grid, sell / buy, order book, borrow.
- Bottom: **Related markets** from `scenarios_of_event` for each of its events, e.g. on "SPICE only":
  "SPICE x Fed (4 worlds)", "SPICE x ETF (4 worlds)", each with its odds and money in the pools.
- URL per market (`/market/<scenario id>/`) so a market can be shared and linked.

Tie-in with idea 1: the list also shows **proposed markets** collecting pledges, with a progress bar
("38,200 / 50,000 USDC pledged").

### Wireframes

Today (header dropdown, two hard-coded options):

```
 ┌──────────────────────────────────────┐
 │ [● SPICE × Fed ▾]          [Connect] │
 │   ├ SPICE × Fed (4 worlds)  ✓        │
 │   └ SPICE only (2 worlds)            │
 └──────────────────────────────────────┘
```

Home: market list

```
 ┌──────────────────────────────────────────────────────────┐
 │ Multiverse                      [Search markets…] [Connect]│
 │ [All] [Single event] [Combos] [NEAR] [Macro] [Pledging]   │
 │ Sort: Money in pools ▾                                     │
 ├──────────────────────────────────────────────────────────┤
 │ ┌─────────────────────────┐  ┌─────────────────────────┐  │
 │ │ Will SPICE ship by       │  │ Will the Fed cut in      │  │
 │ │ Mar 31, 2027?            │  │ December?                │  │
 │ │ SHIPS 67%  DELAYED 33%   │  │ CUTS 1%   HOLDS 99%      │  │
 │ │ NEAR: $3.40 | $2.80      │  │ NEAR: $3.50 | $2.90      │  │
 │ │ 42k USDC · ends Mar 31   │  │ 18k USDC · ends Dec 10   │  │
 │ │ 2 worlds · Open          │  │ 2 worlds · Open          │  │
 │ └─────────────────────────┘  └─────────────────────────┘  │
 │ ┌─────────────────────────┐  ┌─────────────────────────┐  │
 │ │ SPICE × Fed   (combo)    │  │ SPICE × ETF  (pledging)  │  │
 │ │ 4 worlds  ▢▢ ▢▢          │  │ ████████░░ 38.2k / 50k   │  │
 │ │ Implied NEAR $3.04       │  │ USDC pledged             │  │
 │ │ 12k USDC · Open          │  │ [Pledge]                 │  │
 │ └─────────────────────────┘  └─────────────────────────┘  │
 │                                   [+ Propose a new market] │
 └──────────────────────────────────────────────────────────┘
```

On a phone the cards stack in one column and the filter chips scroll sideways.

Market page (`/market/<scenario id>/`)

```
 ┌──────────────────────────────────────────────┐
 │ ← All markets                                 │
 │ Will SPICE ship on NEAR mainnet by Mar 31?    │
 │ Rule: … · Source: … · Ends Mar 31, 2027       │
 │ SHIPS 67%  ·  DELAYED 33%      [Share link]   │
 ├──────────────────────────────────────────────┤
 │  World grid · Sell / Buy · Order book · Borrow│
 │  (the screens that exist today)               │
 ├──────────────────────────────────────────────┤
 │ Related markets                               │
 │  SPICE × Fed     Open      12k USDC   [Open]  │
 │  SPICE × ETF     Pledging  38.2k/50k  [Pledge]│
 │  [+ Combine SPICE with another event]         │
 └──────────────────────────────────────────────┘
```

The numbers in the wireframes are placeholders, not demo values.

Effort: medium, web only (contract views already exist). Make sure each market page and the world grid still
read well on a phone.


**Decision (13 Nov):** every new market, including a separate single-event market like "Fed only", is funded
through the pledge flow of idea 1. It opens only once pledges cover the starting money for all its pools
(2 pools + 1 odds pool for a single event, 7 for a 2-event combination), so no market opens empty.

## 5. Lending tiers instead of one fixed 75%

### Today

Each scenario has one USDC lending market with one LLTV, 0.75 (`params.lltv`, used in `HF = C_min x LLTV / debt`),
and one fixed 5% rate. Every loan in every market lends 75% of its worst world, whatever the market's depth,
how jumpy its prices are, or how close it is to resolution.

### The fix: three tiers per market

```
 Safe tier     60%   low interest
 Normal tier   70%   medium interest
 Bold tier     80%   high interest
```

- Each scenario gets three lending pools instead of one, each with its own LLTV.
- **Lenders** choose a tier when they supply ("I'm careful: Safe").
- **Borrowers** choose a tier when they borrow ("I need more cash: Bold"). A loan and its collateral live in one
  tier; health factor and liquidation use that tier's LLTV.
- **Interest is set per tier by demand** (the utilization-based rate of fix F9 in idea 3): if everyone wants Bold,
  Bold's rate rises until lenders come in or borrowers leave. The back and forth happens through rates, not
  one-by-one offers.
- Borrowing stays instant (borrow from the tier's pool), and lenders still just deposit and withdraw.

Tier levels are per market, not fixed forever: a deep, calm market could offer 65/75/85, a thin or jumpy one
50/60/70.

### Considered and not picked: free bidding

Lenders posting individual offers ("60% at 4%", "75% at 8%") and borrowers picking one. Not picked because:
borrowing waits for offers instead of being instant; ordinary lenders cannot price per-world risk; every loan has
its own threshold (more liquidation code, more room for bugs); and a lender's money is locked in specific loans
until they are repaid.

### Cost

- Three markets per scenario instead of one: lender money splits three ways (thinner per tier).
- Contract change: lending state keyed by (scenario, tier); views and the Borrow / Lend screens gain a tier picker.
- Liquidation bonus may need to differ per tier (Bold needs a bigger cushion for liquidators).


## 6. More demo markets, so the story is easy to explain

### Today

The demo seeds three events (`scripts/lib/demo.ts`) and two scenarios:

- Events: "Will SPICE ship on NEAR mainnet by Mar 31, 2027?", "Will the Fed cut at its December meeting?",
  and the past "Did the Fed cut at its October 27-28, 2026 meeting?" (resolved HOLDS from FRED through OutLayer).
- Scenarios: SPICE x Fed (4 worlds) and SPICE only (2 worlds). There is no Fed-only market, and the past Fed event
  shows only on the Resolve screen.

### Demo set (one market per idea to show)

| Market | Kind | Shows |
|---|---|---|
| SPICE only | single event, open | the basic split: NEAR if SHIPS / NEAR if DELAYED (LEARN.md lessons 4-6) |
| Fed only (December) | single event, open | someone who only cares about the Fed is not forced into SPICE worlds (idea 4) |
| SPICE x Fed | combo, open | 4 worlds, Alice's sale, worst-world borrowing (LEARN.md lessons 7-10) |
| October Fed (past) | single event, **resolved** | the end state: dead worlds, surviving vouchers redeem 1:1, resolved from real data |
| A second NEAR-ecosystem event, e.g. a usage milestone with a public data source | single event, open | the list is not just two questions; related markets for a non-SPICE event |
| SPICE x that event | combo, open | "related markets" under SPICE lists two combos, not one |

Mix of states on purpose: open, deciding (a proposal in its dispute window, if timed for the demo), resolved.

### Depends on

- **Idea 4's market list.** The app's `ScenarioSwitch.tsx` has two hard-coded options, so new scenarios seeded
  on-chain do not appear in the app until the dropdown is replaced by a list built from `scenario_count` /
  `get_scenario`.
- **Seed changes.** `scripts/lib/demo.ts` and `scripts/lib/seed.ts` gain the new events, scenarios and pools; each
  new market needs starting money in all its pools (3 for a single event, 7 for a combo). On testnet the mock
  tokens are free to mint, so money is not the limit, time is.
- **Every new event needs a clear rule and a resolution path.** New future events resolve from
  `deployments/demo-outcomes.json` like SPICE does today (the app says so); only past events can resolve from
  real data.
- **README.** The "Do X - see Y" steps, the scenario ids and the demo numbers must be re-checked after reseeding.
