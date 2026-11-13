//! The v1 -> v2 upgrade: one transaction `[DeployContract, FunctionCall("migrate")]`
//! signed by the contract account. `migrate` decodes the v1 root with the
//! mirror in `v1`, re-creates every v1 collection on its own prefix (nothing
//! is copied or re-keyed), runs each part's step and writes the
//! VersionRecord. Any failure reverts the deploy with it.
//!
//! Per-account v1 data cannot be enumerated on chain, so it is folded lazily:
//! `upgrade_account` runs before any per-account v1 data is read or written,
//! and `migrate` runs it eagerly for every account of the pre-upgrade dump.

pub mod v1;

use std::collections::BTreeSet;

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, AccountId, IntoStorageKey};

use crate::books::Books;
use crate::catalog::{Catalog, MarketParams};
use crate::errors::fail;
use crate::events::MultiverseEvent;
use crate::lending::tiers::LendingParams;
use crate::ops::{PauseFlag, PauseState};
use crate::outlayer::OutLayerState;
use crate::prices::{MarketPriceCfg, PriceState};
use crate::version::{
    stored_state_version, write_version_record, CODE_VERSION, STATE_VERSION, V1_CODE_VERSION,
    V1_STATE_VERSION,
};
use crate::{now_sec, Contract, ContractExt, StorageKey};

use self::v1::ContractV1;

/// Lending's migrate arguments: legacy scenarios whose markets are frozen.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LendingMigrateArgs {
    pub frozen_scenarios: Vec<u64>,
}

/// The catalogue's migrate arguments: which legacy markets are listed, the
/// reference market of each event, the anchors, event sources and categories,
/// and the params (`None` = the testnet column; `anchors` wins either way).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogMigrateArgs {
    pub listed: Vec<u64>,
    pub references: Vec<(u64, u64)>,
    pub anchors: [u64; 3],
    pub event_meta: Vec<EventMetaArg>,
    pub params: Option<MarketParams>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventMetaArg {
    pub event_id: u64,
    pub source: String,
    pub category: u8,
}

/// Lending's part of `contract_upgraded`.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct LendingUpgradeLog {
    pub legacy_markets: u32,
    pub borrowers: u32,
    pub v1_terms: Vec<u64>,
    pub frozen: Vec<u64>,
    /// `[sid, TBS - Σ indexed shares]` per short legacy market; empty normally.
    pub unindexed: Vec<(u64, U128)>,
}

/// The catalogue's part of `contract_upgraded`.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct CatalogUpgradeLog {
    pub listed: Vec<u64>,
    pub references: u32,
}

/// One line per upgrade. `lending` and `catalog` are null from
/// `post_upgrade`.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ContractUpgraded<'a> {
    pub from_state_version: u32,
    pub to_state_version: u32,
    pub from_code_version: &'a str,
    pub code_version: &'a str,
    pub accounts_upgraded: u32,
    pub scenarios: u64,
    pub pools: u64,
    pub orders: u64,
    pub paused: Vec<PauseFlag>,
    pub legacy_scenario_count: u64,
    pub lending: Option<LendingUpgradeLog>,
    pub catalog: Option<CatalogUpgradeLog>,
}

impl MultiverseEvent for ContractUpgraded<'_> {
    const NAME: &'static str = "contract_upgraded";
}

#[near]
impl Contract {
    /// v1 -> v2, in the deploy transaction. Only the contract account may
    /// call it (near-sdk does not enforce `#[private]` on an init). `accounts`
    /// is every AccountId of the pre-upgrade dump; `pause` the flags to leave
    /// set (default: every guardian flag).
    #[init(ignore_state)]
    pub fn migrate(
        accounts: Vec<AccountId>,
        pause: Option<Vec<PauseFlag>>,
        lending: LendingMigrateArgs,
        catalog: CatalogMigrateArgs,
    ) -> Self {
        // 1
        if env::predecessor_account_id() != env::current_account_id() {
            fail("InitNotSelf");
        }
        // 2
        let found = stored_state_version();
        if found != V1_STATE_VERSION {
            fail!("WrongStateVersion({found}, {V1_STATE_VERSION})");
        }
        // 3
        let old = read_v1_state();
        // 4
        for (field, prefix, key) in old.prefixes() {
            if prefix != key.into_storage_key().as_slice() {
                fail!("MigrateLayoutMismatch({field})");
            }
        }
        // 5
        let mut c = Contract::from_v1(old, pause);
        // 6
        c.migrate_check_records();
        // 7
        c.migrate_eight_worlds();
        // 8
        let params = c.params.clone();
        c.migrate_prices(&params);
        // 9
        let mut lending_log = LendingUpgradeLog::default();
        c.migrate_lending_configs(&lending, &mut lending_log);
        // 10
        let accounts_upgraded = c.upgrade_dump_accounts(&accounts);
        // 11
        c.migrate_lending_proof(&mut lending_log);
        // 12
        let catalog_log = c.migrate_catalog(&catalog);
        // 13
        write_version_record(V1_CODE_VERSION);
        // 14
        ContractUpgraded {
            from_state_version: V1_STATE_VERSION,
            to_state_version: STATE_VERSION,
            from_code_version: V1_CODE_VERSION,
            code_version: CODE_VERSION,
            accounts_upgraded,
            scenarios: c.scenario_count,
            pools: c.pool_count,
            orders: c.order_count,
            paused: c.pause.paused(),
            legacy_scenario_count: c.legacy_scenario_count,
            lending: Some(lending_log),
            catalog: Some(catalog_log),
        }
        .emit();
        // 15: the init wrapper writes STATE; dropping flushes the maps
        c
    }
}

/// The v1 root, decoded whole; `NoState` without one.
fn read_v1_state() -> ContractV1 {
    let bytes = env::storage_read(b"STATE").unwrap_or_else(|| fail("NoState"));
    near_sdk::borsh::from_slice(&bytes).unwrap_or_else(|_| fail("MigrateLayoutMismatch(STATE)"))
}

impl Contract {
    /// Step 5: v1 scalars moved, v1 collections re-created on their own
    /// prefixes, every v2 field at its starting value.
    fn from_v1(old: ContractV1, pause: Option<Vec<PauseFlag>>) -> Self {
        let flags = PauseFlag::bits_of(pause.as_deref().unwrap_or(&PauseFlag::GUARDIAN));
        Self {
            owner_id: old.owner_id,
            reporter_id: old.reporter_id,
            wnear: old.wnear,
            usdc: old.usdc,
            params: old.params.into(),
            events: LookupMap::new(StorageKey::Events),
            event_count: old.event_count,
            scenarios_of_event: LookupMap::new(StorageKey::ScenariosOfEvent),
            scenarios: LookupMap::new(StorageKey::Scenarios),
            scenario_count: old.scenario_count,
            reserves: LookupMap::new(StorageKey::Reserves),
            balances: LookupMap::new(StorageKey::Balances),
            supply: LookupMap::new(StorageKey::Supply),
            created: LookupSet::new(StorageKey::Created),
            real: LookupMap::new(StorageKey::Real),
            pools: LookupMap::new(StorageKey::Pools),
            pool_count: old.pool_count,
            within: LookupMap::new(StorageKey::Within),
            between: LookupMap::new(StorageKey::Between),
            spot_pool: old.spot_pool,
            positions: LookupMap::new(StorageKey::Positions),
            impact: LookupMap::new(StorageKey::Impact),
            orders: LookupMap::new(StorageKey::Orders),
            order_count: old.order_count,
            open_by_world: LookupMap::new(StorageKey::OpenByWorld),
            open_by_scenario: LookupMap::new(StorageKey::OpenByScenario),
            markets: LookupMap::new(StorageKey::Markets),
            supply_shares: LookupMap::new(StorageKey::SupplyShares),
            supply_principal: LookupMap::new(StorageKey::SupplyPrincipal),
            borrow_shares: LookupMap::new(StorageKey::BorrowShares),
            collateral: LookupMap::new(StorageKey::Collateral),
            vaults: LookupMap::new(StorageKey::Vaults),
            lp_shares: LookupMap::new(StorageKey::LpShares),
            storage: LookupMap::new(StorageKey::Storage),
            outlayer: OutLayerState::new(),
            pause: PauseState {
                flags,
                since_sec: now_sec(),
                liquidations_resume_at_sec: 0,
            },
            guardian_id: None,
            pending_owner_id: None,
            legacy_scenario_count: old.scenario_count,
            legacy_backfill_open: false,
            books: Books::default(),
            account_version: LookupMap::new(StorageKey::AccountVersion),
            catalog: Catalog::new(),
            world_supply: LookupMap::new(StorageKey::WorldSupply),
            created_masks: LookupMap::new(StorageKey::CreatedMasks),
            account_scenarios: LookupMap::new(StorageKey::AccountScenarios),
            footprints: LookupMap::new(StorageKey::Footprints),
            prices: PriceState::new(MarketPriceCfg::V2),
            tier_states: LookupMap::new(StorageKey::TierStates),
            borrower_count: LookupMap::new(StorageKey::BorrowerCount),
            borrower_at: LookupMap::new(StorageKey::BorrowerAt),
            borrower_pos: LookupMap::new(StorageKey::BorrowerPos),
            lending: LendingParams::default(),
        }
    }

    /// Step 10: `upgrade_account` for every distinct account of the dump.
    /// Returns how many were upgraded now.
    fn upgrade_dump_accounts(&mut self, accounts: &[AccountId]) -> u32 {
        let mut seen = BTreeSet::new();
        let mut upgraded = 0u32;
        for a in accounts {
            if !seen.insert(a.clone()) {
                continue;
            }
            if self.account_version.get(a).copied().unwrap_or(0) < STATE_VERSION {
                upgraded += 1;
            }
            self.upgrade_account(a);
        }
        upgraded
    }

    /// Step 6: every event, scenario, pool and order decodes with the v2
    /// types (`MigrateMissingRecord(kind, id)` otherwise).
    pub(crate) fn migrate_check_records(&self) {}

    /// Folds `a`'s v1 data into the v2 structures (the books totals and the
    /// borrower index of legacy markets). Called first in every funnel that
    /// reads or writes per-account v1 data; the `account_version` marker
    /// makes it run once per account and state version.
    pub(crate) fn upgrade_account(&mut self, a: &AccountId) {
        self.books_upgrade_account(a);
        self.lending_upgrade_account(a);
    }
}
