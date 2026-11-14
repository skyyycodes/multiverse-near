//! The per-account index of scenarios created after the upgrade: what one
//! account holds in one scenario (`account_scenarios`) and the list of those
//! scenarios (`footprints`), so `storage_unregister` and the NEP-245
//! enumeration never scan every key. Scenarios up to `legacy_scenario_count`
//! are never indexed; a fixed legacy scan covers them (`storage.rs`).
//!
//! One write helper per map keeps the index in step, calling `note` on every
//! 0 <-> non-zero transition: `set_verse_balance` (`ledger.rs`),
//! `put_position` (`amm/liquidity.rs`), `set_shares` (`rootlp.rs`) and the
//! lending writers through `note_lending`.

use near_sdk::{env, near, AccountId};

use crate::lending::tiers::TIER_SHIFT;
use crate::types::{Asset, VerseKey};
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

    /// Every member, wNEAR first, masks ascending: the (asset, mask) order of
    /// token ids.
    pub fn iter(&self) -> impl Iterator<Item = (Asset, u8)> + '_ {
        (0..self.bits.len()).flat_map(move |word| {
            let mut left = self.bits[word];
            std::iter::from_fn(move || {
                if left == 0 {
                    return None;
                }
                let bit = word * 64 + left.trailing_zeros() as usize;
                left &= left - 1;
                let asset = if bit < 256 { Asset::Wnear } else { Asset::Usdc };
                Some((asset, (bit % 256) as u8))
            })
        })
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

/// One more or one fewer of a counted entry.
pub(crate) fn step(count: u8, up: bool) -> u8 {
    if up {
        count.saturating_add(1)
    } else {
        count.saturating_sub(1)
    }
}

impl Contract {
    /// Applies `f` to `a`'s record of scenario `sid`, creating it and its
    /// footprint entry, or removing both once empty; nothing is written when
    /// `f` changes nothing. A no-op for the spot pool (`sid == 0`), for legacy
    /// scenarios and for the contract's own custody. Every write helper of
    /// `balances`, `positions`, `lp_shares` and the lending maps calls it on
    /// a 0 <-> non-zero transition.
    pub(crate) fn note(&mut self, a: &AccountId, sid: u64, f: impl FnOnce(&mut AccountScenario)) {
        if sid == 0 || sid <= self.legacy_scenario_count || *a == env::current_account_id() {
            return;
        }
        let k = (a.clone(), sid);
        let old = self.account_scenarios.get(&k).cloned();
        let mut record = old.clone().unwrap_or_default();
        f(&mut record);
        if old.as_ref() == Some(&record) {
            return;
        }
        match (old.is_some(), record.is_empty()) {
            (true, true) => {
                self.account_scenarios.remove(&k);
                self.footprint_remove(a, sid);
            }
            (_, false) => {
                self.account_scenarios.insert(k, record);
                if old.is_none() {
                    self.footprint_add(a, sid);
                }
            }
            (false, true) => {}
        }
    }

    /// A lending entry of `account` in the market with this key (any tier)
    /// appeared (`now`) or went away; `was` is whether it existed before the
    /// write. Lending entries are the supply shares, the borrow shares and
    /// the collateral list of one market.
    pub(crate) fn note_lending(
        &mut self,
        account: &AccountId,
        market_key: u64,
        was: bool,
        now: bool,
    ) {
        if was != now {
            let sid = market_key & ((1u64 << TIER_SHIFT) - 1);
            self.note(account, sid, |r| {
                r.lending_entries = step(r.lending_entries, now)
            });
        }
    }

    fn footprint_add(&mut self, a: &AccountId, sid: u64) {
        let footprint = self.footprints.entry(a.clone()).or_default();
        if let Err(i) = footprint.scenarios.binary_search(&sid) {
            footprint.scenarios.insert(i, sid);
        }
    }

    fn footprint_remove(&mut self, a: &AccountId, sid: u64) {
        let Some(footprint) = self.footprints.get_mut(a) else {
            return;
        };
        footprint.scenarios.retain(|s| *s != sid);
        if footprint.scenarios.is_empty() {
            self.footprints.remove(a);
        }
    }

    /// The scenarios after the upgrade where `a` holds anything, ascending.
    pub(crate) fn indexed_scenarios(&self, a: &AccountId) -> Vec<u64> {
        self.footprints
            .get(a)
            .map(|f| f.scenarios.clone())
            .unwrap_or_default()
    }

    /// `a`'s non-zero verse balances in an indexed scenario, as token keys in
    /// (asset, mask) order.
    pub(crate) fn indexed_verse_keys(&self, a: &AccountId, sid: u64) -> Vec<VerseKey> {
        self.account_scenarios
            .get(&(a.clone(), sid))
            .map(|r| {
                r.verse
                    .iter()
                    .map(|(asset, mask)| VerseKey::new(sid, asset, mask))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Migrate step 7: `world_supply` and `created_masks` of every legacy
    /// scenario from `supply` and `created`, then every possible world's
    /// counter checked against the reserves (`BackingMismatch(sid, asset, w)`).
    pub(crate) fn migrate_eight_worlds(&mut self) {}
}
