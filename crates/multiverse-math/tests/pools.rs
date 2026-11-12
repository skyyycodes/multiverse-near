//! The pool layer at the maths level: the dynamic-fee and TWAP tests of `VerseHook.t.sol`, `PoolSeeder.t.sol`'s
//! price moves, the odds tests of `MultiverseLens.t.sol`, and the demo's golden numbers,
//! run against the constant-product pool that replaces Uniswap v4.
//!
//! Orientation as on NEAR: a within-world pool has wNEAR-if-w as token0 and USDC-if-w as token1, a between-world pool
//! has the lower mask as token0. The fee window measures token0 in both.

use multiverse_math::cpmm::{Pool, Position, SwapResult};
use multiverse_math::flow::SwapFlow;
use multiverse_math::twap::TwapOracle;
use multiverse_math::{odds, orders, price, risk, U256, WAD};
use proptest::prelude::*;

const BASE_FEE: u32 = 3000;
const MAX_FEE: u32 = 15000;
const LLTV: u128 = 750_000_000_000_000_000;

/// The demo scripts' `_fmt`: integer part, a point, two decimals rounded down.
fn fmt(amount: u128) -> String {
    format!(
        "{}.{:02}",
        amount / WAD,
        amount % WAD / 10_000_000_000_000_000
    )
}

/// A pool as the contract keeps it: curve and fees, the fee window and the TWAP.
struct VersePool {
    pool: Pool,
    flow: SwapFlow,
    oracle: TwapOracle,
    now: u64,
}

impl VersePool {
    /// Full range at `price` (USDC per wNEAR, WAD) with `depth` wNEAR and `floor(depth * price / 1e18)` USDC, as
    /// SeedDemo seeds the world pools.
    fn seed(price: u128, depth: u128) -> Self {
        let usdc = multiverse_math::mul_div_down(depth, price, WAD);
        Self::with_reserves(depth, usdc)
    }

    fn with_reserves(reserve0: u128, reserve1: u128) -> Self {
        let mut pool = Pool::new();
        pool.mint_initial(&mut Position::new(), reserve0, reserve1)
            .unwrap();
        let now = 1_700_000_000;
        let oracle = TwapOracle::new(now, pool.tick().unwrap());
        Self {
            pool,
            flow: SwapFlow::new(),
            oracle,
            now,
        }
    }

    fn fee_of(&self) -> u32 {
        self.flow.fee(BASE_FEE, MAX_FEE)
    }

    /// What the hook did after every swap: a TWAP point at the post-swap tick, then the flow record.
    fn after_swap(&mut self, swap: &SwapResult) {
        self.oracle.write(self.now, self.pool.tick().unwrap());
        self.flow
            .record_swap(swap.zero_for_one, swap.amount_in, swap.amount_out);
    }

    /// Exact-input sale of wNEAR-if-w (or token0).
    fn sell(&mut self, amount: u128) -> (SwapResult, u32) {
        let fee = self.fee_of();
        let swap = self.pool.swap_exact_in(true, amount, fee).unwrap();
        self.after_swap(&swap);
        (swap, fee)
    }

    /// Exact-output purchase of wNEAR-if-w (or token0).
    fn buy(&mut self, amount: u128) -> (SwapResult, u32) {
        let fee = self.fee_of();
        let swap = self.pool.swap_exact_out(false, amount, fee).unwrap();
        self.after_swap(&swap);
        (swap, fee)
    }

    /// Exact-input swap of token1 into the pool.
    fn sell_token1(&mut self, amount: u128) -> (SwapResult, u32) {
        let fee = self.fee_of();
        let swap = self.pool.swap_exact_in(false, amount, fee).unwrap();
        self.after_swap(&swap);
        (swap, fee)
    }

    fn flow_of(&self) -> (i128, u128, u64) {
        let window = self.flow.window();
        let net = i128::try_from(window.net_abs().low_u128()).unwrap();
        let net = if window.net_is_negative() { -net } else { net };
        (net, window.total().low_u128(), self.flow.count())
    }

    fn wnear_price(&self) -> u128 {
        self.pool.price_wad().unwrap()
    }
}

#[test]
fn fee_base_without_history() {
    let mut p = VersePool::seed(2_500 * WAD, 100 * WAD);
    assert_eq!(p.flow_of(), (0, 0, 0));
    assert_eq!(p.fee_of(), BASE_FEE);
    let (swap, fee) = p.sell(WAD);
    assert_eq!(fee, BASE_FEE);
    assert_eq!(swap.fee_amount, 3_000_000_000_000_000);
    // After one 1 wNEAR sale the window is [-1e18], entirely one-sided.
    assert_eq!(p.fee_of(), MAX_FEE);
}

#[test]
fn fee_base_with_balanced_flow() {
    let mut p = VersePool::seed(2_500 * WAD, 100 * WAD);
    for _ in 0..4 {
        p.sell(WAD);
        p.buy(WAD);
        assert_eq!(p.fee_of(), BASE_FEE);
    }
    // netSold 0, total 8e18, 8 swaps (flowOf reports (net, total, swaps)).
    assert_eq!(p.flow_of(), (0, 8 * WAD, 8));
    assert_eq!(p.sell(WAD).1, BASE_FEE);
}

#[test]
fn fee_rises_under_one_sided_flow() {
    let mut p = VersePool::seed(2_500 * WAD, 100 * WAD);
    for _ in 0..4 {
        p.buy(WAD);
    }
    for _ in 0..4 {
        p.sell(WAD);
    }
    // Each sale pushes one buy out of the window: |net| / total = 0, 2/8, 4/8, 6/8, 8/8, 8/8.
    let paid: Vec<u32> = (0..6).map(|_| p.sell(WAD).1).collect();
    assert_eq!(paid, [3000, 6000, 9000, 12000, 15000, 15000]);
}

#[test]
fn fee_rounds_up_in_the_pools_favour() {
    let mut p = VersePool::seed(2_500 * WAD, 100 * WAD);
    p.sell(WAD + 1);
    p.buy(WAD);
    // net 1, total 2e18 + 1: 3000 + ceil(12000 / (2e18 + 1)) = 3001.
    assert_eq!(p.flow_of(), (1, 2 * WAD + 1, 2));
    assert_eq!(p.fee_of(), 3001);
}

#[test]
fn fee_is_per_pool() {
    let mut delayed_holds = VersePool::seed(2_500 * WAD, 100 * WAD);
    let ships_cuts = VersePool::seed(3_700 * WAD, 100 * WAD);
    for _ in 0..3 {
        delayed_holds.sell(WAD);
    }
    assert_eq!(delayed_holds.fee_of(), MAX_FEE);
    assert_eq!(ships_cuts.fee_of(), BASE_FEE);
}

#[test]
fn fee_volume_is_the_wnear_side_whichever_way_it_moves() {
    let mut p = VersePool::seed(3_000 * WAD, 100 * WAD);
    p.sell(WAD);
    assert_eq!(p.flow_of(), (WAD as i128, WAD, 1));
    // Paying USDC in buys wNEAR out: the window records the wNEAR bought, not the USDC paid.
    let (swap, _) = p.sell_token1(3_000 * WAD);
    assert_eq!(p.flow.volumes()[1], swap.amount_out as i128);
}

#[test]
fn fee_between_world_pool() {
    // SHIPS·HOLDS (0x4, token0) against DELAYED·HOLDS (0x8) at 6667:3333, 1,000,000 deep on the less likely side.
    let (r_x, r_y) = odds::seed_reserves(6667, 3333, 1_000_000 * WAD);
    let mut p = VersePool::with_reserves(r_x, r_y);
    assert_eq!(p.sell(1_000 * WAD).1, BASE_FEE);
    assert_eq!(p.fee_of(), MAX_FEE);
    assert_eq!(p.buy(1_000 * WAD).1, MAX_FEE);
    assert_eq!(p.flow_of(), (0, 2_000 * WAD, 2));
    assert_eq!(p.fee_of(), BASE_FEE);
}

#[test]
fn fee_dust_swaps_do_not_reset_the_window() {
    let mut p = VersePool::seed(2_500 * WAD, 100 * WAD);
    for _ in 0..8 {
        p.sell(WAD);
    }
    for _ in 0..8 {
        // 1 wei of USDC-if-w in buys no wNEAR, so nothing is recorded (but the TWAP still gets a point).
        let (swap, _) = p.sell_token1(1);
        assert_eq!(swap.amount_out, 0);
    }
    assert_eq!(p.flow_of(), (8 * WAD as i128, 8 * WAD, 8));
    assert_eq!(p.fee_of(), MAX_FEE);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// testFuzz_fee_oneSidedFromEmptyHistory: ten sales of 1e9..2e18; the first pays the base fee, the rest the cap.
    #[test]
    fn fee_one_sided_from_empty_history(sizes in proptest::collection::vec(1_000_000_000u128..=2 * WAD, 10)) {
        let mut p = VersePool::seed(2_500 * WAD, 100 * WAD);
        let mut last = 0;
        for (i, size) in sizes.into_iter().enumerate() {
            let fee = p.sell(size).1;
            prop_assert_eq!(fee, if i == 0 { BASE_FEE } else { MAX_FEE });
            prop_assert!(fee >= last);
            last = fee;
        }
    }

    /// testFuzz_fee_matchesTheFormula: twenty swaps of 1e9..3e18 either way (sales exact input, purchases exact
    /// output); every fee equals an independent evaluation of the formula over the previous eight recorded swaps.
    #[test]
    fn fee_matches_the_formula(swaps in proptest::collection::vec((any::<bool>(), 1_000_000_000u128..=3 * WAD), 20)) {
        let mut p = VersePool::seed(2_500 * WAD, 100 * WAD);
        let mut recorded: Vec<i128> = Vec::new();
        for (is_sale, size) in swaps {
            let window = &recorded[recorded.len().saturating_sub(8)..];
            let total: u128 = window.iter().map(|v| v.unsigned_abs()).sum();
            let net = window.iter().sum::<i128>().unsigned_abs();
            let expected = if total == 0 { 3000 } else { 3000 + (12_000 * net).div_ceil(total) as u32 };
            let (swap, fee) = if is_sale { p.sell(size) } else { p.buy(size) };
            prop_assert_eq!(fee, expected);
            prop_assert!((BASE_FEE..=MAX_FEE).contains(&fee));
            let volume = if is_sale { -(swap.amount_in as i128) } else { swap.amount_out as i128 };
            prop_assert_eq!(volume.unsigned_abs(), size);
            recorded.push(volume);
        }
    }
}

#[test]
fn mean_tick_needs_a_full_window_of_history() {
    let mut p = VersePool::seed(2_500 * WAD, 100 * WAD);
    let seeded = p.pool.tick().unwrap();
    assert_eq!(p.oracle.mean_tick(p.now, 60), None);
    p.now += 59;
    assert_eq!(p.oracle.mean_tick(p.now, 60), None);
    p.now += 1;
    assert_eq!(p.oracle.mean_tick(p.now, 60), Some(seeded));
}

#[test]
fn mean_tick_is_time_weighted() {
    let mut p = VersePool::seed(2_500 * WAD, 100 * WAD);
    p.now += 100;
    let tick0 = p.pool.tick().unwrap();
    p.sell(5 * WAD);
    let tick1 = p.pool.tick().unwrap();
    assert!(tick1 < tick0);
    p.now += 30;
    let expected = (i64::from(tick0) * 30 + i64::from(tick1) * 30).div_euclid(60);
    assert_eq!(p.oracle.mean_tick(p.now, 60), Some(expected as i32));
}

#[test]
fn same_second_swaps_count_once() {
    // A sale and its reversal inside one second: the deep tick in between carries no weight, only the tick the
    // second ends on does.
    let mut p = VersePool::seed(2_500 * WAD, 100 * WAD);
    let seeded = p.pool.tick().unwrap();
    p.now += 30;
    p.sell(10 * WAD);
    let low = p.pool.tick().unwrap();
    p.buy(10 * WAD);
    let end = p.pool.tick().unwrap();
    assert!(low + 1_000 < end);
    assert_eq!(p.oracle.count(), 2);
    p.now += 30;
    let expected = (i64::from(seeded) * 30 + i64::from(end) * 30).div_euclid(60);
    assert_eq!(p.oracle.mean_tick(p.now, 60), Some(expected as i32));
}

#[test]
fn seeded_prices_match_the_spec() {
    // Every world pool sits exactly at its demo price, and L = sqrt(x * y).
    let worlds = [
        (3_700, 100, 6_082),
        (3_000, 100, 5_477),
        (3_300, 100, 5_744),
        (2_500, 40, 2_000),
    ];
    for (price, depth, liquidity) in worlds {
        let p = VersePool::seed(price * WAD, depth * WAD);
        assert_eq!(p.wnear_price(), price * WAD);
        assert_eq!(p.pool.liquidity() / WAD, liquidity);
        // The v4 reading through the square-root price is within 1e-6 (here: one wei low or exact).
        let via_sqrt = price::from_sqrt_price_x96(p.pool.sqrt_price_x96().unwrap()).unwrap();
        assert!(price * WAD - via_sqrt <= 1);
    }
}

#[test]
fn demo_twap_prices() {
    // With wNEAR-if-w as token0, the TWAP of a freshly seeded pool reads one tick below the seed price.
    let expected = [
        (3_700, "3699.63"),
        (3_000, "2999.79"),
        (3_300, "3299.72"),
        (2_500, "2499.90"),
        (3_400, "3399.87"),
        (2_800, "2799.79"),
    ];
    for (seed_price, twap_cents) in expected {
        let mut p = VersePool::seed(seed_price * WAD, 100 * WAD);
        p.now += 61;
        let mean = p.oracle.mean_tick(p.now, 60).unwrap();
        let twap = price::wnear_price_at_tick(mean, true).unwrap();
        assert_eq!(fmt(twap), twap_cents, "seeded at {seed_price}");
    }
}

#[test]
fn golden_demo_sale() {
    // DELAYED·HOLDS is the thin pool: 40 wNEAR / 100,000 USDC at 2,500.
    let pool_only = VersePool::seed(2_500 * WAD, 40 * WAD)
        .pool
        .quote_exact_in(true, 2 * WAD, BASE_FEE)
        .unwrap();
    assert_eq!(fmt(pool_only.amount_out), "4748.29");
    // Averages per wNEAR: x * 1e18 / 2e18.
    assert_eq!(fmt(pool_only.amount_out / 2), "2374.14");

    // Ravi's bid fills 1 wNEAR at 2% under 2,500, then the pool takes the second wNEAR.
    let ravi_price = 2_500 * WAD * (10_000 - 200) / 10_000;
    assert_eq!(ravi_price, 2_450 * WAD);
    assert_eq!(orders::cost(WAD, ravi_price), 2_450 * WAD);
    let mut delayed_holds = VersePool::seed(2_500 * WAD, 40 * WAD);
    let (rest, fee) = delayed_holds.sell(WAD);
    assert_eq!(fee, BASE_FEE);
    let with_bid = orders::proceeds(WAD, ravi_price) + rest.amount_out;
    // The EVM run's raw proceeds for world 3, to the wei.
    assert_eq!(with_bid, 4_881_885_259_897_065_638_949);
    assert!(with_bid > pool_only.amount_out);
    assert_eq!(fmt(with_bid), "4881.88");
    assert_eq!(fmt(with_bid / 2), "2440.94");
    // "push from 2,380": the pool price after the sale.
    assert_eq!(fmt(delayed_holds.wnear_price()), "2379.88");
    // The sold pool now charges the cap on its next swap.
    assert_eq!(delayed_holds.fee_of(), MAX_FEE);

    // The other sold worlds (100 wNEAR deep) and the binary DELAYED world, against the EVM run's raw proceeds.
    let sales = [
        (
            3_000,
            5_865_050_885_346_196_835_108u128,
            "5865.05",
            "2883.84",
        ),
        (3_300, 6_451_555_973_880_816_518_618, "6451.55", "3172.23"),
        (2_800, 5_474_047_492_989_783_712_767, "5474.04", "2691.58"),
    ];
    for (seed_price, evm, proceeds, price_after) in sales {
        let mut p = VersePool::seed(seed_price * WAD, 100 * WAD);
        let (swap, _) = p.sell(2 * WAD);
        // v4 steps through square-root prices and lands within a few wei of the closed form; here within 1 wei.
        assert!(
            swap.amount_out.abs_diff(evm) <= 1,
            "{} vs {evm}",
            swap.amount_out
        );
        assert_eq!(fmt(swap.amount_out), proceeds);
        assert_eq!(fmt(p.wnear_price()), price_after);
    }

    // Alice borrows 3,000 against the L-shape sale; her worst world holds 4,881.88 USDC-if-DELAYED·HOLDS.
    let hf = risk::health_factor(with_bid, 3_000 * WAD, LLTV).unwrap();
    assert_eq!(hf, 1_220_471_314_974_266_409);
    assert_eq!(fmt(hf), "1.22");
    assert_eq!(fmt(risk::borrow_capacity(with_bid, LLTV)), "3661.41");
    let binary = risk::health_factor(5_474_047_492_989_783_712_767, 3_000 * WAD, LLTV).unwrap();
    assert_eq!(fmt(binary), "1.36");
}

#[test]
fn quote_sell_matches_execution_on_the_l_shape() {
    // MultiverseLens quoteSell(2x2, 2 wNEAR, L-shape) on the seed pools (all 100 wNEAR deep), EVM reference
    // [0, 5865050885346196835108, 6451555973880816518618, 4887542404455164029256].
    let evm = [
        0u128,
        5_865_050_885_346_196_835_108,
        6_451_555_973_880_816_518_618,
        4_887_542_404_455_164_029_256,
    ];
    let prices = [3_700, 3_000, 3_300, 2_500];
    let l_shape = 0b1110u8;
    for (w, seed_price) in prices.into_iter().enumerate() {
        let mut p = VersePool::seed(seed_price * WAD, 100 * WAD);
        if l_shape & (1 << w) == 0 {
            assert_eq!(evm[w], 0);
            continue;
        }
        let quote = p.pool.quote_exact_in(true, 2 * WAD, p.fee_of()).unwrap();
        let (swap, _) = p.sell(2 * WAD);
        assert_eq!(quote, swap);
        assert!(
            swap.amount_out.abs_diff(evm[w]) <= 1,
            "world {w}: {} vs {}",
            swap.amount_out,
            evm[w]
        );
    }
}

/// Configured odds of the 2x2 scenario from basis points: world = a + 2b, a = Glamsterdam, b = Fed.
fn independent_odds(ships_bps: u128, cuts_bps: u128) -> [u128; 4] {
    let e10 = 10_000_000_000;
    [
        ships_bps * cuts_bps * e10,
        (10_000 - ships_bps) * cuts_bps * e10,
        ships_bps * (10_000 - cuts_bps) * e10,
        (10_000 - ships_bps) * (10_000 - cuts_bps) * e10,
    ]
}

/// Between-world pools seeded at the configured odds (SeedDemo's `_seedOdds`, 1,000,000 deep), keyed by pair.
fn odds_pools(q: &[u128]) -> Vec<((u8, u8), Pool)> {
    let sum = |mask: u8| -> u128 {
        (0..q.len())
            .filter(|w| mask & (1 << w) != 0)
            .map(|w| q[w])
            .sum()
    };
    odds::pairs(q.len() as u8)
        .iter()
        .map(|&(x, y)| {
            let (r_x, r_y) = odds::seed_reserves(sum(x), sum(y), 1_000_000 * WAD);
            let mut pool = Pool::new();
            pool.mint_initial(&mut Position::new(), r_x, r_y).unwrap();
            ((x, y), pool)
        })
        .collect()
}

fn odds_from_pools(world_count: u8, possible: u8, pools: &[((u8, u8), Pool)]) -> Option<Vec<u128>> {
    odds::odds(world_count, possible, |x, y| {
        let pool = &pools.iter().find(|(pair, _)| *pair == (x, y))?.1;
        odds::share_x(pool.reserve0(), pool.reserve1())
    })
}

#[test]
fn odds_2x2_match_configured_odds() {
    let q = independent_odds(6667, 3000);
    let pools = odds_pools(&q);
    let read = odds_from_pools(4, 0b1111, &pools).unwrap();
    for w in 0..4 {
        assert!(
            read[w].abs_diff(q[w]) <= 10,
            "world {w}: {} vs {}",
            read[w],
            q[w]
        );
    }
    assert_eq!(read.iter().sum::<u128>(), WAD);
    // Implied spot at the demo prices: 3,163.359 (MultiverseLens.t.sol, within 1e-10).
    let prices = [3_700 * WAD, 3_000 * WAD, 3_300 * WAD, 2_500 * WAD];
    let implied = odds::implied_spot(&read, 0b1111, |w| Some(prices[usize::from(w)])).unwrap();
    let reference = 3_163_359_000_000_000_000_000u128;
    assert!(
        implied.abs_diff(reference) * 10_000_000_000 <= reference,
        "{implied}"
    );
    // SeedDemo seeds the spot pool from the configured odds instead, which is exact.
    assert_eq!(
        odds::implied_spot(&q, 0b1111, |w| Some(prices[usize::from(w)])),
        Some(reference)
    );
}

#[test]
fn seeded_implied_spot_from_polymarket_odds() {
    // The seed table with SHIPS at 6667 bps: the Fed odds at 100, 104 and 119 bps.
    let prices = [3_700 * WAD, 3_000 * WAD, 3_300 * WAD, 2_500 * WAD];
    let cases = [
        (100, 3_037_693_300_000_000_000_000u128),
        (104, 3_037_866_632_000_000_000_000),
        (119, 3_038_516_627_000_000_000_000),
    ];
    for (cuts_bps, implied) in cases {
        let q = independent_odds(6667, cuts_bps);
        assert_eq!(q.iter().sum::<u128>(), WAD);
        assert_eq!(
            odds::implied_spot(&q, 0b1111, |w| Some(prices[usize::from(w)])),
            Some(implied)
        );
    }
    // Binary scenario at 6667 bps and 3,400 / 2,800: 3,200.02.
    let q = [6667 * 100_000_000_000_000, 3333 * 100_000_000_000_000];
    let implied = odds::implied_spot(&q, 0b11, |w| {
        Some([3_400 * WAD, 2_800 * WAD][usize::from(w)])
    })
    .unwrap();
    assert_eq!(fmt(implied), "3200.02");
}

#[test]
fn odds_renormalize_after_resolution() {
    let q = independent_odds(6667, 3000);
    let pools = odds_pools(&q);
    // After HOLDS only SHIPS·HOLDS vs DELAYED·HOLDS is read: 0.6667 / 0.3333.
    let after_holds = odds_from_pools(4, 0b1100, &pools).unwrap();
    assert_eq!(after_holds[..2], [0, 0]);
    assert!(after_holds[2].abs_diff(666_700_000_000_000_000) <= 10);
    assert_eq!(after_holds[2] + after_holds[3], WAD);
    // After DELAYED only CUTS vs HOLDS: 0.3 / 0.7.
    let after_delayed = odds_from_pools(4, 0b1010, &pools).unwrap();
    assert_eq!((after_delayed[0], after_delayed[2]), (0, 0));
    assert!(after_delayed[1].abs_diff(300_000_000_000_000_000) <= 10);
    assert_eq!(after_delayed[1] + after_delayed[3], WAD);
    // After both, the survivor holds everything and needs no pool.
    assert_eq!(odds_from_pools(4, 0b1000, &[]), Some(vec![0, 0, 0, WAD]));
    assert_eq!(odds_from_pools(2, 0b01, &[]), Some(vec![WAD, 0]));
    // Without the pools between live verses the odds are unknown, never a guess.
    assert_eq!(odds_from_pools(4, 0b1111, &pools[..2]), None);
    assert_eq!(odds_from_pools(4, 0b1111, &[]), None);
}

#[test]
fn odds_follow_trades() {
    // Selling 10,000 USDC-if-DELAYED·HOLDS into the SH/DH pool makes DELAYED·HOLDS cheaper, so less likely.
    let q = independent_odds(6667, 3000);
    let mut pools = odds_pools(&q);
    let before = odds_from_pools(4, 0b1111, &pools).unwrap();
    let leaf = &mut pools
        .iter_mut()
        .find(|(pair, _)| *pair == (0x4, 0x8))
        .unwrap()
        .1;
    leaf.swap_exact_in(false, 10_000 * WAD, BASE_FEE).unwrap();
    let after = odds_from_pools(4, 0b1111, &pools).unwrap();
    assert!(after[2] > before[2] && after[3] < before[3]);
    assert_eq!(after[2] + after[3], before[2] + before[3]);
    assert_eq!(after[..2], before[..2]);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// testFuzz_odds_matchSeededOdds: any configured odds read back within 10 wei per world, summing to 1e18.
    #[test]
    fn odds_match_seeded_odds(ships in 1u128..=9999, cuts in 1u128..=9999) {
        let q = independent_odds(ships, cuts);
        let read = odds_from_pools(4, 0b1111, &odds_pools(&q)).unwrap();
        prop_assert_eq!(read.iter().sum::<u128>(), WAD);
        for w in 0..4 {
            prop_assert!(read[w].abs_diff(q[w]) <= 10, "world {}: {} vs {}", w, read[w], q[w]);
        }
    }
}

#[test]
fn move_to_up_and_down_lands_on_the_target() {
    // PoolSeeder.t.sol: a 3,000 spot pool with L = 5,000e18, moved to 3,200 then 2,900. v4 lands on the target's
    // square-root price exactly; a constant-product pool lands within its reserves' integer granularity.
    let liquidity = U256::from(5_000 * WAD);
    let reserve0 =
        multiverse_math::isqrt_u256(liquidity * liquidity / U256::from(3_000u32)).low_u128();
    let mut p = VersePool::with_reserves(reserve0, reserve0 * 3_000);
    for target in [3_200 * WAD, 2_900 * WAD] {
        let (before0, before1) = p.pool.reserves();
        let plan = p.pool.plan_move_to(target, BASE_FEE).unwrap().unwrap();
        let swap = p
            .pool
            .swap_exact_in(plan.zero_for_one, plan.amount_in, BASE_FEE)
            .unwrap();
        let price = p.wnear_price();
        assert!(
            price.abs_diff(target) * 1_000_000_000_000_000 <= target,
            "{price} vs {target}"
        );
        // The payer paid one currency and received the other.
        let (after0, after1) = p.pool.reserves();
        if plan.zero_for_one {
            assert!(after0 > before0 && after1 < before1);
        } else {
            assert!(after1 > before1 && after0 < before0);
        }
        assert!(swap.amount_out > 0);
    }
    // At the target it is a no-op.
    let current = p.wnear_price();
    let again = p.pool.plan_move_to(current, BASE_FEE).unwrap();
    assert!(again.is_none_or(
        |m| m.amount_in * 1_000_000_000_000_000 <= p.pool.reserve0().max(p.pool.reserve1())
    ));
}
