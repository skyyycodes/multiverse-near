//! Real assets going out: the `ft_transfer` + `on_payout` pair, the failure
//! path that credits the internal balance (never re-mints), and dust.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::PromiseResult;

use super::harness::*;
use crate::types::Asset::{Usdc, Wnear};

const USDC_UNIT: u128 = 1_000_000_000_000;

#[test]
fn withdraw_schedules_ft_transfer_then_on_payout() {
    let mut w = World::new();
    w.deposit(ALICE, Usdc, 5 * E18).unwrap();
    w.auto_payouts = false;
    w.withdraw(ALICE, Usdc, 2 * E18).unwrap();
    assert_eq!(w.real(ALICE, Usdc), 3 * E18);
    let calls = w.last.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].receiver_id.as_str(), USDC_TOKEN);
    assert_eq!(calls[0].method, "ft_transfer");
    assert_eq!(
        calls[0].args,
        json!({"receiver_id": ALICE, "amount": "2000000", "memo": null})
    );
    assert_eq!((calls[0].deposit, calls[0].tgas), (1, 10));
    assert_eq!(calls[1].receiver_id.as_str(), CONTRACT);
    assert_eq!(calls[1].method, "on_payout");
    assert_eq!(
        calls[1].args,
        json!({"account_id": ALICE, "asset": "usdc", "amount": "2000000"})
    );
    assert_eq!(
        (calls[1].deposit, calls[1].tgas, calls[1].after.clone()),
        (0, 5, vec![0])
    );
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"multiverse","version":"2.0.0","event":"real_withdraw","data":[{"account_id":"alice.near","asset":"usdc","amount":"2000000000000000000"}]}"#
        ]
    );
}

#[test]
fn a_successful_payout_reaches_the_wallet() {
    let mut w = World::new();
    w.deposit(ALICE, Usdc, 5 * E18).unwrap();
    w.withdraw(ALICE, Usdc, 2 * E18).unwrap();
    assert_eq!(w.wallet(ALICE, Usdc), FUND - 3 * E18);
    assert_eq!(w.held_by_contract(Usdc), 3 * E18);
    assert_eq!(w.real(ALICE, Usdc), 3 * E18);
    assert_eq!(w.callbacks.len(), 1);
    assert!(w.callbacks[0].logs.is_empty());
}

#[test]
fn a_failed_payout_is_credited_back() {
    let mut w = World::new();
    w.deposit(ALICE, Usdc, 5 * E18).unwrap();
    w.ft_unregistered.insert(acc(ALICE));
    w.withdraw(ALICE, Usdc, 2 * E18).unwrap();
    assert_eq!(w.wallet(ALICE, Usdc), FUND - 5 * E18);
    assert_eq!(w.real(ALICE, Usdc), 5 * E18);
    assert_eq!(w.held_by_contract(Usdc), 5 * E18);
    assert_eq!(
        w.callbacks[0].logs,
        vec![
            r#"EVENT_JSON:{"standard":"multiverse","version":"2.0.0","event":"payout_failed","data":[{"account_id":"alice.near","asset":"usdc","token_amount":"2000000","credited":"2000000000000000000"}]}"#
        ]
    );
    // once registered with the token, the same balance withdraws fine
    w.ft_unregistered.clear();
    w.withdraw(ALICE, Usdc, 5 * E18).unwrap();
    assert_eq!(w.wallet(ALICE, Usdc), FUND);
    assert_eq!(w.real(ALICE, Usdc), 0);
}

#[test]
fn a_failed_merge_payout_is_credited_not_reminted() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &SINGLES, 2 * E18).unwrap();
    w.ft_unregistered.insert(acc(ALICE));
    w.merge(ALICE, 1, Wnear, &SINGLES, ROOT, 2 * E18).unwrap();
    // the verse side is settled for good
    assert_eq!(w.reserves(1, Wnear), 0);
    for m in SINGLES {
        assert_eq!(w.supply(1, Wnear, m), 0);
    }
    // the real side waits in the internal balance
    assert_eq!(w.real(ALICE, Wnear), 2 * E18);
    assert_eq!(w.held_by_contract(Wnear), 2 * E18);
    assert_eq!(w.wallet(ALICE, Wnear), FUND - 2 * E18);
    w.ft_unregistered.clear();
    w.withdraw(ALICE, Wnear, 2 * E18).unwrap();
    assert_eq!(w.wallet(ALICE, Wnear), FUND);
}

#[test]
fn usdc_dust_stays_in_the_internal_balance() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Usdc, &[SHIPS, DELAYED], 3 * E18)
        .unwrap();
    w.admin_resolve(w.spice, OUT_SHIPS).unwrap();
    // 1.5 USDC and 123 internal units: the units go out, the 123 stay
    w.redeem(ALICE, 1, Usdc, SHIPS, 15 * E18 / 10 + 123)
        .unwrap();
    assert_eq!(
        w.wallet(ALICE, Usdc),
        FUND - 3 * E18 + 1_500_000 * USDC_UNIT
    );
    assert_eq!(w.real(ALICE, Usdc), 123);
    assert_eq!(w.reserves(1, Usdc), 3 * E18 - 15 * E18 / 10 - 123);
    // below one token unit nothing is sent, and nothing is lost
    w.auto_payouts = false;
    w.withdraw(ALICE, Usdc, 123).unwrap();
    assert!(w.last.calls().is_empty());
    assert_eq!(w.real(ALICE, Usdc), 123);
    // the books: what the contract holds covers reserves plus internal balances
    assert_eq!(
        w.held_by_contract(Usdc),
        w.reserves(1, Usdc) + w.real(ALICE, Usdc)
    );
}

#[test]
fn withdraw_checks() {
    let mut w = World::new();
    fails(w.withdraw(ALICE, Wnear, 0), "ZeroAmount");
    fails(
        w.withdraw(ALICE, Wnear, 1),
        "InsufficientBalance(alice.near, 0, 1)",
    );
    fails(
        w.call(ALICE, NO_DEPOSIT, |c| c.withdraw(Wnear, U128(1))),
        "Requires attached deposit of exactly 1 yoctoNEAR",
    );
}

#[test]
fn on_payout_never_panics() {
    let mut w = World::new();
    // a failed payout to an account that has nothing here yet
    let ok = w
        .exec(CONTRACT, NO_DEPOSIT, vec![PromiseResult::Failed], |c| {
            c.on_payout(acc("dave.near"), Usdc, U128(7))
        })
        .unwrap();
    assert!(!ok);
    assert_eq!(w.real("dave.near", Usdc), 7 * USDC_UNIT);
    // absurd amounts saturate instead of overflowing
    w.exec(CONTRACT, NO_DEPOSIT, vec![PromiseResult::Failed], |c| {
        c.on_payout(acc("dave.near"), Usdc, U128(u128::MAX))
    })
    .unwrap();
    assert_eq!(w.real("dave.near", Usdc), u128::MAX);
    let ok = w
        .exec(
            CONTRACT,
            NO_DEPOSIT,
            vec![PromiseResult::Successful(vec![])],
            |c| c.on_payout(acc("dave.near"), Wnear, U128(1)),
        )
        .unwrap();
    assert!(ok);
    assert_eq!(w.real("dave.near", Wnear), 0);
}
