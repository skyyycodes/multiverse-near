//! The core invariants as property tests. Each case
//! builds the fixture with three scenarios that share events (2x2 [spice,
//! fed], binary [spice], binary [fed]) and three users, then runs 50 to 200
//! random actions: split (from the wallet, from the internal balance or from
//! a held token), merge, merge back, redeem, transfer (dead tokens included),
//! attempts on dead verses, deposits and withdrawals, and the whole oracle
//! state machine (report, dispute, finalize after a time warp, admin
//! resolve). The invariant is checked after every action. Payouts to carol
//! always fail (she is not registered with the tokens), so the books also go
//! through `on_payout`'s re-credit.
//!
//! The backing invariant also runs with the 24-decimal wNEAR of testnet,
//! where deposits carry a random remainder below one internal unit that must
//! come straight back as unused and never reach the books.
//!
//! Every campaign also checks the books after every action (OPS-1, M-13):
//! the `books` view equals the token balances exactly, its running totals
//! equal their enumeration, and the contract's own NEAR is never negative
//! (`ops::books_hold`).
//!
//! Choices come from bit ranges of one seed per action; actions that would
//! be pointless are skipped, and calls that fail are rolled back and the run
//! goes on.
//!
//! Every call's NEP-245 lines are replayed on a shadow ledger (EW-5). The
//! 8-world runner does the same on the 3-event scenario `[spice, fed,
//! third]` (two thirds of the actions), the 2x2 and the binary scenario,
//! and also checks the per-world counters, the per-account index and both
//! definitions of `holds_anything` after every action (EW-1..EW-4).

use std::cell::RefCell;
use std::collections::BTreeMap;

use proptest::prelude::*;
use proptest::test_runner::{Config, TestRunner};

use super::eight::{check_eight_worlds, THIRD_QUESTION, THIRD_RULE};
use super::harness::*;
use crate::masks::single_worlds;
use crate::types::Asset::{self, Usdc, Wnear};
use crate::types::VerseKey;

const MAX_AMOUNT: u128 = 1_000_000_000_000_000_000_000_000_000_000; // 1e30
const ACTORS: [&str; 3] = [ALICE, BOB, CAROL];
const ASSETS: [Asset; 2] = [Wnear, Usdc];
const CASES: u32 = 256;
const CASES_8: u32 = 40;

/// Which fixture a campaign runs on.
#[derive(Clone, Copy)]
enum Fixture {
    /// The 2x2, the binary SPICE and the binary Fed scenario, with a wNEAR
    /// of this many decimals.
    Base(u8),
    /// The 3-event scenario, the 2x2 and the binary SPICE scenario.
    Eight,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Op {
    Split,
    Merge,
    MergeBack,
    Redeem,
    Transfer,
    DeadOps,
    Resolve,
    Propose,
    Dispute,
    Finalize,
    Warp,
    Deposit,
    Withdraw,
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        5 => Just(Op::Split),
        3 => Just(Op::Merge),
        3 => Just(Op::MergeBack),
        2 => Just(Op::Redeem),
        3 => Just(Op::Transfer),
        2 => Just(Op::DeadOps),
        1 => Just(Op::Resolve),
        1 => Just(Op::Propose),
        1 => Just(Op::Dispute),
        1 => Just(Op::Finalize),
        2 => Just(Op::Warp),
        1 => Just(Op::Deposit),
        1 => Just(Op::Withdraw),
    ]
}

fn actions() -> impl Strategy<Value = Vec<(Op, u64, u128)>> {
    proptest::collection::vec((op(), any::<u64>(), any::<u128>()), 50..=200)
}

/// Clamps a random amount into `lo..=hi`.
fn bound(x: u128, lo: u128, hi: u128) -> u128 {
    lo + x % (hi - lo + 1)
}

struct Pick {
    actor: &'static str,
    sid: u64,
    asset: Asset,
    root: u8,
    possible: u8,
}

#[derive(Default)]
struct Stats {
    cases: u64,
    actions: u64,
    calls: BTreeMap<&'static str, u64>,
    dead_ops_attempted: u64,
    resolutions: u64,
    failed_payouts: u64,
    max_dead_tracked: usize,
}

struct Campaign {
    w: World,
    scenarios: [u64; 3],
    events: Vec<u64>,
    last_split: BTreeMap<&'static str, (u64, Asset, u8, Vec<u8>)>,
    dead_ops_succeeded: u64,
    /// Every created token whose verse died, with its supply at that moment.
    dead: Vec<(VerseKey, u128)>,
}

impl Campaign {
    fn new(fixture: Fixture) -> Self {
        let decimals = match fixture {
            Fixture::Base(d) => d,
            Fixture::Eight => 18,
        };
        let mut w = World::new_with_wnear_decimals(decimals);
        w.fund(CAROL);
        w.ft_unregistered.insert(acc(CAROL));
        let (spice, fed, s2x2, s_bin) = (w.spice, w.fed, w.s2x2, w.s_bin);
        let (scenarios, events) = match fixture {
            Fixture::Base(_) => {
                let s_fed = w.create_scenario(&[fed]).unwrap();
                ([s2x2, s_bin, s_fed], vec![spice, fed])
            }
            Fixture::Eight => {
                let third = w
                    .create_event(THIRD_QUESTION, &["YES", "NO"], THIRD_RULE, T0 + 50 * DAY)
                    .unwrap();
                let s8 = w.create_scenario(&[spice, fed, third]).unwrap();
                ([s8, s2x2, s_bin], vec![spice, fed, third])
            }
        };
        w.track_logs();
        Campaign {
            w,
            scenarios,
            events,
            last_split: BTreeMap::new(),
            dead_ops_succeeded: 0,
            dead: Vec::new(),
        }
    }

    fn event(&self, seed: u64) -> u64 {
        self.events[((seed >> 8) % self.events.len() as u64) as usize]
    }

    /// `(mask, created, actor's balance)` of every non-root mask, in one read.
    fn holdings(&mut self, p: &Pick) -> Vec<(u8, bool, u128)> {
        let (sid, asset, root, actor) = (p.sid, p.asset, p.root, acc(p.actor));
        self.w.view(|c| {
            (1..root)
                .map(|m| {
                    let key = VerseKey::new(sid, asset, m);
                    (m, c.is_created(&key), c.verse_balance(&actor, &key))
                })
                .collect()
        })
    }

    /// Two thirds of the actions go to the 2x2 scenario.
    fn pick(&mut self, seed: u64) -> Pick {
        let actor = ACTORS[(seed % 3) as usize];
        let s = (seed >> 8) % 6;
        let sid = self.scenarios[if s <= 3 { 0 } else { (s - 3) as usize }];
        let asset = ASSETS[((seed >> 16) % 2) as usize];
        let (root, possible) = self.w.view(|c| {
            let s = c.get_scenario(sid);
            (s.root, s.possible)
        });
        Pick {
            actor,
            sid,
            asset,
            root,
            possible,
        }
    }

    /// A live (or, if `collapsed_only`, collapsed) non-root mask the actor
    /// holds, scanning from a random start.
    fn held_mask(&mut self, p: &Pick, start: u64, collapsed_only: bool) -> Option<(u8, u128)> {
        let n = u64::from(p.root - 1);
        let held = self.holdings(p);
        for i in 0..n {
            let m = 1 + ((start + i) % n) as u8;
            if m & p.possible == 0 || (collapsed_only && m & p.possible != p.possible) {
                continue;
            }
            let (_, created, bal) = held[usize::from(m) - 1];
            if !created {
                continue;
            }
            if bal > 0 {
                return Some((m, bal));
            }
        }
        None
    }

    fn run(&mut self, op: Op, seed: u64, amount: u128, stats: &mut Stats) {
        let ok = match op {
            Op::Split => self.split(seed, amount),
            Op::Merge => self.merge(seed, amount),
            Op::MergeBack => self.merge_back(seed, amount),
            Op::Redeem => self.redeem(seed, amount),
            Op::Transfer => self.transfer(seed, amount),
            Op::DeadOps => {
                let attempted = self.attempt_dead_ops(seed);
                stats.dead_ops_attempted += u64::from(attempted);
                attempted
            }
            Op::Resolve => self.resolve(seed),
            Op::Propose => self.propose(seed),
            Op::Dispute => self.dispute(seed),
            Op::Finalize => self.finalize(seed),
            Op::Warp => {
                self.w.warp(seed % 40);
                true
            }
            Op::Deposit => self.deposit(seed, amount),
            Op::Withdraw => self.withdraw(seed, amount),
        };
        if ok {
            *stats.calls.entry(name(op)).or_default() += 1;
        }
        if matches!(op, Op::Resolve | Op::Finalize) && ok {
            stats.resolutions += 1;
        }
        stats.failed_payouts += self
            .w
            .callbacks
            .iter()
            .filter(|c| !c.logs.is_empty())
            .count() as u64;
        stats.max_dead_tracked = stats.max_dead_tracked.max(self.dead.len());
    }

    fn split(&mut self, seed: u64, amount: u128) -> bool {
        let p = self.pick(seed);
        // root is paid from the wallet through the token, or (direct) from
        // the internal balance; a held token can be split as well
        let direct = (seed >> 56) & 1 == 1;
        let mut from = p.root;
        let mut available = if direct {
            self.w.real(p.actor, p.asset)
        } else {
            self.w.wallet(p.actor, p.asset)
        };
        if (seed >> 24) & 1 == 1 {
            if let Some((m, bal)) = self.held_mask(&p, seed >> 25, false) {
                (from, available) = (m, bal);
            }
        }
        let parts = random_partition(from, p.possible, next_seed(seed));
        if available == 0 || parts.is_empty() {
            return false;
        }
        let result = if from == p.root && !direct {
            let unit = self.w.unit(p.asset);
            let tokens = bound(amount, 1, (available / unit).min(MAX_AMOUNT / unit));
            self.w
                .split_ft(p.actor, p.sid, p.asset, &parts, tokens * unit)
                .map(|_| tokens * unit)
        } else {
            let amount = bound(amount, 1, available.min(MAX_AMOUNT));
            self.w
                .split(p.actor, p.sid, p.asset, from, &parts, amount)
                .map(|_| amount)
        };
        let Ok(amount) = result else {
            return false;
        };
        // mostly kept, so later merges find what they need; sometimes given away
        let to = if (seed >> 40) % 4 == 0 {
            ACTORS[((seed >> 48) % 3) as usize]
        } else {
            p.actor
        };
        if to == p.actor {
            self.last_split
                .insert(p.actor, (p.sid, p.asset, from, parts));
        } else {
            let ids: Vec<String> = parts.iter().map(|m| token_id(p.sid, p.asset, *m)).collect();
            self.w
                .mt_batch_transfer(p.actor, to, &ids, &vec![amount; ids.len()])
                .expect("give the parts away");
        }
        true
    }

    /// Reverses the actor's last split; after a resolution only the parts
    /// that are still live are needed.
    fn merge_back(&mut self, seed: u64, amount: u128) -> bool {
        let actor = ACTORS[(seed % 3) as usize];
        let Some((sid, asset, from, parts)) = self.last_split.get(actor).cloned() else {
            return false;
        };
        let possible = self.w.possible(sid);
        let mut live = Vec::new();
        let mut min_bal = u128::MAX;
        for m in parts {
            if m & possible == 0 {
                continue;
            }
            min_bal = min_bal.min(self.w.bal(actor, sid, asset, m));
            live.push(m);
        }
        if live.is_empty() || min_bal == 0 {
            return false;
        }
        let amount = bound(amount, 1, min_bal.min(MAX_AMOUNT));
        self.w.merge(actor, sid, asset, &live, from, amount).is_ok()
    }

    /// Merges 2 to 4 disjoint live verses the actor holds into their union,
    /// sometimes plus dead worlds (which need no cover). Reaches root, and so
    /// pays out, whenever the parts cover every possible world.
    fn merge(&mut self, seed: u64, amount: u128) -> bool {
        let p = self.pick(seed);
        let want = 2 + ((seed >> 24) % 3) as usize;
        let n = u64::from(p.root - 1);
        let held = self.holdings(&p);
        let (mut parts, mut used, mut min_bal) = (Vec::new(), 0u8, u128::MAX);
        for i in 0..n {
            if parts.len() >= want {
                break;
            }
            let m = 1 + (((seed >> 32) + i) % n) as u8;
            let (_, created, bal) = held[usize::from(m) - 1];
            if m & p.possible == 0 || m & used != 0 || !created {
                continue;
            }
            if bal == 0 {
                continue;
            }
            parts.push(m);
            used |= m;
            min_bal = min_bal.min(bal);
        }
        if parts.len() < 2 {
            return false;
        }
        let to_mask = used | ((seed >> 40) as u8 & p.root & !p.possible);
        let amount = bound(amount, 1, min_bal.min(MAX_AMOUNT));
        self.w
            .merge(p.actor, p.sid, p.asset, &parts, to_mask, amount)
            .is_ok()
    }

    fn redeem(&mut self, seed: u64, amount: u128) -> bool {
        let p = self.pick(seed);
        let Some((m, bal)) = self.held_mask(&p, seed >> 24, true) else {
            return false;
        };
        self.w
            .redeem(p.actor, p.sid, p.asset, m, bound(amount, 1, bal))
            .is_ok()
    }

    /// Any held token, dead ones included: transfers stay allowed after a
    /// verse dies. NEAR refuses self-transfers, so those go to the next actor.
    fn transfer(&mut self, seed: u64, amount: u128) -> bool {
        let p = self.pick(seed);
        let n = u64::from(p.root - 1);
        let held = self.holdings(&p);
        for i in 0..n {
            let m = 1 + (((seed >> 24) + i) % n) as u8;
            let (_, created, bal) = held[usize::from(m) - 1];
            if !created {
                continue;
            }
            if bal == 0 {
                continue;
            }
            let mut to = ACTORS[((seed >> 40) % 3) as usize];
            if to == p.actor {
                to = ACTORS[((seed >> 40) % 3 + 1) as usize % 3];
            }
            return self
                .w
                .mt_transfer(
                    p.actor,
                    to,
                    &token_id(p.sid, p.asset, m),
                    bound(amount, 1, bal),
                )
                .is_ok();
        }
        false
    }

    /// Invariant 2's probe: redeem, split and merge on a dead verse must all
    /// fail. The merge is set up so that the dead part is the only thing
    /// wrong with it. Returns whether an attempt was made.
    fn attempt_dead_ops(&mut self, seed: u64) -> bool {
        let p = self.pick(seed);
        let n = u64::from(p.root - 1);
        let held = self.holdings(&p);
        let mut dead = 0u8;
        for i in 0..n {
            let m = 1 + (((seed >> 24) + i) % n) as u8;
            let (_, created, bal) = held[usize::from(m) - 1];
            if m & p.possible != 0 || !created {
                continue;
            }
            if bal > 0 {
                dead = m;
                break;
            }
        }
        if dead == 0 {
            return false;
        }
        if self.w.redeem(p.actor, p.sid, p.asset, dead, 1).is_ok() {
            self.dead_ops_succeeded += 1;
        }
        let lowest = dead & dead.wrapping_neg();
        if self
            .w
            .split(p.actor, p.sid, p.asset, dead, &[lowest], 1)
            .is_ok()
        {
            self.dead_ops_succeeded += 1;
        }
        // one token unit of every live single world, then a merge that only
        // the dead part spoils
        let unit = self.w.unit(p.asset);
        let singles = single_worlds(p.possible);
        self.w
            .split_ft(p.actor, p.sid, p.asset, &singles, unit)
            .expect("split root into the live singles");
        let with_dead: Vec<u8> = std::iter::once(dead)
            .chain(singles.iter().copied())
            .collect();
        if self
            .w
            .merge(p.actor, p.sid, p.asset, &with_dead, p.root, unit)
            .is_ok()
        {
            self.dead_ops_succeeded += 1;
        }
        self.w
            .merge(p.actor, p.sid, p.asset, &singles, p.root, unit)
            .expect("merge the singles back");
        true
    }

    fn event_state(&mut self, event: u64) -> (bool, bool, u64) {
        self.w.view(|c| {
            (
                c.is_finalized(event),
                c.has_open_proposal(event),
                c.finalizable_at(event),
            )
        })
    }

    fn resolve(&mut self, seed: u64) -> bool {
        // kept rare, so runs see plenty of activity before and after each event
        if seed % 3 != 0 {
            return false;
        }
        let event = self.event(seed);
        if self.event_state(event).0 {
            return false;
        }
        self.w
            .admin_resolve(event, ((seed >> 16) % 2) as u8)
            .expect("admin resolve of an unfinalized event");
        self.record_deaths();
        true
    }

    fn propose(&mut self, seed: u64) -> bool {
        let event = self.event(seed);
        let (finalized, open, _) = self.event_state(event);
        if finalized || open {
            return false;
        }
        self.w
            .report(event, ((seed >> 16) % 2) as u8)
            .expect("report on an open event");
        true
    }

    fn dispute(&mut self, seed: u64) -> bool {
        let event = self.event(seed);
        let (_, open, at) = self.event_state(event);
        if !open || self.w.now >= at {
            return false;
        }
        self.w.dispute(event).expect("dispute inside the window");
        true
    }

    fn finalize(&mut self, seed: u64) -> bool {
        let event = self.event(seed);
        let (_, open, at) = self.event_state(event);
        if !open || self.w.now < at {
            return false;
        }
        self.w
            .finalize(ACTORS[(seed % 3) as usize], event)
            .expect("finalize after the window");
        self.record_deaths();
        true
    }

    fn deposit(&mut self, seed: u64, amount: u128) -> bool {
        let (actor, asset) = (
            ACTORS[(seed % 3) as usize],
            ASSETS[((seed >> 16) % 2) as usize],
        );
        let unit = self.w.unit(asset);
        let tokens = bound(
            amount,
            1,
            (self.w.wallet(actor, asset) / unit).min(MAX_AMOUNT / unit),
        );
        let raw = self.w.to_raw(asset, tokens * unit);
        // above 18 decimals, raw units below one internal unit ride along and
        // must come back as unused
        let raw_per_unit = if unit == 1 {
            self.w.to_raw(asset, 1)
        } else {
            1
        };
        let remainder = u128::from(seed >> 32) % raw_per_unit;
        if self.w.wallet_raw(actor, asset) < raw + remainder {
            return false;
        }
        match self.w.ft_transfer_call(actor, asset, raw + remainder, "") {
            Ok(unused) => {
                assert_eq!(unused, remainder, "the remainder goes back");
                true
            }
            Err(_) => false,
        }
    }

    fn withdraw(&mut self, seed: u64, amount: u128) -> bool {
        let (actor, asset) = (
            ACTORS[(seed % 3) as usize],
            ASSETS[((seed >> 16) % 2) as usize],
        );
        let real = self.w.real(actor, asset);
        real > 0
            && self
                .w
                .withdraw(actor, asset, bound(amount, 1, real))
                .is_ok()
    }

    /// After each resolution: every created token whose verse just died,
    /// with its supply at death.
    fn record_deaths(&mut self) {
        let scenarios = self.scenarios;
        let known: Vec<VerseKey> = self.dead.iter().map(|(k, _)| *k).collect();
        let fresh = self.w.view(|c| {
            let mut fresh = Vec::new();
            for sid in scenarios {
                let s = c.get_scenario(sid);
                for asset in ASSETS {
                    for m in 1..s.root {
                        let key = VerseKey::new(sid, asset, m);
                        if m & s.possible == 0 && c.is_created(&key) && !known.contains(&key) {
                            fresh.push((key, c.verse_supply(&key)));
                        }
                    }
                }
            }
            fresh
        });
        self.dead.extend(fresh);
    }

    /// Invariant 1, backing: for every (scenario, asset) and every possible
    /// world, the supply of the tokens covering it equals the scenario's
    /// reserves; there is never a root token; every token's supply is what
    /// its holders hold; and the contract's token balance, in raw units, is
    /// exactly the reserves plus the internal balances.
    fn check_backing(&mut self) -> Result<(), TestCaseError> {
        let scenarios = self.scenarios;
        let held: Vec<u128> = ASSETS.iter().map(|a| self.w.held_raw(*a)).collect();
        let cfg = self.w.cfg.clone();
        let holders: Vec<near_sdk::AccountId> = ACTORS.iter().map(|a| acc(a)).collect();
        self.w.view(|c| {
            for (i, asset) in ASSETS.into_iter().enumerate() {
                let mut total_reserves = 0u128;
                for sid in scenarios {
                    let s = c.get_scenario(sid);
                    let reserves = c.reserve(sid, asset);
                    total_reserves += reserves;
                    let supply: Vec<u128> = (0..=255u8)
                        .map(|m| {
                            if (1..s.root).contains(&m) {
                                c.verse_supply(&VerseKey::new(sid, asset, m))
                            } else {
                                0
                            }
                        })
                        .collect();
                    for w in 0..s.world_count {
                        if (s.possible >> w) & 1 == 0 {
                            continue;
                        }
                        let covering: u128 = (1..s.root)
                            .filter(|m| (m >> w) & 1 == 1)
                            .map(|m| supply[m as usize])
                            .sum();
                        prop_assert_eq!(
                            covering,
                            reserves,
                            "backing: scenario {} {} world {}",
                            sid,
                            asset,
                            w
                        );
                    }
                    let root = VerseKey::new(sid, asset, s.root);
                    prop_assert!(
                        !c.is_created(&root) && c.verse_supply(&root) == 0,
                        "a token for root"
                    );
                    for m in 1..s.root {
                        let key = VerseKey::new(sid, asset, m);
                        let held_by: u128 = holders
                            .iter()
                            .map(|h| c.verse_balance(h, &key))
                            .sum::<u128>()
                            + c.pool_holdings(&key)
                            + c.escrow_holdings(&key)
                            + c.collateral_holdings(&key)
                            + c.vault_holdings(&key);
                        prop_assert_eq!(
                            supply[m as usize],
                            held_by,
                            "conservation: {}",
                            key.token_id()
                        );
                    }
                }
                let internal: u128 = holders.iter().map(|h| c.real_balance(h, asset)).sum();
                let books = cfg[i].to_raw(total_reserves + internal).expect("raw fits");
                prop_assert_eq!(
                    (held[i], 0),
                    books,
                    "token balance != reserves + internal ({})",
                    asset
                );
            }
            Ok(())
        })
    }

    /// Invariant 2, dead stays dead: nothing on a dead verse ever succeeds,
    /// so every dead token's supply stays what it was when its verse died.
    fn check_dead_stays_dead(&mut self) -> Result<(), TestCaseError> {
        prop_assert_eq!(
            self.dead_ops_succeeded,
            0,
            "an operation on a dead verse succeeded"
        );
        let dead = self.dead.clone();
        let changed = self.w.view(|c| {
            dead.iter()
                .find(|(k, s)| c.verse_supply(k) != *s)
                .map(|(k, _)| k.token_id())
        });
        prop_assert!(
            changed.is_none(),
            "dead verse supply changed: {:?}",
            changed
        );
        Ok(())
    }

    /// Invariants 1 and 2 with EW-1..EW-4: the per-world counters, the
    /// created sets, the per-account index and both definitions of
    /// `holds_anything` (EW-5 runs inside every call).
    fn check_eight(&mut self) -> Result<(), TestCaseError> {
        self.check_backing()?;
        self.check_dead_stays_dead()?;
        check_eight_worlds(&mut self.w).map_err(TestCaseError::fail)
    }
}

fn name(op: Op) -> &'static str {
    match op {
        Op::Split => "split",
        Op::Merge => "merge",
        Op::MergeBack => "merge_back",
        Op::Redeem => "redeem",
        Op::Transfer => "mt_transfer",
        Op::DeadOps => "dead_op_rounds",
        Op::Resolve => "admin_resolve",
        Op::Propose => "report",
        Op::Dispute => "dispute",
        Op::Finalize => "finalize",
        Op::Warp => "warp",
        Op::Deposit => "deposit",
        Op::Withdraw => "withdraw",
    }
}

/// OPS-1 and M-13 after every action of every campaign.
fn check_books(c: &mut Campaign) -> Result<(), TestCaseError> {
    super::ops::books_hold(&mut c.w, &[ALICE, BOB, CAROL, OWNER]).map_err(TestCaseError::fail)
}

fn campaign(title: &str, fixture: Fixture, check: fn(&mut Campaign) -> Result<(), TestCaseError>) {
    let cases = match fixture {
        Fixture::Base(_) => CASES,
        Fixture::Eight => CASES_8,
    };
    let stats = RefCell::new(Stats::default());
    let config = Config {
        cases,
        failure_persistence: None,
        max_shrink_iters: 256,
        ..Config::default()
    };
    let replayed = RefCell::new((0u64, 0u64));
    let mut runner = TestRunner::new(config);
    let result = runner.run(&actions(), |actions| {
        let mut c = Campaign::new(fixture);
        let mut s = stats.borrow_mut();
        s.cases += 1;
        check(&mut c)?;
        check_books(&mut c)?;
        for (op, seed, amount) in actions {
            c.run(op, seed, amount, &mut s);
            s.actions += 1;
            check(&mut c)?;
            check_books(&mut c)?;
        }
        let r = c.w.replay.as_ref().expect("replayed");
        let mut total = replayed.borrow_mut();
        total.0 += r.calls;
        total.1 += r.lines;
        Ok(())
    });
    let s = stats.into_inner();
    let (calls, lines) = replayed.into_inner();
    println!(
        "{title}: {} cases, {} actions; successful calls {:?}; dead-op rounds {}, resolutions {}, failed payouts \
         re-credited {}, most dead tokens tracked in one run {}; NEP-245 replay of {calls} calls, {lines} lines",
        s.cases, s.actions, s.calls, s.dead_ops_attempted, s.resolutions, s.failed_payouts, s.max_dead_tracked
    );
    if let Err(e) = result {
        panic!("{title}: {e}");
    }
    // the campaign must actually reach the states the invariants are about
    assert!(s.calls.get("split").copied().unwrap_or(0) > 4 * u64::from(cases));
    assert!(s.resolutions > u64::from(cases));
    assert!(s.dead_ops_attempted > 0);
    assert!(s.failed_payouts > 0);
    assert!(calls > s.actions / 2 && lines > 4 * u64::from(cases));
}

#[test]
fn invariant_1_backing() {
    campaign(
        "invariant_1_backing",
        Fixture::Base(18),
        Campaign::check_backing,
    );
}

/// The backing invariant with the testnet wNEAR's 24 decimals: the contract
/// holds exactly the raw units of reserves plus internal balances, so no
/// deposit remainder and no payout rounding ever leaks into the books.
#[test]
fn invariant_1_backing_with_24_decimal_wnear() {
    campaign(
        "invariant_1_backing_with_24_decimal_wnear",
        Fixture::Base(24),
        Campaign::check_backing,
    );
}

/// Invariants 1 and 2 and EW-1..EW-5 at 8 worlds.
#[test]
fn invariants_at_eight_worlds() {
    campaign(
        "invariants_at_eight_worlds",
        Fixture::Eight,
        Campaign::check_eight,
    );
}

#[test]
fn invariant_2_dead_stays_dead() {
    campaign(
        "invariant_2_dead_stays_dead",
        Fixture::Base(18),
        Campaign::check_dead_stays_dead,
    );
}
