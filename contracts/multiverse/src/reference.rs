//! The outside NEAR/USD reference: the median of public price sources,
//! written by an OutLayer TEE guest or the reporter key. Lending compares it
//! with the TWAP-implied spot of a market whose price config turns the check
//! on: it can block new borrowing and cap how far liquidation prices drop. It
//! never blocks repay, deposits, exits or liquidation.
//!
//! Both records sit under raw keys outside the root record: the config (the
//! owner pays) and the state, a fixed 54 bytes that callbacks overwrite in
//! place without ever growing storage.

use near_sdk::borsh::BorshDeserialize;
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, IntoStorageKey};

use crate::outlayer::ResourceLimits;
use crate::{Contract, StorageKey};

/// Raw key 0x2f; the owner pays (<= ~2.4 KB).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReferenceConfig {
    pub enabled: bool,
    pub guest: Option<ReferenceGuest>,
    pub reporter_id: Option<AccountId>,
    pub min_sources: u8,
    pub max_spread_bps: u32,
    pub max_result_delay_sec: u64,
    pub borrow_max_age_sec: u64,
    pub liquidation_max_age_sec: u64,
    pub min_price: U128,
    pub max_price: U128,
}

/// The pinned guest that computes the median.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReferenceGuest {
    pub outlayer_id: AccountId,
    /// https, <= 2048 bytes.
    pub wasm_url: String,
    /// 64 lowercase hex characters.
    pub wasm_sha256: String,
    pub resource_limits: ResourceLimits,
    pub deposit: U128,
}

/// Raw key 0x30. Fixed 54 bytes: callbacks overwrite in place, never grow
/// storage, need no payer.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReferenceState {
    /// WAD USDC per NEAR, 0 = none.
    pub price: u128,
    pub observed_at: u64,
    pub stored_at: u64,
    /// 0 none, 1 outlayer, 2 reporter.
    pub source: u8,
    pub sources_used: u8,
    pub spread_bps: u32,
    pub request: u64,
    /// 0 = nothing in flight.
    pub pending_since: u64,
}

impl Contract {
    /// The stored reference config, if the owner set one.
    pub(crate) fn reference_config(&self) -> Option<ReferenceConfig> {
        env::storage_read(&StorageKey::ReferenceConfig.into_storage_key())
            .and_then(|bytes| ReferenceConfig::try_from_slice(&bytes).ok())
    }

    /// The stored reference, if any was ever written.
    #[allow(dead_code)] // read by the price snapshot once the reference check is on
    pub(crate) fn reference_state(&self) -> Option<ReferenceState> {
        env::storage_read(&StorageKey::ReferenceState.into_storage_key())
            .and_then(|bytes| ReferenceState::try_from_slice(&bytes).ok())
    }
}
