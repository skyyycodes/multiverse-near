//! Edge cases probed against the reference behaviour and pinned here.

use super::harness::*;
use crate::types::Asset::{Usdc, Wnear};
use crate::types::Source;

#[test]
fn single_part_split_after_resolution() {
    let mut w = World::new();
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    // root's dead worlds need no cover, so one part is enough
    w.split_ft(ALICE, 1, Wnear, &[HOLDS], E18).unwrap();
    w.split_ft(ALICE, 1, Wnear, &[L_SHAPE], E18).unwrap();
    w.redeem(ALICE, 1, Wnear, HOLDS, E18).unwrap();
    w.redeem(ALICE, 1, Wnear, L_SHAPE, E18).unwrap();
    assert_eq!(w.wallet(ALICE, Wnear), FUND);
    assert_eq!(w.reserves(1, Wnear), 0);
}

#[test]
fn single_live_world_root_split_into_one_part() {
    let mut w = World::new();
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    w.admin_resolve(w.spice, OUT_DELAYED).unwrap();
    w.split_ft(ALICE, 1, Wnear, &[DELAYED_HOLDS], E18).unwrap();
    fails(
        w.split(ALICE, 1, Wnear, DELAYED_HOLDS, &[DELAYED_HOLDS], 1),
        "NotStrictSubset(8, 8)",
    );
}

#[test]
fn merge_into_dead_to_mask() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &SINGLES, E18).unwrap();
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    fails(
        w.merge(ALICE, 1, Wnear, &[SHIPS_CUTS, DELAYED_CUTS], CUTS, 1),
        "DeadVerse(1)",
    );
    fails(w.merge(ALICE, 1, Wnear, &[], CUTS, 1), "EmptyPartition");
}

#[test]
fn merge_live_into_mask_with_dead_worlds() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &SINGLES, E18).unwrap();
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    w.merge(ALICE, 1, Wnear, &[SHIPS_HOLDS, DELAYED_HOLDS], 0xD, E18)
        .unwrap();
    assert_eq!(w.bal(ALICE, 1, Wnear, 0xD), E18);
    assert_eq!(w.reserves(1, Wnear), E18);
    // 0xD covers every possible world, so it is collapsed and redeems 1:1
    w.redeem(ALICE, 1, Wnear, 0xD, E18).unwrap();
    assert_eq!(w.reserves(1, Wnear), 0);
}

#[test]
fn redeem_before_resolution() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &[SHIPS, DELAYED], E18).unwrap();
    for m in [SHIPS, DELAYED] {
        fails(
            w.redeem(ALICE, 1, Wnear, m, 1),
            &format!("NotCollapsed({m})"),
        );
    }
}

#[test]
fn split_from_collapsed_token_burns_not_pulls() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &[CUTS, HOLDS], 2 * E18)
        .unwrap();
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    let (wallet, real) = (w.wallet(ALICE, Wnear), w.real(ALICE, Wnear));
    // HOLDS is collapsed now: it splits like root, but burns the token
    w.split(ALICE, 1, Wnear, HOLDS, &[SHIPS_HOLDS, DELAYED_HOLDS], E18)
        .unwrap();
    assert_eq!(w.wallet(ALICE, Wnear), wallet);
    assert_eq!(w.real(ALICE, Wnear), real);
    assert_eq!(w.reserves(1, Wnear), 2 * E18);
    assert_eq!(w.bal(ALICE, 1, Wnear, HOLDS), E18);
    assert_eq!(w.bal(ALICE, 1, Wnear, SHIPS_HOLDS), E18);
}

#[test]
fn dispute_boundary_and_finalize_boundary() {
    let mut w = World::new();
    let fed = w.fed;
    let t0 = w.now;
    w.report(fed, OUT_HOLDS).unwrap();
    // the last second a dispute is possible
    w.now = t0 + DISPUTE_WINDOW - 1;
    fails(
        w.finalize(ALICE, fed),
        &format!("DisputeWindowNotOver(2, {})", t0 + DISPUTE_WINDOW),
    );
    w.dispute(fed).unwrap();
    let t1 = w.now;
    w.report(fed, OUT_HOLDS).unwrap();
    // at exactly proposed_at + window: no dispute, finalize works
    w.now = t1 + DISPUTE_WINDOW;
    fails(w.dispute(fed), "DisputeWindowOver(2)");
    w.finalize(ALICE, fed).unwrap();
}

#[test]
fn window_change_applies_to_open_proposal() {
    let mut w = World::new();
    let fed = w.fed;
    let t0 = w.now;
    w.report(fed, OUT_CUTS).unwrap();
    assert_eq!(w.view(|c| c.finalizable_at(fed)), t0 + 30);
    w.call(OWNER, ONE_YOCTO, |c| c.set_dispute_window(100))
        .unwrap();
    assert_eq!(w.view(|c| c.finalizable_at(fed)), t0 + 100);
    assert_eq!(w.view(|c| c.get_event(fed)).finalizable_at_sec, t0 + 100);
    w.warp(50);
    w.dispute(fed).unwrap();
    // the disputed proposal's time, outcome and source survive
    let e = w.view(|c| c.get_event(fed));
    assert_eq!(
        (e.proposed_at_sec, e.proposed_outcome, e.proposed_by),
        (t0, OUT_CUTS, Some(Source::Reporter))
    );
    assert!(!e.proposal_open && !e.finalized);
    assert_eq!(e.finalizable_at_sec, 0);
    assert_eq!(w.view(|c| c.finalizable_at(fed)), 0);
}

#[test]
fn zero_window() {
    let mut w = World::new();
    let fed = w.fed;
    w.call(OWNER, ONE_YOCTO, |c| c.set_dispute_window(0))
        .unwrap();
    w.report(fed, OUT_HOLDS).unwrap();
    // never disputable, finalizable in the same block
    fails(w.dispute(fed), "DisputeWindowOver(2)");
    w.finalize(BOB, fed).unwrap();
    assert_eq!(w.possible(1), HOLDS);
}

#[test]
fn huge_window_blocks_proposals_until_lowered() {
    let mut w = World::new();
    let fed = w.fed;
    w.report(fed, OUT_HOLDS).unwrap();
    w.call(OWNER, ONE_YOCTO, |c| c.set_dispute_window(u64::MAX))
        .unwrap();
    // finalizable_at overflows u64
    fails(w.try_view(|c| c.finalizable_at(fed)), "ArithmeticOverflow");
    fails(w.finalize(ALICE, fed), "ArithmeticOverflow");
    // dispute adds in a wider type and still works
    w.dispute(fed).unwrap();
    fails(w.report(fed, OUT_HOLDS), "ArithmeticOverflow");
    w.call(OWNER, ONE_YOCTO, |c| c.set_dispute_window(30))
        .unwrap();
    w.report(fed, OUT_HOLDS).unwrap();
}

#[test]
fn admin_resolve_after_window_overrides_proposal() {
    let mut w = World::new();
    let fed = w.fed;
    w.report(fed, OUT_CUTS).unwrap();
    w.warp(DISPUTE_WINDOW + 5);
    w.admin_resolve(fed, OUT_HOLDS).unwrap();
    assert_eq!(
        w.last.logs,
        vec![
            r#"EVENT_JSON:{"standard":"multiverse","version":"2.0.0","event":"proposal_disputed","data":[{"event_id":2,"outcome":0}]}"#,
            &format!(
                r#"EVENT_JSON:{{"standard":"multiverse","version":"2.0.0","event":"outcome_proposed","data":[{{"event_id":2,"outcome":1,"source":"admin","finalizable_at_sec":{}}}]}}"#,
                w.now + DISPUTE_WINDOW
            ),
            r#"EVENT_JSON:{"standard":"multiverse","version":"2.0.0","event":"worlds_removed","data":[{"scenario_id":1,"event_id":2,"outcome":1,"removed":3,"possible":12}]}"#,
            r#"EVENT_JSON:{"standard":"multiverse","version":"2.0.0","event":"event_finalized","data":[{"event_id":2,"outcome":1,"scenario_ids":[1]}]}"#,
        ]
    );
    assert_eq!(
        w.view(|c| c.get_event(fed)).proposed_by,
        Some(Source::Admin)
    );
}

#[test]
fn report_unknown_event() {
    let mut w = World::new();
    fails(w.report(99, 0), "UnknownEvent(99)");
}

#[test]
fn report_log_order() {
    let mut w = World::new();
    w.report(w.fed, OUT_HOLDS).unwrap();
    let names: Vec<String> = w.last.event_names().into_iter().map(|(_, e)| e).collect();
    assert_eq!(names, vec!["outcome_proposed", "report_received"]);
    assert_eq!(w.last.data_of("report_received")[0]["evidence"], "");
}

#[test]
fn labels() {
    let mut w = World::new();
    assert_eq!(w.view(|c| c.verse_label(1, 0x6)), "0b0110");
    assert_eq!(w.view(|c| c.verse_label(1, 0x9)), "0b1001");
    assert_eq!(w.view(|c| c.verse_label(1, 0x7)), "0b0111");
    assert_eq!(w.view(|c| c.verse_label(2, BIN_SHIPS)), "SHIPS");
    assert_eq!(w.view(|c| c.verse_label(2, BIN_ROOT)), "ANY");
    fails(w.try_view(|c| c.verse_label(2, 0x4)), "InvalidMask(4)");
    fails(w.try_view(|c| c.verse_label(1, 0)), "InvalidMask(0)");
}

#[test]
fn views_on_odd_inputs() {
    let mut w = World::new();
    // stray high bits are ignored by value_in
    assert!(w.view(|c| c.value_in(1, 0xF0 | L_SHAPE, 3)));
    assert!(!w.view(|c| c.value_in(1, 0xF0, 4)));
    assert_eq!(w.view(|c| c.finalizable_at(42)), 0);
    assert!(!w.view(|c| c.is_finalized(42)));
    assert_eq!(w.view(|c| c.scenarios_of_event(42)), Vec::<u64>::new());
    fails(w.try_view(|c| c.get_scenario(9)), "UnknownScenario(9)");
    fails(w.try_view(|c| c.is_live(9, 1)), "UnknownScenario(9)");
    fails(w.try_view(|c| c.backing(9)), "UnknownScenario(9)");
    let fed = w.fed;
    fails(
        w.try_view(|c| c.worlds_with(2, fed, 0)),
        "EventNotInScenario(2, 2)",
    );
    fails(
        w.try_view(|c| c.worlds_with(1, fed, 2)),
        "InvalidOutcome(2)",
    );
    fails(w.try_view(|c| c.outcome_name(fed, 2)), "InvalidOutcome(2)");
    fails(w.try_view(|c| c.outcome_name(42, 0)), "UnknownEvent(42)");
}

#[test]
fn reversed_event_order() {
    let mut w = World::new();
    let (spice, fed) = (w.spice, w.fed);
    let rev = w.create_scenario(&[fed, spice]).unwrap();
    // Fed is digit 0 now
    assert_eq!(w.view(|c| c.worlds_with(rev, fed, OUT_HOLDS)), 0xA);
    assert_eq!(w.view(|c| c.worlds_with(rev, spice, OUT_DELAYED)), 0xC);
    assert_eq!(w.view(|c| c.verse_label(rev, 0x2)), "HOLDS·SHIPS");
}

#[test]
fn register_verse_by_anyone_and_name_decimals() {
    let mut w = World::new();
    let id = w
        .call(CAROL, NO_DEPOSIT, |c| {
            c.register_verse(2, Usdc, BIN_DELAYED)
        })
        .unwrap();
    assert_eq!(id, "2:usdc:2");
    let meta = w.view(|c| c.mt_metadata_base_by_token_id(vec![id.clone()]));
    assert_eq!(meta[0].name, "USDC-if-DELAYED");
    assert_eq!(meta[0].decimals.as_deref(), Some("18"));
    // registering costs storage, so an account without a deposit cannot
    fails(
        w.call("dave.near", NO_DEPOSIT, |c| {
            c.register_verse(2, Usdc, BIN_SHIPS)
        }),
        "NotRegistered(dave.near)",
    );
}

#[test]
fn split_order_of_checks() {
    let mut w = World::new();
    // UnknownScenario before ZeroAmount, ZeroAmount before the mask, the
    // mask before liveness, liveness before the partition, the partition
    // before the balance.
    fails(w.split(ALICE, 9, Wnear, 0, &[], 0), "UnknownScenario(9)");
    fails(w.split(ALICE, 1, Wnear, 0, &[], 0), "ZeroAmount");
    fails(w.split(ALICE, 1, Wnear, 0, &[], 1), "InvalidMask(0)");
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    fails(w.split(ALICE, 1, Wnear, CUTS, &[], 1), "DeadVerse(3)");
    fails(w.split(ALICE, 1, Wnear, ROOT, &[], 1), "EmptyPartition");
    fails(
        w.split(ALICE, 1, Wnear, ROOT, &[HOLDS], 1),
        "InsufficientBalance(alice.near, 0, 1)",
    );
    fails(
        w.split(ALICE, 1, Wnear, HOLDS, &[SHIPS_HOLDS, DELAYED_HOLDS], 1),
        "InvalidMask(12)",
    );
}

#[test]
fn create_scenario_after_partial_use() {
    let mut w = World::new();
    w.admin_resolve(w.spice, OUT_SHIPS).unwrap();
    fails(w.create_scenario(&[w.spice, w.fed]), "EventNotOpen(1)");
    fails(w.create_scenario(&[w.fed, w.spice]), "EventNotOpen(1)");
}

#[test]
fn duplicate_scenario_allowed() {
    let mut w = World::new();
    let again = w.create_scenario(&[w.spice, w.fed]).unwrap();
    assert_eq!(again, 3);
    w.split_ft(ALICE, again, Wnear, &SINGLES, E18).unwrap();
    // its own reserves and tokens
    assert_eq!(w.reserves(again, Wnear), E18);
    assert_eq!(w.reserves(1, Wnear), 0);
    assert_eq!(w.bal(ALICE, again, Wnear, SHIPS_CUTS), E18);
    assert_eq!(w.bal(ALICE, 1, Wnear, SHIPS_CUTS), 0);
    // resolving the shared events resolves every copy
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    assert_eq!(w.possible(again), HOLDS);
    assert_eq!(w.possible(1), HOLDS);
}
