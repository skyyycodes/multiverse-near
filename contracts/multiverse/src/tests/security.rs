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
