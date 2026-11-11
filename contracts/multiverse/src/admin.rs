//! Owner-only configuration and the app's config view.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use near_sdk::{assert_one_yocto, env, near, AccountId, IntoStorageKey};

use crate::errors::fail;
use crate::types::AssetCfg;
use crate::{Contract, ContractExt, StorageKey};

/// What the app needs once at start-up. `demo` stays null until the owner
/// records it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AppConfig {
    pub owner_id: AccountId,
    pub reporter_id: Option<AccountId>,
    pub weth: AssetCfg,
    pub usdc: AssetCfg,
    pub lltv: U128,
    pub liquidation_bonus: U128,
    pub borrow_rate_per_sec: U128,
    pub dispute_window_sec: u64,
    pub twap_window_sec: u64,
    pub min_pool_depth: U128,
    pub fee_base_pips: u32,
    pub fee_cap_pips: u32,
    pub event_count: u64,
    pub scenario_count: u64,
    /// The owner-set demo record (event and scenario ids, seeded odds).
    pub demo: Option<Value>,
}

#[near]
impl Contract {
    /// Stores the demo record the app reads through `get_app_config`. It must
    /// be a JSON object; an empty string clears it. The bytes come out of the
    /// owner's storage deposit.
    #[payable]
    pub fn set_demo_record(&mut self, json: String) {
        assert_one_yocto();
        self.assert_owner();
        let value = if json.trim().is_empty() {
            None
        } else {
            match serde_json::from_str::<Value>(&json) {
                Ok(Value::Object(_)) => Some(json),
                Ok(_) => fail("BadDemoRecord(not a JSON object)"),
                Err(e) => fail!("BadDemoRecord({e})"),
            }
        };
        // Written straight to its own key, outside the root record, so the
        // bytes show up in storage usage and are charged like any other write.
        let key = StorageKey::DemoRecord.into_storage_key();
        let before = env::storage_usage();
        match value {
            Some(json) => {
                env::storage_write(&key, json.as_bytes());
            }
            None => {
                env::storage_remove(&key);
            }
        }
        self.charge_storage(&env::predecessor_account_id(), before);
    }

    pub fn get_app_config(&self) -> AppConfig {
        let p = &self.params;
        AppConfig {
            owner_id: self.owner_id.clone(),
            reporter_id: self.reporter_id.clone(),
            weth: self.weth.clone(),
            usdc: self.usdc.clone(),
            lltv: U128(p.lltv),
            liquidation_bonus: U128(p.liquidation_bonus),
            borrow_rate_per_sec: U128(p.borrow_rate_per_sec),
            dispute_window_sec: p.dispute_window_sec,
            twap_window_sec: p.twap_window_sec,
            min_pool_depth: U128(p.min_pool_depth),
            fee_base_pips: p.fee_base_pips,
            fee_cap_pips: p.fee_cap_pips,
            event_count: self.event_count,
            scenario_count: self.scenario_count,
            demo: env::storage_read(&StorageKey::DemoRecord.into_storage_key())
                .and_then(|bytes| serde_json::from_slice(&bytes).ok()),
        }
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }
}

impl Contract {
    pub(crate) fn assert_owner(&self) {
        let caller = env::predecessor_account_id();
        if caller != self.owner_id {
            fail!("OwnableUnauthorizedAccount({caller})");
        }
    }
}
