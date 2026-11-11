//! Regression tests for the internal security review (docs/SECURITY.md).
//! Each test reproduces one finding against the unfixed code and pins the
//! fixed behaviour; the finding id is in the test's doc comment.

use near_sdk::json_types::U128;
use near_sdk::{NearToken, PromiseResult};

use super::amm::pool_world;
use super::harness::*;
use crate::core::MAX_SCENARIOS_PER_EVENT;
use crate::types::Asset::{Usdc, Weth};

/// RT-1: with nothing attached, an owner function-call key could move the
/// owner's balances into a pool at any price.
#[test]
fn owner_creation_methods_need_an_attached_deposit() {
    let mut w = pool_world();
    let sid = w.s2x2;
    w.split_ft(OWNER, sid, Weth, &SINGLES, 100 * E18).unwrap();
    w.split_ft(OWNER, sid, Usdc, &SINGLES, 100 * E18).unwrap();
    w.deposit(OWNER, Weth, 10 * E18).unwrap();
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
    let glam = w.glam;
    fails(
        w.call(OWNER, NO_DEPOSIT, |c| c.create_scenario(vec![glam])),
        "DepositRequired",
    );
    assert_eq!(w.bal(OWNER, sid, Weth, SHIPS_CUTS), 100 * E18);

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
    let glam = w.glam;
    let used = w.view(|c| c.scenarios_of_event(glam).len());
    for _ in used..MAX_SCENARIOS_PER_EVENT {
        w.create_scenario(&[glam]).unwrap();
    }
    fails(
        w.create_scenario(&[glam]),
        &format!("TooManyScenarios({glam})"),
    );
    w.report(glam, OUT_SHIPS).unwrap();
    w.warp(DISPUTE_WINDOW + 1);
    w.finalize(CAROL, glam).unwrap();
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
    w.split_ft(ALICE, 1, Weth, &[SHIPS, DELAYED], 10 * E18)
        .unwrap();
    w.register(MARKET, NearToken::from_near(1));
    let ships = token_id(1, Weth, SHIPS);
    // The receiver keeps 1 wei, so its own entry survives every refund.
    w.mt_transfer(ALICE, MARKET, &ships, 1).unwrap();
    let used = w.storage_used(ALICE);
    for _ in 0..3 {
        let bal = w.bal(ALICE, 1, Weth, SHIPS);
        let s = ships.clone();
        w.call(ALICE, ONE_YOCTO, |c| {
            c.mt_transfer_call(acc(MARKET), s, U128(bal), None, None, String::new());
        })
        .unwrap();
        assert_eq!(resolve_last(&mut w, PromiseResult::Failed), vec![0]);
        assert_eq!(w.storage_used(ALICE), used);
    }
    assert_eq!(w.bal(ALICE, 1, Weth, SHIPS), 10 * E18 - 1);
}

/// RT-2 (a): price-1 bids escrowed one wei each, and `trade_view` showed
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
        post(&mut w, BOB, sid, SHIPS_CUTS, Side::Bid, 1, MIN_ORDER_AMOUNT, expiry),
        &format!("OrderValueTooSmall(1, {MIN_ORDER_VALUE})"),
    );
    // The cheapest order allowed, as many times as one maker may.
    let floor = MIN_ORDER_VALUE * E18 / MIN_ORDER_AMOUNT;
    for _ in 0..MAX_OPEN_ORDERS_PER_MAKER {
        post(&mut w, BOB, sid, SHIPS_CUTS, Side::Bid, floor, MIN_ORDER_AMOUNT, expiry).unwrap();
    }
    fails(
        post(&mut w, BOB, sid, SHIPS_CUTS, Side::Bid, floor, MIN_ORDER_AMOUNT, expiry),
        &format!("TooManyOpenOrders({MAX_OPEN_ORDERS_PER_MAKER})"),
    );
    give(&mut w, RAVI, sid, Usdc, SHIPS_CUTS, 2_450 * E18);
    let real = post(&mut w, RAVI, sid, SHIPS_CUTS, Side::Bid, 2_450 * E18, E18, expiry).unwrap();
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
    give(&mut w, RAVI, sid, Weth, DELAYED_HOLDS, MIN_ORDER_AMOUNT);
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
        let id = post(&mut w, RAVI, sid, DELAYED_HOLDS, Side::Ask, 2_000 * E18, MIN_ORDER_AMOUNT, expiry).unwrap();
        w.call(RAVI, ONE_YOCTO, |c| c.cancel_order(near_sdk::json_types::U64(id)))
            .unwrap();
    }
    let (unreg1, view1) = gas(&mut w);
    // 300 closed orders used to add about 21 Tgas to each.
    assert!(unreg1 < unreg0 + 1_000_000_000_000, "{unreg0} -> {unreg1}");
    assert!(view1 < view0 + 1_000_000_000_000, "{view0} -> {view1}");
}

const P0: u128 = 3_400 * E18;
const P1: u128 = 2_800 * E18;

/// The binary scenario with the demo's world pools and Bob's 100,000 USDC
/// supply, one minute after seeding.
fn lending_world() -> (World, u64, Vec<u64>) {
    use super::amm::seed_worlds;
    let mut w = pool_world();
    let s = w.s_bin;
    let pools = seed_worlds(&mut w, s, &[P0, P1], &[100 * E18, 100 * E18]);
    let msg = format!(r#"{{"action":"supply","scenario_id":{s}}}"#);
    w.ft_transfer_call(BOB, Usdc, 100_000 * E18 / scale(Usdc), &msg)
        .unwrap();
    w.warp(61);
    (w, s, pools)
}

fn post_weth(w: &mut World, who: &str, s: u64, amount: u128) {
    let msg = format!(r#"{{"action":"deposit_collateral","scenario_id":{s}}}"#);
    w.ft_transfer_call(who, Weth, amount, &msg).unwrap();
}

/// ECON-1: one root USDC split pumps every world's pool; held for one 60 s
/// window, the TWAP followed and 24 WETH borrowed the whole market.
#[test]
fn pumping_every_world_for_a_minute_does_not_unlock_borrowing() {
    let (mut w, s, pools) = lending_world();
    w.split_ft(CAROL, s, Usdc, &[1, 2], 142_000 * E18).unwrap();
    for (i, y) in [(0usize, 100 * P0), (1, 100 * P1)] {
        // y * (sqrt 2 - 1) into the curve doubles the price.
        let amount_in = y * 414_213_562 / 1_000_000_000 * 1_000_000 / 997_000;
        w.call(CAROL, ONE_YOCTO, |c| {
            c.swap(pools[i], false, U128(amount_in), U128(0))
        })
        .unwrap();
    }
    w.warp(61);
    post_weth(&mut w, CAROL, s, 24 * E18);
    let borrowed = w.call(CAROL, ONE_YOCTO, |c| c.borrow(s, U128(100_000 * E18)));
    assert!(borrowed.is_err(), "{borrowed:?}");
    // While the pools sit this far from their TWAP the worlds are unpriced,
    // so nothing borrows against WETH there.
    w.call(CAROL, ONE_YOCTO, |c| c.borrow(s, U128(10_000 * E18)))
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
    post_weth(&mut w, ALICE, s, 10 * E18);
    w.call(ALICE, ONE_YOCTO, |c| c.borrow(s, U128(18_000 * E18)))
        .unwrap();
    w.split_ft(CAROL, s, Weth, &[1, 2], 19 * E18).unwrap();
    w.call(CAROL, ONE_YOCTO, |c| {
        c.swap(pools[1], true, U128(18_380_000_000_000_000_000), U128(0))
    })
    .unwrap();
    w.warp(61);
    let msg = format!(
        r#"{{"action":"liquidate","scenario_id":{s},"account_id":"{ALICE}","repay_amount":"max"}}"#
    );
    let liquidated = w.ft_transfer_call(CAROL, Usdc, 9_001 * E18 / scale(Usdc), &msg);
    assert!(liquidated.is_err(), "{liquidated:?}");
    assert_eq!(w.real(CAROL, Weth), 0);
}
