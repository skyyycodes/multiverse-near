//! The market catalogue: proposals for new markets, the pledges that fund
//! them, the opening that turns pledges into pool liquidity, the seed vault
//! that holds that liquidity for the pledgers, and the registry of listed
//! markets the app's market list reads.
//!
//! Two kinds of proposal share one record: a brand-new binary event and its
//! single-event market (`propose_event`, opened after the owner approves it)
//! and a market on 1 to 3 open events (`propose_market`, opened as soon as
//! its pledges reach the goal).

// `propose_event` takes the new event's texts and terms as its JSON
// arguments, one more than clippy's limit, also in the generated ext method.
#![allow(clippy::too_many_arguments)]

pub mod events;
mod migrate;
mod open;
mod params;
mod pledge;
mod pricing;
mod propose;
mod registry;
mod seed;
mod status;
mod views;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, IntoStorageKey};

use crate::amm::Position;
use crate::types::{Asset, WAD};
use crate::{Contract, StorageKey};

/// One NEAR in yoctoNEAR.
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// Everything the catalogue stores. Root bytes: 8 + 16 + 12 x 5 = 84.
#[near(serializers = [borsh])]
pub struct Catalog {
    /// Last id; ids start at 1.
    pub proposal_count: u64,
    /// yoctoNEAR; forfeited bonds; spent only on opening storage.
    pub storage_fund: u128,
    pub proposals: LookupMap<u64, VProposal>,
    pub texts: LookupMap<u64, ProposalText>,
    pub pledges: LookupMap<(u64, AccountId), Pledge>,
    pub accounts: LookupMap<AccountId, AccountMarkets>,
    /// Live Kind B per canonical key.
    pub proposal_by_set: LookupMap<EventSetKey, u64>,
    /// Live Kind B ids containing the event, <= 16.
    pub live_of_event: LookupMap<u64, Vec<u64>>,
    /// Live Kind A per normalised question.
    pub question_hashes: LookupMap<[u8; 32], u64>,
    pub registry: LookupMap<u64, VMarketEntry>,
    /// The one listed market per key.
    pub listed_by_set: LookupMap<EventSetKey, u64>,
    /// Event -> scenario.
    pub reference_market: LookupMap<u64, u64>,
    /// Scenario id.
    pub seed_vaults: LookupMap<u64, VSeedVault>,
    pub event_meta: LookupMap<u64, EventMeta>,
}

impl Catalog {
    pub fn new() -> Self {
        Self {
            proposal_count: 0,
            storage_fund: 0,
            proposals: LookupMap::new(StorageKey::Proposals),
            texts: LookupMap::new(StorageKey::ProposalTexts),
            pledges: LookupMap::new(StorageKey::Pledges),
            accounts: LookupMap::new(StorageKey::AccountMarkets),
            proposal_by_set: LookupMap::new(StorageKey::ProposalBySet),
            live_of_event: LookupMap::new(StorageKey::LiveProposalsOfEvent),
            question_hashes: LookupMap::new(StorageKey::QuestionHashes),
            registry: LookupMap::new(StorageKey::MarketRegistry),
            listed_by_set: LookupMap::new(StorageKey::ListedBySet),
            reference_market: LookupMap::new(StorageKey::ReferenceMarkets),
            seed_vaults: LookupMap::new(StorageKey::SeedVaults),
            event_meta: LookupMap::new(StorageKey::EventMeta),
        }
    }

    /// Writes out every buffered map (see `Contract::flush_state`).
    pub fn flush(&mut self) {
        self.proposals.flush();
        self.texts.flush();
        self.pledges.flush();
        self.accounts.flush();
        self.proposal_by_set.flush();
        self.live_of_event.flush();
        self.question_hashes.flush();
        self.registry.flush();
        self.listed_by_set.flush();
        self.reference_market.flush();
        self.seed_vaults.flush();
        self.event_meta.flush();
    }

    /// Whether `a` has a pledge, a seed claim or a live proposal here (one
    /// read); it blocks `storage_unregister`.
    pub fn account_busy(&self, a: &AccountId) -> bool {
        self.accounts
            .get(a)
            .is_some_and(|m| !m.pledges.is_empty() || !m.proposals.is_empty())
    }
}

impl Default for Catalog {
    fn default() -> Self {
        Self::new()
    }
}

/// Canonical event set: ids ascending, zero-padded (0 is never an event id).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct EventSetKey(pub [u64; 3]);

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProposalKind {
    NewEvent,
    Market,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProposalStatus {
    Review,
    Pledging,
    Opened,
    Rejected,
    Cancelled,
    Expired,
    Void,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoidReason {
    None,
    ReviewTimeout,
    EventResolved,
    EventFull,
    MarketExists,
    Evicted,
}

/// How a brand-new event opens: the odds of outcome 0 and one wNEAR price
/// multiplier per outcome, in basis points.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpeningTerms {
    pub odds0_bps: u16,
    pub mult_bps: [u16; 2],
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VProposal {
    V1(Proposal),
}

/// Every field fixed-size: status changes never resize the record (~470 B).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proposal {
    pub kind: ProposalKind,
    /// Stored; the effective status is derived lazily.
    pub status: ProposalStatus,
    pub void_reason: VoidReason,
    pub proposer: AccountId,
    /// B: canonical ids; A: [0;3] until open, then [event_id, 0, 0].
    pub key: EventSetKey,
    pub world_count: u8,
    /// A only (< 16); B: 0.
    pub category: u8,
    /// A only; B: zeros.
    pub terms: OpeningTerms,
    /// Usable value at opening, internal USDC.
    pub goal: u128,
    pub ideal_wnear: u128,
    pub ideal_usdc: u128,
    /// S_ref when the goal was set.
    pub s_hint: u128,
    /// WAD, snapshot of beta_bps.
    pub beta: u128,
    /// Snapshot.
    pub seed_lock_sec: u64,
    pub created_at_sec: u64,
    /// A: at approval; B: = created.
    pub approved_at_sec: u64,
    /// A: 0 until approved.
    pub expires_at_sec: u64,
    /// Notice after the owner re-terms Kind A.
    pub open_not_before_sec: u64,
    /// A: proposer's; B: min over the events' deadlines (0 = none).
    pub deadline_sec: u64,
    /// Before open: Σ pledges; after: unused owed + dust.
    pub escrow_wnear: u128,
    pub escrow_usdc: u128,
    /// Live pledge records.
    pub pledgers: u32,
    /// After open: records whose unused part is unpaid.
    pub unused_open: u32,
    /// yocto held; 0 once returned or forfeited.
    pub bond: u128,
    /// yocto held for opening storage.
    pub reserve: u128,
    pub open_scheduled_block: u64,
    /// Zeroed until opened.
    pub open: OpenRecord,
}

/// What an opening used, frozen at open.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenRecord {
    pub scenario_id: u64,
    pub opened_at_sec: u64,
    pub s_ref: u128,
    /// PW, PU.
    pub pledged_wnear: u128,
    pub pledged_usdc: u128,
    /// UW, UU.
    pub used_wnear: u128,
    pub used_usdc: u128,
    /// T.
    pub shares: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposalText {
    pub question: String,
    pub outcome_names: Vec<String>,
    pub rule: String,
    pub source: String,
}

/// ~170 bytes with key.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pledge {
    pub wnear: u128,
    pub usdc: u128,
    pub withdrawn_shares: u128,
    pub unused_paid: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountMarkets {
    /// <= max_pledges_per_account.
    pub pledges: Vec<u64>,
    /// Live, <= max_active_per_account.
    pub proposals: Vec<u64>,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketOrigin {
    Legacy,
    Owner,
    Pledged,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VMarketEntry {
    V1(MarketEntry),
}

/// A scenario without a record reads as `{listed: false, origin: Legacy if
/// sid <= legacy_scenario_count else Owner, proposal_id: 0, created_at_sec:
/// 0}`; the owner path writes no record.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketEntry {
    pub listed: bool,
    pub origin: MarketOrigin,
    pub proposal_id: u64,
    pub created_at_sec: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventMeta {
    /// 0 = owner.
    pub proposal_id: u64,
    pub proposer: Option<AccountId>,
    /// <= 256 bytes.
    pub source: String,
    /// < 16.
    pub category: u8,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VSeedVault {
    V1(SeedVault),
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedVault {
    pub proposal_id: u64,
    pub supply: u128,
    pub unlock_at_sec: u64,
    /// W world pools in world order, then W-1 odds pools in pairs() order.
    pub positions: Vec<SeedPosition>,
    /// Custody leftovers and booked fees; no zero entries.
    pub idle: Vec<IdleToken>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedPosition {
    pub pool_id: u64,
    pub position: Position,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IdleToken {
    pub asset: Asset,
    pub mask: u8,
    pub amount: u128,
}

/// The catalogue's parameters (raw key 0x1d); amounts in NEAR are yocto,
/// amounts in USDC and wNEAR internal units. 33 fields.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketParams {
    pub bond_new_event: U128,
    pub bond_market: U128,
    pub reserve_base: U128,
    pub reserve_per_world: U128,
    pub proposal_ttl_sec: u64,
    pub review_ttl_sec: u64,
    pub min_pledge_window_sec: u64,
    pub min_market_life_sec: u64,
    pub notice_sec: u64,
    pub seed_lock_sec: u64,
    pub evict_min_age_sec: u64,
    pub spam_floor_bps: u16,
    pub goal_depth_usdc: U128,
    pub min_open_depth_usdc: U128,
    pub min_goal_usdc: U128,
    pub goal_round_usdc: U128,
    pub beta_bps: u16,
    pub odds_clamp_bps: u16,
    pub mult_a_bps: [u16; 2],
    pub mult_b_bps: [u16; 2],
    pub anchors: [u64; 3],
    pub max_anchor_divergence_bps: u16,
    pub max_reference_divergence_bps: u16,
    pub min_reference_depth_usdc: U128,
    pub min_reference_odds_depth_usdc: U128,
    pub require_external: bool,
    pub max_external_divergence_bps: u16,
    pub min_pledge_usdc: U128,
    pub min_pledge_wnear: U128,
    pub max_pledges_per_account: u8,
    pub max_active_per_account: u8,
    pub max_live_per_event: u8,
    pub seed_depth_floor: bool,
}

impl MarketParams {
    /// The testnet column: what `new()` writes and `migrate` writes unless it
    /// is given params. No anchors.
    pub fn testnet_defaults() -> Self {
        Self {
            bond_new_event: U128(NEAR / 5),
            bond_market: U128(NEAR / 20),
            reserve_base: U128(NEAR / 20),
            reserve_per_world: U128(NEAR / 40),
            proposal_ttl_sec: 1_209_600,
            review_ttl_sec: 1_209_600,
            min_pledge_window_sec: 86_400,
            min_market_life_sec: 259_200,
            notice_sec: 3_600,
            seed_lock_sec: 604_800,
            evict_min_age_sec: 259_200,
            spam_floor_bps: 1_000,
            goal_depth_usdc: U128(15_000 * WAD),
            min_open_depth_usdc: U128(10_000 * WAD),
            min_goal_usdc: U128(10_000 * WAD),
            goal_round_usdc: U128(1_000 * WAD),
            beta_bps: 2_500,
            odds_clamp_bps: 100,
            mult_a_bps: [5_000, 20_000],
            mult_b_bps: [2_000, 50_000],
            anchors: [0, 0, 0],
            max_anchor_divergence_bps: 300,
            max_reference_divergence_bps: 1_000,
            min_reference_depth_usdc: U128(10_000 * WAD),
            min_reference_odds_depth_usdc: U128(1_000 * WAD),
            require_external: false,
            max_external_divergence_bps: 1_000,
            min_pledge_usdc: U128(10 * WAD),
            min_pledge_wnear: U128(3 * WAD),
            max_pledges_per_account: 32,
            max_active_per_account: 4,
            max_live_per_event: 16,
            seed_depth_floor: true,
        }
    }
}

// The JSON shapes of the catalogue's views and returns.

/// What a pledge withdrawal or an unused-part claim paid out.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PledgeReturn {
    pub wnear: U128,
    pub usdc: U128,
}

/// `market_params()`: the params and the opening reserve at 2, 4 and 8 worlds.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketParamsView {
    pub params: MarketParams,
    pub reserve_w2: U128,
    pub reserve_w4: U128,
    pub reserve_w8: U128,
    pub storage_fund: U128,
}

/// A proposal's status as the proposal page shows it: `ready` and `waiting`
/// split a pledging proposal by whether it can open now.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProposalViewStatus {
    Review,
    Pledging,
    Ready,
    Waiting,
    Opened,
    Rejected,
    Cancelled,
    Expired,
    Void,
}

/// The texts and terms of a brand-new event.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewEventView {
    pub question: String,
    pub outcome_names: Vec<String>,
    pub rule: String,
    pub source: String,
    pub deadline_sec: u64,
    pub category: u8,
    pub terms: OpeningTerms,
}

/// `NewEventView` without the rule and the source, for lists.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewEventSummary {
    pub question: String,
    pub outcome_names: Vec<String>,
    pub deadline_sec: u64,
    pub category: u8,
    pub terms: OpeningTerms,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenedView {
    pub scenario_id: u64,
    pub opened_at_sec: u64,
    pub s_ref: U128,
    pub shares: U128,
    pub unlock_at_sec: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposalView {
    pub proposal_id: u64,
    pub kind: ProposalKind,
    pub proposer: AccountId,
    pub status: ProposalViewStatus,
    pub void_reason: Option<VoidReason>,
    pub blocker: Option<String>,
    pub event_ids: Vec<u64>,
    pub world_count: u8,
    pub new_event: Option<NewEventView>,
    pub category: u8,
    pub deadline_sec: u64,
    pub created_at_sec: u64,
    pub approved_at_sec: u64,
    pub expires_at_sec: u64,
    pub open_not_before_sec: u64,
    pub goal: U128,
    pub ideal_wnear: U128,
    pub ideal_usdc: U128,
    pub s_hint: U128,
    pub pledged_wnear: U128,
    pub pledged_usdc: U128,
    pub pledgers: u32,
    pub progress_bps: u32,
    pub bond: U128,
    pub reserve: U128,
    pub seed_lock_sec: u64,
    pub preview: Option<OpeningPreview>,
    pub opened: Option<OpenedView>,
}

/// `ProposalView` without the preview, the new event's rule and source, and
/// the ready/waiting split.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposalSummary {
    pub proposal_id: u64,
    pub kind: ProposalKind,
    pub proposer: AccountId,
    pub status: ProposalStatus,
    pub void_reason: Option<VoidReason>,
    pub blocker: Option<String>,
    pub event_ids: Vec<u64>,
    pub world_count: u8,
    pub new_event: Option<NewEventSummary>,
    pub category: u8,
    pub deadline_sec: u64,
    pub created_at_sec: u64,
    pub approved_at_sec: u64,
    pub expires_at_sec: u64,
    pub open_not_before_sec: u64,
    pub goal: U128,
    pub ideal_wnear: U128,
    pub ideal_usdc: U128,
    pub s_hint: U128,
    pub pledged_wnear: U128,
    pub pledged_usdc: U128,
    pub pledgers: u32,
    pub progress_bps: u32,
    pub bond: U128,
    pub reserve: U128,
    pub seed_lock_sec: u64,
    pub opened: Option<OpenedView>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposalList {
    pub proposals: Vec<ProposalSummary>,
    pub next_from: Option<u64>,
}

/// An anchor market and the spot it implies.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnchorView {
    pub scenario_id: u64,
    pub implied: U128,
}

/// The reference market of one event of a combination.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReferenceView {
    pub event_id: u64,
    pub scenario_id: u64,
    pub odds0: U128,
    pub ratio0: U128,
    pub ratio1: U128,
    pub implied: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldPoolPlan {
    pub world: u8,
    pub wnear: U128,
    pub usdc: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OddsPoolPlan {
    pub mask0: u8,
    pub mask1: u8,
    pub amount0: U128,
    pub amount1: U128,
}

/// A token and an amount of it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenAmount {
    pub token_id: String,
    pub amount: U128,
}

/// What an opening would do now. The planned amounts are computed from the
/// current pledges even when `can_open` is false.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpeningPreview {
    pub can_open: bool,
    pub blocker: Option<String>,
    pub s_ref: Option<U128>,
    pub anchors: Vec<AnchorView>,
    pub references: Vec<ReferenceView>,
    pub odds: Vec<U128>,
    pub prices: Vec<U128>,
    pub usable_value: U128,
    pub used_wnear: U128,
    pub used_usdc: U128,
    pub unused_wnear: U128,
    pub unused_usdc: U128,
    pub world_pools: Vec<WorldPoolPlan>,
    pub odds_pools: Vec<OddsPoolPlan>,
    pub idle: Vec<TokenAmount>,
    pub idle_value: U128,
    pub thinnest_world_usdc: U128,
    pub needs: Option<Asset>,
    pub storage_estimate: U128,
    pub reserve_available: U128,
}

#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PledgeState {
    Pledged,
    Refundable,
    Seed,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PledgeView {
    pub proposal_id: u64,
    pub account_id: AccountId,
    pub wnear: U128,
    pub usdc: U128,
    pub state: PledgeState,
    pub shares: Option<U128>,
    pub withdrawn_shares: U128,
    pub unused_wnear: U128,
    pub unused_usdc: U128,
    pub unused_paid: bool,
    pub unlock_at_sec: u64,
    pub max_withdrawable_shares: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PledgePreview {
    pub usable_before: U128,
    pub usable_after: U128,
    pub deployed_part: U128,
    pub goal_reached_after: bool,
    pub needs: Option<Asset>,
}

/// `market_check(event_ids)`: `propose_market`'s checks without panicking.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketCheck {
    pub canonical: Vec<u64>,
    pub world_count: u8,
    pub blocker: Option<String>,
    pub listed_market: Option<u64>,
    pub live_proposal: Option<u64>,
    pub goal: U128,
    pub ideal_wnear: U128,
    pub ideal_usdc: U128,
    pub bond: U128,
    pub reserve: U128,
    pub expires_at_sec: u64,
}

/// `event_check(..)`: `propose_event`'s checks from `BadTerms` on, without
/// panicking.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventCheckView {
    pub blocker: Option<String>,
    pub live_proposal: Option<u64>,
    pub goal: U128,
    pub ideal_wnear: U128,
    pub ideal_usdc: U128,
    pub s_ref: Option<U128>,
    pub odds: [U128; 2],
    pub prices: [U128; 2],
    pub bond: U128,
    pub reserve: U128,
}

#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketCardStatus {
    Open,
    Deciding,
    PartlyResolved,
    Resolved,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedSummary {
    pub proposal_id: u64,
    pub supply: U128,
    pub unlock_at_sec: u64,
}

/// One market of the list.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketCard {
    pub scenario_id: u64,
    pub listed: bool,
    pub origin: MarketOrigin,
    pub proposal_id: Option<u64>,
    pub event_ids: Vec<u64>,
    pub world_count: u8,
    pub possible: u8,
    pub status: MarketCardStatus,
    pub categories: Vec<u8>,
    pub deadline_sec: u64,
    pub created_at_sec: u64,
    pub odds: Vec<U128>,
    pub odds_known: bool,
    pub world_prices: Vec<U128>,
    pub implied_spot: U128,
    pub pool_value: U128,
    pub min_world_depth: U128,
    pub pool_count: u32,
    pub lendable: bool,
    pub seed: Option<SeedSummary>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketList {
    pub markets: Vec<MarketCard>,
    pub next_from: Option<u64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelatedMarket {
    pub scenario_id: u64,
    pub event_ids: Vec<u64>,
    pub world_count: u8,
    pub status: MarketCardStatus,
    pub listed: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelatedMarkets {
    pub markets: Vec<RelatedMarket>,
    pub proposals: Vec<ProposalSummary>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketOfEvents {
    pub canonical: Vec<u64>,
    pub listed_market: Option<u64>,
    pub live_proposal: Option<u64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventMetaView {
    pub event_id: u64,
    pub proposal_id: u64,
    pub proposer: Option<AccountId>,
    pub source: String,
    pub category: u8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedPositionView {
    pub pool_id: u64,
    pub liquidity: U128,
    pub amount0: U128,
    pub amount1: U128,
    pub fees0: U128,
    pub fees1: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedVaultView {
    pub proposal_id: u64,
    pub supply: U128,
    pub unlock_at_sec: u64,
    pub positions: Vec<SeedPositionView>,
    pub idle: Vec<TokenAmount>,
}

/// Per world, what an account would hold before the merge.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PerWorldAmounts {
    pub wnear: Vec<U128>,
    pub usdc: Vec<U128>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedWithdrawPreview {
    pub wnear_out: U128,
    pub usdc_out: U128,
    pub tokens: Vec<TokenAmount>,
    pub max_shares: U128,
    pub locked_until_sec: u64,
    pub per_world: PerWorldAmounts,
}

/// `Err` carries the error in house format; entry points panic with it,
/// views report it.
pub(crate) type Check<T> = Result<T, String>;

/// Basis points per 1.0.
const BPS_DENOM: u128 = 10_000;
/// One basis point in WAD.
const BPS_WAD: u128 = 100_000_000_000_000;
/// Most texts and ids a view or record carries.
const MAX_SOURCE_BYTES: usize = 256;
/// Categories are 0..16.
const CATEGORIES: u8 = 16;

impl EventSetKey {
    /// Canonical key of an event set: ids ascending, zero-padded.
    pub fn of(ids: &[u64]) -> Self {
        let mut sorted = ids.to_vec();
        sorted.sort_unstable();
        let mut key = [0u64; 3];
        for (slot, id) in key.iter_mut().zip(sorted) {
            *slot = id;
        }
        EventSetKey(key)
    }

    /// The ids, ascending, without the padding.
    pub fn ids(&self) -> Vec<u64> {
        self.0.iter().copied().filter(|id| *id != 0).collect()
    }
}

impl ProposalStatus {
    /// Rejected, cancelled, expired or void: nothing can revive it.
    pub fn is_terminal(self) -> bool {
        !matches!(
            self,
            ProposalStatus::Review | ProposalStatus::Pledging | ProposalStatus::Opened
        )
    }

    /// The JSON name, as error texts print it.
    pub fn name(self) -> &'static str {
        match self {
            ProposalStatus::Review => "review",
            ProposalStatus::Pledging => "pledging",
            ProposalStatus::Opened => "opened",
            ProposalStatus::Rejected => "rejected",
            ProposalStatus::Cancelled => "cancelled",
            ProposalStatus::Expired => "expired",
            ProposalStatus::Void => "void",
        }
    }
}

impl Proposal {
    /// The events of the market: a combination's canonical ids, a new event's
    /// id once opened (none before).
    pub fn event_ids(&self) -> Vec<u64> {
        self.key.ids()
    }

    /// Escrow valued in USDC at the price the goal was set at.
    pub fn pledged_value(&self) -> u128 {
        self.escrow_usdc.saturating_add(
            multiverse_math::checked_mul_div(
                self.escrow_wnear,
                self.s_hint,
                WAD,
                multiverse_math::Rounding::Down,
            )
            .unwrap_or(u128::MAX),
        )
    }

    /// Under the spam floor: pledged value at `s_hint` below `floor_bps` of
    /// the goal.
    pub fn under_floor(&self, floor_bps: u16) -> bool {
        let floor = multiverse_math::checked_mul_div(
            self.goal,
            u128::from(floor_bps),
            BPS_DENOM,
            multiverse_math::Rounding::Down,
        )
        .unwrap_or(u128::MAX);
        self.pledged_value() < floor
    }

    fn unwrap(v: &VProposal) -> &Proposal {
        match v {
            VProposal::V1(p) => p,
        }
    }
}

impl SeedVault {
    fn unwrap(v: &VSeedVault) -> &SeedVault {
        match v {
            VSeedVault::V1(s) => s,
        }
    }
}

impl MarketParams {
    /// NEAR an opening of `world_count` worlds sets aside for its storage.
    pub fn reserve_for(&self, world_count: u8) -> u128 {
        self.reserve_base.0.saturating_add(
            self.reserve_per_world
                .0
                .saturating_mul(u128::from(world_count)),
        )
    }
}

/// `sha256(lowercase_ascii(trim(question)))`: one live new-event proposal
/// per question.
pub(crate) fn question_hash(question: &str) -> [u8; 32] {
    let normal = question.trim().to_ascii_lowercase();
    let digest = env::sha256(normal.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

impl Contract {
    /// The stored params (raw key 0x1d); the testnet column if none.
    pub(crate) fn market_params_stored(&self) -> MarketParams {
        env::storage_read(&StorageKey::MarketParams.into_storage_key())
            .and_then(|bytes| near_sdk::borsh::from_slice(&bytes).ok())
            .unwrap_or_else(MarketParams::testnet_defaults)
    }

    /// Writes the params through to their raw key.
    pub(crate) fn write_market_params(&mut self, params: &MarketParams) {
        let bytes = near_sdk::borsh::to_vec(params).unwrap_or_else(|_| env::abort());
        env::storage_write(&StorageKey::MarketParams.into_storage_key(), &bytes);
    }

    pub(crate) fn get_proposal_record(&self, pid: u64) -> Option<Proposal> {
        self.catalog
            .proposals
            .get(&pid)
            .map(|v| Proposal::unwrap(v).clone())
    }

    /// The proposal, or `UnknownProposal(pid)`.
    pub(crate) fn proposal_or(&self, pid: u64) -> Check<Proposal> {
        self.get_proposal_record(pid)
            .ok_or_else(|| format!("UnknownProposal({pid})"))
    }

    pub(crate) fn proposal_record(&self, pid: u64) -> Proposal {
        self.proposal_or(pid)
            .unwrap_or_else(|e| crate::errors::fail(&e))
    }

    pub(crate) fn save_proposal(&mut self, pid: u64, p: Proposal) {
        self.catalog.proposals.insert(pid, VProposal::V1(p));
    }

    pub(crate) fn seed_vault_record(&self, sid: u64) -> Option<SeedVault> {
        self.catalog
            .seed_vaults
            .get(&sid)
            .map(|v| SeedVault::unwrap(v).clone())
    }

    pub(crate) fn account_markets(&self, a: &AccountId) -> AccountMarkets {
        self.catalog.accounts.get(a).cloned().unwrap_or_default()
    }

    /// Stores `a`'s catalogue entry, removing it once it lists nothing.
    pub(crate) fn set_account_markets(&mut self, a: &AccountId, m: AccountMarkets) {
        if m.pledges.is_empty() && m.proposals.is_empty() {
            self.catalog.accounts.remove(a);
        } else {
            self.catalog.accounts.insert(a.clone(), m);
        }
    }

    /// The escrow funnel: `books.pledges` follows every escrow change.
    pub(crate) fn escrow_books(&mut self, asset: Asset, amount: u128, up: bool) {
        let slot = &mut self.books.pledges[crate::books::asset_index(asset)];
        *slot = if up {
            slot.saturating_add(amount)
        } else {
            slot.saturating_sub(amount)
        };
    }
}
