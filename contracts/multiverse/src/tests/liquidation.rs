//! Liquidation: amendment 8 sizing (one fraction of
//! every piece), the close factor and dust rule, both pauses, gaps below the
//! repayment, plus the NEAR side of the `liquidate` action (refunds, what
//! the liquidator receives, the status view).
//!
//! Bob supplies 1,000,000 USDC; carol liquidates with USDC from her wallet.
//! A price crash is a change in the test price table rather than a swap.

use proptest::prelude::*;

use super::harness::*;
use super::lending::*;
use crate::amm::test_hooks;
use crate::lending::{check_liquidation_bonus, CollateralKey, Liquidation, LiquidationState};
use crate::prices::WorldStatus;
use crate::types::Asset::{Usdc, Wnear};
use multiverse_math::risk::liquidation_target;
use multiverse_math::{mul_div_down, mul_div_up};

const LIQ: &str = CAROL;
const C_USDC: [u128; 4] = [1_700 * E18, 1_500 * E18, 1_600 * E18, 1_300 * E18];
const PRICE_UNIT: u128 = E18;

fn liq_world() -> World {
    lending_world(1_000_000 * E18)
}

/// Real USDC `min(c)` plus, per world above it, USDC-if-w for the rest:
/// collateral worth exactly `c[w]` at any price.
fn post_usdc_worlds(w: &mut World, who: &str, sid: u64, c: [u128; 4]) {
    let min = *c.iter().min().unwrap();
    w.post_real(who, sid, Usdc, min).unwrap();
    for (wd, value) in c.iter().enumerate() {
        if *value > min {
            let single = 1u8 << wd;
            w.split_ft(who, sid, Usdc, &[single, ROOT ^ single], value - min)
                .unwrap();
            w.post(who, sid, &token_id(sid, Usdc, single), value - min)
                .unwrap();
        }
    }
}

/// Warps until the health factor has decayed just below `t` by interest.
fn age_to(w: &mut World, sid: u64, who: &str, t: u128) {
    let debt = w.debt(sid, who);
    let hf = w.hf(sid, who).0.unwrap();
    let target = mul_div_down(debt, hf, t);
    let secs = mul_div_down(target - debt, E18, debt * RATE) + 1;
    w.warp(u64::try_from(secs).unwrap());
    let after = w.hf(sid, who).0.unwrap();
    assert!(after < E18, "aged to {after}");
}

fn borrow_near_max(w: &mut World, sid: u64, who: &str) -> u128 {
    let lowest = w.lowest(sid, who);
    let amount = mul_div_down(lowest * 995, LLTV, E18 * 1_000);
    w.borrow(who, sid, amount).unwrap();
    amount
}

/// C = 1,700 / 1,500 / 1,600 / 1,300, borrow 974, aged to HF 0.975 (debt ~1,000).
fn unhealthy_usdc_loan(w: &mut World) {
    let s = w.s2x2;
    post_usdc_worlds(w, ALICE, s, C_USDC);
    w.borrow(ALICE, s, 974 * E18).unwrap();
    age_to(w, s, ALICE, 975_000_000_000_000_000);
}

/// L-shape + 500 real wNEAR + 200 real USDC + 300 wNEAR-if-HOLDS: 7 pieces.
fn mixed_loan(w: &mut World) {
    let s = w.s2x2;
    w.l_shape(ALICE);
    w.post_real(ALICE, s, Wnear, 500 * E18).unwrap();
    w.post_real(ALICE, s, Usdc, 200 * E18).unwrap();
    w.split_ft(ALICE, s, Wnear, &[HOLDS, CUTS], 300 * E18)
        .unwrap();
    w.post(ALICE, s, &token_id(s, Wnear, HOLDS), 300 * E18)
        .unwrap();
    assert_eq!(w.pieces(s, ALICE).len(), 7);
    borrow_near_max(w, s, ALICE);
    age_to(w, s, ALICE, 980_000_000_000_000_000);
}

/// 1,000 real wNEAR, borrowed near the max, then world 3 crashes to 1/16 of 2.50.
fn crashed_wnear_loan(w: &mut World) {
    let s = w.s2x2;
    w.post_real(ALICE, s, Wnear, 1_000 * E18).unwrap();
    borrow_near_max(w, s, ALICE);
    set_price(s, 3, PRICES_2X2[3] / 16);
}

pub fn price_of(sid: u64, world: u8) -> (u128, bool) {
    match test_hooks::quote(sid, world) {
        Some(q) if q.status == WorldStatus::Trusted => (q.twap, true),
        _ => (0, false),
    }
}

/// The seized slice valued in every world, independently of the contract:
/// USDC at par, wNEAR at the world price, 0 outside a piece's worlds or for
/// worlds that can no longer happen.
pub fn slice_value(
    w: &mut World,
    sid: u64,
    pieces: &[CollateralKey],
    seized: &[u128],
) -> Vec<u128> {
    let s = w.view(|c| c.get_scenario(sid));
    (0..s.world_count)
        .map(|wd| {
            if s.possible & (1 << wd) == 0 {
                return 0;
            }
            pieces
                .iter()
                .zip(seized)
                .filter(|(k, _)| k.mask(s.root) & (1 << wd) != 0)
                .map(|(k, a)| match k.asset() {
                    Usdc => *a,
                    Wnear => {
                        let (p, ok) = price_of(sid, wd);
                        if ok {
                            mul_div_down(*a, p, E18)
                        } else {
                            0
                        }
                    }
                })
                .sum()
        })
        .collect()
}

struct Done {
    liq: Liquidation,
    target: u128,
    c_min: u128,
    debt: u128,
    hf_before: u128,
    hf_after: Option<u128>,
    slice: Vec<u128>,
    possible: u8,
}

impl Done {
    fn worst_slice(&self) -> u128 {
        (0..self.slice.len())
            .filter(|wd| self.possible & (1 << wd) != 0)
            .map(|wd| self.slice[wd])
            .min()
            .unwrap()
    }

    #[track_caller]
    fn assert_covers(&self) {
        for (wd, v) in self.slice.iter().enumerate() {
            if self.possible & (1 << wd) != 0 {
                assert!(
                    *v >= self.liq.repaid,
                    "world {wd}: slice {v} < repaid {}",
                    self.liq.repaid
                );
            }
        }
    }
}

/// Liquidates and checks the sizing rule piece by piece, what is left, and
/// what the liquidator received.
fn liquidate_in(w: &mut World, sid: u64, account: &str, repay: Option<u128>) -> Done {
    let held = w.pieces(sid, account);
    let c_min = w.lowest(sid, account);
    let debt = w.debt(sid, account);
    let hf_before = w.hf(sid, account).0.unwrap();
    let usdc_before = w.usdc_total(LIQ);
    let wnear_before = w.real(LIQ, Wnear);
    let verse_before: Vec<u128> = held
        .iter()
        .map(|(p, _)| match CollateralKey::parse(sid, p).unwrap() {
            CollateralKey::Verse { asset, mask } => w.bal(LIQ, sid, asset, mask),
            CollateralKey::Real(_) => 0,
        })
        .collect();
    let liq = w.liquidate(LIQ, sid, account, repay).unwrap();
    let target = liquidation_target(liq.repaid, BONUS);
    assert_eq!(liq.pieces.len(), held.len());
    let mut usdc_seized = 0;
    for (i, (piece, amount)) in held.iter().enumerate() {
        let key = CollateralKey::parse(sid, piece).unwrap();
        assert_eq!(liq.pieces[i], key, "pre-liquidation order");
        let expected = if target >= c_min {
            *amount
        } else {
            mul_div_down(*amount, target, c_min)
        };
        assert_eq!(liq.seized[i], expected, "piece {piece}");
        assert_eq!(w.held(sid, account, piece), amount - expected);
        match key {
            CollateralKey::Verse { asset, mask } => {
                assert_eq!(w.bal(LIQ, sid, asset, mask), verse_before[i] + expected);
            }
            CollateralKey::Real(Wnear) => assert_eq!(w.real(LIQ, Wnear), wnear_before + expected),
            CollateralKey::Real(Usdc) => usdc_seized = expected,
        }
    }
    assert_eq!(w.usdc_total(LIQ) + liq.repaid, usdc_before + usdc_seized);
    let slice = slice_value(w, sid, &liq.pieces, &liq.seized);
    let hf_after = w.hf(sid, account).0;
    let possible = w.possible(sid);
    Done {
        liq,
        target,
        c_min,
        debt,
        hf_before,
        hf_after,
        slice,
        possible,
    }
}

#[test]
fn liquidate_fails_while_healthy() {
    let mut w = liq_world();
    let s = w.s2x2;
    w.post_real(ALICE, s, Usdc, 1_300 * E18).unwrap();
    w.borrow(ALICE, s, 900 * E18).unwrap();
    let hf = hf_of(1_300 * E18, 900 * E18);
    fails(
        w.liquidate(LIQ, s, ALICE, Some(E18)),
        &format!("NotLiquidatable({hf})"),
    );
    fails(
        w.liquidate(LIQ, s, BOB, Some(E18)),
        &format!("NotLiquidatable({})", u128::MAX),
    );
}

#[test]
fn liquidate_fails_above_the_close_factor() {
    let mut w = liq_world();
    let s = w.s2x2;
    unhealthy_usdc_loan(&mut w);
    let max_repay = w.debt(s, ALICE) / 2;
    fails(
        w.liquidate(LIQ, s, ALICE, Some(max_repay + 1)),
        &format!("AboveCloseFactor({}, {max_repay})", max_repay + 1),
    );
    let done = liquidate_in(&mut w, s, ALICE, Some(max_repay));
    assert_eq!(done.liq.repaid, max_repay);
}

#[test]
fn liquidate_fails_on_zero_amount() {
    let mut w = liq_world();
    let s = w.s2x2;
    unhealthy_usdc_loan(&mut w);
    fails(w.liquidate(LIQ, s, ALICE, Some(0)), "ZeroAmount");
}

#[test]
fn liquidate_fails_on_unknown_scenario() {
    let mut w = liq_world();
    fails(
        w.liquidate(LIQ, 999, ALICE, Some(E18)),
        "UnknownScenario(999)",
    );
}

#[test]
fn liquidate_fails_on_dust() {
    let mut w = liq_world();
    let s = w.s2x2;
    mixed_loan(&mut w);
    let max_price = PRICES_2X2[0];
    let smallest = 20 * 7 * (max_price / PRICE_UNIT + 2);
    // 3.70 USDC per wNEAR counts as 3 whole USDC per unit: 20 * 7 * 5
    assert_eq!(smallest, 700);
    fails(
        w.liquidate(LIQ, s, ALICE, Some(1)),
        "LiquidationTooSmall(1)",
    );
    fails(
        w.liquidate(LIQ, s, ALICE, Some(smallest - 20)),
        &format!("LiquidationTooSmall({})", smallest - 20),
    );
    let done = liquidate_in(&mut w, s, ALICE, Some(smallest));
    done.assert_covers();
}

#[test]
fn liquidate_cuts_every_piece_by_the_worst_world() {
    let mut w = liq_world();
    let s = w.s2x2;
    mixed_loan(&mut w);
    let repay = w.debt(s, ALICE) * 2 / 5;
    let done = liquidate_in(&mut w, s, ALICE, Some(repay));
    assert_eq!(done.liq.repaid, repay);
    assert_eq!(done.liq.pieces.len(), 7);
    assert!(done.target < done.c_min);
    done.assert_covers();
    let worst = done.worst_slice();
    assert!(worst <= done.target && done.target <= worst + 7 * 3_702);
    assert!(done.hf_after.unwrap() > done.hf_before);
    assert!(done.liq.shares > 0);
    let log = &w.last.data_of("liquidate")[0];
    assert_eq!(log["scenario_id"], s);
    assert_eq!(log["account_id"], ALICE);
    assert_eq!(log["liquidator_id"], LIQ);
    assert_eq!(log["repaid"], repay.to_string());
    assert_eq!(log["shares"], done.liq.shares.to_string());
    let pieces: Vec<String> = done.liq.pieces.iter().map(|k| k.piece_id(s)).collect();
    assert_eq!(log["pieces"], near_sdk::serde_json::json!(pieces));
    assert_eq!(log["c_min"], done.c_min.to_string());
}

#[test]
fn liquidate_raises_the_health_factor() {
    let mut w = liq_world();
    let s = w.s2x2;
    unhealthy_usdc_loan(&mut w);
    let repay = w.debt(s, ALICE) / 4;
    let done = liquidate_in(&mut w, s, ALICE, Some(repay));
    done.assert_covers();
    assert!(done.hf_after.unwrap() > done.hf_before);
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, failure_persistence: None, ..ProptestConfig::default() })]

    #[test]
    fn fuzz_liquidate_raises_hf_above_the_bonus_ratio(hf_seed in any::<u64>(), repay_seed in any::<u128>()) {
        let mut w = liq_world();
        let s = w.s2x2;
        post_usdc_worlds(&mut w, ALICE, s, C_USDC);
        w.borrow(ALICE, s, 974 * E18).unwrap();
        let hf = 800_000_000_000_000_000 + u128::from(hf_seed) % 190_000_000_000_000_001;
        age_to(&mut w, s, ALICE, hf);
        let debt = w.debt(s, ALICE);
        let (lo, hi) = (debt / 100, debt / 2);
        let repay = lo + repay_seed % (hi - lo + 1);
        let done = liquidate_in(&mut w, s, ALICE, Some(repay));
        done.assert_covers();
        prop_assert!(done.hf_after.unwrap() > done.hf_before);
    }

    #[test]
    fn fuzz_liquidate_repeated_rounds_do_not_spiral(hf_seed in any::<u64>(), fraction_seed in any::<u64>()) {
        let mut w = liq_world();
        let s = w.s2x2;
        post_usdc_worlds(&mut w, ALICE, s, C_USDC);
        w.borrow(ALICE, s, 974 * E18).unwrap();
        let hf = 850_000_000_000_000_000 + u128::from(hf_seed) % 140_000_000_000_000_001;
        age_to(&mut w, s, ALICE, hf);
        let fraction = 100_000_000_000_000_000 + u128::from(fraction_seed) % 400_000_000_000_000_001;
        let mut rounds = 0;
        loop {
            let (hf, _) = w.hf(s, ALICE);
            let hf = hf.unwrap();
            if hf >= E18 {
                fails(w.liquidate(LIQ, s, ALICE, Some(E18)), &format!("NotLiquidatable({hf})"));
                break;
            }
            let debt = w.debt(s, ALICE);
            let repay = mul_div_down(debt, fraction, E18).min(debt / 2);
            let done = liquidate_in(&mut w, s, ALICE, Some(repay));
            done.assert_covers();
            prop_assert!(done.hf_after.unwrap() > done.hf_before);
            rounds += 1;
            prop_assert!(rounds <= 20);
        }
    }
}

#[test]
fn liquidate_gap_below_the_repayment_takes_everything() {
    let mut w = liq_world();
    let s = w.s2x2;
    crashed_wnear_loan(&mut w);
    let done = liquidate_in(&mut w, s, ALICE, None);
    assert!(done.target >= done.c_min);
    assert_eq!(done.liq.seized, vec![1_000 * E18]);
    assert!(w.pieces(s, ALICE).is_empty());
    assert_eq!(done.slice[3], done.c_min);
    assert!(done.c_min < done.liq.repaid, "156 vs 932");
    assert!(done.slice[0] > done.liq.repaid);
    let left = w.debt(s, ALICE);
    assert!(left.abs_diff(done.debt - done.liq.repaid) <= 2);
    assert_eq!(done.hf_after, Some(0));
}

#[test]
fn liquidate_gap_smallest_repayment_that_caps_f_takes_everything() {
    let mut w = liq_world();
    let s = w.s2x2;
    crashed_wnear_loan(&mut w);
    let c_min = w.lowest(s, ALICE);
    let repay = mul_div_up(c_min, E18, E18 + BONUS);
    assert!(liquidation_target(repay - 1, BONUS) < c_min);
    let done = liquidate_in(&mut w, s, ALICE, Some(repay));
    assert!(done.target >= c_min);
    assert_eq!(done.liq.seized, vec![1_000 * E18]);
    // DELAYED·CUTS still values the 1,000 wNEAR at 3,000 USDC
    assert!(done.slice[1] >= 2_999 * E18);
    let left = w.debt(s, ALICE);
    assert!(left.abs_diff(done.debt - repay) <= 2);
    assert!(
        left > 1_700 * E18 && left < 1_730 * E18,
        "about 1,716 left: {left}"
    );
}

#[test]
fn liquidate_gap_within_the_bonus_takes_everything_and_covers() {
    let mut w = liq_world();
    let s = w.s2x2;
    crashed_wnear_loan(&mut w);
    let c_min = w.lowest(s, ALICE);
    let repay = c_min * 100 / 103;
    let done = liquidate_in(&mut w, s, ALICE, Some(repay));
    assert!(done.target >= c_min);
    assert!(w.pieces(s, ALICE).is_empty());
    done.assert_covers();
    assert!(done.worst_slice() < done.target);
}

fn binary_market(w: &mut World) -> u64 {
    let ev = w
        .create_event(SPICE_QUESTION, &["A", "B"], SPICE_RULE, T0 + 90 * DAY)
        .unwrap();
    let sid = w.create_scenario(&[ev]).unwrap();
    w.lend(BOB, sid, 50_000 * E18).unwrap();
    sid
}

#[test]
fn liquidate_pauses_while_a_pool_is_under_the_gate() {
    let mut w = liq_world();
    let sid = binary_market(&mut w);
    set_price(sid, 0, PRICES_BIN[0]);
    set_price(sid, 1, PRICES_BIN[1]);
    w.post_real(ALICE, sid, Wnear, 1_000 * E18).unwrap();
    w.borrow(ALICE, sid, 2_079 * E18).unwrap();
    let hf = w.hf(sid, ALICE).0.unwrap();
    assert!(hf > E18 && hf < 1_011_000_000_000_000_000);
    // the depth gate fails in world 0
    set_unpriced(sid, 0);
    assert_eq!(w.hf(sid, ALICE), (Some(0), 0));
    fails(w.borrow(ALICE, sid, 1), "Unhealthy(0, 0)");
    fails(w.liquidate(LIQ, sid, ALICE, Some(1)), "PriceUnavailable(0)");
    let status = w.view(|c| c.liquidation_status(sid, acc(ALICE)));
    assert_eq!(
        (status.status, status.unpriced_world),
        (LiquidationState::PausedNoPrice, Some(0))
    );
    // liquidity comes back
    set_price(sid, 0, PRICES_BIN[0]);
    let hf = w.hf(sid, ALICE).0.unwrap();
    assert!(hf >= E18);
    fails(
        w.liquidate(LIQ, sid, ALICE, Some(1)),
        &format!("NotLiquidatable({hf})"),
    );
}

#[test]
fn liquidate_pauses_without_twap_history() {
    let mut w = liq_world();
    let sid = binary_market(&mut w);
    set_unpriced(sid, 0);
    set_price(sid, 1, PRICES_BIN[1]);
    w.post_real(ALICE, sid, Usdc, 1_000 * E18).unwrap();
    w.split_ft(ALICE, sid, Wnear, &[BIN_SHIPS, BIN_DELAYED], 1_000 * E18)
        .unwrap();
    w.post(ALICE, sid, &token_id(sid, Wnear, BIN_SHIPS), 1_000 * E18)
        .unwrap();
    w.borrow(ALICE, sid, 740 * E18).unwrap();
    assert_eq!(w.values(sid, ALICE)[0], 1_000 * E18);
    w.warp(YEAR);
    assert!(w.hf(sid, ALICE).0.unwrap() < E18);
    fails(w.liquidate(LIQ, sid, ALICE, None), "PriceUnavailable(0)");
    // a pool younger than the window still has no price
    w.warp(30);
    fails(w.liquidate(LIQ, sid, ALICE, None), "PriceUnavailable(0)");
    set_price(sid, 0, PRICES_BIN[0]);
    let done = liquidate_in(&mut w, sid, ALICE, None);
    done.assert_covers();
    assert!(done.hf_after.unwrap() > done.hf_before);
}

#[test]
fn liquidate_pauses_while_halted_then_works_after_finalize() {
    let mut w = liq_world();
    let s = w.s2x2;
    unhealthy_usdc_loan(&mut w);
    let fed = w.fed;
    w.report(fed, OUT_HOLDS).unwrap();
    fails(
        w.liquidate(LIQ, s, ALICE, None),
        &format!("ScenarioHalted({s})"),
    );
    // checked before the health factor
    fails(
        w.liquidate(LIQ, s, BOB, Some(E18)),
        &format!("ScenarioHalted({s})"),
    );
    let status = w.view(|c| c.liquidation_status(s, acc(ALICE)));
    assert_eq!(status.status, LiquidationState::PausedHalted);
    w.warp(DISPUTE_WINDOW);
    w.finalize(BOB, fed).unwrap();
    assert!(!w.view(|c| c.is_halted(s)));
    let done = liquidate_in(&mut w, s, ALICE, None);
    assert_eq!(done.possible, HOLDS);
    done.assert_covers();
    assert!(done.hf_after.unwrap() > done.hf_before);
}

#[test]
fn liquidate_halt_shields_a_loan_that_resolution_rescues() {
    let mut w = liq_world();
    let s = w.s2x2;
    unhealthy_usdc_loan(&mut w);
    let fed = w.fed;
    w.report(fed, OUT_CUTS).unwrap();
    fails(
        w.liquidate(LIQ, s, ALICE, None),
        &format!("ScenarioHalted({s})"),
    );
    w.warp(DISPUTE_WINDOW);
    w.finalize(BOB, fed).unwrap();
    let (hf, worst) = w.hf(s, ALICE);
    let hf = hf.unwrap();
    assert!(hf >= E18);
    assert_eq!(worst, 1);
    fails(
        w.liquidate(LIQ, s, ALICE, None),
        &format!("NotLiquidatable({hf})"),
    );
}

#[test]
fn liquidate_cuts_dead_pieces_too() {
    let mut w = liq_world();
    let s = w.s2x2;
    w.l_shape(ALICE);
    borrow_near_max(&mut w, s, ALICE);
    let fed = w.fed;
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    age_to(&mut w, s, ALICE, 980_000_000_000_000_000);
    let held_wnear = w.held(s, ALICE, &token_id(s, Wnear, SHIPS_CUTS));
    let held_usdc = w.held(s, ALICE, &token_id(s, Usdc, DELAYED_CUTS));
    let repay = w.debt(s, ALICE) * 2 / 5;
    let done = liquidate_in(&mut w, s, ALICE, Some(repay));
    assert_eq!(done.possible, HOLDS);
    done.assert_covers();
    let dead_wnear = mul_div_down(held_wnear, done.target, done.c_min);
    let dead_usdc = mul_div_down(held_usdc, done.target, done.c_min);
    assert!(dead_wnear > 0 && dead_usdc > 0);
    assert_eq!(done.liq.seized[0], dead_wnear);
    assert_eq!(done.liq.seized[1], dead_usdc);
    assert_eq!(
        w.bal(LIQ, s, Wnear, SHIPS_CUTS),
        mul_div_down(2_000 * E18, done.target, done.c_min)
    );
}

#[test]
fn liquidate_max_repays_half_the_accrued_debt() {
    let mut w = liq_world();
    let s = w.s2x2;
    unhealthy_usdc_loan(&mut w);
    let before = w.view(|c| c.market(s));
    let debt = w.debt(s, ALICE);
    assert!(debt > before.total_borrow_assets);
    let done = liquidate_in(&mut w, s, ALICE, None);
    assert_eq!(done.liq.repaid, debt / 2);
    let after = w.view(|c| c.market(s));
    assert_eq!(after.last_update, w.now);
    let interest = debt - before.total_borrow_assets;
    assert!(
        after
            .total_supply_assets
            .abs_diff(before.total_supply_assets + interest)
            <= 1
    );
    assert!(after.total_borrow_assets.abs_diff(debt - done.liq.repaid) <= 1);
    assert!(w.debt(s, ALICE).abs_diff(debt - done.liq.repaid) <= 2);
}

#[test]
fn original_rule_spirals_where_amendment_8_recovers() {
    // The exported rule from HF 0.975: repay half the debt and take (r/D)(1+b)
    // of every piece. Every world shrinks to 47.5% and the debt halves, so HF
    // falls by 5% a round, and the slice stops covering in the 8th round.
    let (mut c_min, mut debt) = (1_300 * E18, 1_000 * E18);
    let mut hf = hf_of(c_min, debt);
    let mut first_short = None;
    for round in 1..=9 {
        let r = debt / 2;
        let slice = mul_div_down(c_min, liquidation_target(r, BONUS), debt);
        if slice < r && first_short.is_none() {
            first_short = Some(round);
            assert_eq!(slice * 10_000 / r, 9_532);
        }
        c_min -= slice;
        debt -= r;
        let next = hf_of(c_min, debt);
        assert!(next < hf);
        hf = next;
    }
    assert_eq!(first_short, Some(8));
    // amendment 8 from the same state: one round, every slice worth >= 500
    let (r, target) = (500 * E18, liquidation_target(500 * E18, BONUS));
    assert_eq!(target, 525 * E18);
    for c in C_USDC {
        assert!(c - mul_div_down(c, 1_300 * E18 - target, 1_300 * E18) >= r);
    }
    assert_eq!(
        hf_of(1_300 * E18 - target, 1_000 * E18 - r),
        1_162_500_000_000_000_000
    );
    // the contract, from the aged loan
    let mut w = liq_world();
    let s = w.s2x2;
    unhealthy_usdc_loan(&mut w);
    let done = liquidate_in(&mut w, s, ALICE, None);
    let expected = hf_of(done.c_min - done.target, done.debt - done.liq.repaid);
    let hf_after = done.hf_after.unwrap();
    assert!(rel_close(hf_after, expected, 1_000_000_000));
    assert!(rel_close(
        hf_after,
        1_162_500_000_000_000_000,
        2_000_000_000_000_000
    ));
    fails(
        w.liquidate(LIQ, s, ALICE, None),
        &format!("NotLiquidatable({hf_after})"),
    );
}

#[test]
fn constructor_rejects_a_bonus_that_cannot_lift_hf() {
    let mut w = liq_world();
    fails(
        w.try_view(|_| check_liquidation_bonus(LLTV, 0)),
        "InvalidLiquidationBonus(0)",
    );
    fails(
        w.try_view(|_| check_liquidation_bonus(LLTV, 340_000_000_000_000_000)),
        "InvalidLiquidationBonus(340000000000000000)",
    );
    w.try_view(|_| check_liquidation_bonus(LLTV, 330_000_000_000_000_000))
        .unwrap();
    w.try_view(|c| check_liquidation_bonus(c.params.lltv, c.params.liquidation_bonus))
        .unwrap();
}

#[test]
fn liquidate_ft_needs_enough_usdc_and_refunds_the_rest() {
    let mut w = liq_world();
    let s = w.s2x2;
    unhealthy_usdc_loan(&mut w);
    let max_repay = w.debt(s, ALICE) / 2;
    let msg = format!(
        r#"{{"action":"liquidate","scenario_id":{s},"account_id":"{ALICE}","repay_amount":"max"}}"#
    );
    let wallet = w.wallet(LIQ, Usdc);
    fails(
        w.ft_transfer_call(LIQ, Usdc, 100_000_000, &msg),
        &format!("InsufficientRepayment({}, {max_repay})", 100 * E18),
    );
    fails(
        w.ft_transfer_call(LIQ, Wnear, E18, &msg),
        "WrongAsset(wnear)",
    );
    assert_eq!(w.wallet(LIQ, Usdc), wallet);
    // 10,000 attached: half the debt is used, the rest comes back
    let usdc = w.usdc_total(LIQ);
    let unused = w.ft_transfer_call(LIQ, Usdc, 10_000_000_000, &msg).unwrap();
    assert!(unused > 0);
    let seized = w.last.data_of("liquidate")[0]["seized"][0]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    // the real USDC piece comes first: the liquidator's books balance
    assert_eq!(w.usdc_total(LIQ) + max_repay, usdc + seized);
}

#[test]
fn liquidating_a_debt_without_pieces_or_of_one_unit() {
    let mut w = liq_world();
    let s = w.s2x2;
    // debt of 1: nothing can be repaid under the close factor
    w.post_real(DAVE, s, Wnear, E18).unwrap();
    w.borrow(DAVE, s, 1).unwrap();
    set_price(s, 3, 0);
    assert_eq!(w.hf(s, DAVE), (Some(0), 3));
    fails(w.liquidate(LIQ, s, DAVE, None), "ZeroAmount");
    fails(w.liquidate(LIQ, s, DAVE, Some(1)), "AboveCloseFactor(1, 0)");
    // a real wNEAR loan whose only world crashes to zero is a pure repayment
    // once its pieces are gone; it can still be "liquidated", seizing nothing
    set_price(s, 3, PRICES_2X2[3]);
    crashed_wnear_loan(&mut w);
    set_price(s, 3, 0);
    liquidate_in(&mut w, s, ALICE, None);
    assert!(w.pieces(s, ALICE).is_empty());
    let debt = w.debt(s, ALICE);
    assert!(debt > 0, "bad debt stays on the account");
    let done = liquidate_in(&mut w, s, ALICE, None);
    assert!(done.liq.pieces.is_empty());
    assert_eq!(done.liq.repaid, debt / 2);
    assert_eq!(w.debt(s, ALICE), debt - debt / 2);
    // self-liquidation is allowed
    w.fund(ALICE);
    let msg = format!(
        r#"{{"action":"liquidate","scenario_id":{s},"account_id":"{ALICE}","repay_amount":"{}"}}"#,
        E18
    );
    w.ft_transfer_call(ALICE, Usdc, 1_000_000, &msg).unwrap();
    assert_eq!(
        w.view(|c| c.liquidation_status(s, acc(ALICE))).status,
        LiquidationState::Liquidatable
    );
}
