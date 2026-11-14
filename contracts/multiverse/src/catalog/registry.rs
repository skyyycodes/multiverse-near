//! The registry of markets the app lists, the reference market of each event
//! (which combinations price from) and each event's source and category.

use near_sdk::{assert_one_yocto, env, near};

use super::events::{EventMetaSet, MarketListingSet, ReferenceMarketSet};
use super::{
    Check, EventMeta, EventSetKey, MarketEntry, MarketOrigin, VMarketEntry, VoidReason, CATEGORIES,
    MAX_SOURCE_BYTES,
};
use crate::errors::fail;
use crate::events::MultiverseEvent;
use crate::types::Scenario;
use crate::{Contract, ContractExt};

#[near]
impl Contract {
    /// Owner only; lists or unlists a market. Listing needs a seeded market
    /// (`NotSeeded`) and a free event set (`DuplicateListed(other)`); a live
    /// combination proposal on the same set is voided (`market_exists`), its
    /// bond and reserve returned. Never affects trading, exits, lending or
    /// orders. The deposit (or the owner's storage balance) pays.
    #[payable]
    pub fn set_market_listing(&mut self, scenario_id: u64, listed: bool) {
        self.assert_owner();
        let key = scenario_key(self.scenario(scenario_id));
        if listed {
            self.check_seeded(scenario_id).unwrap_or_else(|e| fail(&e));
            if let Some(other) = self.catalog.listed_by_set.get(&key).copied() {
                if other != scenario_id {
                    fail!("DuplicateListed({other})");
                }
            }
            if let Some(pid) = self.catalog.proposal_by_set.get(&key).copied() {
                self.void_segment(pid, VoidReason::MarketExists);
            }
        }
        self.flush_state();
        let before = env::storage_usage();
        let mut entry = self.market_entry(scenario_id);
        entry.listed = listed;
        self.catalog
            .registry
            .insert(scenario_id, VMarketEntry::V1(entry));
        if listed {
            self.catalog.listed_by_set.insert(key, scenario_id);
        } else if self.catalog.listed_by_set.get(&key) == Some(&scenario_id) {
            self.catalog.listed_by_set.remove(&key);
        }
        MarketListingSet {
            scenario_id,
            listed,
        }
        .emit();
        self.charge_storage_or_deposit(&env::predecessor_account_id(), before);
    }

    /// Owner only, 1 yoctoNEAR: the listed market combinations price `event_id`
    /// from, or none (new combinations with the event then fail
    /// `NoReferenceMarket` and live ones wait).
    #[payable]
    pub fn set_reference_market(&mut self, event_id: u64, scenario_id: Option<u64>) {
        assert_one_yocto();
        self.assert_owner();
        self.event(event_id);
        if let Some(sid) = scenario_id {
            self.check_reference(event_id, sid)
                .unwrap_or_else(|e| fail(&e));
        }
        let owner = env::predecessor_account_id();
        let before = env::storage_usage();
        match scenario_id {
            Some(sid) => self.catalog.reference_market.insert(event_id, sid),
            None => self.catalog.reference_market.remove(&event_id),
        };
        ReferenceMarketSet {
            event_id,
            scenario_id,
        }
        .emit();
        self.charge_storage(&owner, before);
    }

    /// Owner only: an event's public data source (at most 256 bytes) and its
    /// category (below 16). The deposit (or the owner's storage balance) pays.
    #[payable]
    pub fn set_event_meta(&mut self, event_id: u64, source: String, category: u8) {
        self.assert_owner();
        self.event(event_id);
        check_meta(&source, category).unwrap_or_else(|e| fail(&e));
        let before = env::storage_usage();
        self.put_event_meta(event_id, source, category);
        EventMetaSet { event_id, category }.emit();
        self.charge_storage_or_deposit(&env::predecessor_account_id(), before);
    }
}

/// `TextTooLong(source)`, then `BadCategory(c)`.
pub(crate) fn check_meta(source: &str, category: u8) -> Check<()> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err("TextTooLong(source)".to_string());
    }
    if category >= CATEGORIES {
        return Err(format!("BadCategory({category})"));
    }
    Ok(())
}

/// The canonical event set of a scenario.
pub(crate) fn scenario_key(s: &Scenario) -> EventSetKey {
    EventSetKey::of(&s.event_ids)
}

impl Contract {
    /// The market's registry entry; a market without one reads as unlisted,
    /// `legacy` up to `legacy_scenario_count` and `owner` above it.
    pub(crate) fn market_entry(&self, sid: u64) -> MarketEntry {
        match self.catalog.registry.get(&sid) {
            Some(VMarketEntry::V1(e)) => e.clone(),
            None => MarketEntry {
                listed: false,
                origin: if sid <= self.legacy_scenario_count {
                    MarketOrigin::Legacy
                } else {
                    MarketOrigin::Owner
                },
                proposal_id: 0,
                created_at_sec: 0,
            },
        }
    }

    /// Every possible world has a world pool with liquidity and the odds are
    /// known (a fully resolved market passes), else `NotSeeded(sid)`.
    pub(crate) fn check_seeded(&self, sid: u64) -> Check<()> {
        let s = self.scenario(sid);
        if crate::masks::is_single_world(s.possible) {
            return Ok(());
        }
        let pooled = (0..s.world_count)
            .filter(|w| crate::masks::contains(s.possible, *w))
            .all(|w| {
                self.world_pool(sid, w)
                    .and_then(|id| self.pools.get(&id))
                    .is_some_and(|p| !p.amm.is_empty())
            });
        if pooled && self.odds_of(sid).1 {
            Ok(())
        } else {
            Err(format!("NotSeeded({sid})"))
        }
    }

    /// `UnknownScenario`, `NotInScenario(e, sid)`, `NotListed(sid)`.
    pub(crate) fn check_reference(&self, event_id: u64, sid: u64) -> Check<()> {
        let s = self
            .scenarios
            .get(&sid)
            .ok_or_else(|| format!("UnknownScenario({sid})"))?;
        if !s.event_ids.contains(&event_id) {
            return Err(format!("NotInScenario({event_id}, {sid})"));
        }
        if !self.market_entry(sid).listed {
            return Err(format!("NotListed({sid})"));
        }
        Ok(())
    }

    /// Writes an event's source and category, keeping who proposed it.
    pub(crate) fn put_event_meta(&mut self, event_id: u64, source: String, category: u8) {
        let (proposal_id, proposer) = self
            .catalog
            .event_meta
            .get(&event_id)
            .map_or((0, None), |m| (m.proposal_id, m.proposer.clone()));
        self.catalog.event_meta.insert(
            event_id,
            EventMeta {
                proposal_id,
                proposer,
                source,
                category,
            },
        );
    }
}
