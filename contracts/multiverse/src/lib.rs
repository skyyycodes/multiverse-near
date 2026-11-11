//! Multiverse Lending on NEAR.
//!
//! The whole protocol is one contract: the event oracle, the verse ledger
//! (exposed as NEP-245 multi tokens), the pools, the order book, the money
//! markets and the Root LP vault. Living in one account is what makes every
//! multi-step action atomic; only payouts of real tokens leave as promises.
//!
//! Units: every amount inside the contract is 18-decimal fixed point for both
//! assets. Token amounts are scaled at the NEP-141 boundary (`receiver` on the
//! way in, `payout` on the way out).

#[macro_use]
pub mod errors;
pub mod events;
pub mod ledger;
pub mod masks;
pub mod storage;
pub mod types;

use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, AccountId, BorshStorageKey, PanicOnDefault};

use crate::errors::fail;
use crate::events::{DisputeWindowSet, MultiverseEvent};
use crate::storage::StorageAccount;
use crate::types::{Asset, AssetCfg, EventData, Params, Scenario, VerseKey};

/// One prefix per collection. Append new variants at the end: the borsh
/// index of a variant is its storage prefix.
#[near]
#[derive(BorshStorageKey)]
pub(crate) enum StorageKey {
    Events,
    ScenariosOfEvent,
    Scenarios,
    Reserves,
    Balances,
    Supply,
    Created,
    Real,
    Storage,
    /// The owner-set demo record (a JSON string), stored under this key alone.
    DemoRecord,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    // config
    owner_id: AccountId,
    /// The only account `report_outcome` accepts; None accepts nobody.
    reporter_id: Option<AccountId>,
    weth: AssetCfg,
    usdc: AssetCfg,
    params: Params,

    // oracle
    events: LookupMap<u64, EventData>,
    event_count: u64,
    scenarios_of_event: LookupMap<u64, Vec<u64>>,

    // core
    scenarios: LookupMap<u64, Scenario>,
    scenario_count: u64,
    /// Real assets backing each scenario. Moves only on a root split (+),
    /// a merge to root (-) and a redeem (-).
    reserves: LookupMap<(u64, Asset), u128>,

    // ledger: verse tokens held by accounts. Tokens held by pools, order
    // escrow, collateral and the Root LP live in those modules' records.
    balances: LookupMap<(AccountId, VerseKey), u128>,
    /// Changes only on mint and burn.
    supply: LookupMap<VerseKey, u128>,
    /// Keys ever minted or registered; burning an unknown key is `InvalidMask`.
    created: LookupSet<VerseKey>,
    /// Internal real WETH/USDC balances: deposits, failed payouts, dust.
    real: LookupMap<(AccountId, Asset), u128>,

    // NEP-145
    storage: LookupMap<AccountId, StorageAccount>,
}

#[near]
impl Contract {
    /// Deploy and initialise in one transaction signed by the contract
    /// account: near-sdk does not enforce `#[private]` on `#[init]`, and an
    /// open `new` could be raced by anyone.
    #[init]
    pub fn new(
        owner_id: AccountId,
        reporter_id: Option<AccountId>,
        weth: AssetCfg,
        usdc: AssetCfg,
        dispute_window_sec: u64,
    ) -> Self {
        if env::predecessor_account_id() != env::current_account_id() {
            fail("InitNotSelf");
        }
        for cfg in [&weth, &usdc] {
            if cfg.decimals > 18 {
                fail!("BadDecimals({})", cfg.decimals);
            }
            if cfg.symbol.is_empty() {
                fail("EmptyText");
            }
        }
        if weth.token_id == usdc.token_id {
            fail!("SameToken({})", weth.token_id);
        }
        DisputeWindowSet { dispute_window_sec }.emit();
        Self {
            owner_id,
            reporter_id,
            weth,
            usdc,
            params: Params::new(dispute_window_sec),
            events: LookupMap::new(StorageKey::Events),
            event_count: 0,
            scenarios_of_event: LookupMap::new(StorageKey::ScenariosOfEvent),
            scenarios: LookupMap::new(StorageKey::Scenarios),
            scenario_count: 0,
            reserves: LookupMap::new(StorageKey::Reserves),
            balances: LookupMap::new(StorageKey::Balances),
            supply: LookupMap::new(StorageKey::Supply),
            created: LookupSet::new(StorageKey::Created),
            real: LookupMap::new(StorageKey::Real),
            storage: LookupMap::new(StorageKey::Storage),
        }
    }
}

impl Contract {
    pub(crate) fn asset_cfg(&self, asset: Asset) -> &AssetCfg {
        match asset {
            Asset::Weth => &self.weth,
            Asset::Usdc => &self.usdc,
        }
    }

    /// Token units to internal units: 10^(18 - decimals).
    pub(crate) fn scale(&self, asset: Asset) -> u128 {
        self.asset_cfg(asset).scale()
    }
}
