//! Prices (F4, F5): world classification under each market's config, the
//! depth at the TWAP price, the borrow side at min(spot, TWAP), the
//! liquidation side at the TWAP (out-of-band worlds with a full window
//! included), the reference factor and its guard, the owner's config
//! setters with the lock while a market has debt, the views, the snapshot's
//! purity and cost, and migrate step 8 on production's state.
//!
//! Lending moves onto the snapshot in its own package; these tests pin what
//! the snapshot hands it.

use multiverse_math::fixed::{mul_div_down, WAD};
use near_sdk::env;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use proptest::prelude::*;

use super::amm::{
    buy, give_world_tokens, independent_odds, seed_odds, seed_worlds, sell, DEMO_2X2, DEMO_BIN,
    DEPTH, ODDS_DEPTH,
};
use super::harness::*;
use super::lending::{lending_world, Lend};
use super::profile::V1_PRICE_CFG;
use super::reference::{configure, report, reporter_only, set_cfg, with_reference};
use crate::amm::test_hooks::{self, TestQuote};
use crate::prices::{
    MarketPriceCfg, PriceBlock, PriceMode, PriceSnapshot, RefCheck, WorldQuote, WorldStatus,
};
use crate::types::Asset::Wnear;

use WorldStatus::{NoPool, OutOfBand, Shallow, Trusted, Young};

/// The v2 fixture (production defaults) with the owner and Carol funded and
/// no quote hooks.
pub fn v2_world() -> World {
    test_hooks::clear();
    let mut w = World::new_v2();
    w.fund(OWNER);
    w.fund(CAROL);
    w
}

/// The binary scenario's world pools at the demo prices, 100,000 wNEAR deep
/// (340,000 and 280,000 USDC-if-w), and its odds pool at 2/3 : 1/3.
pub fn seed_bin(w: &mut World) -> (u64, Vec<u64>) {
    let s = w.s_bin;
    let pools = seed_worlds(w, s, &DEMO_BIN, &[DEPTH; 2]);
    seed_odds(w, s, &independent_odds(2, 6_667, 0), ODDS_DEPTH);
    (s, pools)
}

pub fn snap(w: &mut World, s: u64) -> PriceSnapshot {
    w.view(|c| c.price_snapshot(s))
}

fn statuses(w: &mut World, s: u64) -> Vec<WorldStatus> {
    snap(w, s).statuses()
}

fn quote(twap: u128, spot: u128, status: WorldStatus, full_window: bool) -> TestQuote {
    TestQuote {
        twap,
        spot,
        status,
        full_window,
    }
}

/// The binary scenario priced by quotes at 4.00 in both worlds and odds 1/2
/// each (I = 4), with the reference reported by the reporter and switched on
/// for the market under `cfg`.
fn quoted_bin(cfg: MarketPriceCfg) -> (World, u64) {
    test_hooks::clear();
    let mut w = World::new_v2();
    let s = w.s_bin;
    test_hooks::set_price(s, 0, 4 * E18);
    test_hooks::set_price(s, 1, 4 * E18);
    test_hooks::set_odds(s, vec![E18 / 2; 2]);
    configure(&mut w, reporter_only()).unwrap();
    set_cfg(&mut w, s, cfg).unwrap();
    (w, s)
}

// ---- Classification ----

#[test]
fn classification_follows_the_market_config() {
    let mut w = v2_world();
    let (s, pools) = seed_bin(&mut w);
    // No TWAP yet.
    assert_eq!(statuses(&mut w, s), vec![Young; 2]);
    w.warp(61);
    // 61 s of history: young under the v2 age gate (1,800 s)...
    assert_eq!(statuses(&mut w, s), vec![Young; 2]);
    // ...trusted under the v1 gates on this market.
    set_cfg(&mut w, s, V1_PRICE_CFG).unwrap();
    assert_eq!(statuses(&mut w, s), vec![Trusted; 2]);
    // A depth gate above world 1's 280,000 USDC-if-1.
    let deep = MarketPriceCfg {
        min_depth: U128(300_000 * E18),
        ..V1_PRICE_CFG
    };
    set_cfg(&mut w, s, deep).unwrap();
    assert_eq!(statuses(&mut w, s), vec![Trusted, Shallow]);
    // A full window under the v2 gates.
    set_cfg(&mut w, s, MarketPriceCfg::V2).unwrap();
    w.warp(1_740);
    let sn = snap(&mut w, s);
    assert_eq!(sn.statuses(), vec![Trusted; 2]);
    assert!(sn
        .quotes
        .iter()
        .all(|q| q.full_window && q.age_sec == 1_801));
    // A dump of world 1 far past the band.
    give_world_tokens(&mut w, CAROL, s, 40_000 * E18, 0);
    sell(&mut w, CAROL, pools[1], 30_000 * E18);
    assert_eq!(statuses(&mut w, s), vec![Trusted, OutOfBand]);
    // A scenario without pools.
    let s2 = w.s2x2;
    assert_eq!(statuses(&mut w, s2), vec![NoPool; 4]);
    // The pool view shows the status of world pools only.
    let pool = |w: &mut World, id: u64| w.view(|c| c.get_pool(id).unwrap());
    assert_eq!(
        pool(&mut w, pools[1]).price_status.as_deref(),
        Some("out_of_band")
    );
    assert!(!pool(&mut w, pools[1]).twap_ok);
    assert_eq!(
        pool(&mut w, pools[0]).price_status.as_deref(),
        Some("trusted")
    );
    assert!(pool(&mut w, pools[0]).twap_ok);
    let odds_pool = w.view(|c| c.pools_of(s)).last().unwrap().clone();
    assert_eq!(
        (odds_pool.kind.as_str(), odds_pool.price_status),
        ("between", None)
    );
}

#[test]
fn depth_is_the_usdc_side_at_the_twap_price() {
    let mut w = v2_world();
    let (s, pools) = seed_bin(&mut w);
    set_cfg(&mut w, s, V1_PRICE_CFG).unwrap();
    w.warp(61);
    let q = snap(&mut w, s).quotes;
    for (i, reserve1) in [(0, 340_000 * E18), (1, 280_000 * E18)] {
        // At the pool's own price the depth is its USDC reserve, floored by
        // at most a tick.
        assert!(q[i].depth <= reserve1, "{i}");
        assert!(reserve1 - q[i].depth <= reserve1 / 10_000, "{i}");
    }
    // A sale moves the reserve, not the depth, inside its block.
    give_world_tokens(&mut w, CAROL, s, 20_000 * E18, 0);
    sell(&mut w, CAROL, pools[0], 20_000 * E18);
    assert!(w.view(|c| c.pool(pools[0]).amm.reserve1()) < 300_000 * E18);
    assert_eq!(snap(&mut w, s).quotes[0].depth, q[0].depth);
    // Liquidity moves it at once.
    give_world_tokens(&mut w, BOB, s, 10_000 * E18, 40_000 * E18);
    w.call(BOB, ONE_YOCTO, |c| {
        c.add_liquidity(pools[0], U128(10_000 * E18), U128(40_000 * E18), U128(0))
    })
    .unwrap();
    assert!(snap(&mut w, s).quotes[0].depth > q[0].depth);
}

// ---- F4: the borrow side ----

#[test]
fn borrow_uses_the_lower_of_spot_and_twap() {
    let mut w = v2_world();
    let (s, pools) = seed_bin(&mut w);
    w.warp(1_801);
    give_world_tokens(&mut w, CAROL, s, 2_000 * E18, 10_000 * E18);
    // World 0 about 2% down, world 1 about 2% up, both inside the band.
    sell(&mut w, CAROL, pools[0], 1_000 * E18);
    buy(&mut w, CAROL, pools[1], 1_000 * E18);
    let sn = snap(&mut w, s);
    assert_eq!(sn.statuses(), vec![Trusted; 2]);
    let (q0, q1) = (sn.quotes[0], sn.quotes[1]);
    assert!(q0.spot < q0.twap && q1.spot > q1.twap);
    let (b, l) = (
        sn.prices(PriceMode::Borrow),
        sn.prices(PriceMode::Liquidate),
    );
    // After a fall the borrow side follows the spot at once; after a rise it
    // stays at the TWAP. The liquidation side is the TWAP either way.
    assert_eq!(b.prices, vec![q0.spot, q1.twap]);
    assert_eq!(l.prices, vec![q0.twap, q1.twap]);
    assert_eq!((b.priced, b.trusted, b.factor), (0b11, 0b11, WAD));
    assert_eq!(b.max_price, q1.twap.max(q0.spot));
    let view = w.view(|c| c.world_prices(s));
    assert_eq!(view[0].borrow_price.0, q0.spot);
    assert_eq!(view[0].liquidation_price.0, q0.twap);
    assert_eq!(view[1].borrow_price.0, q1.twap);
}

/// What lending relies on for L-5: per world the borrow price is at most
/// the liquidation price and borrow-priced implies liquidation-priced, for
/// every status, window, spot, TWAP, reference ratio, age and haircut. So
/// an account whose borrow-side value covers its debt at `borrow_ltv <=
/// lltv` is never liquidatable in the same block.
fn arb_quote() -> impl Strategy<Value = WorldQuote> {
    (
        0usize..5,
        1u128..=10_000 * E18,
        1u128..=10_000 * E18,
        any::<bool>(),
    )
        .prop_map(|(status, twap, spot, full_window)| WorldQuote {
            status: [NoPool, Young, Shallow, OutOfBand, Trusted][status],
            twap,
            spot,
            mean_tick: None,
            spot_tick: None,
            depth: 0,
            age_sec: 0,
            full_window,
        })
}

fn worst_value(possible: u8, prices: &[u128], wnear: &[u128], usdc: &[u128]) -> u128 {
    (0..prices.len())
        .filter(|w| possible & (1 << w) != 0)
        .map(|w| usdc[w] + mul_div_down(wnear[w], prices[w], WAD))
        .min()
        .unwrap()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn borrow_then_liquidate_same_block_fails(
        quotes in prop::collection::vec(arb_quote(), 8),
        world_count in prop::sample::select(vec![2usize, 4, 8]),
        possible_bits in 1u8..=255,
        checked in any::<bool>(),
        ratio in 0u128..=3 * E18,
        age in 0u64..=4_000,
        haircut in 0u128..=E18 / 2,
        deviation in E18 / 100..=E18 / 2,
        wnear in prop::collection::vec(0u128..=1_000_000 * E18, 8),
        usdc in prop::collection::vec(0u128..=1_000_000 * E18, 8),
        lltv in E18 / 10..=E18,
        gap in 0u128..=E18 / 5,
    ) {
        let possible = possible_bits & ((1u16 << world_count) - 1) as u8;
        prop_assume!(possible != 0);
        let check = if checked {
            RefCheck::Checked {
                reference: ratio,
                implied: WAD,
                ratio,
                age_sec: age,
                borrow_max_age_sec: 3_600,
                liquidation_max_age_sec: 300,
            }
        } else {
            RefCheck::Off
        };
        let sn = PriceSnapshot {
            scenario_id: 1,
            possible,
            cfg: MarketPriceCfg {
                max_haircut: U128(haircut),
                max_deviation: U128(deviation),
                ..MarketPriceCfg::V2
            },
            quotes: quotes[..world_count].to_vec(),
            check,
        };
        let (b, l) = (sn.prices(PriceMode::Borrow), sn.prices(PriceMode::Liquidate));
        let (f_b, f_l) = sn.factors();
        prop_assert!(f_b <= f_l && f_l <= WAD && f_l >= WAD - haircut);
        prop_assert_eq!(b.priced & !l.priced, 0);
        prop_assert_eq!(b.priced & !possible, 0);
        for w in 0..world_count {
            prop_assert!(b.prices[w] <= l.prices[w]);
        }
        // The largest debt the borrow side allows, then the liquidation side.
        let borrow_ltv = lltv.saturating_sub(gap);
        let c_b = worst_value(possible, &b.prices, &wnear, &usdc);
        let c_l = worst_value(possible, &l.prices, &wnear, &usdc);
        let debt = mul_div_down(c_b, borrow_ltv, WAD);
        prop_assert!(mul_div_down(c_l, lltv, WAD) >= debt);
    }
}

// ---- F5: the liquidation side ----

#[test]
fn out_of_band_full_window_world_stays_liquidatable() {
    let mut w = v2_world();
    let (s, pools) = seed_bin(&mut w);
    w.warp(1_801);
    let twap = snap(&mut w, s).quotes[1].twap;
    give_world_tokens(&mut w, CAROL, s, 40_000 * E18, 0);
    sell(&mut w, CAROL, pools[1], 30_000 * E18);
    let sn = snap(&mut w, s);
    assert_eq!(sn.quotes[1].status, OutOfBand);
    assert!(sn.quotes[1].full_window);
    let (b, l) = (
        sn.prices(PriceMode::Borrow),
        sn.prices(PriceMode::Liquidate),
    );
    // Liquidation goes on at the TWAP the dump did not move; borrowing
    // counts nothing there.
    assert_eq!((l.priced, l.prices[1]), (0b11, twap));
    assert_eq!((b.priced, b.prices[1]), (0b01, 0));
    assert!(w.view(|c| {
        let cfg = c.price_cfg(s);
        c.world_liq_priced_with(s, c.pool(pools[1]), &cfg)
    }));
    // A minute later the TWAP has moved a little towards the dump and the
    // world is still priced at it.
    w.warp(61);
    let sn = snap(&mut w, s);
    let l = sn.prices(PriceMode::Liquidate);
    assert_eq!(sn.quotes[1].status, OutOfBand);
    assert_eq!(l.prices[1], sn.quotes[1].twap);
    assert!(l.prices[1] < twap && l.prices[1] > sn.quotes[1].spot);
}

#[test]
fn out_of_band_young_world_still_pauses() {
    let mut w = v2_world();
    let (s, pools) = seed_bin(&mut w);
    set_cfg(&mut w, s, V1_PRICE_CFG).unwrap();
    w.warp(61);
    give_world_tokens(&mut w, CAROL, s, 40_000 * E18, 0);
    sell(&mut w, CAROL, pools[1], 30_000 * E18);
    let sn = snap(&mut w, s);
    assert_eq!(sn.quotes[1].status, OutOfBand);
    assert!(!sn.quotes[1].full_window);
    assert_eq!(sn.prices(PriceMode::Liquidate).priced, 0b01);
    assert_eq!(sn.prices(PriceMode::Borrow).priced, 0b01);
    assert!(!w.view(|c| {
        let cfg = c.price_cfg(s);
        c.world_liq_priced_with(s, c.pool(pools[1]), &cfg)
    }));
}

#[test]
fn shallow_young_and_missing_worlds_pause() {
    test_hooks::clear();
    let mut w = World::new_v2();
    let s = w.s2x2;
    let p = 3 * E18;
    test_hooks::set_quote(s, 0, quote(p, p, Trusted, true));
    test_hooks::set_quote(s, 1, quote(p, p, Shallow, true));
    test_hooks::set_quote(s, 2, quote(p, p, Young, false));
    test_hooks::set_quote(s, 3, quote(p, p, OutOfBand, false));
    let sn = snap(&mut w, s);
    for mode in [PriceMode::Borrow, PriceMode::Liquidate] {
        let px = sn.prices(mode);
        assert_eq!((px.priced, px.trusted), (0b0001, 0b0001), "{mode:?}");
        assert_eq!(px.prices, vec![p, 0, 0, 0]);
    }
    // Out of band over a full window: the liquidation side only.
    test_hooks::set_quote(s, 3, quote(p, p / 2, OutOfBand, true));
    let sn = snap(&mut w, s);
    assert_eq!(sn.prices(PriceMode::Liquidate).priced, 0b1001);
    assert_eq!(sn.prices(PriceMode::Borrow).priced, 0b0001);
    test_hooks::set_quote(s, 0, quote(0, 0, NoPool, false));
    assert_eq!(snap(&mut w, s).prices(PriceMode::Liquidate).priced, 0b1000);
    // Dead worlds are never priced.
    let spice = w.spice;
    w.admin_resolve(spice, OUT_SHIPS).unwrap();
    let sn = snap(&mut w, s);
    assert_eq!(sn.possible, 0b0101);
    assert_eq!(sn.prices(PriceMode::Liquidate).priced, 0);
    test_hooks::clear();
}

// ---- The reference factor ----

#[test]
fn reference_haircut_needs_a_300s_reference_and_is_capped() {
    let (mut w, s) = quoted_bin(with_reference(MarketPriceCfg::V2));
    // R = 0.5 I: the liquidation side loses the 20% cap, the borrow side half.
    report(&mut w, 2 * E18).unwrap();
    let sn = snap(&mut w, s);
    assert_eq!(sn.factors(), (E18 / 2, 800 * E15));
    let (b, l) = (
        sn.prices(PriceMode::Borrow),
        sn.prices(PriceMode::Liquidate),
    );
    assert_eq!((b.prices.clone(), b.factor), (vec![2 * E18; 2], E18 / 2));
    assert_eq!(
        (l.prices.clone(), l.factor),
        (vec![3_200 * E15; 2], 800 * E15)
    );
    assert_eq!(
        sn.borrow_block(),
        Some(PriceBlock::ReferenceDeviation {
            implied: 4 * E18,
            reference: 2 * E18
        })
    );
    // R = 0.95 I: 5% on both sides.
    w.warp(1);
    report(&mut w, 3_800 * E15).unwrap();
    assert_eq!(snap(&mut w, s).factors(), (950 * E15, 950 * E15));
    assert_eq!(
        snap(&mut w, s).prices(PriceMode::Liquidate).prices,
        vec![3_800 * E15; 2]
    );
    // 300 s old still lowers liquidation prices; 301 s no longer does.
    w.warp(300);
    assert_eq!(snap(&mut w, s).factors(), (950 * E15, 950 * E15));
    w.warp(1);
    assert_eq!(snap(&mut w, s).factors(), (950 * E15, E18));
    assert_eq!(
        snap(&mut w, s).prices(PriceMode::Liquidate).prices,
        vec![4 * E18; 2]
    );
    // A market that allows no haircut ignores the reference on that side.
    report(&mut w, 3_800 * E15).unwrap();
    let no_haircut = MarketPriceCfg {
        max_haircut: U128(0),
        ..with_reference(MarketPriceCfg::V2)
    };
    set_cfg(&mut w, s, no_haircut).unwrap();
    assert_eq!(snap(&mut w, s).factors(), (950 * E15, E18));
    // With the switch off both sides are plain.
    set_cfg(&mut w, s, MarketPriceCfg::V2).unwrap();
    let sn = snap(&mut w, s);
    assert_eq!(
        (sn.check.clone(), sn.factors()),
        (RefCheck::Off, (E18, E18))
    );
    let check = w.view(|c| c.price_check(s));
    assert_eq!(
        (check.borrow_factor.0, check.liquidation_factor.0),
        (E18, E18)
    );
    assert_eq!(check.ratio, Some(U128(950 * E15)));
    test_hooks::clear();
}

#[test]
fn guard_pauses_liquidation_when_the_pools_sit_far_below_the_reference() {
    let (mut w, s) = quoted_bin(with_reference(MarketPriceCfg::V2));
    // Pools 10.00% below the reference: allowed.
    report(&mut w, 4_400 * E15).unwrap();
    let sn = snap(&mut w, s);
    assert_eq!((sn.liquidation_guard(), sn.borrow_block()), (None, None));
    // 10.25% below: liquidation waits, borrowing stops, no price is raised.
    w.warp(1);
    report(&mut w, 4_410 * E15).unwrap();
    let sn = snap(&mut w, s);
    let guard = sn.liquidation_guard().unwrap();
    assert_eq!(
        guard.error(),
        "ReferenceGuard(4000000000000000000, 4410000000000000000)"
    );
    assert_eq!(
        sn.borrow_block().unwrap().error(),
        "ReferenceDeviation(4000000000000000000, 4410000000000000000)"
    );
    assert_eq!(sn.factors(), (E18, E18));
    assert!(w.view(|c| c.price_check(s)).liquidation_guard);
    // A reference too old for liquidation no longer guards.
    w.warp(301);
    let sn = snap(&mut w, s);
    assert_eq!(sn.liquidation_guard(), None);
    assert!(sn.borrow_block().is_some());
    test_hooks::clear();
}

// ---- PRC-1: the snapshot and the views write nothing ----

#[test]
fn snapshot_is_pure() {
    let mut w = v2_world();
    let (s, _) = seed_bin(&mut w);
    configure(&mut w, reporter_only()).unwrap();
    set_cfg(&mut w, s, with_reference(MarketPriceCfg::V2)).unwrap();
    w.warp(1_801);
    report(&mut w, 3_200 * E15).unwrap();
    let out = w
        .exec(ALICE, NO_DEPOSIT, vec![], |c| {
            let root = near_sdk::borsh::to_vec(&*c).unwrap();
            let reference = c.reference_state();
            let usage = env::storage_usage();
            let sn = c.price_snapshot(s);
            let _ = (
                sn.prices(PriceMode::Borrow),
                sn.prices(PriceMode::Liquidate),
            );
            let _ = (c.world_prices(s), c.price_check(s), c.get_reference());
            let _ = (c.get_pool(1), c.get_market_price_config(s));
            c.flush_state();
            (
                root == near_sdk::borsh::to_vec(&*c).unwrap(),
                reference == c.reference_state(),
                usage == env::storage_usage(),
                sn.check,
            )
        })
        .unwrap();
    assert!(out.0 && out.1 && out.2);
    assert!(matches!(out.3, RefCheck::Checked { .. }), "{:?}", out.3);
    assert!(w.last.logs.is_empty() && w.last.receipts.is_empty());
}

// ---- Config setters ----

#[test]
fn price_config_setters_check_the_owner_and_the_bounds() {
    let mut w = World::new_v2();
    let set_default = |w: &mut World, who: &str, cfg: MarketPriceCfg| {
        w.call(who, ONE_YOCTO, |c| c.set_default_price_config(cfg))
    };
    fails(
        set_default(&mut w, ALICE, MarketPriceCfg::V2),
        "NotOwner(alice.near)",
    );
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.set_market_price_config(1, MarketPriceCfg::V2)
        }),
        "NotOwner(alice.near)",
    );
    fails(
        set_cfg(&mut w, 99, MarketPriceCfg::V2),
        "UnknownScenario(99)",
    );
    let v2 = MarketPriceCfg::V2;
    let bad = [
        (
            MarketPriceCfg {
                min_age_sec: 59,
                ..v2
            },
            "min_age_sec",
        ),
        (
            MarketPriceCfg {
                min_age_sec: 1_801,
                ..v2
            },
            "min_age_sec",
        ),
        (
            MarketPriceCfg {
                min_depth: U128(E18 - 1),
                ..v2
            },
            "min_depth",
        ),
        (
            MarketPriceCfg {
                min_depth: U128(1_000_000_000_000 * E18 + 1),
                ..v2
            },
            "min_depth",
        ),
        (
            MarketPriceCfg {
                max_deviation: U128(E18 / 100 - 1),
                ..v2
            },
            "max_deviation",
        ),
        (
            MarketPriceCfg {
                max_deviation: U128(E18 / 2 + 1),
                ..v2
            },
            "max_deviation",
        ),
        (
            MarketPriceCfg {
                max_haircut: U128(E18 / 2 + 1),
                ..v2
            },
            "max_haircut",
        ),
    ];
    let s = w.s_bin;
    for (cfg, field) in bad {
        let error = format!("BadPriceConfig({field})");
        fails(set_default(&mut w, OWNER, cfg), &error);
        fails(set_cfg(&mut w, s, cfg), &error);
    }
    let edges = [
        MarketPriceCfg {
            min_age_sec: 60,
            min_depth: U128(E18),
            max_deviation: U128(E18 / 100),
            max_haircut: U128(0),
            ..v2
        },
        MarketPriceCfg {
            min_age_sec: 1_800,
            min_depth: U128(1_000_000_000_000 * E18),
            max_deviation: U128(E18 / 2),
            max_haircut: U128(E18 / 2),
            ..v2
        },
    ];
    for cfg in edges {
        set_default(&mut w, OWNER, cfg).unwrap();
        set_cfg(&mut w, s, cfg).unwrap();
        assert_eq!(w.view(|c| c.get_market_price_config(s)), cfg);
    }
    fails(
        w.try_view(|c| c.get_market_price_config(99)),
        "UnknownScenario(99)",
    );
}

#[test]
fn the_default_config_applies_to_scenarios_created_later() {
    let mut w = World::new_v2();
    let s = w.s_bin;
    let new_default = with_reference(V1_PRICE_CFG);
    w.call(OWNER, ONE_YOCTO, |c| {
        c.set_default_price_config(new_default)
    })
    .unwrap();
    assert_eq!(
        w.last.data_of("price_config_set"),
        vec![json!({
            "scenario_id": null, "min_age_sec": 60, "min_depth": "10000000000000000000000",
            "reference": true, "max_deviation": "100000000000000000", "max_haircut": "0",
        })]
    );
    assert_eq!(w.view(|c| c.get_default_price_config()), new_default);
    assert_eq!(w.view(|c| c.get_market_price_config(s)), MarketPriceCfg::V2);
    let fed = w.fed;
    let created = w.create_scenario(&[fed]).unwrap();
    assert_eq!(w.view(|c| c.get_market_price_config(created)), new_default);
    set_cfg(&mut w, s, V1_PRICE_CFG).unwrap();
    assert_eq!(
        w.last.data_of("price_config_set")[0]["scenario_id"],
        json!(s)
    );
    assert_eq!(w.view(|c| c.get_market_price_config(s)), V1_PRICE_CFG);
}

/// PRC-6: while a market has debt, only changes that never lower a
/// liquidation price pass.
#[test]
fn config_changes_with_debt() {
    let mut w = lending_world(100_000 * E18);
    let s = w.s2x2;
    let base = MarketPriceCfg {
        max_haircut: U128(E18 / 5),
        ..with_reference(V1_PRICE_CFG)
    };
    set_cfg(&mut w, s, base).unwrap();
    test_hooks::set_odds(s, vec![E18 / 4; 4]);
    configure(&mut w, reporter_only()).unwrap();
    report(&mut w, 3_125 * E15).unwrap();
    w.post_real(ALICE, s, Wnear, 10_000 * E18).unwrap();
    w.borrow(ALICE, s, 15_000 * E18).unwrap();
    assert!(w.view(|c| c.has_debt(s)));
    let locked = format!("PriceConfigLocked({s})");
    // The bounds come first.
    fails(
        set_cfg(
            &mut w,
            s,
            MarketPriceCfg {
                min_age_sec: 59,
                ..base
            },
        ),
        "BadPriceConfig(min_age_sec)",
    );
    // A higher haircut, a younger pool or a thinner pool could lower or
    // restore a liquidation price.
    for cfg in [
        MarketPriceCfg {
            max_haircut: U128(E18 / 4),
            ..base
        },
        MarketPriceCfg {
            min_depth: U128(9_000 * E18),
            ..base
        },
    ] {
        fails(set_cfg(&mut w, s, cfg), &locked);
    }
    // These never lower one.
    let mut cfg = base;
    let changes: [fn(&mut MarketPriceCfg); 6] = [
        |c: &mut MarketPriceCfg| c.max_deviation = U128(E18 * 3 / 10),
        |c: &mut MarketPriceCfg| c.max_deviation = U128(E18 / 20),
        |c: &mut MarketPriceCfg| c.max_haircut = U128(E18 / 10),
        |c: &mut MarketPriceCfg| c.min_depth = U128(20_000 * E18),
        |c: &mut MarketPriceCfg| c.min_age_sec = 120,
        |c: &mut MarketPriceCfg| c.reference = false,
    ];
    for change in changes {
        change(&mut cfg);
        set_cfg(&mut w, s, cfg).unwrap();
        assert_eq!(w.view(|c| c.get_market_price_config(s)), cfg);
    }
    for back in [
        MarketPriceCfg {
            reference: true,
            ..cfg
        },
        MarketPriceCfg {
            min_age_sec: 60,
            ..cfg
        },
        MarketPriceCfg {
            max_haircut: U128(E18 / 5),
            ..cfg
        },
    ] {
        fails(set_cfg(&mut w, s, back), &locked);
    }
    // Another scenario without debt takes anything; so does this one once
    // the debt is repaid.
    let b = w.s_bin;
    set_cfg(&mut w, b, with_reference(MarketPriceCfg::V2)).unwrap();
    w.repay_ft(ALICE, s, 16_000 * E18, true).unwrap();
    assert!(!w.view(|c| c.has_debt(s)));
    set_cfg(&mut w, s, base).unwrap();
    test_hooks::clear();
}

// ---- Views ----

#[test]
fn price_views_have_their_keys() {
    let mut w = v2_world();
    let (s, _) = seed_bin(&mut w);
    w.warp(1_801);
    configure(&mut w, reporter_only()).unwrap();
    report(&mut w, 3_200 * E15).unwrap();
    let keys = |v: &Value| -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    let rows = serde_json::to_value(w.view(|c| c.world_prices(s))).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 2);
    assert_eq!(
        keys(&rows[0]),
        [
            "age_sec",
            "borrow_price",
            "depth",
            "full_window",
            "liquidation_price",
            "spot",
            "status",
            "twap",
            "world"
        ]
    );
    assert_eq!(
        (rows[1]["world"].clone(), rows[1]["status"].clone()),
        (json!(1), json!("trusted"))
    );
    let check = serde_json::to_value(w.view(|c| c.price_check(s))).unwrap();
    assert_eq!(
        keys(&check),
        [
            "borrow_block",
            "borrow_factor",
            "config",
            "implied_twap_spot",
            "liquidation_factor",
            "liquidation_guard",
            "ratio",
            "reference",
            "scenario_id"
        ]
    );
    assert_eq!(
        keys(&check["config"]),
        [
            "max_deviation",
            "max_haircut",
            "min_age_sec",
            "min_depth",
            "reference"
        ]
    );
    assert_eq!(
        keys(&check["reference"]),
        [
            "age_sec",
            "observed_at",
            "price",
            "source",
            "sources_used",
            "spread_bps"
        ]
    );
    assert_eq!(check["reference"]["source"], "reporter");
    // The market does not use the reference: plain factors, no block, but
    // the implied spot and the ratio are shown.
    assert_eq!(check["borrow_block"], Value::Null);
    assert_eq!(check["borrow_factor"], "1000000000000000000");
    let implied: u128 = check["implied_twap_spot"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    // 2/3 x 3.40 + 1/3 x 2.80 = 3.20, at floored TWAP prices.
    assert!(implied > 3_190 * E15 && implied < 3_210 * E15, "{implied}");
    let defaults = serde_json::to_value(w.view(|c| c.get_default_price_config())).unwrap();
    assert_eq!(
        defaults,
        json!({"min_age_sec": 1800, "min_depth": "50000000000000000000000", "reference": false,
               "max_deviation": "100000000000000000", "max_haircut": "200000000000000000"})
    );
    // Without a stored reference there is none to show.
    let mut fresh = v2_world();
    let (s, _) = seed_bin(&mut fresh);
    let check = fresh.view(|c| c.price_check(s));
    assert_eq!((check.reference, check.ratio), (None, None));
}

// ---- Cost ----

/// Odds of three independent events (SPICE 2/3, Fed cut 1/100, a third at
/// 1/2), summing to exactly 1e18.
fn odds_8() -> Vec<u128> {
    let p = [6_667u128, 100, 5_000];
    let mut q: Vec<u128> = (0..8usize)
        .map(|w| {
            (0..3).fold(E18, |acc, k| {
                let bps = if w & (1 << k) == 0 {
                    p[k]
                } else {
                    10_000 - p[k]
                };
                acc * bps / 10_000
            })
        })
        .collect();
    let rest = E18 - q[..7].iter().sum::<u128>();
    q[7] = rest;
    q
}

/// Gas of one snapshot in the mocked runtime (its host-function cost: the
/// pool and key reads), with both price vectors and both reference checks.
fn snapshot_gas(w: &mut World, s: u64) -> u64 {
    w.view(|c| {
        let before = env::used_gas().as_gas();
        let sn = c.price_snapshot(s);
        let _ = (
            sn.prices(PriceMode::Borrow),
            sn.prices(PriceMode::Liquidate),
        );
        let _ = (sn.borrow_block(), sn.liquidation_guard());
        env::used_gas().as_gas() - before
    })
}

#[test]
fn price_snapshot_gas() {
    let mut w = v2_world();
    let (spice, fed) = (w.spice, w.fed);
    let third = w
        .create_event(
            "Will the third event happen?",
            &["YES", "NO"],
            "YES if it happens; otherwise NO.",
            T0 + 50 * DAY,
        )
        .unwrap();
    let s4 = w.s2x2;
    let s8 = w.create_scenario(&[spice, fed, third]).unwrap();
    seed_worlds(&mut w, s4, &DEMO_2X2, &[DEPTH; 4]);
    seed_odds(&mut w, s4, &independent_odds(4, 6_667, 100), ODDS_DEPTH);
    let prices8: Vec<u128> = DEMO_2X2.iter().chain(DEMO_2X2.iter()).copied().collect();
    seed_worlds(&mut w, s8, &prices8, &[DEPTH; 8]);
    seed_odds(&mut w, s8, &odds_8(), ODDS_DEPTH);
    w.warp(1_801);
    configure(&mut w, reporter_only()).unwrap();
    report(&mut w, 3_000 * E15).unwrap();
    let mut measured = Vec::new();
    for (s, worlds) in [(s4, 4), (s8, 8)] {
        let off = snapshot_gas(&mut w, s);
        set_cfg(&mut w, s, with_reference(MarketPriceCfg::V2)).unwrap();
        let sn = snap(&mut w, s);
        assert!(
            matches!(sn.check, RefCheck::Checked { .. }),
            "{:?}",
            sn.check
        );
        let on = snapshot_gas(&mut w, s);
        measured.push((worlds, off, on));
        assert!(on > off);
    }
    println!("price_snapshot gas (worlds, off, on): {measured:?}");
    // Measured here (2026-11-14): 4 worlds 0.70 / 1.27 Tgas, 8 worlds 1.27 /
    // 2.40 Tgas with the reference off / on, where SPEC-C 7 estimated 1.2 /
    // 2.3 at 8 worlds. Pinned 10% above, so a growth is a reviewed change;
    // the sandbox gate (`measure.ts`) re-measures the wasm.
    let budgets = [
        (4, 775_000_000_000, 1_395_000_000_000),
        (8, 1_400_000_000_000, 2_640_000_000_000),
    ];
    for ((worlds, off, on), (n, off_max, on_max)) in measured.into_iter().zip(budgets) {
        assert_eq!(worlds, n);
        assert!(
            off <= off_max && on <= on_max,
            "{worlds} worlds: {off} {on}"
        );
    }
}

// ---- Migrate step 8 on production's state ----

mod migration {
    use multiverse_math::price;

    use super::super::harness::fails;
    use super::super::migration::{migrated_prod, prod_account, prod_args, Prod, PROD_CONTRACT};
    use crate::amm::{Pool, MAX_SPOT_TWAP_TICKS};
    use crate::prices::MarketPriceCfg;
    use crate::types::{Params, WAD};
    use crate::StorageKey;
    use near_sdk::borsh::{self, BorshDeserialize};
    use near_sdk::IntoStorageKey;

    /// v1's lending price of a pool at `now`, written out independently of
    /// the contract: the mean tick behind 60 s of history, the band, then the
    /// depth gate on the current USDC reserve.
    fn v1_price(pool: &Pool, now: u64, params: &Params) -> (u128, bool) {
        let Some(first) = pool.twap.observations().next().map(|o| o.timestamp) else {
            return (0, false);
        };
        let window = params.twap_window_sec.min(now - first);
        if window < 60 {
            return (0, false);
        }
        let Some(mean) = pool.twap.mean_tick(now, window) else {
            return (0, false);
        };
        let latest = pool.twap.latest().unwrap().tick;
        if (i64::from(latest) - i64::from(mean)).abs() > i64::from(MAX_SPOT_TWAP_TICKS)
            || pool.amm.reserve1() < params.min_pool_depth
        {
            return (0, false);
        }
        match price::wnear_price_at_tick(mean, true) {
            Some(p) => (p, true),
            None => (0, false),
        }
    }

    /// P-7 / R16: every world of scenarios 1-6 is trusted exactly where v1
    /// priced it, at the same price; each legacy config is v1's gates, the
    /// default is v2's; Carl's health and status are v1's.
    #[test]
    fn prices_are_unchanged() {
        let mut args = prod_args();
        args.pause = Some(vec![]);
        let mut p = Prod::from_snapshot();
        p.migrate(&prod_account(PROD_CONTRACT), args).unwrap();
        let now = p.now_sec();
        let params = p.view(|c| c.params.clone());
        let mut trusted = 0;
        for sid in 1..=6u64 {
            assert_eq!(
                p.view(|c| c.prices.configs.get(&sid).copied()),
                Some(MarketPriceCfg::v1(&params)),
                "{sid}"
            );
            let rows = p.view(|c| c.world_prices(sid));
            for row in rows {
                let pool = p.view(|c| c.world_pool(sid, row.world).map(|id| c.pool(id).clone()));
                let (v1, v1_ok) = pool.map_or((0, false), |pool| v1_price(&pool, now, &params));
                assert_eq!(
                    row.status == crate::prices::WorldStatus::Trusted,
                    v1_ok,
                    "{sid}/{}",
                    row.world
                );
                if v1_ok {
                    trusted += 1;
                    assert_eq!(row.twap.0, v1, "{sid}/{}", row.world);
                    let possible = p.view(|c| c.scenario(sid).possible);
                    if possible & (1 << row.world) != 0 {
                        assert_eq!(row.liquidation_price.0, v1, "{sid}/{}", row.world);
                    }
                }
                assert_eq!(
                    p.view(|c| c.world_price(sid, row.world)),
                    (if v1_ok { v1 } else { 0 }, v1_ok)
                );
            }
        }
        // Every one of production's 18 world pools is deep,
        // old and in band.
        assert_eq!(trusted, 18);
        assert_eq!(p.view(|c| c.get_default_price_config()), MarketPriceCfg::V2);
        // Carl, the one borrower: HF 0.951869, liquidatable already under v1.
        let carl = prod_account("carl");
        let hf = p
            .view(|c| c.health_factor(1, carl.clone(), None))
            .health_factor
            .unwrap()
            .0;
        assert!(
            hf > 951_000 * WAD / 1_000_000 && hf < 952_000 * WAD / 1_000_000,
            "{hf}"
        );
        let status =
            near_sdk::serde_json::to_value(p.view(|c| c.liquidation_status(1, carl, None)))
                .unwrap();
        assert_eq!(status["status"], "liquidatable");
    }

    /// C22: a legacy world with debt that v2 would price differently (here
    /// pool 4, Carl's world 3, pushed out of band in the block before)
    /// reverts the upgrade.
    #[test]
    fn migrate_refuses_a_legacy_world_with_debt_pushed_out_of_band() {
        let mut p = Prod::from_snapshot();
        let mut key = StorageKey::Pools.into_storage_key();
        key.extend_from_slice(&4u64.to_le_bytes());
        let mut pool = Pool::try_from_slice(&p.storage[&key]).unwrap();
        let now = p.now_sec();
        let tick = pool.twap.latest().unwrap().tick;
        pool.twap.write(now, tick - 2 * MAX_SPOT_TWAP_TICKS);
        p.storage.insert(key, borsh::to_vec(&pool).unwrap());
        fails(
            p.migrate(&prod_account(PROD_CONTRACT), prod_args()),
            "MigratePriceMismatch(1, 3)",
        );
        // The untouched snapshot migrates, Carl's world priced as before.
        let mut p = migrated_prod();
        assert!(p.view(|c| c.world_price(1, 3)).1);
    }
}
