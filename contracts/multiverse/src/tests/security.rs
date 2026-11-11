//! Regression tests for the internal security review (docs/SECURITY.md).
//! Each test reproduces one finding against the unfixed code and pins the
//! fixed behaviour; the finding id is in the test's doc comment.

use near_sdk::json_types::U128;

use super::amm::pool_world;
use super::harness::*;
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
