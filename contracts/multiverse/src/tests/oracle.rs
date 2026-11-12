//! The event oracle, test by test. The automated path is the reporter's
//! `report_outcome`.

use super::harness::*;
use crate::Contract;

#[test]
fn create_event_stores_everything() {
    let mut w = World::new();
    let (spice, fed) = (w.spice, w.fed);
    let e = w.view(|c| c.get_event(fed));
    assert_eq!(e.question, FED_QUESTION);
    assert_eq!(
        e.outcome_names,
        vec!["CUTS".to_string(), "HOLDS".to_string()]
    );
    assert!(!e.finalized);
    assert!(!e.proposal_open);
    assert_eq!(w.view(|c| c.outcome_count(fed)), 2);
    assert_eq!(w.view(|c| c.outcome_name(spice, OUT_DELAYED)), "DELAYED");
    assert_eq!(w.view(|c| c.event_count()), 2);
}

#[test]
fn create_event_fails() {
    let mut w = World::new();
    let names = || vec!["A".to_string(), "B".to_string()];
    fails(
        w.call(ALICE, ONE_YOCTO, |c| {
            c.create_event("q".into(), names(), "r".into(), 0)
        }),
        "OwnableUnauthorizedAccount(alice.near)",
    );
    fails(
        w.create_event("q", &["A", "B", "C"], "r", 0),
        "NotBinary(3)",
    );
    fails(w.create_event("", &["A", "B"], "r", 0), "EmptyText");
    fails(w.create_event("q", &["A", "B"], "", 0), "EmptyText");
    fails(w.create_event("q", &["A", ""], "r", 0), "EmptyText");
}

#[test]
fn create_event_caps_text_lengths() {
    let mut w = World::new();
    let (q, r, n) = ("q".repeat(280), "r".repeat(1024), "N".repeat(32));
    // byte lengths, not characters: "·" is two bytes
    fails(
        w.create_event(&"·".repeat(141), &["A", "B"], "r", 0),
        "TextTooLong(question)",
    );
    fails(
        w.create_event(&format!("{q}x"), &["A", "B"], "r", 0),
        "TextTooLong(question)",
    );
    fails(
        w.create_event("q", &["A", "B"], &format!("{r}x"), 0),
        "TextTooLong(rule)",
    );
    fails(
        w.create_event("q", &["A", &format!("{n}x")], "r", 0),
        "TextTooLong(outcome_names)",
    );
    let id = w.create_event(&q, &[&n, "B"], &r, 0).unwrap();
    let e = w.view(|c| c.get_event(id));
    assert_eq!((e.question.len(), e.rule.len()), (280, 1024));
    assert_eq!(e.outcome_names[0], n);
}

#[test]
fn unknown_event_views() {
    let mut w = World::new();
    assert_eq!(w.view(|c| c.outcome_count(42)), 0);
    assert!(!w.view(|c| c.has_open_proposal(42)));
    fails(w.try_view(|c| c.get_event(42)), "UnknownEvent(42)");
}

/// Core and oracle are one contract; the one-time step is `new`, which only
/// the contract account itself may run (the deploy transaction).
#[test]
fn init_only_by_the_contract_itself() {
    let mut w = World::new();
    fails(
        w.call(ALICE, NO_DEPOSIT, |_| {
            Contract::new(acc(ALICE), None, wnear_cfg(), usdc_cfg(), DISPUTE_WINDOW);
        }),
        "InitNotSelf",
    );
    // and it validates what it is given
    let mut usdc = usdc_cfg();
    usdc.decimals = 25;
    fails(
        w.call(CONTRACT, NO_DEPOSIT, |_| {
            Contract::new(acc(OWNER), None, wnear_cfg(), usdc, 30).event_count
        }),
        "BadDecimals(25)",
    );
    // 24 decimals, as the testnet wNEAR has, is fine
    w.call(CONTRACT, NO_DEPOSIT, |_| {
        Contract::new(acc(OWNER), None, wnear_cfg_with(24), usdc_cfg(), 30).event_count
    })
    .unwrap();
    fails(
        w.call(CONTRACT, NO_DEPOSIT, |_| {
            Contract::new(acc(OWNER), None, wnear_cfg(), wnear_cfg(), 30).event_count
        }),
        "SameToken(wnear.near)",
    );
}

#[test]
fn set_dispute_window_only_owner() {
    let mut w = World::new();
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.set_dispute_window(1)),
        "OwnableUnauthorizedAccount(alice.near)",
    );
    w.call(OWNER, ONE_YOCTO, |c| c.set_dispute_window(300))
        .unwrap();
    assert_eq!(w.view(|c| c.dispute_window_sec()), 300);
}

// Admin path

#[test]
fn admin_resolve_resolves_every_scenario_using_the_event() {
    let mut w = World::new();
    let spice = w.spice;
    w.admin_resolve(spice, OUT_DELAYED).unwrap();
    assert!(w.view(|c| c.is_finalized(spice)));
    assert!(!w.view(|c| c.has_open_proposal(spice)));
    assert_eq!(w.view(|c| c.get_event(spice)).outcome, OUT_DELAYED);
    assert_eq!(w.possible(1), DELAYED);
    assert_eq!(w.possible(2), BIN_DELAYED);
}

#[test]
fn admin_resolve_replaces_an_open_proposal() {
    let mut w = World::new();
    let fed = w.fed;
    w.report(fed, OUT_CUTS).unwrap();
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    assert_eq!(w.view(|c| c.get_event(fed)).outcome, OUT_HOLDS);
    assert_eq!(w.possible(1), HOLDS);
}

#[test]
fn admin_resolve_fails() {
    let mut w = World::new();
    let fed = w.fed;
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.admin_resolve(fed, OUT_HOLDS)),
        "OwnableUnauthorizedAccount(alice.near)",
    );
    fails(w.admin_resolve(fed, 2), "InvalidOutcome(2)");
    fails(w.admin_resolve(9, 0), "UnknownEvent(9)");
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    fails(w.admin_resolve(fed, OUT_CUTS), "AlreadyFinalized(2)");
    // NEAR: owner calls that move state need exactly 1 yoctoNEAR
    fails(
        w.call(OWNER, NO_DEPOSIT, |c| c.admin_resolve(1, 0)),
        "Requires attached deposit of exactly 1 yoctoNEAR",
    );
}

// Propose, dispute, finalize

#[test]
fn propose_halts_then_finalize_after_window() {
    let mut w = World::new();
    let fed = w.fed;
    let t0 = w.now;
    w.report(fed, OUT_HOLDS).unwrap();
    assert!(w.view(|c| c.has_open_proposal(fed)));
    assert_eq!(w.view(|c| c.finalizable_at(fed)), t0 + DISPUTE_WINDOW);
    assert!(w.view(|c| c.is_halted(1)));
    // nothing resolves before finalize
    assert_eq!(w.possible(1), ROOT);

    w.now = t0 + DISPUTE_WINDOW - 1;
    fails(
        w.finalize(ALICE, fed),
        &format!("DisputeWindowNotOver(2, {})", t0 + DISPUTE_WINDOW),
    );

    w.now = t0 + DISPUTE_WINDOW;
    // anyone
    w.finalize(BOB, fed).unwrap();
    assert!(w.view(|c| c.is_finalized(fed)));
    assert!(!w.view(|c| c.is_halted(1)));
    assert_eq!(w.possible(1), HOLDS);
}

#[test]
fn dispute_cancels_inside_window() {
    let mut w = World::new();
    let fed = w.fed;
    w.report(fed, OUT_CUTS).unwrap();
    w.warp(DISPUTE_WINDOW - 1);
    w.dispute(fed).unwrap();
    assert!(!w.view(|c| c.has_open_proposal(fed)));
    assert!(!w.view(|c| c.is_halted(1)));
    fails(w.finalize(ALICE, fed), "NoOpenProposal(2)");
    // a new proposal can follow
    w.report(fed, OUT_HOLDS).unwrap();
    assert!(w.view(|c| c.has_open_proposal(fed)));
}

#[test]
fn dispute_fails() {
    let mut w = World::new();
    let fed = w.fed;
    fails(w.dispute(fed), "NoOpenProposal(2)");
    w.report(fed, OUT_CUTS).unwrap();
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.dispute(fed)),
        "OwnableUnauthorizedAccount(alice.near)",
    );
    w.warp(DISPUTE_WINDOW);
    fails(w.dispute(fed), "DisputeWindowOver(2)");
}

#[test]
fn propose_fails() {
    let mut w = World::new();
    let (spice, fed) = (w.spice, w.fed);
    w.report(fed, OUT_CUTS).unwrap();
    fails(w.report(fed, OUT_HOLDS), "ProposalAlreadyOpen(2)");
    fails(w.report(spice, 5), "InvalidOutcome(5)");
    w.admin_resolve(spice, OUT_SHIPS).unwrap();
    fails(w.report(spice, OUT_SHIPS), "AlreadyFinalized(1)");
}

// Reporter path (the CRE onReport)

#[test]
fn report_proposes_through_the_same_path() {
    let mut w = World::new();
    let fed = w.fed;
    w.report(fed, OUT_HOLDS).unwrap();
    assert!(w.view(|c| c.has_open_proposal(fed)));
    assert!(w.view(|c| c.is_halted(1)));
    assert_eq!(
        w.view(|c| c.get_event(fed)).proposed_by,
        Some(crate::types::Source::Reporter)
    );
    w.warp(DISPUTE_WINDOW);
    w.finalize(CAROL, fed).unwrap();
    assert_eq!(w.possible(1), HOLDS);
}

#[test]
fn report_rejects_other_senders() {
    let mut w = World::new();
    let fed = w.fed;
    fails(
        w.call(ALICE, NO_DEPOSIT, |c| {
            c.report_outcome(fed, OUT_HOLDS, acc(CONTRACT), String::new())
        }),
        "NotReporter(alice.near)",
    );
    // no reporter configured: nobody can report, not even the old reporter
    w.call(OWNER, ONE_YOCTO, |c| c.set_reporter(None)).unwrap();
    fails(w.report(fed, OUT_HOLDS), "NotReporter(resolver.near)");
}

/// `target` is the replay guard: a report
/// signed for another deployment of the contract is refused.
#[test]
fn report_rejects_other_targets_and_stale_reports() {
    let mut w = World::new();
    let fed = w.fed;
    fails(
        w.call(REPORTER, NO_DEPOSIT, |c| {
            c.report_outcome(fed, OUT_HOLDS, acc("other.near"), String::new())
        }),
        "WrongTarget(other.near)",
    );
    w.report(fed, OUT_HOLDS).unwrap();
    fails(w.report(fed, OUT_CUTS), "ProposalAlreadyOpen(2)");
}

/// The evidence string is logged right after `outcome_proposed`.
#[test]
fn report_logs_evidence() {
    let mut w = World::new();
    let spice = w.spice;
    let evidence = "team-controlled outcomes file (demo): spice-2027 = DELAYED";
    w.call(REPORTER, NO_DEPOSIT, |c| {
        c.report_outcome(spice, OUT_DELAYED, acc(CONTRACT), evidence.into())
    })
    .unwrap();
    let names: Vec<String> = w.last.event_names().into_iter().map(|(_, e)| e).collect();
    assert_eq!(names, vec!["outcome_proposed", "report_received"]);
    assert_eq!(
        w.last.logs[1],
        format!(
            r#"EVENT_JSON:{{"standard":"multiverse","version":"1.0.0","event":"report_received","data":[{{"event_id":1,"outcome":1,"reporter_id":"resolver.near","evidence":"{evidence}"}}]}}"#
        )
    );
    let long = "x".repeat(513);
    let fed = w.fed;
    fails(
        w.call(REPORTER, NO_DEPOSIT, |c| {
            c.report_outcome(fed, OUT_HOLDS, acc(CONTRACT), long)
        }),
        "EvidenceTooLong(513, 512)",
    );
    let at_limit = "x".repeat(512);
    w.call(REPORTER, NO_DEPOSIT, |c| {
        c.report_outcome(fed, OUT_HOLDS, acc(CONTRACT), at_limit)
    })
    .unwrap();
}

/// Stands in for `supportsInterface`: what the resolver needs from the
/// contract is that `report_outcome` and `finalize` take no deposit and never
/// grow storage, so a function-call key of an account with no storage
/// deposit can drive the whole state machine.
#[test]
fn reporter_and_finalizer_need_no_deposit_or_registration() {
    let mut w = World::new();
    let fed = w.fed;
    // neither the reporter nor dave is registered for storage
    assert!(w.view(|c| c.storage_balance_of(acc(REPORTER))).is_none());
    w.call(REPORTER, NO_DEPOSIT, |c| {
        c.report_outcome(fed, OUT_HOLDS, acc(CONTRACT), "FRED rows".into())
    })
    .unwrap();
    w.warp(DISPUTE_WINDOW);
    w.call("dave.near", NO_DEPOSIT, |c| c.finalize(fed))
        .unwrap();
    assert_eq!(w.possible(1), HOLDS);
}

#[test]
fn set_reporter_only_owner() {
    let mut w = World::new();
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.set_reporter(Some(acc(ALICE)))),
        "OwnableUnauthorizedAccount(alice.near)",
    );
    w.call(OWNER, ONE_YOCTO, |c| c.set_reporter(Some(acc(BOB))))
        .unwrap();
    assert_eq!(w.view(|c| c.reporter_id()), Some(acc(BOB)));
    assert_eq!(w.view(|c| c.get_app_config()).reporter_id, Some(acc(BOB)));
}

/// An oracle cannot be unwired from the core; the related case is an event no scenario uses (the past-FOMC
/// event), which finalizes on its own and resolves nothing.
#[test]
fn finalize_event_without_scenarios() {
    let mut w = World::new();
    let past = w
        .create_event(
            "Did the Fed cut at its October 27-28, 2026 meeting?",
            &["CUTS", "HOLDS"],
            "rule",
            T0,
        )
        .unwrap();
    w.report(past, OUT_HOLDS).unwrap();
    w.warp(DISPUTE_WINDOW);
    w.finalize(ALICE, past).unwrap();
    assert!(w.last.logs.contains(
        &r#"EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"event_finalized","data":[{"event_id":3,"outcome":1,"scenario_ids":[]}]}"#
            .to_string()
    ));
    assert_eq!(w.possible(1), ROOT);
    assert!(w.view(|c| c.is_finalized(past)));
}
