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

use std::cell::RefCell;
use std::collections::BTreeMap;

use near_sdk::NearToken;
use proptest::prelude::*;
use proptest::test_runner::{Config, TestRunner};

use super::harness::*;
use super::lending::*;
use super::liquidation::slice_value;
use crate::amm::TEST_WORLD_PRICES;
use crate::lending::CollateralKey;
use crate::masks::single_worlds;
use crate::types::Asset::{Usdc, Wnear};
use multiverse_math::risk::{dust_allowance, liquidation_target};
use multiverse_math::{mul_div_down, U256};

const CASES: u32 = 256;
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
    events: [u64; 2],
    pools: BTreeMap<(u64, u8), Pool>,
    steps: u64,
    /// Invariant 4 borrows nearer the limit and moves prices.
    liquidation: bool,
}

impl Campaign {
    fn new(liquidation: bool) -> Self {
        clear_prices();
        let mut w = World::new();
        w.register(DAVE, NearToken::from_near(5));
        w.register(LIQUIDATOR, NearToken::from_near(20));
        for who in [CAROL, DAVE, LIQUIDATOR] {
            w.fund(who);
        }
        let sids = [w.s2x2, w.s_bin];
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
            events: [w.spice, w.fed],
            w,
            sids,
            pools,
            steps: 0,
            liquidation,
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
        let masks = [
            [L_SHAPE, BIN_DELAYED],
            [SHIPS, BIN_SHIPS],
            [DELAYED_HOLDS, BIN_DELAYED],
        ];
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
        let ok = p.usdc >= GATE;
        TEST_WORLD_PRICES.with(|m| m.borrow_mut().insert(key, (price, ok)));
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
        let event = self.events[((seed >> 8) % 2) as usize];
        if self.w.view(|c| c.get_event(event).finalized) {
            return;
        }
        let pairs = self.pairs();
        let before: Vec<Option<u128>> = pairs.iter().map(|(s, a)| self.w.hf(*s, a).0).collect();
        self.w
            .admin_resolve(event, ((seed >> 16) % 2) as u8)
            .unwrap();
        st.resolutions += 1;
        for (i, (s, a)) in pairs.iter().enumerate() {
            if self.w.debt(*s, a) == 0 {
                continue;
            }
            st.checks_around_resolution += 1;
            let after = self.w.hf(*s, a).0.unwrap();
            if after < before[i].unwrap() {
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
        for event in self.events {
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
        let event = self.events[((seed >> 8) % 2) as usize];
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
            0 => max_repay,
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
                    c.market(s),
                    ids.iter().map(|a| c.supply_shares_of(s, a)).sum::<u128>(),
                    ids.iter().map(|a| c.borrow_shares_of(s, a)).sum::<u128>(),
                    ids.iter().map(|a| c.pieces(s, a)).collect::<Vec<_>>(),
                )
            });
            prop_assert_eq!(supply_sum, m.total_supply_shares);
            prop_assert_eq!(borrow_sum, m.total_borrow_shares);
            prop_assert!(m.total_supply_assets >= m.total_borrow_assets);
            for list in lists {
                prop_assert!(list.len() <= 16);
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

fn campaign(liquidation: bool) -> Stats {
    let stats = RefCell::new(Stats::default());
    let config = Config {
        cases: CASES,
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
    let result = runner.run(&actions, |actions| {
        let mut c = Campaign::new(liquidation);
        let mut s = stats.borrow_mut();
        s.cases += 1;
        c.check_books()?;
        for (op, seed, amount) in actions {
            c.run(op, seed, amount, &mut s);
            s.actions += 1;
            c.check_books()?;
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
    let s = campaign(false);
    println!(
        "invariant_3_resolution_never_lowers_hf: {} cases, {} actions; successful calls {:?}; resolutions {}, \
         checks around resolution {}, violations {}",
        s.cases, s.actions, s.calls, s.resolutions, s.checks_around_resolution, s.violations
    );
    assert_eq!(s.violations, 0);
    // the campaign must reach the states the invariant is about
    assert!(s.resolutions > u64::from(CASES));
    assert!(s.checks_around_resolution > u64::from(CASES));
}

#[test]
fn invariant_4_liquidation_covers_repayment() {
    let s = campaign(true);
    println!(
        "invariant_4_liquidation_covers_repayment: {} cases, {} actions; successful calls {:?}; liquidations {}, \
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
    assert!(s.liquidations > u64::from(CASES));
    assert!(s.precondition_held > 0);
}
