//! NEP-145 storage management, plus the charging every state-changing entry
//! point runs at its end: the bytes a call adds are paid from the payer's
//! storage deposit and the bytes it frees are credited back.
//!
//! Accounting is per payer, not per owner of an entry: if alice's transfer
//! creates bob's balance entry, alice pays for it, and whoever's call later
//! removes it gets the credit. Callbacks charge the account they write for
//! without checking its deposit, so the contract never pays for user growth;
//! it only absorbs callback writes for accounts that are not registered.
//!
//! Every write of a NEP-145 record goes through one funnel,
//! `put_storage_account`: it folds the account's v1 data first
//! (`upgrade_account`) and moves the NEAR books by the record's change.

use std::cmp::Ordering;
use std::ops::RangeInclusive;

use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, AccountId, NearToken, Promise};

use crate::errors::fail;
use crate::events::{DustSwept, MultiverseEvent};
use crate::lending::tiers::{MarketId, Tier};
use crate::ops::PauseFlag;
use crate::types::{Asset, VerseKey};
use crate::{Contract, ContractExt};

/// Registration minimum. It is a deposit, not a fee: storage is drawn from
/// it as the account's calls use bytes, and what is left can be withdrawn.
pub const STORAGE_MIN: NearToken = NearToken::from_millinear(100);

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageAccount {
    pub deposit: NearToken,
    /// Net bytes this account's calls have added, its own record included.
    pub used_bytes: u64,
    /// Orders this account has open. Kept here so `storage_unregister` and
    /// the per-maker cap never scan the book.
    pub open_orders: u32,
}

impl StorageAccount {
    fn used_cost(&self) -> NearToken {
        env::storage_byte_cost().saturating_mul(u128::from(self.used_bytes))
    }

    fn available(&self) -> NearToken {
        self.deposit.saturating_sub(self.used_cost())
    }

    fn balance(&self) -> StorageBalance {
        StorageBalance {
            total: U128(self.deposit.as_yoctonear()),
            available: U128(self.available().as_yoctonear()),
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near]
impl Contract {
    /// Registers `account_id` (default: the caller) or tops it up. A new
    /// account needs at least `STORAGE_MIN`; with `registration_only` only
    /// the minimum is kept and the rest refunded, and an account that is
    /// already registered gets the whole deposit back.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        let attached = env::attached_deposit();
        let registration_only = registration_only.unwrap_or(false);
        let (account, refund) = match self.storage.get(&account_id).cloned() {
            Some(mut account) => {
                if registration_only {
                    (account, attached)
                } else {
                    account.deposit = account.deposit.saturating_add(attached);
                    self.put_storage_account(&account_id, Some(account.clone()));
                    (account, NearToken::from_yoctonear(0))
                }
            }
            None => {
                if attached < STORAGE_MIN {
                    fail!(
                        "InsufficientDeposit({}, {})",
                        attached.as_yoctonear(),
                        STORAGE_MIN.as_yoctonear()
                    );
                }
                let deposit = if registration_only {
                    STORAGE_MIN
                } else {
                    attached
                };
                self.flush_state();
                let before = env::storage_usage();
                self.put_storage_account(
                    &account_id,
                    Some(StorageAccount {
                        deposit,
                        used_bytes: 0,
                        open_orders: 0,
                    }),
                );
                self.flush_state();
                // The record pays for itself and for the account's upgrade
                // marker. Rewriting it with the measured size keeps the same
                // byte length.
                let account = StorageAccount {
                    deposit,
                    used_bytes: env::storage_usage() - before,
                    open_orders: 0,
                };
                self.put_storage_account(&account_id, Some(account.clone()));
                (account, attached.saturating_sub(deposit))
            }
        };
        if !refund.is_zero() {
            Promise::new(env::predecessor_account_id()).transfer(refund);
        }
        account.balance()
    }

    /// Withdraws `amount` (default: everything available) of the caller's
    /// storage deposit that no stored bytes are using.
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        assert_one_yocto();
        self.assert_live(PauseFlag::Exit);
        let account_id = env::predecessor_account_id();
        let mut account = self.registered(&account_id);
        let available = account.available();
        let amount = amount.map_or(available, |a| NearToken::from_yoctonear(a.0));
        if amount > available {
            fail!(
                "WithdrawExceedsAvailable({}, {})",
                amount.as_yoctonear(),
                available.as_yoctonear()
            );
        }
        account.deposit = account.deposit.saturating_sub(amount);
        self.put_storage_account(&account_id, Some(account.clone()));
        if !amount.is_zero() {
            Promise::new(account_id).transfer(amount);
        }
        account.balance()
    }

    /// Closes the caller's registration and refunds the deposit. Only an
    /// account that holds nothing here may leave, apart from internal balances
    /// below one token unit, which are swept to the contract; `force` is not
    /// supported. The account's upgrade marker goes with the record (an
    /// account that comes back has nothing left to fold). Returns false if the
    /// caller was not registered.
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        self.assert_live(PauseFlag::Exit);
        if force == Some(true) {
            fail("ForceUnregisterUnsupported");
        }
        let account_id = env::predecessor_account_id();
        let Some(account) = self.storage.get(&account_id).cloned() else {
            return false;
        };
        if self.holds_anything(&account_id) {
            fail!("AccountNotEmpty({account_id})");
        }
        self.flush_state();
        let before = env::storage_usage();
        self.sweep_dust(&account_id);
        self.put_storage_account(&account_id, None);
        self.account_version.remove(&account_id);
        self.flush_state();
        let freed = before.saturating_sub(env::storage_usage());
        // Entries this account paid for that still exist (another account's
        // balance it created, say) keep their bytes paid for.
        let still_used = account.used_bytes.saturating_sub(freed);
        let still_cost = env::storage_byte_cost().saturating_mul(u128::from(still_used));
        let refund = account.deposit.saturating_sub(still_cost);
        if !refund.is_zero() {
            Promise::new(account_id).transfer(refund);
        }
        true
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.storage.get(&account_id).map(StorageAccount::balance)
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: U128(STORAGE_MIN.as_yoctonear()),
            max: None,
        }
    }
}

impl Contract {
    pub(crate) fn is_registered(&self, account_id: &AccountId) -> bool {
        self.storage.contains_key(account_id)
    }

    pub(crate) fn assert_registered(&self, account_id: &AccountId) {
        if !self.is_registered(account_id) {
            fail!("NotRegistered({account_id})");
        }
    }

    fn registered(&self, account_id: &AccountId) -> StorageAccount {
        self.storage
            .get(account_id)
            .cloned()
            .unwrap_or_else(|| fail!("NotRegistered({account_id})"))
    }

    /// `near_sdk::store` collections buffer writes until flushed, so storage
    /// usage only moves once they are written out. Every collection of the
    /// contract must be listed here (`created` and the raw keys write
    /// through on their own).
    pub(crate) fn flush_state(&mut self) {
        self.events.flush();
        self.scenarios_of_event.flush();
        self.scenarios.flush();
        self.reserves.flush();
        self.balances.flush();
        self.supply.flush();
        self.real.flush();
        self.pools.flush();
        self.within.flush();
        self.between.flush();
        self.positions.flush();
        self.impact.flush();
        self.orders.flush();
        self.open_by_world.flush();
        self.open_by_scenario.flush();
        self.markets.flush();
        self.supply_shares.flush();
        self.supply_principal.flush();
        self.borrow_shares.flush();
        self.collateral.flush();
        self.vaults.flush();
        self.lp_shares.flush();
        self.storage.flush();
        self.outlayer.flush();
        self.account_version.flush();
        self.catalog.flush();
        self.world_supply.flush();
        self.created_masks.flush();
        self.account_scenarios.flush();
        self.footprints.flush();
        self.prices.configs.flush();
        self.tier_states.flush();
        self.borrower_count.flush();
        self.borrower_at.flush();
        self.borrower_pos.flush();
    }

    /// The StorageAccount funnel, the only writer of `storage`: folds the
    /// account's v1 data first, then moves the NEAR books from the stored
    /// record to `record` (`None` removes it).
    pub(crate) fn put_storage_account(
        &mut self,
        account_id: &AccountId,
        record: Option<StorageAccount>,
    ) {
        self.upgrade_account(account_id);
        let old = self.storage.get(account_id).cloned();
        self.books_on_storage(old.as_ref(), record.as_ref());
        match record {
            Some(record) => {
                self.storage.insert(account_id.clone(), record);
            }
            None => {
                self.storage.remove(account_id);
            }
        }
    }

    /// Folds a registered account before a charge is measured, so its
    /// upgrade marker counts as growth of the call that wrote it.
    fn fold_payer(&mut self, account_id: &AccountId) {
        if self.storage.contains_key(account_id) {
            self.upgrade_account(account_id);
        }
    }

    /// Charges what the call grew storage by (since `before`) to `payer`'s
    /// deposit, or credits what it freed. Growth needs a registered payer
    /// with enough available deposit, else the call fails (and an
    /// `ft_on_transfer` refunds).
    pub(crate) fn charge_storage(&mut self, payer: &AccountId, before: u64) {
        self.fold_payer(payer);
        self.flush_state();
        let after = env::storage_usage();
        if after == before {
            return;
        }
        let Some(mut account) = self.storage.get(payer).cloned() else {
            if after > before {
                fail!("NotRegistered({payer})");
            }
            // Bytes freed by an unregistered payer were paid by someone else;
            // they stay with the contract.
            return;
        };
        if after > before {
            let grown = after - before;
            let needed = env::storage_byte_cost().saturating_mul(u128::from(grown));
            let available = account.available();
            if needed > available {
                fail!(
                    "InsufficientStorage({}, {})",
                    needed.as_yoctonear(),
                    available.as_yoctonear()
                );
            }
            account.used_bytes += grown;
        } else {
            account.used_bytes = account.used_bytes.saturating_sub(before - after);
        }
        self.put_storage_account(payer, Some(account));
    }

    /// Credits `yocto` to `account`'s NEP-145 deposit: a bond, a reserve or an
    /// excess the contract returns. It is synchronous and costs no receipt;
    /// the account withdraws it with `storage_withdraw`. An account that is no
    /// longer registered is sent the NEAR instead.
    #[allow(dead_code)] // the catalogue returns bonds and reserves through it
    pub(crate) fn credit_deposit(&mut self, account: &AccountId, yocto: u128) {
        if yocto == 0 {
            return;
        }
        let amount = NearToken::from_yoctonear(yocto);
        match self.storage.get(account).cloned() {
            Some(mut record) => {
                record.deposit = record.deposit.saturating_add(amount);
                self.put_storage_account(account, Some(record));
            }
            None => {
                Promise::new(account.clone()).transfer(amount);
            }
        }
    }

    pub(crate) fn open_order_count(&self, account_id: &AccountId) -> usize {
        self.storage
            .get(account_id)
            .map_or(0, |a| a.open_orders as usize)
    }

    /// Makers are always registered: posting charges them storage.
    pub(crate) fn count_open_order(&mut self, maker: &AccountId, opened: bool) {
        let Some(mut account) = self.storage.get(maker).cloned() else {
            fail!("NotRegistered({maker})");
        };
        account.open_orders = if opened {
            account.open_orders.saturating_add(1)
        } else {
            account.open_orders.saturating_sub(1)
        };
        self.put_storage_account(maker, Some(account));
    }

    /// `charge_storage` for callbacks, which must never panic: growth is
    /// added to a registered account's bytes even past its deposit (it then
    /// has nothing available to withdraw until it frees bytes). Without this,
    /// an entry a callback re-creates for free would be credited to the
    /// account again when it is next removed. Unregistered accounts' growth
    /// stays with the contract.
    pub(crate) fn charge_storage_in_callback(&mut self, account_id: &AccountId, before: u64) {
        self.fold_payer(account_id);
        self.flush_state();
        let after = env::storage_usage();
        let Some(mut account) = self.storage.get(account_id).cloned() else {
            return;
        };
        account.used_bytes = match after.cmp(&before) {
            Ordering::Greater => account.used_bytes.saturating_add(after - before),
            Ordering::Less => account.used_bytes.saturating_sub(before - after),
            Ordering::Equal => return,
        };
        self.put_storage_account(account_id, Some(account));
    }

    /// For owner methods marked S. They move the owner's balances, so a
    /// deposit is required: a function-call access key cannot attach one.
    /// Exactly 1 yoctoNEAR means the owner's NEP-145 balance pays; more pays
    /// for the growth and the excess is refunded.
    pub(crate) fn charge_storage_or_deposit(&mut self, payer: &AccountId, before: u64) {
        let attached = env::attached_deposit();
        if attached.is_zero() {
            fail("DepositRequired");
        }
        if attached == NearToken::from_yoctonear(1) {
            return self.charge_storage(payer, before);
        }
        self.flush_state();
        let grown = env::storage_usage().saturating_sub(before);
        let needed = env::storage_byte_cost().saturating_mul(u128::from(grown));
        if needed > attached {
            fail!(
                "InsufficientStorage({}, {})",
                needed.as_yoctonear(),
                attached.as_yoctonear()
            );
        }
        let refund = attached.saturating_sub(needed);
        if !refund.is_zero() {
            Promise::new(payer.clone()).transfer(refund);
        }
    }

    /// Whether `account_id` still has anything in the contract, which blocks
    /// `storage_unregister`: a real balance of at least one token unit (dust
    /// below it does not count: no payout could ever send it), an open order,
    /// anything in a scenario created after the upgrade (its scenario index,
    /// one read), a pledge, seed claim or live proposal (one read), a spot
    /// pool position, or anything in a legacy scenario (a fixed scan of
    /// scenarios `1..=legacy_scenario_count`). Its cost does not grow with
    /// the number of markets.
    pub(crate) fn holds_anything(&self, account_id: &AccountId) -> bool {
        Asset::ALL
            .into_iter()
            .any(|a| self.real_balance(account_id, a) >= self.asset_cfg(a).min_payable())
            || self.has_open_orders(account_id)
            || self.footprints.contains_key(account_id)
            || self.catalog.account_busy(account_id)
            || self.has_spot_position(account_id)
            || self.legacy_holds(account_id)
    }

    /// The spot pool belongs to no scenario, so the index never covers it.
    fn has_spot_position(&self, account_id: &AccountId) -> bool {
        self.spot_pool
            .is_some_and(|id| self.positions.contains_key(&(id, account_id.clone())))
    }

    /// v1-era holdings, which the index never covers: anything in a scenario
    /// up to `legacy_scenario_count` (about 190 reads on production, forever;
    /// none on a deployment made with `new`).
    fn legacy_holds(&self, account_id: &AccountId) -> bool {
        (1..=self.legacy_scenario_count).any(|sid| self.legacy_holds_in(account_id, sid))
    }

    /// Whether `account_id` holds anything in legacy scenario `sid`: a verse
    /// balance, a position in one of its pools, a lending entry of any tier
    /// (Normal also counts a supply principal, as v1 did) or Root LP shares.
    pub(crate) fn legacy_holds_in(&self, account_id: &AccountId, sid: u64) -> bool {
        let Some(s) = self.scenarios.get(&sid) else {
            return false;
        };
        let a = account_id.clone();
        self.verse_keys_in(sid..=sid)
            .any(|k| self.verse_balance(account_id, &k) > 0)
            || s.pool_ids
                .iter()
                .any(|id| self.positions.contains_key(&(*id, a.clone())))
            || Tier::ALL.into_iter().any(|tier| {
                let k = (MarketId::new(sid, Some(tier)).key(), a.clone());
                self.supply_shares.contains_key(&k)
                    || self.borrow_shares.contains_key(&k)
                    || self.collateral.contains_key(&k)
                    || (tier.is_normal() && self.supply_principal.contains_key(&k))
            })
            || self.lp_shares.contains_key(&(sid, a))
    }

    /// The scenarios where `account_id` holds anything, ascending: the legacy
    /// scan, then the scenario index.
    pub(crate) fn scenarios_held_by(&self, account_id: &AccountId) -> Vec<u64> {
        let mut out: Vec<u64> = (1..=self.legacy_scenario_count)
            .filter(|sid| self.legacy_holds_in(account_id, *sid))
            .collect();
        out.extend(self.indexed_scenarios(account_id));
        out
    }

    /// Keeps the books whole: the dust stays backed by tokens the contract
    /// holds, so it moves to the contract's own internal balance.
    fn sweep_dust(&mut self, account_id: &AccountId) {
        let contract = env::current_account_id();
        for asset in Asset::ALL {
            let dust = self.real_balance(account_id, asset);
            if dust == 0 {
                continue;
            }
            self.real_debit(account_id, asset, dust);
            self.real_credit(&contract, asset, dust);
            DustSwept {
                account_id,
                asset,
                amount: U128(dust),
            }
            .emit();
        }
    }

    /// Every verse key that can exist in the scenarios `sids`, in a fixed
    /// order: scenario, then asset, then mask. Root is skipped; it is never a
    /// token.
    pub(crate) fn verse_keys_in(
        &self,
        sids: RangeInclusive<u64>,
    ) -> impl Iterator<Item = VerseKey> + '_ {
        sids.flat_map(move |sid| {
            let root = self.scenarios.get(&sid).map_or(0, |s| s.root());
            Asset::ALL
                .into_iter()
                .flat_map(move |asset| (1..root).map(move |mask| VerseKey::new(sid, asset, mask)))
        })
    }

    /// Every verse key that can exist, in every scenario: the full scan the
    /// tests check the counters and the index against.
    #[cfg(test)]
    pub(crate) fn verse_keys(&self) -> impl Iterator<Item = VerseKey> + '_ {
        self.verse_keys_in(1..=self.scenario_count)
    }

    /// Every token that exists, in (scenario, asset, mask) order: one
    /// `created_masks` read per scenario.
    pub(crate) fn created_keys(&self) -> impl Iterator<Item = VerseKey> + '_ {
        (1..=self.scenario_count).flat_map(move |sid| {
            let set = self.created_masks.get(&sid).copied().unwrap_or_default();
            set.iter()
                .map(move |(asset, mask)| VerseKey::new(sid, asset, mask))
                .collect::<Vec<_>>()
        })
    }
}
