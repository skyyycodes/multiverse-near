//! Multiverse Lending on NEAR.
//!
//! The whole protocol is one contract: the event oracle, the verse ledger
//! (exposed as NEP-245 multi tokens), the pools, the order book, the money
//! markets and the Root LP vault. Living in one account is what makes every
//! multi-step action atomic; only payouts of real tokens leave as promises.
//!
//! Units: every amount inside the contract is 18-decimal fixed point for both
//! assets. Token amounts are converted at the NEP-141 boundary with
//! `AssetCfg::to_internal` (`receiver` on the way in, a failed payout's
//! re-credit) and `AssetCfg::to_raw` (`payout` on the way out).

#[macro_use]
pub mod errors;
pub mod admin;
pub mod amm;
pub mod core;
pub mod events;
pub mod ledger;
pub mod lending;
pub mod masks;
pub mod nep245;
pub mod oracle;
pub mod orders;
pub mod outlayer;
pub mod payout;
pub mod receiver;
pub mod rootlp;
pub mod router;
pub mod storage;
pub mod types;
pub mod views;

#[cfg(test)]
mod tests;

use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, AccountId, BorshStorageKey, PanicOnDefault};

use crate::amm::{ImpactRing, Pool, Position};
use crate::errors::fail;
use crate::events::{DisputeWindowSet, MultiverseEvent};
use crate::lending::{CollateralKey, Market};
use crate::orders::Order;
use crate::outlayer::OutLayerState;
use crate::rootlp::Vault;
use crate::storage::StorageAccount;
use crate::types::{Asset, AssetCfg, EventData, Params, Scenario, VerseKey, MAX_DECIMALS};

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
    Pools,
    Within,
    Between,
    Positions,
    Impact,
    Orders,
    OpenByWorld,
    Markets,
    SupplyShares,
    SupplyPrincipal,
    BorrowShares,
    Collateral,
    Vaults,
    LpShares,
    Storage,
    /// The owner-set demo record (a JSON string), stored under this key alone.
    DemoRecord,
    OpenByScenario,
    OutLayerConfig,
    OutLayerDates,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    // config
    owner_id: AccountId,
    /// The only account `report_outcome` accepts; None accepts nobody.
    reporter_id: Option<AccountId>,
    wnear: AssetCfg,
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
    /// Internal real wNEAR/USDC balances: deposits, failed payouts, dust.
    real: LookupMap<(AccountId, Asset), u128>,

    // amm
    pools: LookupMap<u64, Pool>,
    pool_count: u64,
    within: LookupMap<(u64, u8), u64>,
    between: LookupMap<(u64, u8, u8), u64>,
    spot_pool: Option<u64>,
    positions: LookupMap<(u64, AccountId), Position>,
    /// Last 64 post-swap price points per scenario, for the Impact Meter.
    impact: LookupMap<u64, ImpactRing>,

    // orders
    orders: LookupMap<u64, Order>,
    order_count: u64,
    /// Open single-world orders per (scenario, world), for the views.
    open_by_world: LookupMap<(u64, u8), Vec<u64>>,
    /// Open order ids per scenario, ascending, so no read walks closed
    /// orders.
    open_by_scenario: LookupMap<u64, Vec<u64>>,

    // lending
    markets: LookupMap<u64, Market>,
    supply_shares: LookupMap<(u64, AccountId), u128>,
    supply_principal: LookupMap<(u64, AccountId), u128>,
    borrow_shares: LookupMap<(u64, AccountId), u128>,
    /// At most 16 pieces per (market, account).
    collateral: LookupMap<(u64, AccountId), Vec<(CollateralKey, u128)>>,

    // rootlp
    vaults: LookupMap<u64, Vault>,
    lp_shares: LookupMap<(u64, AccountId), u128>,

    // NEP-145
    storage: LookupMap<AccountId, StorageAccount>,

    // outlayer
    outlayer: OutLayerState,
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
        wnear: AssetCfg,
        usdc: AssetCfg,
        dispute_window_sec: u64,
    ) -> Self {
        if env::predecessor_account_id() != env::current_account_id() {
            fail("InitNotSelf");
        }
        for cfg in [&wnear, &usdc] {
            if cfg.decimals > MAX_DECIMALS {
                fail!("BadDecimals({})", cfg.decimals);
            }
            if cfg.symbol.is_empty() {
                fail("EmptyText");
            }
        }
        if wnear.token_id == usdc.token_id {
            fail!("SameToken({})", wnear.token_id);
        }
        DisputeWindowSet { dispute_window_sec }.emit();
        Self {
            owner_id,
            reporter_id,
            wnear,
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
            pools: LookupMap::new(StorageKey::Pools),
            pool_count: 0,
            within: LookupMap::new(StorageKey::Within),
            between: LookupMap::new(StorageKey::Between),
            spot_pool: None,
            positions: LookupMap::new(StorageKey::Positions),
            impact: LookupMap::new(StorageKey::Impact),
            orders: LookupMap::new(StorageKey::Orders),
            order_count: 0,
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
        }
    }
}

impl Contract {
    pub(crate) fn asset_cfg(&self, asset: Asset) -> &AssetCfg {
        match asset {
            Asset::Wnear => &self.wnear,
            Asset::Usdc => &self.usdc,
        }
    }

    /// The asset whose NEP-141 contract is `token`, if it is one of ours.
    pub(crate) fn asset_by_token(&self, token: &AccountId) -> Option<Asset> {
        Asset::ALL
            .into_iter()
            .find(|a| &self.asset_cfg(*a).token_id == token)
    }
}

/// Block time in whole seconds, the unit every stored time uses.
pub(crate) fn now_sec() -> u64 {
    env::block_timestamp() / 1_000_000_000
}
