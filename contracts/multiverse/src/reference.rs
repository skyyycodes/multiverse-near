//! The outside NEAR/USD reference: the median of public price sources,
//! written by an OutLayer TEE guest (`oracle/nearusd-guest`) or the reporter
//! key. Lending compares it with the TWAP-implied spot of a market whose
//! price config turns the check on: it can block new borrowing and cap how far
//! liquidation prices drop. It never blocks repay, deposits, exits or
//! liquidation.
//!
//! Both records sit under raw keys outside the root record: the config (the
//! owner pays) and the state, a fixed 54 bytes that callbacks overwrite in
//! place without ever growing storage.
//!
//! Anyone may refresh it with `request_reference` and pays OutLayer for the
//! run; `on_reference_result` never panics and drops anything it cannot
//! trust, with the reason in a `reference_rejected` line.

use near_sdk::borsh::{self, BorshDeserialize};
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, AccountId, IntoStorageKey, NearToken, Promise, PromiseResult};

use crate::errors::fail;
use crate::events::MultiverseEvent;
use crate::ops::PauseFlag;
use crate::outlayer::{
    assert_guest, clip, outlayer_args, ResourceLimits, CALLBACK_GAS, OUTLAYER_GAS, REQUEST_GAS,
};
use crate::types::WAD;
use crate::{now_sec, Contract, ContractExt, StorageKey};

/// A request in flight longer than this no longer blocks a new one (its
/// callback was lost).
pub const REFERENCE_REQUEST_TIMEOUT_SEC: u64 = 600;
/// An observation may be at most this far ahead of the block clock.
pub const MAX_CLOCK_AHEAD_SEC: u64 = 60;
/// Largest guest result the callback reads; the guest prints well under 1 KiB.
const MAX_RESULT_BYTES: usize = 4096;
/// `reference_rejected` notes are clipped to this.
pub const MAX_NOTE_BYTES: usize = 512;

/// Bounds of `ReferenceConfig` (`BadReferenceConfig(field)`).
pub const MAX_MIN_SOURCES: u8 = 4;
pub const MAX_SPREAD_BPS: u32 = 2_000;
pub const MIN_RESULT_DELAY_SEC: u64 = 30;
pub const MAX_RESULT_DELAY_SEC: u64 = 600;
pub const MIN_BORROW_MAX_AGE_SEC: u64 = 300;
pub const MAX_BORROW_MAX_AGE_SEC: u64 = 86_400;
pub const MIN_LIQUIDATION_MAX_AGE_SEC: u64 = 60;
pub const MAX_LIQUIDATION_MAX_AGE_SEC: u64 = 900;
/// 1,000,000 USDC per NEAR.
pub const MAX_REFERENCE_PRICE: u128 = 1_000_000 * WAD;

/// Raw key 0x2f; the owner pays (<= ~2.4 KB).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReferenceConfig {
    /// The global switch: false = every market behaves as `reference: false`.
    pub enabled: bool,
    /// The OutLayer job; None = no OutLayer source.
    pub guest: Option<ReferenceGuest>,
    /// May call `report_reference`; None = nobody.
    pub reporter_id: Option<AccountId>,
    pub min_sources: u8,
    pub max_spread_bps: u32,
    /// Most seconds from `observed_at` to the block that stores it.
    pub max_result_delay_sec: u64,
    pub borrow_max_age_sec: u64,
    pub liquidation_max_age_sec: u64,
    /// WAD USDC per NEAR.
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

/// Where the stored reference came from.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReferenceSource {
    None,
    Outlayer,
    Reporter,
}

impl ReferenceSource {
    pub const OUTLAYER: u8 = 1;
    pub const REPORTER: u8 = 2;

    pub fn from_code(code: u8) -> Self {
        match code {
            Self::OUTLAYER => ReferenceSource::Outlayer,
            Self::REPORTER => ReferenceSource::Reporter,
            _ => ReferenceSource::None,
        }
    }
}

impl ReferenceConfig {
    /// The first bound a config that switches the reference on breaks, as
    /// the error to fail with. A config with `enabled: false` is always
    /// accepted: switching the reference off must never be refused.
    fn assert_valid(&self) {
        if !self.enabled {
            return;
        }
        let field = if self.min_sources == 0 || self.min_sources > MAX_MIN_SOURCES {
            Some("min_sources")
        } else if self.max_spread_bps == 0 || self.max_spread_bps > MAX_SPREAD_BPS {
            Some("max_spread_bps")
        } else if !(MIN_RESULT_DELAY_SEC..=MAX_RESULT_DELAY_SEC)
            .contains(&self.max_result_delay_sec)
        {
            Some("max_result_delay_sec")
        } else if !(MIN_BORROW_MAX_AGE_SEC..=MAX_BORROW_MAX_AGE_SEC)
            .contains(&self.borrow_max_age_sec)
        {
            Some("borrow_max_age_sec")
        } else if !(MIN_LIQUIDATION_MAX_AGE_SEC..=MAX_LIQUIDATION_MAX_AGE_SEC)
            .contains(&self.liquidation_max_age_sec)
            || self.liquidation_max_age_sec > self.borrow_max_age_sec
        {
            Some("liquidation_max_age_sec")
        } else if self.min_price.0 == 0 || self.min_price.0 >= self.max_price.0 {
            Some("min_price")
        } else if self.max_price.0 > MAX_REFERENCE_PRICE {
            Some("max_price")
        } else {
            None
        };
        if let Some(field) = field {
            fail!("BadReferenceConfig({field})");
        }
        if let Some(g) = &self.guest {
            assert_guest(&g.wasm_url, &g.wasm_sha256, &g.resource_limits, g.deposit.0);
        }
    }

    /// Why an observation of `price` at `observed_at` cannot replace
    /// `stored` now, in the callback's order from the clock checks on.
    fn reject(&self, stored: &ReferenceState, price: u128, observed_at: u64) -> Option<String> {
        let now = now_sec();
        if observed_at > now.saturating_add(MAX_CLOCK_AHEAD_SEC) {
            return Some("observed in the future".to_string());
        }
        let late = now.saturating_sub(observed_at);
        if late > self.max_result_delay_sec {
            return Some(format!("late by {late} s"));
        }
        if observed_at <= stored.observed_at {
            return Some("older than stored".to_string());
        }
        if price < self.min_price.0 || price > self.max_price.0 {
            return Some("out of bounds".to_string());
        }
        None
    }
}

/// The stored reference as `get_reference` shows it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReferenceView {
    pub price: U128,
    pub observed_at: u64,
    pub stored_at: u64,
    pub age_sec: u64,
    pub source: ReferenceSource,
    pub sources_used: u8,
    pub spread_bps: u32,
    /// The last request number issued.
    pub request: u64,
    /// A request is in flight and not timed out.
    pub pending: bool,
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ReferenceRequested<'a> {
    pub request: u64,
    pub payer_id: &'a AccountId,
}

impl MultiverseEvent for ReferenceRequested<'_> {
    const NAME: &'static str = "reference_requested";
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ReferenceUpdated {
    pub price: U128,
    pub observed_at: u64,
    pub source: ReferenceSource,
    pub request: u64,
    pub sources_used: u8,
    pub spread_bps: u32,
}

impl MultiverseEvent for ReferenceUpdated {
    const NAME: &'static str = "reference_updated";
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ReferenceRejected<'a> {
    pub request: u64,
    pub note: &'a str,
}

impl MultiverseEvent for ReferenceRejected<'_> {
    const NAME: &'static str = "reference_rejected";
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ReferenceConfigSet<'a> {
    pub enabled: bool,
    /// Whether an OutLayer guest is configured.
    pub outlayer: bool,
    pub reporter_id: Option<&'a AccountId>,
    pub min_sources: u8,
    pub max_spread_bps: u32,
    pub borrow_max_age_sec: u64,
    pub liquidation_max_age_sec: u64,
}

impl MultiverseEvent for ReferenceConfigSet<'_> {
    const NAME: &'static str = "reference_config_set";
}

#[near]
impl Contract {
    /// Owner only. Stores the config (and, the first time, a zero reference
    /// record); storage comes out of the deposit, or the owner's NEP-145
    /// balance with 1 yoctoNEAR. `enabled: false` is always accepted.
    #[payable]
    pub fn set_reference_config(&mut self, config: ReferenceConfig) {
        self.assert_owner();
        config.assert_valid();
        let before = env::storage_usage();
        let bytes = borsh::to_vec(&config).unwrap_or_else(|_| env::abort());
        env::storage_write(&StorageKey::ReferenceConfig.into_storage_key(), &bytes);
        if self.reference_state().is_none() {
            self.write_reference_state(&ReferenceState::default());
        }
        self.charge_storage_or_deposit(&env::predecessor_account_id(), before);
        ReferenceConfigSet {
            enabled: config.enabled,
            outlayer: config.guest.is_some(),
            reporter_id: config.reporter_id.as_ref(),
            min_sources: config.min_sources,
            max_spread_bps: config.max_spread_bps,
            borrow_max_age_sec: config.borrow_max_age_sec,
            liquidation_max_age_sec: config.liquidation_max_age_sec,
        }
        .emit();
    }

    /// Anyone. Attach at least the guest's deposit (all of it goes to
    /// OutLayer, which refunds what the run does not use to the caller) and
    /// 300 Tgas. One request at a time; one that has waited 600 s no longer
    /// blocks.
    #[payable]
    pub fn request_reference(&mut self) -> Promise {
        self.assert_live(PauseFlag::Oracle);
        let Some((config, guest)) = self
            .reference_config()
            .filter(|c| c.enabled)
            .and_then(|c| c.guest.clone().map(|g| (c, g)))
        else {
            fail("ReferenceNotConfigured");
        };
        let mut state = self.reference_state().unwrap_or_default();
        let now = now_sec();
        if state.pending_since != 0
            && now.saturating_sub(state.pending_since) < REFERENCE_REQUEST_TIMEOUT_SEC
        {
            fail!("ReferenceRequestInFlight({})", state.request);
        }
        let deposit = env::attached_deposit();
        if deposit.as_yoctonear() < guest.deposit.0 {
            fail!(
                "InsufficientDeposit({}, {})",
                guest.deposit.0,
                deposit.as_yoctonear()
            );
        }
        if env::prepaid_gas() < REQUEST_GAS {
            fail!("NotEnoughGas({})", REQUEST_GAS.as_tgas());
        }
        let payer = env::predecessor_account_id();
        state.pending_since = now.max(1);
        state.request = state.request.saturating_add(1);
        let request = state.request;
        self.write_reference_state(&state);
        ReferenceRequested {
            request,
            payer_id: &payer,
        }
        .emit();
        let input = json!({
            "min_sources": config.min_sources,
            "max_spread_bps": config.max_spread_bps,
        })
        .to_string();
        let args = outlayer_args(
            &guest.wasm_url,
            &guest.wasm_sha256,
            &guest.resource_limits,
            &input,
            &payer,
        );
        Promise::new(guest.outlayer_id)
            .function_call(
                "request_execution".to_string(),
                args.to_string().into_bytes(),
                deposit,
                OUTLAYER_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_reference_result(request, payer, U128(deposit.as_yoctonear())),
            )
    }

    /// Never panics. Stores the guest's price when every check passes and
    /// returns it; otherwise logs `reference_rejected` with the reason. When
    /// `request_execution` itself failed, the deposit came back to this
    /// contract and is passed on to the payer.
    #[private]
    pub fn on_reference_result(
        &mut self,
        request: u64,
        payer: AccountId,
        deposit: U128,
    ) -> Option<U128> {
        let mut state = self.reference_state().unwrap_or_default();
        let current = state.request == request;
        if current && state.pending_since != 0 {
            state.pending_since = 0;
            self.write_reference_state(&state);
        }
        let result = if env::promise_results_count() == 1 {
            env::promise_result(0)
        } else {
            PromiseResult::Failed
        };
        let bytes = match result {
            PromiseResult::Successful(bytes) => bytes,
            PromiseResult::Failed => {
                if deposit.0 > 0 {
                    Promise::new(payer).transfer(NearToken::from_yoctonear(deposit.0));
                }
                return reject(request, "request failed");
            }
        };
        if !current {
            return reject(request, "stale request");
        }
        let Some(config) = self.reference_config() else {
            return reject(request, "stale request");
        };
        if bytes.len() > MAX_RESULT_BYTES {
            return reject(request, "result too long");
        }
        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => return reject(request, "result is not JSON"),
        };
        let price = &value["price_wad"];
        if price.is_null() {
            return reject(request, "no result");
        }
        let Some(price) = price.as_str().and_then(parse_u128) else {
            return reject(request, "bad price");
        };
        // A missing or malformed field reads as the value that fails its check.
        let sources_used = value["sources_used"]
            .as_u64()
            .and_then(|n| u8::try_from(n).ok())
            .unwrap_or(0);
        if sources_used < config.min_sources {
            let note = format!("too few sources ({sources_used} < {})", config.min_sources);
            return reject(request, &note);
        }
        let spread_bps = value["spread_bps"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(u32::MAX);
        if spread_bps > config.max_spread_bps {
            let note = format!("spread {spread_bps} bps above {}", config.max_spread_bps);
            return reject(request, &note);
        }
        let observed_at = value["observed_at"].as_u64().unwrap_or(0);
        if let Some(note) = config.reject(&state, price, observed_at) {
            return reject(request, &note);
        }
        let stored = ReferenceState {
            price,
            observed_at,
            stored_at: now_sec(),
            source: ReferenceSource::OUTLAYER,
            sources_used,
            spread_bps,
            request: state.request,
            pending_since: state.pending_since,
        };
        self.write_reference_state(&stored);
        ReferenceUpdated {
            price: U128(price),
            observed_at,
            source: ReferenceSource::Outlayer,
            request,
            sources_used,
            spread_bps,
        }
        .emit();
        Some(U128(price))
    }

    /// The reporter only, while the reference is switched on: posts a price
    /// observed at `observed_at` (seconds) under the callback's checks from
    /// the clock on (`BadReference(note)`).
    pub fn report_reference(&mut self, price: U128, observed_at: u64) {
        self.assert_live(PauseFlag::Oracle);
        let caller = env::predecessor_account_id();
        let config = self.reference_config();
        let Some(config) = config.filter(|c| c.reporter_id.as_ref() == Some(&caller)) else {
            fail!("NotReferenceReporter({caller})");
        };
        if !config.enabled {
            fail("ReferenceNotConfigured");
        }
        let mut state = self.reference_state().unwrap_or_default();
        if let Some(note) = config.reject(&state, price.0, observed_at) {
            fail!("BadReference({note})");
        }
        state.price = price.0;
        state.observed_at = observed_at;
        state.stored_at = now_sec();
        state.source = ReferenceSource::REPORTER;
        state.sources_used = 0;
        state.spread_bps = 0;
        self.write_reference_state(&state);
        ReferenceUpdated {
            price,
            observed_at,
            source: ReferenceSource::Reporter,
            request: state.request,
            sources_used: 0,
            spread_bps: 0,
        }
        .emit();
    }

    /// Null before the first `set_reference_config`.
    pub fn get_reference(&self) -> Option<ReferenceView> {
        let s = self.reference_state()?;
        let now = now_sec();
        Some(ReferenceView {
            price: U128(s.price),
            observed_at: s.observed_at,
            stored_at: s.stored_at,
            age_sec: now.saturating_sub(s.observed_at),
            source: ReferenceSource::from_code(s.source),
            sources_used: s.sources_used,
            spread_bps: s.spread_bps,
            request: s.request,
            pending: s.pending_since != 0
                && now.saturating_sub(s.pending_since) < REFERENCE_REQUEST_TIMEOUT_SEC,
        })
    }

    pub fn get_reference_config(&self) -> Option<ReferenceConfig> {
        self.reference_config()
    }
}

impl Contract {
    /// The stored reference config, if the owner set one.
    pub(crate) fn reference_config(&self) -> Option<ReferenceConfig> {
        env::storage_read(&StorageKey::ReferenceConfig.into_storage_key())
            .and_then(|bytes| ReferenceConfig::try_from_slice(&bytes).ok())
    }

    /// The stored reference, if any was ever written.
    pub(crate) fn reference_state(&self) -> Option<ReferenceState> {
        env::storage_read(&StorageKey::ReferenceState.into_storage_key())
            .and_then(|bytes| ReferenceState::try_from_slice(&bytes).ok())
    }

    /// Overwrites the fixed 54-byte record.
    fn write_reference_state(&mut self, state: &ReferenceState) {
        let bytes = borsh::to_vec(state).unwrap_or_else(|_| env::abort());
        env::storage_write(&StorageKey::ReferenceState.into_storage_key(), &bytes);
    }
}

/// Logs why a result was dropped; the callback's answer is then None.
fn reject(request: u64, note: &str) -> Option<U128> {
    ReferenceRejected {
        request,
        note: clip(note, MAX_NOTE_BYTES),
    }
    .emit();
    None
}

/// A decimal u128 with digits only (no sign, no exponent, no spaces).
fn parse_u128(s: &str) -> Option<u128> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}
