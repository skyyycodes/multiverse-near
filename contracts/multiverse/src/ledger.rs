//! The verse ledger (per-account balances, supply, the created set) and the
//! internal real wNEAR/USDC balances.
//!
//! Every change to a user's verse balance logs the matching NEP-245 event,
//! one log line per call however many tokens it moves. Tokens a module holds
//! (pool reserves, order escrow, collateral, the Root LP vault) leave
//! `balances` but stay in `supply`; the custody helpers log those moves as
//! transfers to and from the contract's own account, so indexers balance.
//! Zero balances are removed so they stop costing storage.
//!
//! A router trade can move tokens dozens of times (every order fill, swap and
//! deposit), and a receipt may log at most 100 lines and 16 KiB, so it opens
//! a `TransferBatch`: its transfers are summed per (from, to, token) and
//! logged as one `mt_transfer` line when the batch finishes.

use std::cell::RefCell;

use near_sdk::json_types::U128;
use near_sdk::{env, AccountId};

use crate::errors::{add, sub};
use crate::events::{MtBurnLog, MtEvent, MtMintLog, MtTransferLog};
use crate::types::{Asset, VerseKey};
use crate::Contract;

impl Contract {
    pub fn verse_balance(&self, account_id: &AccountId, key: &VerseKey) -> u128 {
        self.balances
            .get(&(account_id.clone(), *key))
            .copied()
            .unwrap_or(0)
    }

    pub fn verse_supply(&self, key: &VerseKey) -> u128 {
        self.supply.get(key).copied().unwrap_or(0)
    }

    pub fn is_created(&self, key: &VerseKey) -> bool {
        self.created.contains(key)
    }

    pub fn real_balance(&self, account_id: &AccountId, asset: Asset) -> u128 {
        self.real
            .get(&(account_id.clone(), asset))
            .copied()
            .unwrap_or(0)
    }

    pub(crate) fn mark_created(&mut self, key: &VerseKey) {
        if !self.created.contains(key) {
            self.created.insert(*key);
        }
    }

    fn set_verse_balance(&mut self, account_id: &AccountId, key: &VerseKey, value: u128) {
        let k = (account_id.clone(), *key);
        if value == 0 {
            self.balances.remove(&k);
        } else {
            self.balances.insert(k, value);
        }
    }

    fn add_supply(&mut self, key: &VerseKey, amount: u128) {
        let supply = add(self.verse_supply(key), amount);
        self.supply.insert(*key, supply);
    }

    fn sub_supply(&mut self, key: &VerseKey, amount: u128) {
        let supply = sub(self.verse_supply(key), amount);
        if supply == 0 {
            self.supply.remove(key);
        } else {
            self.supply.insert(*key, supply);
        }
    }

    /// A short balance fails `InsufficientBalance(owner, balance, amount)`.
    fn debit_verse(&mut self, owner: &AccountId, key: &VerseKey, amount: u128) {
        let balance = self.verse_balance(owner, key);
        if balance < amount {
            fail!("InsufficientBalance({owner}, {balance}, {amount})");
        }
        self.set_verse_balance(owner, key, balance - amount);
    }

    fn credit_verse(&mut self, owner: &AccountId, key: &VerseKey, amount: u128) {
        let balance = add(self.verse_balance(owner, key), amount);
        self.set_verse_balance(owner, key, balance);
    }

    /// Mints every `(key, amount)` to `owner`, with one `mt_mint` log.
    pub(crate) fn mint(
        &mut self,
        owner: &AccountId,
        items: &[(VerseKey, u128)],
        memo: Option<&str>,
    ) {
        for (key, amount) in items {
            self.mark_created(key);
            self.credit_verse(owner, key, *amount);
            self.add_supply(key, *amount);
        }
        log_mint(owner, items, memo);
    }

    /// Burns from `owner`, in order. A key that was never minted is
    /// `InvalidMask(mask)` ("nobody can hold it"); a short balance is
    /// `InsufficientBalance(owner, balance, needed)`.
    pub(crate) fn burn(
        &mut self,
        owner: &AccountId,
        items: &[(VerseKey, u128)],
        memo: Option<&str>,
    ) {
        for (key, amount) in items {
            if !self.is_created(key) {
                fail!("InvalidMask({})", key.mask);
            }
            self.debit_verse(owner, key, *amount);
            self.sub_supply(key, *amount);
        }
        log_burn(owner, items, memo);
    }

    /// Moves verse tokens between accounts, with one `mt_transfer` log.
    pub(crate) fn transfer_verse(
        &mut self,
        from: &AccountId,
        to: &AccountId,
        items: &[(VerseKey, u128)],
        memo: Option<&str>,
    ) {
        for (key, amount) in items {
            self.debit_verse(from, key, *amount);
            self.credit_verse(to, key, *amount);
        }
        log_transfer(from, to, items, memo);
    }

    // The custody helpers below are for the pools, order book, lending and
    // Root LP; they are `pub` so the crate builds without them in use yet.

    /// Takes tokens from `owner` into a module's own record. The caller adds
    /// them to that record; supply is unchanged.
    pub fn take_into_custody(
        &mut self,
        owner: &AccountId,
        items: &[(VerseKey, u128)],
        memo: Option<&str>,
    ) {
        for (key, amount) in items {
            self.debit_verse(owner, key, *amount);
        }
        log_transfer(owner, &env::current_account_id(), items, memo);
    }

    /// Gives tokens out of a module's record (the caller has already taken
    /// them off it) back to `to`.
    pub fn release_from_custody(
        &mut self,
        to: &AccountId,
        items: &[(VerseKey, u128)],
        memo: Option<&str>,
    ) {
        for (key, amount) in items {
            self.credit_verse(to, key, *amount);
        }
        log_transfer(&env::current_account_id(), to, items, memo);
    }

    /// Mints straight into a module's record (e.g. a pool's side of a split).
    pub fn mint_into_custody(&mut self, items: &[(VerseKey, u128)], memo: Option<&str>) {
        for (key, amount) in items {
            self.mark_created(key);
            self.add_supply(key, *amount);
        }
        log_mint(&env::current_account_id(), items, memo);
    }

    /// Burns tokens a module holds (the caller has taken them off its record).
    pub fn burn_from_custody(&mut self, items: &[(VerseKey, u128)], memo: Option<&str>) {
        for (key, amount) in items {
            if !self.is_created(key) {
                fail!("InvalidMask({})", key.mask);
            }
            self.sub_supply(key, *amount);
        }
        log_burn(&env::current_account_id(), items, memo);
    }

    /// The only writer of internal real balances: v1 data is folded first,
    /// then the books follow the change.
    fn set_real(&mut self, account_id: &AccountId, asset: Asset, value: u128) {
        self.upgrade_account(account_id);
        let old = self.real_balance(account_id, asset);
        self.books_on_real(account_id, asset, old, value);
        let k = (account_id.clone(), asset);
        if value == 0 {
            self.real.remove(&k);
        } else {
            self.real.insert(k, value);
        }
    }

    pub(crate) fn real_credit(&mut self, account_id: &AccountId, asset: Asset, amount: u128) {
        if amount > 0 {
            let balance = add(self.real_balance(account_id, asset), amount);
            self.set_real(account_id, asset, balance);
        }
    }

    /// Short balances fail `InsufficientBalance(account, balance, amount)`.
    pub(crate) fn real_debit(&mut self, account_id: &AccountId, asset: Asset, amount: u128) {
        let balance = self.real_balance(account_id, asset);
        if balance < amount {
            fail!("InsufficientBalance({account_id}, {balance}, {amount})");
        }
        self.set_real(account_id, asset, balance - amount);
    }
}

fn ids_and_amounts(items: &[(VerseKey, u128)]) -> (Vec<String>, Vec<U128>) {
    items.iter().map(|(k, a)| (k.token_id(), U128(*a))).unzip()
}

fn log_mint(owner: &AccountId, items: &[(VerseKey, u128)], memo: Option<&str>) {
    if items.is_empty() {
        return;
    }
    let (token_ids, amounts) = ids_and_amounts(items);
    MtEvent::MtMint(&[MtMintLog {
        owner_id: owner,
        token_ids: &token_ids,
        amounts: &amounts,
        memo,
    }])
    .emit();
}

fn log_burn(owner: &AccountId, items: &[(VerseKey, u128)], memo: Option<&str>) {
    if items.is_empty() {
        return;
    }
    let (token_ids, amounts) = ids_and_amounts(items);
    MtEvent::MtBurn(&[MtBurnLog {
        owner_id: owner,
        authorized_id: None,
        token_ids: &token_ids,
        amounts: &amounts,
        memo,
    }])
    .emit();
}

fn log_transfer(from: &AccountId, to: &AccountId, items: &[(VerseKey, u128)], memo: Option<&str>) {
    if items.is_empty() || (memo.is_none() && TransferBatch::absorb(from, to, items)) {
        return;
    }
    let (token_ids, amounts) = ids_and_amounts(items);
    MtEvent::MtTransfer(&[MtTransferLog {
        authorized_id: None,
        old_owner_id: from,
        new_owner_id: to,
        token_ids: &token_ids,
        amounts: &amounts,
        memo,
    }])
    .emit();
}

type PendingTransfer = (AccountId, AccountId, Vec<(VerseKey, u128)>);

thread_local! {
    static BATCH: RefCell<Option<Vec<PendingTransfer>>> = const { RefCell::new(None) };
}

/// Collects the NEP-245 transfers logged while it lives. `finish` logs them
/// as one line; dropping it unfinished (a failed call) discards them.
pub(crate) struct TransferBatch(());

impl TransferBatch {
    pub(crate) fn start() -> Self {
        BATCH.with(|b| *b.borrow_mut() = Some(Vec::new()));
        TransferBatch(())
    }

    pub(crate) fn finish(self) {
        let entries = BATCH.with(|b| b.borrow_mut().take()).unwrap_or_default();
        if entries.is_empty() {
            return;
        }
        let ids: Vec<(Vec<String>, Vec<U128>)> = entries
            .iter()
            .map(|(_, _, items)| ids_and_amounts(items))
            .collect();
        let logs: Vec<MtTransferLog> = entries
            .iter()
            .zip(&ids)
            .map(|((from, to, _), (token_ids, amounts))| MtTransferLog {
                authorized_id: None,
                old_owner_id: from,
                new_owner_id: to,
                token_ids,
                amounts,
                memo: None,
            })
            .collect();
        MtEvent::MtTransfer(&logs).emit();
    }

    /// Adds the transfer to an open batch; false when there is none.
    fn absorb(from: &AccountId, to: &AccountId, items: &[(VerseKey, u128)]) -> bool {
        BATCH.with(|b| {
            let mut batch = b.borrow_mut();
            let Some(entries) = batch.as_mut() else {
                return false;
            };
            let i = match entries.iter().position(|(f, t, _)| f == from && t == to) {
                Some(i) => i,
                None => {
                    entries.push((from.clone(), to.clone(), Vec::new()));
                    entries.len() - 1
                }
            };
            let moved = &mut entries[i].2;
            for (key, amount) in items {
                match moved.iter_mut().find(|(k, _)| k == key) {
                    Some((_, total)) => *total = add(*total, *amount),
                    None => moved.push((*key, *amount)),
                }
            }
            true
        })
    }
}

impl Drop for TransferBatch {
    fn drop(&mut self) {
        BATCH.with(|b| *b.borrow_mut() = None);
    }
}
