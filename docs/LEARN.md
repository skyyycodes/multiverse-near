# Multiverse Lending on NEAR, from zero

A step-by-step guide for someone new to crypto. One idea per lesson, each building on the one before, with the
questions a newcomer usually asks along the way.

The numbers come from the project's demo on NEAR testnet. The tokens there are mock tokens with no real value.

---

## Contents

1. [Two coins](#lesson-1-two-coins)
2. [Future events move the price](#lesson-2-future-events-move-the-price)
3. [The usual tools don't fit](#lesson-3-the-usual-tools-dont-fit)
4. [Splitting 1 NEAR into vouchers](#lesson-4-splitting-1-near-into-vouchers)
5. [Swapping the voucher you don't want](#lesson-5-swapping-the-voucher-you-dont-want)
6. [The day the result comes out](#lesson-6-the-day-the-result-comes-out)
7. [Two events, four worlds](#lesson-7-two-events-four-worlds)
8. [Borrowing against your vouchers](#lesson-8-borrowing-against-your-vouchers)
9. [Health factor and liquidation](#lesson-9-health-factor-and-liquidation)
10. [Alice's full story](#lesson-10-alices-full-story)
11. [Where the project goes next](#where-the-project-goes-next)
12. [Glossary](#glossary)

---

## Lesson 1: Two coins

The project uses only two coins.

**NEAR**
- A cryptocurrency, the coin of the NEAR blockchain.
- Its price moves. Today it might be $3, next month $4 or $2.

**USDC**
- A "digital dollar" (a stablecoin).
- 1 USDC is always about $1.

So holding **NEAR** means taking a risk (you could gain or lose), and holding **USDC** means you're safe (it stays at
$1).

### Example

You have 100 NEAR, and NEAR costs $3 today.

- Your 100 NEAR is worth **$300**.
- If NEAR rises to $4, it's worth **$400**.
- If NEAR falls to $2, it's worth **$200**.

If you had swapped to 300 USDC instead, you'd have **$300** whatever happened.

> **Remember:** NEAR can go up or down. USDC stays the same. The whole project is about choosing **when** to hold
> NEAR and **when** to hold USDC.

---

## Lesson 2: Future events move the price

Things happen in the world that push NEAR's price up or down. Take one event:

> **"Will SPICE (a NEAR upgrade) ship by March 2027?"**

Two possible answers:
- **SHIPS**: released on time
- **DELAYED**: late

When a big upgrade ships, people get excited and buy, so the price rises. When it's delayed, some people sell, so
the price falls.

| What happens | NEAR price (example) |
|---|---|
| SPICE SHIPS | $3.40 |
| SPICE DELAYED | $2.80 |

With 100 NEAR:

- If SPICE ships: 100 x $3.40 = **$340**
- If SPICE is delayed: 100 x $2.80 = **$280**

You don't know yet which will happen, so you think:

> "I'm happy to keep NEAR if SPICE ships. If it's delayed, I wish I had USDC instead."

> **Remember:** an event has two possible results, and NEAR's price is different in each.

---

## Lesson 3: The usual tools don't fit

You want: **NEAR if SPICE ships, USDC if it's delayed.**

Say NEAR is $3.00 today and you have 100 NEAR.

### Try 1: Sell everything today

You get 300 USDC.

| What happens | You have |
|---|---|
| Ships | $300 (you missed the $340) |
| Delayed | $300 |

You escaped the bad outcome but gave up the good one.

### Try 2: Do nothing

| What happens | You have |
|---|---|
| Ships | $340 |
| Delayed | $280, or less |

You kept the good outcome but you're not protected.

### Try 3: Buy insurance (a "put option")

A put option pays you if NEAR's price falls. But it **costs money up front**, and it pays when the price falls for
any reason; it knows nothing about SPICE. You pay for protection in every case, including the one where SPICE ships
and you didn't need it.

### What you really want

| What happens | You want |
|---|---|
| Ships | **NEAR** |
| Delayed | **USDC** |

**Different things in different futures.** None of the usual tools can do that.

> **Remember:** normal tools treat the future as one thing. You want to act differently in each possible future.

---

## Lesson 4: Splitting 1 NEAR into vouchers

This is the main trick of the project.

Put 1 NEAR into the contract (a program on the blockchain), and it gives you **two vouchers**:

```
                1 NEAR
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
    Voucher A            Voucher B
 "1 NEAR if SPICE     "1 NEAR if SPICE
     SHIPS"              is DELAYED"
```

- **Voucher A** pays 1 NEAR **only if** SPICE ships. Otherwise it's worth nothing.
- **Voucher B** pays 1 NEAR **only if** SPICE is delayed. Otherwise it's worth nothing.

### Why holding both = holding 1 NEAR

SPICE will either ship or be delayed, so exactly one voucher always pays.

| What happens | Voucher A | Voucher B | Total |
|---|---|---|---|
| Ships | 1 NEAR | 0 | **1 NEAR** |
| Delayed | 0 | 1 NEAR | **1 NEAR** |

Nothing is created or lost by splitting. You can also join them back: give A + B, get your 1 NEAR immediately.

### Why it's useful

Your NEAR is now in two separate pieces, so **you can treat each piece differently**: keep one, swap the other.

### An everyday comparison

Think of a match ticket split in two: "Get ₹100 if Team A wins" and "Get ₹100 if Team B wins". Hold both and you
always get ₹100. Sell one and you've bet on the other.

> **Remember:** 1 NEAR = "NEAR if SHIPS" + "NEAR if DELAYED". Exactly one will pay.

### ❓ Question: if I keep ticket A and sell ticket B, what price will B sell for?

It depends on **how likely people think Team B is to win**.

- Both teams equally strong (50/50): B pays ₹100 half the time, so a fair price is about **₹50**.
- Team B is weak (20% chance): about **₹20**.
- Team B is strong (80% chance): about **₹80**.

> **Price of a ticket ≈ chance it pays x ₹100**, and the two prices add up to about ₹100.

| Chance B wins | Price of B | Price of A |
|---|---|---|
| 20% | ₹20 | ₹80 |
| 50% | ₹50 | ₹50 |
| 80% | ₹80 | ₹20 |

Nobody sets this price. Buyers and sellers agree on it, like in a vegetable market.

If B sells for ₹20, you hold ₹20 cash plus ticket A:

| Who wins | You get |
|---|---|
| Team A | ₹100 + ₹20 = **₹120** |
| Team B | ₹0 + ₹20 = **₹20** |

Selling B means you **bet on A**. That's how a prediction market works.

**Note:** the NEAR project uses the vouchers differently. You don't sell "NEAR if DELAYED" for cash today; you
**swap it for "USDC if DELAYED"**. That's protection, not a bet. Lesson 5 shows how.

---

## Lesson 5: Swapping the voucher you don't want

You have 100 NEAR. After splitting you hold:

- 100 x "NEAR if SHIPS": **keep these**
- 100 x "NEAR if DELAYED": you don't want NEAR in this future

### The swap

You swap it for a different voucher **in the same future**:

```
100 x "NEAR if DELAYED"   ──swap──▶   280 x "USDC if DELAYED"
```

Both say "if DELAYED". They pay in the same future, so you're only changing **what** you get there: NEAR or USDC.

### Where does 280 come from?

In the ticket example the price depended on **chance**. Here it doesn't, because both vouchers pay in the same
future. The only question is:

> "If SPICE is delayed, how much will 1 NEAR be worth in USDC?"

Traders think about $2.80, so 100 NEAR-if-DELAYED swaps for about 280 USDC-if-DELAYED. (The project runs a separate
small market for each future; in this one, "NEAR if DELAYED" trades against "USDC if DELAYED".)

### What you hold now

| What happens | Your vouchers pay | Worth |
|---|---|---|
| Ships | **100 NEAR** | ~$340 |
| Delayed | **280 USDC** | $280, locked |

Exactly what Lesson 3 asked for.

### "Isn't $280 the same as just holding NEAR at $2.80?"

The $2.80 is only a **guess** about the future. The swap **locks it in**.

| If delayed, NEAR actually ends at… | Without swap (100 NEAR) | With swap (280 USDC) |
|---|---|---|
| $2.00 (worse than expected) | $200 | **$280** |
| $2.80 (as expected) | $280 | $280 |
| $3.20 (better than expected) | $320 | $280 |

The swap protects you if the delay hurts **more** than expected. The cost is that you miss out if it hurts
**less**. That's what a hedge is: **you trade the unknown for a sure amount.**

### Compared with Lesson 3

| | If ships | If delayed |
|---|---|---|
| Sell everything today | $300 | $300 |
| Do nothing | ~$340 | unknown (could be $200) |
| **Multiverse swap** | **~$340** | **$280, locked** |

> **Remember:** split your NEAR, keep "NEAR if good future", swap "NEAR if bad future" for "USDC if bad future".

---

## Lesson 6: The day the result comes out

It's March 2027. You hold 100 x "NEAR if SHIPS" and 280 x "USDC if DELAYED".

### If SPICE was delayed

- "NEAR if SHIPS": that future didn't happen, so the voucher **dies** (worth 0).
- "USDC if DELAYED": that future happened, so it **becomes real money**. You redeem it for **280 real USDC**.

### If SPICE shipped

- "USDC if DELAYED" dies.
- "NEAR if SHIPS" becomes **100 real NEAR**, now worth more because the upgrade shipped.

> **Rule:** vouchers for the future that happened become real coins, 1 for 1. Vouchers for the future that didn't
> happen become worthless.

### Where does the real money come from?

When you split 100 NEAR, that **real NEAR stayed locked in the contract**, and so did everyone else's. The contract's
rule is that **every voucher is backed by real coins in every future**, and it checks this automatically. The app
shows it as **"Every world balances: ✓ all backed"**.

### Who tells the contract what happened?

A blockchain can't read the news, so:

1. **A reporter proposes the answer**, for example "DELAYED".
2. **A short waiting time follows** (the dispute window). A wrong answer can be cancelled during it.
3. **After that, it's final.** Losing vouchers die; winning ones can be redeemed.

In the demo, one event (the October 2026 Fed meeting) was settled **automatically from official US government data**
(the Federal Reserve's FRED database) through a service called OutLayer, with no person typing the answer.

> **Remember:** when the event happens, the losing future's vouchers die and the winning future's vouchers become
> real coins.

---

## Lesson 7: Two events, four worlds

Add a second event.

### The US "Fed"

The Fed is America's central bank. It sets **interest rates**: how expensive it is to borrow money.

> **"Will the Fed cut interest rates in December?"**

- **CUTS**: borrowing gets cheaper, people take more risk and buy crypto, so NEAR tends to go **up**.
- **HOLDS**: nothing changes, people stay careful, so NEAR tends to go **down**.

### Two events make four futures

Each event has 2 answers, and 2 x 2 = 4 combinations. The project calls each one a **world**:

```
                      Fed CUTS          Fed HOLDS
                   ┌────────────────┬────────────────┐
  SPICE SHIPS      │  SHIPS·CUTS    │  SHIPS·HOLDS   │
                   │  best          │  ok            │
                   ├────────────────┼────────────────┤
  SPICE DELAYED    │  DELAYED·CUTS  │  DELAYED·HOLDS │
                   │  meh           │  worst         │
                   └────────────────┴────────────────┘
```

Only one world will really happen. That's where the name "Multiverse" comes from.

### Four vouchers

1 NEAR now splits into four: "NEAR if SHIPS·CUTS", "NEAR if SHIPS·HOLDS", "NEAR if DELAYED·CUTS" and "NEAR if
DELAYED·HOLDS". Only one will pay, so all four together = 1 NEAR.

Each world has its own market, so NEAR gets its own price in each. In the demo:

| World | NEAR price in that world |
|---|---|
| SHIPS·CUTS | $3.70 |
| SHIPS·HOLDS | $3.30 |
| DELAYED·CUTS | $3.00 |
| DELAYED·HOLDS | $2.50 |

### Why two events?

Because a fear is often a **combination**.

**Person 1: "I'm only scared if both bad things happen."** Swap to USDC in one world, keep NEAR in three:

```
 SHIPS·CUTS    → NEAR      SHIPS·HOLDS   → NEAR
 DELAYED·CUTS  → NEAR      DELAYED·HOLDS → USDC
```

**Person 2: "I only want NEAR if everything goes well."** Keep NEAR in one world, swap in three:

```
 SHIPS·CUTS    → NEAR      SHIPS·HOLDS   → USDC
 DELAYED·CUTS  → USDC      DELAYED·HOLDS → USDC
```

Same app, same NEAR, but each person picks exactly the worlds they want. (Person 2 is "Alice" in the demo.)

> **Remember:** 2 events = 4 worlds. Split NEAR into 4 vouchers and choose NEAR or USDC in each world separately.

### ❓ Question: who creates these markets? What if my fear isn't listed?

**Today, only the admin (the "owner" account) can create markets.** Creating an event, combining events into worlds,
and opening each world's market all start with an owner check in the contract; anyone else is refused. The admin can
also cancel a wrong result during the waiting time or declare a result directly.

So if your fear isn't listed, **you can't hedge it**; you'd have to ask the admin. Other limits: only NEAR and USDC,
and at most 2 events per market.

Why design it this way:

| Reason | Example |
|---|---|
| Clear questions | "Will NEAR do well?" can't be answered yes/no. The admin writes exact rules. |
| No spam | Without control, people could create thousands of junk or trick markets. |
| Markets need starting money | A new market is empty; someone has to put in the first NEAR and USDC. Here, the owner does. |

Once a market exists, **anyone** can split, swap, redeem, trade, lend, borrow and add money to it. The admin builds
the shops; anyone can shop.

### ❓ Question: could people propose markets themselves, with upvotes like Reddit?

It's a good start, with holes:

1. **Upvotes are free, so they can be faked**: one person, fifty accounts. Make voting cost something.
2. **Upvotes aren't money.** A popular market with nothing in it gives terrible prices. Better: people **pledge real
   money** ("500 USDC if it opens"), and the market opens already funded, like a crowdfunding campaign.
3. **Everyone who upvotes fears the same thing**, so they'd all want to sell the same voucher. A market needs both
   sides: the fearful (want protection) and the confident (happy to buy cheap).
4. **Some questions are dangerous.** "Will project X get hacked?": the proposer could bet on it and then do it.
   Reject questions someone can easily cause.
5. **It doesn't fix who decides the result.** Require a public data source with every proposal.

The improved version (not built; see [Where the project goes next](#where-the-project-goes-next)):

```
1. Propose → question + exact rule + data source + deadline
              (small deposit to stop spam, returned if accepted)
2. Pledge  → people lock real money: "500 USDC if it opens"
              (fearful AND confident sides both pledge)
3. Check   → clear yes/no? public data? can't be faked or caused?
4. Open    → market starts with the pledged money already inside
5. Resolve → result comes from the public data, not a person
```

People can propose a **brand-new event** (needs the admin check) or a **combination of existing events**, like "SPICE x
Fed" from two events that already exist (already checked, so it could open automatically once pledges reach the
goal).

### ❓ Question: why only 2 events per market? Why not 3, or more?

The contract sets a maximum of 4 worlds and 2 events. Every extra yes/no event **doubles** the worlds:

| Events | Worlds | Markets that need money |
|---|---|---|
| 1 | 2 | 3 |
| 2 | 4 | 7 |
| 3 | 8 | 15 |
| 4 | 16 | 31 |
| 5 | 32 | 63 |

Each world needs its own market (plus markets for the odds), and that causes four problems:

1. **Money gets thin.** $100,000 of starting money is $25,000 per world at 4 worlds but $6,250 at 16. Thin markets
   give bad prices; even today, 2,000 NEAR sold into one thin world market got about 5% less than the listed price.
2. **Work per transaction.** One click does work in every world, and a transaction has a work limit ("gas").
3. **People can't read 16 worlds.** A 2x2 grid fits a phone.
4. **Real fears are about 1 or 2 things.**

**Why 3 is the natural next step:** the contract tracks worlds with 8 on/off switches (an 8-bit mask), and 3 events =
8 worlds fits exactly. The money only doubles (15 markets instead of 7), and it's still readable as two 2x2 grids. It
isn't a one-line change: other parts were built for 4 worlds and need checking.

**Why not more than 3:** 16 worlds needs 16 switches, which means rebuilding how the contract stores worlds, token
names and data. The money explodes (31, then 63 markets), nobody can read the screen, and each click's work doubles
again.

Today you can still have **many separate markets**: the demo runs "SPICE x Fed" and "SPICE only" side by side. You
just can't combine 3 events in one.

---

## Lesson 8: Borrowing against your vouchers

Back to one event. You hold:

- 100 x "NEAR if SHIPS"
- 280 x "USDC if DELAYED"

The result comes out in March 2027, but you want real USDC **now**, for rent or another opportunity. Your vouchers
can't be spent in a shop. Can someone lend you real USDC against them?

### Collateral is a pawn shop

You give the shop your gold ring, the shop gives you cash, you repay (plus a little extra) and get your ring back.
If you don't repay, the shop keeps the ring. **Your vouchers are the ring.**

### The lender's question: what's the least they could be worth?

The lender adds up what **the whole bundle** pays in each world. Only one future happens, so only one voucher pays:

| If this world happens | "NEAR if SHIPS" pays | "USDC if DELAYED" pays | Bundle total |
|---|---|---|---|
| Ships | 100 NEAR ($340) | 0 | **$340** |
| Delayed | 0 | 280 USDC | **$280** (worst) |

Whatever happens, the bundle is worth **at least $280**.

### How much can you borrow?

The lender lends **75%** of the worst-world value: $280 x 75% = **$210**, real USDC, straight into your wallet. The
other 25% is a cushion in case prices move.

### Why "worst world" works

The lender is covered in every future:

- Ships: the bundle is worth $340, more than $210.
- Delayed: the bundle is worth $280, more than $210.

### Why normal lending apps can't do this

Apps like Aave or Burrow ask, "what is this token's price today?" "USDC if DELAYED" doesn't have a normal price:
it's worth $1 in one future and $0 in another. A normal app would value it at nothing and lend you $0. Multiverse
understands worlds, so it can say, "in your worst world you still have $280; here's $210."

### Who gives you the money?

**Lenders**: people with spare USDC who deposit it. Borrowers pay **interest** (5% a year in this version), and all
of it goes to the lenders.

> **Remember:** you can borrow real USDC today against your vouchers. The amount is 75% of your **worst** world, so the
> lender is safe whichever future happens.

### Detail: the worst world can change

The $280 is fixed, because it's USDC. The $340 depends on NEAR's price in the "ships" world, which can move. If that
price fell to $2.50, "ships" would be worth $250 and become the new worst world, and you could only borrow
75% x $250 = $187.50. The contract **re-checks your worst world all the time**, using the latest prices.

### ❓ Question: what if SPICE is delayed and the value falls to $190?

It depends on what you hold in that world.

**If you swapped (as above), you're safe.** In the delayed world you hold 280 **USDC**, not NEAR. Even if NEAR crashes
to $1.90, your 280 USDC is still $280. NEAR's price doesn't matter there; that's the point of the swap.

**If you didn't swap**, you hold "NEAR if DELAYED". At $1.90, 100 NEAR = $190, less than the $210 loan. That's a
problem for the lender.

**Even a hedged borrower has risk in the worlds where they kept NEAR.** If NEAR in the "ships" world dropped to $1.90,
that world would be worth $190.

The lender doesn't wait until it reaches $190: someone steps in early. That's Lesson 9.

---

## Lesson 9: Health factor and liquidation

### The danger line

Your loan is $210. The contract lends at most 75% of the worst world, so it needs the worst world to stay at
$210 / 0.75 = **$280 or more**. Below $280, the loan is **unsafe**, long before $190.

### The health factor

> **Health factor = worst world x 75% / loan**

- Above 1: safe
- Below 1: unsafe, and anyone can step in

NEAR in the "ships" world falls from $3.40 to **$2.70**:

| World | Bundle value |
|---|---|
| Ships | 100 x $2.70 = **$270** (now the worst) |
| Delayed | $280 |

Health factor = $270 x 0.75 / $210 = **0.96**. Unsafe.

### Who's involved (the company isn't one of them)

| Person | Role | Whose money |
|---|---|---|
| **You** (borrower) | Borrowed $210 | Your vouchers are locked as the guarantee |
| **Bob** (lender) | Lent the $210 | Bob's own USDC |
| **Leo** (liquidator) | Steps in when a loan is unsafe | Leo's own USDC |

The contract is a **referee**: it holds the vouchers, follows the rules and moves money between people. It doesn't
lend its own money and doesn't pay anyone.

### The liquidation, step by step

```
① Leo pays $105 of HIS OWN USDC → half your loan is repaid

② The contract takes about 41% of each of YOUR vouchers → gives them to Leo
   (worth $110.25 = $105 + a 5% bonus)

③ Your loan shrinks from $210 to $105
```

| | Before | After |
|---|---|---|
| Your loan | $210 | **$105** |
| NEAR if SHIPS | 100 | **59.17** |
| USDC if DELAYED | 280 | **165.67** |
| Worst world | $270 | **$159.75** |
| Health factor | 0.96 (unsafe) | **1.14 (safe)** |

If NEAR keeps falling, the same thing can happen again.

### Who won and who lost?

| Person | What happened | Result |
|---|---|---|
| Bob (lender) | Got $105 back early; the rest is safe again | **No loss** |
| Leo (liquidator) | Paid $105, received vouchers worth $110.25 | **+$5.25** |
| You (borrower) | Lost vouchers worth $110.25 for $105 less debt | **−$5.25** |
| The company | Nothing | **Zero** |

**The liquidator's bonus comes out of the borrower's pocket.** It's the penalty for letting the loan become unsafe.
You could have avoided it by repaying some of the loan or adding collateral when the health factor neared 1.

**Shop analogy:** you pawn a ring at Bob's shop for $210. Gold prices fall. Leo walks in: "I'll pay Bob $105 of your
debt now; give me a bit of your ring worth $110." Bob is happy, Leo made $5, you paid a $5 penalty, and the
building's owner wasn't involved.

### Why would anyone be a liquidator?

The bonus, every time. Bots watch loans around the clock, and **anyone** can be one; no permission needed. One catch:
the liquidator is paid in **vouchers**, not cash, so they must wait for the result or sell the vouchers, and prices
can move meanwhile.

### When can the lender lose?

Only when liquidation can't happen in time:

| Risk | What it means |
|---|---|
| Sudden crash | If NEAR drops very fast, the vouchers may end up worth less than the loan before anyone acts. The gap is **bad debt**. |
| Slow price | Loans are judged on a **30-minute average price** (this stops people faking prices), so the contract reacts up to 30 minutes late in a fast crash. |
| No liquidators | If nobody runs a bot, nobody steps in. |

**Who pays bad debt?** Not the company. There's no insurance fund and the company keeps no interest, so the loss falls
on **the lenders**. That's the deal: lenders earn interest in exchange for this rare risk.

> **Remember:** the liquidator uses their own money and is paid with the borrower's vouchers plus a 5% bonus. The
> borrower pays the penalty, and the company pays nothing. Only in a crash too fast for liquidation does anyone lose,
> and that's the lenders.

### ❓ Question: can I run my own liquidator bot with the current code?

**Yes.** Anyone can liquidate; there's no owner check and no allowlist.

What the code already gives a bot:

- **The liquidate action**: send USDC to the contract with the action `liquidate`, naming the market, the borrower and
  how much to repay (an amount, or "max", which is half the debt).
- **A check**: `liquidation_status(market, account)` answers None (healthy), Liquidatable, PausedHalted (a result is
  being decided) or PausedNoPrice (a world's price can't be trusted right now). `health_factor(market, account)` gives
  the exact number.
- **An example**: the project's end-to-end test script runs a full liquidation (Leo liquidates Carl).

What a bot needs: a NEAR account with the 0.1 NEAR storage deposit, USDC to repay with, a list of borrowers, and a
loop that checks and liquidates.

### ❓ Question: what's still missing for liquidation and lending?

| Gap | Who it hurts |
|---|---|
| No list of borrowers in the contract; a bot must rebuild it from public `borrow` events | Liquidators |
| No ready-made bot script and no "Liquidate" button in the app (only a "Liquidatable" badge) | Liquidators |
| Liquidators are paid in vouchers; turning them into cash before the result takes extra trades | Liquidators |
| Prices react up to 30 minutes late in a crash | Lenders |
| Liquidation pauses while a result is being decided, or when a world's market is too thin or jumpy | Lenders |
| Very small loans may never get liquidated | Lenders |
| Bad debt is never written off; it stays on the books as if it will be repaid | Lenders |
| Lenders can only withdraw unused cash; if it runs short, the first out gets paid and the last waits | Lenders |
| Someone with a lot of money could hold one world's price down for 30 minutes to make a healthy borrower look unsafe (a known, documented risk) | Borrowers |

None of these breaks a testnet demo; they're what a real-money launch must fix.

### ❓ Question: how would you fix them?

In priority order (not built):

| Priority | Fix |
|---|---|
| 1 | **Insurance fund** (a slice of interest) pays bad debt first; any rest is written off across all lenders at once |
| 2 | **Sliding interest**: low when cash is plentiful, very high when the pool is nearly empty, so cash flows back |
| 3 | **Minimum loan size**, and full (not half) liquidation for small or very unhealthy loans |
| 4 | **A borrower list in the contract, an open-source bot, and a Liquidate button** |
| 5 | **Bigger cushion**, and borrowing against the lower of the live and average price |
| 6 | "Liquidate and cash out" in one step; a cautious price instead of pausing; a check against an outside price feed |

### ❓ Question: shouldn't lenders compete on terms instead of a fixed 75%?

One fixed 75% is blunt: too generous for a thin, jumpy market and too strict for a deep, calm one.

Lenders compete on **two things together**: how much they lend and the interest they charge. More lent means more
risk, so a higher rate. The borrower picks the best deal.

Free one-by-one bidding has problems, though: borrowing becomes slow (waiting for offers), ordinary lenders can't
price per-world risk, every loan has its own rules (more code, more bugs), and lenders' money gets locked in specific
loans.

The middle path, **tiers**:

```
 Safe tier     60%   low interest
 Normal tier   70%   medium interest
 Bold tier     80%   high interest
```

Lenders and borrowers each pick a tier, and each tier's interest moves with demand. The back and forth happens
through **rates**, borrowing stays instant, and lenders still just deposit. Calm markets could offer higher tiers and
jumpy ones lower.

---

## Lesson 10: Alice's full story

Everything so far, in one story with the demo's numbers.

### Scene 1: Alice

Alice has **2,000 NEAR** and watches two events, SPICE (ships or delayed) and the Fed (cuts or holds):

```
                 Fed CUTS          Fed HOLDS
             ┌───────────────┬───────────────┐
 SHIPS       │ $3.70         │ $3.30         │
             ├───────────────┼───────────────┤
 DELAYED     │ $3.00         │ $2.50         │
             └───────────────┴───────────────┘
```

### Scene 2: The decision

> "I only want NEAR if everything goes well (SHIPS·CUTS). In the other three worlds I want USDC."

### Scene 3: One click to sell

In the app Alice picks the three feared worlds, clicks **"Sell in 3 worlds"**, and signs **once**. Behind the scenes
the 2,000 NEAR splits into four sets of vouchers; "NEAR if SHIPS·CUTS" is kept and the other three are swapped into
USDC:

| World | Alice holds |
|---|---|
| SHIPS·CUTS | **2,000 NEAR** (kept) |
| DELAYED·CUTS | **5,865 USDC** |
| SHIPS·HOLDS | **6,451 USDC** |
| DELAYED·HOLDS | **4,881 USDC** |

**Why 5,865 and not 2,000 x $3.00 = $6,000?**

1. **Big sales push the price down as they go** (slippage): the first NEAR sells at $3.00, each next one a little
   cheaper.
2. **A small trading fee** goes to the people who put money into the market.

**Ravi helped in the worst world.** Ravi had a standing offer to buy 1,000 NEAR at $2.45 there. Alice's sale used it
first, then the market: 4,881 USDC instead of 4,748 from the market alone (+$133).

### Scene 4: Alice borrows

| World | Bundle value |
|---|---|
| SHIPS·CUTS | 2,000 x $3.70 ≈ **$7,399** |
| DELAYED·CUTS | **$5,865** |
| SHIPS·HOLDS | **$6,451** |
| DELAYED·HOLDS | **$4,881** (worst) |

- Maximum loan: $4,881 x 75% = **$3,661**
- Alice borrows **3,000 USDC**, real money, into the wallet.
- Health factor: $4,881 x 0.75 / $3,000 = **1.22** (safe)

### Scene 5: Waiting

Alice uses the 3,000 USDC. The loan costs 5% a year. Three of the four worlds are USDC, which doesn't move; the only
real risk is NEAR falling in SHIPS·CUTS. Liquidation would need the worst world to drop below $3,000 / 0.75 = $4,000.

### Scene 6: The result

In the demo, **SPICE was delayed** and **the Fed held**: the world is **DELAYED·HOLDS**.

- Three worlds die; their vouchers are worth 0.
- "USDC if DELAYED·HOLDS" becomes **4,881 real USDC**.

Alice clicks **"Close and redeem"** (one transaction): it repays the loan (3,000 plus interest, about $56 over
roughly 4.5 months) and pays out the rest, **about 1,825 USDC**.

Total: 3,000 (borrowed and already spent or kept) + 1,825 ≈ **$4,825**.

### Scene 7: The other endings

| World that happens | Alice ends with (before repaying about $3,056) |
|---|---|
| SHIPS·CUTS | **2,000 NEAR** (~$7,400): full upside kept |
| SHIPS·HOLDS | **6,451 USDC** |
| DELAYED·CUTS | **5,865 USDC** |
| DELAYED·HOLDS | **4,881 USDC** |

**Alice knew all four outcomes on day one.** The only number that could move was the NEAR in the best world.

### Scene 8: Was it worth it?

Had Alice done nothing and NEAR ended exactly at $2.50 in DELAYED·HOLDS, 2,000 NEAR would be **$5,000**, slightly more
than the hedged $4,881. So the hedge **cost about 2.4%** (slippage and fees) **if prices end as expected**. But:

| NEAR ends at | Did nothing | Alice (hedged) |
|---|---|---|
| $2.50 (as expected) | $5,000 | $4,881 |
| $2.00 | $4,000 | **$4,881** |
| $1.50 | $3,000 | **$4,881** |

That's insurance: **pay a little to remove the scary unknown**, and Alice had 3,000 USDC to use the whole time.

### Bonus: Carl

Carl borrowed against **plain NEAR**, with no hedge. When the DELAYED·HOLDS price was pushed down in the test, Carl's
health factor fell to **0.86** and Leo liquidated him. Alice was in the same market through the same price drop, and
nothing happened, because Alice's worst world was already USDC.

> **Hedged borrower: safe. Unhedged borrower: liquidated.** That's the whole pitch in one picture.

---

## Where the project goes next

Ideas for after the hackathon, **none built yet**. The full version, with code references, is in
[ROADMAP.md](ROADMAP.md).

1. **Users propose markets, funded by pledges.** Propose, pledge real money, check, then open already funded.
   Proposals can be brand-new events (admin check) or combinations of existing events (opens automatically once
   funded).
2. **Up to 3 events per market.** Fits the contract's 8-world format and only doubles the money; more than 3 needs a
   redesign.
3. **Safer lending before real money.** Insurance fund, sliding interest, minimum loans, a public liquidator bot,
   and better price handling.
4. **Separate markets, related markets, and a market list.** Each event is its own market (SPICE only, Fed only) and
   combinations are extra markets. The app's two-option dropdown becomes a browsable list of market cards, each
   market page lists related markets that share an event, and every new market is funded through pledges. The
   contract already supports this; only the web app needs work.
5. **Lending tiers.** Safe 60% / Normal 70% / Bold 80%, each with its own demand-driven interest rate.
6. **More demo markets.** SPICE only, Fed only, SPICE x Fed, the resolved October Fed market, a second NEAR event and
   its combination with SPICE, so every idea in this guide has a market to point at.

---

## Glossary

| Term | Meaning |
|---|---|
| **NEAR** | The coin of the NEAR blockchain; its price moves. |
| **USDC** | A stablecoin; 1 USDC ≈ $1. |
| **wNEAR** | "Wrapped NEAR": NEAR in token form, so contracts can move it like any other token. |
| **Smart contract** | A program on a blockchain that holds money and follows fixed rules. |
| **Event** | A yes/no question about the future with a rule for deciding it. |
| **World** | One combination of event outcomes, e.g. SHIPS·CUTS. |
| **Scenario / market** | One or two events and their worlds, with their own markets and lending. |
| **Voucher (verse token)** | "1 NEAR (or 1 USDC) if this world happens". |
| **Split / merge** | Turn 1 NEAR into one voucher per world, or join them back. |
| **Redeem** | Turn a winning voucher into a real coin after the result. |
| **Hedge** | Protection against a bad outcome. |
| **Put option** | Insurance that pays if a price falls, for any reason. |
| **Prediction market** | A market for betting on whether events happen. |
| **Slippage** | A big trade getting a worse average price because it moves the market. |
| **Collateral** | What you lock up to borrow. |
| **Worst world** | The world where your collateral is worth least; loans are sized by it. |
| **LTV (75%)** | How much you can borrow as a share of your worst-world value. |
| **Health factor** | Worst world x 75% / loan. Above 1 is safe; below 1 can be liquidated. |
| **Liquidation** | Someone repays part of an unsafe loan and takes collateral plus a 5% bonus. |
| **Liquidator** | Whoever does it, usually a bot. |
| **Bad debt** | Loan left unpaid after all collateral is gone. |
| **Interest** | What borrowers pay lenders (5% a year here). |
| **Reporter** | The account that proposes an event's result. |
| **Dispute window** | The waiting time after a proposed result, when a wrong one can be cancelled. |
| **OutLayer** | A service that ran code reading official Fed data and reported the result on-chain. |
| **Testnet** | A practice version of the blockchain; its tokens have no real value. |
