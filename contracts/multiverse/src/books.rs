//! The books: running totals of what the contract owes, per bucket, for the
//! buckets that cannot be enumerated on chain (internal real balances, real
//! collateral, pledges) and for the NEAR it holds for others.
//!
//! The totals move only in funnels: `set_real` (internal balances),
//! `set_pieces` (real collateral), the pledge escrow funnel, the NEP-145
//! StorageAccount funnel and the proposal NEAR funnel. A v1 account's data is
//! folded in once, by `upgrade_account`, before any funnel touches it.

use near_sdk::{near, AccountId};

use crate::types::Asset;
use crate::Contract;

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

impl Contract {
    /// Funnel of every internal real balance write: `account`'s balance of
    /// `asset` goes from `old` to `new`. Called by `set_real` after
    /// `upgrade_account`.
    pub(crate) fn books_on_real(
        &mut self,
        _account: &AccountId,
        _asset: Asset,
        _old: u128,
        _new: u128,
    ) {
    }

    /// Funnel of every collateral write: the real pieces of
    /// `collateral[(market key, account)]` hold `old` before and `new` after,
    /// per asset (index 0 wNEAR, 1 USDC). Called by `set_pieces` after
    /// `upgrade_account`.
    pub(crate) fn books_on_collateral(
        &mut self,
        _account: &AccountId,
        _old: [u128; 2],
        _new: [u128; 2],
    ) {
    }

    /// Folds `account`'s v1 data into the totals: its internal real balances,
    /// the real pieces of its legacy collateral and its v1 StorageAccount.
    /// Runs once per account, from `upgrade_account`.
    pub(crate) fn books_upgrade_account(&mut self, _account: &AccountId) {}
}
