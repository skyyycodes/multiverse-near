//! The v1 root record (code at `1c6c41f`), mirrored field for field so that
//! `migrate` can decode it after the deploy has replaced the code. Nothing
//! here depends on a type that v2 may change: `ParamsV1` is a copy of v1's
//! `Params`, and every store collection decodes as its prefix bytes (u32
//! length + bytes) without a live handle.

use near_sdk::{near, AccountId};

use crate::types::{AssetCfg, Params};

/// Field-for-field copy of v1 `Params` (types.rs at 1c6c41f).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParamsV1 {
    pub dispute_window_sec: u64,
    pub twap_window_sec: u64,
    pub min_pool_depth: u128,
    pub lltv: u128,
    pub liquidation_bonus: u128,
    pub borrow_rate_per_sec: u128,
    pub fee_base_pips: u32,
    pub fee_cap_pips: u32,
}

impl From<ParamsV1> for Params {
    fn from(p: ParamsV1) -> Self {
        Params {
            dispute_window_sec: p.dispute_window_sec,
            twap_window_sec: p.twap_window_sec,
            min_pool_depth: p.min_pool_depth,
            lltv: p.lltv,
            liquidation_bonus: p.liquidation_bonus,
            borrow_rate_per_sec: p.borrow_rate_per_sec,
            fee_base_pips: p.fee_base_pips,
            fee_cap_pips: p.fee_cap_pips,
        }
    }
}

/// Borsh-exact mirror of the v1 root at 1c6c41f (lib.rs:85-154); decoding
/// consumes all 402 bytes of production's STATE.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ContractV1 {
    pub owner_id: AccountId,
    pub reporter_id: Option<AccountId>,
    pub wnear: AssetCfg,
    pub usdc: AssetCfg,
    pub params: ParamsV1,
    pub events: Vec<u8>,
    pub event_count: u64,
    pub scenarios_of_event: Vec<u8>,
    pub scenarios: Vec<u8>,
    pub scenario_count: u64,
    pub reserves: Vec<u8>,
    pub balances: Vec<u8>,
    pub supply: Vec<u8>,
    pub created: Vec<u8>,
    pub real: Vec<u8>,
    pub pools: Vec<u8>,
    pub pool_count: u64,
    pub within: Vec<u8>,
    pub between: Vec<u8>,
    pub spot_pool: Option<u64>,
    pub positions: Vec<u8>,
    pub impact: Vec<u8>,
    pub orders: Vec<u8>,
    pub order_count: u64,
    pub open_by_world: Vec<u8>,
    pub open_by_scenario: Vec<u8>,
    pub markets: Vec<u8>,
    pub supply_shares: Vec<u8>,
    pub supply_principal: Vec<u8>,
    pub borrow_shares: Vec<u8>,
    pub collateral: Vec<u8>,
    pub vaults: Vec<u8>,
    pub lp_shares: Vec<u8>,
    pub storage: Vec<u8>,
    /// `OutLayerState { dates }`.
    pub outlayer_dates: Vec<u8>,
}

impl ContractV1 {
    /// Every v1 collection's stored prefix with its field name and the
    /// StorageKey it must equal, in field order (25).
    pub fn prefixes(&self) -> [(&'static str, &[u8], crate::StorageKey); 25] {
        use crate::StorageKey as K;
        [
            ("events", &self.events, K::Events),
            (
                "scenarios_of_event",
                &self.scenarios_of_event,
                K::ScenariosOfEvent,
            ),
            ("scenarios", &self.scenarios, K::Scenarios),
            ("reserves", &self.reserves, K::Reserves),
            ("balances", &self.balances, K::Balances),
            ("supply", &self.supply, K::Supply),
            ("created", &self.created, K::Created),
            ("real", &self.real, K::Real),
            ("pools", &self.pools, K::Pools),
            ("within", &self.within, K::Within),
            ("between", &self.between, K::Between),
            ("positions", &self.positions, K::Positions),
            ("impact", &self.impact, K::Impact),
            ("orders", &self.orders, K::Orders),
            ("open_by_world", &self.open_by_world, K::OpenByWorld),
            (
                "open_by_scenario",
                &self.open_by_scenario,
                K::OpenByScenario,
            ),
            ("markets", &self.markets, K::Markets),
            ("supply_shares", &self.supply_shares, K::SupplyShares),
            (
                "supply_principal",
                &self.supply_principal,
                K::SupplyPrincipal,
            ),
            ("borrow_shares", &self.borrow_shares, K::BorrowShares),
            ("collateral", &self.collateral, K::Collateral),
            ("vaults", &self.vaults, K::Vaults),
            ("lp_shares", &self.lp_shares, K::LpShares),
            ("storage", &self.storage, K::Storage),
            ("outlayer_dates", &self.outlayer_dates, K::OutLayerDates),
        ]
    }
}
