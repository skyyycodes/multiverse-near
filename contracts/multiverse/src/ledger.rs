//! The verse ledger (per-account balances, supply, the created set) and the
//! internal real wNEAR/USDC balances.
//!
//! Every change to a user's verse balance logs the matching NEP-245 event.
//! Tokens a module holds (pool reserves, order escrow, collateral, the Root
//! LP vault) leave `balances` but stay in `supply`; the custody helpers log
//! those moves as transfers to and from the contract's own account, so
//! indexers balance. Zero balances are removed so they stop costing storage.
//!
//! Two counters follow the ledger so that no read has to scan every mask:
//! `world_supply[(scenario, asset)][w]` is the supply of every token paying
//! in world `w` (`add_supply` / `sub_supply` are its only writers), and
//! `created_masks[scenario]` the set of tokens ever created (`mark_created`).
//! Each 0 <-> non-zero balance change is noted in the account's scenario
//! index (`index.rs`).
//!
//! A multi-step call can move tokens dozens of times (every order fill, swap
//! and deposit of a trade), and a receipt may log at most 100 lines and
//! 16 KiB, so such calls open a `LogScope`. While it is open, the NEP-245
//! items are summed (mints and burns per owner and token, transfers netted
//! per account and token against the contract's custody) and the
//! `multiverse` events are held by name; the scope that opened first writes
//! them out when it ends, in a fixed order:
//!
//! 1. one `mt_mint` line, one entry per owner;
//! 2. one `mt_transfer` line: every `account -> contract` entry, then every
//!    `contract -> account` entry, one per account and direction;
//! 3. one `mt_burn` line, one entry per owner;
//! 4. one `multiverse` line per event name in first-emission order, every
//!    item in its `data`; order fills become one `orders_filled` line with
//!    one item per (scenario, taker).
//!
//! Replaying the lines in that order reproduces every balance and supply
//! change of the call and never takes a balance below zero. Items with a memo
//! (`mt_resolve_transfer`'s refunds) are never absorbed.

use std::cell::RefCell;

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, serde_json, AccountId};

use crate::errors::{add, sub};
use crate::events::{
    self, MtBurnLog, MtEvent, MtMintLog, MtTransferLog, MultiverseEvent, OrdersFilled,
};
use crate::masks;
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

    /// The only writer of `created`: a new key also goes into its scenario's
    /// `created_masks`.
    pub(crate) fn mark_created(&mut self, key: &VerseKey) {
        if !self.created.contains(key) {
            self.created.insert(*key);
            let mut set = self
                .created_masks
                .get(&key.scenario)
                .copied()
                .unwrap_or_default();
            set.set(key.asset, key.mask, true);
            self.created_masks.insert(key.scenario, set);
        }
    }

    /// The only writer of `balances`; `old` is the balance it replaces.
    fn set_verse_balance(
        &mut self,
        account_id: &AccountId,
        key: &VerseKey,
        old: u128,
        value: u128,
    ) {
        let k = (account_id.clone(), *key);
        if value == 0 {
            self.balances.remove(&k);
        } else {
            self.balances.insert(k, value);
        }
        if (old == 0) != (value == 0) {
            self.note(account_id, key.scenario, |r| {
                r.verse.set(key.asset, key.mask, value > 0)
            });
        }
    }

    fn add_supply(&mut self, key: &VerseKey, amount: u128) {
        let supply = add(self.verse_supply(key), amount);
        self.supply.insert(*key, supply);
        self.bump_world_supply(key, amount, true);
    }

    fn sub_supply(&mut self, key: &VerseKey, amount: u128) {
        let supply = sub(self.verse_supply(key), amount);
        if supply == 0 {
            self.supply.remove(key);
        } else {
            self.supply.insert(*key, supply);
        }
        self.bump_world_supply(key, amount, false);
    }

    /// Moves `amount` up or down on every world of `key.mask` in the
    /// scenario's per-world supply. An all-zero vector is removed. In a
    /// possible world the counter equals the reserves (invariant 1), so it
    /// always fits; a dead world's counter may sum more than any one token,
    /// so the counters wrap and stay exact modulo 2^128 instead of failing a
    /// valid action.
    fn bump_world_supply(&mut self, key: &VerseKey, amount: u128, up: bool) {
        if amount == 0 {
            return;
        }
        let world_count = self.scenario(key.scenario).world_count;
        let k = (key.scenario, key.asset);
        let mut counts = self
            .world_supply
            .get(&k)
            .cloned()
            .unwrap_or_else(|| vec![0; usize::from(world_count)]);
        for (w, count) in (0u8..).zip(counts.iter_mut()) {
            if masks::contains(key.mask, w) {
                *count = if up {
                    count.wrapping_add(amount)
                } else {
                    count.wrapping_sub(amount)
                };
            }
        }
        if counts.iter().all(|c| *c == 0) {
            self.world_supply.remove(&k);
        } else {
            self.world_supply.insert(k, counts);
        }
    }

    /// The supply of every token paying in each world of the scenario (one
    /// entry per world, zeros before the first mint).
    pub(crate) fn world_supply_of(
        &self,
        scenario_id: u64,
        asset: Asset,
        world_count: u8,
    ) -> Vec<u128> {
        self.world_supply
            .get(&(scenario_id, asset))
            .cloned()
            .unwrap_or_else(|| vec![0; usize::from(world_count)])
    }

    /// A short balance fails `InsufficientBalance(owner, balance, amount)`.
    fn debit_verse(&mut self, owner: &AccountId, key: &VerseKey, amount: u128) {
        let balance = self.verse_balance(owner, key);
        if balance < amount {
            fail!("InsufficientBalance({owner}, {balance}, {amount})");
        }
        self.set_verse_balance(owner, key, balance, balance - amount);
    }

    fn credit_verse(&mut self, owner: &AccountId, key: &VerseKey, amount: u128) {
        let old = self.verse_balance(owner, key);
        self.set_verse_balance(owner, key, old, add(old, amount));
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
    if items.is_empty() || (memo.is_none() && absorb(|p| p.mint(owner, items))) {
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
    if items.is_empty() || (memo.is_none() && absorb(|p| p.burn(owner, items))) {
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
    if items.is_empty() || (memo.is_none() && absorb(|p| p.transfer(from, to, items))) {
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

/// One order fill inside a scope: `(order_id, amount, usdc_amount,
/// remaining)`, as v1's `order_filled` fields.
pub(crate) type Fill = (U64, U128, U128, U128);

/// Per owner, per token, summed; owners and tokens in first-touch order.
type Sums = Vec<(AccountId, Vec<(VerseKey, u128)>)>;

/// An account's net change in one token: at most one side is non-zero.
#[derive(Default)]
struct Net {
    credited: u128,
    debited: u128,
}

impl Net {
    fn credit(&mut self, amount: u128) {
        if self.debited >= amount {
            self.debited -= amount;
        } else {
            self.credited = add(self.credited, amount - self.debited);
            self.debited = 0;
        }
    }

    fn debit(&mut self, amount: u128) {
        if self.credited >= amount {
            self.credited -= amount;
        } else {
            self.debited = add(self.debited, amount - self.credited);
            self.credited = 0;
        }
    }
}

/// What an open scope has absorbed so far.
#[derive(Default)]
struct Pending {
    mints: Sums,
    burns: Sums,
    /// Per account, per token: the net move against the contract's custody.
    net: Vec<(AccountId, Vec<(VerseKey, Net)>)>,
    /// `multiverse` items by event name, names in first-emission order.
    held: Vec<(&'static str, Vec<String>)>,
    /// Fills per (scenario, taker), in first-fill order.
    fills: Vec<(u64, AccountId, Vec<Fill>)>,
}

fn sum_into(sums: &mut Sums, owner: &AccountId, items: &[(VerseKey, u128)]) {
    let i = match sums.iter().position(|(o, _)| o == owner) {
        Some(i) => i,
        None => {
            sums.push((owner.clone(), Vec::new()));
            sums.len() - 1
        }
    };
    let tokens = &mut sums[i].1;
    for (key, amount) in items {
        match tokens.iter_mut().find(|(k, _)| k == key) {
            Some((_, total)) => *total = add(*total, *amount),
            None => tokens.push((*key, *amount)),
        }
    }
}

impl Pending {
    fn mint(&mut self, owner: &AccountId, items: &[(VerseKey, u128)]) {
        sum_into(&mut self.mints, owner, items);
    }

    fn burn(&mut self, owner: &AccountId, items: &[(VerseKey, u128)]) {
        sum_into(&mut self.burns, owner, items);
    }

    /// `from -> to` becomes a debit of `from` and a credit of `to`; the
    /// contract's own side is its custody, which the entries imply.
    fn transfer(&mut self, from: &AccountId, to: &AccountId, items: &[(VerseKey, u128)]) {
        let contract = env::current_account_id();
        for (key, amount) in items {
            if *from != contract {
                self.net_of(from, key).debit(*amount);
            }
            if *to != contract {
                self.net_of(to, key).credit(*amount);
            }
        }
    }

    fn net_of(&mut self, account: &AccountId, key: &VerseKey) -> &mut Net {
        let i = match self.net.iter().position(|(a, _)| a == account) {
            Some(i) => i,
            None => {
                self.net.push((account.clone(), Vec::new()));
                self.net.len() - 1
            }
        };
        let tokens = &mut self.net[i].1;
        let j = match tokens.iter().position(|(k, _)| k == key) {
            Some(j) => j,
            None => {
                tokens.push((*key, Net::default()));
                tokens.len() - 1
            }
        };
        &mut tokens[j].1
    }

    fn hold(&mut self, name: &'static str, item: String) {
        match self.held.iter_mut().find(|(n, _)| *n == name) {
            Some((_, items)) => items.push(item),
            None => self.held.push((name, vec![item])),
        }
    }

    fn add_fill(&mut self, scenario_id: u64, taker: &AccountId, fill: Fill) {
        if !self.held.iter().any(|(n, _)| *n == OrdersFilled::NAME) {
            // keeps the line's place among the held names
            self.held.push((OrdersFilled::NAME, Vec::new()));
        }
        match self
            .fills
            .iter_mut()
            .find(|(s, t, _)| *s == scenario_id && t == taker)
        {
            Some((_, _, fills)) => fills.push(fill),
            None => self.fills.push((scenario_id, taker.clone(), vec![fill])),
        }
    }

    /// Writes the lines out, in the module doc's order.
    fn flush(self) {
        let contract = env::current_account_id();
        if !self.mints.is_empty() {
            let ids: Vec<_> = self.mints.iter().map(|(_, t)| ids_and_amounts(t)).collect();
            let logs: Vec<MtMintLog> = self
                .mints
                .iter()
                .zip(&ids)
                .map(|((owner, _), (token_ids, amounts))| MtMintLog {
                    owner_id: owner,
                    token_ids,
                    amounts,
                    memo: None,
                })
                .collect();
            MtEvent::MtMint(&logs).emit();
        }

        let side = |out: bool| -> Vec<(&AccountId, Vec<(VerseKey, u128)>)> {
            self.net
                .iter()
                .map(|(account, tokens)| {
                    let moved = tokens
                        .iter()
                        .map(|(k, n)| (*k, if out { n.debited } else { n.credited }))
                        .filter(|(_, a)| *a > 0)
                        .collect::<Vec<_>>();
                    (account, moved)
                })
                .filter(|(_, moved)| !moved.is_empty())
                .collect()
        };
        let (outs, ins) = (side(true), side(false));
        if !outs.is_empty() || !ins.is_empty() {
            // (from, to, token ids and amounts): every out, then every in
            type Entry<'e> = (&'e AccountId, &'e AccountId, (Vec<String>, Vec<U128>));
            let entries: Vec<Entry> = outs
                .iter()
                .map(|(a, t)| (*a, &contract, ids_and_amounts(t)))
                .chain(ins.iter().map(|(a, t)| (&contract, *a, ids_and_amounts(t))))
                .collect();
            let logs: Vec<MtTransferLog> = entries
                .iter()
                .map(|(from, to, (token_ids, amounts))| MtTransferLog {
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

        if !self.burns.is_empty() {
            let ids: Vec<_> = self.burns.iter().map(|(_, t)| ids_and_amounts(t)).collect();
            let logs: Vec<MtBurnLog> = self
                .burns
                .iter()
                .zip(&ids)
                .map(|((owner, _), (token_ids, amounts))| MtBurnLog {
                    owner_id: owner,
                    authorized_id: None,
                    token_ids,
                    amounts,
                    memo: None,
                })
                .collect();
            MtEvent::MtBurn(&logs).emit();
        }

        for (name, items) in &self.held {
            if *name == OrdersFilled::NAME {
                let items: Vec<String> = self
                    .fills
                    .iter()
                    .map(|(scenario_id, taker, fills)| {
                        let item = OrdersFilled {
                            scenario_id: *scenario_id,
                            taker,
                            fills,
                        };
                        serde_json::to_string(&item).unwrap_or_else(|_| env::abort())
                    })
                    .collect();
                env::log_str(&events::line(name, &items));
            } else {
                env::log_str(&events::line(name, items));
            }
        }
    }
}

thread_local! {
    static SCOPE: RefCell<Option<Pending>> = const { RefCell::new(None) };
}

/// Runs `f` on the open scope; false when there is none.
fn absorb(f: impl FnOnce(&mut Pending)) -> bool {
    SCOPE.with(|s| match s.borrow_mut().as_mut() {
        Some(p) => {
            f(p);
            true
        }
        None => false,
    })
}

/// Groups the logs of one call (see the module doc). `open` starts a scope,
/// or joins the one already open; only the scope that started it writes the
/// lines, when it is dropped, so an early return never loses them. On a
/// failed call nothing is written: in the contract a panic aborts and the
/// receipt's logs are discarded anyway, and natively (tests) the pending
/// lines are dropped while unwinding.
pub(crate) struct LogScope {
    owner: bool,
}

impl LogScope {
    pub(crate) fn open() -> LogScope {
        SCOPE.with(|s| {
            let mut s = s.borrow_mut();
            if s.is_some() {
                LogScope { owner: false }
            } else {
                *s = Some(Pending::default());
                LogScope { owner: true }
            }
        })
    }

    pub(crate) fn is_open() -> bool {
        SCOPE.with(|s| s.borrow().is_some())
    }

    /// Holds a serialized `multiverse` item for the `name` line. Without an
    /// open scope it does nothing; `MultiverseEvent::emit` checks first.
    pub(crate) fn hold(name: &'static str, item: String) {
        absorb(|p| p.hold(name, item));
    }

    /// Adds an order fill to the `orders_filled` line. Without an open scope
    /// it does nothing; `fill_order_for` checks first.
    pub(crate) fn add_fill(scenario_id: u64, taker: &AccountId, fill: Fill) {
        absorb(|p| p.add_fill(scenario_id, taker, fill));
    }
}

impl Drop for LogScope {
    fn drop(&mut self) {
        if !self.owner {
            return;
        }
        let pending = SCOPE.with(|s| s.borrow_mut().take());
        if let Some(p) = pending {
            if !std::thread::panicking() {
                p.flush();
            }
        }
    }
}
