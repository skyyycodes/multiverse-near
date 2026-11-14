//! Regression tests for the internal security review (docs/SECURITY.md).
//! Each test reproduces one finding against the unfixed code and pins the
//! fixed behaviour; the finding id is in the test's doc comment.

use near_sdk::json_types::U128;
use near_sdk::{NearToken, PromiseResult};

use super::amm::pool_world;
use super::harness::*;
use crate::core::MAX_SCENARIOS_PER_EVENT;
use crate::lending::tiers::MarketId;
use crate::types::Asset::{Usdc, Wnear};

/// RT-1: with nothing attached, an owner function-call key could move the
/// owner's balances into a pool at any price.
#[test]
fn owner_creation_methods_need_an_attached_deposit() {
    let mut w = pool_world();
    let sid = w.s2x2;
    w.split_ft(OWNER, sid, Wnear, &SINGLES, 100 * E18).unwrap();
    w.split_ft(OWNER, sid, Usdc, &SINGLES, 100 * E18).unwrap();
    w.deposit(OWNER, Wnear, 10 * E18).unwrap();
    w.deposit(OWNER, Usdc, 40_000 * E18).unwrap();

    fails(
        w.call(OWNER, NO_DEPOSIT, |c| {
            c.create_within_pool(sid, 0, U128(100 * E18), U128(E18))
        }),
        "DepositRequired",
    );
    fails(
        w.call(OWNER, NO_DEPOSIT, |c| {
            c.create_between_pool(sid, SHIPS_CUTS, DELAYED_CUTS, U128(E18), U128(E18))
        }),
        "DepositRequired",
    );
    fails(
        w.call(OWNER, NO_DEPOSIT, |c| {
            c.create_spot_pool(U128(E18), U128(3_000 * E18))
        }),
        "DepositRequired",
    );
    fails(
        w.call(OWNER, NO_DEPOSIT, |c| {
            c.create_event("q".into(), vec!["A".into(), "B".into()], "r".into(), 0)
        }),
        "DepositRequired",
    );
    let spice = w.spice;
    fails(
        w.call(OWNER, NO_DEPOSIT, |c| c.create_scenario(vec![spice])),
        "DepositRequired",
    );
    assert_eq!(w.bal(OWNER, sid, Wnear, SHIPS_CUTS), 100 * E18);

    // One yoctoNEAR proves a full-access key; storage then comes from the
    // owner's NEP-145 balance.
    let used = w.storage_used(OWNER);
    w.call(OWNER, ONE_YOCTO, |c| {
        c.create_within_pool(sid, 0, U128(E18), U128(30 * E18))
    })
    .unwrap();
    assert!(w.storage_used(OWNER) > used);
    assert!(w.last.near_transfers().is_empty());
}

/// RT-3: finalizing logs one line per scenario using the event; without a
/// cap, enough scenarios push finalize and admin_resolve past the receipt's
/// log limit and the event can never resolve.
#[test]
fn scenarios_per_event_are_capped_so_resolution_always_fits() {
    let mut w = World::new();
    let spice = w.spice;
    let used = w.view(|c| c.scenarios_of_event(spice).len());
    for _ in used..MAX_SCENARIOS_PER_EVENT {
        w.create_scenario(&[spice]).unwrap();
    }
    fails(
        w.create_scenario(&[spice]),
        &format!("TooManyScenarios({spice})"),
    );
    w.report(spice, OUT_SHIPS).unwrap();
    w.warp(DISPUTE_WINDOW + 1);
    w.finalize(CAROL, spice).unwrap();
    assert!(w.last.logs.len() <= 100);
    assert!(!w.view(|c| c.is_halted(1)));
}

/// RT-4: a failed payout re-creates the real-balance entry in a callback;
/// the bytes must be charged to the account, or every withdraw-and-fail
/// cycle hands it bytes it never paid for.
#[test]
fn failed_payout_recredit_is_charged_to_the_account() {
    let mut w = World::new();
    let usdc = 1_000_000 * scale(Usdc);
    w.deposit(ALICE, Usdc, usdc).unwrap();
    let start = w.storage_used(ALICE);
    w.ft_unregistered.insert(acc(ALICE));
    for _ in 0..5 {
        w.withdraw(ALICE, Usdc, usdc).unwrap();
        assert_eq!(w.real(ALICE, Usdc), usdc);
        assert_eq!(w.storage_used(ALICE), start);
    }
    let left = w
        .call(ALICE, ONE_YOCTO, |c| c.storage_withdraw(None))
        .unwrap();
    let locked = near_sdk::env::storage_byte_cost().as_yoctonear() * u128::from(start);
    assert_eq!(left.total.0, locked);
}

fn resolve_last(w: &mut World, result: PromiseResult) -> Vec<u128> {
    let call = w
        .last
        .calls()
        .into_iter()
        .find(|c| c.method == "mt_resolve_transfer")
        .expect("resolve scheduled");
    let a = call.args;
    let sender = acc(a["sender_id"].as_str().unwrap());
    let receiver = acc(a["receiver_id"].as_str().unwrap());
    let ids: Vec<String> = a["token_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    let amounts: Vec<U128> = a["amounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| U128(v.as_str().unwrap().parse().unwrap()))
        .collect();
    w.exec(CONTRACT, NO_DEPOSIT, vec![result], |c| {
        c.mt_resolve_transfer(sender, receiver, ids, amounts, None)
    })
    .unwrap()
    .into_iter()
    .map(|u| u.0)
    .collect()
}

/// STD-1: the refund in `mt_resolve_transfer` re-creates the sender's
/// balance entry; unless it is charged, looping a failing transfer call
/// drives the sender's `used_bytes` to zero while the state stays.
#[test]
fn resolve_refund_is_charged_to_the_sender() {
    const MARKET: &str = "market.near";
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &[SHIPS, DELAYED], 10 * E18)
        .unwrap();
    w.register(MARKET, NearToken::from_near(1));
    let ships = token_id(1, Wnear, SHIPS);
    // The receiver keeps 1 unit, so its own entry survives every refund.
    w.mt_transfer(ALICE, MARKET, &ships, 1).unwrap();
    let used = w.storage_used(ALICE);
    for _ in 0..3 {
        let bal = w.bal(ALICE, 1, Wnear, SHIPS);
        let s = ships.clone();
        w.call(ALICE, ONE_YOCTO, |c| {
            c.mt_transfer_call(acc(MARKET), s, U128(bal), None, None, String::new());
        })
        .unwrap();
        assert_eq!(resolve_last(&mut w, PromiseResult::Failed), vec![0]);
        assert_eq!(w.storage_used(ALICE), used);
    }
    assert_eq!(w.bal(ALICE, 1, Wnear, SHIPS), 10 * E18 - 1);
}

/// RT-2 (a): price-1 bids escrowed one unit each, and `trade_view` showed
/// the first 200 open ids, so dust posted early hid every later order.
#[test]
fn dust_orders_cannot_hide_the_book_from_trade_view() {
    use super::orders::{book, give, post, RAVI};
    use crate::orders::{Side, MAX_OPEN_ORDERS_PER_MAKER, MIN_ORDER_AMOUNT, MIN_ORDER_VALUE};

    let mut w = book();
    let sid = w.s2x2;
    let expiry = T0 + 365 * DAY;
    w.register(BOB, NearToken::from_near(2));
    give(&mut w, BOB, sid, Usdc, SHIPS_CUTS, 1_000 * E18);
    fails(
        post(
            &mut w,
            BOB,
            sid,
            SHIPS_CUTS,
            Side::Bid,
            1,
            MIN_ORDER_AMOUNT,
            expiry,
        ),
        &format!("OrderValueTooSmall(1, {MIN_ORDER_VALUE})"),
    );
    // The cheapest order allowed, as many times as one maker may.
    let floor = MIN_ORDER_VALUE * E18 / MIN_ORDER_AMOUNT;
    for _ in 0..MAX_OPEN_ORDERS_PER_MAKER {
        post(
            &mut w,
            BOB,
            sid,
            SHIPS_CUTS,
            Side::Bid,
            floor,
            MIN_ORDER_AMOUNT,
            expiry,
        )
        .unwrap();
    }
    fails(
        post(
            &mut w,
            BOB,
            sid,
            SHIPS_CUTS,
            Side::Bid,
            floor,
            MIN_ORDER_AMOUNT,
            expiry,
        ),
        &format!("TooManyOpenOrders({MAX_OPEN_ORDERS_PER_MAKER})"),
    );
    give(&mut w, RAVI, sid, Usdc, SHIPS_CUTS, 2_450 * E18);
    let real = post(
        &mut w,
        RAVI,
        sid,
        SHIPS_CUTS,
        Side::Bid,
        2_450 * E18,
        E18,
        expiry,
    )
    .unwrap();
    let orders = w.view(|c| c.trade_view(sid, None)).orders;
    assert_eq!(orders.first().map(|o| o.id.0), Some(real));
    // A maker always sees their own orders, also the ones outside the top.
    let mine = w.view(|c| c.trade_view(sid, Some(acc(BOB)))).orders;
    let bobs = mine.iter().filter(|o| o.maker == acc(BOB)).count();
    assert_eq!(bobs, MAX_OPEN_ORDERS_PER_MAKER);
}

/// RT-2 (b), STD-2: closed orders stayed in the scans behind
/// `storage_unregister` and `trade_view`, so their gas grew with every
/// order ever posted.
#[test]
fn closed_orders_do_not_grow_unregister_or_trade_view_gas() {
    use super::orders::{book, give, post, RAVI};
    use crate::orders::{Side, MIN_ORDER_AMOUNT};
    use near_sdk::env;

    let mut w = book();
    let sid = w.s2x2;
    let expiry = T0 + 365 * DAY;
    w.register(RAVI, NearToken::from_near(5));
    give(&mut w, RAVI, sid, Wnear, DELAYED_HOLDS, MIN_ORDER_AMOUNT);
    let gas = |w: &mut World| -> (u64, u64) {
        w.view(|c| {
            let g0 = env::used_gas().as_gas();
            assert!(!c.holds_anything(&acc(BOB)));
            let g1 = env::used_gas().as_gas();
            let _ = c.trade_view(sid, None);
            (g1 - g0, env::used_gas().as_gas() - g1)
        })
    };
    let (unreg0, view0) = gas(&mut w);
    for _ in 0..300 {
        let id = post(
            &mut w,
            RAVI,
            sid,
            DELAYED_HOLDS,
            Side::Ask,
            2_000 * E18,
            MIN_ORDER_AMOUNT,
            expiry,
        )
        .unwrap();
        w.call(RAVI, ONE_YOCTO, |c| {
            c.cancel_order(near_sdk::json_types::U64(id))
        })
        .unwrap();
    }
    let (unreg1, view1) = gas(&mut w);
    // 300 closed orders used to add about 21 Tgas to each.
    assert!(unreg1 < unreg0 + 1_000_000_000_000, "{unreg0} -> {unreg1}");
    assert!(view1 < view0 + 1_000_000_000_000, "{view0} -> {view1}");
}

const P0: u128 = 3_400 * E15;
const P1: u128 = 2_800 * E15;

/// The binary scenario with the demo's world pools and Bob's 100,000 USDC
/// supply, one minute after seeding.
fn lending_world() -> (World, u64, Vec<u64>) {
    use super::amm::seed_worlds;
    let mut w = pool_world();
    let s = w.s_bin;
    let pools = seed_worlds(&mut w, s, &[P0, P1], &[100_000 * E18, 100_000 * E18]);
    let msg = format!(r#"{{"action":"supply","scenario_id":{s}}}"#);
    w.ft_transfer_call(BOB, Usdc, 100_000 * E18 / scale(Usdc), &msg)
        .unwrap();
    w.warp(61);
    (w, s, pools)
}

fn post_wnear(w: &mut World, who: &str, s: u64, amount: u128) {
    let msg = format!(r#"{{"action":"deposit_collateral","scenario_id":{s}}}"#);
    w.ft_transfer_call(who, Wnear, amount, &msg).unwrap();
}

/// ECON-1: one root USDC split pumps every world's pool; held for one 60 s
/// window, the TWAP followed and 24,000 wNEAR borrowed the whole market.
#[test]
fn pumping_every_world_for_a_minute_does_not_unlock_borrowing() {
    let (mut w, s, pools) = lending_world();
    w.split_ft(CAROL, s, Usdc, &[1, 2], 142_000 * E18).unwrap();
    for (i, y) in [(0usize, 100_000 * P0), (1, 100_000 * P1)] {
        // y * (sqrt 2 - 1) into the curve doubles the price.
        let amount_in = y * 414_213_562 / 1_000_000_000 * 1_000_000 / 997_000;
        w.call(CAROL, ONE_YOCTO, |c| {
            c.swap(pools[i], false, U128(amount_in), U128(0))
        })
        .unwrap();
    }
    w.warp(61);
    post_wnear(&mut w, CAROL, s, 24_000 * E18);
    let borrowed = w.call(CAROL, ONE_YOCTO, |c| c.borrow(s, U128(100_000 * E18), None));
    assert!(borrowed.is_err(), "{borrowed:?}");
    // While the pools sit this far from their TWAP the worlds are unpriced,
    // so nothing borrows against wNEAR there.
    w.call(CAROL, ONE_YOCTO, |c| c.borrow(s, U128(10_000 * E18), None))
        .unwrap_err();
    for i in 0..2 {
        assert!(!w.view(|c| c.world_price(s, i)).1);
    }
}

/// ECON-2: dumping one world's pool for one 60 s window made a borrower
/// who was healthy at every honest price liquidatable.
#[test]
fn dumping_one_world_for_a_minute_does_not_liquidate_a_healthy_borrower() {
    let (mut w, s, pools) = lending_world();
    post_wnear(&mut w, ALICE, s, 10_000 * E18);
    w.call(ALICE, ONE_YOCTO, |c| c.borrow(s, U128(18_000 * E18), None))
        .unwrap();
    w.split_ft(CAROL, s, Wnear, &[1, 2], 19_000 * E18).unwrap();
    w.call(CAROL, ONE_YOCTO, |c| {
        c.swap(pools[1], true, U128(18_380 * E18), U128(0))
    })
    .unwrap();
    w.warp(61);
    let msg = format!(
        r#"{{"action":"liquidate","scenario_id":{s},"account_id":"{ALICE}","repay_amount":"max"}}"#
    );
    let liquidated = w.ft_transfer_call(CAROL, Usdc, 9_001 * E18 / scale(Usdc), &msg);
    // Under the v1 gates the pool is younger than a window, so its mean runs
    // over the dump too: the out-of-band world pauses liquidation.
    fails(liquidated, "PriceUnavailable(1)");
    let status = w.view(|c| c.liquidation_status(s, acc(ALICE), None));
    assert_eq!(
        (status.status, status.unpriced_world),
        (crate::lending::LiquidationState::PausedNoPrice, Some(1))
    );
    assert_eq!(w.real(CAROL, Wnear), 0);
}

// ---- ECON-1 and ECON-2 under the v2 price config (C-PRC) ----

/// The binary scenario with world pools at 3.40 / 2.80 (100,000 wNEAR
/// deep), its odds pool at 2/3 : 1/3 and Bob's 100,000 USDC supply, on the
/// production defaults (`min_age_sec` 1,800, `min_depth` 50,000), a full
/// window after seeding.
fn v2_lending_world() -> (World, u64, Vec<u64>) {
    let mut w = super::prices::v2_world();
    let (s, pools) = super::prices::seed_bin(&mut w);
    let msg = format!(r#"{{"action":"supply","scenario_id":{s}}}"#);
    w.ft_transfer_call(BOB, Usdc, 100_000 * E18 / scale(Usdc), &msg)
        .unwrap();
    w.warp(1_801);
    (w, s, pools)
}

/// The TWAP-implied spot (I) of the scenario now.
fn implied(w: &mut World, s: u64) -> u128 {
    w.view(|c| c.price_check(s)).implied_twap_spot.unwrap().0
}

/// Liquidation-side health of `who` at `lltv`, from the snapshot's prices:
/// what lending computes once it reads the snapshot.
fn liquidation_hf(w: &mut World, s: u64, who: &str, lltv: u128) -> u128 {
    use crate::prices::PriceMode;
    let who = acc(who);
    w.view(|c| {
        let px = c.price_snapshot(s).prices(PriceMode::Liquidate);
        let root = c.scenario(s).root();
        let possible = c.scenario(s).possible;
        let mut values = vec![0u128; px.prices.len()];
        for (piece, amount) in c.pieces(MarketId::new(s, None), &who) {
            let mask = piece.mask(root) & possible;
            for (w, value) in values.iter_mut().enumerate() {
                if mask & (1 << w) == 0 {
                    continue;
                }
                *value += if piece.asset() == Usdc {
                    amount
                } else {
                    multiverse_math::mul_div_down(amount, px.prices[w], E18)
                };
            }
        }
        let lowest = (0..values.len())
            .filter(|w| possible & (1 << w) != 0)
            .map(|w| values[w])
            .min()
            .unwrap();
        multiverse_math::risk::health_factor(lowest, c.debt_for(MarketId::new(s, None), &who), lltv)
            .unwrap()
    })
}

/// A wNEAR amount that moves a pool of `reserve0` wNEAR to `factor` (WAD)
/// of its price when sold into it: `reserve0 * (1/sqrt(factor) - 1)`, before
/// the fee.
fn to_move_price(reserve0: u128, factor_pct: u128) -> u128 {
    // 1/sqrt(0.70) = 1.195229, 1/sqrt(0.75) = 1.154701.
    let inverse_sqrt = match factor_pct {
        70 => 1_195_229,
        75 => 1_154_701,
        _ => panic!("unsupported factor"),
    };
    reserve0 * (inverse_sqrt - 1_000_000) / 1_000_000 * 1_000 / 997
}

/// ECON-2 on a v2 market: the same dump, but in a pool with a full window.
/// The out-of-band world stays priced for liquidation at its TWAP, which
/// the minute of dumping moved by 114 ticks: Alice stays healthy. She
/// borrows 16,000, within the Normal tier's 0.60 borrow limit on the 2.80
/// world (16,800); SPEC-C 8.4's 18,000 is above that limit.
#[test]
fn econ2_full_window_dump_does_not_liquidate() {
    let (mut w, s, pools) = v2_lending_world();
    post_wnear(&mut w, ALICE, s, 10_000 * E18);
    w.call(ALICE, ONE_YOCTO, |c| c.borrow(s, U128(16_000 * E18), None))
        .unwrap();
    w.split_ft(CAROL, s, Wnear, &[1, 2], 19_000 * E18).unwrap();
    w.call(CAROL, ONE_YOCTO, |c| {
        c.swap(pools[1], true, U128(18_380 * E18), U128(0))
    })
    .unwrap();
    w.warp(61);
    let sn = w.view(|c| c.price_snapshot(s));
    let q = sn.quotes[1];
    assert_eq!(q.status, crate::prices::WorldStatus::OutOfBand);
    assert!(q.full_window);
    let rows = w.view(|c| c.world_prices(s));
    assert_eq!(rows[1].borrow_price.0, 0);
    // TWAP 2.8 x 1.0001^-114 = 2.768.
    let p = rows[1].liquidation_price.0;
    assert_eq!(p, q.twap);
    assert!(p > 2_767 * E15 && p < 2_769 * E15, "{p}");
    // 10,000 x 2.768 x 0.70 / 16,000: HF 1.211 at the Normal tier's 0.70.
    let hf = liquidation_hf(&mut w, s, ALICE, 700 * E15);
    assert!(hf > 1_210 * E15 && hf < 1_212 * E15, "{hf}");
    let msg = format!(
        r#"{{"action":"liquidate","scenario_id":{s},"account_id":"{ALICE}","repay_amount":"max"}}"#
    );
    assert!(w
        .ft_transfer_call(CAROL, Usdc, 9_001 * E18 / scale(Usdc), &msg)
        .is_err());
    assert_eq!(w.real(CAROL, Wnear), 0);
}

/// An LP pull makes a world shallow: liquidation there pauses, the implied
/// spot becomes unknown and the reference haircut switches off.
#[test]
fn econ2_lp_pull_pauses_and_switches_the_haircut_off() {
    let (mut w, s, pools) = v2_lending_world();
    let honest = implied(&mut w, s);
    super::reference::configure(&mut w, super::reference::reporter_only()).unwrap();
    let cfg = super::reference::with_reference(crate::prices::MarketPriceCfg::V2);
    super::reference::set_cfg(&mut w, s, cfg).unwrap();
    // The outside price 5% under the pools: a 5% haircut on both sides.
    super::reference::report(&mut w, honest * 95 / 100).unwrap();
    let check = w.view(|c| c.price_check(s));
    // f_l = rho, 0.95 to within the floors of R and rho.
    assert_eq!(Some(check.liquidation_factor), check.ratio);
    assert!(check.liquidation_factor.0.abs_diff(950 * E15) <= 1);
    post_wnear(&mut w, ALICE, s, 10_000 * E18);
    w.call(ALICE, ONE_YOCTO, |c| c.borrow(s, U128(15_000 * E18), None))
        .unwrap();
    // The owner pulls 90% of world 1's liquidity: 28,000 USDC-if-1 left.
    let owner = w.view(|c| c.position_of(pools[1], acc(OWNER)).unwrap());
    let pull = owner.liquidity.0 / 10 * 9;
    w.call(OWNER, ONE_YOCTO, |c| {
        c.remove_liquidity(pools[1], U128(pull), U128(0), U128(0))
    })
    .unwrap();
    let rows = w.view(|c| c.world_prices(s));
    assert_eq!(rows[1].status, crate::prices::WorldStatus::Shallow);
    assert_eq!(rows[1].liquidation_price.0, 0);
    let check = w.view(|c| c.price_check(s));
    assert_eq!(check.implied_twap_spot, None);
    assert_eq!(check.liquidation_factor.0, E18);
    // World 0 keeps its plain TWAP.
    assert_eq!(rows[0].liquidation_price.0, rows[0].twap.0);
    let msg = format!(
        r#"{{"action":"liquidate","scenario_id":{s},"account_id":"{ALICE}","repay_amount":"max"}}"#
    );
    fails(
        w.ft_transfer_call(CAROL, Usdc, 9_001 * E18 / scale(Usdc), &msg),
        "PriceUnavailable(1)",
    );
}

/// PRC-3: pushing every world far out of band, up and down, inside one
/// block changes no liquidation price, depth, factor or guard; a second
/// later each TWAP has moved by at most push_ticks / 1,800.
#[test]
fn one_block_push_never_moves_liquidation_prices() {
    let (mut w, s, pools) = v2_lending_world();
    let honest = implied(&mut w, s);
    super::reference::configure(&mut w, super::reference::reporter_only()).unwrap();
    let cfg = super::reference::with_reference(crate::prices::MarketPriceCfg::V2);
    super::reference::set_cfg(&mut w, s, cfg).unwrap();
    super::reference::report(&mut w, honest * 95 / 100).unwrap();
    let before_rows = w.view(|c| c.world_prices(s));
    let before_check = w.view(|c| c.price_check(s));
    let before = w.view(|c| c.price_snapshot(s));
    super::amm::give_world_tokens(&mut w, CAROL, s, 40_000 * E18, 200_000 * E18);
    super::amm::buy(&mut w, CAROL, pools[0], 30_000 * E18);
    super::amm::sell(&mut w, CAROL, pools[1], 30_000 * E18);
    let after = w.view(|c| c.price_snapshot(s));
    assert!(after
        .statuses()
        .iter()
        .all(|st| *st == crate::prices::WorldStatus::OutOfBand));
    let after_rows = w.view(|c| c.world_prices(s));
    for (b, a) in before_rows.iter().zip(&after_rows) {
        assert_eq!(
            (b.liquidation_price, b.depth, b.twap),
            (a.liquidation_price, a.depth, a.twap)
        );
    }
    let after_check = w.view(|c| c.price_check(s));
    assert_eq!(
        (
            after_check.liquidation_factor,
            after_check.liquidation_guard
        ),
        (
            before_check.liquidation_factor,
            before_check.liquidation_guard
        )
    );
    assert_eq!(
        after_check.implied_twap_spot,
        before_check.implied_twap_spot
    );
    w.warp(1);
    let later = w.view(|c| c.price_snapshot(s));
    for i in 0..2 {
        let (l0, push) = (
            before.quotes[i].mean_tick.unwrap(),
            after.quotes[i].spot_tick.unwrap(),
        );
        let l1 = later.quotes[i].mean_tick.unwrap();
        let bound = (i64::from(push) - i64::from(l0)).abs() / 1_800 + 1;
        assert!(
            (i64::from(l1) - i64::from(l0)).abs() <= bound,
            "{i}: {l0} -> {l1}, push {push}"
        );
    }
}

/// A dump that drains the USDC side below the depth gate leaves the depth
/// (USDC at the TWAP price) where it was: the world is out of band, never
/// shallow, so one dump cannot pause liquidation in a full-window pool.
#[test]
fn one_block_dump_cannot_make_a_world_shallow() {
    let mut w = super::prices::v2_world();
    let s = w.s_bin;
    // World 1: 4,286 wNEAR at 2.80, 12,000 USDC-if-1 against the v1 gate of
    // 10,000.
    let pools = super::amm::seed_worlds(
        &mut w,
        s,
        &[3_400 * E15, 2_800 * E15],
        &[100_000 * E18, 4_286 * E18],
    );
    super::reference::set_cfg(&mut w, s, super::profile::V1_PRICE_CFG).unwrap();
    w.warp(61);
    assert_eq!(
        w.view(|c| c.price_snapshot(s)).statuses(),
        vec![crate::prices::WorldStatus::Trusted; 2]
    );
    let depth = w.view(|c| c.price_snapshot(s)).quotes[1].depth;
    super::amm::give_world_tokens(&mut w, CAROL, s, 2_000 * E18, 0);
    super::amm::sell(&mut w, CAROL, pools[1], 1_000 * E18);
    assert!(w.view(|c| c.pool(pools[1]).amm.reserve1()) < 10_000 * E18);
    let q = w.view(|c| c.price_snapshot(s)).quotes[1];
    assert_eq!(q.status, crate::prices::WorldStatus::OutOfBand);
    assert_eq!(q.depth, depth);
    assert!(depth > 11_990 * E18);
}

/// G9, closed: holding the likely world (2/3) 30% down for a window moves
/// the implied spot 21% under the outside price, so the guard pauses
/// liquidation (and borrowing).
#[test]
fn econ2_guard_catches_a_high_odds_world_held_down_a_window() {
    let (mut w, s, pools) = v2_lending_world();
    let honest = implied(&mut w, s);
    super::reference::configure(&mut w, super::reference::reporter_only()).unwrap();
    let cfg = super::reference::with_reference(crate::prices::MarketPriceCfg::V2);
    super::reference::set_cfg(&mut w, s, cfg).unwrap();
    super::amm::give_world_tokens(&mut w, CAROL, s, 30_000 * E18, 0);
    super::amm::sell(&mut w, CAROL, pools[0], to_move_price(100_000 * E18, 70));
    w.warp(1_801);
    super::reference::report(&mut w, honest).unwrap();
    let check = w.view(|c| c.price_check(s));
    let ratio = check.ratio.unwrap().0;
    // 3.20 / (2/3 x 2.38 + 1/3 x 2.80) = 1.27.
    assert!(ratio > 1_260 * E15 && ratio < 1_280 * E15, "{ratio}");
    assert!(check.liquidation_guard);
    assert!(check
        .borrow_block
        .unwrap()
        .starts_with("ReferenceDeviation("));
    let guard = w.view(|c| c.price_snapshot(s)).liquidation_guard().unwrap();
    assert!(guard.error().starts_with("ReferenceGuard("));
}

/// G9's documented residual: holding the unlikely world (1/3) 30% down
/// for a window moves the implied spot only 9.6%, inside the guard's 10%,
/// and a borrower healthy at honest prices is liquidated at the held TWAP.
/// A later fix of the residual must change this test.
#[test]
fn econ2_low_odds_world_held_down_a_window_is_the_documented_residual() {
    let (mut w, s, pools) = v2_lending_world();
    let honest = implied(&mut w, s);
    super::reference::configure(&mut w, super::reference::reporter_only()).unwrap();
    let cfg = super::reference::with_reference(crate::prices::MarketPriceCfg::V2);
    super::reference::set_cfg(&mut w, s, cfg).unwrap();
    super::reference::report(&mut w, honest).unwrap();
    post_wnear(&mut w, ALICE, s, 10_000 * E18);
    w.call(ALICE, ONE_YOCTO, |c| c.borrow(s, U128(15_000 * E18), None))
        .unwrap();
    super::amm::give_world_tokens(&mut w, CAROL, s, 30_000 * E18, 0);
    super::amm::sell(&mut w, CAROL, pools[1], to_move_price(100_000 * E18, 70));
    w.warp(1_801);
    super::reference::report(&mut w, honest).unwrap();
    let check = w.view(|c| c.price_check(s));
    let ratio = check.ratio.unwrap().0;
    // 3.20 / (2/3 x 3.40 + 1/3 x 1.96) = 1.096.
    assert!(ratio > 1_090 * E15 && ratio < 1_100 * E15, "{ratio}");
    assert!(!check.liquidation_guard);
    assert_eq!(check.borrow_block, None);
    let rows = w.view(|c| c.world_prices(s));
    assert_eq!(rows[1].status, crate::prices::WorldStatus::Trusted);
    assert_eq!(rows[1].liquidation_price, rows[1].twap);
    // 10,000 x 1.96 x 0.75 < 15,000: liquidatable at the held TWAP.
    assert!(liquidation_hf(&mut w, s, ALICE, 750 * E15) < E18);
    let msg = format!(
        r#"{{"action":"liquidate","scenario_id":{s},"account_id":"{ALICE}","repay_amount":"max"}}"#
    );
    w.ft_transfer_call(CAROL, Usdc, 9_001 * E18 / scale(Usdc), &msg)
        .unwrap();
    assert!(w.real(CAROL, Wnear) > 0);
}

/// ECON-1 held for a whole window: the TWAP follows the pump, but the
/// outside price does not, so a reference market refuses new borrowing.
/// Without the reference it is the documented residual.
#[test]
fn pumping_every_world_for_a_window_is_caught_by_the_reference() {
    let (mut w, s, pools) = v2_lending_world();
    let honest = implied(&mut w, s);
    super::reference::configure(&mut w, super::reference::reporter_only()).unwrap();
    w.split_ft(CAROL, s, Usdc, &[1, 2], 142_000 * E18).unwrap();
    for (i, y) in [(0usize, 100_000 * P0), (1, 100_000 * P1)] {
        // y * (sqrt 2 - 1) into the curve doubles the price.
        let amount_in = y * 414_213_562 / 1_000_000_000 * 1_000_000 / 997_000;
        w.call(CAROL, ONE_YOCTO, |c| {
            c.swap(pools[i], false, U128(amount_in), U128(0))
        })
        .unwrap();
    }
    w.warp(1_801);
    super::reference::report(&mut w, honest).unwrap();
    // Off: the pump counts (the residual), at about twice the price.
    let rows = w.view(|c| c.world_prices(s));
    assert!(
        rows[0].borrow_price.0 > 6_700 * E15,
        "{}",
        rows[0].borrow_price.0
    );
    assert_eq!(w.view(|c| c.price_check(s)).borrow_block, None);
    // On: the reference says NEAR did not double.
    let cfg = super::reference::with_reference(crate::prices::MarketPriceCfg::V2);
    super::reference::set_cfg(&mut w, s, cfg).unwrap();
    let check = w.view(|c| c.price_check(s));
    let ratio = check.ratio.unwrap().0;
    assert!(ratio > 490 * E15 && ratio < 510 * E15, "{ratio}");
    assert!(check
        .borrow_block
        .unwrap()
        .starts_with("ReferenceDeviation("));
    // The borrow side would also be cut to the reference: f_b = rho.
    assert_eq!(check.borrow_factor.0, ratio);
}

/// ECON-1 in a young pool: under the v2 age gate (1,800 s) a pump in the
/// first second after seeding, held a minute, prices nothing.
#[test]
fn young_pool_pump_cannot_borrow_under_v2_defaults() {
    let mut w = super::prices::v2_world();
    let (s, pools) = super::prices::seed_bin(&mut w);
    let msg = format!(r#"{{"action":"supply","scenario_id":{s}}}"#);
    w.ft_transfer_call(BOB, Usdc, 100_000 * E18 / scale(Usdc), &msg)
        .unwrap();
    w.split_ft(CAROL, s, Usdc, &[1, 2], 142_000 * E18).unwrap();
    for (i, y) in [(0usize, 100_000 * P0), (1, 100_000 * P1)] {
        let amount_in = y * 414_213_562 / 1_000_000_000 * 1_000_000 / 997_000;
        w.call(CAROL, ONE_YOCTO, |c| {
            c.swap(pools[i], false, U128(amount_in), U128(0))
        })
        .unwrap();
    }
    w.warp(61);
    let rows = w.view(|c| c.world_prices(s));
    assert!(rows
        .iter()
        .all(|r| r.status == crate::prices::WorldStatus::Young && r.borrow_price.0 == 0));
    post_wnear(&mut w, CAROL, s, 24_000 * E18);
    let err = w
        .call(CAROL, ONE_YOCTO, |c| c.borrow(s, U128(10_000 * E18), None))
        .unwrap_err();
    assert!(err.starts_with("Unhealthy("), "{err}");
}
