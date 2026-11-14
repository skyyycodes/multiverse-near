//! The catalogue tests' fixture: the 2x2 SPICE x Fed demo market (the spot
//! anchor and Fed's reference) and the binary SPICE market (SPICE's
//! reference), both seeded, listed and past a full TWAP window, plus helpers
//! to propose, pledge, open and check the books.

#![allow(dead_code)]

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::NearToken;

pub use super::amm::{
    independent_odds, pool_world, seed_odds, seed_worlds, DEMO_2X2, DEMO_BIN, DEPTH, ODDS_DEPTH,
};
pub use super::harness::*;
use crate::catalog::{MarketParams, OpeningTerms, Proposal, ProposalView, VProposal, VSeedVault};
use crate::types::{Asset, VerseKey};
use crate::Contract;

pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// What proposals attach: more than any bond plus reserve.
pub const PROPOSE_DEPOSIT: NearToken = NearToken::from_near(1);
/// A full TWAP window and a second.
pub const WINDOW: u64 = 1_801;
pub const QUESTION: &str = "Will NEAR mainnet process 1 billion transactions by Jun 30, 2027?";
pub const RULE: &str = "YES if the NEAR explorer shows 1,000,000,000 transactions by the deadline.";
pub const SOURCE: &str = "https://nearblocks.io";
pub const TERMS: OpeningTerms = OpeningTerms {
    odds0_bps: 4_000,
    mult_bps: [11_500, 9_000],
};
pub const DAVE: &str = "dave.near";

/// Lists `sid` as the owner, paying with an attached deposit.
pub fn list(w: &mut World, sid: u64, listed: bool) -> Result<(), String> {
    w.call(OWNER, NearToken::from_near(1), |c| {
        c.set_market_listing(sid, listed)
    })
}

pub fn set_reference(w: &mut World, event: u64, sid: Option<u64>) -> Result<(), String> {
    w.call(OWNER, ONE_YOCTO, |c| c.set_reference_market(event, sid))
}

pub fn params(w: &mut World) -> MarketParams {
    w.view(|c| c.market_params_stored())
}

pub fn set_params(w: &mut World, f: impl FnOnce(&mut MarketParams)) -> Result<(), String> {
    let mut p = params(w);
    f(&mut p);
    w.call(OWNER, ONE_YOCTO, |c| c.set_market_params(p))
}

/// The base fixture with both demo markets seeded (2x2 at 3.70 / 3.00 / 3.30
/// / 2.50 with SPICE 66.67% and CUTS 1%, binary at 3.40 / 2.80), listed, set
/// as references (SPICE -> binary, Fed -> 2x2), the 2x2 as the anchor, and a
/// full TWAP window later.
pub fn market_world() -> World {
    let mut w = pool_world();
    let (s, b) = (w.s2x2, w.s_bin);
    seed_worlds(&mut w, s, &DEMO_2X2, &[DEPTH; 4]);
    seed_odds(&mut w, s, &independent_odds(4, 6_667, 100), ODDS_DEPTH);
    seed_worlds(&mut w, b, &DEMO_BIN, &[DEPTH; 2]);
    seed_odds(&mut w, b, &independent_odds(2, 6_667, 0), ODDS_DEPTH);
    list(&mut w, s, true).unwrap();
    list(&mut w, b, true).unwrap();
    let (spice, fed) = (w.spice, w.fed);
    set_reference(&mut w, spice, Some(b)).unwrap();
    set_reference(&mut w, fed, Some(s)).unwrap();
    set_params(&mut w, |p| p.anchors = [s, 0, 0]).unwrap();
    w.register(DAVE, NearToken::from_near(1));
    w.warp(WINDOW);
    w
}

pub fn propose_market(w: &mut World, who: &str, events: &[u64]) -> Result<u64, String> {
    let events = events.to_vec();
    w.call(who, PROPOSE_DEPOSIT, |c| c.propose_market(events))
}

pub fn propose_event_with(
    w: &mut World,
    who: &str,
    question: &str,
    terms: OpeningTerms,
    deadline: u64,
) -> Result<u64, String> {
    let q = question.to_string();
    w.call(who, PROPOSE_DEPOSIT, |c| {
        c.propose_event(
            q,
            vec!["YES".into(), "NO".into()],
            RULE.into(),
            SOURCE.into(),
            deadline,
            1,
            terms,
        )
    })
}

/// A deadline far enough out for a new event.
pub fn far_deadline(w: &World) -> u64 {
    w.now + 90 * DAY
}

pub fn propose_event(w: &mut World, who: &str) -> Result<u64, String> {
    let deadline = far_deadline(w);
    propose_event_with(w, who, QUESTION, TERMS, deadline)
}

pub fn approve(w: &mut World, pid: u64, terms: Option<OpeningTerms>) -> Result<(), String> {
    w.call(OWNER, ONE_YOCTO, |c| c.approve_proposal(pid, terms))
}

/// Pledges `internal` units of `asset`; returns the token units handed back.
pub fn pledge(
    w: &mut World,
    who: &str,
    pid: u64,
    asset: Asset,
    internal: u128,
) -> Result<u128, String> {
    let raw = w.to_raw(asset, internal);
    let msg = json!({"action": "pledge", "proposal_id": pid}).to_string();
    w.ft_transfer_call(who, asset, raw, &msg)
}

pub fn record(w: &mut World, pid: u64) -> Proposal {
    w.view(|c| match c.catalog.proposals.get(&pid).cloned().unwrap() {
        VProposal::V1(p) => p,
    })
}

pub fn proposal_view(w: &mut World, pid: u64) -> ProposalView {
    w.view(|c| c.get_proposal(pid)).unwrap()
}

/// Rounds up to whole USDC units.
pub fn whole(asset: Asset, internal: u128) -> u128 {
    internal.div_ceil(scale(asset)) * scale(asset)
}

/// The ideal mix scaled to 102% of the goal: (wNEAR, USDC).
pub fn goal_mix(w: &mut World, pid: u64) -> (u128, u128) {
    let p = record(w, pid);
    let wad = crate::types::WAD;
    let value = multiverse_math::mul_div_down(p.ideal_wnear, p.s_hint, wad) + p.ideal_usdc;
    let scale = |x: u128| multiverse_math::mul_div_down(x, p.goal, value) * 102 / 100;
    (
        whole(Asset::Wnear, scale(p.ideal_wnear)),
        whole(Asset::Usdc, scale(p.ideal_usdc)),
    )
}

/// Pledges the ideal mix at 102% of the goal: wNEAR from Alice, USDC from Bob.
pub fn fund(w: &mut World, pid: u64) {
    let (wnear, usdc) = goal_mix(w, pid);
    pledge(w, ALICE, pid, Asset::Wnear, wnear).unwrap();
    pledge(w, BOB, pid, Asset::Usdc, usdc).unwrap();
}

/// Runs the `auto_open` self-calls the last call scheduled, as the runtime
/// would; each must succeed (it never panics).
pub fn replay_auto_open(w: &mut World) -> Vec<Option<u64>> {
    let calls: Vec<u64> = w
        .last
        .calls()
        .iter()
        .filter(|c| c.method == "auto_open")
        .map(|c| {
            assert_eq!(c.receiver_id.as_str(), CONTRACT);
            assert!(c.after.is_empty(), "auto_open is detached");
            assert_eq!((c.deposit, c.tgas), (0, 200));
            c.args["proposal_id"].as_u64().unwrap()
        })
        .collect();
    calls
        .into_iter()
        .map(|pid| {
            w.exec(CONTRACT, NO_DEPOSIT, vec![], |c| c.auto_open(pid))
                .expect("auto_open must never panic")
        })
        .collect()
}

pub fn open(w: &mut World, who: &str, pid: u64) -> Result<u64, String> {
    w.call(who, NO_DEPOSIT, |c| c.open_market(pid))
}

/// The account's NEP-145 deposit, in yoctoNEAR.
pub fn deposit_of(w: &mut World, who: &str) -> u128 {
    let id = acc(who);
    w.view(|c| c.storage.get(&id).map_or(0, |a| a.deposit.as_yoctonear()))
}

pub fn storage_fund(w: &mut World) -> u128 {
    w.view(|c| c.catalog.storage_fund)
}

/// Seed vault idle tokens of `key`.
fn seed_idle(c: &Contract, key: &VerseKey) -> u128 {
    match c.catalog.seed_vaults.get(&key.scenario) {
        Some(VSeedVault::V1(v)) => v
            .idle
            .iter()
            .filter(|t| t.asset == key.asset && t.mask == key.mask)
            .map(|t| t.amount)
            .sum(),
        None => 0,
    }
}

/// Supply of every verse key == what accounts, pools, escrow, collateral,
/// the Root LP and the seed vaults hold.
pub fn assert_conserved(w: &mut World) {
    let accounts: Vec<_> = [OWNER, ALICE, BOB, CAROL, DAVE, CONTRACT]
        .iter()
        .map(|a| acc(a))
        .collect();
    w.view(|c| {
        for key in c.verse_keys() {
            let held: u128 = accounts
                .iter()
                .map(|a| c.verse_balance(a, &key))
                .sum::<u128>()
                + c.pool_holdings(&key)
                + c.escrow_holdings(&key)
                + c.collateral_holdings(&key)
                + c.vault_holdings(&key)
                + seed_idle(c, &key);
            assert_eq!(
                c.verse_supply(&key),
                held,
                "conservation of {}",
                key.token_id()
            );
        }
    });
}

/// Every possible world of every scenario is backed (invariant 1).
pub fn assert_all_backed(w: &mut World) {
    w.view(|c| {
        for sid in 1..=c.scenario_count {
            for world in c.backing(sid).worlds {
                assert!(
                    world.wnear_backed && world.usdc_backed,
                    "scenario {sid} world {}",
                    world.world
                );
            }
        }
    });
}

/// M-2 and the NEAR funnel: `books.pledges` = escrow summed over every
/// proposal; `books.near_held` = bond + reserve summed over them.
pub fn assert_books(w: &mut World) {
    w.view(|c| {
        let (mut wnear, mut usdc, mut near) = (0u128, 0u128, 0u128);
        for pid in 1..=c.catalog.proposal_count {
            if let Some(VProposal::V1(p)) = c.catalog.proposals.get(&pid) {
                wnear += p.escrow_wnear;
                usdc += p.escrow_usdc;
                near += p.bond + p.reserve;
            }
        }
        assert_eq!(c.books.pledges, [wnear, usdc], "books.pledges");
        assert_eq!(c.books.near_held, near, "books.near_held");
    });
}

/// The `data[0]` of the last call's `name` events.
pub fn logged(w: &World, name: &str) -> Vec<serde_json::Value> {
    w.last.data_of(name)
}

pub fn u(v: &serde_json::Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

pub fn u128_of(x: U128) -> u128 {
    x.0
}

/// An owner-made, listed binary market on a new event at `prices`, YES at
/// `yes_bps`, set as the event's reference (needs a TWAP window to price).
pub fn owner_market(
    w: &mut World,
    question: &str,
    prices: &[u128; 2],
    yes_bps: u128,
) -> (u64, u64) {
    let deadline = w.now + 120 * DAY;
    let e = w
        .create_event(question, &["YES", "NO"], RULE, deadline)
        .unwrap();
    let sid = w.create_scenario(&[e]).unwrap();
    seed_worlds(w, sid, prices, &[DEPTH; 2]);
    seed_odds(w, sid, &independent_odds(2, yes_bps, 0), ODDS_DEPTH);
    list(w, sid, true).unwrap();
    set_reference(w, e, Some(sid)).unwrap();
    (e, sid)
}

/// Opens a Kind A market on `QUESTION` from Dave's proposal: approve, fund,
/// open. Returns (proposal, event, scenario).
pub fn open_kind_a(w: &mut World) -> (u64, u64, u64) {
    let pid = propose_event(w, DAVE).unwrap();
    approve(w, pid, None).unwrap();
    fund(w, pid);
    let sid = replay_auto_open(w)[0].expect("opens");
    let eid = w.view(|c| c.get_scenario(sid)).event_ids[0];
    (pid, eid, sid)
}

/// The estimate an opening was checked against covers what it measured.
pub fn assert_estimate_covers(w: &World, estimate: u128) {
    let ev = w.last.data_of("market_opened");
    let measured = u(&ev[0]["storage_cost"]);
    assert!(
        estimate >= measured,
        "estimate {estimate} < measured {measured}"
    );
}
