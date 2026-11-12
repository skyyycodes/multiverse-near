//! The lens over the pools (odds, implied spot, quotes) and the demo's golden
//! numbers from the seed and sale scripts. The prototype's pools were seeded
//! through sqrt prices with stepwise rounding; these pools hold the exact
//! reserve ratio, so the printed numbers (two decimals, rounded down) match
//! the prototype's demo numbers and the raw values agree to a few units.

use multiverse_math::fixed::WAD;
use multiverse_math::price;
use near_sdk::json_types::U128;

use super::amm::*;
use super::harness::*;
use crate::amm::views::SellPart;
use crate::amm::PoolKind;
use crate::types::Asset::Usdc;

/// The prototype's demo numbers, raw (wNEAR-if-w as token0).
const PROTO_W1_SALE: u128 = 5_865_050_885_346_196_835_108;
const PROTO_W2_SALE: u128 = 6_451_555_973_880_816_518_618;
const PROTO_W3_RAVI_THEN_POOL: u128 = 4_881_885_259_897_065_638_949;
/// Ravi's bid: 1,000 NEAR at 2.45 USDC per NEAR.
const RAVI_PRICE: u128 = 2_450 * E15;
const RAVI_SIZE: u128 = 1_000 * E18;
/// Alice's sale: 2,000 NEAR.
const SALE: u128 = 2_000 * E18;

fn odds_view(w: &mut World, sid: u64) -> (Vec<u128>, bool) {
    let v = w.view(|c| c.odds(sid));
    (v.q.iter().map(|q| q.0).collect(), v.known)
}

fn implied(w: &mut World, sid: u64) -> u128 {
    w.view(|c| c.implied_spot(sid)).0
}

/// `sum of floor(q_w * price_w)` over possible worlds.
fn weighted(q: &[u128], prices: &[u128], possible: u8) -> u128 {
    q.iter()
        .zip(prices)
        .enumerate()
        .filter(|(i, _)| possible & (1 << i) != 0)
        .map(|(_, (q, p))| wmul(*q, *p))
        .sum()
}

/// The odds check: known, each world within 10 units, dead worlds
/// 0, the router-facing read agrees, and the sum is exactly 1e18.
fn assert_odds(w: &mut World, sid: u64, expected: &[u128]) {
    let (q, known) = odds_view(w, sid);
    assert!(known);
    let possible = w.possible(sid);
    for (i, (got, want)) in q.iter().zip(expected).enumerate() {
        if possible & (1 << i) == 0 {
            assert_eq!(*got, 0, "dead world {i}");
        } else {
            assert!(got.abs_diff(*want) <= 10, "world {i}: {got} vs {want}");
        }
    }
    assert_eq!(q.iter().sum::<u128>(), WAD);
    assert_eq!(w.view(|c| c.odds_of(sid)), (q, true));
}

fn world_prices(w: &mut World, pools: &[u64]) -> Vec<u128> {
    pools.iter().map(|id| price_of(w, *id)).collect()
}

/// The implied spot from the pools' own odds and prices, and the
/// router-facing read agrees with the view.
fn assert_implied(w: &mut World, sid: u64, pools: &[u64]) -> u128 {
    let (q, _) = odds_view(w, sid);
    let prices = world_prices(w, pools);
    let possible = w.possible(sid);
    let got = implied(w, sid);
    assert_eq!(got, weighted(&q, &prices, possible));
    assert_eq!(w.view(|c| c.implied_spot_of(sid)), got);
    got
}

// Golden numbers

#[test]
fn golden_sale_in_the_thin_pool() {
    let mut w = pool_world();
    seed_demo_thin(&mut w);
    let s = w.s2x2;
    let pool_only = w.view(|c| c.quote_sell(s, U128(SALE), DELAYED_HOLDS))[3].0;
    assert_eq!(cents(pool_only), 474829);
    // 2.37414 USDC per NEAR on average
    assert_eq!(price_5dp(pool_only / 2_000), 237414);
    // Ravi's 1,000 NEAR at 2.45, then 1,000 NEAR into the pool
    let slice = w.view(|c| c.quote_sell(s, U128(RAVI_SIZE), DELAYED_HOLDS))[3].0;
    assert_eq!(cents(slice), 243188);
    let with_bid = wmul(RAVI_SIZE, RAVI_PRICE) + slice;
    assert_eq!(cents(with_bid), 488188);
    assert_eq!(price_5dp(with_bid / 2_000), 244094);
    assert!(with_bid.abs_diff(PROTO_W3_RAVI_THEN_POOL) <= 1_000_000);
    // even the pool's first NEAR averages under the bid
    assert!(slice / 1_000 < RAVI_PRICE && pool_only / 2_000 < RAVI_PRICE);
}

#[test]
fn golden_l_shape_sale_and_the_prices_after_it() {
    let mut w = pool_world();
    let pools = seed_demo_thin(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, 10_000 * E18, 0);
    let quotes: Vec<u128> = w
        .view(|c| c.quote_sell(s, U128(SALE), L_SHAPE))
        .iter()
        .map(|q| q.0)
        .collect();
    assert_eq!(quotes[0], 0);
    assert!(quotes[1].abs_diff(PROTO_W1_SALE) <= 1_000_000);
    assert!(quotes[2].abs_diff(PROTO_W2_SALE) <= 1_000_000);
    assert_eq!((cents(quotes[1]), cents(quotes[2])), (586505, 645155));
    // worlds 1 and 2 sell 2,000 NEAR; world 3 sells the 1,000 NEAR Ravi's bid leaves
    assert_eq!(sell(&mut w, ALICE, pools[1], SALE).0, quotes[1]);
    assert_eq!(sell(&mut w, ALICE, pools[2], SALE).0, quotes[2]);
    sell(&mut w, ALICE, pools[3], SALE - RAVI_SIZE);
    let after: Vec<u128> = world_prices(&mut w, &pools)
        .into_iter()
        .map(price_5dp)
        .collect();
    assert_eq!(after, [370000, 288384, 317223, 237988]);
    let fees: Vec<u32> = pools.iter().map(|id| fee_of(&mut w, *id)).collect();
    assert_eq!(fees, [3000, 15000, 15000, 15000]);
}

#[test]
fn golden_twap_prices_after_a_full_window() {
    let mut w = pool_world();
    seed_demo_thin(&mut w);
    let sb = w.s_bin;
    seed_worlds(&mut w, sb, &DEMO_BIN, &[DEPTH; 2]);
    w.warp(61);
    let s = w.s2x2;
    let twap: Vec<u128> = (0..4)
        .map(|i| price_5dp(w.view(|c| c.world_price(s, i)).0))
        .collect();
    // 3.69963, 2.99979, 3.29972 and 2.49990: a floored mean tick prices the
    // world up to one tick (0.01%) under its pool
    assert_eq!(twap, [369963, 299979, 329972, 249990]);
    let bin: Vec<u128> = (0..2)
        .map(|i| price_5dp(w.view(|c| c.world_price(sb, i)).0))
        .collect();
    // 2.79980 for DELAYED: the tick grid sits elsewhere relative to the price
    // than at the prototype's price scale, and this one floors a hair higher
    // (the prototype's demo numbers had one unit less in the last digit)
    assert_eq!(bin, [339987, 279980]);
}

#[test]
fn golden_implied_spot_at_104_and_119_bps() {
    for (cuts, configured) in [
        (104, 3_037_866_632 * 1_000_000_000),
        (119, 3_038_516_627 * 1_000_000_000),
    ] {
        let mut w = pool_world();
        let pools = seed_demo_thin(&mut w);
        let s = w.s2x2;
        let q = independent_odds(4, 6667, cuts);
        assert_eq!(weighted(&q, &DEMO_2X2, ROOT), configured);
        seed_odds(&mut w, s, &q, ODDS_DEPTH);
        assert_odds(&mut w, s, &q);
        // the leaf pools hold 499,925 against 1,000,000
        let kind = PoolKind::Between {
            mask0: SHIPS_CUTS,
            mask1: DELAYED_CUTS,
        };
        let leaf = w.view(|c| c.get_pool(c.pool_of_kind(s, kind).unwrap()).unwrap());
        assert_eq!(
            (cents(leaf.reserve0.0), leaf.reserve1.0),
            (49992500, ODDS_DEPTH)
        );
        let got = assert_implied(&mut w, s, &pools);
        assert!(within_rel(got, configured, 10_000_000_000));
        assert_eq!(price_5dp(got), price_5dp(configured));
        // the demo seed seeds the spot pool at the configured implied spot
        seed_spot(&mut w, configured, DEPTH);
        assert_eq!(w.view(|c| c.spot_price()).0, configured);
        assert_eq!(w.view(|c| c.spot_price_wad()), configured);
    }
}

#[test]
fn golden_binary_implied_spot() {
    let mut w = pool_world();
    let sb = w.s_bin;
    let pools = seed_worlds(&mut w, sb, &DEMO_BIN, &[DEPTH; 2]);
    let q = independent_odds(2, 6667, 0);
    seed_odds(&mut w, sb, &q, ODDS_DEPTH);
    assert_odds(&mut w, sb, &q);
    let got = assert_implied(&mut w, sb, &pools);
    assert_eq!(price_5dp(got), 320002);
    assert!(within_rel(got, 3_200_020 * E15 / 1000, 10_000_000_000));
}

// The lens

#[test]
fn scenario_pools_before_and_after_a_sale() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    assert_eq!(w.view(|c| c.spot_price()).0, 0);
    for (i, id) in pools.iter().enumerate() {
        let p = w.view(|c| c.get_pool(*id).unwrap());
        assert!(within_rel(p.price.0, DEMO_2X2[i], 1_000_000));
        assert!(p.liquidity.0 > 0);
    }
    give_world_tokens(&mut w, ALICE, s, SALE, 0);
    for id in &pools[1..] {
        sell(&mut w, ALICE, *id, SALE);
    }
    for (i, id) in pools.iter().enumerate().skip(1) {
        assert!(price_of(&mut w, *id) < DEMO_2X2[i]);
    }
    assert_eq!(price_of(&mut w, pools[0]), DEMO_2X2[0]);
    w.assert_conservation(&[OWNER, ALICE, BOB, CAROL]);
}

#[test]
fn quote_sell_matches_execution() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, SALE, 0);
    // a fee window that is not at base, so the quote must use the live fee
    sell(&mut w, ALICE, pools[2], 500 * E18);
    let quotes = w.view(|c| c.quote_sell(s, U128(1_000 * E18), L_SHAPE));
    assert_eq!(quotes[0].0, 0);
    for i in 1..4 {
        let (out, _) = sell(&mut w, ALICE, pools[i], 1_000 * E18);
        assert_eq!(out, quotes[i].0, "world {i}");
    }
    // the router-facing quote is the same number
    let next = w
        .view(|c| c.quote_exact_in(pools[1], true, 250 * E18))
        .unwrap();
    assert_eq!(sell(&mut w, ALICE, pools[1], 250 * E18).0, next);
}

#[test]
fn quote_sell_parts_and_bounds() {
    let mut w = pool_world();
    seed_demo_2x2(&mut w);
    let (s, sb) = (w.s2x2, w.s_bin);
    let one = w.view(|c| c.quote_sell(s, U128(1_000 * E18), 0xF));
    let two = w.view(|c| c.quote_sell(s, U128(SALE), 0xF));
    let parts = vec![
        SellPart {
            world: 3,
            wnear_amount: U128(1_000 * E18),
        },
        SellPart {
            world: 3,
            wnear_amount: U128(SALE),
        },
        SellPart {
            world: 0,
            wnear_amount: U128(1_000 * E18),
        },
        SellPart {
            world: 7,
            wnear_amount: U128(E18),
        },
        SellPart {
            world: 1,
            wnear_amount: U128(0),
        },
    ];
    let got = w.view(|c| c.quote_sell_parts(s, parts));
    assert_eq!(got, [one[3], two[3], one[0], U128(0), U128(0)]);
    // bits above the world count are ignored; no pools, no quotes
    assert_eq!(w.view(|c| c.quote_sell(sb, U128(E18), 0xFF)), [U128(0); 2]);
    assert!(w.try_view(|c| c.quote_sell(9, U128(E18), 1)).is_err());
}

#[test]
fn odds_unknown_without_between_world_pools() {
    let mut w = pool_world();
    seed_demo_2x2(&mut w);
    let s = w.s2x2;
    assert_eq!(odds_view(&mut w, s), (vec![0; 4], false));
    assert_eq!(implied(&mut w, s), 0);
    assert_eq!(w.view(|c| c.odds_of(s)), (vec![0; 4], false));
}

#[test]
fn odds_unknown_while_a_pool_is_missing() {
    let mut w = pool_world();
    seed_demo_2x2(&mut w);
    let s = w.s2x2;
    let q = independent_odds(4, 6667, 3000);
    seed_odds_pool(
        &mut w,
        s,
        CUTS,
        HOLDS,
        sum_over(&q, CUTS),
        sum_over(&q, HOLDS),
        ODDS_DEPTH,
    );
    seed_odds_pool(&mut w, s, SHIPS_CUTS, DELAYED_CUTS, q[0], q[1], ODDS_DEPTH);
    let (got, known) = odds_view(&mut w, s);
    assert!(!known);
    assert_eq!(got[0], 0);
    assert_eq!(implied(&mut w, s), 0);
    seed_odds_pool(
        &mut w,
        s,
        SHIPS_HOLDS,
        DELAYED_HOLDS,
        q[2],
        q[3],
        ODDS_DEPTH,
    );
    assert_odds(&mut w, s, &q);
}

#[test]
fn odds_2x2_match_configured_odds() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    let q = independent_odds(4, 6667, 3000);
    seed_odds(&mut w, s, &q, ODDS_DEPTH);
    assert_odds(&mut w, s, &q);
    let got = assert_implied(&mut w, s, &pools);
    assert!(within_rel(
        got,
        weighted(&q, &DEMO_2X2, ROOT),
        10_000_000_000
    ));
    assert!(within_rel(got, 3_163_359 * E15 / 1000, 10_000_000_000));
}

#[test]
fn odds_binary_match_configured_odds() {
    let mut w = pool_world();
    let sb = w.s_bin;
    seed_worlds(&mut w, sb, &DEMO_BIN, &[DEPTH; 2]);
    let q = independent_odds(2, 6667, 0);
    seed_odds(&mut w, sb, &q, ODDS_DEPTH);
    assert_odds(&mut w, sb, &q);
    assert!(within_rel(
        implied(&mut w, sb),
        320002 * E15 / 100,
        10_000_000_000
    ));
}

#[test]
fn implied_spot_matches_actual_spot_after_seeding() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    let q = independent_odds(4, 6667, 3000);
    let configured = weighted(&q, &DEMO_2X2, ROOT);
    assert_eq!(configured, 3_163_359 * E15 / 1000);
    seed_odds(&mut w, s, &q, ODDS_DEPTH);
    let spot_id = seed_spot(&mut w, configured, DEPTH);
    let got = assert_implied(&mut w, s, &pools);
    let spot = w.view(|c| c.spot_price()).0;
    assert!(within_rel(got, spot, 10_000));
    let spot_tick = tick_of(&mut w, spot_id);
    let implied_tick = price::tick_from_reserves(WAD, got).unwrap();
    assert!((spot_tick - implied_tick).abs() <= 1);
}

#[test]
fn odds_renormalize_after_holds() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let (s, fed) = (w.s2x2, w.fed);
    seed_odds(&mut w, s, &independent_odds(4, 6667, 3000), ODDS_DEPTH);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    assert_odds(&mut w, s, &[0, 0, 6667 * E18 / 10_000, 3333 * E18 / 10_000]);
    let got = assert_implied(&mut w, s, &pools);
    assert!(within_rel(
        got,
        (6667 * 3300 + 3333 * 2500) * E15 / 10_000,
        10_000_000_000
    ));
}

#[test]
fn odds_renormalize_after_delayed() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let (s, spice) = (w.s2x2, w.spice);
    seed_odds(&mut w, s, &independent_odds(4, 6667, 3000), ODDS_DEPTH);
    w.admin_resolve(spice, OUT_DELAYED).unwrap();
    assert_odds(&mut w, s, &[0, 3 * E18 / 10, 0, 7 * E18 / 10]);
    let got = assert_implied(&mut w, s, &pools);
    assert!(within_rel(
        got,
        (3 * 3000 + 7 * 2500) * E15 / 10,
        10_000_000_000
    ));
}

#[test]
fn odds_after_both_resolutions() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let (s, spice, fed) = (w.s2x2, w.spice, w.fed);
    seed_odds(&mut w, s, &independent_odds(4, 6667, 3000), ODDS_DEPTH);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    w.admin_resolve(spice, OUT_DELAYED).unwrap();
    assert_eq!(odds_view(&mut w, s), (vec![0, 0, 0, WAD], true));
    assert_eq!(implied(&mut w, s), price_of(&mut w, pools[3]));
}

#[test]
fn odds_after_resolution_need_only_live_pools() {
    let mut w = pool_world();
    seed_demo_2x2(&mut w);
    let (s, sb, spice, fed) = (w.s2x2, w.s_bin, w.spice, w.fed);
    seed_odds_pool(
        &mut w,
        s,
        SHIPS_HOLDS,
        DELAYED_HOLDS,
        6667,
        3333,
        ODDS_DEPTH,
    );
    assert!(!odds_view(&mut w, s).1);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    assert_odds(&mut w, s, &[0, 0, 6667 * E18 / 10_000, 3333 * E18 / 10_000]);
    // the binary scenario has no pool at all
    assert!(!odds_view(&mut w, sb).1);
    w.admin_resolve(spice, OUT_SHIPS).unwrap();
    assert_eq!(odds_view(&mut w, sb), (vec![WAD, 0], true));
    // no world pools: the implied spot is unknown even with known odds
    assert_eq!(implied(&mut w, sb), 0);
}

#[test]
fn odds_follow_trades() {
    let mut w = pool_world();
    seed_demo_2x2(&mut w);
    let s = w.s2x2;
    let pools = seed_odds(&mut w, s, &independent_odds(4, 6667, 3000), ODDS_DEPTH);
    w.split_ft(ALICE, s, Usdc, &singles(4), 10_000 * E18)
        .unwrap();
    let (before, _) = odds_view(&mut w, s);
    // buy USDC-if-SHIPS·HOLDS (token0) with 10,000 USDC-if-DELAYED·HOLDS
    swap(&mut w, ALICE, pools[2], false, 10_000 * E18).unwrap();
    let (after, known) = odds_view(&mut w, s);
    assert!(known);
    assert!(after[2] > before[2]);
    assert!(after[3] < before[3]);
    assert_eq!(after[2] + after[3], before[2] + before[3]);
    assert_eq!(&after[..2], &before[..2]);
}

#[test]
fn odds_match_seeded_odds_for_any_independent_odds() {
    let mut seed = 2026;
    for _ in 0..12 {
        seed = next_seed(seed);
        let ships = 1 + u128::from(seed) % 9999;
        seed = next_seed(seed);
        let cuts = 1 + u128::from(seed) % 9999;
        let mut w = pool_world();
        let s = w.s2x2;
        let q = independent_odds(4, ships, cuts);
        seed_odds(&mut w, s, &q, ODDS_DEPTH);
        assert_odds(&mut w, s, &q);
    }
}
