//! Pledges (SPEC-C 3.7.1, K7): the `pledge` action's checks and effects, the
//! 24-decimal remainder, withdrawals by asset and amount, and the storage
//! rule that a pledger cannot unregister.

use near_sdk::json_types::U128;

use super::catalog_fixture::*;
use crate::catalog::PledgeReturn;
use crate::ops::PauseFlag;
use crate::types::Asset::{self, Usdc, Wnear};

fn withdraw(
    w: &mut World,
    who: &str,
    pid: u64,
    wnear: Option<u128>,
    usdc: Option<u128>,
) -> Result<PledgeReturn, String> {
    w.call(who, ONE_YOCTO, |c| {
        c.withdraw_pledge(pid, wnear.map(U128), usdc.map(U128))
    })
}

fn pledge_of(w: &mut World, pid: u64, who: &str) -> Option<(u128, u128)> {
    w.view(|c| c.pledge_of(pid, acc(who)))
        .map(|p| (p.wnear.0, p.usdc.0))
}

#[test]
fn pledge_check_order_and_effects() {
    let mut w = market_world();
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    let bits = PauseFlag::bits_of(&[PauseFlag::Pledge]);
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = bits).unwrap();
    fails(
        pledge(&mut w, ALICE, pid, Usdc, 100 * E18),
        "Paused(pledge)",
    );
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = 0).unwrap();
    fails(
        pledge(&mut w, ALICE, 99, Usdc, 100 * E18),
        "UnknownProposal(99)",
    );
    let min = params(&mut w).min_pledge_usdc.0;
    fails(
        pledge(&mut w, ALICE, pid, Usdc, min - E18),
        &format!("PledgeTooSmall({}, {min})", min - E18),
    );
    fails(
        w.ft_transfer_call(
            ALICE,
            Usdc,
            100_000_000,
            &format!(r#"{{"action":"pledge","proposal_id":{pid},"x":1}}"#),
        )
        .map(|_| ()),
        "BadMessage(unknown field `x`, expected `proposal_id`)",
    );
    let wallet = w.wallet(ALICE, Usdc);
    let real = w.real(ALICE, Usdc);
    assert_eq!(pledge(&mut w, ALICE, pid, Usdc, 100 * E18).unwrap(), 0);
    assert_eq!(w.wallet(ALICE, Usdc), wallet - 100 * E18);
    assert_eq!(
        w.real(ALICE, Usdc),
        real,
        "the whole credit goes into escrow"
    );
    let ev = logged(&w, "pledged")[0].clone();
    assert_eq!(
        (
            ev["asset"].as_str(),
            u(&ev["amount"]),
            u(&ev["escrow_usdc"])
        ),
        (Some("usdc"), 100 * E18, 100 * E18)
    );
    // A top-up of an existing pledge may be below the minimum.
    pledge(&mut w, ALICE, pid, Usdc, E18).unwrap();
    pledge(&mut w, ALICE, pid, Wnear, 5 * E18).unwrap();
    assert_eq!(pledge_of(&mut w, pid, ALICE), Some((5 * E18, 101 * E18)));
    let p = record(&mut w, pid);
    assert_eq!(
        (p.escrow_wnear, p.escrow_usdc, p.pledgers),
        (5 * E18, 101 * E18, 1)
    );
    let alice = acc(ALICE);
    assert_eq!(w.view(|c| c.account_markets(&alice)).pledges, vec![pid]);
    assert_books(&mut w);
    // The per-account cap counts pledge records.
    set_params(&mut w, |p| p.max_pledges_per_account = 1).unwrap();
    let other = propose_event(&mut w, DAVE).unwrap();
    fails(
        pledge(&mut w, ALICE, other, Usdc, 100 * E18),
        "TooManyPledges(1)",
    );
    pledge(&mut w, ALICE, pid, Usdc, E18).unwrap();
    // A cancelled proposal takes no pledge.
    let far = far_deadline(&w);
    let spare = propose_event_with(&mut w, CAROL, "Spare?", TERMS, far).unwrap();
    w.call(CAROL, ONE_YOCTO, |c| c.cancel_proposal(spare))
        .unwrap();
    fails(
        pledge(&mut w, BOB, spare, Usdc, 100 * E18),
        &format!("ProposalClosed({spare}, cancelled)"),
    );
}

#[test]
fn the_sub_unit_remainder_of_a_24_decimal_pledge_is_refunded() {
    let mut w = market_world_with_decimals(24);
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    let raw = 5 * 10u128.pow(24) + 7;
    let wallet = w.wallet_raw(ALICE, Wnear);
    let msg = format!(r#"{{"action":"pledge","proposal_id":{pid}}}"#);
    let refund = w.ft_transfer_call(ALICE, Wnear, raw, &msg).unwrap();
    assert_eq!(refund, 7);
    assert_eq!(w.wallet_raw(ALICE, Wnear), wallet - raw + 7);
    assert_eq!(record(&mut w, pid).escrow_wnear, 5 * E18);
    assert_books(&mut w);
}

#[test]
fn withdraw_pledge_check_order_and_amounts() {
    let mut w = market_world();
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    pledge(&mut w, ALICE, pid, Usdc, 100 * E18).unwrap();
    pledge(&mut w, ALICE, pid, Wnear, 50 * E18).unwrap();
    let bits = PauseFlag::bits_of(&[PauseFlag::Exit]);
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = bits).unwrap();
    fails(withdraw(&mut w, ALICE, pid, None, None), "Paused(exit)");
    // The guardian's flags never stop an exit.
    let guardian = PauseFlag::bits_of(&PauseFlag::GUARDIAN);
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = guardian)
        .unwrap();
    withdraw(&mut w, ALICE, pid, Some(0), Some(E18)).unwrap();
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = 0).unwrap();
    fails(
        withdraw(&mut w, ALICE, 99, None, None),
        "UnknownProposal(99)",
    );
    fails(
        withdraw(&mut w, BOB, pid, None, None),
        &format!("NoPledge({pid}, {BOB})"),
    );
    fails(withdraw(&mut w, ALICE, pid, Some(0), Some(0)), "ZeroAmount");
    fails(
        withdraw(&mut w, ALICE, pid, Some(51 * E18), None),
        &format!("InsufficientPledge(wnear, {}, {})", 50 * E18, 51 * E18),
    );
    fails(
        withdraw(&mut w, ALICE, pid, Some(49 * E18), Some(E18)),
        &format!(
            "PledgeTooSmall({}, {})",
            E18,
            params(&mut w).min_pledge_wnear.0
        ),
    );
    // Exactly x of one asset, none of the other.
    let wallet = w.wallet(ALICE, Usdc);
    let r = withdraw(&mut w, ALICE, pid, Some(0), Some(9 * E18)).unwrap();
    assert_eq!((r.wnear.0, r.usdc.0), (0, 9 * E18));
    assert_eq!(w.wallet(ALICE, Usdc), wallet + 9 * E18);
    assert_eq!(pledge_of(&mut w, pid, ALICE), Some((50 * E18, 90 * E18)));
    assert_eq!(logged(&w, "pledge_returned")[0]["reason"], "withdraw");
    // None = all of that asset.
    let r = withdraw(&mut w, ALICE, pid, None, Some(0)).unwrap();
    assert_eq!((r.wnear.0, r.usdc.0), (50 * E18, 0));
    // Both None = everything; the emptied record goes.
    let r = withdraw(&mut w, ALICE, pid, None, None).unwrap();
    assert_eq!((r.wnear.0, r.usdc.0), (0, 90 * E18));
    assert_eq!(pledge_of(&mut w, pid, ALICE), None);
    assert_eq!(record(&mut w, pid).pledgers, 0);
    let alice = acc(ALICE);
    assert!(w.view(|c| c.account_markets(&alice)).pledges.is_empty());
    assert_books(&mut w);
    // After the opening the pledge is a seed claim.
    fund(&mut w, pid);
    let sid = replay_auto_open(&mut w)[0].unwrap();
    fails(
        withdraw(&mut w, ALICE, pid, None, None),
        &format!("AlreadyOpen({pid}, {sid})"),
    );
}

#[test]
fn pledgers_and_proposers_cannot_unregister() {
    let mut w = market_world();
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    pledge(&mut w, CAROL, pid, Usdc, 100 * E18).unwrap();
    // Carol's other balances: settle them so only the pledge holds her.
    for asset in Asset::ALL {
        let real = w.real(CAROL, asset);
        if real > 0 {
            w.call(CAROL, ONE_YOCTO, |c| c.withdraw(asset, U128(real)))
                .unwrap();
        }
    }
    let unregister =
        |w: &mut World, who: &str| w.call(who, ONE_YOCTO, |c| c.storage_unregister(None));
    fails(
        unregister(&mut w, CAROL),
        &format!("AccountNotEmpty({CAROL})"),
    );
    fails(
        unregister(&mut w, DAVE),
        &format!("AccountNotEmpty({DAVE})"),
    );
    withdraw(&mut w, CAROL, pid, None, None).unwrap();
    assert!(unregister(&mut w, CAROL).unwrap());
    w.call(DAVE, ONE_YOCTO, |c| c.cancel_proposal(pid)).unwrap();
    // The bond and the reserve were credited to Dave's deposit: unregistering
    // refunds them with it.
    let deposit = deposit_of(&mut w, DAVE);
    assert!(unregister(&mut w, DAVE).unwrap());
    let sent: u128 = w.last.near_transfers().iter().map(|(_, a)| a).sum();
    assert!(sent > 0 && sent <= deposit);
}
