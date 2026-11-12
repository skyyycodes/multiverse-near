//! Event logs. Protocol events use NEP-297 with standard "multiverse":
//! `EVENT_JSON:{"standard":"multiverse","version":"1.0.0","event":"split","data":[{...}]}`.
//! Every change to a user's verse balance also logs a NEP-245 `mt_mint`,
//! `mt_burn` or `mt_transfer`, so indexers and wallets can follow positions.
//!
//! A receipt may log at most 100 lines and 16 KiB in total, so events carry
//! ids and amounts, not names or labels the views can derive.

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{env, near, serde_json, AccountId};

use crate::types::{Asset, Source};

pub const STANDARD: &str = "multiverse";
pub const VERSION: &str = "1.0.0";

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Envelope<'a, T> {
    standard: &'static str,
    version: &'static str,
    event: &'static str,
    data: [&'a T; 1],
}

/// A NEP-297 event of the "multiverse" standard. Any module can add one: a
/// `Serialize` struct (its fields appear in declaration order) plus
/// `impl MultiverseEvent for Swap<'_> { const NAME: &'static str = "swap"; }`.
pub trait MultiverseEvent: Serialize + Sized {
    /// The snake_case `event` field.
    const NAME: &'static str;

    fn emit(&self) {
        let envelope = Envelope {
            standard: STANDARD,
            version: VERSION,
            event: Self::NAME,
            data: [self],
        };
        let json = serde_json::to_string(&envelope).unwrap_or_else(|_| env::abort());
        env::log_str(&format!("EVENT_JSON:{json}"));
    }
}

macro_rules! named {
    ($ty:ty, $name:literal) => {
        impl MultiverseEvent for $ty {
            const NAME: &'static str = $name;
        }
    };
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct EventCreated<'a> {
    pub event_id: u64,
    pub question: &'a str,
    pub outcome_names: &'a [String],
    pub rule: &'a str,
    pub deadline_sec: u64,
}
named!(EventCreated<'_>, "event_created");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct OutcomeProposed {
    pub event_id: u64,
    pub outcome: u8,
    pub source: Source,
    pub finalizable_at_sec: u64,
}
named!(OutcomeProposed, "outcome_proposed");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ProposalDisputed {
    pub event_id: u64,
    pub outcome: u8,
}
named!(ProposalDisputed, "proposal_disputed");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct EventFinalized<'a> {
    pub event_id: u64,
    pub outcome: u8,
    pub scenario_ids: &'a [u64],
}
named!(EventFinalized<'_>, "event_finalized");

/// Logged after `outcome_proposed`: who reported and with what evidence.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ReportReceived<'a> {
    pub event_id: u64,
    pub outcome: u8,
    pub reporter_id: &'a AccountId,
    pub evidence: &'a str,
}
named!(ReportReceived<'_>, "report_received");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ReporterSet<'a> {
    pub reporter_id: Option<&'a AccountId>,
}
named!(ReporterSet<'_>, "reporter_set");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct DisputeWindowSet {
    pub dispute_window_sec: u64,
}
named!(DisputeWindowSet, "dispute_window_set");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ScenarioCreated<'a> {
    pub scenario_id: u64,
    pub event_ids: &'a [u64],
    pub world_count: u8,
}
named!(ScenarioCreated<'_>, "scenario_created");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct WorldsRemoved {
    pub scenario_id: u64,
    pub event_id: u64,
    pub outcome: u8,
    pub removed: u8,
    pub possible: u8,
}
named!(WorldsRemoved, "worlds_removed");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Split<'a> {
    pub account_id: &'a AccountId,
    pub scenario_id: u64,
    pub asset: Asset,
    pub from_mask: u8,
    pub to_masks: &'a [u8],
    pub amount: U128,
}
named!(Split<'_>, "split");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Merged<'a> {
    pub account_id: &'a AccountId,
    pub scenario_id: u64,
    pub asset: Asset,
    pub from_masks: &'a [u8],
    pub to_mask: u8,
    pub amount: U128,
}
named!(Merged<'_>, "merged");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Redeemed<'a> {
    pub account_id: &'a AccountId,
    pub scenario_id: u64,
    pub asset: Asset,
    pub mask: u8,
    pub amount: U128,
}
named!(Redeemed<'_>, "redeemed");

/// Real wNEAR/USDC credited to the internal balance by a plain deposit.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct RealDeposit<'a> {
    pub account_id: &'a AccountId,
    pub asset: Asset,
    pub amount: U128,
}
named!(RealDeposit<'_>, "real_deposit");

/// The internal balance sent out by `withdraw`, in internal units.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct RealWithdraw<'a> {
    pub account_id: &'a AccountId,
    pub asset: Asset,
    pub amount: U128,
}
named!(RealWithdraw<'_>, "real_withdraw");

/// An `ft_transfer` out failed (usually: the receiver is not registered with
/// the token) and the amount went back to the internal balance instead.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct PayoutFailed<'a> {
    pub account_id: &'a AccountId,
    pub asset: Asset,
    pub token_amount: U128,
    pub credited: U128,
}
named!(PayoutFailed<'_>, "payout_failed");

/// Sub-unit dust left in a leaving account's internal balance. It cannot be
/// paid out, so `storage_unregister` moves it to the contract's own balance.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct DustSwept<'a> {
    pub account_id: &'a AccountId,
    pub asset: Asset,
    pub amount: U128,
}
named!(DustSwept<'_>, "dust_swept");

// NEP-245 events, standard "nep245" version "1.0.0". Optional fields are left
// out of the JSON when absent, as the standard's interfaces mark them `?`.

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct MtMintLog<'a> {
    pub owner_id: &'a AccountId,
    pub token_ids: &'a [String],
    pub amounts: &'a [U128],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<&'a str>,
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct MtBurnLog<'a> {
    pub owner_id: &'a AccountId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorized_id: Option<&'a AccountId>,
    pub token_ids: &'a [String],
    pub amounts: &'a [U128],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<&'a str>,
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct MtTransferLog<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorized_id: Option<&'a AccountId>,
    pub old_owner_id: &'a AccountId,
    pub new_owner_id: &'a AccountId,
    pub token_ids: &'a [String],
    pub amounts: &'a [U128],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<&'a str>,
}

#[near(event_json(standard = "nep245"))]
pub enum MtEvent<'a> {
    #[event_version("1.0.0")]
    MtMint(&'a [MtMintLog<'a>]),
    #[event_version("1.0.0")]
    MtBurn(&'a [MtBurnLog<'a>]),
    #[event_version("1.0.0")]
    MtTransfer(&'a [MtTransferLog<'a>]),
}
