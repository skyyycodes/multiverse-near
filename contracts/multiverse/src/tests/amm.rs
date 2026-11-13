//! The pool layer: admission, halts, dead worlds, the dynamic fee, the TWAP
//! and moving the spot pool, plus liquidity positions, the spot pool and its
//! `ft_on_transfer` action, lending's world price and the Impact Meter ring.
//! Every pool here has wNEAR-if-w as token0, so the orientation branches of
//! the reference maths collapse to that case.

use multiverse_math::fixed::{mul_div_down, WAD};
use multiverse_math::{odds, price};
use near_sdk::json_types::U128;
use near_sdk::NearToken;

use super::harness::*;
use crate::amm::IMPACT_POINTS;
use crate::types::Asset::{self, Usdc, Wnear};
use crate::types::VerseKey;

/// The demo's world prices, USDC per NEAR: 3.70, 3.00, 3.30 and 2.50.
pub const DEMO_2X2: [u128; 4] = [3_700 * E15, 3_000 * E15, 3_300 * E15, 2_500 * E15];
/// The binary demo's world prices: 3.40 and 2.80.
pub const DEMO_BIN: [u128; 2] = [3_400 * E15, 2_800 * E15];
/// Each demo world pool is 100,000 NEAR deep.
pub const DEPTH: u128 = 100_000 * E18;
/// DELAYED·HOLDS, the thin demo pool, is 40,000 NEAR deep.
pub const THIN_DEPTH: u128 = 40_000 * E18;
pub const ODDS_DEPTH: u128 = 1_000_000 * E18;
pub const POOL_FEE: NearToken = NearToken::from_near(1);

/// The base fixture with the owner and Carol funded too.
pub fn pool_world() -> World {
    let mut w = World::new();
    w.fund(OWNER);
    w.fund(CAROL);
    w
}

pub fn singles(world_count: usize) -> Vec<u8> {
    (0..world_count).map(|i| 1u8 << i).collect()
}

/// `a * b / 1e18`, rounded down.
pub fn wmul(a: u128, b: u128) -> u128 {
    mul_div_down(a, b, WAD)
}

/// Rounds up to whole USDC token units, so a root split can pay it.
fn whole_usdc(internal: u128) -> u128 {
    internal.div_ceil(scale(Usdc)) * scale(Usdc)
}

/// Seeds the worlds: the owner splits enough wNEAR and USDC into every
/// world, then opens each world's pool at `prices[w]` with `depths[w]` wNEAR.
pub fn seed_worlds(w: &mut World, sid: u64, prices: &[u128], depths: &[u128]) -> Vec<u64> {
    let max_wnear = *depths.iter().max().unwrap();
    let max_usdc = prices
        .iter()
        .zip(depths)
        .map(|(p, d)| wmul(*d, *p))
        .max()
        .unwrap();
    let masks = singles(prices.len());
    w.split_ft(OWNER, sid, Wnear, &masks, max_wnear).unwrap();
    w.split_ft(OWNER, sid, Usdc, &masks, whole_usdc(max_usdc))
        .unwrap();
    (0..prices.len())
        .map(|i| seed_world(w, sid, i as u8, prices[i], depths[i]))
        .collect()
}

/// Opens one world pool from tokens the owner already holds.
pub fn seed_world(w: &mut World, sid: u64, world: u8, price: u128, depth: u128) -> u64 {
    let usdc = wmul(depth, price);
    w.call(OWNER, POOL_FEE, |c| {
        c.create_within_pool(sid, world, U128(depth), U128(usdc))
    })
    .unwrap()
}

pub fn seed_demo_2x2(w: &mut World) -> Vec<u64> {
    let sid = w.s2x2;
    seed_worlds(w, sid, &DEMO_2X2, &[DEPTH; 4])
}

/// The demo's 2x2 pools: DELAYED·HOLDS is the thin one, 40,000 NEAR deep.
pub fn seed_demo_thin(w: &mut World) -> Vec<u64> {
    let sid = w.s2x2;
    seed_worlds(w, sid, &DEMO_2X2, &[DEPTH, DEPTH, DEPTH, THIN_DEPTH])
}

/// Sum of `q` over the worlds of `mask`.
pub fn sum_over(q: &[u128], mask: u8) -> u128 {
    q.iter()
        .enumerate()
        .filter(|(i, _)| mask & (1 << i) != 0)
        .map(|(_, v)| v)
        .sum()
}

/// Odds of independent events from basis points, as the demo seed builds them.
pub fn independent_odds(world_count: usize, ships_bps: u128, cuts_bps: u128) -> Vec<u128> {
    let (s, c) = (ships_bps, cuts_bps);
    if world_count == 2 {
        return vec![s * 100_000_000_000_000, (10_000 - s) * 100_000_000_000_000];
    }
    let k = 10_000_000_000;
    vec![
        s * c * k,
        (10_000 - s) * c * k,
        s * (10_000 - c) * k,
        (10_000 - s) * (10_000 - c) * k,
    ]
}

/// One between-world pool of USDC-if-x and USDC-if-y priced `qx : qy`, the
/// less likely side `depth` deep.
pub fn seed_odds_pool(
    w: &mut World,
    sid: u64,
    x: u8,
    y: u8,
    qx: u128,
    qy: u128,
    depth: u128,
) -> u64 {
    let root = w.view(|c| c.scenario(sid).root());
    let mut to = vec![x, y];
    let rest = root & !(x | y);
    if rest != 0 {
        to.push(rest);
    }
    w.split_ft(OWNER, sid, Usdc, &to, depth).unwrap();
    let (ax, ay) = odds::seed_reserves(qx, qy, depth);
    w.call(OWNER, POOL_FEE, |c| {
        c.create_between_pool(sid, x, y, U128(ax), U128(ay))
    })
    .unwrap()
}

/// Every pair of the odds tree at `q`.
pub fn seed_odds(w: &mut World, sid: u64, q: &[u128], depth: u128) -> Vec<u64> {
    let pairs = odds::pairs(q.len() as u8);
    pairs
        .iter()
        .map(|&(x, y)| seed_odds_pool(w, sid, x, y, sum_over(q, x), sum_over(q, y), depth))
        .collect()
}

/// The spot pool at `price` with `depth` wNEAR, from the owner's deposits.
pub fn seed_spot(w: &mut World, price: u128, depth: u128) -> u64 {
    let usdc = wmul(depth, price);
    w.deposit(OWNER, Wnear, depth).unwrap();
    w.deposit(OWNER, Usdc, usdc).unwrap();
    w.call(OWNER, POOL_FEE, |c| {
        c.create_spot_pool(U128(depth), U128(usdc))
    })
    .unwrap()
}

/// Gives `who` wNEAR-if-w and USDC-if-w in every world of the scenario.
pub fn give_world_tokens(w: &mut World, who: &str, sid: u64, wnear: u128, usdc: u128) {
    let n = w.view(|c| c.scenario(sid).world_count) as usize;
    for (asset, amount) in [(Wnear, wnear), (Usdc, usdc)] {
        if amount > 0 {
            w.split_ft(who, sid, asset, &singles(n), amount).unwrap();
        }
    }
}

pub fn fee_of(w: &mut World, pool: u64) -> u32 {
    w.view(|c| c.get_pool(pool).unwrap().fee_pips)
}

/// `(net sold, total, swaps recorded)` of the pool's fee window.
pub fn flow_of(w: &mut World, pool: u64) -> (i128, u128, u64) {
    w.view(|c| {
        let flow = &c.pool(pool).flow;
        let net: i128 = -flow.volumes().iter().sum::<i128>();
        let total: u128 = flow.volumes().iter().map(|v| v.unsigned_abs()).sum();
        (net, total, flow.count())
    })
}

pub fn price_of(w: &mut World, pool: u64) -> u128 {
    w.view(|c| c.get_pool(pool).unwrap().price.0)
}

pub fn tick_of(w: &mut World, pool: u64) -> i32 {
    w.view(|c| c.pool(pool).amm.tick().unwrap())
}

/// Exact-input swap through the public method. Asserts it logged exactly
/// one swap whose fee is what the pool said the next swap would pay.
pub fn swap(
    w: &mut World,
    who: &str,
    pool: u64,
    zero_for_one: bool,
    amount: u128,
) -> Result<(u128, u32), String> {
    let expected_fee = w.view(|c| c.get_pool(pool).map(|p| p.fee_pips));
    let out = w
        .call(who, ONE_YOCTO, |c| {
            c.swap(pool, zero_for_one, U128(amount), U128(0))
        })?
        .0;
    Ok((out, single_swap_fee(w, expected_fee.unwrap())))
}

/// Exact-output swap (the fee tests' buys); returns the input paid.
pub fn swap_out(w: &mut World, who: &str, pool: u64, zero_for_one: bool, out: u128) -> (u128, u32) {
    let expected_fee = fee_of(w, pool);
    let account = acc(who);
    let paid = w
        .call(who, NO_DEPOSIT, |c| {
            c.swap_exact_out_for(&account, pool, zero_for_one, out)
        })
        .unwrap();
    (paid, single_swap_fee(w, expected_fee))
}

fn single_swap_fee(w: &World, expected: u32) -> u32 {
    let swaps = w.last.data_of("swap");
    assert_eq!(swaps.len(), 1, "one swap event per swap");
    let fee = swaps[0]["fee_pips"].as_u64().unwrap() as u32;
    assert_eq!(fee, expected, "charged fee == fee read before");
    fee
}

/// Sell wNEAR-if-w into its world pool.
pub fn sell(w: &mut World, who: &str, pool: u64, amount: u128) -> (u128, u32) {
    swap(w, who, pool, true, amount).unwrap()
}

/// Buy exactly `amount` wNEAR-if-w out of its world pool.
pub fn buy(w: &mut World, who: &str, pool: u64, amount: u128) -> (u128, u32) {
    swap_out(w, who, pool, false, amount)
}

/// Floors a WAD amount to cents, the way the scripts print it.
pub fn cents(x: u128) -> u128 {
    x / 10_000_000_000_000_000
}

/// Floors a WAD price to 5 decimals: a NEAR price is a few dollars, so its
/// cents alone would hide the differences the tests pin.
pub fn price_5dp(x: u128) -> u128 {
    x / 10_000_000_000_000
}

pub fn within_rel(a: u128, b: u128, denominator: u128) -> bool {
    a.abs_diff(b) <= b / denominator
}

fn all_holders() -> [&'static str; 4] {
    [OWNER, ALICE, BOB, CAROL]
}

// Pool admission

#[test]
fn registers_within_world_pool() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let p = w.view(|c| c.get_pool(pools[3]).unwrap());
    assert_eq!(p.kind, "within");
    assert_eq!((p.scenario_id, p.world), (Some(w.s2x2), Some(3)));
    assert_eq!((p.mask0, p.mask1), (DELAYED_HOLDS, DELAYED_HOLDS));
    assert_eq!(
        (p.token0.as_str(), p.token1.as_str()),
        ("1:wnear:8", "1:usdc:8")
    );
    assert_eq!(w.view(|c| c.pool(pools[3]).twap.count()), 1);
    assert_eq!(p.swap_count, 0);
    let created = w.view(|c| c.world_pool(1, 3));
    assert_eq!(created, Some(pools[3]));
}

#[test]
fn registers_between_world_pool() {
    let mut w = pool_world();
    let sid = w.s2x2;
    let id = seed_odds_pool(&mut w, sid, HOLDS, CUTS, 7, 3, ODDS_DEPTH);
    let p = w.view(|c| c.get_pool(id).unwrap());
    assert_eq!(p.kind, "between");
    assert_eq!(p.mask0 | p.mask1, ROOT);
    assert_eq!(p.mask0 & p.mask1, 0);
    // the lower mask is token0 whatever order the owner names them in
    assert_eq!((p.mask0, p.mask1), (CUTS, HOLDS));
    assert_eq!(
        (p.token0.as_str(), p.token1.as_str()),
        ("1:usdc:3", "1:usdc:12")
    );
    assert_eq!((p.wnear_reserve, p.usdc_reserve), (None, None));
    // HOLDS (q 7) is likelier, so CUTS holds the full depth
    assert_eq!(p.reserve0.0, ODDS_DEPTH);
    assert_eq!(p.reserve1.0, ODDS_DEPTH * 3 / 7);
}

#[test]
fn rejects_real_asset() {
    let mut w = pool_world();
    let sid = w.s2x2;
    fails(
        w.call(OWNER, POOL_FEE, |c| {
            c.create_between_pool(sid, ROOT, DELAYED_HOLDS, U128(E18), U128(E18))
        }),
        "NotVerseToken(usdc.near)",
    );
}

#[test]
fn rejects_different_scenarios() {
    let mut w = pool_world();
    let (s2, sb) = (w.s2x2, w.s_bin);
    fails(
        w.try_view(|c| {
            c.admit_pair(
                VerseKey::new(s2, Wnear, SHIPS_CUTS),
                VerseKey::new(sb, Usdc, BIN_SHIPS),
            )
        }),
        "DifferentScenarios(1, 2)",
    );
}

#[test]
fn rejects_unsupported_pairs() {
    let mut w = pool_world();
    let s = w.s2x2;
    let cases = [
        // two wNEAR verses
        (
            (Wnear, SHIPS_CUTS),
            (Wnear, DELAYED_CUTS),
            "UnsupportedPair(1:wnear:1, 1:wnear:2)",
        ),
        // wNEAR and USDC of different worlds
        (
            (Wnear, SHIPS_CUTS),
            (Usdc, DELAYED_CUTS),
            "UnsupportedPair(1:wnear:1, 1:usdc:2)",
        ),
        // overlapping USDC verses
        (
            (Usdc, 0x6),
            (Usdc, CUTS),
            "UnsupportedPair(1:usdc:3, 1:usdc:6)",
        ),
        // a single-world wNEAR against a two-world USDC
        (
            (Wnear, SHIPS_CUTS),
            (Usdc, HOLDS),
            "UnsupportedPair(1:wnear:1, 1:usdc:12)",
        ),
    ];
    for ((a0, m0), (a1, m1), expected) in cases {
        fails(
            w.try_view(|c| c.admit_pair(VerseKey::new(s, a0, m0), VerseKey::new(s, a1, m1))),
            expected,
        );
    }
    fails(
        w.call(OWNER, POOL_FEE, |c| {
            c.create_between_pool(s, 0x6, CUTS, U128(E18), U128(E18))
        }),
        "UnsupportedPair(1:usdc:3, 1:usdc:6)",
    );
}

#[test]
fn rejects_dead_verse() {
    let mut w = pool_world();
    let (s, fed) = (w.s2x2, w.fed);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    fails(
        w.call(OWNER, POOL_FEE, |c| {
            c.create_within_pool(s, 0, U128(E18), U128(E18))
        }),
        "DeadVerse(1)",
    );
    fails(
        w.call(OWNER, POOL_FEE, |c| {
            c.create_between_pool(s, SHIPS_CUTS, DELAYED_HOLDS, U128(E18), U128(E18))
        }),
        "DeadVerse(1)",
    );
}

#[test]
fn rejects_a_second_pool_bad_worlds_and_strangers() {
    let mut w = pool_world();
    let s = w.s2x2;
    let pools = seed_demo_2x2(&mut w);
    fails(
        w.call(OWNER, POOL_FEE, |c| {
            c.create_within_pool(s, 3, U128(E18), U128(E18))
        }),
        &format!("AlreadyInitialized({})", pools[3]),
    );
    fails(
        w.call(OWNER, POOL_FEE, |c| {
            c.create_within_pool(s, 4, U128(E18), U128(E18))
        }),
        "InvalidWorld(4)",
    );
    fails(
        w.call(OWNER, POOL_FEE, |c| {
            c.create_within_pool(s, 0, U128(0), U128(E18))
        }),
        "AlreadyInitialized(1)",
    );
    fails(
        w.call(ALICE, POOL_FEE, |c| {
            c.create_within_pool(s, 0, U128(E18), U128(E18))
        }),
        "NotOwner(alice.near)",
    );
    let sb = w.s_bin;
    fails(
        w.call(OWNER, POOL_FEE, |c| {
            c.create_within_pool(sb, 0, U128(0), U128(E18))
        }),
        "ZeroAmount",
    );
    fails(
        w.call(OWNER, POOL_FEE, |c| {
            c.create_within_pool(9, 0, U128(E18), U128(E18))
        }),
        "UnknownScenario(9)",
    );
}

#[test]
fn pool_creation_logs_and_takes_the_owners_tokens() {
    let mut w = pool_world();
    let s = w.s2x2;
    w.split_ft(OWNER, s, Wnear, &singles(4), 10_000 * E18)
        .unwrap();
    w.split_ft(OWNER, s, Usdc, &singles(4), 30_000 * E18)
        .unwrap();
    let id = seed_world(&mut w, s, 1, 3_000 * E15, 10_000 * E18);
    let logs = w.last.data_of("pool_created");
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0]["kind"], "within");
    assert_eq!(logs[0]["pool_id"], id);
    assert_eq!(logs[0]["price"], (3_000 * E15).to_string());
    assert_eq!(w.bal(OWNER, s, Wnear, DELAYED_CUTS), 0);
    assert_eq!(w.bal(OWNER, s, Usdc, DELAYED_CUTS), 0);
    let moved = w
        .last
        .events()
        .into_iter()
        .filter(|e| e["standard"] == "nep245" && e["event"] == "mt_transfer")
        .count();
    assert_eq!(moved, 1);
    w.assert_conservation(&all_holders());
}

// Halts and dead worlds

#[test]
fn swap_pays_the_base_fee() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, 10 * E18, 0);
    let (_, fee) = sell(&mut w, ALICE, pools[3], E18);
    assert_eq!(fee, 3000);
}

#[test]
fn swap_fails_while_halted() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let (s, sb, fed) = (w.s2x2, w.s_bin, w.fed);
    let bin_pools = seed_worlds(&mut w, sb, &DEMO_BIN, &[DEPTH; 2]);
    give_world_tokens(&mut w, ALICE, s, 10 * E18, 0);
    give_world_tokens(&mut w, ALICE, sb, 10 * E18, 0);
    w.report(fed, OUT_HOLDS).unwrap();
    fails(
        swap(&mut w, ALICE, pools[3], true, E18),
        "ScenarioHalted(1)",
    );
    // quotes fail the same way, and the sale quote shows 0
    assert_eq!(w.view(|c| c.quote_exact_in(pools[3], true, E18)), None);
    assert_eq!(
        w.view(|c| c.quote_sell(s, U128(E18), DELAYED_HOLDS))[3].0,
        0
    );
    // a Fed proposal does not halt the binary scenario
    sell(&mut w, ALICE, bin_pools[1], E18);
    // the halt lasts past the window, until someone finalizes
    w.warp(DISPUTE_WINDOW + 100);
    fails(
        swap(&mut w, ALICE, pools[3], true, E18),
        "ScenarioHalted(1)",
    );
    w.finalize(BOB, fed).unwrap();
    sell(&mut w, ALICE, pools[3], E18);
}

#[test]
fn swap_fails_in_dead_world() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let (s, fed, spice) = (w.s2x2, w.fed, w.spice);
    give_world_tokens(&mut w, ALICE, s, 10 * E18, 10_000 * E18);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    fails(swap(&mut w, ALICE, pools[0], true, E18), "DeadVerse(1)");
    fails(swap(&mut w, ALICE, pools[1], false, E18), "DeadVerse(2)");
    sell(&mut w, ALICE, pools[2], E18);
    // a halt is reported before death
    w.report(spice, OUT_SHIPS).unwrap();
    fails(
        swap(&mut w, ALICE, pools[0], true, E18),
        "ScenarioHalted(1)",
    );
}

#[test]
fn between_pool_reports_the_dead_side() {
    let mut w = pool_world();
    let (s, fed, spice) = (w.s2x2, w.fed, w.spice);
    let id = seed_odds_pool(&mut w, s, SHIPS_HOLDS, DELAYED_HOLDS, 2, 1, ODDS_DEPTH);
    w.split_ft(ALICE, s, Usdc, &singles(4), 10_000 * E18)
        .unwrap();
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    swap(&mut w, ALICE, id, true, E18).unwrap();
    w.admin_resolve(spice, OUT_SHIPS).unwrap();
    // token0 (SHIPS·HOLDS) lives; token1 died
    fails(swap(&mut w, ALICE, id, true, E18), "DeadVerse(8)");
}

#[test]
fn unknown_pool_and_zero_amount() {
    let mut w = pool_world();
    seed_demo_2x2(&mut w);
    assert_eq!(w.view(|c| c.get_pool(99)), None);
    fails(swap(&mut w, ALICE, 99, true, E18), "UnknownPool(99)");
    fails(swap(&mut w, ALICE, 1, true, 0), "ZeroAmount");
    assert_eq!(w.view(|c| c.quote_exact_in(99, true, E18)), None);
    assert_eq!(w.view(|c| c.quote_exact_in(1, true, 0)), None);
}

#[test]
fn swap_enforces_min_out_and_one_yocto() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, 10 * E18, 0);
    let quote = w.view(|c| c.quote_exact_in(pools[3], true, E18)).unwrap();
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.swap(pools[3], true, U128(E18), U128(quote + 1))
        }),
        &format!("TooLittleReceived({quote}, {})", quote + 1),
    );
    let out = w
        .call(ALICE, ONE_YOCTO, |c| {
            c.swap(pools[3], true, U128(E18), U128(quote))
        })
        .unwrap();
    assert_eq!(out.0, quote);
    assert_eq!(w.bal(ALICE, s, Usdc, DELAYED_HOLDS), quote);
    assert_eq!(w.bal(ALICE, s, Wnear, DELAYED_HOLDS), 9 * E18);
    assert!(w
        .call(ALICE, NO_DEPOSIT, |c| c.swap(
            pools[3],
            true,
            U128(E18),
            U128(0)
        ))
        .unwrap_err()
        .contains("1 yoctoNEAR"));
    assert!(swap(&mut w, BOB, pools[3], true, E18).is_err());
    w.assert_conservation(&all_holders());
}

// TWAP

#[test]
fn mean_tick_needs_a_full_window_of_history() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let seeded = tick_of(&mut w, pools[3]);
    let now = w.now;
    assert_eq!(w.view(|c| c.pool(pools[3]).twap.mean_tick(now, 60)), None);
    assert_eq!(w.view(|c| c.get_pool(pools[3]).unwrap().twap_price), None);
    w.warp(59);
    let now = w.now;
    assert_eq!(w.view(|c| c.pool(pools[3]).twap.mean_tick(now, 60)), None);
    w.warp(1);
    let now = w.now;
    assert_eq!(
        w.view(|c| c.pool(pools[3]).twap.mean_tick(now, 60)),
        Some(seeded)
    );
    let p = w.view(|c| c.get_pool(pools[3]).unwrap());
    assert_eq!(p.twap_price, price::from_tick(seeded).map(U128));
    assert!(p.twap_ok);
}

#[test]
fn mean_tick_is_time_weighted() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, 10 * E18, 0);
    w.warp(100);
    let tick0 = tick_of(&mut w, pools[3]);
    sell(&mut w, ALICE, pools[3], 5 * E18);
    let tick1 = tick_of(&mut w, pools[3]);
    assert!(tick1 < tick0);
    w.warp(30);
    let now = w.now;
    let mean = w
        .view(|c| c.pool(pools[3]).twap.mean_tick(now, 60))
        .unwrap();
    let expected = (i64::from(tick0) * 30 + i64::from(tick1) * 30).div_euclid(60);
    assert_eq!(i64::from(mean), expected);
}

#[test]
fn swaps_in_one_second_leave_one_observation() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, 10 * E18, 0);
    w.warp(10);
    sell(&mut w, ALICE, pools[3], E18);
    sell(&mut w, ALICE, pools[3], E18);
    assert_eq!(w.view(|c| c.pool(pools[3]).twap.count()), 2);
    let last = w.view(|c| c.pool(pools[3]).twap.latest().unwrap().tick);
    assert_eq!(last, tick_of(&mut w, pools[3]));
}

#[test]
fn seeded_price_matches_spec() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    for (i, id) in pools.iter().enumerate() {
        let p = price_of(&mut w, *id);
        assert!(within_rel(p, DEMO_2X2[i], 1_000_000));
        // reserves carry the exact ratio, so the NEAR pools hit the price
        assert_eq!(p, DEMO_2X2[i]);
        let v = w.view(|c| c.get_pool(*id).unwrap());
        assert_eq!(v.wnear_reserve, Some(U128(DEPTH)));
        assert_eq!(v.usdc_reserve, Some(U128(wmul(DEPTH, DEMO_2X2[i]))));
    }
}

// The dynamic fee

#[test]
fn fee_base_without_history() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, 10 * E18, 0);
    assert_eq!(flow_of(&mut w, pools[3]), (0, 0, 0));
    assert_eq!(fee_of(&mut w, pools[3]), 3000);
    assert_eq!(sell(&mut w, ALICE, pools[3], E18).1, 3000);
    // one sale fills the window one-sidedly
    assert_eq!(fee_of(&mut w, pools[3]), 15000);
}

#[test]
fn fee_base_with_balanced_flow() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, 10 * E18, 100_000 * E18);
    for _ in 0..4 {
        sell(&mut w, ALICE, pools[3], E18);
        buy(&mut w, ALICE, pools[3], E18);
        assert_eq!(fee_of(&mut w, pools[3]), 3000);
    }
    assert_eq!(flow_of(&mut w, pools[3]), (0, 8 * E18, 8));
    assert_eq!(sell(&mut w, ALICE, pools[3], E18).1, 3000);
}

#[test]
fn fee_rises_under_one_sided_flow() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, 20 * E18, 100_000 * E18);
    for _ in 0..4 {
        buy(&mut w, ALICE, pools[3], E18);
    }
    for _ in 0..4 {
        sell(&mut w, ALICE, pools[3], E18);
    }
    let fees: Vec<u32> = (0..6)
        .map(|_| sell(&mut w, ALICE, pools[3], E18).1)
        .collect();
    assert_eq!(fees, [3000, 6000, 9000, 12000, 15000, 15000]);
    assert_eq!(w.view(|c| c.params.fee_cap_pips), 15000);
}

#[test]
fn fee_one_sided_from_empty_history() {
    let mut seed = 7;
    for _ in 0..8 {
        let mut w = pool_world();
        let pools = seed_demo_2x2(&mut w);
        let s = w.s2x2;
        give_world_tokens(&mut w, ALICE, s, 30 * E18, 0);
        let mut last = 0;
        for i in 0..10 {
            seed = next_seed(seed);
            let size = 1_000_000_000 + u128::from(seed) % (2 * E18 - 1_000_000_000);
            let (_, fee) = sell(&mut w, ALICE, pools[3], size);
            assert_eq!(fee, if i == 0 { 3000 } else { 15000 });
            assert!(fee >= last);
            last = fee;
        }
    }
}

/// The fee formula written out independently: base plus the rounded-up
/// share of the spread, over the last 8 recorded (non-zero) volumes.
fn expected_fee(volumes: &[i128]) -> u32 {
    let window: Vec<i128> = volumes
        .iter()
        .copied()
        .filter(|v| *v != 0)
        .rev()
        .take(8)
        .collect();
    let total: u128 = window.iter().map(|v| v.unsigned_abs()).sum();
    if total == 0 {
        return 3000;
    }
    let net = window.iter().sum::<i128>().unsigned_abs();
    3000 + (12_000 * net).div_ceil(total) as u32
}

#[test]
fn fee_matches_the_formula() {
    let mut seed = 42;
    for _ in 0..6 {
        let mut w = pool_world();
        let pools = seed_demo_2x2(&mut w);
        let s = w.s2x2;
        give_world_tokens(&mut w, ALICE, s, 100 * E18, 1_000_000 * E18);
        let mut volumes = Vec::new();
        for _ in 0..20 {
            seed = next_seed(seed);
            let size = 1_000_000_000 + u128::from(seed >> 1) % (3 * E18);
            let expected = expected_fee(&volumes);
            let fee = if seed & 1 == 0 {
                volumes.push(-(size as i128));
                sell(&mut w, ALICE, pools[3], size).1
            } else {
                volumes.push(size as i128);
                buy(&mut w, ALICE, pools[3], size).1
            };
            assert_eq!(fee, expected);
            assert!((3000..=15000).contains(&fee));
        }
    }
}

#[test]
fn fee_rounds_up_in_the_pools_favour() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, 10 * E18, 10_000 * E18);
    sell(&mut w, ALICE, pools[3], E18 + 1);
    buy(&mut w, ALICE, pools[3], E18);
    assert_eq!(fee_of(&mut w, pools[3]), 3001);
}

#[test]
fn fee_is_per_pool() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, 10 * E18, 0);
    for _ in 0..3 {
        sell(&mut w, ALICE, pools[3], E18);
    }
    assert_eq!(fee_of(&mut w, pools[3]), 15000);
    for id in &pools[..3] {
        assert_eq!(fee_of(&mut w, *id), 3000);
    }
    // the L-shape sale touches worlds 1..3, one swap each
    let fees: Vec<u32> = (1..4)
        .map(|i| sell(&mut w, ALICE, pools[i], E18).1)
        .collect();
    assert_eq!(fees, [3000, 3000, 15000]);
}

#[test]
fn fee_within_world_volume_is_wnear() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, 10 * E18, 10_000 * E18);
    sell(&mut w, ALICE, pools[0], E18);
    assert_eq!(flow_of(&mut w, pools[0]), (E18 as i128, E18, 1));
    // a USDC-in buy records the wNEAR that came out
    let (out, _) = swap(&mut w, ALICE, pools[1], false, 3000 * E18).unwrap();
    assert_eq!(flow_of(&mut w, pools[1]), (-(out as i128), out, 1));
}

#[test]
fn fee_between_world_pool() {
    let mut w = pool_world();
    let s = w.s2x2;
    let id = seed_odds_pool(
        &mut w,
        s,
        SHIPS_HOLDS,
        DELAYED_HOLDS,
        6667,
        3333,
        ODDS_DEPTH,
    );
    w.split_ft(ALICE, s, Usdc, &singles(4), 10_000 * E18)
        .unwrap();
    assert_eq!(swap(&mut w, ALICE, id, true, 1000 * E18).unwrap().1, 3000);
    assert_eq!(fee_of(&mut w, id), 15000);
    assert_eq!(swap_out(&mut w, ALICE, id, false, 1000 * E18).1, 15000);
    assert_eq!(flow_of(&mut w, id), (0, 2000 * E18, 2));
    assert_eq!(fee_of(&mut w, id), 3000);
}

#[test]
fn fee_dust_swaps_do_not_reset_the_window() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, 10 * E18, 10_000 * E18);
    for _ in 0..8 {
        sell(&mut w, ALICE, pools[3], E18);
    }
    let twap_before = w.view(|c| c.pool(pools[3]).twap.count());
    for _ in 0..8 {
        w.warp(1);
        let (out, _) = swap(&mut w, ALICE, pools[3], false, 1).unwrap();
        assert_eq!(out, 0);
    }
    assert_eq!(flow_of(&mut w, pools[3]), (8 * E18 as i128, 8 * E18, 8));
    assert_eq!(fee_of(&mut w, pools[3]), 15000);
    // they still write the TWAP: with observations spaced for a 30 minute
    // window, eight seconds move the newest one forward rather than add more
    let twap = w.view(|c| c.pool(pools[3]).twap.clone());
    assert!(twap.count() <= twap_before + 1);
    assert_eq!(twap.latest().unwrap().timestamp, w.now);
}

// Moving the spot pool

fn spot_world() -> (World, u64) {
    let mut w = pool_world();
    let id = seed_spot(&mut w, 3_000 * E15, 1_000_000 * E18);
    // working balances for the moves
    w.deposit(OWNER, Wnear, 1_000_000 * E18).unwrap();
    w.deposit(OWNER, Usdc, 10_000_000 * E18).unwrap();
    (w, id)
}

fn move_spot(w: &mut World, price: u128) -> Result<Option<crate::amm::create::SpotMove>, String> {
    w.call(OWNER, ONE_YOCTO, |c| c.move_spot_to(U128(price)))
}

#[test]
fn move_to_up_and_down_lands_on_the_target() {
    let (mut w, id) = spot_world();
    let held = w.held_by_contract(Wnear) + w.held_by_contract(Usdc);
    for target in [3_200 * E15, 2_900 * E15] {
        let (wnear0, usdc0) = (w.real(OWNER, Wnear), w.real(OWNER, Usdc));
        let m = move_spot(&mut w, target).unwrap().unwrap();
        let p = w.view(|c| c.spot_price()).0;
        // the closed form lands within a few units of the target
        assert!(p.abs_diff(target) <= 1_000_000, "{p} vs {target}");
        let (wnear1, usdc1) = (w.real(OWNER, Wnear), w.real(OWNER, Usdc));
        if target > 3_000 * E15 {
            assert!(!m.zero_for_one);
            assert_eq!(usdc0 - usdc1, m.amount_in.0);
            assert_eq!(wnear1 - wnear0, m.amount_out.0);
        } else {
            assert!(m.zero_for_one);
            assert_eq!(wnear0 - wnear1, m.amount_in.0);
            assert_eq!(usdc1 - usdc0, m.amount_out.0);
        }
        // the spot pool's holdings are the only real tokens beyond balances
        let spot = w.view(|c| c.spot_holdings(Wnear) + c.spot_holdings(Usdc));
        let balances = w.real(OWNER, Wnear) + w.real(OWNER, Usdc);
        assert_eq!(spot + balances, held);
    }
    // the spot pool keeps a static fee and no TWAP
    let v = w.view(|c| c.get_pool(id).unwrap());
    assert_eq!(
        (v.fee_pips, v.swap_count, v.twap_price, v.twap_ok),
        (3000, 0, None, false)
    );
}

#[test]
fn move_to_at_the_target_is_a_no_op() {
    let (mut w, _) = spot_world();
    let p = w.view(|c| c.spot_price()).0;
    let wnear = w.real(OWNER, Wnear);
    assert_eq!(move_spot(&mut w, p).unwrap(), None);
    assert_eq!(w.view(|c| c.spot_price()).0, p);
    assert_eq!(w.real(OWNER, Wnear), wnear);
}

#[test]
fn move_to_only_owner() {
    let (mut w, _) = spot_world();
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.move_spot_to(U128(3_200 * E15))),
        "NotOwner(alice.near)",
    );
    let mut bare = pool_world();
    fails(move_spot(&mut bare, 3_200 * E15), "NoSpotPool");
}

// The spot pool

#[test]
fn spot_pool_is_created_once_from_real_balances() {
    let mut w = pool_world();
    let id = seed_spot(&mut w, 3_000 * E15, 100_000 * E18);
    assert_eq!(w.real(OWNER, Wnear), 0);
    let v = w.view(|c| c.get_spot_pool().unwrap());
    assert_eq!((v.id, v.kind.as_str(), v.scenario_id), (id, "spot", None));
    assert_eq!(
        (v.token0.as_str(), v.token1.as_str()),
        (WNEAR_TOKEN, USDC_TOKEN)
    );
    assert_eq!(w.view(|c| c.spot_price()).0, 3_000 * E15);
    w.deposit(OWNER, Wnear, E18).unwrap();
    w.deposit(OWNER, Usdc, E18).unwrap();
    fails(
        w.call(OWNER, POOL_FEE, |c| {
            c.create_spot_pool(U128(E18), U128(E18))
        }),
        &format!("AlreadyInitialized({id})"),
    );
}

#[test]
fn spot_swap_action_credits_the_internal_balance() {
    let mut w = pool_world();
    let fed = w.fed;
    seed_spot(&mut w, 3_000 * E15, 100_000 * E18);
    let id = w.view(|c| c.spot_pool).unwrap();
    // never halted
    w.report(fed, OUT_HOLDS).unwrap();
    let quote = w.view(|c| c.quote_exact_in(id, true, 1_000 * E18)).unwrap();
    let msg = r#"{"action":"spot_swap","min_out":"0"}"#;
    assert_eq!(
        w.ft_transfer_call(ALICE, Wnear, 1_000 * E18, msg).unwrap(),
        0
    );
    assert_eq!(w.real(ALICE, Usdc), quote);
    assert_eq!(w.real(ALICE, Wnear), 0);
    assert_eq!(w.wallet(ALICE, Wnear), FUND - 1_000 * E18);
    let swaps = w.last.data_of("swap");
    assert_eq!(swaps[0]["fee_pips"], 3000);
    // static fee: one-sided flow changes nothing
    assert_eq!(fee_of(&mut w, id), 3000);
    // USDC in, 6-decimal token units
    let usdc_in = 3000 * E18;
    let quote = w.view(|c| c.quote_exact_in(id, false, usdc_in)).unwrap();
    let msg = format!(r#"{{"action":"spot_swap","min_out":"{quote}"}}"#);
    w.ft_transfer_call(ALICE, Usdc, usdc_in / scale(Usdc), &msg)
        .unwrap();
    assert_eq!(w.real(ALICE, Wnear), quote);
    // too little out: the transfer is refunded in full
    let wallet = w.wallet(ALICE, Wnear);
    let msg = r#"{"action":"spot_swap","min_out":"1000000000000000000000000"}"#;
    assert!(w
        .ft_transfer_call(ALICE, Wnear, 1_000 * E18, msg)
        .unwrap_err()
        .starts_with("TooLittleReceived("));
    assert_eq!(w.wallet(ALICE, Wnear), wallet);
}

#[test]
fn spot_swap_through_the_method_uses_internal_balances() {
    let mut w = pool_world();
    let id = seed_spot(&mut w, 3_000 * E15, 100_000 * E18);
    w.deposit(ALICE, Wnear, 2_000 * E18).unwrap();
    let (out, fee) = swap(&mut w, ALICE, id, true, 1_000 * E18).unwrap();
    assert_eq!(fee, 3000);
    assert_eq!(w.real(ALICE, Usdc), out);
    assert_eq!(w.real(ALICE, Wnear), 1_000 * E18);
    let held = w.held_by_contract(Wnear);
    let inside = w.real(ALICE, Wnear) + w.real(OWNER, Wnear) + w.view(|c| c.spot_holdings(Wnear));
    assert_eq!(held, inside);
}

// Liquidity positions

#[test]
fn liquidity_add_collect_remove() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let (s, id) = (w.s2x2, pools[3]);
    give_world_tokens(&mut w, BOB, s, 50_000 * E18, 200_000 * E18);
    give_world_tokens(&mut w, ALICE, s, 10_000 * E18, 0);
    assert!(!w.view(|c| c.has_pool_positions(&acc(BOB))));
    let storage = w.storage_used(BOB);
    let added = w
        .call(BOB, ONE_YOCTO, |c| {
            c.add_liquidity(id, U128(50_000 * E18), U128(200_000 * E18), U128(0))
        })
        .unwrap();
    assert!(w.storage_used(BOB) > storage);
    // binding side: 50,000 wNEAR at 2.50 needs 125,000 USDC
    assert!(added.amount0.0 <= 50_000 * E18 && added.amount0.0 > 50_000 * E18 - 1_000);
    assert!(within_rel(
        added.amount1.0,
        125_000 * E18,
        1_000_000_000_000
    ));
    assert_eq!(
        w.bal(BOB, s, Usdc, DELAYED_HOLDS),
        200_000 * E18 - added.amount1.0
    );
    assert!(w.view(|c| c.has_pool_positions(&acc(BOB))));
    let pos = w.view(|c| c.position_of(id, acc(BOB)).unwrap());
    assert_eq!(pos.liquidity, added.liquidity);
    assert_eq!((pos.fees0.0, pos.fees1.0), (0, 0));
    assert_eq!(w.last.data_of("liquidity")[0]["action"], "add");
    // the price did not move
    assert_eq!(price_of(&mut w, id), 2_500 * E15);

    // a sale pays its fee in wNEAR, shared by liquidity
    sell(&mut w, ALICE, id, 10_000 * E18);
    let fee_total = 10_000 * E18 * 3000 / 1_000_000;
    let pool = w.view(|c| c.get_pool(id).unwrap());
    assert_eq!((pool.fees0.0, pool.fees1.0), (fee_total, 0));
    let bob = w.view(|c| c.position_of(id, acc(BOB)).unwrap());
    let owner = w.view(|c| c.position_of(id, acc(OWNER)).unwrap());
    assert_eq!(bob.fees1.0, 0);
    assert!(bob.fees0.0 + owner.fees0.0 <= fee_total);
    assert!(bob.fees0.0 + owner.fees0.0 >= fee_total - 2);
    let share = mul_div_down(bob.liquidity.0, WAD, pool.liquidity.0);
    assert!(within_rel(
        bob.fees0.0,
        wmul(fee_total, share),
        1_000_000_000
    ));

    let wnear = w.bal(BOB, s, Wnear, DELAYED_HOLDS);
    let got = w.call(BOB, ONE_YOCTO, |c| c.collect_fees(id)).unwrap();
    assert_eq!(got.fees0.0, bob.fees0.0);
    assert_eq!(w.bal(BOB, s, Wnear, DELAYED_HOLDS), wnear + bob.fees0.0);
    assert_eq!(w.view(|c| c.position_of(id, acc(BOB)).unwrap().fees0.0), 0);

    let before = w.view(|c| c.position_of(id, acc(BOB)).unwrap());
    let out = w
        .call(BOB, ONE_YOCTO, |c| {
            c.remove_liquidity(id, before.liquidity, before.amount0, before.amount1)
        })
        .unwrap();
    assert_eq!((out.amount0, out.amount1), (before.amount0, before.amount1));
    assert_eq!(w.view(|c| c.position_of(id, acc(BOB))), None);
    assert!(!w.view(|c| c.has_pool_positions(&acc(BOB))));
    assert_eq!(w.storage_used(BOB), storage);
    w.assert_conservation(&all_holders());
}

#[test]
fn liquidity_checks() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let (s, id) = (w.s2x2, pools[3]);
    give_world_tokens(&mut w, BOB, s, 10_000 * E18, 30_000 * E18);
    fails(
        w.call(BOB, ONE_YOCTO, |c| {
            c.add_liquidity(id, U128(1_000 * E18), U128(2500 * E18), U128(u128::MAX))
        }),
        // sqrt(1,000 * 2,500) of liquidity
        &format!(
            "TooLittleLiquidity({}, {})",
            1_581_138_830_084_189_665_999u128,
            u128::MAX
        ),
    );
    fails(
        w.call(BOB, ONE_YOCTO, |c| {
            c.remove_liquidity(id, U128(1), U128(0), U128(0))
        }),
        "InsufficientLiquidity(1, 0)",
    );
    fails(
        w.call(BOB, ONE_YOCTO, |c| c.collect_fees(id)),
        &format!("NoPosition({id}, bob.near)"),
    );
    fails(
        w.call(BOB, ONE_YOCTO, |c| {
            c.add_liquidity(99, U128(E18), U128(E18), U128(0))
        }),
        "UnknownPool(99)",
    );
    fails(
        w.call(BOB, ONE_YOCTO, |c| {
            c.add_liquidity(id, U128(0), U128(E18), U128(0))
        }),
        "ZeroAmount",
    );
    let added = w
        .call(BOB, ONE_YOCTO, |c| {
            c.add_liquidity(id, U128(1_000 * E18), U128(2500 * E18), U128(0))
        })
        .unwrap();
    assert!(w
        .call(BOB, ONE_YOCTO, |c| {
            c.remove_liquidity(id, added.liquidity, U128(1_000 * E18 + 1), U128(0))
        })
        .unwrap_err()
        .starts_with("TooLittleReceived("));
    // a position blocks unregistering
    fails(
        w.call(BOB, ONE_YOCTO, |c| c.storage_unregister(None)),
        "AccountNotEmpty(bob.near)",
    );
}

#[test]
fn liquidity_is_never_blocked() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let (s, fed, spice) = (w.s2x2, w.fed, w.spice);
    give_world_tokens(&mut w, BOB, s, 10 * E18, 40_000 * E18);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    w.report(spice, OUT_SHIPS).unwrap();
    // halted, and world 0 is dead
    for id in [pools[0], pools[3]] {
        let p = price_of(&mut w, id);
        let added = w
            .call(BOB, ONE_YOCTO, |c| {
                c.add_liquidity(id, U128(E18), U128(p), U128(0))
            })
            .unwrap();
        w.call(BOB, ONE_YOCTO, |c| c.collect_fees(id)).unwrap();
        w.call(BOB, ONE_YOCTO, |c| {
            c.remove_liquidity(id, added.liquidity, U128(0), U128(0))
        })
        .unwrap();
    }
    w.assert_conservation(&all_holders());
}

#[test]
fn a_drained_pool_takes_a_new_price() {
    let mut w = pool_world();
    let s = w.s2x2;
    w.split_ft(OWNER, s, Wnear, &singles(4), 10_000 * E18)
        .unwrap();
    w.split_ft(OWNER, s, Usdc, &singles(4), 40_000 * E18)
        .unwrap();
    let id = seed_world(&mut w, s, 0, 3_000 * E15, 1_000 * E18);
    let all = w.view(|c| c.position_of(id, acc(OWNER)).unwrap());
    w.call(OWNER, ONE_YOCTO, |c| {
        c.remove_liquidity(id, all.liquidity, U128(0), U128(0))
    })
    .unwrap();
    assert_eq!(price_of(&mut w, id), 0);
    fails(swap(&mut w, OWNER, id, true, E18), "NoLiquidity");
    assert_eq!(w.view(|c| c.quote_sell(s, U128(E18), 1))[0].0, 0);
    w.warp(5);
    w.call(OWNER, ONE_YOCTO, |c| {
        c.add_liquidity(id, U128(E18), U128(3500 * E18), U128(0))
    })
    .unwrap();
    assert_eq!(price_of(&mut w, id), 3500 * E18);
    let latest = w.view(|c| c.pool(id).twap.latest().unwrap());
    assert_eq!(
        (latest.timestamp, latest.tick),
        (w.now, tick_of(&mut w, id))
    );
    w.assert_conservation(&all_holders());
}

// Lending's world price: TWAP and the depth gate

#[test]
fn world_price_needs_twap_history() {
    let mut w = pool_world();
    let sb = w.s_bin;
    seed_worlds(&mut w, sb, &DEMO_BIN, &[DEPTH; 2]);
    assert_eq!(w.view(|c| c.world_price(sb, 0)), (0, false));
    w.warp(60);
    let (p, ok) = w.view(|c| c.world_price(sb, 0));
    assert!(ok);
    // wNEAR is token0, so the floored mean tick prices it down, by at most a tick
    assert!(p <= 3_400 * E15 && within_rel(p, 3_400 * E15, 10_000));
    assert_eq!(price_5dp(p), 339_987);
    assert_eq!(price_5dp(w.view(|c| c.world_price(sb, 1)).0), 279_980);
    // no pool, no price
    assert_eq!(w.view(|c| c.world_price(1, 0)), (0, false));
}

#[test]
fn world_price_below_liquidity_gate_counts_zero() {
    let mut w = pool_world();
    let sb = w.s_bin;
    seed_worlds(&mut w, sb, &DEMO_BIN, &[1_000 * E18, DEPTH]);
    w.warp(60);
    // 1,000 wNEAR deep at 3.40 holds 3,400 USDC, under the 10,000 gate
    assert_eq!(w.view(|c| c.world_price(sb, 0)), (0, false));
    assert!(!w.view(|c| c.get_pool(1).unwrap().twap_ok));
    assert!(w.view(|c| c.world_price(sb, 1)).1);
}

#[test]
fn world_price_follows_liquidity_in_and_out() {
    let mut w = pool_world();
    let sb = w.s_bin;
    let pools = seed_worlds(&mut w, sb, &DEMO_BIN, &[DEPTH; 2]);
    give_world_tokens(&mut w, BOB, sb, 300_000 * E18, 1_100_000 * E18);
    let added = w
        .call(BOB, ONE_YOCTO, |c| {
            c.add_liquidity(
                pools[0],
                U128(300_000 * E18),
                U128(1_020_000 * E18),
                U128(0),
            )
        })
        .unwrap();
    // the owner pulls out, leaving Bob's position
    let owner = w.view(|c| c.position_of(pools[0], acc(OWNER)).unwrap());
    w.call(OWNER, ONE_YOCTO, |c| {
        c.remove_liquidity(pools[0], owner.liquidity, U128(0), U128(0))
    })
    .unwrap();
    w.warp(60);
    assert!(w.view(|c| c.world_price(sb, 0)).1);
    // Bob pulls all but 2,000 wNEAR: under the gate
    let keep = added.liquidity.0 / 150;
    w.call(BOB, ONE_YOCTO, |c| {
        c.remove_liquidity(pools[0], U128(added.liquidity.0 - keep), U128(0), U128(0))
    })
    .unwrap();
    assert_eq!(w.view(|c| c.world_price(sb, 0)), (0, false));
    w.call(BOB, ONE_YOCTO, |c| {
        c.add_liquidity(pools[0], U128(10_000 * E18), U128(34_000 * E18), U128(0))
    })
    .unwrap();
    assert!(w.view(|c| c.world_price(sb, 0)).1);
}

#[test]
fn twap_follows_the_price_over_time() {
    let mut w = pool_world();
    let pools = seed_demo_thin(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, 10_000 * E18, 0);
    w.warp(120);
    let twap = |w: &mut World| w.view(|c| c.get_pool(pools[3]).unwrap().twap_price.unwrap().0);
    let seeded = twap(&mut w);
    assert!(w.view(|c| c.world_price(s, 3)).1);
    sell(&mut w, ALICE, pools[3], 2_000 * E18);
    let after = price_of(&mut w, pools[3]);
    // the sale's tick has no weight in its own second
    assert_eq!(twap(&mut w), seeded);
    // but the pool now sits more than 953 ticks (a factor 1.1) under its
    // TWAP, so lending refuses the world's price until the TWAP catches up
    assert!(after * 11 < seeded * 10);
    assert_eq!(w.view(|c| c.world_price(s, 3)), (0, false));
    w.warp(30);
    let half = twap(&mut w);
    assert!(half < seeded && half > after);
    // a pool younger than the window averages its whole history; a full
    // window after the sale the TWAP is the new price
    w.warp(1_800);
    let full = twap(&mut w);
    assert!(full < half && within_rel(full, after, 10_000));
    assert!(w.view(|c| c.world_price(s, 3)).1);
}

#[test]
fn test_world_price_override_wins() {
    let mut w = pool_world();
    crate::amm::test_hooks::set_price(1, 2, 1234);
    assert_eq!(w.view(|c| c.world_price(1, 2)), (1234, true));
    crate::amm::test_hooks::clear();
    assert_eq!(w.view(|c| c.world_price(1, 2)), (0, false));
}

// The Impact Meter ring

#[test]
fn impact_ring_keeps_the_last_points() {
    let mut w = pool_world();
    let pools = seed_demo_2x2(&mut w);
    let s = w.s2x2;
    give_world_tokens(&mut w, ALICE, s, 100 * E18, 0);
    let first = w.view(|c| c.impact(s));
    assert_eq!(first.len(), 1);
    // seeded one pool at a time in one second: the last point has them all
    let seeded: Vec<u128> = first[0].prices.iter().map(|p| p.0).collect();
    assert_eq!(seeded, DEMO_2X2);
    sell(&mut w, ALICE, pools[1], E18);
    sell(&mut w, ALICE, pools[2], E18);
    let points = w.view(|c| c.impact(s));
    assert_eq!(points.len(), 1, "same second, one point");
    w.warp(1);
    sell(&mut w, ALICE, pools[3], E18);
    let points = w.view(|c| c.impact(s));
    assert_eq!(points.len(), 2);
    assert_eq!(points[1].at_sec, w.now);
    for (i, id) in pools.iter().enumerate() {
        assert_eq!(points[1].prices[i].0, price_of(&mut w, *id));
    }
    for _ in 0..70 {
        w.warp(1);
        sell(&mut w, ALICE, pools[0], E18 / 10);
    }
    let points = w.view(|c| c.impact(s));
    assert_eq!(points.len(), IMPACT_POINTS);
    assert_eq!(points.last().unwrap().at_sec, w.now);
    assert_eq!(points[0].at_sec, w.now - 63);
    // between-world swaps add nothing
    let id = seed_odds_pool(&mut w, s, CUTS, HOLDS, 1, 1, ODDS_DEPTH);
    w.split_ft(ALICE, s, Usdc, &[CUTS, HOLDS], 1_000 * E18)
        .unwrap();
    w.warp(1);
    swap(&mut w, ALICE, id, true, E18).unwrap();
    assert_eq!(w.view(|c| c.impact(s)).last().unwrap().at_sec, w.now - 1);
}

#[test]
fn pools_of_lists_every_pool_of_the_scenario() {
    let mut w = pool_world();
    let s = w.s2x2;
    let within = seed_demo_2x2(&mut w);
    let between = seed_odds(&mut w, s, &independent_odds(4, 6667, 3000), ODDS_DEPTH);
    seed_spot(&mut w, 3_000 * E15, 1_000 * E18);
    let ids: Vec<u64> = w.view(|c| c.pools_of(s)).iter().map(|p| p.id).collect();
    assert_eq!(ids, [within, between].concat());
    assert!(w.view(|c| c.pools_of(2)).is_empty());
    w.assert_conservation(&all_holders());
    let real: u128 = w.view(|c| c.spot_holdings(Asset::Usdc));
    assert_eq!(real, 3000 * E18);
}
