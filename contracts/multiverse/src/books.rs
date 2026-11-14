//! The books: running totals of what the contract owes, per bucket, for the
//! buckets that cannot be enumerated on chain (internal real balances, real
//! collateral, pledges) and for the NEAR it holds for others, plus the two
//! views that put them together with the enumerable buckets.
//!
//! The totals move only in funnels: `set_real` and `set_real_in_callback`
//! (internal balances), `set_pieces` (real collateral), the pledge escrow
//! funnel, the NEP-145 StorageAccount funnel and the proposal NEAR funnel. A
//! v1 account's data is folded in once, by `upgrade_account`, before any
//! funnel touches it, so nothing is counted twice.
//!
//! The totals are a monitoring identity, never a gate: they saturate instead
//! of failing, so a drift shows up in the off-chain check (`Σ pages.total ==
//! ft_balance_of × factor`) and never blocks a user's action.

use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId};

use crate::lending::tiers::{MarketId, Tier};
use crate::lending::CollateralKey;
use crate::storage::StorageAccount;
use crate::types::Asset;
use crate::{Contract, ContractExt};

/// Rows a `books` page covers when the caller names no limit.
pub const BOOKS_DEFAULT_LIMIT: u32 = 50;
/// The most rows of one `books` page.
pub const BOOKS_MAX_LIMIT: u32 = 100;

/// Running totals of the books buckets that cannot be enumerated; index 0 =
/// wNEAR, 1 = USDC. NEAR part (M-13): nep145_deposit / nep145_used_bytes = Σ
/// over folded StorageAccount records; near_held = Σ live proposals' (bond +
/// reserve), yocto. 136 bytes.
#[near(serializers = [borsh])]
#[derive(Clone, Default, Debug, PartialEq, Eq)]
pub struct Books {
    pub internal: [u128; 2],
    pub collateral: [u128; 2],
    pub pledges: [u128; 2],
    pub nep145_deposit: u128,
    pub nep145_used_bytes: u64,
    pub near_held: u128,
}

/// The books index of an asset.
pub const fn asset_index(asset: Asset) -> usize {
    match asset {
        Asset::Wnear => 0,
        Asset::Usdc => 1,
    }
}

/// One asset's buckets on one `books` page, internal units.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BooksAssetView {
    /// Σ scenario reserves of the page's scenarios.
    pub reserves: U128,
    /// Σ (TSA + insurance − TBA) over the page's scenarios × 3 tiers; wNEAR
    /// is never lent, so always "0" there.
    pub lending_cash: U128,
    /// The insurance part of `lending_cash`, for information (not added again).
    pub insurance: U128,
    /// Internal real balances (first page only).
    pub internal: U128,
    /// Real collateral pieces (first page only).
    pub collateral: U128,
    /// The spot pool's reserves and fees (first page only).
    pub spot_pool: U128,
    /// Pledge escrow (first page only).
    pub pledges: U128,
    /// reserves + lending_cash + internal + collateral + spot_pool + pledges.
    pub total: U128,
}

/// `books(from_scenario, limit)`: the scenario rows from `from_scenario` on,
/// with the global buckets on the first page only. Block-pin the calls and
/// sum `total` over the pages: it equals the token balance times the
/// internal-unit factor, plus whatever was sent with plain `ft_transfer`s.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BooksView {
    pub from_scenario: u64,
    pub next_scenario: Option<u64>,
    pub wnear: BooksAssetView,
    pub usdc: BooksAssetView,
}

/// `near_books()`, yocto. `own_free` (signed decimal) is the contract's own
/// NEAR beyond the storage stake and what it holds for others; M-13 holds
/// iff it is ≥ 0.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NearBooksView {
    pub balance: U128,
    pub storage_stake: U128,
    pub nep145_available: U128,
    pub near_held: U128,
    pub storage_fund: U128,
    pub own_free: String,
}

/// `total` with a balance going from `old` to `new`.
fn moved(total: u128, old: u128, new: u128) -> u128 {
    if new >= old {
        total.saturating_add(new - old)
    } else {
        total.saturating_sub(old - new)
    }
}

fn moved_u64(total: u64, old: u64, new: u64) -> u64 {
    if new >= old {
        total.saturating_add(new - old)
    } else {
        total.saturating_sub(old - new)
    }
}

/// The real wNEAR and USDC of a piece list.
pub(crate) fn real_amounts(pieces: &[(CollateralKey, u128)]) -> [u128; 2] {
    let mut held = [0u128; 2];
    for (piece, amount) in pieces {
        if let CollateralKey::Real(asset) = piece {
            let i = asset_index(*asset);
            held[i] = held[i].saturating_add(*amount);
        }
    }
    held
}

/// `(deposit, used bytes)` of a NEP-145 record, zeros for none.
fn nep145_parts(record: Option<&StorageAccount>) -> (u128, u64) {
    record.map_or((0, 0), |r| (r.deposit.as_yoctonear(), r.used_bytes))
}

#[near]
impl Contract {
    /// The books per bucket. `limit` defaults to 50 and is clamped to
    /// 1..=100 scenarios; `from_scenario` defaults to 1. The global buckets
    /// (internal, collateral, spot pool, pledges) come only on the first page.
    pub fn books(&self, from_scenario: Option<u64>, limit: Option<u32>) -> BooksView {
        let from = from_scenario.unwrap_or(1).max(1);
        let limit = u64::from(
            limit
                .unwrap_or(BOOKS_DEFAULT_LIMIT)
                .clamp(1, BOOKS_MAX_LIMIT),
        );
        let end = from.saturating_add(limit);
        let next_scenario = (end <= self.scenario_count).then_some(end);
        let mut reserves = [0u128; 2];
        let (mut lending_cash, mut insurance) = (0u128, 0u128);
        for sid in from..end.min(self.scenario_count.saturating_add(1)) {
            for asset in Asset::ALL {
                let i = asset_index(asset);
                reserves[i] = reserves[i].saturating_add(self.reserve(sid, asset));
            }
            for tier in Tier::ALL {
                let key = MarketId::new(sid, Some(tier)).key();
                let (tsa, tba) = self
                    .markets
                    .get(&key)
                    .map_or((0, 0), |m| (m.total_supply_assets, m.total_borrow_assets));
                let ins = self.tier_states.get(&key).map_or(0, |s| s.insurance);
                lending_cash =
                    lending_cash.saturating_add(tsa.saturating_add(ins).saturating_sub(tba));
                insurance = insurance.saturating_add(ins);
            }
        }
        let first = from == 1;
        let spot = if first {
            self.spot_pool_holdings()
        } else {
            [0, 0]
        };
        let global = |bucket: &[u128; 2], i: usize| if first { bucket[i] } else { 0 };
        let asset_view = |i: usize, cash: u128, ins: u128| {
            let parts = [
                reserves[i],
                cash,
                global(&self.books.internal, i),
                global(&self.books.collateral, i),
                spot[i],
                global(&self.books.pledges, i),
            ];
            BooksAssetView {
                reserves: U128(parts[0]),
                lending_cash: U128(parts[1]),
                insurance: U128(ins),
                internal: U128(parts[2]),
                collateral: U128(parts[3]),
                spot_pool: U128(parts[4]),
                pledges: U128(parts[5]),
                total: U128(parts.iter().fold(0u128, |t, x| t.saturating_add(*x))),
            }
        };
        BooksView {
            from_scenario: from,
            next_scenario,
            wnear: asset_view(0, 0, 0),
            usdc: asset_view(1, lending_cash, insurance),
        }
    }

    /// The contract's NEAR, O(1): balance, the stake its storage locks, the
    /// NEP-145 deposits users can withdraw, the bonds and reserves of live
    /// proposals, the storage fund, and what is left of its own.
    pub fn near_books(&self) -> NearBooksView {
        let byte_cost = env::storage_byte_cost().as_yoctonear();
        let balance = env::account_balance().as_yoctonear();
        let storage_stake = byte_cost.saturating_mul(u128::from(env::storage_usage()));
        let nep145_available = self
            .books
            .nep145_deposit
            .saturating_sub(byte_cost.saturating_mul(u128::from(self.books.nep145_used_bytes)));
        let near_held = self.books.near_held;
        let storage_fund = self.catalog.storage_fund;
        let signed = |x: u128| i128::try_from(x).unwrap_or(i128::MAX);
        let own_free = signed(balance)
            .saturating_sub(signed(storage_stake))
            .saturating_sub(signed(nep145_available))
            .saturating_sub(signed(near_held))
            .saturating_sub(signed(storage_fund));
        NearBooksView {
            balance: U128(balance),
            storage_stake: U128(storage_stake),
            nep145_available: U128(nep145_available),
            near_held: U128(near_held),
            storage_fund: U128(storage_fund),
            own_free: own_free.to_string(),
        }
    }
}

impl Contract {
    /// Funnel of every internal real balance write: `account`'s balance of
    /// `asset` goes from `old` to `new`. Called by `set_real` and
    /// `set_real_in_callback` after `upgrade_account`.
    pub(crate) fn books_on_real(
        &mut self,
        _account: &AccountId,
        asset: Asset,
        old: u128,
        new: u128,
    ) {
        let i = asset_index(asset);
        self.books.internal[i] = moved(self.books.internal[i], old, new);
    }

    /// Funnel of every collateral write: the real pieces of
    /// `collateral[(market key, account)]` hold `old` before and `new` after,
    /// per asset (index 0 wNEAR, 1 USDC). Called by `set_pieces` after
    /// `upgrade_account`.
    pub(crate) fn books_on_collateral(
        &mut self,
        _account: &AccountId,
        old: [u128; 2],
        new: [u128; 2],
    ) {
        for i in 0..2 {
            self.books.collateral[i] = moved(self.books.collateral[i], old[i], new[i]);
        }
    }

    /// Funnel of every NEP-145 record write: the record goes from `old` to
    /// `new` (`None` = no record). Called by the StorageAccount funnel after
    /// `upgrade_account`.
    pub(crate) fn books_on_storage(
        &mut self,
        old: Option<&StorageAccount>,
        new: Option<&StorageAccount>,
    ) {
        let (old_deposit, old_used) = nep145_parts(old);
        let (new_deposit, new_used) = nep145_parts(new);
        self.books.nep145_deposit = moved(self.books.nep145_deposit, old_deposit, new_deposit);
        self.books.nep145_used_bytes = moved_u64(self.books.nep145_used_bytes, old_used, new_used);
    }

    /// Folds `account`'s v1 data into the totals: its internal real balances,
    /// the real pieces of its legacy collateral (scenarios
    /// 1..=`legacy_scenario_count`, whose v1 key is the Normal market key) and
    /// its v1 StorageAccount. Runs once per account, from `upgrade_account`.
    pub(crate) fn books_upgrade_account(&mut self, account: &AccountId) {
        for asset in Asset::ALL {
            let i = asset_index(asset);
            let held = self.real_balance(account, asset);
            self.books.internal[i] = self.books.internal[i].saturating_add(held);
        }
        for sid in 1..=self.legacy_scenario_count {
            let key = MarketId::new(sid, None).key();
            let Some(pieces) = self.collateral.get(&(key, account.clone())) else {
                continue;
            };
            let real = real_amounts(pieces);
            for (i, amount) in real.into_iter().enumerate() {
                self.books.collateral[i] = self.books.collateral[i].saturating_add(amount);
            }
        }
        let (deposit, used) = nep145_parts(self.storage.get(account));
        self.books.nep145_deposit = self.books.nep145_deposit.saturating_add(deposit);
        self.books.nep145_used_bytes = self.books.nep145_used_bytes.saturating_add(used);
    }

    /// The spot pool's real wNEAR and USDC: curve reserves plus fees not yet
    /// collected.
    fn spot_pool_holdings(&self) -> [u128; 2] {
        let Some(pool) = self.spot_pool.and_then(|id| self.pools.get(&id)) else {
            return [0, 0];
        };
        let (r0, r1) = pool.amm.reserves();
        let (f0, f1) = pool.amm.fees();
        [r0.saturating_add(f0), r1.saturating_add(f1)]
    }
}
