//! Opening markets from pledges (SPEC-C 3.7.5, 8.6): both kinds at 2 and 4
//! worlds, the custody seeding and the vault, the storage paid from the
//! reserve then `storage_fund`, slot priority, the waiting blockers and the
//! detached `auto_open`.

use near_sdk::json_types::U128;
use near_sdk::NearToken;

use super::catalog_fixture::*;
use crate::catalog::{MarketOrigin, ProposalStatus, ProposalViewStatus};
use crate::types::Asset::{Usdc, Wnear};
use crate::types::WAD;

#[test]
fn kind_b_fed_only_opens_from_pledges() {
    let mut w = market_world();
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    let v = proposal_view(&mut w, pid);
    assert_eq!(v.status, ProposalViewStatus::Pledging);
    assert_eq!(v.goal.0 % (1_000 * WAD), 0);
    assert!(
        (40_000 * WAD..=45_000 * WAD).contains(&v.goal.0),
        "{}",
        v.goal.0
    );
    let dave_before = deposit_of(&mut w, DAVE);

    let p = record(&mut w, pid);
    let wnear = whole(Wnear, p.ideal_wnear * 101 / 100);
    let usdc = whole(Usdc, p.ideal_usdc * 101 / 100);
    pledge(&mut w, ALICE, pid, Wnear, wnear).unwrap();
    assert!(replay_auto_open(&mut w).is_empty(), "no USDC yet");
    pledge(&mut w, BOB, pid, Usdc, usdc).unwrap();
    assert_eq!(logged(&w, "open_scheduled").len(), 1);
    let preview = w.view(|c| c.opening_preview(pid));
    assert!(preview.can_open, "{:?}", preview.blocker);
    assert_eq!(proposal_view(&mut w, pid).status, ProposalViewStatus::Ready);
    let opened = replay_auto_open(&mut w);
    let sid = opened[0].expect("opened");
    let ev = logged(&w, "market_opened")[0].clone();
    assert_eq!(ev["proposal_id"], pid);
    assert_eq!(ev["opener"], CONTRACT);

    let p = record(&mut w, pid);
    assert_eq!(p.status, ProposalStatus::Opened);
    assert_eq!(p.open.scenario_id, sid);
    assert_eq!((p.bond, p.reserve), (0, 0));
    assert_eq!(p.open.used_wnear, preview.used_wnear.0);
    assert_eq!(p.open.used_usdc, preview.used_usdc.0);
    assert_eq!(p.escrow_wnear, wnear - p.open.used_wnear);
    assert_eq!(p.escrow_usdc, usdc - p.open.used_usdc);
    assert_eq!(w.reserves(sid, Wnear), p.open.used_wnear);
    assert_eq!(w.reserves(sid, Usdc), p.open.used_usdc);
    // The pools are the planner's.
    let s = w.view(|c| c.get_scenario(sid));
    assert_eq!(s.event_ids, vec![fed]);
    assert_eq!(s.pool_ids.len(), 3);
    for (i, plan) in preview.world_pools.iter().enumerate() {
        let pool = w.view(|c| c.pool(s.pool_ids[i]).amm.reserves());
        assert_eq!(pool, (plan.wnear.0, plan.usdc.0));
    }
    let odds = w.view(|c| c.pool(s.pool_ids[2]).amm.reserves());
    assert_eq!(
        odds,
        (
            preview.odds_pools[0].amount0.0,
            preview.odds_pools[0].amount1.0
        )
    );
    // Implied spot of the new market = S_ref.
    let implied = w.view(|c| c.implied_spot_of(sid));
    let s_ref = p.open.s_ref;
    assert!(
        implied.abs_diff(s_ref) * 1_000_000 < s_ref,
        "{implied} vs {s_ref}"
    );
    // Registry, listing and price config.
    let card = w.view(|c| c.get_market(sid)).unwrap();
    assert!(card.listed);
    assert_eq!(card.origin, MarketOrigin::Pledged);
    assert_eq!(card.proposal_id, Some(pid));
    assert_eq!(
        w.view(|c| c.market_of_events(vec![fed])).listed_market,
        Some(sid)
    );
    assert!(w.view(|c| c.prices.configs.contains_key(&sid)));
    let vault = w.view(|c| c.seed_vault(sid)).unwrap();
    assert_eq!(vault.supply.0, p.open.shares);
    assert_eq!(vault.positions.len(), 3);
    // Bond and unused reserve back; the market's bytes paid by the reserve.
    let cost = u(&ev["storage_cost"]);
    let params = params(&mut w);
    let held = params.bond_market.0 + params.reserve_for(2);
    assert_eq!(deposit_of(&mut w, DAVE), dave_before + held - cost);
    assert_eq!(storage_fund(&mut w), 0);
    let dave = acc(DAVE);
    assert!(w.view(|c| c.account_markets(&dave)).proposals.is_empty());
    assert!(!w.view(|c| c.catalog.proposal_by_set.contains_key(&p.key)));
    assert_all_backed(&mut w);
    assert_conserved(&mut w);
    assert_books(&mut w);
    // A second opening of the same proposal fails.
    fails(
        open(&mut w, CAROL, pid),
        &format!("AlreadyOpen({pid}, {sid})"),
    );
}

#[test]
fn kind_a_opens_after_approval_with_its_event_and_reference() {
    let mut w = market_world();
    let pid = propose_event(&mut w, DAVE).unwrap();
    let p = record(&mut w, pid);
    assert_eq!(p.status, ProposalStatus::Review);
    // Pledging is open in review, opening is not.
    fund(&mut w, pid);
    assert!(replay_auto_open(&mut w).is_empty());
    fails(open(&mut w, CAROL, pid), &format!("NotApproved({pid})"));
    assert_eq!(
        proposal_view(&mut w, pid).status,
        ProposalViewStatus::Review
    );
    let dave = deposit_of(&mut w, DAVE);
    approve(&mut w, pid, None).unwrap();
    let bond = params(&mut w).bond_new_event.0;
    assert_eq!(
        deposit_of(&mut w, DAVE),
        dave + bond,
        "bond back at approval"
    );
    let estimate = w.view(|c| c.open_storage_estimate(pid, &c.proposal_record(pid)));
    let sid = replay_auto_open(&mut w)[0].expect("approval schedules the opening");
    assert_estimate_covers(&w, estimate);
    let ev = logged(&w, "market_opened")[0].clone();
    let eid = ev["event_id"].as_u64().unwrap();
    let event = w.view(|c| c.get_event(eid));
    assert_eq!(event.question, QUESTION);
    assert_eq!(event.outcome_names, vec!["YES", "NO"]);
    assert_eq!(w.view(|c| c.reference_market_of(eid)), Some(sid));
    let meta = w.view(|c| c.event_meta(eid)).unwrap();
    assert_eq!(
        (meta.proposal_id, meta.source.as_str(), meta.category),
        (pid, SOURCE, 1)
    );
    assert_eq!(meta.proposer, Some(acc(DAVE)));
    let p = record(&mut w, pid);
    assert_eq!(p.key.ids(), vec![eid]);
    assert!(w.view(|c| c.catalog.texts.get(&pid).is_none()));
    let hash = crate::catalog::question_hash(QUESTION);
    assert!(w.view(|c| c.catalog.question_hashes.get(&hash).is_none()));
    // The view still shows the texts, now from the event.
    assert_eq!(
        proposal_view(&mut w, pid).new_event.unwrap().question,
        QUESTION
    );
    // Prices follow the terms: YES 40%, the odds pool says so.
    let s = w.view(|c| c.get_scenario(sid));
    let (yes, no) = w.view(|c| c.pool(s.pool_ids[2]).amm.reserves());
    let share = multiverse_math::odds::share_x(yes, no).unwrap();
    assert!(share.abs_diff(4 * WAD / 10) < WAD / 1_000_000, "{share}");
    assert_all_backed(&mut w);
    assert_conserved(&mut w);
    assert_books(&mut w);
}

#[test]
fn four_world_combination_opens_on_a_pledged_event() {
    let mut w = market_world();
    let (_, eid, _) = open_kind_a(&mut w);
    let spice = w.spice;
    // The new market prices once its pools have a full window.
    fails(
        propose_market(&mut w, CAROL, &[eid, spice]),
        &format!(
            "ReferenceUnavailable({}, young)",
            w.view(|c| c.reference_market_of(eid)).unwrap()
        ),
    );
    w.warp(WINDOW);
    let pid = propose_market(&mut w, CAROL, &[eid, spice]).unwrap();
    let p = record(&mut w, pid);
    assert_eq!(p.key.ids(), vec![spice, eid]);
    assert_eq!(p.world_count, 4);
    assert_eq!(p.goal % (1_000 * WAD), 0);
    let estimate = w.view(|c| c.open_storage_estimate(pid, &c.proposal_record(pid)));
    fund(&mut w, pid);
    let sid = replay_auto_open(&mut w)[0].expect("opens");
    assert_estimate_covers(&w, estimate);
    let s = w.view(|c| c.get_scenario(sid));
    assert_eq!(s.event_ids, vec![spice, eid]);
    assert_eq!(s.pool_ids.len(), 7);
    // 3W - 2 custody keys in one mt_mint.
    let mints = logged(&w, "mt_mint");
    assert_eq!(mints.len(), 1);
    assert_eq!(mints[0]["token_ids"].as_array().unwrap().len(), 10);
    let implied = w.view(|c| c.implied_spot_of(sid));
    let s_ref = record(&mut w, pid).open.s_ref;
    assert!(
        implied.abs_diff(s_ref) * 100_000 < s_ref,
        "{implied} vs {s_ref}"
    );
    assert_all_backed(&mut w);
    assert_conserved(&mut w);
    assert_books(&mut w);
}

#[test]
fn an_unregistered_opener_pays_nothing() {
    let mut w = market_world();
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    fund(&mut w, pid);
    let zed = "zed.near";
    let sid = open(&mut w, zed, pid).unwrap();
    assert!(w.view(|c| c.storage_balance_of(acc(zed))).is_none());
    assert_eq!(logged(&w, "market_opened")[0]["opener"], zed);
    assert_eq!(w.view(|c| c.get_scenario(sid)).event_ids, vec![fed]);
}

#[test]
fn storage_short_waits_for_a_top_up_then_the_fund() {
    let mut w = market_world();
    set_params(&mut w, |p| {
        p.reserve_base = U128(NEAR / 50);
        p.reserve_per_world = U128(NEAR / 100);
    })
    .unwrap();
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    fund(&mut w, pid);
    assert!(replay_auto_open(&mut w).is_empty(), "short: not scheduled");
    let p = record(&mut w, pid);
    let estimate = w.view(|c| c.open_storage_estimate(pid, &p));
    assert_eq!(p.reserve, NEAR / 25);
    fails(
        open(&mut w, CAROL, pid),
        &format!("OpenStorageShort({estimate}, {})", NEAR / 25),
    );
    let view = proposal_view(&mut w, pid);
    assert_eq!(view.status, ProposalViewStatus::Waiting);
    // Anyone tops the reserve up.
    let top = estimate - NEAR / 25;
    w.call(CAROL, NearToken::from_yoctonear(top), |c| {
        c.top_up_proposal(pid)
    })
    .unwrap();
    assert_eq!(logged(&w, "proposal_topped_up")[0]["account_id"], CAROL);
    assert_eq!(record(&mut w, pid).reserve, estimate);
    open(&mut w, CAROL, pid).unwrap();
    assert_estimate_covers(&w, estimate);
    assert_books(&mut w);

    // Backstop: a forfeited bond in storage_fund pays what the reserve
    // lacks, here for a new event with the longest texts.
    let (e, _) = owner_market(&mut w, "Will it snow in Delhi?", &DEMO_BIN, 5_000);
    w.warp(WINDOW);
    let spam = propose_market(&mut w, CAROL, &[e, fed]).unwrap();
    w.call(CAROL, ONE_YOCTO, |c| c.cancel_proposal(spam))
        .unwrap();
    let bond = params(&mut w).bond_market.0;
    assert_eq!(storage_fund(&mut w), bond);
    let deadline = far_deadline(&w);
    let pid3 = w
        .call(DAVE, PROPOSE_DEPOSIT, |c| {
            c.propose_event(
                "Q".repeat(280),
                vec!["Y".repeat(32), "N".repeat(32)],
                "R".repeat(1_024),
                "S".repeat(256),
                deadline,
                3,
                TERMS,
            )
        })
        .unwrap();
    approve(&mut w, pid3, None).unwrap();
    fund(&mut w, pid3);
    let p3 = record(&mut w, pid3);
    let estimate3 = w.view(|c| c.open_storage_estimate(pid3, &p3));
    assert!(estimate3 > p3.reserve && estimate3 <= p3.reserve + bond);
    let dave = deposit_of(&mut w, DAVE);
    replay_auto_open(&mut w)[0].expect("opens on the fund");
    assert_estimate_covers(&w, estimate3);
    let cost = u(&logged(&w, "market_opened")[0]["storage_cost"]);
    assert!(cost > p3.reserve, "the reserve alone was not enough");
    assert_eq!(storage_fund(&mut w), bond - (cost - p3.reserve));
    // Nothing of the reserve is left to return; the bond came back at approval.
    assert_eq!(deposit_of(&mut w, DAVE), dave);
    assert_books(&mut w);
}

/// `n` owner scenarios on `event` alone (unlisted duplicates).
fn fill_slots(w: &mut World, event: u64, n: usize) {
    for _ in 0..n {
        w.create_scenario(&[event]).unwrap();
    }
}

fn pledge_both(w: &mut World, pid: u64, factor_pct: u128) {
    let (wnear, usdc) = goal_mix(w, pid);
    pledge(w, ALICE, pid, Wnear, whole(Wnear, wnear * factor_pct / 100)).unwrap();
    pledge(w, BOB, pid, Usdc, whole(Usdc, usdc * factor_pct / 100)).unwrap();
}

#[test]
fn outranked_for_the_last_slot_until_the_better_funded_opens() {
    let mut w = market_world();
    let (e, _) = owner_market(&mut w, "Will it snow in Delhi?", &DEMO_BIN, 5_000);
    w.warp(WINDOW);
    let fed = w.fed;
    let p1 = propose_market(&mut w, DAVE, &[fed]).unwrap();
    let p2 = propose_market(&mut w, CAROL, &[e, fed]).unwrap();
    pledge_both(&mut w, p1, 100);
    pledge_both(&mut w, p2, 150);
    // 15 scenarios use Fed: one slot left, and p2 ranks higher.
    fill_slots(&mut w, fed, 14);
    assert_eq!(w.view(|c| c.scenarios_of_event(fed)).len(), 15);
    fails(
        open(&mut w, CAROL, p1),
        &format!("OutrankedForSlot({fed}, {p2})"),
    );
    assert_eq!(
        proposal_view(&mut w, p1).status,
        ProposalViewStatus::Waiting
    );
    open(&mut w, CAROL, p2).unwrap();
    // The event is full: p1 is void, its pledges refundable.
    fails(
        open(&mut w, CAROL, p1),
        &format!("ProposalClosed({p1}, void)"),
    );
    let v = proposal_view(&mut w, p1);
    assert_eq!(v.status, ProposalViewStatus::Void);
    assert_eq!(v.void_reason, Some(crate::catalog::VoidReason::EventFull));
}

#[test]
fn single_asset_pledges_do_not_outrank() {
    let mut w = market_world();
    let (e, _) = owner_market(&mut w, "Will it snow in Delhi?", &DEMO_BIN, 5_000);
    w.warp(WINDOW);
    let fed = w.fed;
    let p1 = propose_market(&mut w, DAVE, &[fed]).unwrap();
    let p2 = propose_market(&mut w, CAROL, &[e, fed]).unwrap();
    // p2: USDC only, far above its goal at s_hint, but nothing in wNEAR.
    let goal = record(&mut w, p2).goal;
    pledge(&mut w, BOB, p2, Usdc, whole(Usdc, 3 * goal)).unwrap();
    assert!(record(&mut w, p2).pledged_value() >= goal);
    pledge_both(&mut w, p1, 100);
    fill_slots(&mut w, fed, 14);
    open(&mut w, CAROL, p1).unwrap();
}

#[test]
fn event_deciding_waits_then_opens_after_a_dispute() {
    let mut w = market_world();
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    pledge_both(&mut w, pid, 100);
    w.report(fed, 0).unwrap();
    fails(open(&mut w, CAROL, pid), &format!("EventDeciding({fed})"));
    assert_eq!(
        proposal_view(&mut w, pid).status,
        ProposalViewStatus::Waiting
    );
    // A proposal on an event that is deciding cannot be made either.
    let (e, _) = owner_market(&mut w, "Will it snow in Delhi?", &DEMO_BIN, 5_000);
    fails(
        propose_market(&mut w, CAROL, &[fed, e]),
        &format!("EventDeciding({fed})"),
    );
    w.dispute(fed).unwrap();
    open(&mut w, CAROL, pid).unwrap();
}

#[test]
fn a_re_term_waits_out_the_notice() {
    let mut w = market_world();
    let pid = propose_event(&mut w, DAVE).unwrap();
    approve(&mut w, pid, None).unwrap();
    let goal = record(&mut w, pid).goal;
    let new_terms = crate::catalog::OpeningTerms {
        odds0_bps: 3_000,
        mult_bps: [12_000, 9_500],
    };
    approve(&mut w, pid, Some(new_terms)).unwrap();
    let p = record(&mut w, pid);
    assert_eq!(p.terms, new_terms);
    assert_ne!(p.goal, goal, "the goal follows the terms");
    let notice = params(&mut w).notice_sec;
    assert_eq!(p.open_not_before_sec, w.now + notice);
    assert_eq!(logged(&w, "proposal_approved")[0]["bond_returned"], "0");
    fund(&mut w, pid);
    assert!(replay_auto_open(&mut w).is_empty(), "notice: not scheduled");
    fails(
        open(&mut w, CAROL, pid),
        &format!("NoticePeriod({pid}, {})", p.open_not_before_sec),
    );
    w.warp(notice);
    open(&mut w, CAROL, pid).unwrap();
}

/// Writes the outside NEAR/USD reference as PRC's callback would.
fn set_reference_price(w: &mut World, price: u128, observed_at: u64) {
    w.call(OWNER, NO_DEPOSIT, |_| {
        let state = crate::reference::ReferenceState {
            price,
            observed_at,
            stored_at: observed_at,
            source: 2,
            ..Default::default()
        };
        near_sdk::env::storage_write(
            &near_sdk::IntoStorageKey::into_storage_key(crate::StorageKey::ReferenceState),
            &near_sdk::borsh::to_vec(&state).unwrap(),
        );
    })
    .unwrap();
}

fn s_ref(w: &mut World) -> u128 {
    w.view(|c| c.spot_reference(&c.market_params_stored()).unwrap().s_ref)
}

#[test]
fn require_external_blocks_on_a_stale_reference() {
    let mut w = market_world();
    let fed = w.fed;
    let s = s_ref(&mut w);
    set_params(&mut w, |p| p.require_external = true).unwrap();
    fails(propose_market(&mut w, DAVE, &[fed]), "ReferenceMissing");
    let now = w.now;
    set_reference_price(&mut w, s, now - 4_000);
    fails(
        propose_market(&mut w, DAVE, &[fed]),
        "ReferenceStale(4000, 3600)",
    );
    let far = s * 12 / 10;
    set_reference_price(&mut w, far, now);
    fails(
        propose_market(&mut w, DAVE, &[fed]),
        &format!("ExternalDisagrees({far}, {s})"),
    );
    set_reference_price(&mut w, s * 105 / 100, now);
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    // Openings wait for a fresh price too (step 8, wait class).
    w.warp(3_601);
    pledge_both(&mut w, pid, 100);
    assert!(replay_auto_open(&mut w).is_empty());
    fails(open(&mut w, CAROL, pid), "ReferenceStale(3601, 3600)");
    assert_eq!(
        proposal_view(&mut w, pid).status,
        ProposalViewStatus::Waiting
    );
    let now = w.now;
    set_reference_price(&mut w, s, now);
    open(&mut w, CAROL, pid).unwrap();
}

#[test]
fn a_blocked_auto_open_defers_without_failing() {
    let mut w = market_world();
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    pledge_both(&mut w, pid, 100);
    // The goal-reaching pledge scheduled the opening; the owner pauses
    // `mint` before it runs.
    let pledged = w.last.clone();
    let bits = crate::ops::PauseFlag::bits_of(&[crate::ops::PauseFlag::Mint]);
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = bits).unwrap();
    w.last = pledged;
    assert_eq!(replay_auto_open(&mut w), vec![None]);
    let deferred = logged(&w, "open_deferred");
    assert_eq!(deferred[0]["blocker"], "Paused(mint)");
    assert_eq!(deferred[0]["proposal_id"], pid);
    fails(open(&mut w, CAROL, pid), "Paused(mint)");
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = 0).unwrap();
    open(&mut w, CAROL, pid).unwrap();
}

#[test]
fn two_pledges_in_five_blocks_schedule_once() {
    let mut w = market_world();
    let fed = w.fed;
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    pledge_both(&mut w, pid, 100);
    assert_eq!(logged(&w, "open_scheduled").len(), 1);
    let scheduled = record(&mut w, pid).open_scheduled_block;
    pledge(&mut w, CAROL, pid, Usdc, 100 * E18).unwrap();
    assert!(logged(&w, "open_scheduled").is_empty());
    assert!(w.last.calls().is_empty());
    w.warp(6);
    pledge(&mut w, CAROL, pid, Usdc, 100 * E18).unwrap();
    assert_eq!(logged(&w, "open_scheduled").len(), 1);
    assert!(record(&mut w, pid).open_scheduled_block > scheduled + 5);
    replay_auto_open(&mut w)[0].expect("opens");
}

#[test]
fn held_odds_push_moves_kind_b_odds_only_within_gate() {
    let mut w = market_world();
    let (s, b, fed) = (w.s2x2, w.s_bin, w.fed);
    // Push the 2x2's CUTS/HOLDS pool to even odds and hold it a full window.
    let pool = w.view(|c| *c.between.get(&(s, 0x3, 0xC)).unwrap());
    w.split_ft(OWNER, s, Usdc, &[0x3, 0xC], 2_000_000 * E18)
        .unwrap();
    let (r0, r1) = w.view(|c| c.pool(pool).amm.reserves());
    let even = multiverse_math::fixed::isqrt_u256(
        multiverse_math::U256::from(r0) * multiverse_math::U256::from(r1),
    )
    .low_u128();
    let owner = acc(OWNER);
    w.call(OWNER, NO_DEPOSIT, |c| {
        c.swap_exact_out_for(&owner, pool, false, r0 - even)
    })
    .unwrap();
    w.warp(WINDOW);
    let gate = w.view(|c| {
        let (a, b) = c.pool(pool).amm.reserves();
        a.min(b)
    });
    set_params(&mut w, |p| {
        p.anchors = [s, b, 0];
        p.min_reference_odds_depth_usdc = U128(gate);
    })
    .unwrap();
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    let twap = w.view(|c| {
        let cfg = crate::prices::MarketPriceCfg {
            min_depth: U128(0),
            ..c.price_cfg(s)
        };
        c.twap_odds(s, &cfg).unwrap()
    });
    let preview = w.view(|c| c.opening_preview(pid));
    assert_eq!(preview.odds[0].0, twap[0] + twap[1], "the pushed TWAP odds");
    assert!((WAD * 45 / 100..WAD * 55 / 100).contains(&preview.odds[0].0));
    // One unit past the gate: the reference is thin.
    set_params(&mut w, |p| p.min_reference_odds_depth_usdc = U128(gate + 1)).unwrap();
    fails(
        open(&mut w, CAROL, pid),
        &format!("ReferenceUnavailable({s}, thin_odds)"),
    );
}

#[test]
fn kind_b_prices_ignore_a_same_block_push() {
    let mut w = market_world();
    let (s, fed) = (w.s2x2, w.fed);
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    let before = w.view(|c| c.opening_preview(pid));
    // A push inside the band on the reference's odds pool and a world pool,
    // in the same second: the TWAP has not seen it.
    let (odds_pool, world_pool) = w.view(|c| {
        (
            *c.between.get(&(s, 0x3, 0xC)).unwrap(),
            c.world_pool(s, 0).unwrap(),
        )
    });
    let spot = w.view(|c| c.world_spot_price(s, 0).unwrap());
    w.split_ft(CAROL, s, Usdc, &[0x3, 0xC], 300 * E18).unwrap();
    w.call(CAROL, ONE_YOCTO, |c| {
        c.swap(odds_pool, false, U128(300 * E18), U128(0))
    })
    .unwrap();
    w.split_ft(CAROL, s, Wnear, &[1, 2, 4, 8], 2_000 * E18)
        .unwrap();
    w.call(CAROL, ONE_YOCTO, |c| {
        c.swap(world_pool, true, U128(2_000 * E18), U128(0))
    })
    .unwrap();
    assert!(w.view(|c| c.world_spot_price(s, 0).unwrap()) < spot * 97 / 100);
    let after = w.view(|c| c.opening_preview(pid));
    assert_eq!(
        (after.s_ref, after.odds.clone(), after.prices.clone()),
        (before.s_ref, before.odds, before.prices)
    );
}
