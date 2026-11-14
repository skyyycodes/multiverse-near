//! The catalogue's parameters: bounds, the owner's setter and the view.

use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, near};

use super::events::MarketParamsSet;
use super::{Check, MarketParams, MarketParamsView};
use crate::errors::fail;
use crate::events::MultiverseEvent;
use crate::{Contract, ContractExt};

/// One NEAR in yoctoNEAR.
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const DAY: u64 = 86_400;

impl MarketParams {
    /// Bounds of SPEC-C 4.5; the first field out of bounds is the error
    /// `BadMarketParams(field)`. Anchors are checked by the caller.
    pub fn validate(&self) -> Check<()> {
        let bad = |ok: bool, field: &str| -> Check<()> {
            if ok {
                Ok(())
            } else {
                Err(format!("BadMarketParams({field})"))
            }
        };
        let ttl = 3_600..=60 * DAY;
        let range = |r: [u16; 2]| r[0] >= 1_000 && r[1] <= 60_000 && r[0] < r[1];
        bad(self.bond_new_event.0 <= 100 * NEAR, "bond_new_event")?;
        bad(self.bond_market.0 <= 100 * NEAR, "bond_market")?;
        bad(self.reserve_base.0 >= NEAR / 50, "reserve_base")?;
        bad(self.reserve_per_world.0 >= NEAR / 100, "reserve_per_world")?;
        bad(ttl.contains(&self.proposal_ttl_sec), "proposal_ttl_sec")?;
        bad(ttl.contains(&self.review_ttl_sec), "review_ttl_sec")?;
        bad(
            self.min_pledge_window_sec <= self.proposal_ttl_sec,
            "min_pledge_window_sec",
        )?;
        bad(self.min_market_life_sec <= 30 * DAY, "min_market_life_sec")?;
        bad(self.notice_sec <= DAY, "notice_sec")?;
        bad(self.seed_lock_sec <= 30 * DAY, "seed_lock_sec")?;
        bad(
            self.evict_min_age_sec <= self.proposal_ttl_sec,
            "evict_min_age_sec",
        )?;
        bad(self.spam_floor_bps <= 5_000, "spam_floor_bps")?;
        bad(
            self.goal_depth_usdc.0 >= self.min_open_depth_usdc.0,
            "goal_depth_usdc",
        )?;
        bad(self.min_open_depth_usdc.0 > 0, "min_open_depth_usdc")?;
        bad(self.min_goal_usdc.0 > 0, "min_goal_usdc")?;
        bad(self.goal_round_usdc.0 > 0, "goal_round_usdc")?;
        bad((500..=10_000).contains(&self.beta_bps), "beta_bps")?;
        bad((1..=1_000).contains(&self.odds_clamp_bps), "odds_clamp_bps")?;
        bad(range(self.mult_a_bps), "mult_a_bps")?;
        bad(range(self.mult_b_bps), "mult_b_bps")?;
        bad(
            self.max_anchor_divergence_bps <= 2_000,
            "max_anchor_divergence_bps",
        )?;
        bad(
            self.max_reference_divergence_bps <= 3_000,
            "max_reference_divergence_bps",
        )?;
        bad(
            self.min_reference_depth_usdc.0 > 0,
            "min_reference_depth_usdc",
        )?;
        bad(
            self.min_reference_odds_depth_usdc.0 > 0,
            "min_reference_odds_depth_usdc",
        )?;
        bad(
            self.max_external_divergence_bps <= 3_000,
            "max_external_divergence_bps",
        )?;
        bad(
            self.max_pledges_per_account <= 64,
            "max_pledges_per_account",
        )?;
        bad(self.max_active_per_account <= 16, "max_active_per_account")?;
        bad(self.max_live_per_event <= 16, "max_live_per_event")
    }
}

#[near]
impl Contract {
    /// Owner only. Every proposal keeps the snapshot it was created with
    /// (bond, reserve, goal, ideal mix, `s_hint`, `beta`, seed lock, expiry);
    /// the safety thresholds are read at open.
    #[payable]
    pub fn set_market_params(&mut self, params: MarketParams) {
        assert_one_yocto();
        self.assert_owner();
        params.validate().unwrap_or_else(|e| fail(&e));
        if params
            .anchors
            .iter()
            .any(|sid| *sid != 0 && !self.market_entry(*sid).listed)
        {
            fail("BadMarketParams(anchors)");
        }
        self.write_market_params(&params);
        MarketParamsSet(&params).emit();
    }

    pub fn market_params(&self) -> MarketParamsView {
        let params = self.market_params_stored();
        MarketParamsView {
            reserve_w2: U128(params.reserve_for(2)),
            reserve_w4: U128(params.reserve_for(4)),
            reserve_w8: U128(params.reserve_for(8)),
            storage_fund: U128(self.catalog.storage_fund),
            params,
        }
    }
}
