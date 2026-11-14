// The guide, as data: /docs/ renders it (views/Docs.tsx) and docs-md.test.ts writes the same words to public/docs.md
// and public/llms.txt, so the page and the Markdown copy cannot drift apart. Text uses three inline marks only:
// **bold**, `code` and [label](href). Every protocol number below is the contract's own (contracts/multiverse/src)
// or a view of the staging deployment on 14 Nov 2026; the page also reads the live ones from the chain ("live").
import { BRAND } from '../chain/brand'
import { links } from '../config'

export type Block =
  | { type: 'p'; text: string }
  | { type: 'list'; items: string[]; ordered?: boolean }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'code'; text: string }
  | { type: 'terms'; items: [string, string][] }
  | { type: 'note'; text: string }
  | { type: 'h3'; text: string }
  /** A part of the page read from the chain when it opens. The Markdown copy prints `md` in its place. */
  | { type: 'live'; widget: LiveWidget; md: string }
  /** A drawn figure on the web page; the Markdown copy prints `md` in its place. */
  | { type: 'figure'; figure: 'worlds'; md: string }

export type LiveWidget = 'loans' | 'tiers' | 'config' | 'txs' | 'accounts'
export type DocSection = { id: string; title: string; toc: string; blocks: Block[] }
export type DocIds = { contract: string; wnear: string; usdc: string }

/** The deployment's other accounts, named after its root (`app.<root>` is the contract). */
export function accountsOf(ids: DocIds) {
  const root = ids.contract.replace(/^app\./, '')
  return {
    ...ids,
    owner: root,
    reporter: `resolver.${root}`,
    keeper: `keeper.${root}`,
    maker: `maker.${root}`,
    persona: (name: string) => `${name}.${root}`,
  }
}

export const SITE_URL = 'https://multiverse-lending.vercel.app'
export const README_URL = 'https://github.com/skyyycodes/multiverse-near/blob/main/README.md'
/** A site path or a full URL, absolute either way (for the Markdown copies). */
export const absoluteUrl = (u: string): string => (u.startsWith('/') ? `${SITE_URL}${u}` : u)
export const WHITEPAPER_URL = absoluteUrl(links.whitepaper)

export const DOCS_TITLE = 'How it works'
export const DOCS_LEDE = `The complete guide to ${BRAND.name}: what it is, how every part works, what each number means and how to use each screen. If you read only this page, you should understand all of it.`

const p = (text: string): Block => ({ type: 'p', text })
const ul = (...items: string[]): Block => ({ type: 'list', items })
const ol = (...items: string[]): Block => ({ type: 'list', items, ordered: true })
const h3 = (text: string): Block => ({ type: 'h3', text })
const note = (text: string): Block => ({ type: 'note', text })
const table = (head: string[], ...rows: string[][]): Block => ({ type: 'table', head, rows })
const code = (text: string): Block => ({ type: 'code', text })

export function docsSections(ids: DocIds): DocSection[] {
  const a = accountsOf(ids)
  const N = BRAND.name
  return [
    {
      id: 'start',
      toc: 'Start here',
      title: `What ${N} is`,
      blocks: [
        p(`${N} lets you hold NEAR in the futures you like and dollars in the futures you fear, and borrow real USDC against all of it at once. You pick one to three real events, like “Will the Fed cut in December?”. Every way those events can turn out is a **world**. Your money is split into one copy per world, and you decide, world by world, what to hold. A lender then looks only at your **worst world** and lends you real USDC against it.`),
        p('Why this matters: in normal DeFi you can only say “sell if NEAR hits $5”. You cannot say “sell if SPICE is delayed”. A prediction market lets you bet on one event, but the money is stuck until the answer comes, and a bet that pays nothing in some future gets no credit from lenders. Here, a position that is safe in every world is worth something today, so you can borrow against it.'),
        p(`${N} runs on NEAR testnet as one smart contract (\`${a.contract}\`) with test tokens. Nothing on it is real money.`),
        p(`The testnet accounts (\`*.${a.owner}\`) and the web address keep earlier working names.`),
        h3('The idea in five lines'),
        ol(
          '**Split**: 1 wNEAR becomes one “wNEAR-if-world” token in every world. Together they are always worth exactly 1 wNEAR.',
          '**Trade inside a world**: each world has its own NEAR/USDC pool, so you can sell NEAR only in the worlds you fear.',
          '**Borrow**: lenders value your collateral in every world and count only the lowest value.',
          '**Resolve**: when an event is answered from its public source, the worlds that did not happen die.',
          '**Redeem**: when one world is left, its tokens turn back into real wNEAR or USDC, one for one.',
        ),
        note(`${BRAND.credit.text}.`),
      ],
    },
    {
      id: 'example',
      toc: 'A worked example',
      title: 'A worked example',
      blocks: [
        p('The main market on the site asks two questions: **Will SPICE ship on NEAR mainnet by 31 March 2027?** (SHIPS or DELAYED) and **Will the Fed cut at its 8–9 December 2026 meeting?** (CUTS or HOLDS). Two yes-or-no questions give four worlds: Ships & cuts, Delayed & cuts, Ships & holds, Delayed & holds.'),
        p('Say you hold 100 wNEAR and you worry that SPICE gets delayed. Here is what you do:'),
        ol(
          '**Split** 100 wNEAR. You now hold 100 NEAR-if-world tokens in each of the four worlds.',
          '**Sell** the NEAR in the two “Delayed” worlds for USDC in those worlds. You keep NEAR in the two “Ships” worlds.',
          'Now, if SPICE ships, you still have your 100 NEAR. If it is delayed, you hold dollars instead, so a NEAR crash after a delay does not hurt you.',
          '**Borrow** real USDC against this mix. The lender checks all four worlds and lends against the weakest one.',
        ),
        p('On 14 November 2026 the pools priced NEAR at about $4.18 in Ships & cuts, $3.45 in Ships & holds, $3.12 in Delayed & cuts and $2.65 in Delayed & holds (the `world_prices` of `list_markets`). The market thinks NEAR is worth less if SPICE is delayed. Selling 100 NEAR in Delayed & holds at $2.65 gives you about 265 USDC that exists only in that world, before the pool fee and price impact.'),
        p('The page below shows two real loans on this market, read from the chain as you open it: one backed by plain wNEAR, one hedged like the example above.'),
        { type: 'live', widget: 'loans', md: '(On the web page: two live loans on market 1, Carl with plain wNEAR and Alice hedged, drawn as bars per world with their health factors.)' },
      ],
    },
    {
      id: 'worlds',
      toc: 'Events and worlds',
      title: 'Events, outcomes and worlds',
      blocks: [
        p('An **event** is one real question with exactly two **outcomes**, a deadline, a written **rule** that says how it is decided, and a public **source** (for example FRED for Fed decisions, or the Coinbase NEAR-USD daily candle). The rule is stored on chain with the event.'),
        p('A **market** (the contract calls it a scenario) combines one, two or three events. Every combination of their outcomes is a **world**. One event gives 2 worlds, two events give 4, three give 8. The contract allows at most 3 events and 8 worlds per market (`max_events`, `max_worlds` in `get_app_config`).'),
        p('Worlds are numbered from 0 by a simple rule: world = (outcome of event A) + 2 × (outcome of event B) + 4 × (outcome of event C), where the first outcome counts as 0 and the second as 1. In the SPICE × Fed market:'),
        table(['World', 'SPICE', 'Fed', 'Number'], ['Ships & cuts', 'SHIPS (0)', 'CUTS (0)', '0'], ['Delayed & cuts', 'DELAYED (1)', 'CUTS (0)', '1'], ['Ships & holds', 'SHIPS (0)', 'HOLDS (1)', '2'], ['Delayed & holds', 'DELAYED (1)', 'HOLDS (1)', '3']),
        p('A **mask** is a set of worlds written as bits: bit w is on when world w is in the set. Mask 1 (binary 0001) is world 0 alone. Mask 14 (binary 1110) is every world except world 0. Mask 15 (1111) is all four worlds, which is the same thing as the real asset.'),
        { type: 'figure', figure: 'worlds', md: '| | Fed cuts | Fed holds |\n|---|---|---|\n| Ships | Ships & cuts (world 0) | **Ships & holds (world 2)** |\n| Delayed | **Delayed & cuts (world 1)** | **Delayed & holds (world 3)** |\n\nThe bold L-shape, every world but Ships & cuts, is mask 14 (0b1110); all four together are the root, mask 15, which is the real asset itself.' },
        p('Exactly one world will come true. When an event is answered, every world that disagrees with the answer becomes **dead** (impossible). Events can be answered in any order.'),
      ],
    },
    {
      id: 'verses',
      toc: 'Verse tokens',
      title: 'Verse tokens: split, merge, redeem',
      blocks: [
        p('A **verse token** is one asset (wNEAR or USDC) on one mask of one market. “wNEAR-if-world-2” pays 1 wNEAR if world 2 comes true and nothing otherwise. Every verse token is a NEP-245 multi-token inside the one contract, with id `{market}:{asset}:{mask}`, for example `1:wnear:14`, and 18 decimals.'),
        h3('Split'),
        p('**Splitting** puts real wNEAR or USDC into the contract and gives you the same amount in every world still possible. 10 wNEAR in a 4-world market becomes 10 wNEAR-if-0, 10 wNEAR-if-1, 10 wNEAR-if-2 and 10 wNEAR-if-3.'),
        p('**Why 1 wNEAR equals one token in every world:** exactly one world will happen. If you hold one token in every world, you are sure to hold 1 wNEAR in whichever world comes true. So the full set is worth exactly 1 wNEAR, no more and no less. This is also why splitting is free of price risk.'),
        h3('Merge'),
        p('**Merging** is the reverse. If you hold the same amount in every world still possible, you can turn it back into real tokens at any time, before or after any answer.'),
        h3('Redeem'),
        p('When the answers leave only one possible world, that world’s tokens **redeem** one for one into real wNEAR or USDC. Tokens of dead worlds are worth nothing. You can also redeem a token whose mask covers every world still possible (it is then “collapsed”: certain to pay).'),
        h3('The backing rule'),
        p('In every possible world, for each asset, what all verse tokens pay in that world adds up to exactly what the contract holds. This is the contract’s central invariant. Anyone can read it per world with the `backing` view, the contract’s tests assert it after their actions (`assert_conservation`), and the **Checks** tab of a market page shows it while you hold a position there. It means the contract can always pay every winner in full.'),
      ],
    },
    {
      id: 'prices',
      toc: 'Prices are chances',
      title: 'Prices are chances',
      blocks: [
        p('A USDC-if-world token pays $1 only if that world happens. If the market thinks the world has a 30% chance, the token trades near $0.30. So the price of a world’s dollar is the market’s **chance** for that world, and the chances of all possible worlds add up to 100%.'),
        p('In the same way, NEAR inside one world has its own price in dollars of that world. The market’s overall NEAR price (the **implied spot**) is the chance-weighted average of the world prices: add up chance × NEAR price over all worlds. On 14 November 2026 the SPICE × Fed market implied about $3.19 (`implied_spot`).'),
        p('These two kinds of prices answer two different questions: “how likely is this world?” (odds pools) and “what is NEAR worth if this world happens?” (world pools).'),
      ],
    },
    {
      id: 'pools',
      toc: 'World pools and odds pools',
      title: 'World pools and odds pools',
      blocks: [
        p('A **pool** is an automatic market maker: it holds two tokens and quotes a price from how much of each it holds. Anyone can swap with it at any time. Each market has two kinds:'),
        ul(
          '**World pools**: one per world, trading NEAR-if-world against USDC-if-world. They set NEAR’s price inside each world. Lending reads these.',
          '**Odds pools**: they trade the dollar of one outcome against the dollar of the other (for example USDC-if-SHIPS against USDC-if-DELAYED). They set each outcome’s chance.',
        ),
        p('The SPICE × Fed market has 7 pools (`pool_count`), four of them world pools. A new combination of events opens with chances that treat its events as independent (it multiplies each event’s chance); trading corrects that over time.'),
        p('**Fees.** Each swap pays a pool fee of 0.3% (`fee_base_pips` 3000), which rises toward 1.5% (`fee_cap_pips` 15000) when the pool’s last 8 swaps went mostly one way.'),
        p('**Average prices.** Each pool keeps a time-weighted average price (TWAP) over 30 minutes (`twap_window_sec` 1800). Lending uses this average, not the last trade, so one large trade cannot fake a price.'),
        p('**When pools stop.** A pool stops trading from the moment an answer to one of its market’s events is proposed until that answer is finalized (see Resolution), and for good once its world is dead.'),
        { type: 'live', widget: 'config', md: '(On the web page: the live TWAP window, pool fees, dispute window, minimum loan and price-check settings, read from `get_app_config` and `price_check`.)' },
      ],
    },
    {
      id: 'orderbook',
      toc: 'The order book',
      title: 'The order book',
      blocks: [
        p('Next to the pools, each world has an **order book**: a list of standing offers from people.'),
        ul(
          'A **bid** is an offer to buy NEAR-if-world at a price you set, paid in USDC-if-world. You lock that USDC-if-world when you post it.',
          'An **ask** is an offer to sell NEAR-if-world at a price you set. You lock that NEAR-if-world when you post it.',
          'A **fill** happens when someone takes your offer, fully or in part. You receive the other token in that world.',
          '**Cancel** takes back whatever part of your order has not been filled. Orders also carry an expiry time.',
          'An order fills only until the next answer: once any event of the market is answered, older orders can no longer fill, and you cancel them to get your tokens back.',
        ),
        p('Limits from the contract: an order must be at least 0.001 NEAR (`MIN_ORDER_AMOUNT`) and worth at least 0.0001 USDC, one account can have at most 64 open orders (`MAX_OPEN_ORDERS_PER_MAKER`), and one trade fills at most 20 orders (16 in an 8-world market; `max_trade_fills`, `max_trade_fills_8w`).'),
        h3('Pool or order book?'),
        ul(
          'Use the **pool** when you want it done now. You pay the fee and the price moves against you as you trade more.',
          'Use the **order book** when you want a set price and can wait, or when the pool is thin and a large trade would move it a lot.',
          'You do not have to choose: on the **Order book** page, a trade first fills the best orders (up to five per transaction there), then swaps the rest in the pool, or leaves the rest as your own limit order, all in one transaction.',
        ),
        p('Every trade carries a minimum you will accept (`min_out`). The site sets it to the quote less 0.5% on the pool part, so if the price moves more than that before your transaction lands, the trade is refused and nothing moves.'),
      ],
    },
    {
      id: 'hedging',
      toc: 'Hedging',
      title: 'Hedging',
      blocks: [
        p('**Hedging** means removing a risk you do not want. In this market, the risk is “NEAR falls in the worlds where things go badly”.'),
        p('The **Hedge** tab of a market does it in one transaction: it takes wNEAR from your wallet, splits it into every world, and sells the NEAR in the worlds you pick for USDC in those worlds. You keep NEAR in the rest.'),
        p('Example: you hold 100 wNEAR and pick Delayed & cuts and Delayed & holds. After the hedge you hold 100 NEAR-if-Ships & cuts, 100 NEAR-if-Ships & holds, and the USDC the pools paid in the two Delayed worlds. If SPICE ships, you have your NEAR. If it is delayed, you have dollars.'),
        p('Turn on **Keep the result as loan collateral** and the result goes straight into a loan position in the tier you choose, ready to borrow against. The Borrow page offers the same as **Sell NEAR into collateral**; the contract action is `conditional_sell` with `to_lending: true` and a `tier`.'),
        p('A hedge has a cost: the pool fee, the price impact, and the upside you give up in the worlds where you sold.'),
      ],
    },
    {
      id: 'lending',
      toc: 'Lending',
      title: 'Lending: lenders and borrowers',
      blocks: [
        p('Lending happens on markets marked lendable (today: market 1, SPICE × Fed). There are two sides:'),
        ul(
          '**Lenders** supply real USDC to a tier of a market. They earn interest from borrowers. They can withdraw whatever is not lent out at that moment.',
          '**Borrowers** post collateral (verse tokens and real wNEAR or USDC) in one tier and borrow real USDC from that tier. A loan is owed the same in every world.',
        ),
        p('The USDC you borrow is real. It leaves the contract into your wallet and you can use it anywhere.'),
        p('The smallest loan is 100 USDC (`min_loan`). One loan can hold at most 20 different collateral pieces (`max_collateral_pieces`).'),
      ],
    },
    {
      id: 'worst-world',
      toc: 'Worst-world value',
      title: 'Worst-world valuation',
      blocks: [
        p('A lender values your collateral separately in each world that is still possible:'),
        ul(
          'NEAR-if-world counts at NEAR’s price in that world, where it pays, and zero in every other world.',
          'USDC-if-world counts in full where it pays, and zero elsewhere.',
          'Real wNEAR counts in every world, at each world’s NEAR price. Real USDC counts in full in every world.',
        ),
        p('Then it takes the **lowest** of those values. That is your worst world.'),
        p('**Why the worst world?** Your debt is the same in every world, and only one world will come true. The lender does not know which. The only number that is safe whichever world happens is the minimum. If the lender counted an average, a world where your collateral is worth little could come true and leave a loss.'),
        p('**Why answers cannot create bad debt.** When an event is answered, worlds disappear from the list. The minimum over fewer worlds can only be the same or higher. So resolution can only raise your health, never lower it, in any order of answers.'),
        p('This is why hedging helps you borrow more. Plain wNEAR is weakest wherever NEAR is cheapest, and it falls in every world when NEAR falls. Dollars in the worlds you fear do not fall with NEAR, so your worst world stays higher.'),
        p('For new loans, each world’s NEAR is valued at the lower of its live pool price and its 30-minute average. A world without a trusted price (pool too young or too thin) counts zero toward new loans. For the anchor market, a world pool needs to be 30 minutes old (`min_age_sec` 1800) and hold 50,000 USDC of depth (`min_depth`), per `get_market_price_config`.'),
      ],
    },
    {
      id: 'tiers',
      toc: 'Safe, Normal, Bold',
      title: 'Tiers: Safe, Normal and Bold',
      blocks: [
        p('A lendable market has three **tiers**. Each tier is its own pool of lenders with its own limits and rates. A loan lives in one tier. Lenders pick the risk they want; borrowers pick how much they want to borrow.'),
        p('**Borrow up to** is the largest loan as a share of your worst world. **Liquidated at** is the line where your loan can be liquidated. The gap between them (10 points) means a loan that was just opened cannot be liquidated in the same moment. **Bonus** is the extra a liquidator receives.'),
        table(
          ['Tier', 'Borrow up to', 'Liquidated at', 'Bonus', 'Rate at 0% use', 'Rate at 80% use', 'Rate at 100% use'],
          ['Safe', '50%', '60%', '5%', '1%', '5%', '50%'],
          ['Normal', '60%', '70%', '6%', '2%', '8%', '60%'],
          ['Bold', '70%', '80%', '8%', '3%', '12%', '75%'],
        ),
        p('Rates are yearly borrow rates (APR) and follow **utilization**, the share of a tier’s USDC that is lent out. Below 80% use (the “kink”, `rate_kink`) the rate climbs gently from the base; above it, it climbs steeply. No new loan can push a tier past 90% use (`max_utilization`), so lenders can usually withdraw. These are the contract’s compiled defaults (`TierState::builtin`) and the values the staging tiers hold (`lending_tiers`).'),
        p('**Lenders earn** the borrow rate on the part that is lent out, less 10% (`reserve_factor`), which goes to the tier’s insurance fund.'),
        { type: 'live', widget: 'tiers', md: '(On the web page: the three tiers of market 1 read live from `lending_tiers`, with the current borrow and supply rates at today’s use.)' },
      ],
    },
    {
      id: 'health',
      toc: 'Health and interest',
      title: 'Health factor, interest, borrow, repay',
      blocks: [
        p('The **health factor** tells you how safe a loan is: health = worst-world value × the tier’s liquidation line ÷ debt. At 1 or above the loan is safe. Below 1, anyone can liquidate part of it.'),
        p('Example in the Normal tier (liquidated at 70%): your worst world is worth 1,000 USDC and you owe 500 USDC. Health = 1,000 × 0.70 ÷ 500 = 1.40. If NEAR falls and your worst world drops to 700 USDC, health = 700 × 0.70 ÷ 500 = 0.98, and the loan can be liquidated.'),
        p('The most you can borrow is worst-world value × the borrow line (60% in Normal), minus what you already owe: 1,000 × 0.60 = 600 USDC in the example.'),
        p('**Interest** accrues every second on what you owe, at the tier’s current rate. Your debt grows slowly over time; the page shows the current rate.'),
        p('**Repay** any amount at any time, as long as what is left is either nothing or at least the 100 USDC minimum loan. “Repay all” sends slightly more than your debt (debt × 1.001, capped by your wallet) and the contract refunds the rest. Repaying is never paused.'),
        p('**Add collateral** at any time to raise your health. Adding collateral is never paused. **Take back** collateral while the loan stays healthy enough.'),
        p('**Closing after resolution.** Once an event of the market is answered, one transaction on the **Resolve** page (**Close … and redeem**) repays the loan with USDC from your wallet, takes back all your collateral, turns every piece that is now certain to pay into real wNEAR or USDC, and sends it to your wallet. Pieces of worlds still open stay yours as tokens.'),
      ],
    },
    {
      id: 'liquidation',
      toc: 'Liquidation',
      title: 'Liquidation, insurance and bad debt',
      blocks: [
        p('**Liquidation** protects lenders. When a loan’s health falls below 1, anyone (a person or a bot) can repay part of the debt with their own USDC and take collateral in return, plus the tier’s bonus.'),
        ul(
          '**How much:** normally up to half of the debt per liquidation (`close_factor` 0.5). The whole loan can be repaid when health is below 0.9 (`full_liquidation_hf`) or the debt is under 200 USDC (`small_loan`).',
          '**What the liquidator gets:** the same fraction of every collateral piece, plus the bonus (5%, 6% or 8% by tier). Cutting every piece by the same fraction keeps the worst world the worst.',
          '**Tokens or cash:** the liquidator can receive the world tokens themselves, or ask the contract to sell them for USDC in the same transaction (“Cash (USDC)”), with a minimum they will accept.',
          '**When it waits:** liquidation is held back from the moment an answer is proposed until it is finalized, while a world’s pool is too young or thin to price, while the `liquidate` flag is paused (and for a grace period after it is unpaused: 1,800 seconds by default), and when a fresh outside NEAR price is more than 10% above the pools’ price (the guard, below).',
        ),
        p('The **At-risk loans** page lists every loan below a health you choose and lets you liquidate from there. The keeper bot (below) also liquidates on its own.'),
        h3('Insurance and bad debt'),
        p('Each tier has an **insurance fund**. It fills from 10% of all interest and from donations (the **Insure** tab on the Lend page; donations cannot be taken back).'),
        p('**Bad debt** is debt left after a loan has no collateral worth anything. It is written off at once: by the liquidation that takes the last collateral, or by anyone with `write_off_bad_debt` (the **Write off** button on the At-risk page) for a loan whose collateral is worth nothing in every possible world. The tier’s insurance fund pays first. Only what insurance cannot cover is shared by the tier’s lenders (their supply is written down). Each tier’s totals are public: `bad_debt_covered` and `bad_debt_socialized` in `lending_tiers`.'),
      ],
    },
    {
      id: 'reference',
      toc: 'Outside NEAR/USD check',
      title: 'The outside NEAR/USD check',
      blocks: [
        p('The world pools could, in theory, drift away from the real NEAR price. So a lendable market compares the NEAR price its pools imply (from their 30-minute averages) with an outside **reference price**: the median of Coinbase, Kraken, Gemini and CoinGecko.'),
        p('The rules on staging (`get_reference_config`): the price must be posted within 300 seconds of being observed (`max_result_delay_sec`), be newer than the stored one, and lie between $0.10 and $1,000 (`min_price`, `max_price`). A price from OutLayer must also come from at least 3 sources that agree within 2% of each other (`min_sources`, `max_spread_bps`); the contract checks that itself. A price from the reporter is trusted on those two points, and the keeper that posts it applies the same rule before it sends.'),
        ul(
          '**Too far apart:** if the pools’ price and the reference differ by more than 10% (`max_deviation`), new borrowing pauses for that market.',
          '**Pools too high:** if the pools imply a higher price than the reference, collateral counts at the lower, outside level for new loans.',
          '**Pools too low:** if a reference that is at most 300 seconds old (`liquidation_max_age_sec`) is more than 10% above the pools’ price, liquidation waits, so nobody is liquidated on a crashed pool. Otherwise the reference can lower liquidation prices by at most 20% (`max_haircut`).',
          '**Stale price:** if the reference is more than 1 hour old (`borrow_max_age_sec` 3600), new borrowing pauses. Repaying, adding collateral and leaving never pause.',
          '**Opening markets:** a proposal can only open with a fresh reference too (see Proposals).',
        ),
        p(`Who posts it: the reporter account (\`${a.reporter}\`) with \`report_reference\`, run by the keeper; or an OutLayer enclave through \`request_reference\` when one is configured (on staging no guest is set today).`),
      ],
    },
    {
      id: 'resolution',
      toc: 'Resolution',
      title: 'Resolution: how answers are decided',
      blocks: [
        p('Every event has a written rule and a public source. An answer reaches the contract in one of three ways:'),
        ul(
          `**The reporter** (\`${a.reporter}\`) proposes an outcome with its evidence (\`report_outcome\`).`,
          '**OutLayer** runs a small open program inside a secure enclave that reads public data and proposes the outcome (`request_resolution`). On staging it reads Fed decisions from FRED; the request needs 0.005 NEAR attached and at least 240 Tgas (the site attaches 300).',
          '**The owner** resolves directly (`admin_resolve`), for emergencies.',
        ),
        p('A proposed answer then sits in a **dispute window** of 10 minutes on staging (`dispute_window_sec` 600). During it, the owner can dispute it (cancel it, so a new answer can be proposed). After it, anyone can **finalize** the answer (`finalize`), which makes it permanent. Then the losing worlds die. From the moment an answer is proposed until it is finalized, every market on that event pauses its pool swaps, order fills, new borrowing and liquidations; repaying, adding collateral and posting or cancelling orders still work.'),
        p('When every event of a market is final, one world is left: its tokens **redeem** one for one into real wNEAR or USDC, and loans can be closed.'),
        h3('Two real answers on staging'),
        ul(
          '**The October 2026 Fed meeting:** OutLayer read FRED for the 27–28 October meeting. Both limits of the target range were unchanged, so the answer was HOLDS. Nobody typed it.',
          '**NEAR on 1 November 2026:** the reporter answered YES with its evidence: Coinbase closed at 4.284 and Kraken at 4.2827, above the $4.00 line.',
        ),
        p('The transactions for both are in the live section below.'),
      ],
    },
    {
      id: 'proposals',
      toc: 'Proposals and pledges',
      title: 'Proposals and pledges',
      blocks: [
        p('Anyone can ask for a new market. There are two kinds of proposal:'),
        ul(
          '**Kind A, a new event:** you write the question, two outcome names, the rule, the source, a deadline, a category and the starting odds. It needs a bond of 0.2 NEAR (`bond_new_event`) plus a 0.1 NEAR opening reserve (2 worlds). The owner reviews it within 14 days (`review_ttl_sec`) and approves it (your bond comes back at once) or rejects it (the bond comes back unless the owner marks it as spam). A proposal nobody reviews in 14 days ends, and the bond comes back. Once approved, it opens like a combination when its pledges reach the goal.',
          '**Kind B, a combination:** you pick one to three events that already exist and are open. No review. It needs a bond of 0.05 NEAR (`bond_market`) plus an opening reserve of 0.1, 0.15 or 0.25 NEAR for 2, 4 or 8 worlds (`reserve_w2`, `reserve_w4`, `reserve_w8`).',
        ),
        p('The **reserve** pays for the storage the new market will use; what the opening does not spend comes back to you. The **bond** discourages spam.'),
        h3('Goal and pledges'),
        p('Each proposal has a **goal** in USDC, set by the contract when you propose. It works from a target pool depth of 15,000 USDC (`goal_depth_usdc`), rounds to the next 1,000 USDC and is never under 10,000 USDC (`min_goal_usdc`). Anyone can **pledge** wNEAR or USDC toward the goal: at least 10 USDC or 3 wNEAR per pledge (`min_pledge_usdc`, `min_pledge_wnear`). Pledges count at the current NEAR price. The pools need both assets, so a goal usually needs some wNEAR too; the proposal page says which asset helps most.'),
        p('**Auto-open:** the pledge that reaches the goal opens the market by itself, in the same transaction chain. Anyone can also press **Open the market** on a ready proposal. Opening needs an outside NEAR price at most 1 hour old, and the NEAR price the new market starts from (read from the SPICE × Fed market) must sit within 10% of it (`max_external_divergence_bps`).'),
        p('**After opening:** the pledges become the market’s starting pool liquidity. Pledgers own it as seed shares, locked for 7 days (`seed_lock_sec`); after that they can withdraw. Any part of a pledge the pools did not use can be claimed back (`claim_unused`).'),
        p('**Refunds:** before the opening, a pledger can take back a pledge at any time. A proposal expires after 60 days (`proposal_ttl_sec`), or sooner so the market keeps 3 days before its first event’s deadline (`min_market_life_sec`). If it expires, is rejected or ends for another reason (for example one of its events is answered first), every pledge comes back in full (**Get my refund**).'),
        p('**Bond outcome for a combination:** the bond comes back when the market opens, or at expiry if at least 10% of the goal was pledged (`spam_floor_bps`). Under 10% at expiry, the bond is kept as spam protection. A proposer can cancel a proposal nobody has pledged to: the reserve comes back, but a combination’s bond is kept (a new event’s bond comes back while it is still in review). A new event’s bond already came back at approval.'),
        p('Limits per account: at most 4 live proposals (`max_active_per_account`) and 32 pledges (`max_pledges_per_account`).'),
        note('All of these values come from `market_params` on staging. Markets 4 to 10 on the site were opened this way.'),
      ],
    },
    {
      id: 'keeper',
      toc: 'The keeper',
      title: 'The keeper',
      blocks: [
        p('A **keeper** is a small program that does routine work nobody should have to do by hand. Ours runs as a function next to the site (`/api/keeper/`). Each round it:'),
        ol(
          '**Posts the outside NEAR/USD price** with the reporter’s key when the stored one is 5 minutes old or more, after checking the contract’s own rules (sources, spread, delay).',
          `**Keeps the lendable market near the real price** with the maker account (\`${a.maker}\`): if the pools imply a NEAR price more than 4% away from the reference, it trades them back in one transaction.`,
          `**Liquidates unhealthy loans** with the keeper account (\`${a.keeper}\`): it finds loans below health 1, asks the contract for a quote and liquidates, taking cash when the sale covers the repayment, else tokens.`,
        ),
        p('It runs when someone has the site open (each browser asks it at most once a minute, from a visible tab) and on a schedule. Rounds cannot double up: each key signs with a nonce tied to the current block window, so a second round in the same window is refused by the chain.'),
        p('Nothing depends on the keeper for safety. If it stops, the reference grows stale and new borrowing pauses; anyone can still liquidate from the At-risk page.'),
      ],
    },
    {
      id: 'safety',
      toc: 'Safety',
      title: 'Safety: pauses, invariants, storage',
      blocks: [
        p('**Pause flags.** The owner (or a guardian, if set) can pause one group of actions at a time without stopping the rest. There are eight flags: `trade`, `mint`, `transfer`, `lend`, `liquidate`, `oracle`, `pledge` and `exit` (only the owner may set `exit`; only the owner may unpause). Repaying, adding collateral, plain deposits, storage deposits and views are never paused. `pause_state` shows what is paused; today nothing is.'),
        p('**Invariants.** The backing rule (every world balances) is checked by `assert_conservation`. Answers can only raise health. Every value-moving call needs 1 yoctoNEAR attached, which proves a full-access key signed it.'),
        p('**Refunds instead of losses.** Tokens arrive with `ft_transfer_call`. If the action fails or uses less than was sent, the contract returns the rest in the same transaction. There is no separate token approval step.'),
        p('**Storage deposits.** NEAR charges for the bytes an account uses in a contract. You register once with 0.1 NEAR (`storage_balance_bounds`), and the site adds 0.1 NEAR more when your free deposit falls under 0.02 NEAR. Returned bonds and reserves land in this deposit; **storage_withdraw** sends the free part back to your wallet.'),
        p('**Not audited.** This is testnet code with test tokens. Treat it as a working demo.'),
      ],
    },
    {
      id: 'costs',
      toc: 'Costs and wallets',
      title: 'Costs, NEAR and wallets',
      blocks: [
        p('You need a NEAR **testnet** account and a little testnet NEAR. NEAR is only for fees and storage; the trading tokens are test wNEAR and test USDC from the site.'),
        table(
          ['What', 'Cost'],
          ['Registering with the contract (once)', '0.1 NEAR, kept as your storage deposit'],
          ['Everyday actions (split, hedge, supply, repay, collateral)', '150 Tgas attached; about 0.17 NEAR must be free when you sign, most of it comes back'],
          ['Heavy actions (pledge, liquidate, propose, open, OutLayer requests)', '300 Tgas; about 0.31 NEAR must be free when you sign'],
          ['Order book page trades', '20 Tgas per order filled, 30 per pool swap, 25 to post an order'],
          ['A new event proposal', '0.2 NEAR bond + 0.1 NEAR reserve'],
          ['A combination proposal', '0.05 NEAR bond + 0.1 / 0.15 / 0.25 NEAR reserve'],
        ),
        p('**Gas** is the fee for computation. On testnet you pay for the gas you attach up front (1 NEAR per 1,000 Tgas) and get back what is not burnt a few blocks later; real actions burn far less than they attach. A new visitor needs roughly 0.27 NEAR to register and do the everyday actions.'),
        h3('Getting testnet NEAR'),
        ul(
          '**If you have a funded top-level `.testnet` account:** use [near-faucet.io](https://near-faucet.io) to top it up.',
          '**If you have 0 NEAR:** the NEAR CLI (near-cli-rs) can create a new account funded with 10 NEAR by the faucet service. Then import its key into your wallet. Use `print-to-terminal` in place of `save-to-keychain` to see the key.',
        ),
        code('near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create'),
        h3('Test tokens'),
        p('Open the wallet menu (top right) and press **Get test tokens**. It mints a drop of test wNEAR and USDC to you and registers you with the contract (up to three wallet approvals). Test tokens have no value.'),
        h3('Wallets that work'),
        p('The site connects through NEAR Connect. On testnet, **Meteor**, **Intear** and **Nightly** work.'),
      ],
    },
    {
      id: 'guides',
      toc: 'Step-by-step guides',
      title: 'Step-by-step guides',
      blocks: [
        h3('Connect and get test tokens'),
        ol('Press **Connect wallet** (top right) and pick your wallet.', 'Open the wallet menu and press **Get test tokens**. Approve each step in your wallet.', 'The menu now shows your wNEAR and USDC.'),
        h3('Split or merge'),
        ol('Open [Markets](/markets/) and pick a market.', 'In the ticket on the right, the **Fund** tab splits wNEAR or USDC into every world. Enter an amount and press the **Split into …** button.', 'To merge, press **Merge a full set back** under the Fund ticket. It opens the Split page in merge mode; press **Merge back into …**.'),
        h3('Hedge (sell NEAR in the worlds you fear)'),
        ol('On a market, press **Hedge** next to each world you fear, or open the **Hedge** tab.', 'Enter the wNEAR to hedge. The ticket shows what you get and what you hold after.', 'Optionally turn on keeping the result as loan collateral and pick a **Collateral tier**.', 'Press **Sell NEAR in N worlds** and approve.'),
        h3('Trade on the order book'),
        ol('Open [Order book](/orders/) and pick a market and a world.', 'This page trades what you already hold inside that world. If you hold nothing there, press **Add funds** (it opens the Split page) and split first.', 'Pick the order type: **Market** fills the best orders, then the pool; **Limit** takes the orders that cross your price, then leaves the rest on the book at your price until it fills, you cancel it or it expires (**Good for**). A limit order never uses the pool.', 'In the buy or the sell ticket, enter the NEAR amount and press **Buy NEAR** or **Sell NEAR**. Your orders are under **Open orders (…)**; cancel one with **Cancel**.'),
        h3('Lend USDC'),
        ol('Open [Lend](/lend/) and pick a tier (Safe, Normal or Bold).', 'In **Supply**, enter the USDC to supply and press **Supply …**.', 'To leave, open **Withdraw**, enter an amount or press **Max** (the button reads **Withdraw all** when the tier can pay it all now). **Insure** donates to the tier’s insurance fund.'),
        h3('Borrow'),
        ol('Get collateral: hedge with collateral kept, or use **Add collateral** on the [Borrow](/borrow/) page to post wNEAR or USDC.', 'Pick the tier (Safe, Normal or Bold) and switch to **Borrow**. Enter the USDC to borrow; the page shows your new health.', 'Press **Borrow …** and approve. The USDC arrives in your wallet.'),
        h3('Repay'),
        ol('On the Borrow page, choose **Repay**.', 'Enter the USDC to repay, or press **All** (the button then reads **Repay all**). Approve.'),
        h3('Liquidate'),
        ol('Open [At-risk loans](/liquidate/) and set the health to show.', 'Press **Liquidate** on a loan below 1 and choose **Max** or **An amount**, and **Cash (USDC)** or **World tokens**.', 'Press **Liquidate for cash** or **Liquidate for tokens** and approve.'),
        h3('Propose a market'),
        ol('Open [Propose](/propose/) (the **New proposal** view). Choose **A new event** or **Combine events**.', 'For a combination, pick one to three open events. For a new event, fill in the question, outcomes, rule, source, deadline, category and starting odds.', 'Press **Propose · …**, which shows the NEAR it attaches (bond + reserve).'),
        h3('Pledge, refund, claim'),
        ol('Open [Proposals](/proposals/) or a proposal’s page.', 'Choose **Pledge in** wNEAR or USDC, enter an amount and press **Pledge …**. The pledge that reaches the goal opens the market.', 'Before the opening, **Withdraw pledge** (on the list) or **Withdraw everything** (on the proposal’s page) takes it back. After an expiry or rejection, **Get my refund**. After the opening, **Claim the unused part** returns what the pools did not use.'),
        h3('Resolve, finalize, redeem'),
        ol('Open [Resolve](/resolve/) and pick a market. Each event shows where it stands: Open, Proposed, Dispute window, Final.', 'For a Fed event, **Ask OutLayer to read FRED**. After the dispute window, press **Finalize**.', 'Once an answer is final, press **Redeem** to turn tokens that are now certain to pay into real tokens, and close any loan with **Close … and redeem**.'),
        h3('Your positions'),
        p('[Portfolio](/portfolio/) lists your **Positions** and **Open orders** across markets.'),
      ],
    },
    {
      id: 'live',
      toc: 'Live on testnet',
      title: 'Live on testnet',
      blocks: [
        p(`Everything runs in one contract on NEAR testnet with test tokens. The live site is ${SITE_URL}. These transactions ran on it on 14 November 2026 (open them on the explorer):`),
        { type: 'live', widget: 'txs', md: TXS.map((t) => `- ${t.what} (${t.who}): \`${t.hash}\``).join('\n') },
        { type: 'live', widget: 'accounts', md: [
          `- Protocol contract: \`${a.contract}\``,
          `- Owner: \`${a.owner}\``,
          `- Reporter: \`${a.reporter}\``,
          `- Keeper: \`${a.keeper}\``,
          `- Maker: \`${a.maker}\``,
          `- Test wNEAR: \`${a.wnear}\``,
          `- Test USDC: \`${a.usdc}\``,
        ].join('\n') },
      ],
    },
    {
      id: 'developers',
      toc: 'For developers and agents',
      title: 'For developers and agents',
      blocks: [
        p(`This part is for programs and people who want to call the contract directly. The whole guide is also at [/docs.md](/docs.md) as plain Markdown, and [/llms.txt](/llms.txt) points to it.`),
        h3('Accounts and decimals'),
        table(
          ['Role', 'Account', 'Decimals'],
          ['Protocol contract (NEP-245 verse tokens)', `\`${a.contract}\``, '18 (internal)'],
          ['Test wNEAR (NEP-141)', `\`${a.wnear}\``, '24'],
          ['Test USDC (NEP-141)', `\`${a.usdc}\``, '6'],
          ['Owner', `\`${a.owner}\``, ''],
          ['Reporter', `\`${a.reporter}\``, ''],
        ),
        p('Amounts inside the contract (call args, msgs, views) are 18-decimal integers as strings, whatever the token. The `amount` of an `ft_transfer_call` is in the token’s own units (24 for wNEAR, 6 for USDC). Example: 25 USDC is `"25000000"` in `ft_transfer_call` and `"25000000000000000000"` inside a msg.'),
        h3('Main views'),
        table(
          ['View', 'Arguments', 'Returns'],
          ['`get_app_config`', '`{}`', 'owner, reporter, tokens, dispute window, TWAP, fees, limits, lending defaults'],
          ['`list_markets`', '`{ from_id, limit, listed_only }`', 'markets with events, worlds, odds, world prices, implied spot, depth, lendable'],
          ['`get_events`', '`{ event_ids: [1, 2] }`', 'questions, rules, outcomes, deadlines, answers'],
          ['`lending_tiers`', '`{ scenario_id }`', 'each tier’s supply, borrow, rates, insurance, config'],
          ['`market_params`', '`{}`', 'proposal bonds, reserves, goals, pledge limits'],
          ['`get_reference` / `get_reference_config`', '`{}`', 'the outside NEAR/USD price and its rules'],
          ['`get_market_price_config` / `price_check`', '`{ scenario_id }`', 'how a market prices worlds for lending'],
          ['`pause_state`', '`{}`', 'paused flags'],
          ['`mt_balance_of`', '`{ account_id, token_id }`', 'a verse balance, token id `{market}:{asset}:{mask}`'],
          ['`storage_balance_of`', '`{ account_id }`', 'your NEP-145 storage deposit'],
        ),
        h3('Main calls'),
        p('Direct calls attach 1 yoctoNEAR (unless noted) and 150 Tgas:'),
        code([
          'merge { scenario_id, asset: "wnear"|"usdc", from_masks: [1,2,4,8], to_mask: 15, amount }',
          'borrow { scenario_id, amount, tier? }',
          'withdraw_collateral { scenario_id, piece, amount, tier? }',
          'withdraw_supply { scenario_id, amount | null, tier? }',
          'cancel_order { order_id }',
          'redeem { scenario_id, asset, mask, amount }',
          'close_after_resolution { scenario_id, tier? }',
          'finalize { event_id }                       (no deposit)',
          'propose_market { event_ids }                (deposit = bond + reserve, 300 Tgas)',
          'withdraw_pledge { proposal_id, wnear: null, usdc: null }',
          'open_market { proposal_id }                 (no deposit, 300 Tgas)',
          'storage_deposit { account_id, registration_only }   (0.1 NEAR first time)',
        ].join('\n')),
        p('`tier` is `"safe"`, `"normal"` or `"bold"`; left out, it means Normal.'),
        h3('ft_transfer_call messages'),
        p(`Real tokens move with \`ft_transfer_call\` on the token contract, \`receiver_id\` = \`${a.contract}\`, 1 yoctoNEAR attached, and a JSON \`msg\` (a string) naming the action. The contract refunds what it does not use.`),
        code([
          '{"action":"split","scenario_id":1,"to_masks":[1,2,4,8]}',
          '{"action":"conditional_sell","scenario_id":1,"sell_mask":10,"plans":[[],[],[],[]],"min_out":["0","…","0","…"],"to_lending":false}',
          '{"action":"conditional_buy","scenario_id":1,"buy_mask":1,"plans":[[],[],[],[]],"min_out":["…","0","0","0"],"to_lending":false}',
          '{"action":"post_order","scenario_id":1,"mask":4,"side":"bid","price":"…","amount":"…","expiry_sec":1797000000}',
          '{"action":"supply","scenario_id":1,"tier":"safe"}',
          '{"action":"deposit_collateral","scenario_id":1}',
          '{"action":"repay","scenario_id":1,"all":true}',
          '{"action":"liquidate","scenario_id":1,"account_id":"…","repay_amount":"max","receive":"cash","min_out":"…"}',
          '{"action":"fund_insurance","scenario_id":1,"tier":"bold"}',
          '{"action":"pledge","proposal_id":18}',
          '{"action":"close_after_resolution","scenario_id":1}',
        ].join('\n')),
        p('`plans` has one array per world: the orders to fill there, as `{ "order_id", "amount" }`; an empty array means the pool only. `min_out` has one minimum per world, `"0"` where nothing is traded. A tokens-mode liquidation sends neither `receive` nor `min_out`.'),
        h3('Errors'),
        p('A refused call fails with a short code, for example `Paused(trade)`, `ReferenceStale(4000, 3600)`, `ReferenceDeviation(…)` or `InsufficientStorage(…)`. The site turns each into plain words.'),
      ],
    },
    {
      id: 'glossary',
      toc: 'Glossary',
      title: 'Glossary',
      blocks: [
        { type: 'terms', items: [
          ['Event', 'One real yes-or-no question with a rule, a public source and a deadline.'],
          ['Outcome', 'One of an event’s two answers, like SHIPS or DELAYED.'],
          ['Market (scenario)', 'One to three events together, with all their worlds, pools and order books.'],
          ['World', 'One combination of the events’ answers. 1, 2 or 3 events make 2, 4 or 8 worlds.'],
          ['Mask', 'A set of worlds as bits; bit w on means world w is in the set.'],
          ['Verse token', 'One asset on one mask of one market, for example wNEAR-if-world-2. It pays in the worlds of its mask only.'],
          ['Split / merge', 'Turn real tokens into the same amount in every world, or a full set back into real tokens.'],
          ['Redeem', 'Turn the surviving world’s tokens into real tokens, one for one.'],
          ['Dead world', 'A world an answer has ruled out. Its tokens are worth nothing.'],
          ['Chance', 'The price of a world’s dollar: what the market thinks the world’s probability is.'],
          ['Implied spot', 'The chance-weighted average of NEAR’s price across worlds.'],
          ['World pool', 'An automatic market maker trading NEAR-if-world against USDC-if-world.'],
          ['Odds pool', 'An automatic market maker trading one outcome’s dollar against the other’s.'],
          ['TWAP', 'Time-weighted average price, here over 30 minutes.'],
          ['Bid / ask', 'A standing offer to buy / to sell at a set price.'],
          ['Tier', 'Safe, Normal or Bold: a separate lending pool with its own limits and rates.'],
          ['Worst world', 'The world where your collateral is worth least. Loans are measured on it.'],
          ['Health factor', 'Worst-world value × liquidation line ÷ debt. Below 1, the loan can be liquidated.'],
          ['Utilization', 'The share of a tier’s USDC that is lent out. Rates follow it.'],
          ['Liquidation', 'Repaying part of an unhealthy loan in exchange for its collateral plus a bonus.'],
          ['Insurance fund', 'A tier’s reserve that pays bad debt before lenders do.'],
          ['Reference price', 'The outside NEAR/USD median that lending checks the pools against.'],
          ['Reporter', 'The account that proposes answers with evidence and posts the reference price.'],
          ['OutLayer', 'A service that runs a small program in a secure enclave and returns its result to the contract.'],
          ['Dispute window', 'The time after a proposed answer during which the owner can dispute it.'],
          ['Proposal / pledge', 'A request for a new market, and money promised toward its goal.'],
          ['Bond / reserve', 'NEAR a proposer locks: the bond against spam, the reserve for the new market’s storage.'],
          ['Keeper', 'The bot that posts the reference price, keeps pools near it and liquidates.'],
          ['Storage deposit', 'NEAR held by the contract to pay for the bytes your account uses.'],
          ['Tgas', 'A unit of NEAR gas (10¹² gas).'],
        ] },
      ],
    },
    {
      id: 'faq',
      toc: 'FAQ',
      title: 'Questions people ask',
      blocks: [
        h3('Is this real money?'),
        p('No. It runs on NEAR testnet with test tokens that have no value.'),
        h3('Why does splitting not cost anything?'),
        p('Because one token in every world is worth exactly one real token: exactly one world will happen. You only pay gas.'),
        h3('Can I lose more than I put in?'),
        p('You can lose your collateral if your loan is liquidated, but you never owe more than your loan: the USDC you borrowed is yours to keep.'),
        h3('Why can I not borrow on some markets?'),
        p('Only markets marked lendable have tiers. Today that is market 1, SPICE × Fed. Borrowing also pauses when the outside price is stale or far from the pools.'),
        h3('What happens to my tokens in a world that dies?'),
        p('They are worth nothing. That is the other side of holding dollars or NEAR only in some worlds.'),
        h3('Who decides the answers?'),
        p('The rule and public source of each event. The reporter or OutLayer proposes; after the dispute window anyone can finalize.'),
        h3('Why did my transaction need 0.3 NEAR when it burned almost nothing?'),
        p('Testnet charges for the gas you attach when you sign and refunds the unused part a few blocks later.'),
        h3('Can a program or a bot use this?'),
        p('Yes. Read [/docs.md](/docs.md), then use the views and the ft_transfer_call messages in the developers section.'),
      ],
    },
    {
      id: 'limits',
      toc: 'Limits and gaps',
      title: 'Limits and known gaps',
      blocks: [
        ul(
          '**Testnet only, test tokens, not audited.** Nothing here is real money.',
          '**At most three events per market.** Each event doubles the worlds and the pools that need liquidity.',
          '**New events need the owner.** Combinations of open events do not, but a brand-new event waits for review.',
          '**Prices lag up to 30 minutes.** Loans use 30-minute averages, so in a fast crash the contract reacts late, and someone with enough money could hold one world’s price down for that window.',
          '**The outside price needs the keeper.** If nobody posts NEAR/USD for an hour, new borrowing pauses until someone does.',
          '**Joint odds start out independent.** A new combination opens as if its events do not affect each other; only trading corrects that.',
          '**One lendable market.** Lending runs on market 1 only; the others are for trading.',
          '**Proposals need both assets.** A goal usually needs wNEAR as well as USDC, because every world pool needs both sides.',
          '**No decision markets yet.** They are on the [roadmap page](/decision-markets/), not in the contract.',
        ),
      ],
    },
  ]
}

/** Real transactions on the staging deployment, each checked on chain: the smoke runs of 14 Nov 2026. */
export const TXS: { what: string; who: string; hash: string }[] = [
  { what: 'The v2 contract deployed', who: 'app', hash: 'C3KthRtFPyJa68XRXNqBjvE6LpTqZfPgKsAo2U73bcpU' },
  { what: 'Split 10 wNEAR into the four worlds of SPICE × Fed', who: 'a fresh account', hash: '8PiGoktaQrvKbR9xQVM9sC6q9NVRVL71DxXuQ5eehDDK' },
  { what: 'Sold that NEAR in one world, Delayed & cuts', who: 'the same account', hash: '5CvVwf2yLsQZzDVsUvx5XxPCjD9hUmcda8Qh7iHc6q2F' },
  { what: 'Posted an ask for NEAR in Ships & holds', who: 'bob', hash: 'Ar9bjstgtNF2AFVE15jyFobn6aLAJdfKkAV5A8cAtjNA' },
  { what: 'Bought 2 NEAR from that ask', who: 'the same account', hash: 'Ai3tNvAD6sDi6GYjySQMopS5bJCip44fzz9SaTDJ7nT1' },
  { what: 'Sold NEAR straight into loan collateral', who: 'the same account', hash: '3Us4dxEGopbRGNY4p8AtdEqRa3JPbqujUR4HJUA9MuB7' },
  { what: 'Lent 150 USDC to the Normal tier', who: 'sam', hash: 'CarV5RRGdwLe1o2o9nJuApGwWZ5oYe213GDkdTMFFzbi' },
  { what: 'Borrowed 110 USDC', who: 'uma', hash: '6aWQo6owFhwsuA37oekhRPq4URYWU5Yz19TUJh9ioWsL' },
  { what: 'Repaid it all', who: 'uma', hash: 'Hr8Te74cVvymD8BLFTzrnnUcg7PsvhivFVy15KHUmVMs' },
  { what: 'Posted the outside NEAR/USD price', who: 'reporter', hash: '6FiZKCn78TnTnnUSbMeWGMBqPG1vrRN5tnN4uRDNrqrd' },
  { what: 'Proposed a new event: NEAR above $3.25 on 31 Dec', who: 'sam', hash: '39Eu1oWYGZHmj9pMJRsJhVuNenVjzeRLp1QUFXWfZVnz' },
  { what: 'Approved it', who: 'owner', hash: '7etK5dUxeD6hRCi2n9j1RhLDunZ9PUcKdx6xrdeSYkGp' },
  { what: 'Proposed the December Fed event as a market', who: 'uma', hash: 'F69pf735E5XLuRnzUJ8hggD5S6bG7AtMQ5b228qXPwZX' },
  { what: 'The pledge that reached its goal and opened it', who: 'alice', hash: '5vFZLCzAniB96gvVsudAY9WuMcKqk42ddxh8NXqAViAR' },
  { what: 'Paused pledges', who: 'owner', hash: 'DoaqE9h9JfiEps8MYPQSu97fLyJsp6uZWM5a4hqGrcET' },
  { what: 'Unpaused them', who: 'owner', hash: '2hPyr89awCrvpmmHD29Sgauy4Z14EkQtSbXHaxittQMn' },
  { what: 'OutLayer asked to read FRED for the October Fed meeting', who: '–', hash: 'GH1fftYYX8RU56GsgyAadCM1yfHHFdmzcvhDdUQrijqy' },
  { what: 'October Fed answer (HOLDS) finalized', who: '–', hash: '5C1dsLULtK2cnLCneEHwCWtUM86AsBKiWSHdvBLkjYfW' },
  { what: 'Reporter answered NEAR on 1 Nov (YES) with evidence', who: 'reporter', hash: '4JUNNwUAZzHArvY6TwBtiZftuztFAxiqsQs59rmpyK9R' },
  { what: 'NEAR on 1 Nov answer finalized', who: '–', hash: 'C6et7nkCPb6tdLyqZZqw7dnDGHHZfwXpDVvtmZn6vvYw' },
]
