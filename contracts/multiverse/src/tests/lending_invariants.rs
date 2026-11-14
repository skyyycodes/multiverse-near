//! Invariants 3 and 4 of the money markets as stateful property tests, with
//! random lending and liquidation actions.
//!
//! There are no pools on the test chain, so each world pool is modelled by
//! its reserves: sales and price moves are constant-product swaps on them,
//! liquidity moves scale them, and a world is priced only while its USDC
//! reserve clears the 10,000 USDC depth gate. The world price fed to lending
//! is the model's spot price. Everything else (splits, collateral, loans,
//! liquidations, the oracle) runs through the contract.
//!
//! Both invariants are measured at one timestamp: the health factors before
//! and after a resolution, and a liquidated slice against the prices of the
//! same block. Every bad-debt liquidation is counted and printed.
//!
//! Every call's NEP-245 lines are replayed on a shadow ledger (EW-5). The
//! 8-world runners put the 3-event scenario in the 2x2's place and also
//! check EW-1..EW-4 after every action.

use std::cell::RefCell;
use std::collections::BTreeMap;

use near_sdk::NearToken;
use proptest::prelude::*;
use proptest::test_runner::{Config, TestRunner};

use super::eight::{check_eight_worlds, PRICES_8, THIRD_QUESTION, THIRD_RULE};
use super::harness::*;
use super::lending::*;
use super::liquidation::slice_value;
use super::tiers::TierLend;
use crate::amm::test_hooks;
use crate::lending::tiers::{MarketId, Tier};
use crate::lending::{CollateralKey, LiquidationState, RepayAmount, MAX_COLLATERAL_PIECES};
use crate::masks::single_worlds;
use crate::receiver::Receive;
use crate::types::Asset::{Usdc, Wnear};
use multiverse_math::risk::{dust_allowance, full_seize_repay, liquidation_target};
use multiverse_math::{mul_div_down, U256};
use near_sdk::borsh;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{AccountId, IntoStorageKey};

const CASES: u32 = 256;
const CASES_8: u32 = 24;
const ACTORS: [&str; 3] = [ALICE, CAROL, DAVE];
const LIQUIDATOR: &str = "leo.near";
const GATE: u128 = 10_000 * E18;
const DEPTH: u128 = 100_000 * E18;
const PERMANENT: u128 = 2_000 * E18;
const REMOVABLE: u128 = 98_000 * E18;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Op {
    Sell,
    DepositVerse,
    DepositReal,
    Borrow,
    Repay,
    WithdrawCollateral,
    Warp,
    Resolve,
    MovePrice,
    MoveLiquidity,
    Liquidate,
}

fn ops3() -> impl Strategy<Value = Op> {
    prop_oneof![
        Just(Op::Sell),
        Just(Op::DepositVerse),
        Just(Op::DepositReal),
        Just(Op::Borrow),
        Just(Op::Repay),
        Just(Op::WithdrawCollateral),
        Just(Op::Warp),
        Just(Op::Resolve),
    ]
}

fn ops4() -> impl Strategy<Value = Op> {
    prop_oneof![
        1 => Just(Op::Sell),
        1 => Just(Op::DepositVerse),
        1 => Just(Op::DepositReal),
        1 => Just(Op::Borrow),
        1 => Just(Op::Repay),
        1 => Just(Op::MovePrice),
        1 => Just(Op::MoveLiquidity),
        1 => Just(Op::Warp),
        1 => Just(Op::Resolve),
        2 => Just(Op::Liquidate),
    ]
}

/// Clamps a random amount into `lo..=hi`.
fn bound(x: u128, lo: u128, hi: u128) -> u128 {
    lo + x % (hi - lo + 1)
}

/// A world pool as its reserves; `held` is the removable LP part (binary only).
struct Pool {
    wnear: u128,
    usdc: u128,
    held: u128,
}

#[derive(Default)]
struct Stats {
    cases: u64,
    actions: u64,
    calls: BTreeMap<&'static str, u64>,
    resolutions: u64,
    checks_around_resolution: u64,
    violations: u64,
    liquidations: u64,
    precondition_held: u64,
    coverage_failures: u64,
    bad_debt_cases: Vec<(u128, u128, u128)>,
    bad_debt_shortfalls: u64,
    worst_shortfall_bps: u128,
    full_seizures: u64,
    dust_rejected: u64,
    skipped_halted: u64,
    skipped_no_price: u64,
    unexpected_fails: Vec<String>,
    guard_mismatches: u64,
    sizing_mismatches: u64,
}

impl Stats {
    fn ok(&mut self, name: &'static str, r: Result<impl Sized, String>) -> bool {
        let ok = r.is_ok();
        if ok {
            *self.calls.entry(name).or_default() += 1;
        }
        ok
    }
}

struct Campaign {
    w: World,
    sids: [u64; 2],
    events: Vec<u64>,
    pools: BTreeMap<(u64, u8), Pool>,
    steps: u64,
    /// Invariant 4 borrows nearer the limit and moves prices.
    liquidation: bool,
    /// The first scenario is the 3-event one.
    eight: bool,
}

impl Campaign {
    fn new(liquidation: bool, eight: bool) -> Self {
        clear_prices();
        let mut w = World::new();
        w.register(DAVE, NearToken::from_near(5));
        w.register(LIQUIDATOR, NearToken::from_near(20));
        for who in [CAROL, DAVE, LIQUIDATOR] {
            w.fund(who);
        }
        let mut events = vec![w.spice, w.fed];
        let (sids, first_prices): ([u64; 2], &[u128]) = if eight {
            let third = w
                .create_event(THIRD_QUESTION, &["YES", "NO"], THIRD_RULE, T0 + 50 * DAY)
                .unwrap();
            events.push(third);
            let s8 = w.create_scenario(&events).unwrap();
            ([s8, w.s_bin], &PRICES_8)
        } else {
            ([w.s2x2, w.s_bin], &PRICES_2X2)
        };
        w.track_logs();
        let mut pools = BTreeMap::new();
        for (i, p) in first_prices.iter().enumerate() {
            pools.insert(
                (sids[0], i as u8),
                Pool {
                    wnear: DEPTH,
                    usdc: mul_div_down(DEPTH, *p, E18),
                    held: 0,
                },
            );
        }
        for (i, p) in PRICES_BIN.iter().enumerate() {
            let (wnear, held) = if liquidation {
                (DEPTH, REMOVABLE)
            } else {
                (DEPTH, 0)
            };
            pools.insert(
                (sids[1], i as u8),
                Pool {
                    wnear,
                    usdc: mul_div_down(wnear, *p, E18),
                    held,
                },
            );
        }
        let mut c = Campaign {
            events,
            w,
            sids,
            pools,
            steps: 0,
            liquidation,
            eight,
        };
        for key in c.pools.keys().copied().collect::<Vec<_>>() {
            c.sync(key);
        }
        c.w.warp(61);
        for s in sids {
            c.w.lend(BOB, s, 1_000_000 * E18).unwrap();
        }
        if liquidation {
            c.open_loans();
        }
        c
    }

    /// Each actor sells 2,000 wNEAR into lending in each scenario, posts
    /// 1,000 real wNEAR, and borrows 99% of what the worst world carries.
    fn open_loans(&mut self) {
        let masks = if self.eight {
            // every world but the first; SHIPS; DELAYED·HOLDS (both C outcomes)
            [[0xFE, BIN_DELAYED], [0x55, BIN_SHIPS], [0x88, BIN_DELAYED]]
        } else {
            [
                [L_SHAPE, BIN_DELAYED],
                [SHIPS, BIN_SHIPS],
                [DELAYED_HOLDS, BIN_DELAYED],
            ]
        };
        for (i, who) in ACTORS.iter().enumerate() {
            for (j, s) in self.sids.into_iter().enumerate() {
                self.sell_into_lending(who, s, masks[i][j], 2_000 * E18);
                self.w.post_real(who, s, Wnear, 1_000 * E18).unwrap();
            }
        }
        self.w.warp(61);
        for who in ACTORS {
            for s in self.sids {
                let lowest = self.w.lowest(s, who);
                let amount = mul_div_down(lowest, LLTV, E18) * 99 / 100;
                self.w.borrow(who, s, amount).unwrap();
            }
        }
    }

    /// Model price and depth gate into the price table lending reads.
    fn sync(&mut self, key: (u64, u8)) {
        let p = &self.pools[&key];
        let price = mul_div_down(p.usdc, E18, p.wnear);
        if p.usdc >= GATE {
            test_hooks::set_price(key.0, key.1, price);
        } else {
            test_hooks::set_unpriced(key.0, key.1);
        }
    }

    /// Constant-product swap at the base fee; returns the output.
    fn swap(&mut self, key: (u64, u8), wnear_in: bool, amount: u128) -> u128 {
        let p = self.pools.get_mut(&key).unwrap();
        let after_fee = amount * 997 / 1000;
        let out = if wnear_in {
            let out = mul_div_down(p.usdc, after_fee, p.wnear + after_fee);
            p.wnear += after_fee;
            p.usdc -= out;
            out
        } else {
            let out = mul_div_down(p.wnear, after_fee, p.usdc + after_fee);
            p.usdc += after_fee;
            p.wnear -= out;
            out
        };
        self.sync(key);
        out
    }

    fn halted(&mut self, s: u64) -> bool {
        self.w.view(|c| c.is_halted(s))
    }

    fn pick(&self, seed: u64) -> (&'static str, u64) {
        (
            ACTORS[(seed % 3) as usize],
            self.sids[((seed >> 8) % 2) as usize],
        )
    }

    /// The router's sale into lending: wNEAR split into the live worlds, the
    /// worlds in `sell_mask` swapped to USDC-if-w, every piece posted.
    fn sell_into_lending(&mut self, who: &str, s: u64, sell_mask: u8, amount: u128) -> bool {
        let possible = self.w.possible(s);
        let root = self.w.view(|c| c.get_scenario(s).root);
        let singles = single_worlds(possible);
        if self.w.split_ft(who, s, Wnear, &singles, amount).is_err() {
            return false;
        }
        let mut ok = true;
        for single in singles {
            let wd = single.trailing_zeros() as u8;
            if sell_mask & single == 0 {
                ok &= self
                    .w
                    .post(who, s, &token_id(s, Wnear, single), amount)
                    .is_ok();
                continue;
            }
            let out = self.swap((s, wd), true, amount) / USDC_UNIT * USDC_UNIT;
            if out == 0 {
                continue;
            }
            let parts = [single, root ^ single];
            ok &= self.w.split_ft(who, s, Usdc, &parts, out).is_ok()
                && self.w.post(who, s, &token_id(s, Usdc, single), out).is_ok();
        }
        ok
    }

    fn run(&mut self, op: Op, seed: u64, amount: u128, st: &mut Stats) {
        match op {
            Op::Sell => {
                self.steps += 1;
                let (who, s) = self.pick(seed);
                if self.halted(s) {
                    return;
                }
                let root = self.w.view(|c| c.get_scenario(s).root);
                let sell_mask =
                    bound(u128::from(seed >> 16), 1, u128::from(root)) as u8 & self.w.possible(s);
                if sell_mask == 0 {
                    return;
                }
                let amount = bound(amount, E18, 5_000 * E18);
                let ok = self.sell_into_lending(who, s, sell_mask, amount);
                st.ok(
                    "sell_into_lending",
                    if ok { Ok(()) } else { Err(String::new()) },
                );
            }
            Op::DepositVerse => {
                self.steps += 1;
                let (who, s) = self.pick(seed);
                let wnear = (seed >> 16) & 1 == 0;
                let asset = if wnear { Wnear } else { Usdc };
                let (root, possible) = self.w.view(|c| {
                    let sc = c.get_scenario(s);
                    (sc.root, sc.possible)
                });
                let parts = random_partition(root, possible, seed >> 24);
                if parts.is_empty() {
                    return;
                }
                let mut amount = bound(
                    amount,
                    1_000_000_000_000,
                    if wnear { 5_000 * E18 } else { 10_000 * E18 },
                );
                if !wnear {
                    amount = amount / USDC_UNIT * USDC_UNIT;
                }
                let part = parts[((seed >> 32) % parts.len() as u64) as usize];
                let r = self
                    .w
                    .split_ft(who, s, asset, &parts, amount)
                    .and_then(|_| self.w.post(who, s, &token_id(s, asset, part), amount));
                st.ok("deposit_verse", r);
            }
            Op::DepositReal => {
                self.steps += 1;
                let (who, s) = self.pick(seed);
                let wnear = (seed >> 16) & 1 == 0;
                let mut amount = bound(
                    amount,
                    1_000_000_000_000,
                    if wnear { 3_000 * E18 } else { 5_000 * E18 },
                );
                if !wnear {
                    amount = amount / USDC_UNIT * USDC_UNIT;
                }
                let r = self
                    .w
                    .post_real(who, s, if wnear { Wnear } else { Usdc }, amount);
                st.ok("deposit_real", r);
            }
            Op::Borrow => {
                self.steps += 1;
                let (who, s) = self.pick(seed);
                let lowest = self.w.lowest(s, who);
                let capacity = mul_div_down(lowest, LLTV, E18);
                let debt = self.w.debt(s, who);
                if capacity <= debt + 1_000_000 {
                    return;
                }
                let (lo, hi) = if self.liquidation { (50, 100) } else { (1, 99) };
                let amount = (capacity - debt) * bound(amount, lo, hi) / 100;
                let r = self.w.borrow(who, s, amount);
                st.ok("borrow", r);
            }
            Op::Repay => {
                self.steps += 1;
                let (who, s) = self.pick(seed);
                let debt = self.w.debt(s, who);
                if debt == 0 {
                    return;
                }
                let r = if (seed >> 16) % 3 == 0 {
                    self.w.repay_ft(who, s, debt + USDC_UNIT, true)
                } else {
                    self.w.repay_ft(who, s, bound(amount, 1, debt), false)
                };
                // a repayment within the debt never fails
                assert!(st.ok("repay", r.clone()), "repay failed: {r:?}");
            }
            Op::WithdrawCollateral => {
                self.steps += 1;
                let (who, s) = self.pick(seed);
                let pieces = self.w.pieces(s, who);
                if pieces.is_empty() {
                    return;
                }
                let (piece, held) = &pieces[((seed >> 16) % pieces.len() as u64) as usize];
                let r = self.w.unpost(who, s, piece, bound(amount, 1, *held));
                st.ok("withdraw_collateral", r);
            }
            Op::Warp => {
                self.steps += 1;
                let secs = if self.liquidation && seed % 4 == 0 {
                    bound(u128::from(seed >> 2), u128::from(DAY), u128::from(30 * DAY))
                } else if self.liquidation {
                    bound(u128::from(seed), 1, 120)
                } else {
                    bound(u128::from(seed), 1, 900)
                };
                self.w.warp(secs as u64);
                *st.calls.entry("warp").or_default() += 1;
            }
            Op::Resolve if self.liquidation => self.resolve4(seed, st),
            Op::Resolve => self.resolve3(seed, st),
            Op::MovePrice => self.move_price(seed, amount, st),
            Op::MoveLiquidity => self.move_liquidity(seed, amount, st),
            Op::Liquidate => self.liquidate(seed, amount, st),
        }
    }

    fn pairs(&self) -> Vec<(u64, &'static str)> {
        self.sids
            .iter()
            .flat_map(|s| ACTORS.iter().map(move |a| (*s, *a)))
            .collect()
    }

    /// Invariant 3: an admin resolution (proposal and finalization in one
    /// call) never lowers a health factor at the same timestamp.
    fn resolve3(&mut self, seed: u64, st: &mut Stats) {
        if self.steps < 40 || seed % 4 != 0 {
            return;
        }
        let event = self.events[((seed >> 8) % self.events.len() as u64) as usize];
        if self.w.view(|c| c.get_event(event).finalized) {
            return;
        }
        let pairs = self.pairs();
        // V-3: HF and the liquidation-side reference factor, before and after
        // at the same timestamp; with the same factor this is v1's rule.
        let read = |w: &mut World, s: u64, a: &str| {
            let v = w.view(|c| c.borrow_view(s, Some(acc(a)), None)).account;
            (v.health_factor.map(|h| h.0), v.liquidation_factor.0)
        };
        let before: Vec<(Option<u128>, u128)> = pairs
            .iter()
            .map(|(s, a)| read(&mut self.w, *s, a))
            .collect();
        self.w
            .admin_resolve(event, ((seed >> 16) % 2) as u8)
            .unwrap();
        st.resolutions += 1;
        for (i, (s, a)) in pairs.iter().enumerate() {
            if self.w.debt(*s, a) == 0 {
                continue;
            }
            st.checks_around_resolution += 1;
            let (after, f_after) = read(&mut self.w, *s, a);
            let (hf_before, f_before) = before[i];
            let bound = mul_div_down(hf_before.unwrap(), f_after.min(f_before), f_before);
            if after.unwrap() + 2 < bound {
                st.violations += 1;
            }
        }
    }

    /// Invariant 4's oracle traffic: open proposals get disputed or
    /// finalized, new ones are proposed (halting the scenarios), and
    /// sometimes the admin resolves outright.
    fn resolve4(&mut self, seed: u64, st: &mut Stats) {
        self.steps += 1;
        let now = self.w.now;
        for event in self.events.clone() {
            let (open, at) = self
                .w
                .view(|c| (c.has_open_proposal(event), c.finalizable_at(event)));
            if open {
                let r = if now < at {
                    self.w.dispute(event)
                } else {
                    self.w.finalize(BOB, event)
                };
                st.ok(if now < at { "dispute" } else { "finalize" }, r);
                return;
            }
        }
        let event = self.events[((seed >> 8) % self.events.len() as u64) as usize];
        if self.w.view(|c| c.get_event(event).finalized) {
            return;
        }
        let outcome = ((seed >> 16) % 2) as u8;
        if self.steps >= 20 && seed % 16 == 1 {
            let r = self.w.report(event, outcome);
            st.ok("report", r);
        } else if self.steps >= 60 && seed % 8 == 0 {
            let r = self.w.admin_resolve(event, outcome);
            if st.ok("admin_resolve", r) {
                st.resolutions += 1;
            }
        }
    }

    fn move_price(&mut self, seed: u64, amount: u128, st: &mut Stats) {
        self.steps += 1;
        let s = self.sids[((seed >> 8) % 2) as usize];
        let worlds = self.w.view(|c| c.get_scenario(s).world_count);
        let mut wd = ((seed >> 16) % u64::from(worlds)) as u8;
        if (seed >> 40) & 1 == 1 {
            let who = ACTORS[((seed >> 48) % 3) as usize];
            wd = self.w.hf(s, who).1;
        }
        if self.w.possible(s) & (1 << wd) == 0 || self.halted(s) {
            return;
        }
        let down = (seed >> 24) & 1 == 0;
        let amount = if down {
            bound(amount, E18, 150_000 * E18)
        } else {
            bound(amount, E18 / 1_000, 500_000 * E18)
        } >> ((seed >> 32) % 10);
        if amount == 0 {
            return;
        }
        self.swap((s, wd), down, amount);
        *st.calls.entry("move_price").or_default() += 1;
    }

    fn move_liquidity(&mut self, seed: u64, percent: u128, st: &mut Stats) {
        self.steps += 1;
        let s = self.sids[1];
        let wd = (seed % 2) as u8;
        if self.w.possible(s) & (1 << wd) == 0 {
            return;
        }
        let pull = (seed >> 8) % 3 == 0;
        let pct = if (seed >> 16) % 4 == 0 {
            100
        } else {
            bound(percent, 1, 100)
        };
        let p = self.pools.get_mut(&(s, wd)).unwrap();
        let delta = (if pull { p.held } else { REMOVABLE - p.held }) * pct / 100;
        if delta < REMOVABLE / 1_000 {
            return;
        }
        let old = PERMANENT + p.held;
        p.held = if pull { p.held - delta } else { p.held + delta };
        let new = PERMANENT + p.held;
        p.wnear = mul_div_down(p.wnear, new, old);
        p.usdc = mul_div_down(p.usdc, new, old);
        self.sync((s, wd));
        *st.calls
            .entry(if pull {
                "pull_liquidity"
            } else {
                "add_liquidity"
            })
            .or_default() += 1;
    }

    /// The pause a liquidation of `who` must hit, if any.
    fn paused(&mut self, s: u64, who: &str) -> Option<String> {
        if self.halted(s) {
            return Some(format!("ScenarioHalted({s})"));
        }
        let (root, possible, worlds) = self.w.view(|c| {
            let sc = c.get_scenario(s);
            (sc.root, sc.possible, sc.world_count)
        });
        let wnear_worlds = self
            .w
            .pieces(s, who)
            .iter()
            .map(|(p, _)| CollateralKey::parse(s, p).unwrap())
            .filter(|k| k.asset() == Wnear)
            .fold(0u8, |m, k| m | k.mask(root));
        (0..worlds)
            .find(|wd| {
                possible & wnear_worlds & (1 << wd) != 0 && !super::liquidation::price_of(s, *wd).1
            })
            .map(|wd| format!("PriceUnavailable({wd})"))
    }

    fn liquidate(&mut self, seed: u64, amount: u128, st: &mut Stats) {
        self.steps += 1;
        for k in 0..6u64 {
            let i = (seed % 6 + k) % 6;
            let s = self.sids[(i / 3) as usize];
            let who = ACTORS[(i % 3) as usize];
            if self.w.pieces(s, who).is_empty() || self.w.hf(s, who).0.is_none_or(|h| h >= E18) {
                continue;
            }
            if let Some(expected) = self.paused(s, who) {
                if expected.starts_with("ScenarioHalted") {
                    st.skipped_halted += 1;
                } else {
                    st.skipped_no_price += 1;
                }
                match self.w.liquidate(LIQUIDATOR, s, who, None) {
                    Err(e) if e == expected => {}
                    _ => st.guard_mismatches += 1,
                }
                continue;
            }
            let r = if k == 0 {
                amount
            } else {
                let mix = next_seed(amount as u64 ^ k) as u128;
                (mix << 64) | u128::from(next_seed(mix as u64))
            };
            let mode = next_seed(seed ^ (k << 56)) % 4;
            self.liquidate_one(s, who, mode, r, st);
            return;
        }
    }

    fn liquidate_one(&mut self, s: u64, who: &str, mode: u64, r: u128, st: &mut Stats) {
        let c_min = self.w.lowest(s, who);
        let possible = self.w.possible(s);
        let max_price = (0..8u8)
            .filter(|wd| possible & (1 << wd) != 0)
            .map(|wd| super::liquidation::price_of(s, wd))
            .filter(|(_, ok)| *ok)
            .map(|(p, _)| p)
            .max()
            .unwrap_or(0);
        let debt = self.w.debt(s, who);
        let held = self.w.pieces(s, who);
        let max_repay = debt / 2;
        if max_repay == 0 {
            return;
        }
        let repay = match mode {
            // "max" on an underwater loan repays only what seizes everything
            0 => max_repay.min(full_seize_repay(c_min, BONUS)),
            1 => (bound(r, 1, max_repay) >> ((r >> 100) % 64)).max(1),
            _ => bound(r, 1, max_repay),
        };
        let target = liquidation_target(repay, BONUS);
        let n = held.len() as u32;
        let dust = target < c_min && target - repay < dust_allowance(n, max_price);
        let keys: Vec<CollateralKey> = held
            .iter()
            .map(|(p, _)| CollateralKey::parse(s, p).unwrap())
            .collect();
        let liq_before: Vec<u128> = keys
            .iter()
            .map(|k| match *k {
                CollateralKey::Verse { asset, mask } => self.w.bal(LIQUIDATOR, s, asset, mask),
                CollateralKey::Real(Wnear) => self.w.real(LIQUIDATOR, Wnear),
                CollateralKey::Real(Usdc) => 0,
            })
            .collect();
        let usdc_before = self.w.usdc_total(LIQUIDATOR);
        let result = self.w.liquidate(
            LIQUIDATOR,
            s,
            who,
            if mode == 0 { None } else { Some(repay) },
        );
        let liq = match result {
            Ok(l) => l,
            Err(e) => {
                if dust && e == format!("LiquidationTooSmall({repay})") {
                    st.dust_rejected += 1;
                } else {
                    st.unexpected_fails.push(e);
                }
                return;
            }
        };
        if dust || liq.repaid != repay {
            st.sizing_mismatches += 1;
        }
        st.liquidations += 1;
        let all = target >= c_min;
        if all {
            st.full_seizures += 1;
        }
        let mut usdc_seized = 0;
        for (i, ((piece, amount), key)) in held.iter().zip(&keys).enumerate() {
            let expected = if all {
                *amount
            } else {
                mul_div_down(*amount, target, c_min)
            };
            let received = match *key {
                CollateralKey::Verse { asset, mask } => {
                    self.w.bal(LIQUIDATOR, s, asset, mask) - liq_before[i]
                }
                CollateralKey::Real(Wnear) => self.w.real(LIQUIDATOR, Wnear) - liq_before[i],
                CollateralKey::Real(Usdc) => {
                    usdc_seized = liq.seized[i];
                    expected
                }
            };
            let left = self.w.held(s, who, piece);
            if liq.seized[i] != expected || received != expected || left != amount - expected {
                st.sizing_mismatches += 1;
            }
        }
        if self.w.usdc_total(LIQUIDATOR) + repay != usdc_before + usdc_seized {
            st.sizing_mismatches += 1;
        }
        let slice = slice_value(&mut self.w, s, &liq.pieces, &liq.seized);
        let worst_slice = (0..slice.len())
            .filter(|wd| possible & (1 << wd) != 0)
            .map(|wd| slice[wd])
            .min()
            .unwrap();
        let covered =
            U256::from(c_min) * U256::from(E18) >= U256::from(repay) * U256::from(E18 + BONUS);
        if covered {
            st.precondition_held += 1;
            if worst_slice < repay {
                st.coverage_failures += 1;
            }
        } else {
            st.bad_debt_cases.push((repay, c_min, worst_slice));
            if worst_slice < repay {
                st.bad_debt_shortfalls += 1;
                st.worst_shortfall_bps = st
                    .worst_shortfall_bps
                    .max((repay - worst_slice) * 10_000 / repay);
            }
        }
    }

    /// The books the markets keep, checked after every action: shares sum to
    /// the totals, supply covers borrows, piece lists hold only positive
    /// amounts (at most 16, no repeats), and every verse token is accounted for.
    fn check_books(&mut self) -> Result<(), TestCaseError> {
        let everyone = [ALICE, BOB, CAROL, DAVE, LIQUIDATOR];
        for s in self.sids {
            let ids: Vec<_> = everyone.iter().map(|a| acc(a)).collect();
            let (m, supply_sum, borrow_sum, lists) = self.w.view(|c| {
                (
                    c.market_of(MarketId::new(s, None)),
                    ids.iter()
                        .map(|a| c.supply_shares_of(MarketId::new(s, None), a))
                        .sum::<u128>(),
                    ids.iter()
                        .map(|a| c.borrow_shares_of(MarketId::new(s, None), a))
                        .sum::<u128>(),
                    ids.iter()
                        .map(|a| c.pieces(MarketId::new(s, None), a))
                        .collect::<Vec<_>>(),
                )
            });
            prop_assert_eq!(supply_sum, m.total_supply_shares);
            prop_assert_eq!(borrow_sum, m.total_borrow_shares);
            prop_assert!(m.total_supply_assets >= m.total_borrow_assets);
            for list in lists {
                prop_assert!(list.len() <= MAX_COLLATERAL_PIECES);
                prop_assert!(list.iter().all(|(_, a)| *a > 0));
                for (i, (k, _)) in list.iter().enumerate() {
                    prop_assert!(list[i + 1..].iter().all(|(other, _)| other != k));
                }
            }
        }
        self.w
            .assert_conservation(&[ALICE, BOB, CAROL, DAVE, LIQUIDATOR, OWNER]);
        Ok(())
    }
}

/// Runs the campaign; with `eight` on the 3-event scenario, with EW-1..EW-4
/// checked after every action too.
fn campaign(liquidation: bool, eight: bool) -> Stats {
    let stats = RefCell::new(Stats::default());
    let config = Config {
        cases: if eight { CASES_8 } else { CASES },
        failure_persistence: None,
        max_shrink_iters: 64,
        ..Config::default()
    };
    let ops = if liquidation {
        ops4().boxed()
    } else {
        ops3().boxed()
    };
    let actions = proptest::collection::vec((ops, any::<u64>(), any::<u128>()), 50..=200);
    let mut runner = TestRunner::new(config);
    let check = |c: &mut Campaign| -> Result<(), TestCaseError> {
        c.check_books()?;
        if eight {
            check_eight_worlds(&mut c.w).map_err(TestCaseError::fail)?;
        }
        Ok(())
    };
    let result = runner.run(&actions, |actions| {
        let mut c = Campaign::new(liquidation, eight);
        let mut s = stats.borrow_mut();
        s.cases += 1;
        check(&mut c)?;
        for (op, seed, amount) in actions {
            c.run(op, seed, amount, &mut s);
            s.actions += 1;
            check(&mut c)?;
        }
        Ok(())
    });
    if let Err(e) = result {
        panic!("{e}");
    }
    clear_prices();
    stats.into_inner()
}

#[test]
fn invariant_3_resolution_never_lowers_hf() {
    invariant_3("invariant_3_resolution_never_lowers_hf", false);
}

/// Invariant 3 and EW-1..EW-5 on the 3-event scenario.
#[test]
fn invariant_3_at_eight_worlds() {
    invariant_3("invariant_3_at_eight_worlds", true);
}

fn invariant_3(title: &str, eight: bool) {
    let s = campaign(false, eight);
    let cases = u64::from(if eight { CASES_8 } else { CASES });
    println!(
        "{title}: {} cases, {} actions; successful calls {:?}; resolutions {}, \
         checks around resolution {}, violations {}",
        s.cases, s.actions, s.calls, s.resolutions, s.checks_around_resolution, s.violations
    );
    assert_eq!(s.violations, 0);
    // the campaign must reach the states the invariant is about
    assert!(s.resolutions > cases);
    assert!(s.checks_around_resolution > cases);
}

#[test]
fn invariant_4_liquidation_covers_repayment() {
    invariant_4("invariant_4_liquidation_covers_repayment", false);
}

/// Invariant 4 and EW-1..EW-5 on the 3-event scenario.
#[test]
fn invariant_4_at_eight_worlds() {
    invariant_4("invariant_4_at_eight_worlds", true);
}

fn invariant_4(title: &str, eight: bool) {
    let s = campaign(true, eight);
    let cases = u64::from(if eight { CASES_8 } else { CASES });
    println!(
        "{title}: {} cases, {} actions; successful calls {:?}; liquidations {}, \
         precondition held {}, coverage failures {}, bad-debt cases {}, bad-debt shortfalls {}, worst shortfall {} \
         bps, full seizures {}, dust rejected {}, skipped halted {}, skipped no price {}, unexpected failures {}, \
         guard mismatches {}, sizing mismatches {}, resolutions {}",
        s.cases,
        s.actions,
        s.calls,
        s.liquidations,
        s.precondition_held,
        s.coverage_failures,
        s.bad_debt_cases.len(),
        s.bad_debt_shortfalls,
        s.worst_shortfall_bps,
        s.full_seizures,
        s.dust_rejected,
        s.skipped_halted,
        s.skipped_no_price,
        s.unexpected_fails.len(),
        s.guard_mismatches,
        s.sizing_mismatches,
        s.resolutions
    );
    for (repay, c_min, slice) in &s.bad_debt_cases {
        println!("  bad debt: repay {repay}, C_min {c_min}, worst-world slice {slice}");
    }
    assert_eq!(s.coverage_failures, 0);
    assert!(
        s.unexpected_fails.is_empty(),
        "unexpected failures: {:?}",
        s.unexpected_fails
    );
    assert_eq!(s.guard_mismatches, 0);
    assert_eq!(s.sizing_mismatches, 0);
    assert!(s.liquidations > cases);
    assert!(s.precondition_held > 0);
}

// ---- The tiered campaign (v2) ----
//
// The production tiers on both scenarios plus the binary scenario's Normal
// market at the v1 profile's terms, lenders and borrowers across the tiers,
// insurance donations, config changes, write-offs, the outside reference
// switched on and off, and liquidations in both modes: tokens, and cash
// sold into real world pools (the lending prices still come from the
// model). The books are checked after every action: share sums, L-1, L-2,
// L-3, L-6, L-11, L-14, L-15 and token conservation; resolutions check V-3
// with the reference factor.

const LENDERS: [&str; 2] = [BOB, "erin.near"];
const V2_ACCOUNTS: [&str; 7] = [ALICE, BOB, CAROL, DAVE, LIQUIDATOR, OWNER, "erin.near"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum OpV2 {
    Supply,
    Withdraw,
    Borrow,
    Repay,
    Post,
    Unpost,
    FundInsurance,
    Warp,
    MovePrice,
    Resolve,
    Liquidate,
    WriteOff,
    SetConfig,
    Reference,
}

fn ops_v2() -> impl Strategy<Value = OpV2> {
    prop_oneof![
        1 => Just(OpV2::Supply),
        1 => Just(OpV2::Withdraw),
        2 => Just(OpV2::Borrow),
        1 => Just(OpV2::Repay),
        1 => Just(OpV2::Post),
        1 => Just(OpV2::Unpost),
        1 => Just(OpV2::FundInsurance),
        2 => Just(OpV2::Warp),
        2 => Just(OpV2::MovePrice),
        1 => Just(OpV2::Resolve),
        3 => Just(OpV2::Liquidate),
        1 => Just(OpV2::WriteOff),
        1 => Just(OpV2::SetConfig),
        1 => Just(OpV2::Reference),
    ]
}

#[derive(Default)]
struct StatsV2 {
    cases: u64,
    actions: u64,
    calls: BTreeMap<&'static str, u64>,
    expected_fails: BTreeMap<String, u64>,
    unexpected_fails: Vec<String>,
    liquidations: u64,
    cash_outs: u64,
    full_liquidations: u64,
    write_offs: u64,
    above_kink: u64,
    resolutions: u64,
    v3_checks: u64,
    v3_violations: u64,
    quote_mismatches: u64,
    coverage_failures: u64,
}

impl StatsV2 {
    /// Counts a call; failures whose name starts with one of `expected`
    /// are fine, any other is recorded.
    fn record<T>(&mut self, name: &'static str, r: &Result<T, String>, expected: &[&str]) -> bool {
        match r {
            Ok(_) => {
                *self.calls.entry(name).or_default() += 1;
                true
            }
            Err(e) => {
                let short = e.split('(').next().unwrap_or(e).to_string();
                if expected.iter().any(|x| e.starts_with(x))
                    || e.starts_with("Reference")
                    || e.starts_with("ImpliedSpotUnknown")
                {
                    *self
                        .expected_fails
                        .entry(format!("{name}:{short}"))
                        .or_default() += 1;
                } else {
                    self.unexpected_fails.push(format!("{name}: {e}"));
                }
                false
            }
        }
    }
}

struct CampaignV2 {
    w: World,
    sids: [u64; 2],
    events: [u64; 2],
    pools: BTreeMap<(u64, u8), Pool>,
    steps: u64,
    /// Debt per (market key, account) after the last action, for L-6.
    debts: BTreeMap<(u64, String), u128>,
    /// Write-offs seen per market key, for L-15.
    written: BTreeMap<u64, u128>,
    /// Markets that went above the kink in this case.
    kinked: std::collections::BTreeSet<u64>,
}

fn markets_v2(sids: [u64; 2]) -> Vec<MarketId> {
    sids.iter()
        .flat_map(|s| {
            Tier::ALL
                .into_iter()
                .map(move |t| MarketId::new(*s, Some(t)))
        })
        .collect()
}

impl CampaignV2 {
    fn new() -> Self {
        clear_prices();
        let mut w = World::new_v2();
        w.register(DAVE, NearToken::from_near(5));
        w.register(LIQUIDATOR, NearToken::from_near(20));
        w.register("erin.near", NearToken::from_near(5));
        for who in [OWNER, CAROL, DAVE, LIQUIDATOR, "erin.near"] {
            w.fund(who);
        }
        let sids = [w.s2x2, w.s_bin];
        // Real pools for the cash-outs' sales; lending reads the model.
        super::amm::seed_worlds(&mut w, sids[0], &PRICES_2X2, &[DEPTH; 4]);
        super::amm::seed_worlds(&mut w, sids[1], &PRICES_BIN, &[DEPTH; 2]);
        // The binary Normal market at v1's terms.
        let b = sids[1];
        w.call(OWNER, ONE_YOCTO, |c| {
            c.set_tier_config(b, Tier::Normal, super::profile::v1_tier_config())
        })
        .unwrap();
        let mut pools = BTreeMap::new();
        for (i, p) in PRICES_2X2.iter().enumerate() {
            pools.insert(
                (sids[0], i as u8),
                Pool {
                    wnear: DEPTH,
                    usdc: mul_div_down(DEPTH, *p, E18),
                    held: 0,
                },
            );
        }
        for (i, p) in PRICES_BIN.iter().enumerate() {
            pools.insert(
                (sids[1], i as u8),
                Pool {
                    wnear: DEPTH,
                    usdc: mul_div_down(DEPTH, *p, E18),
                    held: 0,
                },
            );
        }
        let mut c = CampaignV2 {
            events: [w.spice, w.fed],
            w,
            sids,
            pools,
            steps: 0,
            debts: BTreeMap::new(),
            written: BTreeMap::new(),
            kinked: Default::default(),
        };
        for key in c.pools.keys().copied().collect::<Vec<_>>() {
            c.sync(key);
        }
        c.w.warp(61);
        for id in markets_v2(sids) {
            c.w.lend_in(id.tier, BOB, id.scenario_id, 8_000 * E18)
                .unwrap();
        }
        c.open_loans();
        c
    }

    /// Model price and depth gate into the price table lending reads.
    fn sync(&mut self, key: (u64, u8)) {
        let p = &self.pools[&key];
        let price = mul_div_down(p.usdc, E18, p.wnear);
        if p.usdc >= GATE {
            test_hooks::set_price(key.0, key.1, price);
        } else {
            test_hooks::set_unpriced(key.0, key.1);
        }
    }

    fn swap(&mut self, key: (u64, u8), wnear_in: bool, amount: u128) {
        let p = self.pools.get_mut(&key).unwrap();
        let after_fee = amount * 997 / 1000;
        if wnear_in {
            let out = mul_div_down(p.usdc, after_fee, p.wnear + after_fee);
            p.wnear += after_fee;
            p.usdc -= out;
        } else {
            let out = mul_div_down(p.wnear, after_fee, p.usdc + after_fee);
            p.usdc += after_fee;
            p.wnear -= out;
        }
        self.sync(key);
    }

    /// Every actor posts 1,000 real wNEAR and 1,500 USDC-if-w in each tier of
    /// each scenario and borrows 95% of its borrow limit there.
    fn open_loans(&mut self) {
        for who in ACTORS {
            for id in markets_v2(self.sids) {
                let s = id.scenario_id;
                self.w
                    .post_real_in(id.tier, who, s, Wnear, 1_000 * E18)
                    .unwrap();
                let possible = self.w.possible(s);
                for single in single_worlds(possible) {
                    self.w
                        .split_ft(who, s, Usdc, &[single, possible ^ single], 500 * E18)
                        .unwrap();
                    self.w
                        .post_in(id.tier, who, s, &token_id(s, Usdc, single), 500 * E18)
                        .unwrap();
                }
                let limit = self.borrow_limit(id, who);
                self.w.borrow_in(id.tier, who, s, limit * 95 / 100).unwrap();
            }
        }
    }

    fn borrow_limit(&mut self, id: MarketId, who: &str) -> u128 {
        let who = acc(who);
        self.w
            .view(|c| c.borrow_view(id.scenario_id, Some(who), Some(id.tier)))
            .account
            .borrow_limit
            .0
    }

    fn pick(&self, seed: u64) -> (&'static str, MarketId) {
        let markets = markets_v2(self.sids);
        (
            ACTORS[(seed % 3) as usize],
            markets[((seed >> 8) % markets.len() as u64) as usize],
        )
    }

    /// Every market's (Market, TierState) bytes but `except`'s.
    fn other_markets(&mut self, except: Option<MarketId>) -> Vec<Vec<u8>> {
        let ids: Vec<MarketId> = markets_v2(self.sids)
            .into_iter()
            .filter(|id| Some(*id) != except)
            .collect();
        self.w.view(|c| {
            ids.iter()
                .map(|id| {
                    let mut v = borsh::to_vec(&c.markets.get(&id.key()).cloned()).unwrap();
                    v.extend(borsh::to_vec(&c.tier_states.get(&id.key()).cloned()).unwrap());
                    v
                })
                .collect()
        })
    }

    fn run(&mut self, op: OpV2, seed: u64, amount: u128, st: &mut StatsV2) {
        self.steps += 1;
        let (who, id) = self.pick(seed);
        let (s, tier) = (id.scenario_id, id.tier);
        let others = matches!(
            op,
            OpV2::Supply
                | OpV2::Withdraw
                | OpV2::Borrow
                | OpV2::Repay
                | OpV2::Post
                | OpV2::Unpost
                | OpV2::FundInsurance
                | OpV2::WriteOff
                | OpV2::SetConfig
        )
        .then(|| self.other_markets(Some(id)));
        match op {
            OpV2::Supply => {
                let lender = LENDERS[((seed >> 16) % 2) as usize];
                let amount = bound(amount, 1, 20_000) * E18;
                let r = self.w.lend_in(tier, lender, s, amount);
                st.record("supply", &r, &["MarketFrozen", "MarketWipedOut"]);
            }
            OpV2::Withdraw => {
                let lender = LENDERS[((seed >> 16) % 2) as usize];
                let all = (seed >> 24) % 3 == 0;
                let lent = self.w.lent_in(tier, s, lender);
                if lent == 0 {
                    return;
                }
                let liquid = self.w.view(|c| c.market_state(s, Some(tier))).liquid.0;
                // Often everything that is liquid, which pushes utilization up.
                let amount = if all {
                    None
                } else if (seed >> 28) % 2 == 0 {
                    Some(lent.min(liquid).max(1))
                } else {
                    Some(bound(amount, 1, lent.min(liquid).max(1)))
                };
                let r = self.w.withdraw_lent_in(tier, lender, s, amount);
                st.record("withdraw", &r, &["InsufficientLiquidity", "ZeroAmount"]);
            }
            OpV2::Borrow => {
                let limit = self.borrow_limit(id, who);
                let debt = self.w.debt_in(tier, s, who);
                if limit <= debt + E18 {
                    return;
                }
                let amount = ((limit - debt) * bound(amount, 30, 100) / 100).max(100 * E18);
                let r = self.w.borrow_in(tier, who, s, amount);
                st.record(
                    "borrow",
                    &r,
                    &[
                        "Unhealthy",
                        "InsufficientLiquidity",
                        "UtilizationCap",
                        "BorrowCapExceeded",
                        "MarketFrozen",
                        "ScenarioHalted",
                    ],
                );
            }
            OpV2::Repay => {
                let debt = self.w.debt_in(tier, s, who);
                if debt == 0 {
                    return;
                }
                let r = if (seed >> 16) % 3 == 0 {
                    self.w.repay_in(tier, who, s, debt + USDC_UNIT, true)
                } else {
                    self.w.repay_in(tier, who, s, bound(amount, 1, debt), false)
                };
                // Only a partial repayment that would leave dust may fail.
                st.record("repay", &r, &["DustDebtLeft"]);
            }
            OpV2::Post => {
                let wnear = (seed >> 16) & 1 == 0;
                let amount = if wnear {
                    bound(amount, E18, 2_000 * E18)
                } else {
                    bound(amount, 1, 3_000) * E18
                };
                let r = self
                    .w
                    .post_real_in(tier, who, s, if wnear { Wnear } else { Usdc }, amount);
                st.record("post", &r, &["TooManyCollateralTokens"]);
            }
            OpV2::Unpost => {
                let pieces = self.w.pieces_in(tier, s, who);
                if pieces.is_empty() {
                    return;
                }
                let (piece, held) = pieces[((seed >> 16) % pieces.len() as u64) as usize];
                let piece_id = piece.piece_id(s);
                let amount = bound(amount, 1, held);
                let piece_arg = piece_id.clone();
                let r = self.w.call(who, ONE_YOCTO, |c| {
                    c.withdraw_collateral(
                        s,
                        piece_arg,
                        near_sdk::json_types::U128(amount),
                        Some(tier),
                    )
                });
                st.record("unpost", &r, &["Unhealthy", "ScenarioHalted"]);
            }
            OpV2::FundInsurance => {
                let amount = bound(amount, 1, 500) * E18;
                let r = self.w.fund_insurance_in(tier, DAVE, s, amount);
                st.record("fund_insurance", &r, &[]);
            }
            OpV2::Warp => {
                let secs = if seed % 3 == 0 {
                    bound(u128::from(seed >> 2), u128::from(DAY), u128::from(90 * DAY))
                } else {
                    bound(u128::from(seed), 1, 600)
                };
                self.w.warp(secs as u64);
                *st.calls.entry("warp").or_default() += 1;
            }
            OpV2::MovePrice => {
                let worlds = self.w.view(|c| c.get_scenario(s).world_count);
                let wd = ((seed >> 16) % u64::from(worlds)) as u8;
                if self.w.possible(s) & (1 << wd) == 0 {
                    return;
                }
                let down = (seed >> 24) % 3 != 0;
                let amount = if down {
                    bound(amount, E18, 200_000 * E18)
                } else {
                    bound(amount, E18, 400_000 * E18)
                } >> ((seed >> 32) % 6);
                if amount > 0 {
                    self.swap((s, wd), down, amount);
                    *st.calls.entry("move_price").or_default() += 1;
                }
            }
            OpV2::Resolve => self.resolve(seed, st),
            OpV2::Liquidate => self.liquidate(seed, amount, st),
            OpV2::WriteOff => {
                let ready = self
                    .w
                    .view(|c| c.liquidation_status(s, acc(who), Some(tier)))
                    .write_off_ready;
                let r = self.w.call(LIQUIDATOR, ONE_YOCTO, |c| {
                    c.write_off_bad_debt(s, acc(who), Some(tier))
                });
                if ready {
                    if st.record("write_off", &r, &[]) {
                        st.write_offs += 1;
                        *self.written.entry(id.key()).or_default() += r.unwrap().0;
                    }
                } else {
                    st.record(
                        "write_off",
                        &r,
                        &["NoDebt", "StillCollateralized", "PriceUnavailable"],
                    );
                }
            }
            OpV2::SetConfig => {
                let current = self.w.state_in(tier, s).config;
                let mut c = current.clone();
                c.rate_base = bound(u128::from(seed >> 16), 0, 1_000_000_000);
                c.rate_slope1 = bound(amount, 0, 3_000_000_000);
                c.rate_slope2 = bound(amount >> 64, 0, 30_000_000_000);
                c.reserve_factor = bound(u128::from(seed >> 40), 0, 3_000) * E18 / 10_000;
                c.rate_kink = bound(u128::from(seed >> 48), 5_000, 9_500) * E18 / 10_000;
                if (seed >> 8) % 4 == 0 {
                    // raise lltv by up to 5 points, within the bounds
                    c.lltv = (c.lltv + bound(amount >> 32, 0, 5) * E18 / 100).min(850 * E15);
                    while multiverse_math::mul_div_down(c.lltv, E18 + c.liquidation_bonus, E18)
                        >= 900 * E15
                    {
                        c.lltv -= E18 / 100;
                    }
                    c.lltv = c.lltv.max(current.lltv);
                }
                let input = crate::lending::tiers::TierConfigInput::from(&c);
                let r = self.w.set_config(s, tier, input);
                st.record(
                    "set_tier_config",
                    &r,
                    &["LltvDecreaseWithDebt", "InvalidLiquidationBonus"],
                );
            }
            OpV2::Reference => {
                let on = (seed >> 16) % 2 == 0;
                let price = bound(amount, 2_000, 4_000) * E15;
                let now = self.w.now;
                self.w
                    .call(OWNER, NO_DEPOSIT, |c| {
                        let config = crate::reference::ReferenceConfig {
                            enabled: true,
                            guest: None,
                            reporter_id: Some(acc(REPORTER)),
                            min_sources: 3,
                            max_spread_bps: 200,
                            max_result_delay_sec: 120,
                            borrow_max_age_sec: 3_600,
                            liquidation_max_age_sec: 300,
                            min_price: U128(E18 / 100),
                            max_price: U128(10_000 * E18),
                        };
                        let state = crate::reference::ReferenceState {
                            price,
                            observed_at: now,
                            stored_at: now,
                            source: 2,
                            ..Default::default()
                        };
                        near_sdk::env::storage_write(
                            &crate::StorageKey::ReferenceConfig.into_storage_key(),
                            &borsh::to_vec(&config).unwrap(),
                        );
                        near_sdk::env::storage_write(
                            &crate::StorageKey::ReferenceState.into_storage_key(),
                            &borsh::to_vec(&state).unwrap(),
                        );
                        let mut cfg = c.price_cfg(s);
                        cfg.reference = on;
                        c.prices.configs.insert(s, cfg);
                    })
                    .unwrap();
                *st.calls.entry("reference").or_default() += 1;
            }
        }
        if let Some(before) = others {
            // L-11: an action on one market changes no other market.
            assert_eq!(self.other_markets(Some(id)), before, "{op:?} on {id:?}");
        }
    }

    /// V-3 at one timestamp, with the reference factor.
    fn resolve(&mut self, seed: u64, st: &mut StatsV2) {
        if self.steps < 30 || seed % 3 != 0 {
            return;
        }
        let event = self.events[((seed >> 8) % 2) as usize];
        if self.w.view(|c| c.get_event(event).finalized) {
            return;
        }
        let pairs: Vec<(MarketId, &str)> = markets_v2(self.sids)
            .into_iter()
            .flat_map(|id| ACTORS.iter().map(move |a| (id, *a)))
            .collect();
        let read = |w: &mut World, id: MarketId, a: &str| {
            let v = w
                .view(|c| c.borrow_view(id.scenario_id, Some(acc(a)), Some(id.tier)))
                .account;
            (v.health_factor.map(|h| h.0), v.liquidation_factor.0)
        };
        let before: Vec<_> = pairs
            .iter()
            .map(|(id, a)| read(&mut self.w, *id, a))
            .collect();
        self.w
            .admin_resolve(event, ((seed >> 16) % 2) as u8)
            .unwrap();
        st.resolutions += 1;
        for (i, (id, a)) in pairs.iter().enumerate() {
            let (Some(hf0), f0) = before[i] else {
                continue;
            };
            let (hf1, f1) = read(&mut self.w, *id, a);
            let Some(hf1) = hf1 else {
                continue;
            };
            st.v3_checks += 1;
            let bound_hf = mul_div_down(hf0, f1.min(f0), f0);
            if hf1 + 2 < bound_hf {
                st.v3_violations += 1;
            }
        }
    }

    fn liquidate(&mut self, seed: u64, amount: u128, st: &mut StatsV2) {
        let pairs: Vec<(MarketId, &str)> = markets_v2(self.sids)
            .into_iter()
            .flat_map(|id| ACTORS.iter().map(move |a| (id, *a)))
            .collect();
        let start = (seed % pairs.len() as u64) as usize;
        for k in 0..pairs.len() {
            let (id, who) = pairs[(start + k) % pairs.len()];
            let s = id.scenario_id;
            let status = self
                .w
                .view(|c| c.liquidation_status(s, acc(who), Some(id.tier)));
            if status.status != LiquidationState::Liquidatable {
                continue;
            }
            let cash = (seed >> 20) % 2 == 0;
            let receive = if cash { Receive::Cash } else { Receive::Tokens };
            let explicit = (seed >> 24) % 3 == 0;
            let repay = explicit.then(|| bound(amount, 1, status.max_repay.0.max(1)));
            let q = self.w.view(|c| {
                c.liquidation_quote(
                    s,
                    acc(who),
                    Some(id.tier),
                    repay.map(|r| RepayAmount::Amount(U128(r))),
                    Some(receive),
                )
            });
            let debt = self.w.debt_in(id.tier, s, who);
            let budget = q.repay.0.max(debt) + USDC_UNIT;
            let mut msg = json!({"action": "liquidate", "scenario_id": s, "account_id": who,
                                 "repay_amount": repay.map_or("max".to_string(), |r| r.to_string())});
            if id.tier != Tier::Normal {
                msg["tier"] = json!(id.tier.name());
            }
            let cash_quote = q.cash.as_ref().map(|c| c.cash.0);
            if cash {
                msg["receive"] = json!("cash");
                msg["min_out"] = json!(cash_quote.unwrap_or(1).to_string());
            }
            let r = self
                .w
                .ft_transfer_call(LIQUIDATOR, Usdc, usdc_units(budget), &msg.to_string());
            let expected = [
                "LiquidationTooSmall",
                "DustDebtLeft",
                "CashOutUnpricesWorld",
                "PoolNotInitialized",
                "ZeroAmount",
            ];
            if !st.record("liquidate", &r, &expected) {
                if let Err(e) = &r {
                    if q.error.as_deref() != Some(e.as_str()) {
                        st.quote_mismatches += 1;
                    }
                }
                return;
            }
            st.liquidations += 1;
            let l = super::tiers::liquidation_of(&self.w, s);
            if l.repaid != q.repay.0
                || l.seize_all != q.seize_all
                || l.written_off != q.written_off.0
                || l.seized != q.pieces.iter().map(|p| p.seized.0).collect::<Vec<_>>()
            {
                st.quote_mismatches += 1;
            }
            if cash {
                st.cash_outs += 1;
                let out = &self.w.last.data_of("cash_out")[0];
                if out["cash"].as_str().unwrap().parse::<u128>().ok() != cash_quote {
                    st.quote_mismatches += 1;
                }
            }
            if l.seize_all || l.repaid >= debt {
                st.full_liquidations += 1;
            }
            if l.written_off > 0 {
                st.write_offs += 1;
                *self.written.entry(id.key()).or_default() += l.written_off;
            }
            // V-4 when not underwater: the slice covers the repayment in every
            // possible world at the liquidation prices.
            if !l.seize_all {
                let slice = slice_value(&mut self.w, s, &l.pieces, &l.seized);
                let possible = self.w.possible(s);
                for (wd, v) in slice.iter().enumerate() {
                    if possible & (1 << wd) != 0 && *v < l.repaid {
                        st.coverage_failures += 1;
                    }
                }
            }
            return;
        }
    }

    fn check_books(&mut self, st: &mut StatsV2) -> Result<(), TestCaseError> {
        let ids: Vec<AccountId> = V2_ACCOUNTS.iter().map(|a| acc(a)).collect();
        let markets = markets_v2(self.sids);
        // One read of everything the checks need.
        struct Read {
            m: crate::lending::Market,
            state: crate::lending::tiers::TierState,
            supply: Vec<u128>,
            borrow: Vec<u128>,
            debts: Vec<u128>,
            lists: Vec<Vec<(CollateralKey, u128)>>,
            index: Vec<AccountId>,
        }
        let (reads, holds, min_loan) = self.w.view(|c| {
            let reads: Vec<Read> = markets
                .iter()
                .map(|id| Read {
                    m: c.market_of(*id),
                    state: c.tier_state(*id),
                    supply: ids.iter().map(|a| c.supply_shares_of(*id, a)).collect(),
                    borrow: ids.iter().map(|a| c.borrow_shares_of(*id, a)).collect(),
                    debts: ids.iter().map(|a| c.debt_for(*id, a)).collect(),
                    lists: ids.iter().map(|a| c.pieces(*id, a)).collect(),
                    index: (0..c.borrower_count_of(*id))
                        .map(|i| c.borrower_at.get(&(id.key(), i)).cloned().unwrap())
                        .collect(),
                })
                .collect();
            let holds: Vec<bool> = ids.iter().map(|a| c.holds_anything(a)).collect();
            (reads, holds, c.lending.min_loan)
        });
        for (id, r) in markets.iter().zip(reads) {
            prop_assert_eq!(r.supply.iter().sum::<u128>(), r.m.total_supply_shares);
            prop_assert_eq!(r.borrow.iter().sum::<u128>(), r.m.total_borrow_shares);
            // L-1
            prop_assert!(r.m.total_supply_assets + r.state.insurance >= r.m.total_borrow_assets);
            // L-3: the index is exactly the accounts with borrow shares.
            let mut index = r.index.clone();
            index.sort();
            let mut owing: Vec<AccountId> = ids
                .iter()
                .zip(&r.borrow)
                .filter(|(_, b)| **b > 0)
                .map(|(a, _)| a.clone())
                .collect();
            owing.sort();
            prop_assert_eq!(index, owing);
            // L-15
            prop_assert_eq!(
                r.state.bad_debt_covered + r.state.bad_debt_socialized,
                self.written.get(&id.key()).copied().unwrap_or(0)
            );
            for (i, a) in V2_ACCOUNTS.iter().enumerate() {
                let debt = r.debts[i];
                // L-6: debt is 0 or at least the minimum, unless it was
                // already below it and only interest moved it.
                let key = (id.key(), a.to_string());
                let prev = self.debts.get(&key).copied().unwrap_or(0);
                if debt > 0 && debt < min_loan {
                    prop_assert!(
                        prev > 0 && prev < min_loan,
                        "dust debt {} of {} in {:?}",
                        debt,
                        a,
                        id
                    );
                }
                self.debts.insert(key, debt);
                // L-14
                if debt > 0 || !r.lists[i].is_empty() || r.supply[i] > 0 {
                    prop_assert!(holds[i], "{} holds a position in {:?}", a, id);
                }
                prop_assert!(r.lists[i].len() <= 20);
                prop_assert!(r.lists[i].iter().all(|(_, x)| *x > 0));
            }
            if irm_utilization(&r.m) > r.state.config.rate_kink && self.kinked.insert(id.key()) {
                st.above_kink += 1;
            }
        }
        assert_usdc_books_v2(&mut self.w);
        self.w.assert_conservation(&V2_ACCOUNTS);
        Ok(())
    }
}

fn irm_utilization(m: &crate::lending::Market) -> u128 {
    multiverse_math::irm::utilization(m.total_borrow_assets, m.total_supply_assets)
}

/// L-2: USDC held by the contract equals reserves, internal balances, real
/// collateral and every market's cash.
fn assert_usdc_books_v2(w: &mut World) {
    let held = w.held_by_contract(Usdc);
    let mut accounts: Vec<AccountId> = V2_ACCOUNTS.iter().map(|a| acc(a)).collect();
    accounts.push(acc(CONTRACT));
    let books = w.view(|c| {
        let mut total = 0u128;
        for sid in 1..=c.scenario_count {
            total += c.reserve(sid, Usdc);
            for tier in Tier::ALL {
                let id = MarketId::new(sid, Some(tier));
                let m = c.market_of(id);
                total += m.total_supply_assets + c.tier_state(id).insurance - m.total_borrow_assets;
                for a in &accounts {
                    for (k, amount) in c.pieces(id, a) {
                        if k == CollateralKey::Real(Usdc) {
                            total += amount;
                        }
                    }
                }
            }
        }
        total
            + accounts
                .iter()
                .map(|a| c.real_balance(a, Usdc))
                .sum::<u128>()
    });
    assert_eq!(held, books, "USDC books (L-2)");
}

trait WithdrawIn {
    fn withdraw_lent_in(
        &mut self,
        tier: Tier,
        who: &str,
        sid: u64,
        amount: Option<u128>,
    ) -> Result<u128, String>;
}

impl WithdrawIn for World {
    fn withdraw_lent_in(
        &mut self,
        tier: Tier,
        who: &str,
        sid: u64,
        amount: Option<u128>,
    ) -> Result<u128, String> {
        self.call(who, ONE_YOCTO, |c| {
            c.withdraw_supply(sid, amount.map(U128), Some(tier)).0
        })
    }
}

#[test]
fn tiered_campaign_keeps_the_books() {
    let stats = RefCell::new(StatsV2::default());
    let config = Config {
        cases: CASES,
        failure_persistence: None,
        max_shrink_iters: 32,
        ..Config::default()
    };
    let actions = proptest::collection::vec((ops_v2(), any::<u64>(), any::<u128>()), 30..=90);
    let mut runner = TestRunner::new(config);
    let result = runner.run(&actions, |actions| {
        let mut c = CampaignV2::new();
        let mut s = stats.borrow_mut();
        s.cases += 1;
        c.check_books(&mut s)?;
        for (op, seed, amount) in actions {
            c.run(op, seed, amount, &mut s);
            s.actions += 1;
            c.check_books(&mut s)?;
        }
        Ok(())
    });
    if let Err(e) = result {
        panic!("{e}");
    }
    clear_prices();
    let s = stats.into_inner();
    println!(
        "tiered_campaign_keeps_the_books: {} cases, {} actions; calls {:?}; expected failures {:?}; liquidations {} \
         (cash {}), full {}, write-offs {}, above the kink {}, resolutions {}, V-3 checks {} violations {}, \
         quote mismatches {}, coverage failures {}, unexpected {:?}",
        s.cases,
        s.actions,
        s.calls,
        s.expected_fails,
        s.liquidations,
        s.cash_outs,
        s.full_liquidations,
        s.write_offs,
        s.above_kink,
        s.resolutions,
        s.v3_checks,
        s.v3_violations,
        s.quote_mismatches,
        s.coverage_failures,
        s.unexpected_fails
    );
    assert!(s.unexpected_fails.is_empty(), "{:?}", s.unexpected_fails);
    assert_eq!(s.v3_violations, 0);
    assert_eq!(s.quote_mismatches, 0);
    assert_eq!(s.coverage_failures, 0);
    // The campaign must reach the states it is about.
    assert!(
        s.full_liquidations > u64::from(CASES),
        "{}",
        s.full_liquidations
    );
    assert!(s.write_offs > u64::from(CASES), "{}", s.write_offs);
    assert!(s.above_kink > u64::from(CASES), "{}", s.above_kink);
    assert!(s.cash_outs > 0 && s.liquidations > u64::from(CASES));
    assert!(s.v3_checks > u64::from(CASES));
}
