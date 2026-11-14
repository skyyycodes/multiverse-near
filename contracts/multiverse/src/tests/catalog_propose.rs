//! Proposing (SPEC-C 3.7.1): the check orders of `propose_event` and
//! `propose_market` (first error wins), what a proposal holds, the owner's
//! approval and rejection, top-ups, and the non-panicking `event_check` and
//! `market_check` against the methods they mirror.

use near_sdk::json_types::U128;
use near_sdk::NearToken;
use proptest::prelude::*;

use super::catalog_fixture::*;
use crate::catalog::{OpeningTerms, ProposalKind, ProposalStatus};
use crate::ops::PauseFlag;
use crate::types::Asset::{Usdc, Wnear};
use crate::types::WAD;

fn texts(
    question: &str,
    outcomes: &[&str],
    rule: &str,
    source: &str,
    category: u8,
    terms: OpeningTerms,
    deadline: u64,
) -> impl FnOnce(&mut crate::Contract) -> u64 {
    let (q, o, r, s) = (
        question.to_string(),
        outcomes.iter().map(|x| x.to_string()).collect::<Vec<_>>(),
        rule.to_string(),
        source.to_string(),
    );
    move |c| c.propose_event(q, o, r, s, deadline, category, terms)
}

fn terms(odds0_bps: u16, mult: [u16; 2]) -> OpeningTerms {
    OpeningTerms {
        odds0_bps,
        mult_bps: mult,
    }
}

fn pause(w: &mut World, flag: PauseFlag) {
    let bits = PauseFlag::bits_of(&[flag]);
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = bits).unwrap();
}

#[test]
fn propose_event_check_order() {
    let mut w = market_world();
    let d = far_deadline(&w);
    let ok = ["YES", "NO"];
    pause(&mut w, PauseFlag::Pledge);
    fails(
        w.call(
            DAVE,
            PROPOSE_DEPOSIT,
            texts(QUESTION, &ok, RULE, SOURCE, 1, TERMS, d),
        ),
        "Paused(pledge)",
    );
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = 0).unwrap();
    fails(
        w.call(
            "zed.near",
            PROPOSE_DEPOSIT,
            texts(QUESTION, &ok, RULE, SOURCE, 1, TERMS, d),
        ),
        "NotRegistered(zed.near)",
    );
    let vectors: Vec<(Box<dyn FnOnce(&mut crate::Contract) -> u64>, String)> = vec![
        (
            Box::new(texts("", &ok, RULE, SOURCE, 1, TERMS, d)),
            "EmptyText".into(),
        ),
        (
            Box::new(texts(QUESTION, &["YES"], RULE, SOURCE, 1, TERMS, d)),
            "NotBinary(1)".into(),
        ),
        (
            Box::new(texts(QUESTION, &["YES", ""], RULE, SOURCE, 1, TERMS, d)),
            "EmptyText".into(),
        ),
        (
            Box::new(texts(&"q".repeat(281), &ok, RULE, SOURCE, 1, TERMS, d)),
            "TextTooLong(question)".into(),
        ),
        (
            Box::new(texts(
                QUESTION,
                &ok,
                &"r".repeat(1_025),
                SOURCE,
                1,
                TERMS,
                d,
            )),
            "TextTooLong(rule)".into(),
        ),
        (
            Box::new(texts(
                QUESTION,
                &["Y".repeat(33).as_str(), "N"],
                RULE,
                SOURCE,
                1,
                TERMS,
                d,
            )),
            "TextTooLong(outcome_names)".into(),
        ),
        (
            Box::new(texts(QUESTION, &ok, RULE, "", 1, TERMS, d)),
            "EmptyText".into(),
        ),
        (
            Box::new(texts(QUESTION, &ok, RULE, &"s".repeat(257), 1, TERMS, d)),
            "TextTooLong(source)".into(),
        ),
        (
            Box::new(texts(QUESTION, &ok, RULE, SOURCE, 16, TERMS, d)),
            "BadCategory(16)".into(),
        ),
        (
            Box::new(texts(
                QUESTION,
                &ok,
                RULE,
                SOURCE,
                1,
                terms(99, [10_000, 10_000]),
                d,
            )),
            "BadTerms(odds0)".into(),
        ),
        (
            Box::new(texts(
                QUESTION,
                &ok,
                RULE,
                SOURCE,
                1,
                terms(9_901, [10_000, 10_000]),
                d,
            )),
            "BadTerms(odds0)".into(),
        ),
        (
            Box::new(texts(
                QUESTION,
                &ok,
                RULE,
                SOURCE,
                1,
                terms(5_000, [4_999, 10_000]),
                d,
            )),
            "BadTerms(mult)".into(),
        ),
        // Raw multipliers in range, normalised 0.97 and 3.88: out of range.
        (
            Box::new(texts(
                QUESTION,
                &ok,
                RULE,
                SOURCE,
                1,
                terms(9_900, [5_000, 20_000]),
                d,
            )),
            "BadTerms(mult)".into(),
        ),
    ];
    for (f, expected) in vectors {
        fails(w.call(DAVE, PROPOSE_DEPOSIT, f), &expected);
    }
    let soon = w.now + DAY + 3 * DAY - 1;
    fails(
        w.call(
            DAVE,
            PROPOSE_DEPOSIT,
            texts(QUESTION, &ok, RULE, SOURCE, 1, TERMS, soon),
        ),
        &format!("DeadlineTooSoon(0, {soon})"),
    );
    let pid = propose_event(&mut w, CAROL).unwrap();
    // The same question in another case and spacing.
    let same = format!("  {}  ", QUESTION.to_ascii_uppercase());
    fails(
        w.call(
            DAVE,
            PROPOSE_DEPOSIT,
            texts(&same, &ok, RULE, SOURCE, 1, TERMS, d),
        ),
        &format!("ProposalExists({pid})"),
    );
    for i in 0..3 {
        propose_event_with(&mut w, CAROL, &format!("Question {i}?"), TERMS, d).unwrap();
    }
    fails(
        propose_event_with(&mut w, CAROL, "Question 4?", TERMS, d),
        "TooManyActiveProposals(4)",
    );
    let (s, b) = (w.s2x2, w.s_bin);
    set_params(&mut w, |p| p.anchors = [0, 0, 0]).unwrap();
    fails(
        propose_event_with(&mut w, DAVE, "Q5?", TERMS, d),
        "NoSpotReference",
    );
    set_params(&mut w, |p| p.anchors = [s, b, 0]).unwrap();
    let (low, high) = w.view(|c| {
        let p = c.market_params_stored();
        (
            c.reference_prices(s, &p).unwrap().implied,
            c.reference_prices(b, &p).unwrap().implied,
        )
    });
    let s_ref = (low + high) / 2;
    fails(
        propose_event_with(&mut w, DAVE, "Q5?", TERMS, d),
        &format!("AnchorsDisagree({s}, {low}, {s_ref})"),
    );
    set_params(&mut w, |p| p.anchors = [s, 0, 0]).unwrap();
    let needed = params(&mut w).bond_new_event.0 + params(&mut w).reserve_for(2);
    fails(
        w.call(
            DAVE,
            NearToken::from_yoctonear(needed - 1),
            texts("Q5?", &ok, RULE, SOURCE, 1, TERMS, d),
        ),
        &format!("InsufficientDeposit({needed}, {})", needed - 1),
    );
}

#[test]
fn a_new_event_proposal_holds_its_bond_and_reserve() {
    let mut w = market_world();
    let dave = deposit_of(&mut w, DAVE);
    let used = w.storage_used(DAVE);
    let pid = propose_event(&mut w, DAVE).unwrap();
    let params = params(&mut w);
    let (bond, reserve) = (params.bond_new_event.0, params.reserve_for(2));
    // The excess of the deposit is credited; the proposal's bytes are charged.
    assert_eq!(
        deposit_of(&mut w, DAVE),
        dave + PROPOSE_DEPOSIT.as_yoctonear() - bond - reserve
    );
    assert!(w.storage_used(DAVE) > used);
    let p = record(&mut w, pid);
    assert_eq!(
        (p.kind, p.status, p.bond, p.reserve),
        (
            ProposalKind::NewEvent,
            ProposalStatus::Review,
            bond,
            reserve
        )
    );
    assert_eq!(p.goal, 47_000 * WAD);
    assert_eq!(p.beta, WAD / 4);
    assert_eq!(p.expires_at_sec, 0);
    assert_eq!(w.view(|c| c.books.near_held), bond + reserve);
    let ev = logged(&w, "proposal_created")[0].clone();
    assert_eq!(ev["kind"], "new_event");
    assert_eq!(ev["new_event"]["question"], QUESTION);
    assert_eq!(ev["goal"], p.goal.to_string());
    let dave_id = acc(DAVE);
    assert_eq!(w.view(|c| c.account_markets(&dave_id)).proposals, vec![pid]);
    assert!(w.view(|c| c.catalog.account_busy(&dave_id)));
    let v = proposal_view(&mut w, pid);
    assert_eq!(v.new_event.unwrap().rule, RULE);
    assert_eq!(v.blocker, Some(format!("NotApproved({pid})")));
}

#[test]
fn propose_market_check_order() {
    let mut w = market_world();
    let (spice, fed, s) = (w.spice, w.fed, w.s2x2);
    fails(propose_market(&mut w, DAVE, &[]), "BadEventCount(0)");
    fails(
        propose_market(&mut w, DAVE, &[1, 2, 3, 4]),
        "BadEventCount(4)",
    );
    fails(
        propose_market(&mut w, DAVE, &[fed, fed]),
        &format!("DuplicateEvent({fed})"),
    );
    fails(propose_market(&mut w, DAVE, &[99]), "UnknownEvent(99)");
    let resolved = w
        .create_event("Resolved?", &["YES", "NO"], RULE, 0)
        .unwrap();
    w.admin_resolve(resolved, 0).unwrap();
    fails(
        propose_market(&mut w, DAVE, &[resolved]),
        &format!("EventResolved({resolved})"),
    );
    let deciding = w
        .create_event("Deciding?", &["YES", "NO"], RULE, 0)
        .unwrap();
    w.report(deciding, 0).unwrap();
    fails(
        propose_market(&mut w, DAVE, &[deciding]),
        &format!("EventDeciding({deciding})"),
    );
    let full = w.create_event("Full?", &["YES", "NO"], RULE, 0).unwrap();
    for _ in 0..16 {
        w.create_scenario(&[full]).unwrap();
    }
    fails(
        propose_market(&mut w, DAVE, &[full]),
        &format!("TooManyScenarios({full})"),
    );
    let bare = w.create_event("Bare?", &["YES", "NO"], RULE, 0).unwrap();
    fails(
        propose_market(&mut w, DAVE, &[bare]),
        &format!("NoReferenceMarket({bare})"),
    );
    // The listed 2x2 catches either order.
    fails(
        propose_market(&mut w, DAVE, &[fed, spice]),
        &format!("MarketExists({s})"),
    );
    fails(
        propose_market(&mut w, DAVE, &[spice, fed]),
        &format!("MarketExists({s})"),
    );
    let (e, _) = owner_market(&mut w, "Will it snow in Delhi?", &DEMO_BIN, 5_000);
    let young = w.view(|c| c.reference_market_of(e)).unwrap();
    fails(
        propose_market(&mut w, DAVE, &[e]),
        &format!("MarketExists({young})"),
    );
    fails(
        propose_market(&mut w, DAVE, &[e, fed]),
        &format!("ReferenceUnavailable({young}, young)"),
    );
    w.warp(WINDOW);
    let pid = propose_market(&mut w, DAVE, &[fed, e]).unwrap();
    fails(
        propose_market(&mut w, CAROL, &[e, fed]),
        &format!("ProposalExists({pid})"),
    );
    // A deadline that leaves no pledge window.
    let soon = w.now + 3 * DAY + 3_600;
    let late = w.create_event("Late?", &["YES", "NO"], RULE, soon).unwrap();
    let late_sid = w.create_scenario(&[late]).unwrap();
    seed_worlds(&mut w, late_sid, &DEMO_BIN, &[DEPTH; 2]);
    seed_odds(&mut w, late_sid, &independent_odds(2, 5_000, 0), ODDS_DEPTH);
    list(&mut w, late_sid, true).unwrap();
    set_reference(&mut w, late, Some(late_sid)).unwrap();
    fails(
        propose_market(&mut w, DAVE, &[late, fed]),
        &format!("DeadlineTooSoon({late}, {soon})"),
    );
    // A reference far from S_ref, and one whose shape is out of range.
    let far_prices = [10 * WAD, 9 * WAD];
    let (far, far_sid) = owner_market(&mut w, "Far?", &far_prices, 5_000);
    let (odd, _) = owner_market(&mut w, "Odd?", &[20 * WAD, 2_880 * WAD / 1_000], 100);
    w.warp(WINDOW);
    let (implied, s_ref) = w.view(|c| {
        let p = c.market_params_stored();
        (
            c.reference_prices(far_sid, &p).unwrap().implied,
            c.spot_reference(&p).unwrap().s_ref,
        )
    });
    fails(
        propose_market(&mut w, DAVE, &[far, fed]),
        &format!("ReferenceDiverges({far_sid}, {implied}, {s_ref})"),
    );
    fails(
        propose_market(&mut w, DAVE, &[odd, fed]),
        "PriceOutOfRange(0)",
    );
    let needed = params(&mut w).bond_market.0 + params(&mut w).reserve_for(4);
    let ids = vec![spice, e];
    fails(
        w.call(DAVE, NearToken::from_yoctonear(needed - 1), |c| {
            c.propose_market(ids)
        }),
        &format!("InsufficientDeposit({needed}, {})", needed - 1),
    );
    let p = record(&mut w, pid);
    assert_eq!(p.key.ids(), {
        let mut v = vec![fed, e];
        v.sort();
        v
    });
    assert_eq!((p.status, p.world_count), (ProposalStatus::Pledging, 4));
    assert_eq!(p.approved_at_sec, p.created_at_sec);
    assert_eq!(p.deadline_sec, w.view(|c| c.get_event(fed)).deadline_sec);
}

#[test]
fn too_many_live_proposals_on_an_event() {
    let mut w = market_world();
    let fed = w.fed;
    set_params(&mut w, |p| {
        p.max_live_per_event = 2;
        p.max_active_per_account = 16;
    })
    .unwrap();
    let (a, _) = owner_market(&mut w, "A?", &DEMO_BIN, 5_000);
    let (b, _) = owner_market(&mut w, "B?", &DEMO_BIN, 5_000);
    let (c, _) = owner_market(&mut w, "C?", &DEMO_BIN, 5_000);
    w.warp(WINDOW);
    propose_market(&mut w, DAVE, &[fed, a]).unwrap();
    let p2 = propose_market(&mut w, DAVE, &[fed, b]).unwrap();
    // Both are young: nothing can be evicted.
    fails(
        propose_market(&mut w, DAVE, &[fed, c]),
        &format!("TooManyProposals({fed})"),
    );
    // Past evict_min_age the least pledged one under the floor goes.
    pledge(&mut w, CAROL, p2, Usdc, 100 * E18).unwrap();
    let age = params(&mut w).evict_min_age_sec;
    w.warp(age);
    // The references need a fresh window after the warp: none moved.
    let p3 = propose_market(&mut w, DAVE, &[fed, c]).unwrap();
    let evicted = logged(&w, "proposal_evicted");
    assert_eq!(evicted.len(), 1);
    assert_eq!(evicted[0]["proposal_id"], 1);
    assert_eq!(evicted[0]["by_proposal_id"], p3);
    assert_eq!(evicted[0]["event_id"], fed);
    let v = proposal_view(&mut w, 1);
    assert_eq!(v.void_reason, Some(crate::catalog::VoidReason::Evicted));
    assert_books(&mut w);
}

#[test]
fn approve_and_reject_check_order() {
    let mut w = market_world();
    let fed = w.fed;
    let b = propose_market(&mut w, CAROL, &[fed]).unwrap();
    let soon = w.now + 5 * DAY;
    let a = propose_event_with(&mut w, DAVE, QUESTION, TERMS, soon).unwrap();
    fails(
        w.call(CAROL, ONE_YOCTO, |c| c.approve_proposal(a, None)),
        &format!("NotOwner({CAROL})"),
    );
    fails(approve(&mut w, 99, None), "UnknownProposal(99)");
    fails(approve(&mut w, b, None), &format!("WrongKind({b})"));
    fails(
        approve(&mut w, a, Some(terms(50, [10_000, 10_000]))),
        "BadTerms(odds0)",
    );
    w.warp(2 * DAY);
    fails(
        approve(&mut w, a, None),
        &format!("DeadlineTooSoon(0, {soon})"),
    );
    let far = far_deadline(&w);
    let a2 = propose_event_with(&mut w, DAVE, "Another?", TERMS, far).unwrap();
    approve(&mut w, a2, None).unwrap();
    fails(
        approve(&mut w, a2, None),
        &format!("ProposalClosed({a2}, pledging)"),
    );
    // A re-term needs a spot reference.
    set_params(&mut w, |p| p.anchors = [0, 0, 0]).unwrap();
    fails(
        approve(&mut w, a2, Some(terms(4_500, [11_000, 9_000]))),
        "NoSpotReference",
    );
    let anchor = w.s2x2;
    set_params(&mut w, |p| p.anchors = [anchor, 0, 0]).unwrap();

    let reject = |w: &mut World, who: &str, pid: u64, forfeit: bool| {
        w.call(who, ONE_YOCTO, |c| c.reject_proposal(pid, forfeit))
    };
    fails(
        reject(&mut w, CAROL, a2, true),
        &format!("NotOwner({CAROL})"),
    );
    fails(reject(&mut w, OWNER, 99, true), "UnknownProposal(99)");
    fails(reject(&mut w, OWNER, b, true), &format!("WrongKind({b})"));
    // Rejecting with the bond forfeited (still held in review) vs returned.
    let a3 = propose_event_with(&mut w, DAVE, "Spam?", TERMS, far).unwrap();
    pledge(&mut w, ALICE, a3, Wnear, 10 * E18).unwrap();
    let fund = storage_fund(&mut w);
    let dave = deposit_of(&mut w, DAVE);
    let p = record(&mut w, a3);
    reject(&mut w, OWNER, a3, true).unwrap();
    assert_eq!(storage_fund(&mut w), fund + p.bond);
    assert!(deposit_of(&mut w, DAVE) >= dave + p.reserve);
    let ev = logged(&w, "proposal_rejected")[0].clone();
    assert_eq!(
        (ev["forfeited"].as_bool(), u(&ev["bond"])),
        (Some(true), p.bond)
    );
    fails(
        reject(&mut w, OWNER, a3, false),
        &format!("ProposalClosed({a3}, rejected)"),
    );
    assert!(w.view(|c| c.catalog.texts.get(&a3).is_none()));
    // Pledges stay withdrawable, whatever is asked.
    w.call(ALICE, ONE_YOCTO, |c| {
        c.withdraw_pledge(a3, Some(U128(1)), None)
    })
    .unwrap();
    assert_eq!(logged(&w, "pledge_returned")[0]["reason"], "refund");
    assert_eq!(u(&logged(&w, "pledge_returned")[0]["wnear"]), 10 * E18);
    // An approved one has no bond left to forfeit.
    let dave = deposit_of(&mut w, DAVE);
    let reserve = record(&mut w, a2).reserve;
    reject(&mut w, OWNER, a2, true).unwrap();
    assert!(deposit_of(&mut w, DAVE) >= dave + reserve);
    assert_eq!(logged(&w, "proposal_rejected")[0]["forfeited"], false);
    assert_books(&mut w);
}

#[test]
fn top_up_check_order() {
    let mut w = market_world();
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    let top = |w: &mut World, pid: u64, yocto: u128| {
        w.call(CAROL, NearToken::from_yoctonear(yocto), |c| {
            c.top_up_proposal(pid)
        })
    };
    pause(&mut w, PauseFlag::Pledge);
    fails(top(&mut w, pid, 1), "Paused(pledge)");
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = 0).unwrap();
    fails(top(&mut w, 99, 1), "UnknownProposal(99)");
    fails(top(&mut w, pid, 0), "ZeroAmount");
    let reserve = record(&mut w, pid).reserve;
    top(&mut w, pid, NEAR / 10).unwrap();
    assert_eq!(record(&mut w, pid).reserve, reserve + NEAR / 10);
    assert_books(&mut w);
    w.call(DAVE, ONE_YOCTO, |c| c.cancel_proposal(pid)).unwrap();
    fails(
        top(&mut w, pid, 1),
        &format!("ProposalClosed({pid}, cancelled)"),
    );
}

#[test]
fn market_check_mirrors_propose_market() {
    let mut w = market_world();
    let (spice, fed, s) = (w.spice, w.fed, w.s2x2);
    let check = w.view(|c| c.market_check(vec![fed, spice]));
    assert_eq!(check.canonical, vec![spice, fed]);
    assert_eq!(check.blocker, Some(format!("MarketExists({s})")));
    assert_eq!(check.listed_market, Some(s));
    let check = w.view(|c| c.market_check(vec![fed]));
    assert_eq!(check.blocker, None);
    assert_eq!(check.world_count, 2);
    assert!(check.goal.0 > 0 && check.ideal_wnear.0 > 0 && check.ideal_usdc.0 > 0);
    assert_eq!(check.reserve.0, params(&mut w).reserve_for(2));
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    let p = record(&mut w, pid);
    assert_eq!(
        (check.goal.0, check.ideal_wnear.0, check.ideal_usdc.0),
        (p.goal, p.ideal_wnear, p.ideal_usdc)
    );
    assert_eq!(check.expires_at_sec, p.expires_at_sec);
    let check = w.view(|c| c.market_check(vec![fed]));
    assert_eq!(check.blocker, Some(format!("ProposalExists({pid})")));
    assert_eq!(check.live_proposal, Some(pid));
    for ids in [vec![], vec![1, 2, 3, 4], vec![fed, fed], vec![77]] {
        let blocker = w.view(|c| c.market_check(ids.clone())).blocker.unwrap();
        fails(propose_market(&mut w, CAROL, &ids), &blocker);
    }
}

#[test]
fn event_check_equals_propose_event_for_each_first_error() {
    let mut w = market_world();
    let d = far_deadline(&w);
    let pid = propose_event_with(&mut w, CAROL, "Taken?", TERMS, d).unwrap();
    let vectors = [
        ("Free?", terms(50, [10_000, 10_000]), d),
        ("Free?", terms(5_000, [30_000, 10_000]), d),
        ("Free?", TERMS, w.now + DAY),
        ("taken?", TERMS, d),
    ];
    for (question, t, deadline) in vectors {
        let q = question.to_string();
        let check = w.view(|c| c.event_check(q, t, deadline));
        let blocker = check.blocker.expect("blocked");
        fails(
            propose_event_with(&mut w, DAVE, question, t, deadline),
            &blocker,
        );
    }
    let check = w.view(|c| c.event_check("taken?".into(), TERMS, d));
    assert_eq!(check.live_proposal, Some(pid));
    let check = w.view(|c| c.event_check("Free?".into(), TERMS, d));
    assert_eq!(check.blocker, None);
    let new = propose_event_with(&mut w, DAVE, "Free?", TERMS, d).unwrap();
    let p = record(&mut w, new);
    assert_eq!((check.goal.0, check.s_ref.unwrap().0), (p.goal, p.s_hint));
    assert_eq!(check.odds[0].0, 4 * WAD / 10);
    assert!(check.prices[0].0 > check.prices[1].0);
    assert_eq!(check.bond, params(&mut w).bond_new_event);
    // Without anchors.
    set_params(&mut w, |p| p.anchors = [0, 0, 0]).unwrap();
    let check = w.view(|c| c.event_check("Other?".into(), TERMS, d));
    assert_eq!(check.blocker.as_deref(), Some("NoSpotReference"));
    assert_eq!((check.s_ref, check.goal.0), (None, 0));
    fails(
        propose_event_with(&mut w, DAVE, "Other?", TERMS, d),
        "NoSpotReference",
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn event_check_never_panics(
        question in ".{0,300}",
        odds0 in any::<u16>(),
        m0 in any::<u16>(),
        m1 in any::<u16>(),
        deadline in any::<u64>(),
    ) {
        let mut w = World::new();
        let t = terms(odds0, [m0, m1]);
        let check = w.try_view(|c| c.event_check(question, t, deadline));
        prop_assert!(check.is_ok());
    }

    #[test]
    fn market_check_never_panics(ids in proptest::collection::vec(0u64..6, 0..5)) {
        let mut w = World::new();
        prop_assert!(w.try_view(|c| c.market_check(ids)).is_ok());
    }
}
