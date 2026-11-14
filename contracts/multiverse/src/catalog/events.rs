//! The catalogue's NEP-297 events (standard `multiverse`).

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::AccountId;

use super::{MarketParams, OpeningTerms, ProposalKind, ProposalStatus, VoidReason};
use crate::events::MultiverseEvent;
use crate::types::Asset;

macro_rules! named {
    ($ty:ty, $name:literal) => {
        impl MultiverseEvent for $ty {
            const NAME: &'static str = $name;
        }
    };
}

/// The texts and terms of a brand-new event, as `proposal_created` logs them.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct NewEventLog<'a> {
    pub question: &'a str,
    pub outcome_names: &'a [String],
    pub rule: &'a str,
    pub source: &'a str,
    pub deadline_sec: u64,
    pub category: u8,
    pub terms: OpeningTerms,
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ProposalCreated<'a> {
    pub proposal_id: u64,
    pub kind: ProposalKind,
    pub proposer: &'a AccountId,
    pub event_ids: &'a [u64],
    pub world_count: u8,
    pub goal: U128,
    pub ideal_wnear: U128,
    pub ideal_usdc: U128,
    pub s_hint: U128,
    pub expires_at_sec: u64,
    pub bond: U128,
    pub reserve: U128,
    pub new_event: Option<NewEventLog<'a>>,
}
named!(ProposalCreated<'_>, "proposal_created");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ProposalApproved {
    pub proposal_id: u64,
    pub terms: OpeningTerms,
    pub goal: U128,
    pub expires_at_sec: u64,
    pub open_not_before_sec: u64,
    pub bond_returned: U128,
}
named!(ProposalApproved, "proposal_approved");

/// `proposal_rejected` and `proposal_cancelled`.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ProposalClosedLog {
    pub proposal_id: u64,
    pub forfeited: bool,
    pub bond: U128,
}

/// `proposal_rejected`.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde", transparent)]
pub struct ProposalRejected(pub ProposalClosedLog);
named!(ProposalRejected, "proposal_rejected");

/// `proposal_cancelled`.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde", transparent)]
pub struct ProposalCancelled(pub ProposalClosedLog);
named!(ProposalCancelled, "proposal_cancelled");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ProposalSettled {
    pub proposal_id: u64,
    pub status: ProposalStatus,
    pub void_reason: VoidReason,
    pub bond_returned: U128,
    pub bond_forfeited: U128,
    pub reserve_returned: U128,
}
named!(ProposalSettled, "proposal_settled");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ProposalEvicted {
    pub proposal_id: u64,
    pub by_proposal_id: u64,
    pub event_id: u64,
}
named!(ProposalEvicted, "proposal_evicted");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ProposalToppedUp<'a> {
    pub proposal_id: u64,
    pub account_id: &'a AccountId,
    pub amount: U128,
}
named!(ProposalToppedUp<'_>, "proposal_topped_up");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Pledged<'a> {
    pub proposal_id: u64,
    pub account_id: &'a AccountId,
    pub asset: Asset,
    pub amount: U128,
    pub escrow_wnear: U128,
    pub escrow_usdc: U128,
}
named!(Pledged<'_>, "pledged");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct PledgeReturned<'a> {
    pub proposal_id: u64,
    pub account_id: &'a AccountId,
    pub wnear: U128,
    pub usdc: U128,
    /// `withdraw`, `refund` (the proposal ended without opening) or `unused`.
    pub reason: &'static str,
}
named!(PledgeReturned<'_>, "pledge_returned");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct OpenScheduled {
    pub proposal_id: u64,
}
named!(OpenScheduled, "open_scheduled");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct OpenDeferred<'a> {
    pub proposal_id: u64,
    pub blocker: &'a str,
}
named!(OpenDeferred<'_>, "open_deferred");

/// Carries the reserves an opening adds; reserve indexers must read it.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct MarketOpened<'a> {
    pub proposal_id: u64,
    pub scenario_id: u64,
    pub event_id: Option<u64>,
    pub opener: &'a AccountId,
    pub s_ref: U128,
    pub pledged_wnear: U128,
    pub pledged_usdc: U128,
    pub used_wnear: U128,
    pub used_usdc: U128,
    pub shares: U128,
    pub pool_ids: &'a [u64],
    pub unlock_at_sec: u64,
    pub storage_bytes: u64,
    pub storage_cost: U128,
}
named!(MarketOpened<'_>, "market_opened");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct SeedWithdrawn<'a> {
    pub proposal_id: u64,
    pub scenario_id: u64,
    pub account_id: &'a AccountId,
    pub shares: U128,
    pub wnear_out: U128,
    pub usdc_out: U128,
}
named!(SeedWithdrawn<'_>, "seed_withdrawn");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct MarketListingSet {
    pub scenario_id: u64,
    pub listed: bool,
}
named!(MarketListingSet, "market_listing_set");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ReferenceMarketSet {
    pub event_id: u64,
    pub scenario_id: Option<u64>,
}
named!(ReferenceMarketSet, "reference_market_set");

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct EventMetaSet {
    pub event_id: u64,
    pub category: u8,
}
named!(EventMetaSet, "event_meta_set");

/// The full params.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde", transparent)]
pub struct MarketParamsSet<'a>(pub &'a MarketParams);
named!(MarketParamsSet<'_>, "market_params_set");
