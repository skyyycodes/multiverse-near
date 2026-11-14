//! After the opening (SPEC-C 3.7.6, K5): unused parts, the seed lock, seed
//! withdrawals before and after resolutions, fees, the depth floor while the
//! market has debt, and the per-world minimums.

use near_sdk::json_types::U128;

use super::catalog_fixture::*;
use crate::catalog::PledgeState;
use crate::lending::tiers::{MarketId, Tier};
use crate::lending::Market;
use crate::ops::PauseFlag;
use crate::types::Asset::{Usdc, Wnear};
use crate::types::{VerseKey, WAD};

/// A Fed-only market opened by Carol from three pledgers, each asset over-
/// pledged so that some of it is unused: Alice (both), Bob (USDC), Dave
/// (wNEAR). Returns (proposal, scenario).
fn opened(w: &mut World) -> (u64, u64) {
    let fed = w.fed;
    let pid = propose_market(w, CAROL, &[fed]).unwrap();
    let (wnear, usdc) = goal_mix(w, pid);
    pledge(w, ALICE, pid, Wnear, whole(Wnear, wnear * 7 / 10)).unwrap();
    pledge(w, ALICE, pid, Usdc, whole(Usdc, usdc / 2)).unwrap();
    pledge(w, BOB, pid, Usdc, whole(Usdc, usdc * 7 / 10)).unwrap();
    give_wnear(w, DAVE, whole(Wnear, wnear * 6 / 10));
    pledge(w, DAVE, pid, Wnear, whole(Wnear, wnear * 6 / 10)).unwrap();
    let sid = open(w, CAROL, pid).unwrap();
    (pid, sid)
}

/// Dave has no wallet in the fixture: the owner's wNEAR is moved to him.
fn give_wnear(w: &mut World, who: &str, amount: u128) {
    let raw = w.to_raw(Wnear, amount);
    let owner = (acc(OWNER), Wnear);
    *w.wallets.get_mut(&owner).unwrap() -= raw;
    *w.wallets.entry((acc(who), Wnear)).or_default() += raw;
}

fn claim(w: &mut World, who: &str, pid: u64) -> Result<(u128, u128), String> {
    call_paying(w, who, ONE_YOCTO, |c| c.claim_unused(pid)).map(|r| (r.wnear.0, r.usdc.0))
}

fn withdraw(
    w: &mut World,
    who: &str,
    pid: u64,
    shares: Option<u128>,
    mins: (Vec<u128>, Vec<u128>),
) -> Result<(u128, u128), String> {
    let (a, b): (Vec<U128>, Vec<U128>) = (
        mins.0.into_iter().map(U128).collect(),
        mins.1.into_iter().map(U128).collect(),
    );
    call_paying(w, who, ONE_YOCTO, |c| {
        c.seed_withdraw(pid, shares.map(U128), a, b)
    })
    .map(|(x, y)| (x.0, y.0))
}

fn zeros(n: usize) -> (Vec<u128>, Vec<u128>) {
    (vec![0; n], vec![0; n])
}

fn shares_of(w: &mut World, pid: u64, who: &str) -> u128 {
    w.view(|c| c.pledge_of(pid, acc(who)))
        .and_then(|p| p.shares)
        .map_or(0, |s| s.0)
}

#[test]
fn unused_parts_come_back_once_and_the_last_claim_sweeps_the_dust() {
    let mut w = market_world();
    let (pid, _) = opened(&mut w);
    let p = record(&mut w, pid);
    let totals = crate::catalog::seed::totals_of(&p);
    let bits = PauseFlag::bits_of(&[PauseFlag::Exit]);
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = bits).unwrap();
    fails(claim(&mut w, ALICE, pid), "Paused(exit)");
    w.call(OWNER, NO_DEPOSIT, |c| c.pause.flags = 0).unwrap();
    fails(claim(&mut w, ALICE, 99), "UnknownProposal(99)");
    let fresh = propose_event(&mut w, DAVE).unwrap();
    fails(claim(&mut w, ALICE, fresh), &format!("NotOpen({fresh})"));
    fails(
        claim(&mut w, CAROL, pid),
        &format!("NoPledge({pid}, {CAROL})"),
    );
    let mut paid = (0, 0);
    for who in [ALICE, BOB, DAVE] {
        let pledge = w.view(|c| c.pledge_of(pid, acc(who))).unwrap();
        assert_eq!(pledge.state, PledgeState::Seed);
        let expected = totals.unused(pledge.wnear.0, pledge.usdc.0);
        assert_eq!((pledge.unused_wnear.0, pledge.unused_usdc.0), expected);
        let wallet = (w.wallet(who, Wnear), w.wallet(who, Usdc));
        let got = claim(&mut w, who, pid).unwrap();
        assert_eq!(got, expected);
        assert_eq!(logged(&w, "pledge_returned")[0]["reason"], "unused");
        // Paid out (whole token units; the rest to the internal balance).
        assert!(w.wallet(who, Usdc) + w.unit(Usdc) > wallet.1 + got.1);
        assert_eq!(claim(&mut w, who, pid).unwrap(), (0, 0), "once");
        paid = (paid.0 + got.0, paid.1 + got.1);
    }
    assert!(paid.0 > 0 && paid.1 > 0, "both assets were over-pledged");
    let after = record(&mut w, pid);
    assert_eq!(
        (after.escrow_wnear, after.escrow_usdc, after.unused_open),
        (0, 0, 0)
    );
    // The rounding dust (at most a unit per pledger) went to the contract.
    let dust = p.escrow_wnear + p.escrow_usdc - paid.0 - paid.1;
    assert!(dust <= 6);
    assert_books(&mut w);
}

#[test]
fn seed_withdraw_checks_and_exact_amounts() {
    let mut w = market_world();
    let (pid, sid) = opened(&mut w);
    let n = 2;
    let lock = record(&mut w, pid).seed_lock_sec;
    let unlock = w.now + lock;
    fails(
        withdraw(&mut w, ALICE, pid, None, zeros(n)),
        &format!("SeedLocked({pid}, {unlock})"),
    );
    w.warp(lock);
    fails(
        withdraw(&mut w, ALICE, pid, None, zeros(3)),
        "LengthMismatch",
    );
    fails(
        withdraw(&mut w, ALICE, pid, Some(0), zeros(n)),
        "ZeroAmount",
    );
    let have = shares_of(&mut w, pid, ALICE);
    fails(
        withdraw(&mut w, ALICE, pid, Some(have + 1), zeros(n)),
        &format!("InsufficientBalance({ALICE}, {have}, {})", have + 1),
    );
    // K5: the per-world amounts are what the minimums compare.
    let part = have / 3;
    let preview = w.view(|c| c.preview_seed_withdraw(pid, acc(ALICE), Some(U128(part))));
    assert_eq!(preview.max_shares.0, have);
    assert_eq!(preview.locked_until_sec, 0);
    let per_w: Vec<u128> = preview.per_world.wnear.iter().map(|x| x.0).collect();
    let per_u: Vec<u128> = preview.per_world.usdc.iter().map(|x| x.0).collect();
    let mut over = per_u.clone();
    over[1] += 1;
    let token = VerseKey::new(sid, Usdc, 2).token_id();
    fails(
        withdraw(&mut w, ALICE, pid, Some(part), (per_w.clone(), over)),
        &format!(
            "InsufficientOutput(1, {token}, {}, {})",
            per_u[1],
            per_u[1] + 1
        ),
    );
    let before = (w.wallet(ALICE, Wnear), w.wallet(ALICE, Usdc));
    let out = withdraw(
        &mut w,
        ALICE,
        pid,
        Some(part),
        (per_w.clone(), per_u.clone()),
    )
    .unwrap();
    assert_eq!(out, (preview.wnear_out.0, preview.usdc_out.0));
    for t in &preview.tokens {
        let key = VerseKey::parse(&t.token_id).unwrap();
        assert_eq!(w.bal(ALICE, sid, key.asset, key.mask), t.amount.0);
    }
    // The merged part is per-world minimum; the unused part came first.
    assert_eq!(out.0, *per_w.iter().min().unwrap());
    assert_eq!(out.1, *per_u.iter().min().unwrap());
    assert!(w.wallet(ALICE, Wnear) > before.0 + out.0 - w.unit(Wnear));
    let ev = logged(&w, "seed_withdrawn")[0].clone();
    assert_eq!((u(&ev["shares"]), u(&ev["wnear_out"])), (part, out.0));
    assert_eq!(logged(&w, "pledge_returned")[0]["reason"], "unused");
    let view = w.view(|c| c.pledge_of(pid, acc(ALICE))).unwrap();
    assert_eq!(view.withdrawn_shares.0, part);
    assert!(view.unused_paid);
    // The rest, then the pledge is gone.
    withdraw(&mut w, ALICE, pid, None, zeros(n)).unwrap();
    assert!(w.view(|c| c.pledge_of(pid, acc(ALICE))).is_none());
    let alice = acc(ALICE);
    assert!(!w.view(|c| c.account_markets(&alice)).pledges.contains(&pid));
    assert_all_backed(&mut w);
    assert_conserved(&mut w);
    assert_books(&mut w);
    // Shares outstanding never exceed the supply.
    let vault = w.view(|c| c.seed_vault(sid)).unwrap();
    let left = shares_of(&mut w, pid, BOB) + shares_of(&mut w, pid, DAVE);
    assert!(left <= vault.supply.0);
}

#[test]
fn a_full_resolution_unlocks_and_pays_real_assets_only() {
    let mut w = market_world();
    let (pid, sid) = opened(&mut w);
    let fed = w.fed;
    w.admin_resolve(fed, 1).unwrap();
    assert_eq!(w.possible(sid), 2);
    let preview = w.view(|c| c.preview_seed_withdraw(pid, acc(BOB), None));
    assert!(preview.tokens.is_empty());
    assert_eq!(preview.per_world.usdc[0].0, 0, "dead world");
    let out = withdraw(&mut w, BOB, pid, None, zeros(2)).unwrap();
    assert_eq!(out, (preview.wnear_out.0, preview.usdc_out.0));
    assert!(out.0 > 0 && out.1 > 0);
    for asset in [Wnear, Usdc] {
        for mask in [1, 2] {
            assert_eq!(w.bal(BOB, sid, asset, mask), 0);
        }
    }
    assert_all_backed(&mut w);
    assert_conserved(&mut w);
}

#[test]
fn a_partial_resolution_skips_dead_positions() {
    let mut w = market_world();
    let (_, eid, _) = open_kind_a(&mut w);
    w.warp(WINDOW);
    let spice = w.spice;
    let pid = propose_market(&mut w, CAROL, &[eid, spice]).unwrap();
    fund(&mut w, pid);
    let sid = open(&mut w, CAROL, pid).unwrap();
    w.admin_resolve(spice, 0).unwrap();
    let possible = w.possible(sid);
    assert_eq!(possible.count_ones(), 2);
    let lock = record(&mut w, pid).seed_lock_sec;
    w.warp(lock);
    let preview = w.view(|c| c.preview_seed_withdraw(pid, acc(ALICE), None));
    let out = withdraw(&mut w, ALICE, pid, None, zeros(4)).unwrap();
    assert_eq!(out, (preview.wnear_out.0, preview.usdc_out.0));
    for (w_idx, amount) in preview.per_world.wnear.iter().enumerate() {
        if possible & (1 << w_idx) == 0 {
            assert_eq!(amount.0, 0, "dead world {w_idx}");
        }
    }
    for t in &preview.tokens {
        let key = VerseKey::parse(&t.token_id).unwrap();
        assert!(key.mask & possible != 0, "only live singles come out");
    }
    assert_all_backed(&mut w);
    assert_conserved(&mut w);
    assert_books(&mut w);
}

#[test]
fn one_share_takes_its_slice_of_the_fees_not_all_of_them() {
    let mut w = market_world();
    let (pid, sid) = opened(&mut w);
    let pool = w.view(|c| c.get_scenario(sid)).pool_ids[0];
    // Carol trades: fees accrue to the vault's position.
    w.split_ft(CAROL, sid, Wnear, &[1, 2], 1_000 * E18).unwrap();
    w.call(CAROL, ONE_YOCTO, |c| {
        c.swap(pool, true, U128(1_000 * E18), U128(0))
    })
    .unwrap();
    let lock = record(&mut w, pid).seed_lock_sec;
    w.warp(lock);
    let vault = w.view(|c| c.seed_vault(sid)).unwrap();
    let fees = vault.positions[0].fees0.0;
    assert!(fees > 0);
    let supply = vault.supply.0;
    withdraw(&mut w, ALICE, pid, Some(1), zeros(2)).unwrap();
    let after = w.view(|c| c.seed_vault(sid)).unwrap();
    let idle: u128 = after
        .idle
        .iter()
        .filter(|t| t.token_id == VerseKey::new(sid, Wnear, 1).token_id())
        .map(|t| t.amount.0)
        .sum();
    // Fees were booked into idle; one share took floor(idle / supply).
    let before_idle: u128 = vault
        .idle
        .iter()
        .filter(|t| t.token_id == VerseKey::new(sid, Wnear, 1).token_id())
        .map(|t| t.amount.0)
        .sum();
    let total = before_idle + fees;
    assert_eq!(idle, total - total / supply);
    assert_eq!(after.positions[0].fees0.0, 0);
    assert_conserved(&mut w);
}

#[test]
fn the_depth_floor_binds_only_with_debt() {
    let mut w = market_world();
    let (pid, sid) = opened(&mut w);
    let lock = record(&mut w, pid).seed_lock_sec;
    w.warp(lock);
    let have = shares_of(&mut w, pid, ALICE);
    // Without debt the floor does not apply.
    let preview = w.view(|c| c.preview_seed_withdraw(pid, acc(ALICE), None));
    assert_eq!(preview.max_shares.0, have);
    // Debt in the market, and a lending depth 90% of the thinnest world pool.
    let key = MarketId::new(sid, Some(Tier::Safe)).key();
    let depth = w.view(|c| {
        let s = c.scenario(sid);
        s.pool_ids[..2]
            .iter()
            .map(|id| {
                let p = c.pool(*id);
                multiverse_math::pricing::depth_at_tick(
                    p.amm.liquidity(),
                    c.pool_mean_tick(p).unwrap(),
                )
            })
            .min()
            .unwrap()
    });
    w.call(OWNER, NO_DEPOSIT, |c| {
        c.markets.insert(
            key,
            Market {
                total_supply_assets: WAD,
                total_supply_shares: WAD,
                total_borrow_assets: WAD,
                total_borrow_shares: WAD,
                last_update: 0,
            },
        );
        let mut cfg = c.price_cfg(sid);
        cfg.min_depth = U128(depth * 9 / 10);
        c.prices.configs.insert(sid, cfg);
    })
    .unwrap();
    let preview = w.view(|c| c.preview_seed_withdraw(pid, acc(ALICE), None));
    let max = preview.max_shares.0;
    assert!(max < have && max > 0, "{max} of {have}");
    let pledge = w.view(|c| c.pledge_of(pid, acc(ALICE))).unwrap();
    assert_eq!(pledge.max_withdrawable_shares.0, max);
    let err = withdraw(&mut w, ALICE, pid, Some(max + 1), zeros(2)).unwrap_err();
    assert!(
        err.starts_with("SeedDepthFloor(") && err.ends_with(&format!(", {max})")),
        "{err}"
    );
    withdraw(&mut w, ALICE, pid, Some(max), zeros(2)).unwrap();
    assert_conserved(&mut w);
}
