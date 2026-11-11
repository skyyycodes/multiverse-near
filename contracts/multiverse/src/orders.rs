//! Order book: bids and asks per world, escrow, epochs, expiry and halts.
//! Not built yet: the record below only holds its place in
//! the contract state.

use near_sdk::{near, AccountId};

use crate::Contract;

/// Whether the order book is live; served to the app by `get_app_config`.
pub const ENABLED: bool = false;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Bid,
    Ask,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Order {}

impl Contract {
    /// Must be true while `account_id` is the maker of an open order; it
    /// blocks `storage_unregister`.
    pub(crate) fn has_open_orders(&self, _account_id: &AccountId) -> bool {
        false
    }

    /// Verse tokens of `key` held in order escrow, for the conservation check
    /// in the tests.
    #[cfg(test)]
    pub(crate) fn escrow_holdings(&self, _key: &crate::types::VerseKey) -> u128 {
        0
    }
}
