# How IfVerse works

This is the design of the contract in `contracts/multiverse` and the maths in `crates/multiverse-math`. What is
specific to NEAR is called out where it matters.

## Units

Every amount inside the contract is an 18-decimal integer, for both assets. A token may have 0 to 24 decimals, and
real amounts are converted once at the NEP-141 boundary with `AssetCfg::to_internal` and `AssetCfg::to_raw`:

- Up to 18 decimals (USDC has 6): `internal = raw * 10^(18 - d)` on the way in, exact. On the way out
  `raw = floor(internal / 10^(18 - d))`; the remainder stays in the account's internal balance as dust, which a later
  withdrawal can pick up.
- Above 18 decimals (wNEAR has 24): `internal = floor(raw / 10^(d - 18))` on the way in. The remainder
  `raw % 10^(d - 18)` never enters the ledger: `ft_on_transfer` returns it as unused and the token contract sends it
  back. On the way out `raw = internal * 10^(d - 18)`, exact, so there is no dust. A failed payout credits back
  exactly the internal amount that was sent.

Prices are WAD-scaled USDC per NEAR (1e18 = 1 USDC per NEAR); a demo price is a few dollars. Fees are in pips
(1,000,000 = 100%). Time is whole seconds of block time. Amounts are `u128`, written as decimal strings (`U128`) in
JSON. Products go through `mul_div` at 256 or 512 bits, so only the final quotient has to fit. Rounding always
favours the protocol: what a user receives rounds down, what a user pays rounds up.

## Events, worlds and masks

An event is a yes/no question with two named outcomes, a rule saying how it resolves, and an informational
deadline. A scenario combines one or two events. Each combination of outcomes is a world, numbered from 0: in the
demo's 2x2 scenario (SPICE, then the Fed) world 0 is SHIPS·CUTS, 1 is DELAYED·CUTS, 2 is SHIPS·HOLDS and 3 is
DELAYED·HOLDS. A scenario has at most two events and four worlds.

A set of worlds is a bit mask: bit `w` set means world `w` is in it. Mask 14 (`0b1110`) is DELAYED·CUTS,
SHIPS·HOLDS and DELAYED·HOLDS, the "L-shape" Alice sells in. The root mask (all worlds) is the real asset itself and
never exists as a token.

A verse is one asset on one mask of one scenario: wNEAR-if-14 pays one wNEAR if the world that comes true is in mask
14. Each verse is a NEP-245 token with id `{scenario}:{asset}:{mask}`, for example `1:wnear:14`, with 18 decimals.

A scenario keeps `possible`, the mask of worlds that can still happen. A verse is live while its mask touches
`possible`, dead once it does not, and collapsed once it covers every possible world.

## Split, merge, redeem

- **Split** turns an amount on one mask into the same amount on each part of a partition of it. Splitting from the
  root takes real tokens, which go into the scenario's reserves. The parts must be non-empty strict subsets of the
  parent, live, pairwise disjoint, and together cover every possible world of the parent (dead worlds can ride along
  without cover).
- **Merge** is the reverse: equal amounts of the parts become the parent. Merging into the root pays out real
  tokens from the reserves.
- **Redeem** pays one real token per collapsed verse token. After resolution, the verse that covers the surviving
  world is collapsed and redeems 1:1.

Split and merge only burn and mint, one for one, with no rounding. Reserves move only on a root split, a merge to
root and a redeem. That keeps invariant 1: in every possible world, the supply of verse tokens covering that world
equals the reserves.

## Pools and fees

All pools are constant-product pools with the semantics of a full-range concentrated-liquidity position
(`x * y = L^2`). The fee
is taken from the input and kept outside the curve for the liquidity providers, outputs round down, and a quote runs
the swap maths on the same state, so a quote equals execution. A pool is born with liquidity from the owner, so its
first price is the ratio of what the owner put in.

- **World pools** (within-world): wNEAR-if-w against USDC-if-w, one per world. Their price is NEAR's price in that
  world. Lending reads their TWAP.
- **Odds pools** (between-world): USDC-if-X against USDC-if-Y for two disjoint verses. Their price is how likely X is
  against Y.
- **Spot pool**: real wNEAR against real USDC from internal balances, with a fixed 0.30% fee. The owner can move it to
  a target price (`move_spot_to`).

Verse pools charge a dynamic fee. A pool remembers the signed flow of its last 8 swaps in its token0 (the wNEAR side
of a world pool). The next swap pays `base + ceil((cap - base) * |net| / total)`, with base 0.30% and cap 1.50%:
balanced flow pays the base, one-sided flow pays the cap. After Alice's sale the three pools she sold into all
charge 1.50%.

Swaps in verse pools stop while the scenario is halted and in any pool that touches a dead verse. Adding, removing
and collecting liquidity always work.

## TWAP

Each verse pool keeps a ring of up to 128 observations of cumulative tick-seconds, written after every swap. At most
one observation counts per second, so a swap and its reversal in the same block move the mean by nothing.
Observations are spaced at `window / 64` seconds, so the ring always spans two windows however often the pool
trades.

Lending prices wNEAR in world `w` from the world pool's mean tick over a 30-minute window (`twap_window_sec` 1800):

- the pool must be at least 60 s old (`twap_min_age_sec`); until it is a full window old, the mean runs over its
  whole history;
- the current tick must be within 953 ticks (a factor of about 1.1) of the mean, or the world has no price;
- the pool must hold at least 10,000 USDC-if-w right now (the depth gate), or the world has no price.

A world without a price counts zero toward borrowing and pauses liquidation in that scenario. The 30-minute window
and the spot band came out of the internal security review (ECON-1 and ECON-2 in `docs/SECURITY.md`); the
prototype used 60 s.

## Odds and the implied spot

The odds pools form a tree from the root: in the 2x2 demo, CUTS (mask 3) against HOLDS (mask 12), then SHIPS·CUTS
against DELAYED·CUTS and SHIPS·HOLDS against DELAYED·HOLDS. A pool with reserves `r_x, r_y` gives X the share
`r_y / (r_x + r_y)` of its parent. A world's odds are the product of the shares down its branch, and the second
child of each split takes `parent - first`, so the odds add up to exactly 100%. A split with a dead side needs no
pool; a split between two live verses without a pool makes the odds unknown, never guessed.

The implied spot is the sum of odds times world price. The app shows it next to the actual spot pool price; when
they drift apart, one of them is mispriced. The seed script sets the spot pool to the 2x2 implied spot (about 3.04 USDC per NEAR
in the demo).

## Order book

Limit orders on any live non-root verse of a scenario. A bid buys wNEAR-if-mask at a price in USDC per wNEAR and
escrows USDC-if-mask; an ask sells wNEAR-if-mask and escrows it. Escrow leaves the maker's balance and sits in the
order. Only the USDC leg rounds: whoever pays USDC pays the ceiling, whoever is paid from a bid's escrow gets the
floor, so an open bid always covers every fill still possible.

An order fills only in the epoch it was posted in (the scenario's resolution count), before its expiry, while its
verse is live and while no proposal is open. Posting and cancelling work at any time. Orders must be at least
0.001 wNEAR and 0.0001 USDC of notional; a maker may have 64 open orders. Closed orders stay stored for `get_order`,
but every read goes through indexes of open orders. `trade_view` shows each world's best 25 bids and asks.

## Router

The router is what makes one signature enough. `conditional_sell` takes wNEAR (attached through `ft_transfer_call`,
or from the internal balance), splits it from root into every possible world, and in each world of `sell_mask`
fills the planned orders first and sends what is left into the world pool. Each traded world must pay at least its
`min_out`. The result stays in the user's ledger or, with `to_lending`, becomes loan collateral. `conditional_buy`
is the same with USDC and asks. `sell_and_borrow` is a sale into lending followed by a USDC loan paid to the wallet.
`post_order` from real assets splits the escrow into `[mask, every other possible world]` and keeps the rest for the
sender. `close_after_resolution` repays the debt, takes every collateral piece back, redeems the collapsed ones and
pays the real tokens out.

Each of these is one synchronous call inside one contract. If any check fails (a planned order was taken, an output
is below `min_out`, the loan would be unhealthy), the call panics, nothing changes, and inside `ft_on_transfer` the
token contract refunds the whole transfer. Plans are strict: an order that was filled, cancelled, expired or went
stale fails the trade and the app plans again. A trade logs its NEP-245 transfers as one batched line, so the
heaviest plan the app builds (four worlds, five fills each) stays inside a receipt's 100-line log limit.

## Lending and worst-world health

Each scenario has one market for real USDC, with no creation step. Lenders supply USDC and receive shares. Borrowers
post collateral pieces: live verse tokens of the scenario, or real wNEAR or USDC. Up to 16 pieces per account and
market.

Each piece is valued in every possible world: wNEAR-if-mask is worth `amount * price_w` in the worlds of its mask and
nothing elsewhere; USDC-if-mask is worth `amount` there; real wNEAR and USDC count in every world. The account's
value in world `w` is the sum, and `C_min` is its lowest value over the possible worlds. Then

```
HF = floor(C_min * LLTV / debt)        LLTV = 0.75
```

Borrowing and withdrawing collateral require HF >= 1 afterwards. Because the loan is judged by the worst world, it
is covered whatever happens; resolution only removes worlds, so it can only raise `C_min` and the health factor
(invariant 3).

In the demo Alice sells 2,000 NEAR in the L-shape, and her worst world is DELAYED·HOLDS, where she holds 4,881.88
USDC-if-DELAYED·HOLDS. A 3,000 USDC loan gives HF = 4,881.88 * 0.75 / 3,000 = 1.22, and she could borrow up to
3,661.41.

Interest is one fixed rate, 1,585,489,599 per second in WAD units (5% a year), simple over each interval and
compounded at every touch; all of it goes to lenders. Shares use virtual offsets (1e6 shares and 1 unit of assets)
so a first depositor cannot inflate the share price. Views add pending interest without writing.

## Liquidation

Below HF 1 anyone can liquidate, unless the scenario is halted (an open proposal: resolution can only raise HF, so
liquidating in the dispute window would front-run it) or a world has no price. The liquidator repays `r`, at most
half the debt, and takes the same fraction of every collateral piece:

```
target = floor(r * (1 + bonus))        bonus = 0.05
f      = min(1, target / C_min)
```

Cutting every piece by the same fraction keeps the worst world worst, so the slice is worth at least `target` in
every possible world, give or take rounding dust (an allowance rejects liquidations too small to clear it). Verse
pieces land in the liquidator's ledger, real pieces in the liquidator's internal balance. Invariant 4 checks the
coverage on random histories. When `C_min` is below the target, the liquidator takes everything and the shortfall
is bad debt; the property test counts and prints those cases.

In the sandbox e2e run of 2026-11-12, Carl borrows 1,799.32 USDC against 1,000 real wNEAR, the owner pushes
DELAYED·HOLDS down by selling 3,000 NEAR into it, and after the TWAP catches up Carl is at HF 0.86. Leo repays half the
debt and Carl's HF rises to 0.93 (on testnet the same flow borrowed 1,785.34 USDC and ended at 0.95).

## Root LP

The Root LP vault provides liquidity in every world of a scenario from one deposit of real wNEAR and USDC. The
deposit is split from root into every live world and added to each world pool at that pool's own price, one vault
position per pool. What a pool cannot take comes back: the part every live world has left over as the real asset
(merged), the rest as world tokens. A share is a claim on `1 / supply` of every live world's position, idle tokens
and uncollected fees. The first deposit locks 1,000 shares that belong to nobody, so the supply never returns to
zero. Fees are collected into the vault before each deposit or withdrawal is priced, so they belong to whoever held
shares while they accrued. After a full resolution, withdrawals pay real assets only.

## Oracle and the dispute window

An outcome becomes final in one of three ways:

1. The reporter account proposes it with `report_outcome(event_id, outcome, target, evidence)`. `target` must be
   this contract's own account id, and `evidence` (at most 512 bytes) is logged.
2. OutLayer proposes it: `request_resolution` sends the pinned guest to OutLayer, and `on_outlayer_result` turns a
   valid answer into a proposal with source `outlayer`. A failed run, `null` or a malformed answer is logged and
   dropped; the callback never panics.
3. The owner calls `admin_resolve`, which finalizes at once.

A proposal is open for the dispute window (30 s on testnet). While it is open, every scenario using the event is
halted: swaps in its pools, order fills and liquidations stop. Before the window ends only the owner can `dispute`
(cancelling the proposal; a new one may follow); from that second on anyone can `finalize`. Finalizing an event
resolves every scenario that uses it: worlds whose outcome for that event differs are removed from `possible`, the
resolution count (the order book's epoch) goes up, and verses that lost all their worlds are dead.

The off-chain resolver (`scripts/resolver.ts`) reads FRED for the real-data event: CUTS only if both DFEDTARU and
DFEDTARL are lower after the meeting than before, HOLDS if neither is, nothing if they disagree or a row is missing.
Rates are compared as whole basis points. It maps the answer to an outcome by name and checks the event's question
first, and signs with a function-call key that can only call `report_outcome` and `finalize`.

## Real tokens in and out

Real wNEAR and USDC enter only through `ft_transfer_call`. `ft_on_transfer` accepts calls only from the two configured
token contracts, credits `to_internal` of the amount to the sender's internal balance, runs the action named in `msg`
for the sender, and returns the whole token units of this transfer that the action did not use, plus any remainder
below one internal unit; the token contract sends those back. A transfer worth less than one internal unit fails
with `ZeroAmount`. An empty `msg` is a plain deposit. Unknown actions and unknown fields fail with `BadMessage`.

Real tokens leave through `payout`, always after every state change: `to_raw` gives the whole token units that go
out with `ft_transfer` (1 yoctoNEAR, 10 Tgas), and `on_payout` (5 Tgas) credits the amount back to the internal
balance if the transfer failed, typically because the receiver is not registered with the token. `withdraw` retries from there.

## Storage

The contract implements NEP-145. An account registers with `storage_deposit` (minimum 0.1 NEAR) before its first
action. Every state-changing entry point measures storage before and after: the bytes it adds are charged to the
payer (the caller, or the sender of an `ft_transfer_call`) and fail the call with `InsufficientStorage` if the
deposit does not cover them; the bytes it frees are credited back. Callbacks that write for an account
(`on_payout`, `mt_resolve_transfer`) charge that account without failing. Zero balances are deleted so they stop
costing storage. Owner methods that create events, scenarios and pools need an attached deposit, which a
function-call key cannot provide.

## One contract

Pools, the order book, lending and the vault live in one account because cross-contract calls on NEAR are
asynchronous: each runs in a later receipt and its failure does not undo the caller. A sale that splits, fills,
swaps, posts collateral and borrows would need a callback and a compensation path at every step across separate
contracts. In one contract it is a single function call. The views are also one call per screen (`trade_view`,
`borrow_view`, `lend_view`, `resolve_view`, `admin_view`), since NEAR RPC has no batching; each reads the same state
the actions use.
