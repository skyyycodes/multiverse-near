//! Shared types: assets, verse keys and their NEP-245 token ids, the stored
//! oracle and scenario records, and the JSON shapes of the core views.

use std::fmt;

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use crate::masks;

/// 1.0 in the 18-decimal fixed point every internal amount uses.
pub const WAD: u128 = 1_000_000_000_000_000_000;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Asset {
    Wnear,
    Usdc,
}

impl Asset {
    pub const ALL: [Asset; 2] = [Asset::Wnear, Asset::Usdc];

    pub fn as_str(self) -> &'static str {
        match self {
            Asset::Wnear => "wnear",
            Asset::Usdc => "usdc",
        }
    }

    pub fn parse(s: &str) -> Option<Asset> {
        match s {
            "wnear" => Some(Asset::Wnear),
            "usdc" => Some(Asset::Usdc),
            _ => None,
        }
    }
}

impl fmt::Display for Asset {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A NEP-141 token the protocol accepts. `symbol` and `decimals` are supplied
/// by the owner at init (the deploy script reads `ft_metadata` first).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetCfg {
    pub token_id: AccountId,
    pub symbol: String,
    pub decimals: u8,
}

/// Most decimals a configured token may have (wNEAR has 24).
pub const MAX_DECIMALS: u8 = 24;

impl AssetCfg {
    /// `10^|18 - decimals|`: internal units per raw unit up to 18 decimals,
    /// raw units per internal unit above.
    fn factor(&self) -> u128 {
        10u128.pow(u32::from(self.decimals.abs_diff(18)))
    }

    /// Raw token units to internal units, with the raw remainder that has no
    /// internal unit. Up to 18 decimals it is exact (`raw * 10^(18-d)`, the
    /// remainder 0); above, `floor(raw / 10^(d-18))` and the remainder is
    /// `raw % 10^(d-18)`, which never enters the ledger. `None` if the internal
    /// amount does not fit a `u128`.
    pub fn to_internal(&self, raw: u128) -> Option<(u128, u128)> {
        let f = self.factor();
        if self.decimals <= 18 {
            raw.checked_mul(f).map(|internal| (internal, 0))
        } else {
            Some((raw / f, raw % f))
        }
    }

    /// Internal units to raw token units, with the internal dust below one
    /// raw unit. Up to 18 decimals `floor(internal / 10^(18-d))` and the dust
    /// is the remainder; above, `internal * 10^(d-18)` exactly, no dust. `None`
    /// if the raw amount does not fit a `u128`.
    pub fn to_raw(&self, internal: u128) -> Option<(u128, u128)> {
        let f = self.factor();
        if self.decimals <= 18 {
            Some((internal / f, internal % f))
        } else {
            internal.checked_mul(f).map(|raw| (raw, 0))
        }
    }

    /// The smallest internal amount that pays out at least one raw unit.
    pub fn min_payable(&self) -> u128 {
        if self.decimals <= 18 {
            self.factor()
        } else {
            1
        }
    }
}

/// Protocol parameters. Fees are in pips (1e6 = 100%), ratios in WAD.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Params {
    pub dispute_window_sec: u64,
    pub twap_window_sec: u64,
    pub min_pool_depth: u128,
    pub lltv: u128,
    pub liquidation_bonus: u128,
    pub borrow_rate_per_sec: u128,
    pub fee_base_pips: u32,
    pub fee_cap_pips: u32,
}

impl Params {
    pub fn new(dispute_window_sec: u64) -> Self {
        Self {
            dispute_window_sec,
            twap_window_sec: 1_800,
            min_pool_depth: 10_000 * WAD,
            lltv: 750_000_000_000_000_000,
            liquidation_bonus: 50_000_000_000_000_000,
            borrow_rate_per_sec: 1_585_489_599,
            fee_base_pips: 3_000,
            fee_cap_pips: 15_000,
        }
    }
}

/// One verse position: pays 1 unit of `asset` if the world that comes true is
/// in `mask`. Never the root mask, which is the real asset itself.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct VerseKey {
    pub scenario: u64,
    pub asset: Asset,
    pub mask: u8,
}

impl VerseKey {
    pub fn new(scenario: u64, asset: Asset, mask: u8) -> Self {
        Self {
            scenario,
            asset,
            mask,
        }
    }

    /// NEP-245 token id, e.g. `"1:wnear:14"`.
    pub fn token_id(&self) -> String {
        format!("{}:{}:{}", self.scenario, self.asset, self.mask)
    }

    /// Inverse of `token_id`. Only the canonical spelling parses, so a
    /// position has exactly one id ("01:wnear:14" and "+1:wnear:14" do not).
    pub fn parse(token_id: &str) -> Option<Self> {
        let mut parts = token_id.split(':');
        let (scenario, asset, mask) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() {
            return None;
        }
        let key = Self::new(
            scenario.parse().ok()?,
            Asset::parse(asset)?,
            mask.parse().ok()?,
        );
        (key.token_id() == token_id).then_some(key)
    }
}

/// Who proposed an event's outcome, as the views and logs spell it. Kept in
/// state because the app cannot read past logs on NEAR.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Admin,
    Reporter,
    OutLayer,
}

/// `Source` as stored. A plain enum rather than an `Option` so that a first
/// proposal does not grow the record: the reporter signs with a function-call
/// key, which cannot attach a deposit to pay for storage.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProposedBy {
    Nobody,
    Admin,
    Reporter,
    OutLayer,
}

impl ProposedBy {
    pub fn source(self) -> Option<Source> {
        match self {
            ProposedBy::Nobody => None,
            ProposedBy::Admin => Some(Source::Admin),
            ProposedBy::Reporter => Some(Source::Reporter),
            ProposedBy::OutLayer => Some(Source::OutLayer),
        }
    }
}

impl From<Source> for ProposedBy {
    fn from(source: Source) -> Self {
        match source {
            Source::Admin => ProposedBy::Admin,
            Source::Reporter => ProposedBy::Reporter,
            Source::OutLayer => ProposedBy::OutLayer,
        }
    }
}

/// A binary event. `proposed_at_sec`, `proposed_outcome` and `proposed_by`
/// survive a dispute, so the app can say "the last proposal (X) was disputed".
/// Every field but the texts has a fixed size, so proposing, disputing and
/// finalizing never change how many bytes the record takes.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventData {
    pub question: String,
    pub rule: String,
    pub outcome_names: Vec<String>,
    /// Informational only; never checked.
    pub deadline_sec: u64,
    pub proposed_at_sec: u64,
    pub proposed_outcome: u8,
    pub proposal_open: bool,
    pub finalized: bool,
    /// Meaningful only once `finalized`.
    pub outcome: u8,
    pub proposed_by: ProposedBy,
}

/// One or two events fixed at creation. World `w` is a mixed-radix number
/// with event 0 as the least significant digit.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scenario {
    pub event_ids: Vec<u64>,
    pub outcome_counts: Vec<u8>,
    pub world_count: u8,
    /// Worlds still possible; loses bits as events resolve, never becomes 0.
    pub possible: u8,
    /// Events resolved so far. The order book uses it as its epoch.
    pub resolution_count: u8,
    /// Bit k is set once event k has resolved in this scenario.
    pub resolved_events: u8,
    /// Every pool opened on this scenario, in creation order.
    pub pool_ids: Vec<u64>,
}

impl Scenario {
    pub fn root(&self) -> u8 {
        masks::root(self.world_count)
    }

    /// Product of the outcome counts of the events before `k`.
    pub fn stride(&self, k: usize) -> u8 {
        self.outcome_counts[..k].iter().product()
    }

    /// Position of `event_id` in this scenario, or `EventNotInScenario`.
    pub fn event_index(&self, scenario_id: u64, event_id: u64) -> usize {
        self.event_ids
            .iter()
            .position(|e| *e == event_id)
            .unwrap_or_else(|| crate::fail!("EventNotInScenario({scenario_id}, {event_id})"))
    }

    /// Every world of the scenario in which event `k` has `outcome`,
    /// regardless of what is still possible.
    pub fn worlds_with(&self, k: usize, outcome: u8) -> u8 {
        masks::worlds_with(
            self.world_count,
            self.stride(k),
            self.outcome_counts[k],
            outcome,
        )
    }

    pub fn is_live(&self, mask: u8) -> bool {
        masks::is_live(mask, self.possible)
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventView {
    pub id: u64,
    pub question: String,
    pub rule: String,
    pub outcome_names: Vec<String>,
    pub deadline_sec: u64,
    /// 0 if nothing was ever proposed; kept after a dispute.
    pub proposed_at_sec: u64,
    pub proposed_outcome: u8,
    pub proposal_open: bool,
    pub finalized: bool,
    pub outcome: u8,
    /// 0 unless a proposal is open.
    pub finalizable_at_sec: u64,
    pub proposed_by: Option<Source>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScenarioInfo {
    pub scenario_id: u64,
    pub event_ids: Vec<u64>,
    pub outcome_counts: Vec<u8>,
    pub world_count: u8,
    pub root: u8,
    pub possible: u8,
    pub resolution_count: u8,
    pub resolved_events: u8,
    pub halted: bool,
    pub pool_ids: Vec<u64>,
}

/// Invariant 1 for one world: the supply of every verse token covering it,
/// against the scenario's reserves of the same asset.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldBacking {
    pub world: u8,
    pub possible: bool,
    pub wnear_supply: U128,
    pub usdc_supply: U128,
    /// Vacuously true once the world is dead.
    pub wnear_backed: bool,
    pub usdc_backed: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackingView {
    pub scenario_id: u64,
    pub possible: u8,
    pub wnear_reserves: U128,
    pub usdc_reserves: U128,
    pub worlds: Vec<WorldBacking>,
}
