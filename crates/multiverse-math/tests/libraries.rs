//! Port of the EVM suite's `test/Libraries.t.sol` (TwapOracleTest and PriceMathTest): same inputs, same assertions.
//! The fuzz tests run as proptests with Foundry's 512 cases.

use multiverse_math::price::{
    from_sqrt_price_x96, from_tick, pool_price, to_sqrt_price_x96, weth_price,
};
use multiverse_math::tick::get_tick_at_sqrt_ratio;
use multiverse_math::twap::TwapOracle;
use multiverse_math::{U256, WAD};
use proptest::collection::vec;
use proptest::prelude::*;

#[test]
fn twap_single_observation() {
    let oracle = TwapOracle::new(1000, -42);
    assert_eq!(oracle.mean_tick(1059, 60), None);
    assert_eq!(oracle.mean_tick(1060, 60), Some(-42));
}

#[test]
#[should_panic(expected = "AlreadyInitialized")]
fn twap_single_observation_cannot_be_initialized_again() {
    let mut oracle = TwapOracle::new(1000, -42);
    oracle.initialize(2000, 1);
}

#[test]
fn twap_piecewise_mean_rounds_down() {
    let mut oracle = TwapOracle::new(0, 100); // 100 for 10 s
    oracle.write(10, -51); // then -51 for 20 s
                           // (100 * 10 - 51 * 20) / 30 = -20 / 30, rounded toward negative infinity.
    assert_eq!(oracle.mean_tick(30, 30), Some(-1));
}

#[test]
fn twap_same_timestamp_keeps_last_tick() {
    let mut oracle = TwapOracle::new(0, 10);
    oracle.write(5, 20);
    oracle.write(5, 30); // same second: only the tick that survives counts
    assert_eq!(oracle.cumulative_at(15), Some(10 * 5 + 30 * 10));
    assert_eq!(oracle.count(), 2);
}

#[test]
fn twap_ring_buffer_drops_oldest() {
    let mut oracle = TwapOracle::new(0, 1);
    for t in 1..=200u64 {
        oracle.write(t, t as i32);
    }
    assert_eq!(oracle.count(), 128);
    // The oldest kept observation is at t = 200 - 127 = 73.
    assert_eq!(oracle.cumulative_at(72), None);
    assert!(oracle.cumulative_at(73).is_some());
}

#[test]
fn price_one_is_q96() {
    assert_eq!(
        to_sqrt_price_x96(WAD),
        U256::from_dec_str("79228162514264337593543950336").unwrap()
    );
    assert_eq!(
        from_sqrt_price_x96(U256::from_dec_str("79228162514264337593543950336").unwrap()),
        Some(WAD)
    );
}

#[test]
fn price_from_tick() {
    assert_eq!(from_tick(0), Some(WAD));
    let tick = get_tick_at_sqrt_ratio(to_sqrt_price_x96(2_500 * WAD));
    let price = from_tick(tick).unwrap();
    // assertApproxEqRel(..., 1e14): within 1e-4 relative.
    assert!(
        price.abs_diff(2_500 * WAD) <= 2_500 * WAD / 10_000,
        "{price}"
    );
}

/// `assertApproxEqRel(a, b, max)`: `|a - b| <= b * max / 1e18`.
fn approx_eq_rel(a: u128, b: u128, max_delta: u128) -> bool {
    U256::from(a.abs_diff(b)) * U256::from(WAD) <= U256::from(b) * U256::from(max_delta)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// testFuzz_cumulativeMatchesBruteForce: 40 observations from t = 1.7e9, gaps of 1..50 s, the first tick in
    /// [-1000, 1000] and the rest in [-200000, 200000]; a target in [t0, t_last + 100]. The binary search agrees with
    /// a replay of the whole history.
    #[test]
    fn twap_cumulative_matches_brute_force(
        first_tick in -1000i32..=1000,
        gaps in vec(1u64..=50, 39),
        ticks in vec(-200_000i32..=200_000, 39),
        target_seed: u64,
    ) {
        let t0 = 1_700_000_000u64;
        let mut times = vec![t0];
        let mut all_ticks = vec![first_tick];
        let mut oracle = TwapOracle::new(t0, first_tick);
        for (gap, tick) in gaps.iter().zip(&ticks) {
            let t = times.last().unwrap() + gap;
            oracle.write(t, *tick);
            times.push(t);
            all_ticks.push(*tick);
        }
        let last = *times.last().unwrap();
        let target = t0 + target_seed % (last + 101 - t0);
        let mut expected: i64 = 0;
        for i in 0..times.len() {
            let end = times.get(i + 1).copied().unwrap_or(u64::MAX);
            if target <= times[i] {
                break;
            }
            let up_to = target.min(end);
            expected += i64::from(all_ticks[i]) * (up_to - times[i]) as i64;
        }
        prop_assert_eq!(oracle.cumulative_at(target), Some(expected));
    }

    /// testFuzz_roundTrip: price -> sqrt -> price comes back within 1e-9 relative and never above (both floor).
    #[test]
    fn price_round_trip(price in 1_000_000_000_000u128..=100_000_000_000_000_000_000_000_000) {
        let back = from_sqrt_price_x96(to_sqrt_price_x96(price)).unwrap();
        prop_assert!(approx_eq_rel(back, price, 1_000_000_000), "{} vs {}", back, price);
        prop_assert!(back <= price);
    }

    /// testFuzz_orientation: WETH as token0 is the identity; as token1 the double inversion stays within 1e-12.
    #[test]
    fn price_orientation(price in 1_000_000_000_000_000u128..=1_000_000_000_000_000_000_000_000) {
        prop_assert_eq!(weth_price(pool_price(price, true), true), price);
        let back = weth_price(pool_price(price, false), false);
        prop_assert!(approx_eq_rel(back, price, 1_000_000), "{} vs {}", back, price);
    }
}
