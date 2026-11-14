//! The borrower index (F1): per market, a dense list of every account with
//! debt, so bots and the At-risk page can page through borrowers on chain.
//!
//! Per market key `k`: `borrower_count[k] = n`, `borrower_at[(k, i)]` for
//! `i < n` and `borrower_pos[(k, account)] = i`. A removal moves the last
//! entry into the freed slot, so the list stays dense; the count entry goes
//! at 0. `set_borrow_shares` is the only writer of `borrow_shares` and keeps
//! the index in step; `set_supply_shares` is the only writer of
//! `supply_shares`. Both, with `set_pieces`, tell the per-account index when
//! a lending entry appears or goes.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use super::tiers::{MarketId, Tier};
use super::LiquidationState;
use crate::{now_sec, Contract, ContractExt};

/// Rows a `borrowers` page scans by default, and at most.
pub const BORROWERS_DEFAULT_LIMIT: u32 = 50;
pub const BORROWERS_MAX_LIMIT: u32 = 100;

/// One borrower, valued at the page's prices. Debt, HF and `max_repay`
/// include pending interest.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BorrowerRow {
    pub index: u32,
    pub account_id: AccountId,
    pub debt: U128,
    pub health_factor: Option<U128>,
    pub worst_world: Option<u8>,
    pub c_min: U128,
    pub liquidation: LiquidationState,
    pub unpriced_world: Option<u8>,
    pub max_repay: U128,
    pub full_seize_repay: U128,
    pub write_off_ready: bool,
}

/// One page of a market's borrowers. `next_index` is where the next page
/// starts, null at the end; a filtered-out row still counts as scanned.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BorrowerPage {
    pub scenario_id: u64,
    pub tier: Tier,
    pub total: u32,
    pub from_index: u32,
    pub next_index: Option<u32>,
    pub now_sec: u64,
    pub rows: Vec<BorrowerRow>,
}

#[near]
impl Contract {
    /// How many accounts owe in the market.
    #[deny_unknown_arguments]
    pub fn borrower_count(&self, scenario_id: u64, tier: Option<Tier>) -> u32 {
        self.borrower_count_of(MarketId::new(scenario_id, tier))
    }

    /// The market's borrowers from slot `from_index` (default 0), scanning
    /// `limit` slots (default 50, at most 100), at one price snapshot. With
    /// `max_health_factor` only rows below it are returned: `1e18` lists
    /// what can be liquidated now. Slots move when a loan closes (the last
    /// borrower takes the freed slot), so a bot re-scans every block.
    #[deny_unknown_arguments]
    pub fn borrowers(
        &self,
        scenario_id: u64,
        tier: Option<Tier>,
        from_index: Option<u32>,
        limit: Option<u32>,
        max_health_factor: Option<U128>,
    ) -> BorrowerPage {
        let id = MarketId::new(scenario_id, tier);
        let ctx = self.market_ctx_view(id);
        let total = self.borrower_count_of(id);
        let from = from_index.unwrap_or(0);
        let limit = limit
            .unwrap_or(BORROWERS_DEFAULT_LIMIT)
            .min(BORROWERS_MAX_LIMIT);
        let end = from.saturating_add(limit).min(total);
        let mut rows = Vec::new();
        for index in from..end {
            let Some(account) = self.borrower_at.get(&(id.key(), index)).cloned() else {
                continue;
            };
            let a = self.assess(&ctx, &account);
            let hf = a.liq_health.hf;
            if let Some(max) = max_health_factor {
                if hf.is_none_or(|h| h >= max.0) {
                    continue;
                }
            }
            rows.push(BorrowerRow {
                index,
                account_id: account,
                debt: U128(a.debt),
                health_factor: hf.map(U128),
                worst_world: hf.map(|_| a.liq_health.worst),
                c_min: U128(a.liq_health.lowest),
                liquidation: a.status,
                unpriced_world: a.unpriced_world,
                max_repay: U128(a.max_repay),
                full_seize_repay: U128(a.fsr),
                write_off_ready: a.write_off_ready,
            });
        }
        BorrowerPage {
            scenario_id,
            tier: id.tier,
            total,
            from_index: from,
            next_index: (end < total).then_some(end),
            now_sec: now_sec(),
            rows,
        }
    }
}

impl Contract {
    pub(crate) fn borrower_count_of(&self, id: MarketId) -> u32 {
        self.borrower_count.get(&id.key()).copied().unwrap_or(0)
    }

    /// The only writer of `borrow_shares`: folds v1 data first, keeps the
    /// borrower index and the account's lending entries in step.
    pub(crate) fn set_borrow_shares(&mut self, id: MarketId, a: &AccountId, shares: u128) {
        self.upgrade_account(a);
        let existed = self.borrow_shares_of(id, a) != 0;
        let k = (id.key(), a.clone());
        if shares == 0 {
            self.borrow_shares.remove(&k);
        } else {
            self.borrow_shares.insert(k, shares);
        }
        self.note_lending(a, id.key(), existed, shares != 0);
        self.sync_borrower(id, a, shares != 0);
    }

    /// The only writer of `supply_shares`. At zero shares the account's
    /// principal entry goes too, so a socialized loss never leaves a
    /// principal behind that blocks `storage_unregister`.
    pub(crate) fn set_supply_shares(&mut self, id: MarketId, a: &AccountId, shares: u128) {
        let existed = self.supply_shares_of(id, a) != 0;
        let k = (id.key(), a.clone());
        if shares == 0 {
            self.supply_shares.remove(&k);
            self.supply_principal.remove(&k);
        } else {
            self.supply_shares.insert(k, shares);
        }
        self.note_lending(a, id.key(), existed, shares != 0);
    }

    /// Puts `a` in the index of `id` or takes it out. It reads the index
    /// rather than trusting the caller, so a borrower the backfill missed is
    /// indexed on its next touch.
    pub(crate) fn sync_borrower(&mut self, id: MarketId, a: &AccountId, borrowing: bool) {
        let k = id.key();
        let pos = self.borrower_pos.get(&(k, a.clone())).copied();
        match (pos, borrowing) {
            (None, true) => {
                let n = self.borrower_count_of(id);
                self.borrower_at.insert((k, n), a.clone());
                self.borrower_pos.insert((k, a.clone()), n);
                self.borrower_count.insert(k, n + 1);
            }
            (Some(i), false) => {
                let last = self.borrower_count_of(id).saturating_sub(1);
                if i != last {
                    if let Some(moved) = self.borrower_at.get(&(k, last)).cloned() {
                        self.borrower_at.insert((k, i), moved.clone());
                        self.borrower_pos.insert((k, moved), i);
                    }
                }
                self.borrower_at.remove(&(k, last));
                self.borrower_pos.remove(&(k, a.clone()));
                if last == 0 {
                    self.borrower_count.remove(&k);
                } else {
                    self.borrower_count.insert(k, last);
                }
            }
            _ => {}
        }
    }

    /// Σ borrow shares of the indexed borrowers of `id`.
    pub(crate) fn indexed_shares(&self, id: MarketId) -> u128 {
        (0..self.borrower_count_of(id))
            .filter_map(|i| self.borrower_at.get(&(id.key(), i)))
            .map(|a| self.borrow_shares_of(id, a))
            .fold(0u128, |sum, s| sum.saturating_add(s))
    }
}
