//! Lazy, monotone status (SPEC-C 3.7.2-3.7.3): every way a proposal ends,
//! what its bond and reserve do, settling once, and cancelling.

use proptest::prelude::*;

use super::catalog_fixture::*;
use crate::catalog::{ProposalStatus, ProposalViewStatus, VoidReason};
use crate::types::Asset::Usdc;

fn settle(w: &mut World, pid: u64) -> ProposalStatus {
    w.call(CAROL, NO_DEPOSIT, |c| c.settle_proposal(pid))
        .unwrap()
}

/// (status, void reason) as the view reports them.
fn status(w: &mut World, pid: u64) -> (ProposalViewStatus, Option<VoidReason>) {
    let v = proposal_view(w, pid);
    (v.status, v.void_reason)
}

/// Settles `pid` and checks what came back to the proposer: the bond (unless
/// forfeited) and the reserve; a second settle does nothing.
fn settle_and_check(w: &mut World, pid: u64, who: &str, forfeit: bool) {
    let p = record(w, pid);
    let before = deposit_of(w, who);
    let fund = storage_fund(w);
    let end = settle(w, pid);
    let ev = logged(w, "proposal_settled")[0].clone();
    let (returned, forfeited) = if forfeit { (0, p.bond) } else { (p.bond, 0) };
    assert_eq!(u(&ev["bond_returned"]), returned);
    assert_eq!(u(&ev["bond_forfeited"]), forfeited);
    assert_eq!(u(&ev["reserve_returned"]), p.reserve);
    assert_eq!(deposit_of(w, who), before + returned + p.reserve);
    assert_eq!(storage_fund(w), fund + forfeited);
    let stored = record(w, pid);
    assert_eq!(stored.status, end);
    assert_eq!((stored.bond, stored.reserve), (0, 0));
    // Idempotent.
    assert_eq!(settle(w, pid), end);
    assert!(logged(w, "proposal_settled").is_empty());
    assert_books(w);
}

#[test]
fn review_times_out() {
    let mut w = market_world();
    let pid = propose_event(&mut w, DAVE).unwrap();
    let ttl = params(&mut w).review_ttl_sec;
    w.warp(ttl - 1);
    assert_eq!(status(&mut w, pid).0, ProposalViewStatus::Review);
    w.warp(1);
    assert_eq!(
        status(&mut w, pid),
        (ProposalViewStatus::Void, Some(VoidReason::ReviewTimeout))
    );
    fails(
        approve(&mut w, pid, None),
        &format!("ProposalClosed({pid}, void)"),
    );
    settle_and_check(&mut w, pid, DAVE, false);
    assert!(w.view(|c| c.catalog.texts.get(&pid).is_none()));
    let dave = acc(DAVE);
    assert!(w.view(|c| c.account_markets(&dave)).proposals.is_empty());
}

#[test]
fn a_resolved_event_voids_its_combinations() {
    let mut w = market_world();
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    pledge(&mut w, ALICE, pid, Usdc, 100 * E18).unwrap();
    w.admin_resolve(fed, 0).unwrap();
    assert_eq!(
        status(&mut w, pid),
        (ProposalViewStatus::Void, Some(VoidReason::EventResolved))
    );
    fails(
        pledge(&mut w, BOB, pid, Usdc, 100 * E18),
        &format!("ProposalClosed({pid}, void)"),
    );
    settle_and_check(&mut w, pid, DAVE, false);
    assert!(w.view(|c| c.catalog.live_of_event.get(&fed).is_none()));
    // The pledge is refunded in full.
    let r = w
        .call(ALICE, ONE_YOCTO, |c| c.withdraw_pledge(pid, None, None))
        .unwrap();
    assert_eq!(r.usdc.0, 100 * E18);
    assert_books(&mut w);
}

#[test]
fn a_full_event_voids_its_combinations() {
    let mut w = market_world();
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    for _ in 0..15 {
        w.create_scenario(&[fed]).unwrap();
    }
    assert_eq!(
        status(&mut w, pid),
        (ProposalViewStatus::Void, Some(VoidReason::EventFull))
    );
    settle_and_check(&mut w, pid, DAVE, false);
}

#[test]
fn listing_a_market_on_the_set_voids_the_proposal_for_good() {
    let mut w = market_world();
    let fed = w.fed;
    // An unlisted owner duplicate blocks nothing.
    let dup = w.create_scenario(&[fed]).unwrap();
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    seed_worlds(&mut w, dup, &DEMO_BIN, &[DEPTH; 2]);
    seed_odds(&mut w, dup, &independent_odds(2, 5_000, 0), ODDS_DEPTH);
    let p = record(&mut w, pid);
    let dave = deposit_of(&mut w, DAVE);
    list(&mut w, dup, true).unwrap();
    assert_eq!(deposit_of(&mut w, DAVE), dave + p.bond + p.reserve);
    let stored = record(&mut w, pid);
    assert_eq!(
        (stored.status, stored.void_reason),
        (ProposalStatus::Void, VoidReason::MarketExists)
    );
    assert_eq!(
        logged(&w, "proposal_settled")[0]["void_reason"],
        "market_exists"
    );
    // Unlisting does not revive it.
    list(&mut w, dup, false).unwrap();
    assert_eq!(status(&mut w, pid).0, ProposalViewStatus::Void);
    assert_books(&mut w);
}

#[test]
fn expiry_forfeits_the_bond_only_under_the_spam_floor() {
    let mut w = market_world();
    let (fed, spice) = (w.fed, w.spice);
    let (e, _) = owner_market(&mut w, "Will it snow in Delhi?", &DEMO_BIN, 5_000);
    w.warp(WINDOW);
    let low = propose_market(&mut w, DAVE, &[fed]).unwrap();
    let high = propose_market(&mut w, CAROL, &[e, spice]).unwrap();
    pledge(&mut w, ALICE, low, Usdc, 100 * E18).unwrap();
    // 10% of the goal at s_hint keeps the bond.
    let goal = record(&mut w, high).goal;
    pledge(&mut w, BOB, high, Usdc, whole(Usdc, goal / 10)).unwrap();
    let expiry = record(&mut w, low).expires_at_sec;
    w.warp(expiry - w.now);
    assert_eq!(status(&mut w, low), (ProposalViewStatus::Expired, None));
    fails(
        pledge(&mut w, ALICE, low, Usdc, 100 * E18),
        &format!("ProposalClosed({low}, expired)"),
    );
    settle_and_check(&mut w, low, DAVE, true);
    settle_and_check(&mut w, high, CAROL, false);
}

#[test]
fn withdrawing_settles_an_ended_proposal_first() {
    let mut w = market_world();
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    pledge(&mut w, ALICE, pid, Usdc, 100 * E18).unwrap();
    let expiry = record(&mut w, pid).expires_at_sec;
    w.warp(expiry - w.now);
    let dave = deposit_of(&mut w, DAVE);
    w.call(ALICE, ONE_YOCTO, |c| c.withdraw_pledge(pid, None, None))
        .unwrap();
    assert_eq!(logged(&w, "proposal_settled").len(), 1);
    assert_eq!(record(&mut w, pid).status, ProposalStatus::Expired);
    // Judged on the totals at expiry: under the floor, the bond is forfeited.
    assert_eq!(
        deposit_of(&mut w, DAVE),
        dave + params(&mut w).reserve_for(2)
    );
    assert_eq!(storage_fund(&mut w), params(&mut w).bond_market.0);
    assert_books(&mut w);
}

#[test]
fn cancel_check_order() {
    let mut w = market_world();
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    let cancel =
        |w: &mut World, who: &str, pid: u64| w.call(who, ONE_YOCTO, |c| c.cancel_proposal(pid));
    fails(cancel(&mut w, DAVE, 99), "UnknownProposal(99)");
    fails(cancel(&mut w, CAROL, pid), &format!("NotProposer({pid})"));
    pledge(&mut w, ALICE, pid, Usdc, 100 * E18).unwrap();
    fails(cancel(&mut w, DAVE, pid), &format!("HasPledges({pid})"));
    w.call(ALICE, ONE_YOCTO, |c| c.withdraw_pledge(pid, None, None))
        .unwrap();
    cancel(&mut w, DAVE, pid).unwrap();
    fails(
        cancel(&mut w, DAVE, pid),
        &format!("ProposalClosed({pid}, cancelled)"),
    );
}

#[test]
fn cancel_kind_b_forfeits_bond() {
    let mut w = market_world();
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    let p = record(&mut w, pid);
    let dave = deposit_of(&mut w, DAVE);
    w.call(DAVE, ONE_YOCTO, |c| c.cancel_proposal(pid)).unwrap();
    assert_eq!(storage_fund(&mut w), p.bond);
    assert!(deposit_of(&mut w, DAVE) >= dave + p.reserve);
    let ev = logged(&w, "proposal_cancelled")[0].clone();
    assert_eq!(
        (ev["forfeited"].as_bool(), u(&ev["bond"])),
        (Some(true), p.bond)
    );
    assert!(w.view(|c| c.catalog.proposal_by_set.get(&p.key).is_none()));
    assert!(w.view(|c| c.catalog.live_of_event.get(&fed).is_none()));
    assert_books(&mut w);
}

#[test]
fn cancel_kind_a_in_review_returns_bond() {
    let mut w = market_world();
    let pid = propose_event(&mut w, DAVE).unwrap();
    let p = record(&mut w, pid);
    let dave = deposit_of(&mut w, DAVE);
    w.call(DAVE, ONE_YOCTO, |c| c.cancel_proposal(pid)).unwrap();
    assert_eq!(storage_fund(&mut w), 0);
    assert!(deposit_of(&mut w, DAVE) >= dave + p.bond + p.reserve);
    assert_eq!(logged(&w, "proposal_cancelled")[0]["forfeited"], false);
    // What came back is withdrawable like any storage deposit.
    let available = w.view(|c| c.storage_balance_of(acc(DAVE)).unwrap().available.0);
    assert!(available >= p.bond + p.reserve);
    w.call(DAVE, ONE_YOCTO, |c| c.storage_withdraw(None))
        .unwrap();
    assert_eq!(w.last.near_transfers(), vec![(acc(DAVE), available)]);
    // The question is free again.
    propose_event(&mut w, CAROL).unwrap();
}

#[test]
fn cancel_and_repropose_cannot_dodge_eviction() {
    let mut w = market_world();
    let fed = w.fed;
    let bond = params(&mut w).bond_market.0;
    for round in 1..=3u128 {
        let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
        w.call(DAVE, ONE_YOCTO, |c| c.cancel_proposal(pid)).unwrap();
        assert_eq!(
            storage_fund(&mut w),
            round * bond,
            "each round costs a bond"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(8))]

    /// M-11: once ended, a proposal never comes back, and settling is
    /// idempotent, whatever happens in between.
    #[test]
    fn an_ended_status_is_permanent(steps in proptest::collection::vec(0u8..6, 1..10)) {
        let mut w = market_world();
        let fed = w.fed;
        let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
        let mut ended: Option<ProposalStatus> = None;
        for step in steps {
            match step {
                0 => w.warp(3 * DAY),
                1 => { let _ = pledge(&mut w, ALICE, pid, Usdc, 100 * E18); }
                2 => { settle(&mut w, pid); }
                3 => { let _ = w.call(ALICE, ONE_YOCTO, |c| c.withdraw_pledge(pid, None, None)); }
                4 => { let _ = w.create_scenario(&[fed]); }
                _ => { let _ = w.admin_resolve(fed, 1); }
            }
            let p = record(&mut w, pid);
            let now = w.view(|c| c.effective_status(&p).0);
            if let Some(end) = ended {
                prop_assert_eq!(now, end);
            } else if now.is_terminal() {
                ended = Some(now);
            }
        }
        let first = settle(&mut w, pid);
        prop_assert_eq!(settle(&mut w, pid), first);
        assert_books(&mut w);
    }
}
