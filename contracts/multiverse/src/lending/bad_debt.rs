//! Bad debt (F8): debt nothing is left to cover is written off at once, the
//! market's insurance first and the lenders for the rest, through the share
//! price. The market's cash (`TSA + insurance - TBA`) does not move.
//!
//! It happens inside a liquidation that seized every piece and left debt,
//! or through `write_off_bad_debt` for an account whose pieces are worth
//! nothing in every possible world. Pieces without a usable price are never
//! written off: lending does not write off what it cannot value.

use multiverse_math::risk;
use multiverse_math::shares::to_assets_up;
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{assert_one_yocto, env, near, AccountId};

use super::tiers::{MarketId, Tier, TierState};
use super::{value_pieces, Market};
use crate::errors::{add, sub};
use crate::events::MultiverseEvent;
use crate::ops::PauseFlag;
use crate::prices::PriceMode;
use crate::{masks, Contract, ContractExt};

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct BadDebtLog<'a> {
    scenario_id: u64,
    tier: Tier,
    account_id: &'a AccountId,
    caller_id: &'a AccountId,
    debt: U128,
    covered: U128,
    socialized: U128,
    insurance_after: U128,
    total_supply_after: U128,
}

impl MultiverseEvent for BadDebtLog<'_> {
    const NAME: &'static str = "bad_debt";
}

#[near]
impl Contract {
    /// Writes off the debt of an account whose collateral is worth nothing
    /// in every possible world (no pieces, or dead pieces only, which stay
    /// with the account). Anyone may call it; the freed bytes are credited
    /// to the caller. Works while halted or frozen. Returns the debt written
    /// off.
    #[payable]
    #[deny_unknown_arguments]
    pub fn write_off_bad_debt(
        &mut self,
        scenario_id: u64,
        account_id: AccountId,
        tier: Option<Tier>,
    ) -> U128 {
        assert_one_yocto();
        self.assert_live(PauseFlag::Liquidate);
        let caller = env::predecessor_account_id();
        let before = env::storage_usage();
        let s = self.scenario(scenario_id).clone();
        let id = MarketId::new(scenario_id, tier);
        let (mut m, mut st) = self.accrue(id);
        if self.borrow_shares_of(id, &account_id) == 0 {
            fail!("NoDebt({account_id})");
        }
        let px = self
            .price_snapshot(scenario_id)
            .prices(PriceMode::Liquidate);
        let v = value_pieces(&s, &px, &self.pieces(id, &account_id));
        if v.unpriced != 0 {
            fail!("PriceUnavailable({})", masks::lowest_world(v.unpriced));
        }
        let worth = v.max_value();
        if worth > 0 {
            fail!("StillCollateralized({worth})");
        }
        let bad = self.write_off(id, &mut m, &mut st, &account_id, &caller);
        self.store_market(id, m, &st);
        self.charge_storage(&caller, before);
        U128(bad)
    }
}

impl Contract {
    /// Writes off all of `account`'s debt in `id` on `m` and `st` (the
    /// caller stores them): insurance covers first, the rest lowers the
    /// lenders' supply. A market whose supply this wipes out freezes.
    /// Returns the debt written off.
    pub(crate) fn write_off(
        &mut self,
        id: MarketId,
        m: &mut Market,
        st: &mut TierState,
        account: &AccountId,
        caller: &AccountId,
    ) -> u128 {
        let shares = self.borrow_shares_of(id, account);
        let bad = to_assets_up(shares, m.total_borrow_assets, m.total_borrow_shares)
            .min(m.total_borrow_assets);
        let (cover, loss) = risk::write_off_split(bad, st.insurance);
        st.insurance -= cover;
        m.total_supply_assets = sub(m.total_supply_assets, loss);
        m.total_borrow_assets -= bad;
        m.total_borrow_shares = sub(m.total_borrow_shares, shares);
        st.bad_debt_covered = add(st.bad_debt_covered, cover);
        st.bad_debt_socialized = add(st.bad_debt_socialized, loss);
        self.set_borrow_shares(id, account, 0);
        if m.total_supply_assets == 0 && m.total_supply_shares > 0 {
            st.frozen = true;
        }
        BadDebtLog {
            scenario_id: id.scenario_id,
            tier: id.tier,
            account_id: account,
            caller_id: caller,
            debt: U128(bad),
            covered: U128(cover),
            socialized: U128(loss),
            insurance_after: U128(st.insurance),
            total_supply_after: U128(m.total_supply_assets),
        }
        .emit();
        bad
    }
}
