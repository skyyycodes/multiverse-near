//! The core: events, scenarios, splits, merges, redemptions and resolution.
//! A root split is paid from the wallet with `ft_transfer_call` (`split_ft`),
//! the caller receives every part (there is no `to`, so "to bob" is a
//! transfer to bob), and real assets come back through `ft_transfer` payouts.

use proptest::prelude::*;

use super::harness::*;
use crate::types::Asset::{Usdc, Wnear};

// Create_scenario

#[test]
fn create_scenario_2x2() {
    let mut w = World::new();
    let s = w.view(|c| c.get_scenario(1));
    assert_eq!(s.event_ids, vec![w.spice, w.fed]);
    assert_eq!(s.outcome_counts, vec![2, 2]);
    assert_eq!(s.world_count, 4);
    assert_eq!(s.possible, ROOT);
    assert_eq!(s.resolution_count, 0);
    assert_eq!(s.root, ROOT);
}

#[test]
fn create_scenario_binary() {
    let mut w = World::new();
    let s = w.view(|c| c.get_scenario(2));
    assert_eq!(s.world_count, 2);
    assert_eq!(s.possible, BIN_ROOT);
    assert_eq!(s.root, BIN_ROOT);
}

#[test]
fn scenarios_of_event() {
    let mut w = World::new();
    let (spice, fed) = (w.spice, w.fed);
    assert_eq!(w.view(|c| c.scenarios_of_event(spice)), vec![1, 2]);
    assert_eq!(w.view(|c| c.scenarios_of_event(fed)), vec![1]);
}

#[test]
fn worlds_with_matches_spec_table() {
    let mut w = World::new();
    let (spice, fed) = (w.spice, w.fed);
    assert_eq!(w.view(|c| c.worlds_with(1, spice, OUT_SHIPS)), SHIPS);
    assert_eq!(w.view(|c| c.worlds_with(1, spice, OUT_DELAYED)), DELAYED);
    assert_eq!(w.view(|c| c.worlds_with(1, fed, OUT_CUTS)), CUTS);
    assert_eq!(w.view(|c| c.worlds_with(1, fed, OUT_HOLDS)), HOLDS);
    assert_eq!(w.view(|c| c.worlds_with(2, spice, OUT_SHIPS)), BIN_SHIPS);
    assert_eq!(
        w.view(|c| c.worlds_with(2, spice, OUT_DELAYED)),
        BIN_DELAYED
    );
}

#[test]
fn create_scenario_fails_non_owner() {
    let mut w = World::new();
    let spice = w.spice;
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.create_scenario(vec![spice])),
        "NotOwner(alice.near)",
    );
}

#[test]
fn create_scenario_fails_bad_event_count() {
    let mut w = World::new();
    fails(w.create_scenario(&[]), "BadEventCount(0)");
    fails(w.create_scenario(&[0, 0, 0]), "BadEventCount(3)");
}

#[test]
fn create_scenario_fails_duplicate_event() {
    let mut w = World::new();
    fails(w.create_scenario(&[w.spice, w.spice]), "DuplicateEvent(1)");
}

#[test]
fn create_scenario_fails_unknown_event() {
    let mut w = World::new();
    fails(w.create_scenario(&[999]), "EventNotOpen(999)");
}

#[test]
fn create_scenario_fails_finalized_event() {
    let mut w = World::new();
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    fails(w.create_scenario(&[w.fed]), "EventNotOpen(2)");
}

#[test]
fn create_scenario_fails_open_proposal() {
    let mut w = World::new();
    w.report(w.fed, OUT_HOLDS).unwrap();
    fails(w.create_scenario(&[w.fed]), "EventNotOpen(2)");
}

// Tokens and labels

#[test]
fn token_names_follow_spec() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &SINGLES, E18).unwrap();
    w.split_ft(ALICE, 1, Usdc, &[SHIPS, DELAYED], E18).unwrap();
    w.split_ft(ALICE, 1, Usdc, &[SHIPS_CUTS, L_SHAPE], E18)
        .unwrap();

    assert_eq!(
        w.view(|c| c.verse_name(1, Wnear, SHIPS_CUTS)),
        "wNEAR-if-SHIPS·CUTS"
    );
    assert_eq!(
        w.view(|c| c.verse_name(1, Wnear, DELAYED_CUTS)),
        "wNEAR-if-DELAYED·CUTS"
    );
    assert_eq!(
        w.view(|c| c.verse_name(1, Wnear, SHIPS_HOLDS)),
        "wNEAR-if-SHIPS·HOLDS"
    );
    assert_eq!(
        w.view(|c| c.verse_name(1, Wnear, DELAYED_HOLDS)),
        "wNEAR-if-DELAYED·HOLDS"
    );
    // The same names reach wallets through the NEP-245 metadata extension.
    let meta = w.view(|c| {
        c.mt_metadata_base_by_token_id(vec![
            token_id(1, Usdc, SHIPS),
            token_id(1, Usdc, DELAYED),
            token_id(1, Usdc, L_SHAPE),
        ])
    });
    assert_eq!(meta[0].name, "USDC-if-SHIPS");
    assert_eq!(meta[1].symbol.as_deref(), Some("USDC-if-DELAYED"));
    assert_eq!(meta[2].name, "USDC-if-0b1110");
    assert_eq!(w.view(|c| c.verse_label(1, HOLDS)), "HOLDS");
    assert_eq!(w.view(|c| c.verse_label(1, CUTS)), "CUTS");
    assert_eq!(w.view(|c| c.verse_label(1, ROOT)), "ANY");
}

#[test]
fn binary_token_names() {
    let mut w = World::new();
    w.split_ft(ALICE, 2, Wnear, &[BIN_SHIPS, BIN_DELAYED], 2 * E18)
        .unwrap();
    assert_eq!(
        w.view(|c| c.verse_name(2, Wnear, BIN_SHIPS)),
        "wNEAR-if-SHIPS"
    );
    assert_eq!(
        w.view(|c| c.verse_name(2, Wnear, BIN_DELAYED)),
        "wNEAR-if-DELAYED"
    );
}

/// A verse token's id carries its scenario, asset and mask, and the metadata
/// its decimals.
#[test]
fn verse_token_metadata() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &[SHIPS, DELAYED], E18).unwrap();
    let id = token_id(1, Wnear, DELAYED);
    assert_eq!(id, "1:wnear:10");
    let key = crate::types::VerseKey::parse(&id).unwrap();
    assert_eq!((key.scenario, key.asset, key.mask), (1, Wnear, DELAYED));
    let all = w.view(|c| c.mt_metadata_token_all(vec![id.clone()]));
    assert_eq!(all[0].base.id, id);
    assert_eq!(all[0].base.decimals.as_deref(), Some("18"));
    assert_eq!(
        all[0].token.extra.as_deref(),
        Some(r#"{"scenario_id":1,"asset":"wnear","mask":10}"#)
    );
    assert_eq!(w.view(|c| c.mt_metadata_contract()).spec, "mt-1.0.0");
}

/// CREATE2 prediction becomes a deterministic id: known before the first
/// mint, unused until then, and the one `token_for` reports afterwards.
#[test]
fn token_id_is_predicted() {
    let mut w = World::new();
    let id = token_id(1, Wnear, DELAYED_HOLDS);
    assert_eq!(w.view(|c| c.mt_token(vec![id.clone()])), vec![None]);
    assert_eq!(w.view(|c| c.mt_supply(id.clone())), None);
    w.split_ft(ALICE, 1, Wnear, &SINGLES, 1).unwrap();
    assert_eq!(
        w.view(|c| c.token_for(1, Wnear, DELAYED_HOLDS)),
        Some(id.clone())
    );
    assert_eq!(
        w.view(|c| c.mt_token(vec![id.clone()]))[0]
            .as_ref()
            .unwrap()
            .token_id,
        id
    );
}

#[test]
fn token_for_root_is_real_asset() {
    let mut w = World::new();
    assert_eq!(
        w.view(|c| c.token_for(1, Wnear, ROOT)),
        Some(WNEAR_TOKEN.to_string())
    );
    assert_eq!(
        w.view(|c| c.token_for(2, Usdc, BIN_ROOT)),
        Some(USDC_TOKEN.to_string())
    );
    assert_eq!(w.view(|c| c.token_for(1, Wnear, DELAYED)), None);
}

#[test]
fn register_verse_without_minting() {
    let mut w = World::new();
    // anyone may register a verse
    let id = w
        .call(BOB, NO_DEPOSIT, |c| {
            c.register_verse(1, Usdc, DELAYED_HOLDS)
        })
        .unwrap();
    assert_eq!(id, token_id(1, Usdc, DELAYED_HOLDS));
    assert_eq!(
        w.view(|c| c.mt_supply(id.clone())),
        Some(near_sdk::json_types::U128(0))
    );
    // idempotent
    assert_eq!(
        w.call(BOB, NO_DEPOSIT, |c| c.register_verse(
            1,
            Usdc,
            DELAYED_HOLDS
        ))
        .unwrap(),
        id
    );
}

/// The asset is one of two enum values, so an unknown one cannot even be decoded (see
/// `receiver::wrong_token_is_refunded` for `AssetNotAllowed`).
#[test]
fn register_verse_fails() {
    let mut w = World::new();
    fails(
        w.call(BOB, NO_DEPOSIT, |c| c.register_verse(1, Wnear, ROOT)),
        "NoTokenForRoot",
    );
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    fails(
        w.call(BOB, NO_DEPOSIT, |c| c.register_verse(1, Wnear, CUTS)),
        "DeadVerse(3)",
    );
}

// Split

#[test]
fn split_root_into_single_worlds() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &SINGLES, 2 * E18).unwrap();
    assert_eq!(w.wallet(ALICE, Wnear), FUND - 2 * E18);
    assert_eq!(w.held_by_contract(Wnear), 2 * E18);
    assert_eq!(w.reserves(1, Wnear), 2 * E18);
    for m in SINGLES {
        assert_eq!(w.bal(ALICE, 1, Wnear, m), 2 * E18);
    }
}

/// Alice's L-shape sale starts here: NEAR in SHIPS·CUTS, the rest in DELAYED or HOLDS.
#[test]
fn split_l_shape() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &[SHIPS_CUTS, L_SHAPE], 2 * E18)
        .unwrap();
    assert_eq!(w.bal(ALICE, 1, Wnear, SHIPS_CUTS), 2 * E18);
    assert_eq!(w.bal(ALICE, 1, Wnear, L_SHAPE), 2 * E18);
}

#[test]
fn split_from_token() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &[SHIPS_CUTS, L_SHAPE], 2 * E18)
        .unwrap();
    w.split(ALICE, 1, Wnear, L_SHAPE, &[DELAYED_CUTS, HOLDS], E18)
        .unwrap();
    w.mt_batch_transfer(
        ALICE,
        BOB,
        &[token_id(1, Wnear, DELAYED_CUTS), token_id(1, Wnear, HOLDS)],
        &[E18, E18],
    )
    .unwrap();
    assert_eq!(w.bal(ALICE, 1, Wnear, L_SHAPE), E18);
    assert_eq!(w.bal(BOB, 1, Wnear, DELAYED_CUTS), E18);
    assert_eq!(w.bal(BOB, 1, Wnear, HOLDS), E18);
    // reserves move only with real assets
    assert_eq!(w.reserves(1, Wnear), 2 * E18);
    w.assert_conservation(&[ALICE, BOB]);
}

#[test]
fn split_fails_bad_inputs() {
    let mut w = World::new();
    w.deposit(ALICE, Wnear, E18).unwrap();
    fails(w.split(ALICE, 1, Wnear, ROOT, &SINGLES, 0), "ZeroAmount");
    // A token other than the two configured ones is refused by the receiver.
    let alice = acc(ALICE);
    fails(
        w.call("beef.near", NO_DEPOSIT, |c| {
            c.ft_on_transfer(alice, near_sdk::json_types::U128(1), String::new())
        }),
        "AssetNotAllowed(beef.near)",
    );
    // there is no `to` argument; the closest failure is a
    // receiver with no storage registration.
    w.split(ALICE, 1, Wnear, ROOT, &SINGLES, 1).unwrap();
    fails(
        w.mt_transfer(ALICE, "nobody.near", &token_id(1, Wnear, SHIPS_CUTS), 1),
        "NotRegistered(nobody.near)",
    );
    fails(
        w.split(ALICE, 77, Wnear, ROOT, &SINGLES, 1),
        "UnknownScenario(77)",
    );
    fails(w.split(ALICE, 1, Wnear, 0, &SINGLES, 1), "InvalidMask(0)");
    fails(
        w.split(ALICE, 1, Wnear, 0x10, &SINGLES, 1),
        "InvalidMask(16)",
    );
}

#[test]
fn split_fails_bad_partitions() {
    let mut w = World::new();
    fails(w.split(ALICE, 1, Wnear, ROOT, &[], 1), "EmptyPartition");
    // a root token would duplicate the real asset
    fails(
        w.split(ALICE, 1, Wnear, ROOT, &[ROOT], 1),
        "NotStrictSubset(15, 15)",
    );
    fails(
        w.split(ALICE, 1, Wnear, ROOT, &[0, ROOT], 1),
        "NotStrictSubset(0, 15)",
    );
    fails(
        w.split(ALICE, 1, Wnear, ROOT, &[L_SHAPE, HOLDS, SHIPS_CUTS], 1),
        "NotDisjoint(12)",
    );
    fails(
        w.split(ALICE, 1, Wnear, ROOT, &[L_SHAPE], 1),
        "DoesNotCover(1)",
    );
    w.split_ft(ALICE, 1, Wnear, &[SHIPS_CUTS, L_SHAPE], E18)
        .unwrap();
    fails(
        w.split(
            ALICE,
            1,
            Wnear,
            L_SHAPE,
            &[SHIPS_CUTS, DELAYED_CUTS, HOLDS],
            1,
        ),
        "NotStrictSubset(1, 14)",
    );
}

#[test]
fn split_fails_dead_verses() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &[CUTS, HOLDS], E18).unwrap();
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    // nothing is ever minted into a dead verse, and the transfer is refunded
    let before = w.wallet(ALICE, Wnear);
    fails(
        w.split_ft(ALICE, 1, Wnear, &[CUTS, HOLDS], 1),
        "DeadVerse(3)",
    );
    assert_eq!(w.wallet(ALICE, Wnear), before);
    // a dead verse cannot be split either
    fails(
        w.split(ALICE, 1, Wnear, CUTS, &[SHIPS_CUTS, DELAYED_CUTS], 1),
        "DeadVerse(3)",
    );
    // after HOLDS, root only needs to cover the HOLDS worlds
    w.split_ft(ALICE, 1, Wnear, &[SHIPS_HOLDS, DELAYED_HOLDS], E18)
        .unwrap();
    assert_eq!(w.bal(ALICE, 1, Wnear, DELAYED_HOLDS), E18);
}

#[test]
fn split_fails_insufficient_balance() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &[SHIPS, DELAYED], E18).unwrap();
    fails(
        w.split(
            ALICE,
            1,
            Wnear,
            DELAYED,
            &[DELAYED_CUTS, DELAYED_HOLDS],
            E18 + 1,
        ),
        "InsufficientBalance(alice.near, 1000000000000000000, 1000000000000000001)",
    );
    assert!(w.created(1, Wnear, DELAYED));
}

// Merge

#[test]
fn merge_back_to_root_pays_real_asset() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &SINGLES, 2 * E18).unwrap();
    let ids: Vec<String> = SINGLES.iter().map(|m| token_id(1, Wnear, *m)).collect();
    w.mt_batch_transfer(ALICE, BOB, &ids, &[2 * E18; 4])
        .unwrap();
    w.merge(BOB, 1, Wnear, &SINGLES, ROOT, 2 * E18).unwrap();
    assert_eq!(w.wallet(BOB, Wnear), FUND + 2 * E18);
    assert_eq!(w.held_by_contract(Wnear), 0);
    assert_eq!(w.reserves(1, Wnear), 0);
    for m in SINGLES {
        assert_eq!(w.supply(1, Wnear, m), 0);
    }
}

#[test]
fn merge_to_non_root_mints() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &SINGLES, 2 * E18).unwrap();
    w.merge(
        ALICE,
        1,
        Wnear,
        &[DELAYED_CUTS, SHIPS_HOLDS, DELAYED_HOLDS],
        L_SHAPE,
        E18,
    )
    .unwrap();
    assert_eq!(w.bal(ALICE, 1, Wnear, L_SHAPE), E18);
    assert_eq!(w.bal(ALICE, 1, Wnear, DELAYED_HOLDS), E18);
    assert_eq!(w.reserves(1, Wnear), 2 * E18);
    w.assert_conservation(&[ALICE]);
}

#[test]
fn merge_after_resolution_needs_only_live_parts() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &SINGLES, 2 * E18).unwrap();
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    w.merge(
        ALICE,
        1,
        Wnear,
        &[SHIPS_HOLDS, DELAYED_HOLDS],
        ROOT,
        2 * E18,
    )
    .unwrap();
    assert_eq!(w.wallet(ALICE, Wnear), FUND);
    assert_eq!(w.reserves(1, Wnear), 0);
    // the CUTS tokens are dead and frozen
    assert_eq!(w.bal(ALICE, 1, Wnear, SHIPS_CUTS), 2 * E18);
}

/// Invariant 2, unit form: nothing can be merged from a dead verse.
#[test]
fn merge_fails_dead_part() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &SINGLES, 2 * E18).unwrap();
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    fails(w.merge(ALICE, 1, Wnear, &SINGLES, ROOT, 1), "DeadVerse(1)");
}

#[test]
fn merge_fails_not_covering() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &SINGLES, 2 * E18).unwrap();
    fails(
        w.merge(
            ALICE,
            1,
            Wnear,
            &[SHIPS_CUTS, DELAYED_CUTS, SHIPS_HOLDS],
            ROOT,
            1,
        ),
        "DoesNotCover(8)",
    );
}

#[test]
fn merge_fails_never_minted_verse() {
    let mut w = World::new();
    fails(
        w.merge(ALICE, 1, Wnear, &[SHIPS, DELAYED], ROOT, 1),
        "InvalidMask(5)",
    );
}

// Redeem

#[test]
fn redeem_after_full_resolution() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &[SHIPS_CUTS, L_SHAPE], 2 * E18)
        .unwrap();
    w.split_ft(ALICE, 1, Usdc, &SINGLES, 5000 * E18).unwrap();
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    w.admin_resolve(w.spice, OUT_DELAYED).unwrap();
    assert_eq!(w.possible(1), DELAYED_HOLDS);

    w.redeem(ALICE, 1, Wnear, L_SHAPE, 2 * E18).unwrap();
    w.redeem(ALICE, 1, Usdc, DELAYED_HOLDS, 5000 * E18).unwrap();
    assert_eq!(w.wallet(ALICE, Wnear), FUND);
    assert_eq!(w.wallet(ALICE, Usdc), FUND);
    assert_eq!(w.reserves(1, Wnear), 0);
    assert_eq!(w.reserves(1, Usdc), 0);
    w.assert_conservation(&[ALICE]);
}

/// Collapse works at any depth: after HOLDS alone, HOLDS and the L-shape
/// already cover every possible world.
#[test]
fn redeem_at_any_depth() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &[CUTS, HOLDS], 3 * E18)
        .unwrap();
    w.split_ft(ALICE, 1, Wnear, &[SHIPS_CUTS, L_SHAPE], E18)
        .unwrap();
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    w.redeem(ALICE, 1, Wnear, HOLDS, 3 * E18).unwrap();
    w.redeem(ALICE, 1, Wnear, L_SHAPE, E18).unwrap();
    assert_eq!(w.wallet(ALICE, Wnear), FUND);
}

#[test]
fn redeem_fails() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &[CUTS, HOLDS], E18).unwrap();
    fails(w.redeem(ALICE, 1, Wnear, HOLDS, 1), "NotCollapsed(12)");
    fails(w.redeem(ALICE, 1, Wnear, ROOT, 1), "NoTokenForRoot");
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    // dead
    fails(w.redeem(ALICE, 1, Wnear, CUTS, 1), "NotCollapsed(3)");
}

// Resolve

/// `resolve` is crate-private: no account can call it, so a caller check
/// cannot fail. What remains to check is that nothing but a
/// finalized event changes `possible`: not a proposal, not an early finalize,
/// not an outsider's admin_resolve.
#[test]
fn resolve_only_through_the_oracle() {
    let mut w = World::new();
    fails(
        w.call(ALICE, ONE_YOCTO, |c| c.admin_resolve(2, OUT_HOLDS)),
        "NotOwner(alice.near)",
    );
    w.report(w.fed, OUT_HOLDS).unwrap();
    assert_eq!(w.possible(1), ROOT);
    fails(
        w.finalize(BOB, w.fed),
        "DisputeWindowNotOver(2, 1790000030)",
    );
    assert_eq!(w.possible(1), ROOT);
    w.warp(DISPUTE_WINDOW);
    w.finalize(BOB, w.fed).unwrap();
    assert_eq!(w.possible(1), HOLDS);
}

#[test]
fn resolve_events_in_any_order() {
    let mut w = World::new();
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    assert_eq!(w.possible(1), HOLDS);
    // the binary scenario does not use the Fed event
    assert_eq!(w.possible(2), BIN_ROOT);
    assert_eq!(w.view(|c| c.get_scenario(1).resolution_count), 1);
    w.admin_resolve(w.spice, OUT_DELAYED).unwrap();
    assert_eq!(w.possible(1), DELAYED_HOLDS);
    assert_eq!(w.possible(2), BIN_DELAYED);
    assert_eq!(w.view(|c| c.get_scenario(1).resolution_count), 2);
    assert_eq!(w.view(|c| c.get_scenario(2).resolution_count), 1);
}

/// All eight (fed first, outcome, outcome) cases fit in a loop.
#[test]
fn resolve_order_does_not_matter() {
    for fed_first in [false, true] {
        for spice_out in 0..2u8 {
            for fed_out in 0..2u8 {
                let mut w = World::new();
                let (spice, fed) = (w.spice, w.fed);
                if fed_first {
                    w.admin_resolve(fed, fed_out).unwrap();
                    w.admin_resolve(spice, spice_out).unwrap();
                } else {
                    w.admin_resolve(spice, spice_out).unwrap();
                    w.admin_resolve(fed, fed_out).unwrap();
                }
                let world = spice_out + 2 * fed_out;
                assert_eq!(
                    w.possible(1),
                    1 << world,
                    "fed_first {fed_first} spice {spice_out} fed {fed_out}"
                );
            }
        }
    }
}

#[test]
fn resolve_emits_worlds_removed() {
    let mut w = World::new();
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    assert!(w.last.logs.contains(
        &r#"EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"worlds_removed","data":[{"scenario_id":1,"event_id":2,"outcome":1,"removed":3,"possible":12}]}"#
            .to_string()
    ));
}

#[test]
fn resolve_fails() {
    let mut w = World::new();
    let (s2x2, s_bin, fed) = (w.s2x2, w.s_bin, w.fed);
    fails(
        w.call(CONTRACT, NO_DEPOSIT, |c| c.resolve(s_bin, fed, OUT_HOLDS)),
        "EventNotInScenario(2, 2)",
    );
    fails(
        w.call(CONTRACT, NO_DEPOSIT, |c| c.resolve(s2x2, fed, 2)),
        "InvalidOutcome(2)",
    );
    w.call(CONTRACT, NO_DEPOSIT, |c| c.resolve(s2x2, fed, OUT_HOLDS))
        .unwrap();
    fails(
        w.call(CONTRACT, NO_DEPOSIT, |c| c.resolve(s2x2, fed, OUT_CUTS)),
        "EventAlreadyResolved(1, 2)",
    );
}

// Views

#[test]
fn is_live_and_value_in() {
    let mut w = World::new();
    assert!(w.view(|c| c.is_live(1, CUTS)));
    assert!(!w.view(|c| c.is_live(1, 0)));
    assert!(!w.view(|c| c.is_live(1, 0x10)));
    assert!(w.view(|c| c.value_in(1, L_SHAPE, 3)));
    assert!(!w.view(|c| c.value_in(1, L_SHAPE, 0)));
    assert!(!w.view(|c| c.value_in(1, L_SHAPE, 4)));
    w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
    assert!(!w.view(|c| c.is_live(1, CUTS)));
    // still contains SHIPS·HOLDS
    assert!(w.view(|c| c.is_live(1, SHIPS)));
    // DELAYED·CUTS is no longer possible
    assert!(!w.view(|c| c.value_in(1, L_SHAPE, 1)));
    assert!(w.view(|c| c.value_in(1, L_SHAPE, 2)));
}

#[test]
fn is_halted_while_proposal_open() {
    let mut w = World::new();
    assert!(!w.view(|c| c.is_halted(1)));
    w.report(w.fed, OUT_HOLDS).unwrap();
    assert!(w.view(|c| c.is_halted(1)));
    // does not use the Fed event
    assert!(!w.view(|c| c.is_halted(2)));
    w.warp(DISPUTE_WINDOW);
    w.finalize(BOB, w.fed).unwrap();
    assert!(!w.view(|c| c.is_halted(1)));
}

// Verse tokens

/// The ledger has no public mint or burn method at all, and every burn takes the caller's own balance:
/// bob cannot merge or redeem alice's tokens.
#[test]
fn only_the_contract_mints_and_burns() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &[SHIPS, DELAYED], E18).unwrap();
    fails(
        w.merge(BOB, 1, Wnear, &[SHIPS, DELAYED], ROOT, 1),
        "InsufficientBalance(bob.near, 0, 1)",
    );
    w.admin_resolve(w.spice, OUT_DELAYED).unwrap();
    fails(
        w.redeem(BOB, 1, Wnear, DELAYED, 1),
        "InsufficientBalance(bob.near, 0, 1)",
    );
    assert_eq!(w.supply(1, Wnear, DELAYED), E18);
}

#[test]
fn verse_token_transfers_stay_allowed_after_death() {
    let mut w = World::new();
    w.split_ft(ALICE, 1, Wnear, &[SHIPS, DELAYED], E18).unwrap();
    w.admin_resolve(w.spice, OUT_SHIPS).unwrap();
    w.mt_transfer(ALICE, BOB, &token_id(1, Wnear, DELAYED), E18)
        .unwrap();
    assert_eq!(w.bal(BOB, 1, Wnear, DELAYED), E18);
}

// Fuzz

proptest! {
    #![proptest_config(ProptestConfig { cases: 512, failure_persistence: None, ..ProptestConfig::default() })]

    /// Any live verse of the 2x2 scenario (all 16 masks are tried; invalid
    /// ones must fail), split along any valid partition and merged back,
    /// returns exactly the real asset that went in. Amounts from 1 to 1e30.
    #[test]
    fn split_merge_round_trip(amount in 1u128..=1_000_000_000_000_000_000_000_000_000_000u128, from in 0u8..16, part_seed: u64, holds_first: bool) {
        let mut w = World::new();
        if holds_first {
            w.admin_resolve(w.fed, OUT_HOLDS).unwrap();
        }
        let possible = w.possible(1);
        if from == 0 || from & possible == 0 {
            w.deposit(ALICE, Wnear, amount).unwrap();
            prop_assert!(w.split(ALICE, 1, Wnear, from, &[from], amount).is_err());
            return Ok(());
        }
        let parts = random_partition(from, possible, part_seed);
        if parts.is_empty() {
            // a single live world with nothing else in it cannot be split further
            return Ok(());
        }
        let mut first = Vec::new();
        if from != ROOT {
            let rest = ROOT & !from;
            first = if rest & possible != 0 { vec![from, rest] } else { vec![from] };
            w.split_ft(ALICE, 1, Wnear, &first, amount).unwrap();
            w.split(ALICE, 1, Wnear, from, &parts, amount).unwrap();
        } else {
            w.split_ft(ALICE, 1, Wnear, &parts, amount).unwrap();
        }
        for p in &parts {
            prop_assert_eq!(w.bal(ALICE, 1, Wnear, *p), amount);
        }
        prop_assert_eq!(w.reserves(1, Wnear), amount);

        w.merge(ALICE, 1, Wnear, &parts, from, amount).unwrap();
        if from != ROOT {
            w.merge(ALICE, 1, Wnear, &first, ROOT, amount).unwrap();
        }
        prop_assert_eq!(w.wallet(ALICE, Wnear), FUND);
        prop_assert_eq!(w.reserves(1, Wnear), 0);
        for m in 1..ROOT {
            prop_assert_eq!(w.supply(1, Wnear, m), 0);
        }
    }
}
