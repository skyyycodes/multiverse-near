//! The order-book invariants as property tests:
//! four makers and takers on the 2x2 and binary scenarios post, fill (also
//! orders made stale by a resolution), cancel (strangers try first now and
//! then), warp time and resolve events, with no pools. A ghost model tracks
//! every order's escrow. Fills go straight to the book; the router path joins
//! once the router exists.
//!
//! Funds are minted to the actor's wallet right before they are needed, then
//! split into `[mask, other possible singles]`. Calls that fail are rolled
//! back and counted when the model says they should have worked.

use std::cell::RefCell;
use std::collections::BTreeMap;

use multiverse_math::orders::{cost, proceeds};
use proptest::prelude::*;
use proptest::test_runner::{Config, TestRunner};

use super::harness::*;
use super::orders::{cancel, fill, post, RAVI};
use crate::masks::single_worlds;
use crate::orders::{Order, Side, MIN_ORDER_AMOUNT};
use crate::types::Asset::{self, Usdc, Wnear};
use crate::types::VerseKey;

const MAX_AMOUNT: u128 = 1_000_000_000_000_000_000_000_000_000_000; // 1e30
const MAX_PRICE: u128 = 1_000_000_000_000_000_000_000_000; // 1e24
const ACTORS: [&str; 4] = [ALICE, BOB, CAROL, RAVI];
const CASES: u32 = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Op {
    Post,
    Fill,
    FillStale,
    Cancel,
    Warp,
    Resolve,
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        Just(Op::Post),
        Just(Op::Fill),
        Just(Op::FillStale),
        Just(Op::Cancel),
        Just(Op::Warp),
        Just(Op::Resolve),
    ]
}

fn actions() -> impl Strategy<Value = Vec<(Op, u64, u128, u128)>> {
    proptest::collection::vec((op(), any::<u64>(), any::<u128>(), any::<u128>()), 50..=200)
}

fn bound(x: u128, lo: u128, hi: u128) -> u128 {
    lo + x % (hi - lo + 1)
}

#[derive(Default)]
struct Stats {
    cases: u64,
    actions: u64,
    posts: u64,
    fills: u64,
    stale_fill_attempts: u64,
    cancels: u64,
    resolutions: u64,
    max_orders: u64,
}

#[derive(Default)]
struct Counters {
    fills_after_resolution: u64,
    expired_fills_succeeded: u64,
    unexpected_successes: u64,
    foreign_cancels_succeeded: u64,
    unexpected_fails: u64,
    wrong_refunds: u64,
}

struct Campaign {
    w: World,
    scenarios: [u64; 2],
    events: [u64; 2],
    ghost: BTreeMap<u64, u128>,
    n: Counters,
}

impl Campaign {
    fn new() -> Self {
        let mut w = World::new();
        w.register(RAVI, near_sdk::NearToken::from_near(1));
        let (spice, fed, s2x2, s_bin) = (w.spice, w.fed, w.s2x2, w.s_bin);
        Campaign {
            w,
            scenarios: [s2x2, s_bin],
            events: [spice, fed],
            ghost: BTreeMap::new(),
            n: Counters::default(),
        }
    }

    /// Mints `amount` (rounded up to whole token units) into `who`'s wallet
    /// and splits it into `[mask, other possible singles]`.
    fn mint_and_give(&mut self, who: &str, sid: u64, asset: Asset, mask: u8, amount: u128) -> bool {
        let possible = self.w.possible(sid);
        let mut parts = vec![mask];
        parts.extend(single_worlds(possible & !mask));
        let s = scale(asset);
        let tokens = amount.div_ceil(s);
        *self.w.wallets.entry((acc(who), asset)).or_default() += tokens;
        self.w.split_ft(who, sid, asset, &parts, tokens * s).is_ok()
    }

    fn orders(&mut self) -> Vec<(u64, Order)> {
        self.w.view(|c| {
            (1..=c.order_count)
                .filter_map(|id| c.order(id).map(|o| (id, o)))
                .collect()
        })
    }

    /// First open order from a seeded start; with `stale`, only orders a
    /// resolution has overtaken.
    fn open_order(&mut self, seed: u64, stale: bool) -> Option<(u64, Order)> {
        let orders = self.orders();
        let n = orders.len();
        if n == 0 {
            return None;
        }
        let scenarios = self.scenarios;
        let counts: BTreeMap<u64, u8> = scenarios
            .iter()
            .map(|s| (*s, self.resolution_count(*s)))
            .collect();
        (0..n)
            .map(|i| &orders[(seed as usize % n + i) % n])
            .find(|(_, o)| o.is_open() && (!stale || counts[&o.scenario_id] != o.epoch))
            .cloned()
    }

    fn resolution_count(&mut self, sid: u64) -> u8 {
        self.w.view(|c| c.get_scenario(sid).resolution_count)
    }

    fn run(&mut self, op: Op, seed: u64, a: u128, b: u128, st: &mut Stats) {
        match op {
            Op::Post => self.post(seed, a, b, st),
            Op::Fill => self.fill(seed, a, false, st),
            Op::FillStale => self.fill(seed, a, true, st),
            Op::Cancel => self.cancel(seed, st),
            Op::Warp => self.w.warp(bound(u128::from(seed), 1, 6 * 3_600) as u64),
            Op::Resolve => self.resolve(seed, st),
        }
    }

    fn post(&mut self, seed: u64, price: u128, amount: u128, st: &mut Stats) {
        let maker = ACTORS[(seed % 4) as usize];
        let sid = self.scenarios[((seed >> 8) % 2) as usize];
        let (root, possible) = self.w.view(|c| {
            let s = c.get_scenario(sid);
            (s.root, s.possible)
        });
        let start = (seed >> 16) as u8;
        let Some(mask) = (0..root - 1)
            .map(|i| 1 + (start.wrapping_add(i)) % (root - 1))
            .find(|m| m & possible != 0)
        else {
            return;
        };
        let side = if (seed >> 24) & 1 == 0 {
            Side::Bid
        } else {
            Side::Ask
        };
        let amount = bound(amount, MIN_ORDER_AMOUNT, MAX_AMOUNT);
        let price = bound(price, 1, MAX_PRICE);
        let expiry = self.w.now + bound(u128::from(seed >> 32), 1, 3 * u128::from(DAY)) as u64;
        let escrow = match side {
            Side::Ask => amount,
            Side::Bid => cost(amount, price),
        };
        if !self.mint_and_give(maker, sid, side.escrow_asset(), mask, escrow) {
            self.n.unexpected_fails += 1;
            return;
        }
        match post(&mut self.w, maker, sid, mask, side, price, amount, expiry) {
            Ok(id) => {
                self.ghost.insert(id, escrow);
                st.posts += 1;
            }
            Err(_) => self.n.unexpected_fails += 1,
        }
    }

    fn fill(&mut self, seed: u64, amount: u128, stale_only: bool, st: &mut Stats) {
        let Some((id, o)) = self.open_order(seed, stale_only) else {
            return;
        };
        let taker = ACTORS[((seed >> 8) % 4) as usize];
        let amount = bound(amount, 1, o.remaining);
        let is_bid = o.side == Side::Bid;
        let usdc_leg = if is_bid {
            proceeds(amount, o.price)
        } else {
            cost(amount, o.price)
        };
        let live = self.w.view(|c| c.is_live(o.scenario_id, o.mask));
        let stale = self.resolution_count(o.scenario_id) != o.epoch;
        let expired = self.w.now >= o.expiry_sec;
        let zero_value = is_bid && usdc_leg == 0;
        let allowed = live && !stale && !expired && !zero_value;
        if live {
            let (asset, pay) = if is_bid {
                (Wnear, amount)
            } else {
                (Usdc, usdc_leg)
            };
            if !self.mint_and_give(taker, o.scenario_id, asset, o.mask, pay) {
                self.n.unexpected_fails += 1;
                return;
            }
        }
        if stale {
            st.stale_fill_attempts += 1;
        }
        match fill(&mut self.w, taker, id, amount, o.price) {
            Err(_) => {
                if allowed {
                    self.n.unexpected_fails += 1;
                }
            }
            Ok(_) => {
                if stale {
                    self.n.fills_after_resolution += 1;
                }
                if expired {
                    self.n.expired_fills_succeeded += 1;
                }
                if !allowed {
                    self.n.unexpected_successes += 1;
                }
                let g = self.ghost.entry(id).or_default();
                *g = match o.side {
                    Side::Bid if amount == o.remaining => 0,
                    Side::Bid => g.saturating_sub(usdc_leg),
                    Side::Ask => g.saturating_sub(amount),
                };
                st.fills += 1;
            }
        }
    }

    fn cancel(&mut self, seed: u64, st: &mut Stats) {
        let Some((id, o)) = self.open_order(seed, false) else {
            return;
        };
        let maker = ACTORS
            .into_iter()
            .find(|a| acc(a) == o.maker)
            .expect("makers are actors");
        if (seed >> 8) % 4 == 0 {
            let stranger = ACTORS[((seed >> 16) % 4) as usize];
            if stranger != maker && cancel(&mut self.w, stranger, id).is_ok() {
                self.n.foreign_cancels_succeeded += 1;
            }
        }
        let key = o.escrow_key();
        let before = self.w.bal(maker, key.scenario, key.asset, key.mask);
        match cancel(&mut self.w, maker, id) {
            Ok(refund) => {
                let after = self.w.bal(maker, key.scenario, key.asset, key.mask);
                if refund != self.ghost[&id] || after != before + refund {
                    self.n.wrong_refunds += 1;
                }
                self.ghost.insert(id, 0);
                st.cancels += 1;
            }
            Err(_) => self.n.unexpected_fails += 1,
        }
    }

    fn resolve(&mut self, seed: u64, st: &mut Stats) {
        if seed % 20 != 0 {
            return;
        }
        let event = self.events[((seed >> 8) % 2) as usize];
        if self.w.view(|c| c.get_event(event).finalized) {
            return;
        }
        if self
            .w
            .admin_resolve(event, ((seed >> 16) % 2) as u8)
            .is_ok()
        {
            st.resolutions += 1;
        }
    }

    /// Invariant 5: every order's escrow matches the model; closed orders
    /// hold nothing; an open bid covers `cost(remaining)` (stronger than
    /// `proceeds`), an open ask exactly `remaining`; per token, supply
    /// equals what the actors hold plus the open escrow, so the book's bucket
    /// is exactly the sum of open escrow; the contract's own account holds
    /// no verse or real balance; every refund matched the model.
    fn check_escrow(&mut self) -> Result<(), TestCaseError> {
        let orders = self.orders();
        let mut bucket: BTreeMap<VerseKey, u128> = BTreeMap::new();
        for (id, o) in &orders {
            prop_assert_eq!(
                o.escrow,
                self.ghost.get(id).copied().unwrap_or(0),
                "order {}",
                id
            );
            if !o.is_open() {
                prop_assert_eq!(o.escrow, 0, "closed order {} holds escrow", id);
                continue;
            }
            match o.side {
                Side::Bid => {
                    prop_assert!(o.escrow >= cost(o.remaining, o.price), "bid {} short", id)
                }
                Side::Ask => prop_assert_eq!(o.escrow, o.remaining, "ask {}", id),
            }
            *bucket.entry(o.escrow_key()).or_default() += o.escrow;
        }
        let actors: Vec<_> = ACTORS.iter().map(|a| acc(a)).collect();
        let contract = acc(CONTRACT);
        let broken = self.w.view(|c| {
            for asset in [Wnear, Usdc] {
                if c.real_balance(&contract, asset) != 0 {
                    return Some(format!("contract holds real {asset:?}"));
                }
            }
            for key in c.verse_keys() {
                if c.verse_balance(&contract, &key) != 0 {
                    return Some(format!("contract holds {}", key.token_id()));
                }
                let held: u128 = actors
                    .iter()
                    .map(|a| c.verse_balance(a, &key))
                    .sum::<u128>()
                    + bucket.get(&key).copied().unwrap_or(0);
                if c.verse_supply(&key) != held {
                    return Some(format!("escrow bucket of {} off", key.token_id()));
                }
            }
            None
        });
        prop_assert!(broken.is_none(), "{:?}", broken);
        prop_assert_eq!(self.n.wrong_refunds, 0);
        Ok(())
    }

    /// Invariant 6: no fill after a resolution or expiry, nothing the model
    /// forbids succeeds, nothing it allows fails, strangers never cancel.
    fn check_no_fill_after_resolution(&mut self) -> Result<(), TestCaseError> {
        prop_assert_eq!(self.n.fills_after_resolution, 0);
        prop_assert_eq!(self.n.expired_fills_succeeded, 0);
        prop_assert_eq!(self.n.unexpected_successes, 0);
        prop_assert_eq!(self.n.foreign_cancels_succeeded, 0);
        prop_assert_eq!(self.n.unexpected_fails, 0);
        Ok(())
    }
}

fn campaign(title: &str, check: fn(&mut Campaign) -> Result<(), TestCaseError>) {
    let stats = RefCell::new(Stats::default());
    let config = Config {
        cases: CASES,
        failure_persistence: None,
        max_shrink_iters: 256,
        ..Config::default()
    };
    let mut runner = TestRunner::new(config);
    let result = runner.run(&actions(), |actions| {
        let mut c = Campaign::new();
        let mut s = stats.borrow_mut();
        s.cases += 1;
        check(&mut c)?;
        for (op, seed, a, b) in actions {
            c.run(op, seed, a, b, &mut s);
            s.actions += 1;
            check(&mut c)?;
        }
        s.max_orders = s.max_orders.max(c.ghost.len() as u64);
        Ok(())
    });
    let s = stats.into_inner();
    println!(
        "{title}: {} cases, {} actions; posts {}, fills {}, stale fill attempts {}, cancels {}, resolutions {}, \
         most orders in one run {}",
        s.cases, s.actions, s.posts, s.fills, s.stale_fill_attempts, s.cancels, s.resolutions, s.max_orders
    );
    if let Err(e) = result {
        panic!("{title}: {e}");
    }
    // the campaign must reach the states the invariants are about
    assert!(s.fills > u64::from(CASES));
    assert!(s.cancels > u64::from(CASES));
    assert!(s.stale_fill_attempts > 0);
    assert!(s.resolutions > 0);
}

#[test]
fn invariant_5_order_book_escrow() {
    campaign("invariant_5_order_book_escrow", Campaign::check_escrow);
}

#[test]
fn invariant_6_no_fill_after_resolution() {
    campaign(
        "invariant_6_no_fill_after_resolution",
        Campaign::check_no_fill_after_resolution,
    );
}
