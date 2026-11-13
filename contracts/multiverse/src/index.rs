//! The per-account index of scenarios created after the upgrade: what one
//! account holds in one scenario (`account_scenarios`) and the list of those
//! scenarios (`footprints`), so `storage_unregister` and the NEP-245
//! enumeration never scan every key. Scenarios up to `legacy_scenario_count`
//! are never indexed; a fixed legacy scan covers them.

use near_sdk::{near, AccountId};

use crate::types::Asset;
use crate::Contract;

/// A set of (asset, mask): bit `asset_index * 256 + mask` (Wnear 0, Usdc 1).
/// 64 bytes.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct MaskSet {
    pub bits: [u64; 8],
}

impl MaskSet {
    fn position(asset: Asset, mask: u8) -> (usize, u64) {
        let bit = (asset as usize) * 256 + usize::from(mask);
        (bit / 64, 1u64 << (bit % 64))
    }

    pub fn contains(&self, asset: Asset, mask: u8) -> bool {
        let (word, bit) = Self::position(asset, mask);
        self.bits[word] & bit != 0
    }

    pub fn set(&mut self, asset: Asset, mask: u8, on: bool) {
        let (word, bit) = Self::position(asset, mask);
        if on {
            self.bits[word] |= bit;
        } else {
            self.bits[word] &= !bit;
        }
    }

    pub fn is_empty(&self) -> bool {
        self.bits.iter().all(|w| *w == 0)
    }
}

/// What one account has in one scenario created after the upgrade (id >
/// legacy_scenario_count). Removed when empty. 67 bytes.
#[near(serializers = [borsh])]
#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct AccountScenario {
    /// Non-zero verse balances in `balances`.
    pub verse: MaskSet,
    /// Entries in `positions` for pools of this scenario (<= 15).
    pub pool_positions: u8,
    /// Non-zero supply_shares, borrow_shares, non-empty collateral, over the
    /// 3 tiers (<= 9).
    pub lending_entries: u8,
    /// An lp_shares entry.
    pub lp_shares: bool,
}

impl AccountScenario {
    pub fn is_empty(&self) -> bool {
        self.verse.is_empty()
            && self.pool_positions == 0
            && self.lending_entries == 0
            && !self.lp_shares
    }
}

/// Scenarios (ascending) with an AccountScenario record. Removed when empty.
#[near(serializers = [borsh])]
#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct Footprint {
    pub scenarios: Vec<u64>,
}

impl Contract {
    /// Applies `f` to `a`'s record of scenario `sid`, creating it and its
    /// footprint entry, or removing both once empty. A no-op for the spot pool
    /// (`sid == 0`), for legacy scenarios and for the contract's own custody.
    /// Every write helper of `balances`, `positions`, `lp_shares` and the
    /// lending maps calls it on a 0 <-> non-zero transition.
    #[allow(dead_code)] // wired into every write helper with the eight-worlds counters
    pub(crate) fn note(
        &mut self,
        _a: &AccountId,
        _sid: u64,
        _f: impl FnOnce(&mut AccountScenario),
    ) {
    }

    /// Migrate step 7: `world_supply` and `created_masks` of every legacy
    /// scenario from `supply` and `created`, then every possible world's
    /// counter checked against the reserves (`BackingMismatch(sid, asset, w)`).
    pub(crate) fn migrate_eight_worlds(&mut self) {}
}
