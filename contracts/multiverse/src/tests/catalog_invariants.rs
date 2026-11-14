//! The catalogue campaign (SPEC-C 8.6): random proposals, approvals,
//! rejections, pledges in both assets, withdrawals, cancels, settles,
//! openings (direct and replayed auto-opens), claims, seed withdrawals,
//! swaps, time, the oracle and owner markets on the same event sets, with a
//! ghost model of escrow and status. After every step: backing and token
//! conservation (V-1), the books (M-2, the NEAR funnel), escrow (M-1), shares
//! (M-6), dedup (M-8) and monotone status (M-11).

use std::collections::HashMap;

use near_sdk::json_types::U128;

use super::catalog_fixture::*;
use crate::catalog::seed::totals_of;
use crate::catalog::{question_hash, OpeningTerms, ProposalKind, ProposalStatus, VProposal};
use crate::types::Asset::{self, Usdc, Wnear};

const CASES: usize = 12;
const STEPS: usize = 80;
const PLEDGERS: [&str; 4] = [ALICE, BOB, CAROL, DAVE];

#[derive(Default)]
struct Coverage {
    openings: usize,
    refunds: usize,
    seed_withdrawals: usize,
    claims: usize,
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = next_seed(self.0);
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }
}

/// Every proposal id with its stored record.
fn proposals(w: &mut World) -> Vec<(u64, crate::catalog::Proposal)> {
    w.view(|c| {
        (1..=c.catalog.proposal_count)
            .filter_map(|pid| {
                c.catalog
                    .proposals
                    .get(&pid)
                    .map(|VProposal::V1(p)| (pid, p.clone()))
            })
            .collect()
    })
}

/// Every (proposal, pledger) with a pledge record.
fn holders(
    w: &mut World,
    all: &[(u64, crate::catalog::Proposal)],
) -> Vec<(u64, &'static str, bool)> {
    let mut out = Vec::new();
    for (pid, p) in all {
        for a in PLEDGERS {
            if w.view(|c| c.catalog.pledges.contains_key(&(*pid, acc(a)))) {
                out.push((*pid, a, p.status == ProposalStatus::Opened));
            }
        }
    }
    out
}

fn check(w: &mut World, ended: &mut HashMap<u64, ProposalStatus>) {
    assert_all_backed(w);
    assert_conserved(w);
    assert_books(w);
    let all = proposals(w);
    let mut live_keys = Vec::new();
    let mut live_hashes = Vec::new();
    for (pid, p) in &all {
        let pledges: Vec<crate::catalog::Pledge> = w.view(|c| {
            PLEDGERS
                .iter()
                .filter_map(|a| c.catalog.pledges.get(&(*pid, acc(a))).cloned())
                .collect()
        });
        if p.status == ProposalStatus::Opened {
            // M-1 after the opening, M-6.
            let totals = totals_of(p);
            let unpaid = pledges.iter().filter(|x| !x.unused_paid);
            let (uw, uu) = unpaid
                .map(|x| totals.unused(x.wnear, x.usdc))
                .fold((0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
            assert!(p.escrow_wnear >= uw && p.escrow_wnear - uw <= u128::from(p.pledgers) + 1);
            assert!(p.escrow_usdc >= uu && p.escrow_usdc - uu <= u128::from(p.pledgers) + 1);
            let outstanding: u128 = pledges
                .iter()
                .map(|x| totals.shares(x.wnear, x.usdc) - x.withdrawn_shares)
                .sum();
            let supply = w
                .view(|c| c.seed_vault(p.open.scenario_id))
                .unwrap()
                .supply
                .0;
            assert!(outstanding <= supply, "M-6");
            assert!(totals.total_shares() >= outstanding);
        } else {
            // M-1 before the opening: escrow is the pledges.
            let sum = pledges
                .iter()
                .fold((0, 0), |a, x| (a.0 + x.wnear, a.1 + x.usdc));
            assert_eq!((p.escrow_wnear, p.escrow_usdc), sum, "escrow of {pid}");
            assert_eq!(p.pledgers as usize, pledges.len());
        }
        let status = w.view(|c| c.effective_status(p).0);
        // M-11: an end is permanent. The one change SPEC-C 3.7.2's order
        // allows before a settle: an expired combination whose event then
        // resolves (or fills up) reads void; nothing ever reads live again.
        if let Some(end) = ended.get(pid).copied() {
            let allowed = status == end
                || (end == ProposalStatus::Expired
                    && status == ProposalStatus::Void
                    && p.status == ProposalStatus::Pledging);
            assert!(allowed, "proposal {pid} went from {end:?} to {status:?}");
            ended.insert(*pid, status);
        } else if status.is_terminal() || status == ProposalStatus::Opened {
            ended.insert(*pid, status);
        }
        // M-8: one live proposal per set and per question; none on a listed set.
        if matches!(status, ProposalStatus::Review | ProposalStatus::Pledging) {
            match p.kind {
                ProposalKind::Market => {
                    assert!(
                        !live_keys.contains(&p.key),
                        "two live proposals on {:?}",
                        p.key
                    );
                    live_keys.push(p.key);
                    assert!(w.view(|c| c.catalog.listed_by_set.get(&p.key).is_none()));
                }
                ProposalKind::NewEvent => {
                    let q = w.view(|c| c.catalog.texts.get(pid).map(|t| t.question.clone()));
                    if let Some(q) = q {
                        let h = question_hash(&q);
                        assert!(!live_hashes.contains(&h));
                        live_hashes.push(h);
                    }
                }
            }
        }
    }
}

fn step(w: &mut World, rng: &mut Rng, events: &[u64], cov: &mut Coverage) {
    let all = proposals(w);
    let pid = if all.is_empty() { 1 } else { rng.pick(&all).0 };
    let who = *rng.pick(&PLEDGERS);
    match rng.below(18) {
        0 | 1 => {
            let n = 1 + rng.below(2) as usize;
            let mut set = Vec::new();
            while set.len() < n {
                let e = *rng.pick(events);
                if !set.contains(&e) {
                    set.push(e);
                }
            }
            let _ = propose_market(w, who, &set);
        }
        2 => {
            let q = format!("Question {}?", rng.below(4));
            let deadline = far_deadline(w);
            let _ = propose_event_with(w, who, &q, TERMS, deadline);
        }
        3 => {
            let terms = (rng.below(2) == 0).then_some(OpeningTerms {
                odds0_bps: 3_000 + rng.below(4_000) as u16,
                mult_bps: [11_000, 9_000],
            });
            let _ = approve(w, pid, terms);
        }
        4 | 16 | 17 => {
            // End a pledged live proposal: reject a new event, let a
            // combination expire.
            let pledged = all.iter().find(|(id, p)| {
                p.escrow_wnear + p.escrow_usdc > 0 && w.view(|c| c.proposal_is_live(*id))
            });
            if let Some((pid, p)) = pledged {
                if p.kind == ProposalKind::NewEvent {
                    let forfeit = rng.below(2) == 0;
                    let _ = w.call(OWNER, ONE_YOCTO, |c| c.reject_proposal(*pid, forfeit));
                } else {
                    w.warp(p.expires_at_sec.saturating_sub(w.now) + 1);
                }
            }
        }
        5 | 6 => {
            let asset = *rng.pick(&Asset::ALL);
            let goal = all
                .iter()
                .find(|(id, _)| *id == pid)
                .map_or(0, |(_, p)| p.goal);
            let amount = whole(asset, goal / (2 + rng.below(6) as u128));
            if amount > 0 {
                let _ = pledge(w, who, pid, asset, amount);
                cov.openings += replay_auto_open(w).into_iter().flatten().count();
            }
        }
        7 => {
            // Fund a live proposal to its goal (approving a new event first).
            if let Some((pid, p)) = all
                .iter()
                .find(|(id, _)| w.view(|c| c.proposal_is_live(*id)))
            {
                if p.status == ProposalStatus::Review {
                    let _ = approve(w, *pid, None);
                }
                let (wnear, usdc) = goal_mix(w, *pid);
                let (a, b) = (*rng.pick(&PLEDGERS), *rng.pick(&PLEDGERS));
                if pledge(w, a, *pid, Wnear, wnear).is_ok()
                    && pledge(w, b, *pid, Usdc, usdc).is_ok()
                {
                    cov.openings += replay_auto_open(w).into_iter().flatten().count();
                }
            }
        }
        8 => {
            // A pledge record, ended proposals first.
            let records = holders(w, &all);
            let ended: Vec<_> = records
                .iter()
                .filter(|(pid, _, opened)| !opened && !w.view(|c| c.proposal_is_live(*pid)))
                .copied()
                .collect();
            let pool = if ended.is_empty() { records } else { ended };
            if let Some(&(pid, who, _)) = pool.get(rng.below(pool.len() as u64) as usize) {
                let wnear = (rng.below(3) > 0).then_some(U128(0));
                let terminal = !w.view(|c| c.proposal_is_live(pid));
                if let Ok(r) =
                    call_paying(w, who, ONE_YOCTO, |c| c.withdraw_pledge(pid, wnear, None))
                {
                    if terminal && r.wnear.0 + r.usdc.0 > 0 {
                        cov.refunds += 1;
                    }
                }
            }
        }
        9 => {
            let _ = w.call(who, ONE_YOCTO, |c| c.cancel_proposal(pid));
        }
        10 => {
            let _ = w.call(who, near_sdk::NearToken::from_yoctonear(0), |c| {
                c.settle_proposal(pid)
            });
        }
        11 => {
            if open(w, who, pid).is_ok() {
                cov.openings += 1;
            }
        }
        12 => {
            let opened: Vec<_> = holders(w, &all).into_iter().filter(|h| h.2).collect();
            if let Some(&(pid, who, _)) = opened.get(rng.below(opened.len() as u64) as usize) {
                if rng.below(2) == 0 {
                    w.warp(8 * DAY);
                }
                if call_paying(w, who, ONE_YOCTO, |c| c.claim_unused(pid)).is_ok() {
                    cov.claims += 1;
                }
                let n = all
                    .iter()
                    .find(|(id, _)| *id == pid)
                    .map_or(2, |(_, p)| p.world_count as usize);
                let shares = (rng.below(2) == 0).then_some(U128(1_000 * E18));
                let mins = vec![U128(0); n];
                if call_paying(w, who, ONE_YOCTO, |c| {
                    c.seed_withdraw(pid, shares, mins.clone(), mins)
                })
                .is_ok()
                {
                    cov.seed_withdrawals += 1;
                }
            }
        }
        13 => {
            // A trade in an opened market's first world pool.
            if let Some((_, p)) = all.iter().find(|(_, p)| p.status == ProposalStatus::Opened) {
                let sid = p.open.scenario_id;
                let (root, pool) =
                    w.view(|c| (c.scenario(sid).root(), c.scenario(sid).pool_ids[0]));
                let singles: Vec<u8> = (0..8).map(|i| 1u8 << i).filter(|m| m & root != 0).collect();
                if w.split_ft(ALICE, sid, Wnear, &singles, 100 * E18).is_ok() {
                    let _ = w.call(ALICE, ONE_YOCTO, |c| {
                        c.swap(pool, true, U128(100 * E18), U128(0))
                    });
                }
            }
        }
        14 => {
            let span = if rng.below(4) == 0 { 15 * DAY } else { 2 * DAY };
            w.warp(60 + rng.below(span));
        }
        _ => {
            let e = *rng.pick(events);
            match rng.below(4) {
                0 => {
                    let _ = w.report(e, rng.below(2) as u8);
                }
                1 => {
                    let _ = w.dispute(e);
                }
                2 => {
                    w.warp(DISPUTE_WINDOW);
                    let _ = w.finalize(CAROL, e);
                }
                _ => {
                    if let Ok(sid) = w.create_scenario(&[e]) {
                        let _ = list(w, sid, true);
                    }
                }
            }
        }
    }
}

#[test]
fn catalogue_campaign() {
    let mut cov = Coverage::default();
    for case in 0..CASES {
        let mut w = market_world();
        w.fund(DAVE);
        let (e1, _) = owner_market(&mut w, "Will it snow in Delhi?", &DEMO_BIN, 5_000);
        let (e2, _) = owner_market(
            &mut w,
            "Will it rain in Pune?",
            &[3_200 * E15, 2_900 * E15],
            4_000,
        );
        w.warp(WINDOW);
        let events = [w.fed, w.spice, e1, e2];
        let mut rng = Rng(0x5eed_0000 + case as u64);
        let mut ended = HashMap::new();
        // Each case starts with a funded proposal, so openings happen early.
        let pid = propose_market(&mut w, DAVE, &[e1, e2]).unwrap();
        fund(&mut w, pid);
        cov.openings += replay_auto_open(&mut w).into_iter().flatten().count();
        for _ in 0..STEPS {
            step(&mut w, &mut rng, &events, &mut cov);
            check(&mut w, &mut ended);
        }
    }
    eprintln!(
        "coverage: openings {}, refunds {}, seed withdrawals {}, claims {}",
        cov.openings, cov.refunds, cov.seed_withdrawals, cov.claims
    );
    assert!(cov.openings > CASES, "openings {}", cov.openings);
    assert!(cov.refunds > CASES, "refunds {}", cov.refunds);
    assert!(
        cov.seed_withdrawals > CASES,
        "seed withdrawals {}",
        cov.seed_withdrawals
    );
    assert!(cov.claims > 0);
}
