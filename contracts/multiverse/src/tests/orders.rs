//! The order book, test by test, plus the views and storage charging.
//!
//! The book lives in the contract, so there is no approval step: escrow and
//! fill payments are debited from the ledger, and a short balance fails as
//! `InsufficientBalance`. Posting for another account is a crate-internal
//! call made inside that account's receipt. Orders must be at least 0.001
//! wNEAR, so the unit-sized rounding cases keep their shape on a 0.001 wNEAR
//! order: a bid of 1e15 + 3 at 1.5 escrows 1.5e15 + 5 and its last three
//! 1-unit fills leave 2 units of dust for the maker.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::NearToken;
use proptest::prelude::*;

use super::harness::*;
use crate::masks::single_worlds;
use crate::orders::{OrderView, Side, MIN_ORDER_AMOUNT};
use crate::types::Asset::{self, Usdc, Wnear};
use crate::types::VerseKey;

pub const RAVI: &str = "ravi.near";
const PRICE: u128 = 2_450 * E18;
const HALF: u128 = E18 / 2;
const ONE_HALF: u128 = 1_500_000_000_000_000_000;

pub fn book() -> World {
    let mut w = World::new();
    w.register(RAVI, NearToken::from_near(1));
    w.fund(RAVI);
    w
}

/// Splits enough of the real asset for `who` into `[mask, other possible
/// singles]` (USDC rounded up to whole token units).
pub fn give(w: &mut World, who: &str, sid: u64, asset: Asset, mask: u8, amount: u128) {
    let possible = w.possible(sid);
    let mut parts = vec![mask];
    parts.extend(single_worlds(possible & !mask));
    let s = scale(asset);
    let amount = amount.div_ceil(s) * s;
    w.split_ft(who, sid, asset, &parts, amount).unwrap();
}

#[allow(clippy::too_many_arguments)]
pub fn post(
    w: &mut World,
    who: &str,
    sid: u64,
    mask: u8,
    side: Side,
    price: u128,
    amount: u128,
    expiry: u64,
) -> Result<u64, String> {
    w.call(who, ONE_YOCTO, |c| {
        c.post_order(sid, mask, side, U128(price), U128(amount), expiry)
            .0
    })
}

pub fn fill(
    w: &mut World,
    who: &str,
    id: u64,
    amount: u128,
    limit: u128,
) -> Result<(u128, u128), String> {
    w.call(who, ONE_YOCTO, |c| {
        let r = c.fill_order(U64(id), U128(amount), U128(limit));
        (r.paid.0, r.received.0)
    })
}

pub fn cancel(w: &mut World, who: &str, id: u64) -> Result<u128, String> {
    w.call(who, ONE_YOCTO, |c| c.cancel_order(U64(id)).0)
}

pub fn order(w: &mut World, id: u64) -> OrderView {
    w.view(|c| c.get_order(U64(id))).expect("order exists")
}

pub fn held(w: &mut World, sid: u64, asset: Asset, mask: u8) -> u128 {
    let key = VerseKey::new(sid, asset, mask);
    w.view(|c| c.escrow_holdings(&key))
}

fn expiry(w: &World) -> u64 {
    w.now + DAY
}

/// Ravi's bid: 1 wNEAR-if-DELAYED·HOLDS at 2,450.
fn ravi_bid(w: &mut World) -> u64 {
    let (s, e) = (w.s2x2, expiry(w));
    give(w, RAVI, s, Usdc, DELAYED_HOLDS, PRICE);
    post(w, RAVI, s, DELAYED_HOLDS, Side::Bid, PRICE, E18, e).unwrap()
}

fn ask(w: &mut World, who: &str, mask: u8, price: u128, amount: u128) -> u64 {
    let (s, e) = (w.s2x2, expiry(w));
    give(w, who, s, Wnear, mask, amount);
    post(w, who, s, mask, Side::Ask, price, amount, e).unwrap()
}

fn bid(w: &mut World, who: &str, mask: u8, price: u128, amount: u128) -> u64 {
    let (s, e) = (w.s2x2, expiry(w));
    give(
        w,
        who,
        s,
        Usdc,
        mask,
        multiverse_math::orders::cost(amount, price),
    );
    post(w, who, s, mask, Side::Bid, price, amount, e).unwrap()
}

// Post

#[test]
fn post_bid_escrows_usdc() {
    let mut w = book();
    let s = w.s2x2;
    let e = expiry(&w);
    give(&mut w, RAVI, s, Usdc, DELAYED_HOLDS, PRICE);
    let id = post(&mut w, RAVI, s, DELAYED_HOLDS, Side::Bid, PRICE, E18, e).unwrap();
    assert_eq!(
        w.last.data_of("order_posted"),
        vec![json!({
            "order_id": "1", "scenario_id": s, "maker": RAVI, "mask": DELAYED_HOLDS, "side": "bid",
            "price": PRICE.to_string(), "amount": E18.to_string(), "expiry_sec": e, "epoch": 0
        })]
    );
    assert_eq!(id, 1);
    assert_eq!(w.view(|c| c.order_count()), U64(1));
    let o = order(&mut w, id);
    assert_eq!(
        o,
        OrderView {
            id: U64(1),
            maker: acc(RAVI),
            scenario_id: s,
            mask: DELAYED_HOLDS,
            side: Side::Bid,
            price: U128(PRICE),
            amount: U128(E18),
            remaining: U128(E18),
            escrow: U128(PRICE),
            expiry_sec: e,
            epoch: 0,
        }
    );
    let key = w.view(|c| c.order(id).unwrap().escrow_key());
    assert_eq!(key, VerseKey::new(s, Usdc, DELAYED_HOLDS));
    assert_eq!(held(&mut w, s, Usdc, DELAYED_HOLDS), PRICE);
    assert_eq!(w.bal(RAVI, s, Usdc, DELAYED_HOLDS), 0);
    w.assert_conservation(&[ALICE, BOB, CAROL, RAVI]);
}

#[test]
fn post_ask_escrows_wnear() {
    let mut w = book();
    let s = w.s2x2;
    let id = ask(&mut w, RAVI, DELAYED_HOLDS, 2_800 * E18, 2 * E18);
    let o = order(&mut w, id);
    assert_eq!(o.side, Side::Ask);
    assert_eq!(o.escrow, U128(2 * E18));
    let key = w.view(|c| c.order(id).unwrap().escrow_key());
    assert_eq!(key, VerseKey::new(s, Wnear, DELAYED_HOLDS));
    assert_eq!(held(&mut w, s, Wnear, DELAYED_HOLDS), 2 * E18);
    assert_eq!(w.bal(RAVI, s, Wnear, DELAYED_HOLDS), 0);
}

#[test]
fn post_bid_escrow_rounds_up() {
    let mut w = book();
    let id = bid(&mut w, RAVI, DELAYED_HOLDS, ONE_HALF, MIN_ORDER_AMOUNT + 3);
    assert_eq!(order(&mut w, id).escrow, U128(1_500_000_000_000_005));
}

#[test]
fn post_accepts_any_live_mask() {
    let mut w = book();
    let s = w.s2x2;
    let b = bid(&mut w, RAVI, L_SHAPE, PRICE, E18);
    let a = ask(&mut w, RAVI, DELAYED, 2_800 * E18, E18);
    assert_eq!(order(&mut w, b).mask, L_SHAPE);
    assert_eq!(order(&mut w, a).mask, DELAYED);
    let fed = w.fed;
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    // DELAYED is half dead now (DELAYED_CUTS), still live
    let a2 = ask(&mut w, RAVI, DELAYED, 2_800 * E18, E18);
    let o = order(&mut w, a2);
    assert_eq!((o.mask, o.epoch), (DELAYED, 1));
    assert_eq!(o.scenario_id, s);
}

/// The router posts through `post_order_for`: the maker is the user, not the
/// account whose call it is.
#[test]
fn post_for_records_the_caller_as_maker() {
    let mut w = book();
    let (s, e) = (w.s2x2, expiry(&w));
    give(&mut w, RAVI, s, Usdc, DELAYED_HOLDS, PRICE);
    let ravi = acc(RAVI);
    let id = w
        .call(BOB, ONE_YOCTO, |c| {
            c.post_order_for(&ravi, s, DELAYED_HOLDS, Side::Bid, PRICE, E18, e)
        })
        .unwrap();
    assert_eq!(order(&mut w, id).maker, acc(RAVI));
    fails(cancel(&mut w, BOB, id), &format!("NotMaker({id})"));
    assert_eq!(cancel(&mut w, RAVI, id), Ok(PRICE));
    assert_eq!(w.bal(RAVI, s, Usdc, DELAYED_HOLDS), PRICE);
}

#[test]
fn post_fails() {
    let mut w = book();
    let (s, b, e) = (w.s2x2, w.s_bin, expiry(&w));
    let now = w.now;
    fails(
        post(&mut w, RAVI, s, DELAYED_HOLDS, Side::Bid, PRICE, 0, e),
        "ZeroAmount",
    );
    fails(
        post(
            &mut w,
            RAVI,
            s,
            DELAYED_HOLDS,
            Side::Bid,
            PRICE,
            MIN_ORDER_AMOUNT - 1,
            e,
        ),
        "OrderTooSmall(999999999999999, 1000000000000000)",
    );
    fails(
        post(&mut w, RAVI, s, DELAYED_HOLDS, Side::Bid, 0, E18, e),
        "ZeroPrice",
    );
    fails(
        post(&mut w, RAVI, s, DELAYED_HOLDS, Side::Bid, PRICE, E18, now),
        &format!("ExpiryInPast({now})"),
    );
    for mask in [0, ROOT, 0x10] {
        fails(
            post(&mut w, RAVI, s, mask, Side::Bid, PRICE, E18, e),
            &format!("InvalidMask({mask})"),
        );
    }
    fails(
        post(&mut w, RAVI, b, BIN_DELAYED | 0x4, Side::Bid, PRICE, E18, e),
        "InvalidMask(6)",
    );
    fails(
        post(&mut w, RAVI, 99, DELAYED_HOLDS, Side::Bid, PRICE, E18, e),
        "UnknownScenario(99)",
    );
    fails(
        post(&mut w, RAVI, s, DELAYED_HOLDS, Side::Ask, PRICE, E18, e),
        &format!("InsufficientBalance({RAVI}, 0, {E18})"),
    );
    let fed = w.fed;
    w.admin_resolve(fed, OUT_CUTS).unwrap();
    fails(
        post(&mut w, RAVI, s, DELAYED_HOLDS, Side::Bid, PRICE, E18, e),
        "DeadVerse(8)",
    );
    assert_eq!(w.view(|c| c.order_count()), U64(0));
}

// Fill

#[test]
fn fill_bid_full() {
    let mut w = book();
    let s = w.s2x2;
    let id = ravi_bid(&mut w);
    give(&mut w, ALICE, s, Wnear, DELAYED_HOLDS, E18);
    let (ravi_wnear, alice_usdc) = (
        w.bal(RAVI, s, Wnear, DELAYED_HOLDS),
        w.bal(ALICE, s, Usdc, DELAYED_HOLDS),
    );
    assert_eq!(fill(&mut w, ALICE, id, E18, PRICE), Ok((E18, PRICE)));
    assert_eq!(
        w.last.data_of("order_filled"),
        vec![json!({
            "order_id": "1", "scenario_id": s, "taker": ALICE, "amount": E18.to_string(),
            "usdc_amount": PRICE.to_string(), "remaining": "0"
        })]
    );
    assert_eq!(w.bal(RAVI, s, Wnear, DELAYED_HOLDS), ravi_wnear + E18);
    assert_eq!(w.bal(ALICE, s, Usdc, DELAYED_HOLDS), alice_usdc + PRICE);
    assert_eq!(held(&mut w, s, Usdc, DELAYED_HOLDS), 0);
    let o = order(&mut w, id);
    assert_eq!((o.remaining, o.escrow), (U128(0), U128(0)));
    w.assert_conservation(&[ALICE, BOB, CAROL, RAVI]);
}

#[test]
fn fill_bid_partial_rounds_down_and_refunds_dust() {
    let mut w = book();
    let s = w.s2x2;
    let size = MIN_ORDER_AMOUNT + 3;
    let id = bid(&mut w, RAVI, DELAYED_HOLDS, ONE_HALF, size);
    give(&mut w, ALICE, s, Wnear, DELAYED_HOLDS, size);
    let alice_usdc = w.bal(ALICE, s, Usdc, DELAYED_HOLDS);
    let ravi_usdc = w.bal(RAVI, s, Usdc, DELAYED_HOLDS);
    assert_eq!(
        fill(&mut w, ALICE, id, MIN_ORDER_AMOUNT, ONE_HALF),
        Ok((MIN_ORDER_AMOUNT, 1_500_000_000_000_000))
    );
    for _ in 0..3 {
        assert_eq!(fill(&mut w, ALICE, id, 1, ONE_HALF), Ok((1, 1)));
    }
    assert_eq!(
        w.bal(ALICE, s, Usdc, DELAYED_HOLDS),
        alice_usdc + 1_500_000_000_000_003
    );
    // 5 units escrowed for the 3-unit tail, 3 paid out: the maker gets 2 back
    assert_eq!(w.bal(RAVI, s, Usdc, DELAYED_HOLDS), ravi_usdc + 2);
    assert_eq!(held(&mut w, s, Usdc, DELAYED_HOLDS), 0);
    assert_eq!(w.bal(RAVI, s, Wnear, DELAYED_HOLDS), size);
    assert_eq!(order(&mut w, id).escrow, U128(0));
}

#[test]
fn fill_ask_partial_cost_rounds_up() {
    let mut w = book();
    let s = w.s2x2;
    let id = ask(&mut w, ALICE, DELAYED_HOLDS, ONE_HALF, MIN_ORDER_AMOUNT);
    give(&mut w, RAVI, s, Usdc, DELAYED_HOLDS, 2);
    let alice_usdc = w.bal(ALICE, s, Usdc, DELAYED_HOLDS);
    let ravi_wnear = w.bal(RAVI, s, Wnear, DELAYED_HOLDS);
    assert_eq!(fill(&mut w, RAVI, id, 1, ONE_HALF), Ok((2, 1)));
    let left = MIN_ORDER_AMOUNT - 1;
    assert_eq!(
        w.last.data_of("order_filled"),
        vec![json!({
            "order_id": id.to_string(), "scenario_id": s, "taker": RAVI, "amount": "1",
            "usdc_amount": "2", "remaining": left.to_string()
        })]
    );
    assert_eq!(w.bal(ALICE, s, Usdc, DELAYED_HOLDS), alice_usdc + 2);
    assert_eq!(w.bal(RAVI, s, Wnear, DELAYED_HOLDS), ravi_wnear + 1);
    let o = order(&mut w, id);
    assert_eq!((o.remaining, o.escrow), (U128(left), U128(left)));
    assert_eq!(held(&mut w, s, Wnear, DELAYED_HOLDS), left);
}

#[test]
fn fill_fails_not_open() {
    let mut w = book();
    let s = w.s2x2;
    fails(fill(&mut w, ALICE, 7, E18, 0), "OrderNotOpen(7)");
    let filled = ask(&mut w, RAVI, DELAYED_HOLDS, PRICE, E18);
    give(&mut w, ALICE, s, Usdc, DELAYED_HOLDS, 2 * PRICE);
    fill(&mut w, ALICE, filled, E18, PRICE).unwrap();
    fails(
        fill(&mut w, ALICE, filled, E18, PRICE),
        &format!("OrderNotOpen({filled})"),
    );
    let cancelled = ask(&mut w, RAVI, DELAYED_HOLDS, PRICE, E18);
    cancel(&mut w, RAVI, cancelled).unwrap();
    fails(
        fill(&mut w, ALICE, cancelled, E18, PRICE),
        &format!("OrderNotOpen({cancelled})"),
    );
}

#[test]
fn fill_fails_amount() {
    let mut w = book();
    let id = ravi_bid(&mut w);
    fails(fill(&mut w, ALICE, id, 0, 0), "ZeroAmount");
    // the amount is checked before the order exists
    fails(fill(&mut w, ALICE, 999, 0, 0), "ZeroAmount");
    fails(
        fill(&mut w, ALICE, id, E18 + 1, 0),
        &format!("AmountExceedsRemaining({id}, {}, {E18})", E18 + 1),
    );
}

#[test]
fn fill_fails_expired() {
    let mut w = book();
    let s = w.s2x2;
    let id = ravi_bid(&mut w);
    let e = order(&mut w, id).expiry_sec;
    give(&mut w, ALICE, s, Wnear, DELAYED_HOLDS, E18);
    w.now = e;
    fails(
        fill(&mut w, ALICE, id, E18, 0),
        &format!("OrderExpired({id}, {e})"),
    );
    // the second before expiry still fills
    w.now = e - 1;
    fill(&mut w, ALICE, id, E18, 0).unwrap();
}

#[test]
fn fill_fails_stale_after_resolution() {
    let mut w = book();
    let s = w.s2x2;
    let id = ravi_bid(&mut w);
    give(&mut w, ALICE, s, Wnear, DELAYED_HOLDS, E18);
    let fed = w.fed;
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    assert!(w.view(|c| c.is_live(s, DELAYED_HOLDS)));
    fails(
        fill(&mut w, ALICE, id, E18, 0),
        &format!("StaleOrder({id}, 0, 1)"),
    );
}

#[test]
fn fill_fails_dead_verse() {
    let mut w = book();
    let s = w.s2x2;
    let id = ravi_bid(&mut w);
    give(&mut w, ALICE, s, Wnear, DELAYED_HOLDS, E18);
    let spice = w.spice;
    w.admin_resolve(spice, OUT_SHIPS).unwrap();
    // dead wins over stale
    fails(fill(&mut w, ALICE, id, E18, 0), "DeadVerse(8)");
}

#[test]
fn fill_fails_while_resolution_pending() {
    let mut w = book();
    let s = w.s2x2;
    let id = ravi_bid(&mut w);
    give(&mut w, ALICE, s, Wnear, DELAYED_HOLDS, E18);
    let fed = w.fed;
    w.report(fed, OUT_HOLDS).unwrap();
    fails(
        fill(&mut w, ALICE, id, E18, 0),
        &format!("ScenarioHalted({s})"),
    );
    w.dispute(fed).unwrap();
    assert_eq!(fill(&mut w, ALICE, id, HALF, 0), Ok((HALF, PRICE / 2)));
    // still halted once the window is over, until someone finalizes
    w.report(fed, OUT_HOLDS).unwrap();
    w.warp(DISPUTE_WINDOW + 1);
    fails(
        fill(&mut w, ALICE, id, HALF, 0),
        &format!("ScenarioHalted({s})"),
    );
}

#[test]
fn post_and_cancel_work_while_halted() {
    let mut w = book();
    let fed = w.fed;
    w.report(fed, OUT_HOLDS).unwrap();
    let id = ravi_bid(&mut w);
    assert_eq!(cancel(&mut w, RAVI, id), Ok(PRICE));
}

#[test]
fn fill_fails_beyond_limit_price() {
    let mut w = book();
    let s = w.s2x2;
    let b = ravi_bid(&mut w);
    let a = ask(&mut w, RAVI, DELAYED_HOLDS, 2_800 * E18, E18);
    give(&mut w, ALICE, s, Wnear, DELAYED_HOLDS, E18);
    give(&mut w, ALICE, s, Usdc, DELAYED_HOLDS, 2_800 * E18);
    fails(
        fill(&mut w, ALICE, b, E18, 2_451 * E18),
        &format!("PriceBeyondLimit({b}, {PRICE}, {})", 2_451 * E18),
    );
    fails(
        fill(&mut w, ALICE, a, E18, 2_799 * E18),
        &format!("PriceBeyondLimit({a}, {}, {})", 2_800 * E18, 2_799 * E18),
    );
    // a limit equal to the price passes
    fill(&mut w, ALICE, b, HALF, PRICE).unwrap();
    fill(&mut w, ALICE, a, HALF, 2_800 * E18).unwrap();
}

#[test]
fn fill_fails_zero_value() {
    let mut w = book();
    let s = w.s2x2;
    let id = bid(&mut w, RAVI, DELAYED_HOLDS, HALF, MIN_ORDER_AMOUNT);
    give(&mut w, ALICE, s, Wnear, DELAYED_HOLDS, E18);
    fails(fill(&mut w, ALICE, id, 1, 0), "ZeroValue");
    assert_eq!(fill(&mut w, ALICE, id, 2, 0), Ok((2, 1)));
}

#[test]
fn fill_fails_without_payment() {
    let mut w = book();
    let b = ravi_bid(&mut w);
    let a = ask(&mut w, RAVI, DELAYED_HOLDS, PRICE, E18);
    fails(
        fill(&mut w, ALICE, b, E18, 0),
        &format!("InsufficientBalance({ALICE}, 0, {E18})"),
    );
    fails(
        fill(&mut w, ALICE, a, E18, PRICE),
        &format!("InsufficientBalance({ALICE}, 0, {PRICE})"),
    );
}

#[test]
fn self_fill_works() {
    let mut w = book();
    let s = w.s2x2;
    let id = ravi_bid(&mut w);
    give(&mut w, RAVI, s, Wnear, DELAYED_HOLDS, E18);
    let before = w.bal(RAVI, s, Usdc, DELAYED_HOLDS);
    assert_eq!(fill(&mut w, RAVI, id, E18, 0), Ok((E18, PRICE)));
    assert_eq!(w.bal(RAVI, s, Usdc, DELAYED_HOLDS), before + PRICE);
    assert_eq!(w.bal(RAVI, s, Wnear, DELAYED_HOLDS), E18);
}

#[test]
fn multi_world_ask_fills_directly() {
    let mut w = book();
    let s = w.s2x2;
    let id = ask(&mut w, RAVI, L_SHAPE, 3_000 * E18, E18);
    give(&mut w, ALICE, s, Usdc, L_SHAPE, 3_000 * E18);
    assert_eq!(
        fill(&mut w, ALICE, id, E18, 3_000 * E18),
        Ok((3_000 * E18, E18))
    );
    assert_eq!(w.bal(ALICE, s, Wnear, L_SHAPE), E18);
}

// Cancel

#[test]
fn cancel_returns_remaining_escrow() {
    let mut w = book();
    let s = w.s2x2;
    let id = bid(&mut w, RAVI, DELAYED_HOLDS, PRICE, 2 * E18);
    give(&mut w, ALICE, s, Wnear, DELAYED_HOLDS, HALF);
    fill(&mut w, ALICE, id, HALF, PRICE).unwrap();
    let before = w.bal(RAVI, s, Usdc, DELAYED_HOLDS);
    assert_eq!(cancel(&mut w, RAVI, id), Ok(3_675 * E18));
    assert_eq!(
        w.last.data_of("order_cancelled"),
        vec![json!({
            "order_id": id.to_string(), "scenario_id": s, "maker": RAVI,
            "remaining": (3 * HALF).to_string(), "refund": (3_675 * E18).to_string()
        })]
    );
    assert_eq!(w.bal(RAVI, s, Usdc, DELAYED_HOLDS), before + 3_675 * E18);
    assert_eq!(held(&mut w, s, Usdc, DELAYED_HOLDS), 0);
    let o = order(&mut w, id);
    assert_eq!((o.remaining, o.escrow), (U128(0), U128(0)));
    // a closed order keeps everything else
    assert_eq!(
        (o.amount, o.price, o.maker),
        (U128(2 * E18), U128(PRICE), acc(RAVI))
    );
}

#[test]
fn cancel_after_resolution_and_expiry() {
    let mut w = book();
    let s = w.s2x2;
    let b = ravi_bid(&mut w);
    let a = ask(&mut w, RAVI, SHIPS_CUTS, 3_700 * E18, E18);
    let spice = w.spice;
    w.admin_resolve(spice, OUT_SHIPS).unwrap();
    w.warp(2 * DAY);
    // the dead token comes back as it is
    assert_eq!(cancel(&mut w, RAVI, b), Ok(PRICE));
    assert_eq!(w.bal(RAVI, s, Usdc, DELAYED_HOLDS), PRICE);
    assert_eq!(cancel(&mut w, RAVI, a), Ok(E18));
    assert_eq!(w.bal(RAVI, s, Wnear, SHIPS_CUTS), E18);
}

#[test]
fn cancel_fails() {
    let mut w = book();
    let s = w.s2x2;
    let id = ravi_bid(&mut w);
    fails(cancel(&mut w, ALICE, id), &format!("NotMaker({id})"));
    fails(cancel(&mut w, BOB, id), &format!("NotMaker({id})"));
    fails(cancel(&mut w, RAVI, 42), "NotMaker(42)");
    cancel(&mut w, RAVI, id).unwrap();
    fails(cancel(&mut w, RAVI, id), &format!("OrderNotOpen({id})"));
    let filled = ravi_bid(&mut w);
    give(&mut w, ALICE, s, Wnear, DELAYED_HOLDS, E18);
    fill(&mut w, ALICE, filled, E18, 0).unwrap();
    fails(
        cancel(&mut w, RAVI, filled),
        &format!("OrderNotOpen({filled})"),
    );
}

#[test]
fn public_methods_need_one_yocto() {
    let mut w = book();
    let s = w.s2x2;
    let e = expiry(&w);
    let msg = "Requires attached deposit of exactly 1 yoctoNEAR";
    fails(
        w.call(RAVI, NO_DEPOSIT, |c| {
            c.post_order(s, DELAYED_HOLDS, Side::Bid, U128(PRICE), U128(E18), e)
        }),
        msg,
    );
    fails(
        w.call(RAVI, NO_DEPOSIT, |c| {
            c.fill_order(U64(1), U128(E18), U128(0))
        }),
        msg,
    );
    fails(w.call(RAVI, NO_DEPOSIT, |c| c.cancel_order(U64(1))), msg);
}

// Views

#[test]
fn get_order_unknown_is_null() {
    let mut w = book();
    assert_eq!(w.view(|c| c.get_order(U64(5))), None);
    assert!(w.view(|c| c.order(5)).is_none());
}

#[test]
fn order_ids_are_strings_in_json() {
    let mut w = book();
    let id = ravi_bid(&mut w);
    let v = near_sdk::serde_json::to_value(order(&mut w, id)).unwrap();
    assert_eq!(v["id"], json!("1"));
    assert_eq!(v["side"], json!("bid"));
    assert_eq!(v["price"], json!(PRICE.to_string()));
}

#[test]
fn orders_for_world_sorts_best_first() {
    let mut w = book();
    let s = w.s2x2;
    let b1 = bid(&mut w, RAVI, DELAYED_HOLDS, 2_400 * E18, E18);
    let b2 = bid(&mut w, BOB, DELAYED_HOLDS, 2_450 * E18, E18);
    let b3 = bid(&mut w, ALICE, DELAYED_HOLDS, 2_400 * E18, E18);
    let a1 = ask(&mut w, RAVI, DELAYED_HOLDS, 2_600 * E18, E18);
    let a2 = ask(&mut w, BOB, DELAYED_HOLDS, 2_550 * E18, E18);
    let a3 = ask(&mut w, ALICE, DELAYED_HOLDS, 2_600 * E18, E18);
    // other worlds and multi-world masks stay out of this world's book
    bid(&mut w, RAVI, SHIPS_HOLDS, 3_000 * E18, E18);
    ask(&mut w, RAVI, HOLDS, 2_000 * E18, E18);
    let ids = |v: Vec<OrderView>| v.into_iter().map(|o| o.id.0).collect::<Vec<_>>();
    let book = w.view(|c| c.orders_for_world(s, 3, None));
    assert_eq!(ids(book.bids), vec![b2, b1, b3]);
    assert_eq!(ids(book.asks), vec![a2, a1, a3]);
    let top = w.view(|c| c.orders_for_world(s, 3, Some(1)));
    assert_eq!((ids(top.bids), ids(top.asks)), (vec![b2], vec![a2]));

    // filled and cancelled orders leave the index
    give(&mut w, ALICE, s, Wnear, DELAYED_HOLDS, E18);
    fill(&mut w, ALICE, b2, E18, 0).unwrap();
    cancel(&mut w, BOB, a2).unwrap();
    let book = w.view(|c| c.orders_for_world(s, 3, None));
    assert_eq!(ids(book.bids), vec![b1, b3]);
    assert_eq!(ids(book.asks), vec![a1, a3]);
    let indexed = w.view(|c| c.open_by_world.get(&(s, 3)).cloned().unwrap());
    assert_eq!(indexed, vec![b1, b3, a1, a3]);

    // expired orders drop out of the book but stay open for their maker
    w.warp(DAY);
    let book = w.view(|c| c.orders_for_world(s, 3, None));
    assert!(book.bids.is_empty() && book.asks.is_empty());
    assert_eq!(ids(w.view(|c| c.orders_by_maker(acc(RAVI), s))).len(), 4);
}

#[test]
fn orders_for_world_drops_stale_and_dead() {
    let mut w = book();
    let s = w.s2x2;
    bid(&mut w, RAVI, DELAYED_HOLDS, PRICE, E18);
    bid(&mut w, RAVI, SHIPS_CUTS, PRICE, E18);
    let fed = w.fed;
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    let fresh = bid(&mut w, RAVI, DELAYED_HOLDS, PRICE, E18);
    let book = w.view(|c| c.orders_for_world(s, 3, None));
    assert_eq!(
        book.bids.iter().map(|o| o.id.0).collect::<Vec<_>>(),
        vec![fresh]
    );
    let dead = w.view(|c| c.orders_for_world(s, 0, None));
    assert!(dead.bids.is_empty());
    let out_of_range = w.view(|c| c.orders_for_world(s, 7, None));
    assert!(out_of_range.bids.is_empty() && out_of_range.asks.is_empty());
    fails(
        w.try_view(|c| c.orders_for_world(99, 0, None)),
        "UnknownScenario(99)",
    );
}

#[test]
fn open_orders_and_orders_by_maker() {
    let mut w = book();
    let (s, b) = (w.s2x2, w.s_bin);
    let o1 = bid(&mut w, RAVI, DELAYED_HOLDS, PRICE, E18);
    let o2 = ask(&mut w, BOB, L_SHAPE, PRICE, E18);
    let o3 = bid(&mut w, RAVI, HOLDS, PRICE, E18);
    let e = expiry(&w);
    give(&mut w, RAVI, b, Wnear, BIN_SHIPS, E18);
    let o4 = post(&mut w, RAVI, b, BIN_SHIPS, Side::Ask, PRICE, E18, e).unwrap();
    cancel(&mut w, RAVI, o3).unwrap();
    let ids = |v: Vec<OrderView>| v.into_iter().map(|o| o.id.0).collect::<Vec<_>>();
    assert_eq!(ids(w.view(|c| c.open_orders(s, None, None))), vec![o1, o2]);
    assert_eq!(
        ids(w.view(|c| c.open_orders(s, Some(U64(2)), None))),
        vec![o2]
    );
    assert_eq!(ids(w.view(|c| c.open_orders(s, None, Some(1)))), vec![o1]);
    assert_eq!(ids(w.view(|c| c.open_orders(b, None, None))), vec![o4]);
    assert_eq!(ids(w.view(|c| c.orders_by_maker(acc(RAVI), s))), vec![o1]);
    assert_eq!(ids(w.view(|c| c.orders_by_maker(acc(BOB), s))), vec![o2]);
    assert_eq!(ids(w.view(|c| c.orders_by_maker(acc(RAVI), b))), vec![o4]);
    assert!(w.view(|c| c.orders_by_maker(acc(ALICE), s)).is_empty());
}

// Storage

#[test]
fn post_charges_the_maker_and_cancel_credits_the_index() {
    let mut w = book();
    let (s, e) = (w.s2x2, expiry(&w));
    give(&mut w, RAVI, s, Usdc, DELAYED_HOLDS, 2 * PRICE);
    let before = w.storage_used(RAVI);
    let id = post(&mut w, RAVI, s, DELAYED_HOLDS, Side::Bid, PRICE, E18, e).unwrap();
    let after_post = w.storage_used(RAVI);
    assert!(after_post > before + 100, "an order record costs its maker");
    // the record stays (closed orders are kept); the index entry goes
    cancel(&mut w, RAVI, id).unwrap();
    let after_cancel = w.storage_used(RAVI);
    assert!(after_cancel < after_post && after_cancel > before);
}

#[test]
fn post_fails_without_storage_and_rolls_back() {
    let mut w = book();
    let (s, e) = (w.s2x2, expiry(&w));
    give(&mut w, RAVI, s, Usdc, DELAYED_HOLDS, PRICE);
    w.call(RAVI, ONE_YOCTO, |c| c.storage_withdraw(None))
        .unwrap();
    let err = post(&mut w, RAVI, s, DELAYED_HOLDS, Side::Bid, PRICE, E18, e).unwrap_err();
    assert!(err.starts_with("InsufficientStorage("), "{err}");
    assert_eq!(w.view(|c| c.order_count()), U64(0));
    assert_eq!(w.bal(RAVI, s, Usdc, DELAYED_HOLDS), PRICE);
}

#[test]
fn fill_charges_the_taker() {
    let mut w = book();
    let s = w.s2x2;
    let id = ravi_bid(&mut w);
    give(&mut w, ALICE, s, Wnear, DELAYED_HOLDS, 2 * E18);
    let alice = w.storage_used(ALICE);
    let ravi = w.storage_used(RAVI);
    fill(&mut w, ALICE, id, E18, 0).unwrap();
    // the taker pays for her new USDC-if-w entry and for the maker's new
    // wNEAR-if-w entry
    assert!(w.storage_used(ALICE) > alice);
    assert_eq!(w.storage_used(RAVI), ravi);
}

#[test]
fn open_order_blocks_unregister() {
    let mut w = book();
    let id = ravi_bid(&mut w);
    let s = w.s2x2;
    // move everything else out so only the order is left
    let ravi = acc(RAVI);
    assert!(w.view(|c| c.has_open_orders(&ravi)));
    for m in [SHIPS_CUTS, DELAYED_CUTS, SHIPS_HOLDS] {
        let b = w.bal(RAVI, s, Usdc, m);
        if b > 0 {
            w.mt_transfer(RAVI, BOB, &token_id(s, Usdc, m), b).unwrap();
        }
    }
    let err = w
        .call(RAVI, ONE_YOCTO, |c| c.storage_unregister(None))
        .unwrap_err();
    assert_eq!(err, format!("AccountNotEmpty({RAVI})"));
    cancel(&mut w, RAVI, id).unwrap();
    assert!(!w.view(|c| c.has_open_orders(&ravi)));
}

// Fuzz

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, failure_persistence: None, ..ProptestConfig::default() })]

    #[test]
    fn fuzz_post_fill_cancel(
        amount in MIN_ORDER_AMOUNT..=1_000_000_000_000_000_000_000_000_000_000u128,
        price in 1u128..=1_000_000_000_000_000_000_000_000u128,
        fill_frac in any::<u128>(),
        mask in 0u8..=15,
        is_ask in any::<bool>(),
    ) {
        let filled_amount = 1 + fill_frac % amount;
        fuzz_case(amount, price, filled_amount, mask, is_ask)?;
    }
}

fn fuzz_case(
    amount: u128,
    price: u128,
    fill_amount: u128,
    mask: u8,
    is_ask: bool,
) -> Result<(), TestCaseError> {
    use multiverse_math::orders::{cost, proceeds};
    let mut w = book();
    let (s, e) = (w.s2x2, expiry(&w));
    let side = if is_ask { Side::Ask } else { Side::Bid };
    if mask == 0 || mask == ROOT {
        let r = post(&mut w, RAVI, s, mask, side, price, amount, e);
        prop_assert_eq!(r, Err(format!("InvalidMask({mask})")));
        return Ok(());
    }
    let escrow = if is_ask { amount } else { cost(amount, price) };
    let (esc_asset, pay_asset) = if is_ask { (Wnear, Usdc) } else { (Usdc, Wnear) };
    give(&mut w, RAVI, s, esc_asset, mask, escrow);
    let id = post(&mut w, RAVI, s, mask, side, price, amount, e).unwrap();
    prop_assert_eq!(held(&mut w, s, esc_asset, mask), escrow);

    let usdc_leg = if is_ask {
        cost(fill_amount, price)
    } else {
        proceeds(fill_amount, price)
    };
    let pay = if is_ask { usdc_leg } else { fill_amount };
    give(&mut w, ALICE, s, pay_asset, mask, pay);
    let maker_before = w.bal(RAVI, s, pay_asset, mask);
    let maker_esc_before = w.bal(RAVI, s, esc_asset, mask);
    let limit = if is_ask { u128::MAX } else { 0 };
    let r = fill(&mut w, ALICE, id, fill_amount, limit);
    let mut filled = 0;
    if !is_ask && usdc_leg == 0 {
        prop_assert_eq!(r, Err("ZeroValue".to_string()));
    } else {
        let expected = if is_ask {
            (usdc_leg, fill_amount)
        } else {
            (fill_amount, usdc_leg)
        };
        prop_assert_eq!(r, Ok(expected));
        filled = fill_amount;
        let got = if is_ask { usdc_leg } else { fill_amount };
        prop_assert_eq!(w.bal(RAVI, s, pay_asset, mask), maker_before + got);
    }
    let left = amount - filled;
    let held_now = held(&mut w, s, esc_asset, mask);
    let paid_out = if filled == 0 { 0 } else { usdc_leg };
    if left == 0 {
        prop_assert_eq!(held_now, 0);
        prop_assert_eq!(order(&mut w, id).escrow, U128(0));
        if !is_ask {
            prop_assert_eq!(
                w.bal(RAVI, s, esc_asset, mask),
                maker_esc_before + escrow - paid_out
            );
        }
        return Ok(());
    }
    let expected_held = if is_ask { left } else { escrow - paid_out };
    prop_assert_eq!(held_now, expected_held);
    if !is_ask {
        prop_assert!(held_now >= cost(left, price));
    }
    let before = w.bal(RAVI, s, esc_asset, mask);
    prop_assert_eq!(cancel(&mut w, RAVI, id), Ok(held_now));
    prop_assert_eq!(w.bal(RAVI, s, esc_asset, mask), before + held_now);
    prop_assert_eq!(held(&mut w, s, esc_asset, mask), 0);
    w.assert_conservation(&[ALICE, BOB, CAROL, RAVI]);
    Ok(())
}
