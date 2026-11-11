//! Resolution through OutLayer: a pinned WASM reads FRED inside an Intel TDX
//! worker and its answer becomes an ordinary proposal, open to dispute for
//! the usual window.
//!
//! Anyone may start a run with `request_resolution` and pays OutLayer for it;
//! the input is built only from what the owner stored (the WASM URL and hash,
//! the limits, the event's two FRED dates). OutLayer pauses the call with a
//! NEP-519 yield and resumes it with the guest's stdout, which reaches
//! `on_outlayer_result`. That callback never panics: a failed run, `null`, a
//! result with no outcome or an event that can no longer take a proposal is
//! logged and dropped.
//!
//! Trust: OutLayer's operator keys decide what comes back on-chain; the TDX
//! attestation of each run is published off-chain. The dispute window is the
//! backstop.

use near_sdk::borsh::{self, BorshDeserialize};
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, Gas, IntoStorageKey, NearToken, Promise, PromiseResult};

use crate::errors::fail;
use crate::events::MultiverseEvent;
use crate::oracle::MAX_EVIDENCE_BYTES;
use crate::types::Source;
use crate::{now_sec, Contract, ContractExt, StorageKey};

pub const DEFAULT_OUTLAYER_ID: &str = "outlayer.testnet";
pub const BUILD_TARGET: &str = "wasm32-wasip2";

/// OutLayer's hard caps; a request above any of them is refused there.
pub const MAX_INSTRUCTIONS: u64 = 500_000_000_000;
pub const MAX_MEMORY_MB: u32 = 4096;
pub const MAX_EXECUTION_SECONDS: u64 = 180;
pub const MAX_WASM_URL_BYTES: usize = 2048;

pub const DEFAULT_MAX_INSTRUCTIONS: u64 = 1_000_000_000;
pub const DEFAULT_MAX_MEMORY_MB: u32 = 128;
pub const DEFAULT_MAX_EXECUTION_SECONDS: u64 = 30;
/// OutLayer's estimate for the default limits on testnet is 0.0040001 NEAR.
/// What the run does not use is refunded to the caller.
pub const DEFAULT_DEPOSIT: NearToken = NearToken::from_millinear(5);

/// Forwarded to `request_execution`; OutLayer keeps 50 Tgas of it for its
/// own resume callback.
pub const OUTLAYER_GAS: Gas = Gas::from_tgas(200);
pub const CALLBACK_GAS: Gas = Gas::from_tgas(20);
/// Prepaid gas `request_resolution` needs for both promises and itself.
pub const REQUEST_GAS: Gas = Gas::from_tgas(240);

/// Largest result the callback reads. The guest prints well under 1 KiB.
const MAX_RESULT_BYTES: usize = 4096;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutLayerConfig {
    pub outlayer_id: AccountId,
    pub wasm_url: String,
    /// 64 lowercase hex characters, as OutLayer requires.
    pub wasm_sha256: String,
    pub resource_limits: ResourceLimits,
    /// The least a request must attach; all of it goes to OutLayer.
    pub deposit: U128,
}

/// Sent with every request, field for field as OutLayer names them.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResourceLimits {
    pub max_instructions: u64,
    pub max_memory_mb: u32,
    pub max_execution_seconds: u64,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            max_instructions: DEFAULT_MAX_INSTRUCTIONS,
            max_memory_mb: DEFAULT_MAX_MEMORY_MB,
            max_execution_seconds: DEFAULT_MAX_EXECUTION_SECONDS,
        }
    }
}

/// The two FRED dates of a FOMC event: the day before the meeting and the
/// day after the statement. `request` numbers the runs; a result from any
/// run but the latest is stale.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FomcDates {
    pub before: String,
    pub after: String,
    pub pending: bool,
    pub request: u64,
}

/// The config sits under its own key, written through like the demo record,
/// so its bytes show up in storage usage at once.
#[near(serializers = [borsh])]
pub struct OutLayerState {
    dates: LookupMap<u64, FomcDates>,
}

impl OutLayerState {
    pub fn new() -> Self {
        Self {
            dates: LookupMap::new(StorageKey::OutLayerDates),
        }
    }

    pub(crate) fn flush(&mut self) {
        self.dates.flush();
    }

    fn config(&self) -> Option<OutLayerConfig> {
        env::storage_read(&StorageKey::OutLayerConfig.into_storage_key())
            .and_then(|bytes| OutLayerConfig::try_from_slice(&bytes).ok())
    }

    fn set_config(&mut self, config: &OutLayerConfig) {
        let bytes = borsh::to_vec(config).unwrap_or_else(|_| env::abort());
        env::storage_write(&StorageKey::OutLayerConfig.into_storage_key(), &bytes);
    }
}

impl Default for OutLayerState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct OutLayerRequested<'a> {
    pub event_id: u64,
    pub request: u64,
    pub payer_id: &'a AccountId,
}

impl MultiverseEvent for OutLayerRequested<'_> {
    const NAME: &'static str = "outlayer_requested";
}

/// `outcome` is what the guest answered, `proposed` whether it became a
/// proposal, `note` the guest's evidence or why nothing was proposed.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct OutLayerResult<'a> {
    pub event_id: u64,
    pub request: u64,
    pub outcome: Option<u8>,
    pub proposed: bool,
    pub note: &'a str,
}

impl MultiverseEvent for OutLayerResult<'_> {
    const NAME: &'static str = "outlayer_result";
}

#[near]
impl Contract {
    /// Owner only. Pins the guest by URL and SHA-256; omitted limits take the
    /// defaults (1e9 instructions, 128 MB, 30 s, 0.005 NEAR). Storage comes
    /// out of the deposit, or the owner's NEP-145 balance with 1 yoctoNEAR.
    #[payable]
    pub fn set_outlayer_config(
        &mut self,
        wasm_url: String,
        wasm_sha256: String,
        outlayer_id: Option<AccountId>,
        resource_limits: Option<ResourceLimits>,
        deposit: Option<U128>,
    ) {
        self.assert_owner();
        if let Some(why) = wasm_url_error(&wasm_url) {
            fail!("BadWasmUrl({why})");
        }
        if !is_sha256_hex(&wasm_sha256) {
            fail("BadWasmHash");
        }
        let config = OutLayerConfig {
            outlayer_id: outlayer_id.unwrap_or_else(|| DEFAULT_OUTLAYER_ID.parse().unwrap()),
            wasm_url,
            wasm_sha256,
            resource_limits: resource_limits.unwrap_or_default(),
            deposit: deposit.unwrap_or(U128(DEFAULT_DEPOSIT.as_yoctonear())),
        };
        if config.resource_limits.max_instructions == 0
            || config.resource_limits.max_instructions > MAX_INSTRUCTIONS
        {
            fail!(
                "BadLimit(max_instructions, {})",
                config.resource_limits.max_instructions
            );
        }
        if config.resource_limits.max_memory_mb == 0
            || config.resource_limits.max_memory_mb > MAX_MEMORY_MB
        {
            fail!(
                "BadLimit(max_memory_mb, {})",
                config.resource_limits.max_memory_mb
            );
        }
        if config.resource_limits.max_execution_seconds == 0
            || config.resource_limits.max_execution_seconds > MAX_EXECUTION_SECONDS
        {
            fail!(
                "BadLimit(max_execution_seconds, {})",
                config.resource_limits.max_execution_seconds
            );
        }
        if config.deposit.0 == 0 {
            fail("BadLimit(deposit, 0)");
        }
        let before = env::storage_usage();
        self.outlayer.set_config(&config);
        self.charge_storage_or_deposit(&env::predecessor_account_id(), before);
    }

    /// Owner only. Sets an event's FRED dates (`YYYY-MM-DD`, `before` earlier
    /// than `after`). Any run in flight for the event becomes stale, so this
    /// also clears a pending flag a lost callback left behind.
    #[payable]
    pub fn set_outlayer_dates(&mut self, event_id: u64, before: String, after: String) {
        self.assert_owner();
        if self.event(event_id).finalized {
            fail!("AlreadyFinalized({event_id})");
        }
        if !is_date(&before) || !is_date(&after) || before >= after {
            fail("BadDates");
        }
        let request = self
            .outlayer
            .dates
            .get(&event_id)
            .map_or(0, |d| d.request.saturating_add(1));
        let before_usage = env::storage_usage();
        self.outlayer.dates.insert(
            event_id,
            FomcDates {
                before,
                after,
                pending: false,
                request,
            },
        );
        self.charge_storage_or_deposit(&env::predecessor_account_id(), before_usage);
    }

    /// Anyone. Attach at least the configured deposit (all of it is
    /// forwarded; OutLayer refunds what the run does not use to the caller)
    /// and 300 Tgas. One run per event at a time.
    #[payable]
    pub fn request_resolution(&mut self, event_id: u64) -> Promise {
        let config = self
            .outlayer
            .config()
            .unwrap_or_else(|| fail("OutLayerNotConfigured"));
        let mut dates = self
            .outlayer
            .dates
            .get(&event_id)
            .cloned()
            .unwrap_or_else(|| fail!("NoOutLayerDates({event_id})"));
        let e = self.event(event_id);
        if e.finalized {
            fail!("AlreadyFinalized({event_id})");
        }
        if e.proposal_open {
            fail!("ProposalAlreadyOpen({event_id})");
        }
        if dates.pending {
            fail!("RequestInFlight({event_id})");
        }
        let deposit = env::attached_deposit();
        if deposit.as_yoctonear() < config.deposit.0 {
            fail!(
                "InsufficientDeposit({}, {})",
                config.deposit.0,
                deposit.as_yoctonear()
            );
        }
        if env::prepaid_gas() < REQUEST_GAS {
            fail!("NotEnoughGas({})", REQUEST_GAS.as_tgas());
        }
        let payer = env::predecessor_account_id();
        dates.pending = true;
        dates.request = dates.request.saturating_add(1);
        let request = dates.request;
        let args = execution_args(&config, &dates, &payer);
        self.outlayer.dates.insert(event_id, dates);
        OutLayerRequested {
            event_id,
            request,
            payer_id: &payer,
        }
        .emit();
        Promise::new(config.outlayer_id)
            .function_call(
                "request_execution".to_string(),
                args.to_string().into_bytes(),
                deposit,
                OUTLAYER_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_outlayer_result(event_id, request, payer, U128(deposit.as_yoctonear())),
            )
    }

    /// Never panics. Returns the outcome it proposed, if any. When
    /// `request_execution` itself failed, the deposit came back to this
    /// contract and is passed on to the payer.
    #[private]
    pub fn on_outlayer_result(
        &mut self,
        event_id: u64,
        request: u64,
        payer: AccountId,
        deposit: U128,
    ) -> Option<u8> {
        let current = match self.outlayer.dates.get_mut(&event_id) {
            Some(d) if d.request == request => {
                d.pending = false;
                true
            }
            _ => false,
        };
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
                return self.drop_result(event_id, request, None, "request failed");
            }
        };
        if !current {
            return self.drop_result(event_id, request, None, "stale request");
        }
        if bytes.len() > MAX_RESULT_BYTES {
            return self.drop_result(event_id, request, None, "result too long");
        }
        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => return self.drop_result(event_id, request, None, "result is not JSON"),
        };
        if value.is_null() {
            return self.drop_result(event_id, request, None, "no result");
        }
        let evidence = clip(value["evidence"].as_str().unwrap_or(""), MAX_EVIDENCE_BYTES);
        let outcome = match value["outcome"].as_u64() {
            Some(o) if o <= u64::from(u8::MAX) => o as u8,
            _ => {
                let note = if evidence.is_empty() {
                    "no outcome"
                } else {
                    evidence
                };
                return self.drop_result(event_id, request, None, note);
            }
        };
        if let Some(why) = self.cannot_propose(event_id, outcome) {
            return self.drop_result(event_id, request, Some(outcome), &why);
        }
        self.propose(event_id, outcome, Source::OutLayer);
        OutLayerResult {
            event_id,
            request,
            outcome: Some(outcome),
            proposed: true,
            note: evidence,
        }
        .emit();
        Some(outcome)
    }

    pub fn get_outlayer_config(&self) -> Option<OutLayerConfig> {
        self.outlayer.config()
    }

    pub fn get_outlayer_dates(&self, event_id: u64) -> Option<FomcDates> {
        self.outlayer.dates.get(&event_id).cloned()
    }
}

impl Contract {
    fn drop_result(
        &self,
        event_id: u64,
        request: u64,
        outcome: Option<u8>,
        note: &str,
    ) -> Option<u8> {
        OutLayerResult {
            event_id,
            request,
            outcome,
            proposed: false,
            note,
        }
        .emit();
        None
    }

    /// Why `propose` would fail, in its order, without panicking.
    fn cannot_propose(&self, event_id: u64, outcome: u8) -> Option<String> {
        let Some(e) = self.events.get(&event_id) else {
            return Some(format!("UnknownEvent({event_id})"));
        };
        if e.finalized {
            return Some(format!("AlreadyFinalized({event_id})"));
        }
        if e.proposal_open {
            return Some(format!("ProposalAlreadyOpen({event_id})"));
        }
        if usize::from(outcome) >= e.outcome_names.len() {
            return Some(format!("InvalidOutcome({outcome})"));
        }
        if now_sec()
            .checked_add(self.params.dispute_window_sec)
            .is_none()
        {
            return Some("ArithmeticOverflow".to_string());
        }
        None
    }
}

/// The arguments of OutLayer's `request_execution`, as its deployed contract
/// reads them. `resource_limits` is always set: without it OutLayer only
/// compiles. Secrets and params are left out.
pub fn execution_args(config: &OutLayerConfig, dates: &FomcDates, payer: &AccountId) -> Value {
    let input = json!({ "before": dates.before, "after": dates.after }).to_string();
    json!({
        "source": {
            "WasmUrl": {
                "url": config.wasm_url,
                "hash": config.wasm_sha256,
                "build_target": BUILD_TARGET,
            }
        },
        "resource_limits": config.resource_limits,
        "input_data": input,
        "response_format": "Json",
        "payer_account_id": payer,
    })
}

/// OutLayer's own checks on a WASM URL, so a bad one fails here instead of
/// in every request.
fn wasm_url_error(url: &str) -> Option<&'static str> {
    if !url.starts_with("https://") || url.len() <= "https://".len() {
        Some("not https")
    } else if url.len() > MAX_WASM_URL_BYTES {
        Some("too long")
    } else if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        Some("whitespace")
    } else if url.contains("EVENT_JSON") {
        Some("EVENT_JSON")
    } else {
        None
    }
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_date(s: &str) -> bool {
    s.len() == 10
        && s.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        })
}

fn clip(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}
