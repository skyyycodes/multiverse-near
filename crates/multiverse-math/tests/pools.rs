//! The pool layer at the maths level: the dynamic fee and the TWAP, the spot pool's price moves, the odds, and the
//! demo's golden numbers at NEAR scale (a few USDC per NEAR, pools 100,000 NEAR deep), run against the
//! constant-product pool.
//!
//! Orientation: a within-world pool has wNEAR-if-w as token0 and USDC-if-w as token1, a between-world pool
//! has the lower mask as token0. The fee window measures token0 in both.

use multiverse_math::cpmm::{Pool, Position, SwapResult};
use multiverse_math::flow::SwapFlow;
use multiverse_math::twap::TwapOracle;
use multiverse_math::{odds, orders, price, risk, U256, WAD};
use proptest::prelude::*;

const BASE_FEE: u32 = 3000;
const MAX_FEE: u32 = 15000;
const LLTV: u128 = 750_000_000_000_000_000;
/// 0.001 in WAD: demo prices are a few USDC per NEAR.
const E15: u128 = 1_000_000_000_000_000;
/// 1,000 NEAR.
const K: u128 = 1_000 * WAD;

/// The demo scripts' amount format: integer part, a point, two decimals rounded down.
fn fmt(amount: u128) -> String {
    format!(
        "{}.{:02}",
        amount / WAD,
        amount % WAD / 10_000_000_000_000_000
    )
}

/// A NEAR price with five decimals, rounded down: at a few dollars, cents alone would hide the differences.
fn fmt5(price: u128) -> String {
    format!("{}.{:05}", price / WAD, price % WAD / 10_000_000_000_000)
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
    /// the demo seed opens the world pools.
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

    /// What the contract does after every swap: a TWAP point at the post-swap tick, then the flow record.
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
    let mut p = VersePool::seed(2_500 * E15, 100_000 * WAD);
    assert_eq!(p.flow_of(), (0, 0, 0));
    assert_eq!(p.fee_of(), BASE_FEE);
    let (swap, fee) = p.sell(K);
    assert_eq!(fee, BASE_FEE);
    assert_eq!(swap.fee_amount, 3 * WAD);
    // After one 1,000 wNEAR sale the window is [-1e21], entirely one-sided.
    assert_eq!(p.fee_of(), MAX_FEE);
}

#[test]
fn fee_base_with_balanced_flow() {
    let mut p = VersePool::seed(2_500 * E15, 100_000 * WAD);
    for _ in 0..4 {
        p.sell(K);
        p.buy(K);
        assert_eq!(p.fee_of(), BASE_FEE);
    }
    // net sold 0, total 8e21, 8 swaps (`flow_of` reports (net, total, swaps)).
    assert_eq!(p.flow_of(), (0, 8 * K, 8));
    assert_eq!(p.sell(K).1, BASE_FEE);
}

#[test]
fn fee_rises_under_one_sided_flow() {
    let mut p = VersePool::seed(2_500 * E15, 100_000 * WAD);
    for _ in 0..4 {
        p.buy(K);
    }
    for _ in 0..4 {
        p.sell(K);
    }
    // Each sale pushes one buy out of the window: |net| / total = 0, 2/8, 4/8, 6/8, 8/8, 8/8.
    let paid: Vec<u32> = (0..6).map(|_| p.sell(K).1).collect();
    assert_eq!(paid, [3000, 6000, 9000, 12000, 15000, 15000]);
}

#[test]
fn fee_rounds_up_in_the_pools_favour() {
    let mut p = VersePool::seed(2_500 * E15, 100_000 * WAD);
    p.sell(K + 1);
    p.buy(K);
    // net 1, total 2e21 + 1: 3000 + ceil(12000 / (2e21 + 1)) = 3001.
    assert_eq!(p.flow_of(), (1, 2 * K + 1, 2));
    assert_eq!(p.fee_of(), 3001);
}

#[test]
fn fee_is_per_pool() {
    let mut delayed_holds = VersePool::seed(2_500 * E15, 100_000 * WAD);
    let ships_cuts = VersePool::seed(3_700 * E15, 100_000 * WAD);
    for _ in 0..3 {
        delayed_holds.sell(K);
    }
    assert_eq!(delayed_holds.fee_of(), MAX_FEE);
    assert_eq!(ships_cuts.fee_of(), BASE_FEE);
}

#[test]
fn fee_volume_is_the_wnear_side_whichever_way_it_moves() {
    let mut p = VersePool::seed(3_000 * E15, 100_000 * WAD);
    p.sell(K);
    assert_eq!(p.flow_of(), (K as i128, K, 1));
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
    let mut p = VersePool::seed(2_500 * E15, 100_000 * WAD);
    for _ in 0..8 {
        p.sell(K);
    }
    for _ in 0..8 {
        // 1 unit of USDC-if-w in buys no wNEAR, so nothing is recorded (but the TWAP still gets a point).
        let (swap, _) = p.sell_token1(1);
        assert_eq!(swap.amount_out, 0);
    }
    assert_eq!(p.flow_of(), (8 * K as i128, 8 * K, 8));
    assert_eq!(p.fee_of(), MAX_FEE);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Ten sales of 1e9..2e21; the first pays the base fee, the rest the cap.
    #[test]
    fn fee_one_sided_from_empty_history(sizes in proptest::collection::vec(1_000_000_000u128..=2 * K, 10)) {
        let mut p = VersePool::seed(2_500 * E15, 100_000 * WAD);
        let mut last = 0;
        for (i, size) in sizes.into_iter().enumerate() {
            let fee = p.sell(size).1;
            prop_assert_eq!(fee, if i == 0 { BASE_FEE } else { MAX_FEE });
            prop_assert!(fee >= last);
            last = fee;
        }
    }

    /// Twenty swaps of 1e9..3e21 either way (sales exact input, purchases exact
    /// output); every fee equals an independent evaluation of the formula over the previous eight recorded swaps.
    #[test]
    fn fee_matches_the_formula(swaps in proptest::collection::vec((any::<bool>(), 1_000_000_000u128..=3 * K), 20)) {
        let mut p = VersePool::seed(2_500 * E15, 100_000 * WAD);
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
    let mut p = VersePool::seed(2_500 * E15, 100_000 * WAD);
    let seeded = p.pool.tick().unwrap();
    assert_eq!(p.oracle.mean_tick(p.now, 60), None);
    p.now += 59;
    assert_eq!(p.oracle.mean_tick(p.now, 60), None);
    p.now += 1;
    assert_eq!(p.oracle.mean_tick(p.now, 60), Some(seeded));
}

#[test]
fn mean_tick_is_time_weighted() {
    let mut p = VersePool::seed(2_500 * E15, 100_000 * WAD);
    p.now += 100;
    let tick0 = p.pool.tick().unwrap();
    p.sell(5 * K);
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
    let mut p = VersePool::seed(2_500 * E15, 100_000 * WAD);
    let seeded = p.pool.tick().unwrap();
    p.now += 30;
    p.sell(10 * K);
    let low = p.pool.tick().unwrap();
    p.buy(10 * K);
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
        (3_700, 100_000, 192_353),
        (3_000, 100_000, 173_205),
        (3_300, 100_000, 181_659),
        (2_500, 40_000, 63_245),
    ];
    for (price, depth, liquidity) in worlds {
        let p = VersePool::seed(price * E15, depth * WAD);
        assert_eq!(p.wnear_price(), price * E15);
        assert_eq!(p.pool.liquidity() / WAD, liquidity);
        // The reading through the square-root price is within 1e-6 (here: one unit low or exact).
        let via_sqrt = price::from_sqrt_price_x96(p.pool.sqrt_price_x96().unwrap()).unwrap();
        assert!(price * E15 - via_sqrt <= 1);
    }
}

#[test]
fn demo_twap_prices() {
    // With wNEAR-if-w as token0, the TWAP of a freshly seeded pool reads one tick below the seed price. The tick grid
    // sits elsewhere relative to the price than at the prototype's price scale, so 2.80 reads 2.79980 where the
    // prototype's demo numbers had one unit less in the last digit; the others carry over digit for digit.
    let expected = [
        (3_700, "3.69963"),
        (3_000, "2.99979"),
        (3_300, "3.29972"),
        (2_500, "2.49990"),
        (3_400, "3.39987"),
        (2_800, "2.79980"),
    ];
    for (seed_price, twap) in expected {
        let mut p = VersePool::seed(seed_price * E15, 100_000 * WAD);
        p.now += 61;
        let mean = p.oracle.mean_tick(p.now, 60).unwrap();
        let read = price::wnear_price_at_tick(mean, true).unwrap();
        assert_eq!(fmt5(read), twap, "seeded at {seed_price}");
    }
}

#[test]
fn golden_demo_sale() {
    // DELAYED·HOLDS is the thin pool: 40,000 wNEAR / 100,000 USDC at 2.50. Alice sells 2,000 NEAR.
    let sale = 2 * K;
    let pool_only = VersePool::seed(2_500 * E15, 40_000 * WAD)
        .pool
        .quote_exact_in(true, sale, BASE_FEE)
        .unwrap();
    assert_eq!(fmt(pool_only.amount_out), "4748.29");
    // 2.37414 USDC per NEAR on average.
    assert_eq!(fmt5(pool_only.amount_out / 2_000), "2.37414");

    // Ravi's bid fills 1,000 wNEAR at 2% under 2.50, then the pool takes the other 1,000.
    let ravi_price = 2_500 * E15 * (10_000 - 200) / 10_000;
    assert_eq!(ravi_price, 2_450 * E15);
    assert_eq!(orders::cost(K, ravi_price), 2_450 * WAD);
    let mut delayed_holds = VersePool::seed(2_500 * E15, 40_000 * WAD);
    let (rest, fee) = delayed_holds.sell(K);
    assert_eq!(fee, BASE_FEE);
    let with_bid = orders::proceeds(K, ravi_price) + rest.amount_out;
    // The prototype's demo number for world 3, to the unit.
    assert_eq!(with_bid, 4_881_885_259_897_065_638_949);
    assert!(with_bid > pool_only.amount_out);
    assert_eq!(fmt(with_bid), "4881.88");
    assert_eq!(fmt5(with_bid / 2_000), "2.44094");
    // "push from 2.38": the pool price after the sale.
    assert_eq!(fmt5(delayed_holds.wnear_price()), "2.37988");
    // The sold pool now charges the cap on its next swap.
    assert_eq!(delayed_holds.fee_of(), MAX_FEE);

    // The other sold worlds (100,000 wNEAR deep) and the binary DELAYED world, against the prototype's demo numbers.
    let sales = [
        (
            3_000,
            5_865_050_885_346_196_835_108u128,
            "5865.05",
            "2.88384",
        ),
        (3_300, 6_451_555_973_880_816_518_618, "6451.55", "3.17223"),
        (2_800, 5_474_047_492_989_783_712_767, "5474.04", "2.69158"),
    ];
    for (seed_price, proto, proceeds, price_after) in sales {
        let mut p = VersePool::seed(seed_price * E15, 100_000 * WAD);
        let (swap, _) = p.sell(sale);
        // The prototype stepped through square-root prices and landed within a few units of the closed form; here
        // within 1 unit.
        assert!(
            swap.amount_out.abs_diff(proto) <= 1,
            "{} vs {proto}",
            swap.amount_out
        );
        assert_eq!(fmt(swap.amount_out), proceeds);
        assert_eq!(fmt5(p.wnear_price()), price_after);
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
    // The lens's quote_sell(2x2, 2,000 wNEAR, L-shape) on the seed pools (all 100,000 wNEAR deep), against the
    // prototype's demo numbers [0, 5865050885346196835108, 6451555973880816518618, 4887542404455164029256].
    let proto = [
        0u128,
        5_865_050_885_346_196_835_108,
        6_451_555_973_880_816_518_618,
        4_887_542_404_455_164_029_256,
    ];
    let prices = [3_700, 3_000, 3_300, 2_500];
    let l_shape = 0b1110u8;
    for (w, seed_price) in prices.into_iter().enumerate() {
        let mut p = VersePool::seed(seed_price * E15, 100_000 * WAD);
        if l_shape & (1 << w) == 0 {
            assert_eq!(proto[w], 0);
            continue;
        }
        let quote = p.pool.quote_exact_in(true, 2 * K, p.fee_of()).unwrap();
        let (swap, _) = p.sell(2 * K);
        assert_eq!(quote, swap);
        assert!(
            swap.amount_out.abs_diff(proto[w]) <= 1,
            "world {w}: {} vs {}",
            swap.amount_out,
            proto[w]
        );
    }
}

/// Configured odds of the 2x2 scenario from basis points: world = a + 2b, a = SPICE, b = Fed.
fn independent_odds(ships_bps: u128, cuts_bps: u128) -> [u128; 4] {
    let e10 = 10_000_000_000;
    [
        ships_bps * cuts_bps * e10,
        (10_000 - ships_bps) * cuts_bps * e10,
        ships_bps * (10_000 - cuts_bps) * e10,
        (10_000 - ships_bps) * (10_000 - cuts_bps) * e10,
    ]
}

/// Between-world pools seeded at the configured odds (as the demo seed does, 1,000,000 deep), keyed by pair.
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
    // Implied spot at the demo prices: 3.163359 (within 1e-10).
    let prices = [3_700 * E15, 3_000 * E15, 3_300 * E15, 2_500 * E15];
    let implied = odds::implied_spot(&read, 0b1111, |w| Some(prices[usize::from(w)])).unwrap();
    let reference = 3_163_359_000_000_000_000u128;
    assert!(
        implied.abs_diff(reference) * 10_000_000_000 <= reference,
        "{implied}"
    );
    // The demo seed prices the spot pool from the configured odds instead, which is exact.
    assert_eq!(
        odds::implied_spot(&q, 0b1111, |w| Some(prices[usize::from(w)])),
        Some(reference)
    );
}

#[test]
fn seeded_implied_spot_from_polymarket_odds() {
    // The seed table with SHIPS at 6667 bps: the Fed odds at 100, 104 and 119 bps.
    let prices = [3_700 * E15, 3_000 * E15, 3_300 * E15, 2_500 * E15];
    let cases = [
        (100, 3_037_693_300_000_000_000u128),
        (104, 3_037_866_632_000_000_000),
        (119, 3_038_516_627_000_000_000),
    ];
    for (cuts_bps, implied) in cases {
        let q = independent_odds(6667, cuts_bps);
        assert_eq!(q.iter().sum::<u128>(), WAD);
        assert_eq!(
            odds::implied_spot(&q, 0b1111, |w| Some(prices[usize::from(w)])),
            Some(implied)
        );
    }
    // Binary scenario at 6667 bps and 3.40 / 2.80: 3.20002.
    let q = [6667 * 100_000_000_000_000, 3333 * 100_000_000_000_000];
    let implied = odds::implied_spot(&q, 0b11, |w| {
        Some([3_400 * E15, 2_800 * E15][usize::from(w)])
    })
    .unwrap();
    assert_eq!(fmt5(implied), "3.20002");
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

    /// Any configured odds read back within 10 units per world, summing to 1e18.
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

/// Odds of three independent events from basis points (world = a + 2b + 4c), split down the 8-world tree as the
/// contract reads it: each level `floor(parent · share)` and `parent − that`, so they sum to exactly 1e18.
fn independent_odds_8(a_bps: u128, b_bps: u128, c_bps: u128) -> Vec<u128> {
    let pairs = odds::pairs(8);
    odds::odds(8, 0xFF, |x, y| {
        let level = pairs.iter().position(|p| *p == (x, y)).unwrap();
        let bps = match level {
            0 => c_bps,
            1 | 2 => b_bps,
            _ => a_bps,
        };
        Some(bps * 100_000_000_000_000)
    })
    .unwrap()
}

/// The 8-world prices of the worked example: the demo's 2x2 under YES, 0.95 of it under NO.
const PRICES_8: [u128; 8] = [
    3_700 * E15,
    3_000 * E15,
    3_300 * E15,
    2_500 * E15,
    3_515 * E15,
    2_850 * E15,
    3_135 * E15,
    2_375 * E15,
];

/// The worked example (SHIPS 0.6667, CUTS 0.01, YES 0.5) read back from 7 seeded odds pools.
#[test]
fn odds_8_match_configured_odds() {
    let q = independent_odds_8(6667, 100, 5000);
    assert_eq!(
        q[..4],
        [
            3_333_500_000_000_000,
            1_666_500_000_000_000,
            330_016_500_000_000_000,
            164_983_500_000_000_000
        ]
    );
    assert_eq!(q[..4], q[4..]);
    let pools = odds_pools(&q);
    assert_eq!(pools.len(), 7);
    let read = odds_from_pools(8, 0xFF, &pools).unwrap();
    assert_eq!(read.iter().sum::<u128>(), WAD);
    for w in 0..8 {
        assert!(
            read[w].abs_diff(q[w]) <= 10,
            "world {w}: {} vs {}",
            read[w],
            q[w]
        );
    }
    // implied spot 2.96175097 (within 1e-9), inside [min p, max p]
    let implied = odds::implied_spot(&read, 0xFF, |w| Some(PRICES_8[usize::from(w)])).unwrap();
    let reference = 2_961_750_967_500_000_000u128;
    assert!(
        implied.abs_diff(reference) * 1_000_000_000 <= reference,
        "{implied}"
    );
    assert!((2_375 * E15..=3_700 * E15).contains(&implied));
}

/// Whichever event resolves first, and then the others in any order, the same 7 pools price the survivors at
/// their conditional odds (within pool rounding), and a lone survivor needs no pool.
#[test]
fn odds_8_renormalize_in_every_resolution_order() {
    let q = independent_odds_8(6667, 3000, 4000);
    let pools = odds_pools(&q);
    let orders: [[usize; 3]; 6] = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];
    for order in orders {
        for outcomes in 0u8..8 {
            let mut possible = 0xFFu8;
            for (step, k) in order.iter().enumerate() {
                let outcome = (outcomes >> k) & 1;
                possible &= (0..8u8)
                    .filter(|w| (w >> k) & 1 == outcome)
                    .fold(0, |m, w| m | 1 << w);
                let read = odds_from_pools(8, possible, &pools).unwrap();
                assert_eq!(
                    read.iter().sum::<u128>(),
                    WAD,
                    "{order:?} {outcomes} step {step}"
                );
                let left: u128 = (0..8)
                    .filter(|w| possible & (1 << w) != 0)
                    .map(|w| q[w])
                    .sum();
                for w in 0..8 {
                    if possible & (1 << w) == 0 {
                        assert_eq!(read[w], 0);
                    } else {
                        // q_w / P(survivors), within the pools' rounding
                        let expected = q[w] * WAD / left;
                        assert!(
                            read[w].abs_diff(expected) <= 100,
                            "{order:?} {outcomes} w{w}: {} vs {expected}",
                            read[w]
                        );
                    }
                }
            }
            assert_eq!(possible.count_ones(), 1);
            assert_eq!(
                odds_from_pools(8, possible, &[]).unwrap()[possible.trailing_zeros() as usize],
                WAD
            );
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Any configured 3-event odds read back from the 8-world tree within 10 units per world, summing to 1e18.
    #[test]
    fn odds_8_match_seeded_odds(a in 1u128..=9999, b in 1u128..=9999, c in 1u128..=9999) {
        let q = independent_odds_8(a, b, c);
        prop_assert_eq!(q.iter().sum::<u128>(), WAD);
        let read = odds_from_pools(8, 0xFF, &odds_pools(&q)).unwrap();
        prop_assert_eq!(read.iter().sum::<u128>(), WAD);
        for w in 0..8 {
            prop_assert!(read[w].abs_diff(q[w]) <= 10, "world {}: {} vs {}", w, read[w], q[w]);
        }
    }
}

#[test]
fn move_to_up_and_down_lands_on_the_target() {
    // The spot pool at 3.00 with L = 5,000,000e18, moved to 3.20 then 2.90. A constant-product pool lands within its
    // reserves' integer granularity.
    let liquidity = U256::from(5_000_000 * WAD);
    let reserve0 = multiverse_math::isqrt_u256(liquidity * liquidity / U256::from(3u32)).low_u128();
    let mut p = VersePool::with_reserves(reserve0, reserve0 * 3);
    for target in [3_200 * E15, 2_900 * E15] {
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
