//! The registry, the catalogue's owner setters and views (SPEC-C 3.7.1, 3.9,
//! K6): listing rules, market cards and the bounded market list, related
//! markets, proposal lists, pledge previews, and the catalogue a production
//! upgrade starts with (R14).

use near_sdk::json_types::U128;
use near_sdk::NearToken;

use super::catalog_fixture::*;
use super::migration::migrated_prod;
use crate::catalog::{MarketCardStatus, MarketOrigin, MarketParams, ProposalStatus};
use crate::prices::MarketPriceCfg;
use crate::types::Asset::{Usdc, Wnear};
use crate::types::WAD;

#[test]
fn listing_check_order() {
    let mut w = market_world();
    let (spice, b) = (w.spice, w.s_bin);
    fails(
        w.call(CAROL, NearToken::from_near(1), |c| {
            c.set_market_listing(b, true)
        }),
        &format!("NotOwner({CAROL})"),
    );
    fails(list(&mut w, 99, true), "UnknownScenario(99)");
    let dup = w.create_scenario(&[spice]).unwrap();
    fails(list(&mut w, dup, true), &format!("NotSeeded({dup})"));
    seed_worlds(&mut w, dup, &DEMO_BIN, &[DEPTH; 2]);
    fails(list(&mut w, dup, true), &format!("NotSeeded({dup})"));
    seed_odds(&mut w, dup, &independent_odds(2, 5_000, 0), ODDS_DEPTH);
    fails(list(&mut w, dup, true), &format!("DuplicateListed({b})"));
    fails(
        w.call(OWNER, NO_DEPOSIT, |c| c.set_market_listing(dup, false)),
        "DepositRequired",
    );
    // Unlisting frees the set; a resolved market can be listed without pools.
    list(&mut w, b, false).unwrap();
    assert_eq!(logged(&w, "market_listing_set")[0]["listed"], false);
    assert_eq!(
        w.view(|c| c.market_of_events(vec![spice])).listed_market,
        None
    );
    list(&mut w, dup, true).unwrap();
    assert_eq!(
        w.view(|c| c.market_of_events(vec![spice])).listed_market,
        Some(dup)
    );
    let lone = w.create_event("Lone?", &["YES", "NO"], RULE, 0).unwrap();
    let resolved = w.create_scenario(&[lone]).unwrap();
    w.admin_resolve(lone, 0).unwrap();
    list(&mut w, resolved, true).unwrap();
    let card = w.view(|c| c.get_market(resolved)).unwrap();
    assert_eq!(
        (card.listed, card.origin, card.status),
        (true, MarketOrigin::Owner, MarketCardStatus::Resolved)
    );
}

#[test]
fn reference_and_meta_check_orders() {
    let mut w = market_world();
    let (spice, fed, s, b) = (w.spice, w.fed, w.s2x2, w.s_bin);
    let set = |w: &mut World, who: &str, e: u64, sid: Option<u64>| {
        w.call(who, ONE_YOCTO, |c| c.set_reference_market(e, sid))
    };
    fails(
        set(&mut w, CAROL, spice, Some(b)),
        &format!("NotOwner({CAROL})"),
    );
    fails(set(&mut w, OWNER, 99, Some(b)), "UnknownEvent(99)");
    fails(set(&mut w, OWNER, spice, Some(99)), "UnknownScenario(99)");
    fails(
        set(&mut w, OWNER, fed, Some(b)),
        &format!("NotInScenario({fed}, {b})"),
    );
    let dup = w.create_scenario(&[spice]).unwrap();
    fails(
        set(&mut w, OWNER, spice, Some(dup)),
        &format!("NotListed({dup})"),
    );
    set(&mut w, OWNER, spice, Some(s)).unwrap();
    assert_eq!(w.view(|c| c.reference_market_of(spice)), Some(s));
    set(&mut w, OWNER, spice, None).unwrap();
    assert_eq!(
        logged(&w, "reference_market_set")[0]["scenario_id"],
        near_sdk::serde_json::Value::Null
    );
    assert_eq!(w.view(|c| c.reference_market_of(spice)), None);
    fails(
        propose_market(&mut w, DAVE, &[spice, fed]),
        &format!("NoReferenceMarket({spice})"),
    );

    let meta = |w: &mut World, who: &str, e: u64, source: String, cat: u8| {
        w.call(who, NearToken::from_millinear(10), |c| {
            c.set_event_meta(e, source, cat)
        })
    };
    fails(
        meta(&mut w, CAROL, fed, "x".into(), 2),
        &format!("NotOwner({CAROL})"),
    );
    fails(meta(&mut w, OWNER, 99, "x".into(), 2), "UnknownEvent(99)");
    fails(
        meta(&mut w, OWNER, fed, "x".repeat(257), 2),
        "TextTooLong(source)",
    );
    fails(meta(&mut w, OWNER, fed, "x".into(), 16), "BadCategory(16)");
    meta(&mut w, OWNER, fed, "FRED DFEDTARU".into(), 2).unwrap();
    assert_eq!(logged(&w, "event_meta_set")[0]["category"], 2);
    let m = w.view(|c| c.event_meta(fed)).unwrap();
    assert_eq!(
        (m.proposal_id, m.proposer, m.source.as_str(), m.category),
        (0, None, "FRED DFEDTARU", 2)
    );
    assert_eq!(w.view(|c| c.get_market(s)).unwrap().categories, vec![0, 2]);
}

#[test]
fn market_params_bounds() {
    let mut w = market_world();
    let p = params(&mut w);
    fails(
        w.call(CAROL, ONE_YOCTO, |c| c.set_market_params(p)),
        &format!("NotOwner({CAROL})"),
    );
    type Edit = fn(&mut MarketParams);
    let near = 1_000_000_000_000_000_000_000_000u128;
    let vectors: Vec<(Edit, &str)> = vec![
        (
            |p| p.bond_new_event = U128(101 * 1_000_000_000_000_000_000_000_000),
            "bond_new_event",
        ),
        (
            |p| p.bond_market = U128(101 * 1_000_000_000_000_000_000_000_000),
            "bond_market",
        ),
        (|p| p.reserve_base = U128(1), "reserve_base"),
        (|p| p.reserve_per_world = U128(1), "reserve_per_world"),
        (|p| p.proposal_ttl_sec = 3_599, "proposal_ttl_sec"),
        (|p| p.review_ttl_sec = 5_184_001, "review_ttl_sec"),
        (
            |p| p.min_pledge_window_sec = p.proposal_ttl_sec + 1,
            "min_pledge_window_sec",
        ),
        (|p| p.min_market_life_sec = 2_592_001, "min_market_life_sec"),
        (|p| p.notice_sec = 86_401, "notice_sec"),
        (|p| p.seed_lock_sec = 2_592_001, "seed_lock_sec"),
        (
            |p| p.evict_min_age_sec = p.proposal_ttl_sec + 1,
            "evict_min_age_sec",
        ),
        (|p| p.spam_floor_bps = 5_001, "spam_floor_bps"),
        (
            |p| p.goal_depth_usdc = U128(p.min_open_depth_usdc.0 - 1),
            "goal_depth_usdc",
        ),
        (
            |p| {
                p.min_open_depth_usdc = U128(0);
                p.goal_depth_usdc = U128(0)
            },
            "min_open_depth_usdc",
        ),
        (|p| p.min_goal_usdc = U128(0), "min_goal_usdc"),
        (|p| p.goal_round_usdc = U128(0), "goal_round_usdc"),
        (|p| p.beta_bps = 499, "beta_bps"),
        (|p| p.odds_clamp_bps = 0, "odds_clamp_bps"),
        (|p| p.mult_a_bps = [999, 20_000], "mult_a_bps"),
        (|p| p.mult_b_bps = [2_000, 2_000], "mult_b_bps"),
        (
            |p| p.max_anchor_divergence_bps = 2_001,
            "max_anchor_divergence_bps",
        ),
        (
            |p| p.max_reference_divergence_bps = 3_001,
            "max_reference_divergence_bps",
        ),
        (
            |p| p.min_reference_depth_usdc = U128(0),
            "min_reference_depth_usdc",
        ),
        (
            |p| p.min_reference_odds_depth_usdc = U128(0),
            "min_reference_odds_depth_usdc",
        ),
        (
            |p| p.max_external_divergence_bps = 3_001,
            "max_external_divergence_bps",
        ),
        (
            |p| p.max_pledges_per_account = 65,
            "max_pledges_per_account",
        ),
        (|p| p.max_active_per_account = 17, "max_active_per_account"),
        (|p| p.max_live_per_event = 17, "max_live_per_event"),
    ];
    for (edit, field) in vectors {
        fails(
            set_params(&mut w, edit),
            &format!("BadMarketParams({field})"),
        );
    }
    let dup = w.create_scenario(&[w.fed]).unwrap();
    fails(
        set_params(&mut w, |p| p.anchors[2] = dup),
        "BadMarketParams(anchors)",
    );
    set_params(&mut w, |p| p.notice_sec = 60).unwrap();
    let ev = logged(&w, "market_params_set")[0].clone();
    assert_eq!(ev["notice_sec"], 60);
    assert_eq!(ev["anchors"][0], w.s2x2);
    let view = w.view(|c| c.market_params());
    assert_eq!(
        (view.reserve_w2.0, view.reserve_w4.0, view.reserve_w8.0),
        (near / 10, near * 15 / 100, near / 4)
    );
    assert_eq!(view.params.notice_sec, 60);
}

#[test]
fn market_cards_and_the_list() {
    let mut w = market_world();
    let (s, b, spice, fed) = (w.s2x2, w.s_bin, w.spice, w.fed);
    let list = w.view(|c| c.list_markets(None, None, None));
    assert_eq!(
        list.markets
            .iter()
            .map(|m| m.scenario_id)
            .collect::<Vec<_>>(),
        vec![s, b]
    );
    assert_eq!(list.next_from, None);
    let dup = w.create_scenario(&[fed]).unwrap();
    let all = w.view(|c| c.list_markets(None, None, Some(false)));
    assert_eq!(all.markets.len(), 3);
    assert!(!all.markets[2].listed);
    assert_eq!(all.markets[2].origin, MarketOrigin::Owner);
    let paged = w.view(|c| c.list_markets(Some(1), Some(1), Some(false)));
    assert_eq!((paged.markets.len(), paged.next_from), (1, Some(2)));

    let card = w.view(|c| c.get_market(s)).unwrap();
    assert!(card.odds_known && card.lendable);
    assert_eq!(card.odds.iter().map(|q| q.0).sum::<u128>(), WAD);
    assert_eq!(card.world_prices[0].0, DEMO_2X2[0]);
    assert_eq!(card.pool_count, 7);
    assert_eq!(card.status, MarketCardStatus::Open);
    assert_eq!(card.deadline_sec, w.view(|c| c.get_event(fed)).deadline_sec);
    assert_eq!(
        card.min_world_depth.0,
        multiverse_math::mul_div_down(DEPTH, DEMO_2X2[3], WAD)
    );
    let s_ref = w.view(|c| c.spot_reference(&c.market_params_stored()).unwrap().s_ref);
    assert!(card.implied_spot.0.abs_diff(s_ref) * 1_000 < s_ref);
    assert!(card.pool_value.0 > 0);
    assert_eq!(card.seed, None);
    assert_eq!(
        w.view(|c| c.get_market(dup)).unwrap().status,
        MarketCardStatus::Open
    );
    assert_eq!(w.view(|c| c.get_market(99)), None);
    fails(
        w.try_view(|c| c.market_cards((1..=13).collect())),
        "TooManyIds(13, 12)",
    );
    assert_eq!(w.view(|c| c.market_cards(vec![b, 99, s])).len(), 2);

    // Deciding, then partly resolved.
    w.report(fed, 0).unwrap();
    assert_eq!(
        w.view(|c| c.get_market(s)).unwrap().status,
        MarketCardStatus::Deciding
    );
    w.dispute(fed).unwrap();
    w.admin_resolve(fed, 0).unwrap();
    let card = w.view(|c| c.get_market(s)).unwrap();
    assert_eq!(
        (card.status, card.possible),
        (MarketCardStatus::PartlyResolved, 0x3)
    );
    assert_eq!(
        card.deadline_sec,
        w.view(|c| c.get_event(spice)).deadline_sec
    );
}

#[test]
fn related_markets_share_an_event() {
    let mut w = market_world();
    let (s, b, spice, fed) = (w.s2x2, w.s_bin, w.spice, w.fed);
    let pid = propose_market(&mut w, DAVE, &[fed]).unwrap();
    w.create_scenario(&[spice]).unwrap();
    let related = w.view(|c| c.related_markets(b));
    assert_eq!(
        related
            .markets
            .iter()
            .map(|m| m.scenario_id)
            .collect::<Vec<_>>(),
        vec![s]
    );
    assert!(related.proposals.is_empty());
    let related = w.view(|c| c.related_markets(s));
    assert_eq!(
        related
            .markets
            .iter()
            .map(|m| m.scenario_id)
            .collect::<Vec<_>>(),
        vec![b]
    );
    assert_eq!(
        related
            .proposals
            .iter()
            .map(|p| p.proposal_id)
            .collect::<Vec<_>>(),
        vec![pid]
    );
    assert_eq!(w.view(|c| c.proposals_of_event(fed))[0].proposal_id, pid);
}

#[test]
fn list_markets_skips_long_unlisted_runs() {
    let mut w = market_world();
    let mut last = 0;
    for i in 0..19 {
        let e = w
            .create_event(&format!("Filler {i}?"), &["YES", "NO"], RULE, 0)
            .unwrap();
        for _ in 0..16 {
            last = w.create_scenario(&[e]).unwrap();
        }
    }
    let listed = w.create_scenario(&[w.fed]).unwrap();
    assert!(listed > last && listed > 300);
    seed_worlds(&mut w, listed, &DEMO_BIN, &[DEPTH; 2]);
    seed_odds(&mut w, listed, &independent_odds(2, 5_000, 0), ODDS_DEPTH);
    list(&mut w, listed, true).unwrap();
    let mut from = Some(1);
    let mut found = Vec::new();
    let mut pages = 0;
    while let Some(id) = from {
        let page = w.view(|c| c.list_markets(Some(id), Some(30), None));
        if let Some(next) = page.next_from {
            assert!(next <= id + 128, "at most 128 ids per call");
        }
        found.extend(page.markets.iter().map(|m| m.scenario_id));
        from = page.next_from;
        pages += 1;
    }
    assert_eq!(found, vec![w.s2x2, w.s_bin, listed]);
    assert_eq!(pages, 3);
}

#[test]
fn lendable_needs_odds_depth() {
    let mut w = market_world();
    let s = w.s2x2;
    let thinnest = w.view(|c| {
        c.scenario(s).pool_ids[4..]
            .iter()
            .map(|id| c.pool(*id).amm.liquidity())
            .min()
            .unwrap()
    });
    let set_cfg = |w: &mut World, reference: bool, min_depth: u128| {
        w.call(OWNER, NO_DEPOSIT, |c| {
            let cfg = MarketPriceCfg {
                reference,
                min_depth: U128(min_depth),
                ..c.price_cfg(s)
            };
            c.prices.configs.insert(s, cfg);
        })
        .unwrap();
    };
    set_cfg(&mut w, true, thinnest + 1);
    assert!(!w.view(|c| c.get_market(s)).unwrap().lendable);
    set_cfg(&mut w, true, thinnest);
    assert!(w.view(|c| c.get_market(s)).unwrap().lendable);
    set_cfg(&mut w, false, thinnest + 1);
    assert!(w.view(|c| c.get_market(s)).unwrap().lendable);
}

#[test]
fn get_events_takes_at_most_24_ids() {
    let mut w = market_world();
    let (spice, fed) = (w.spice, w.fed);
    let events = w.view(|c| c.get_events(vec![fed, spice]));
    assert_eq!(
        events.iter().map(|e| e.id).collect::<Vec<_>>(),
        vec![fed, spice]
    );
    assert_eq!(events[0].question, FED_QUESTION);
    fails(
        w.try_view(|c| c.get_events(vec![1; 25])),
        "TooManyIds(25, 24)",
    );
    fails(
        w.try_view(|c| c.get_events(vec![fed, 99])),
        "UnknownEvent(99)",
    );
}

#[test]
fn proposal_lists_and_previews() {
    let mut w = market_world();
    let fed = w.fed;
    let a = propose_event(&mut w, DAVE).unwrap();
    let b = propose_market(&mut w, CAROL, &[fed]).unwrap();
    let far = far_deadline(&w);
    let c3 = propose_event_with(&mut w, CAROL, "Third?", TERMS, far).unwrap();
    w.call(CAROL, ONE_YOCTO, |c| c.cancel_proposal(c3)).unwrap();
    assert_eq!(w.view(|c| c.proposal_count()), 3);
    let ids = |l: crate::catalog::ProposalList| {
        l.proposals
            .iter()
            .map(|p| p.proposal_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ids(w.view(|c| c.list_proposals(None, None, None))),
        vec![c3, b, a]
    );
    assert_eq!(
        ids(w.view(|c| c.list_proposals(None, None, Some("live".into())))),
        vec![b, a]
    );
    assert_eq!(
        ids(w.view(|c| c.list_proposals(None, None, Some("review".into())))),
        vec![a]
    );
    assert_eq!(
        ids(w.view(|c| c.list_proposals(None, None, Some("closed".into())))),
        vec![c3]
    );
    let page = w.view(|c| c.list_proposals(Some(2), Some(1), None));
    assert_eq!((ids(page.clone()), page.next_from), (vec![b], Some(1)));
    fails(
        w.try_view(|c| c.list_proposals(None, None, Some("open".into()))),
        "BadFilter(open)",
    );
    let summary = &w.view(|c| c.list_proposals(None, None, None)).proposals[1];
    assert_eq!(
        (summary.status, summary.blocker.clone()),
        (ProposalStatus::Pledging, None)
    );
    let summary = &w.view(|c| c.list_proposals(None, None, None)).proposals[2];
    assert_eq!(summary.blocker, Some(format!("NotApproved({a})")));
    assert!(summary.new_event.is_some());

    // The pledge preview: USDC alone deploys nothing.
    let (wnear, usdc) = goal_mix(&mut w, b);
    let preview = w.view(|c| c.pledge_preview(b, Usdc, U128(usdc)));
    assert_eq!(
        (
            preview.usable_before.0,
            preview.usable_after.0,
            preview.deployed_part.0
        ),
        (0, 0, 0)
    );
    assert_eq!(preview.needs, Some(Wnear));
    pledge(&mut w, BOB, b, Usdc, usdc).unwrap();
    let preview = w.view(|c| c.pledge_preview(b, Wnear, U128(wnear)));
    assert!(preview.goal_reached_after && preview.needs.is_none());
    assert!(preview.deployed_part.0 > 0 && preview.deployed_part.0 <= wnear);
    let opening = w.view(|c| c.opening_preview(b));
    assert_eq!(
        opening.blocker,
        Some(format!("GoalNotReached(0, {})", record(&mut w, b).goal))
    );
    assert_eq!(opening.needs, Some(Wnear));
    assert_eq!(opening.unused_usdc.0, usdc);
    let pledges = w.view(|c| c.pledges_of(acc(BOB)));
    assert_eq!(pledges.len(), 1);
    assert_eq!(
        (pledges[0].proposal_id, pledges[0].usdc.0, pledges[0].shares),
        (b, usdc, None)
    );
    let view = proposal_view(&mut w, b);
    assert_eq!(
        view.progress_bps,
        u32::try_from(usdc * 10_000 / view.goal.0).unwrap()
    );
}

#[test]
fn the_production_catalogue_after_migrate() {
    let mut p = migrated_prod();
    let listed = p.view(|c| c.list_markets(None, None, None));
    assert_eq!(
        listed
            .markets
            .iter()
            .map(|m| m.scenario_id)
            .collect::<Vec<_>>(),
        vec![5, 6]
    );
    let all = p.view(|c| c.list_markets(None, None, Some(false)));
    assert_eq!(all.markets.len(), 6);
    for card in &all.markets[..4] {
        assert_eq!((card.listed, card.origin), (false, MarketOrigin::Legacy));
    }
    assert_eq!(
        p.view(|c| c.market_of_events(vec![8, 7])).listed_market,
        Some(5)
    );
    assert_eq!(
        p.view(|c| c.market_check(vec![8, 7])).blocker.as_deref(),
        Some("MarketExists(5)")
    );
    assert_eq!(
        p.view(|c| c.market_check(vec![4])).blocker.as_deref(),
        Some("NoReferenceMarket(4)")
    );
    let fed_only = p.view(|c| c.market_check(vec![8]));
    assert_eq!(fed_only.blocker, None);
    assert_eq!(fed_only.goal.0, 42_000 * WAD);
    assert_eq!(p.view(|c| c.reference_market_of(7)), Some(6));
    assert_eq!(p.view(|c| c.reference_market_of(8)), Some(5));
    assert_eq!(p.view(|c| c.event_meta(6)).unwrap().category, 2);
    assert_eq!(p.view(|c| c.market_params_stored()).anchors, [5, 0, 0]);
}
