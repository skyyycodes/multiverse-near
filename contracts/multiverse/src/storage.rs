//! NEP-145 storage management, plus the charging every state-changing entry
//! point runs at its end: the bytes a call adds are paid from the payer's
//! storage deposit and the bytes it frees are credited back.
//!
//! Accounting is per payer, not per owner of an entry: if alice's transfer
//! creates bob's balance entry, alice pays for it, and whoever's call later
//! removes it gets the credit. The contract never pays for user growth, except
//! the small, bounded writes of callbacks.

use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, AccountId, NearToken, Promise};

use crate::errors::fail;
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
                    self.storage.insert(account_id.clone(), account.clone());
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
                self.storage.insert(
                    account_id.clone(),
                    StorageAccount {
                        deposit,
                        used_bytes: 0,
                    },
                );
                self.storage.flush();
                // The record pays for itself. Rewriting it with the measured
                // size keeps the same byte length.
                let account = StorageAccount {
                    deposit,
                    used_bytes: env::storage_usage() - before,
                };
                self.storage.insert(account_id, account.clone());
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
        self.storage.insert(account_id.clone(), account.clone());
        if !amount.is_zero() {
            Promise::new(account_id).transfer(amount);
        }
        account.balance()
    }

    /// Closes the caller's registration and refunds the deposit. Only an
    /// account that holds nothing here may leave; `force` is not supported.
    /// Returns false if the caller was not registered.
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
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
        self.storage.remove(&account_id);
        self.storage.flush();
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
    /// contract must be listed here (`created` and the demo record write
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
        self.markets.flush();
        self.supply_shares.flush();
        self.supply_principal.flush();
        self.borrow_shares.flush();
        self.collateral.flush();
        self.vaults.flush();
        self.lp_shares.flush();
        self.storage.flush();
    }

    /// Charges what the call grew storage by (since `before`) to `payer`'s
    /// deposit, or credits what it freed. Growth needs a registered payer
    /// with enough available deposit, else the call fails (and an
    /// `ft_on_transfer` refunds).
    pub(crate) fn charge_storage(&mut self, payer: &AccountId, before: u64) {
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
        self.storage.insert(payer.clone(), account);
    }

    /// For owner methods marked S: with a deposit attached, the deposit pays
    /// for the growth and the excess is refunded; without one, the owner's
    /// NEP-145 balance pays.
    pub(crate) fn charge_storage_or_deposit(&mut self, payer: &AccountId, before: u64) {
        let attached = env::attached_deposit();
        if attached.is_zero() {
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
    /// `storage_unregister`.
    pub(crate) fn holds_anything(&self, account_id: &AccountId) -> bool {
        Asset::ALL
            .into_iter()
            .any(|a| self.real_balance(account_id, a) > 0)
            || self
                .verse_keys()
                .any(|k| self.verse_balance(account_id, &k) > 0)
            || self.has_pool_positions(account_id)
            || self.has_open_orders(account_id)
            || self.has_lending_position(account_id)
            || self.has_lp_shares(account_id)
    }

    /// Every verse key that can exist, in a fixed order: scenario, then asset,
    /// then mask. Root is skipped; it is never a token.
    pub(crate) fn verse_keys(&self) -> impl Iterator<Item = VerseKey> + '_ {
        (1..=self.scenario_count).flat_map(move |sid| {
            let root = self.scenarios.get(&sid).map_or(0, |s| s.root());
            Asset::ALL
                .into_iter()
                .flat_map(move |asset| (1..root).map(move |mask| VerseKey::new(sid, asset, mask)))
        })
    }
}
