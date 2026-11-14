//! Lending's part of the v1 -> v2 upgrade (steps 9 to 11 of `migrate`) and
//! of `upgrade_account`.
//!
//! Every v1 lending entry already is the Normal tier of its scenario, so
//! nothing is re-keyed and nothing accrues: a legacy market with debt keeps
//! v1's economics exactly (`TierConfig::v1_terms`), every other legacy
//! Normal market gets v1's lltv and bonus on the Normal curve. The borrower
//! index of legacy markets is backfilled from the dump's accounts, then
//! proved against each market's total borrow shares.

use near_sdk::json_types::U128;
use near_sdk::AccountId;

use super::tiers::{MarketId, Tier, TierConfig, TierState};
use crate::migrate::{LendingMigrateArgs, LendingUpgradeLog};
use crate::ops::PauseFlag;
use crate::Contract;

impl Contract {
    /// Step 9: the Normal `TierState` of every legacy scenario (v1 terms
    /// where its market has supply or debt borrowed, the legacy live terms
    /// elsewhere), frozen per `args`, and builtin frozen Safe and Bold for
    /// each frozen scenario. Every frozen id must be a legacy scenario.
    pub(crate) fn migrate_lending_configs(
        &mut self,
        args: &LendingMigrateArgs,
        log: &mut LendingUpgradeLog,
    ) {
        let legacy = self.legacy_scenario_count;
        for &sid in &args.frozen_scenarios {
            if sid == 0 || sid > legacy {
                fail!("MigrateBadArgs(frozen_scenarios, {sid})");
            }
        }
        let params = self.params.clone();
        for sid in 1..=legacy {
            let frozen = args.frozen_scenarios.contains(&sid);
            let id = MarketId::new(sid, None);
            let market = self.markets.get(&id.key()).cloned();
            if market.is_some() {
                log.legacy_markets += 1;
            }
            let with_debt =
                market.is_some_and(|m| m.total_borrow_assets > 0 || m.total_borrow_shares > 0);
            let config = if with_debt {
                log.v1_terms.push(sid);
                TierConfig::v1_terms(&params)
            } else {
                TierConfig::legacy_live(&params)
            };
            config.validate();
            self.tier_states.insert(
                id.key(),
                TierState {
                    config,
                    frozen,
                    insurance: 0,
                    bad_debt_covered: 0,
                    bad_debt_socialized: 0,
                },
            );
            if frozen {
                log.frozen.push(sid);
                for tier in [Tier::Safe, Tier::Bold] {
                    let mut state = TierState::builtin(tier);
                    state.frozen = true;
                    self.tier_states
                        .insert(MarketId::new(sid, Some(tier)).key(), state);
                }
            }
        }
    }

    /// Lending's part of `upgrade_account`: indexes `a` as a borrower of every
    /// legacy market where it has borrow shares. Idempotent.
    pub(crate) fn lending_upgrade_account(&mut self, a: &AccountId) {
        for sid in 1..=self.legacy_scenario_count {
            let id = MarketId::new(sid, None);
            if self.borrow_shares_of(id, a) != 0 {
                self.sync_borrower(id, a, true);
            }
        }
    }

    /// Step 11: Σ indexed borrow shares against TBS per legacy market. Above
    /// TBS (a bug) fails `BorrowerBackfillIncomplete`; below it (a borrower
    /// the dump missed) logs the gap, sets `legacy_backfill_open` and pauses
    /// `lend` and `liquidate` until `upgrade_accounts` closes it.
    pub(crate) fn migrate_lending_proof(&mut self, log: &mut LendingUpgradeLog) {
        let mut borrowers = 0u32;
        for sid in 1..=self.legacy_scenario_count {
            let id = MarketId::new(sid, None);
            let Some(tbs) = self.markets.get(&id.key()).map(|m| m.total_borrow_shares) else {
                continue;
            };
            borrowers = borrowers.saturating_add(self.borrower_count_of(id));
            let indexed = self.indexed_shares(id);
            if indexed > tbs {
                fail!("BorrowerBackfillIncomplete({sid}, {indexed}, {tbs})");
            }
            if indexed < tbs {
                log.unindexed.push((sid, U128(tbs - indexed)));
            }
        }
        log.borrowers = borrowers;
        if !log.unindexed.is_empty() {
            self.legacy_backfill_open = true;
            self.pause.flags |= PauseFlag::bits_of(&[PauseFlag::Lend, PauseFlag::Liquidate]);
        }
    }

    /// Step 11's proof again, for `unpause` while `legacy_backfill_open`: the
    /// first legacy market still short as `(sid, indexed, tbs)`, None when all
    /// balance.
    #[allow(dead_code)] // called by unpause
    pub(crate) fn lending_backfill_proof(&self) -> Option<(u64, u128, u128)> {
        (1..=self.legacy_scenario_count).find_map(|sid| {
            let id = MarketId::new(sid, None);
            let tbs = self.markets.get(&id.key())?.total_borrow_shares;
            let indexed = self.indexed_shares(id);
            (indexed != tbs).then_some((sid, indexed, tbs))
        })
    }
}
