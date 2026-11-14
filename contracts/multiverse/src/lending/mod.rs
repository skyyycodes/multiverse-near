//! Money markets: three real-USDC markets per scenario (the Safe, Normal and
//! Bold tiers), each a `MarketId { scenario_id, tier }` with its own pool of
//! supply, its own terms and no creation step.
//!
//! Lenders supply USDC at a rate that follows utilization along the tier's
//! kinked curve; a reserve factor of the interest builds the market's
//! insurance, which is never lent. Borrowers post collateral pieces (live
//! verse tokens of the scenario, or real wNEAR/USDC) and borrow USDC up to
//! what the worst still-possible world carries on the borrow side:
//! `C_min(borrow prices) * borrow_ltv`, where a world's borrow price is the
//! lower of its spot and TWAP. Liquidation reads the liquidation side, the
//! TWAP and the tier's `lltv`: below HF 1 anyone can liquidate. The
//! repayment (half the debt, all of a small or very unhealthy loan) buys the
//! same fraction of every piece, sized so the slice covers it in every
//! world; when it takes every piece and debt is left, the rest is written
//! off, insurance first. A liquidator can take the pieces as tokens or have
//! them sold for real USDC in the same receipt.
//!
//! Shares carry virtual offsets (1e6 shares, 1 asset). Views add what is
//! pending without writing. A world without a valid price counts as zero
//! for borrowing, but pauses liquidation, and so does an open oracle
//! proposal: resolution can only raise a health factor, so liquidating
//! during the dispute window would front-run it.

use multiverse_math::risk;
use multiverse_math::shares::{to_assets_down, to_assets_up, to_shares_down, to_shares_up};
use multiverse_math::{irm, mul_div_down};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{assert_one_yocto, env, near, AccountId};

pub mod bad_debt;
pub mod borrowers;
pub mod cash_out;
pub mod migrate;
pub mod rates;
pub mod tiers;

use self::tiers::{MarketId, Tier, TierConfigView, TierState};
use crate::errors::{add, fail, sub};
use crate::events::MultiverseEvent;
use crate::ledger::LogScope;
use crate::ops::PauseFlag;
use crate::prices::{PriceMode, PriceSnapshot, WorldPrices, WorldStatus};
use crate::receiver::{FundInsuranceMsg, LiquidateMsg, Receive, RepayMsg, ScenarioMsg};
use crate::types::{Asset, Scenario, VerseKey, WAD};
use crate::{masks, Contract, ContractExt};

/// Most pieces one account may post in one market (scenario, tier).
pub const MAX_COLLATERAL_PIECES: usize = 20;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Market {
    pub total_supply_assets: u128,
    pub total_supply_shares: u128,
    pub total_borrow_assets: u128,
    pub total_borrow_shares: u128,
    /// Seconds of the last accrual; 0 until the market is first touched.
    pub last_update: u64,
}

impl Market {
    /// What can be lent or withdrawn: supply not borrowed. Insurance is not
    /// part of it, and borrows above the supply read as none left.
    pub fn liquid(&self) -> u128 {
        self.total_supply_assets
            .saturating_sub(self.total_borrow_assets)
    }
}

/// One collateral piece: a real asset, or a verse token of the market's scenario.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CollateralKey {
    Real(Asset),
    Verse { asset: Asset, mask: u8 },
}

impl CollateralKey {
    pub fn asset(self) -> Asset {
        match self {
            CollateralKey::Real(asset) | CollateralKey::Verse { asset, .. } => asset,
        }
    }

    /// The worlds the piece pays in; a real asset pays in all of them.
    pub fn mask(self, root: u8) -> u8 {
        match self {
            CollateralKey::Real(_) => root,
            CollateralKey::Verse { mask, .. } => mask,
        }
    }

    /// `"wnear"` / `"usdc"` for real assets, the NEP-245 token id otherwise.
    pub fn piece_id(self, scenario_id: u64) -> String {
        match self {
            CollateralKey::Real(asset) => asset.as_str().to_string(),
            CollateralKey::Verse { asset, mask } => {
                VerseKey::new(scenario_id, asset, mask).token_id()
            }
        }
    }

    /// Inverse of `piece_id`; a verse token of another scenario is not a
    /// piece of this market.
    pub fn parse(scenario_id: u64, piece: &str) -> Option<Self> {
        if let Some(asset) = Asset::parse(piece) {
            return Some(CollateralKey::Real(asset));
        }
        let key = VerseKey::parse(piece)?;
        (key.scenario == scenario_id).then_some(CollateralKey::Verse {
            asset: key.asset,
            mask: key.mask,
        })
    }
}

/// `"max"` or an amount, for `liquidate`'s `repay_amount`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", untagged)]
pub enum RepayAmount {
    Max(MaxKeyword),
    Amount(U128),
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", rename_all = "lowercase")]
pub enum MaxKeyword {
    Max,
}

impl RepayAmount {
    /// None for `"max"`.
    pub fn amount(self) -> Option<u128> {
        match self {
            RepayAmount::Max(_) => None,
            RepayAmount::Amount(a) => Some(a.0),
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HealthView {
    /// `null` without debt (infinitely healthy); saturates at u128::MAX.
    pub health_factor: Option<U128>,
    /// The possible world with the least collateral value, ties to the lowest index.
    pub worst_world: Option<u8>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CollateralValuesView {
    /// USDC value per world at the liquidation prices; 0 for worlds that can
    /// no longer happen.
    pub values: Vec<U128>,
    pub possible: u8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CollateralPieceView {
    pub piece: String,
    pub amount: U128,
}

/// One market, pending interest included. The first eight keys are v1's.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketView {
    /// Supplied assets including the lenders' part of pending interest.
    pub total_supply: U128,
    /// Borrowed assets including pending interest.
    pub total_borrow: U128,
    pub total_supply_shares: U128,
    pub total_borrow_shares: U128,
    /// WAD.
    pub utilization: U128,
    /// WAD per second.
    pub supply_rate_per_sec: U128,
    pub borrow_rate_per_sec: U128,
    pub last_update_sec: u64,
    pub tier: Tier,
    /// The market's insurance reserve, pending cut included.
    pub insurance: U128,
    /// What can be borrowed or withdrawn now.
    pub liquid: U128,
    pub bad_debt_covered: U128,
    pub bad_debt_socialized: U128,
    pub borrowers: u32,
    pub frozen: bool,
    pub config: TierConfigView,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LiquidationState {
    None,
    Liquidatable,
    PausedHalted,
    PausedNoPrice,
    /// The `liquidate` flag is set, or the grace after unpausing it runs.
    Paused,
    /// The outside NEAR/USD reference guards the scenario's prices.
    PausedReference,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiquidationStatusView {
    pub status: LiquidationState,
    /// The lowest possible world without a price in which the account holds
    /// wNEAR-valued collateral, when that is what pauses liquidation.
    pub unpriced_world: Option<u8>,
    pub tier: Tier,
    /// What `"max"` repays now; 0 unless liquidatable.
    pub max_repay: U128,
    /// The smallest repayment that seizes every piece; 0 without debt.
    pub full_seize_repay: U128,
    /// Debt against pieces worth nothing in every possible world.
    pub write_off_ready: bool,
}

/// Collateral of one account valued in every world of the scenario.
pub(crate) struct Valuation {
    pub values: Vec<u128>,
    pub possible: u8,
    /// Highest price over the possible worlds.
    pub max_price: u128,
    /// Possible worlds without a price in which the account holds wNEAR-valued pieces.
    pub unpriced: u8,
    /// Possible worlds in which the account holds wNEAR-valued pieces.
    pub wnear_exposure: u8,
}

impl Valuation {
    /// The highest value over the possible worlds.
    pub fn max_value(&self) -> u128 {
        (0..self.values.len())
            .filter(|w| masks::contains(self.possible, *w as u8))
            .map(|w| self.values[w])
            .max()
            .unwrap_or(0)
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Health {
    pub hf: Option<u128>,
    pub worst: u8,
    pub lowest: u128,
}

/// What a liquidation did; `pieces` is the list as it was before seizure,
/// `seized` aligned with it (zeros kept).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Liquidation {
    pub repaid: u128,
    pub shares: u128,
    pub pieces: Vec<CollateralKey>,
    pub seized: Vec<u128>,
    /// Every piece was taken.
    pub seize_all: bool,
    /// Debt left after a full seizure and written off in the same call.
    pub written_off: u128,
}

/// Liquidating just below HF 1 must raise HF. That needs `C_min / debt >
/// 1 + bonus` while HF < 1 means `C_min / debt < 1 / lltv`, so the
/// parameters must satisfy `lltv * (1 + bonus) < 1`. A second line of
/// defence behind `TierConfig::validate`.
pub fn check_liquidation_bonus(lltv: u128, bonus: u128) {
    if let Err(e) = liquidation_bonus_ok(lltv, bonus) {
        fail(&e);
    }
}

fn liquidation_bonus_ok(lltv: u128, bonus: u128) -> Result<(), String> {
    let lifted = WAD.checked_add(bonus).and_then(|b| {
        multiverse_math::checked_mul_div(lltv, b, WAD, multiverse_math::Rounding::Down)
    });
    if bonus == 0 || lifted.is_none_or(|v| v >= WAD) {
        return Err(format!("InvalidLiquidationBonus({bonus})"));
    }
    Ok(())
}

/// Each piece valued in every world at `px`: USDC at par, wNEAR at the
/// world's price (0 where unpriced), nothing in worlds that can no longer
/// happen. Pure.
pub(crate) fn value_pieces(
    s: &Scenario,
    px: &WorldPrices,
    pieces: &[(CollateralKey, u128)],
) -> Valuation {
    let (worlds, possible, root) = (s.world_count, s.possible, s.root());
    let mut values = vec![0u128; usize::from(worlds)];
    let (mut unpriced, mut wnear_exposure) = (0u8, 0u8);
    for (piece, amount) in pieces {
        let mask = piece.mask(root);
        let usdc = piece.asset() == Asset::Usdc;
        if !usdc {
            wnear_exposure |= mask & possible;
            unpriced |= mask & possible & !px.priced;
        }
        for w in 0..worlds {
            if !masks::contains(possible & mask, w) {
                continue;
            }
            let i = usize::from(w);
            let value = if usdc {
                *amount
            } else {
                risk::wnear_value(*amount, px.prices[i])
            };
            values[i] = add(values[i], value);
        }
    }
    Valuation {
        values,
        possible,
        max_price: px.max_price,
        unpriced,
        wnear_exposure,
    }
}

/// The worst world and `floor(C_min * ratio / debt)`.
pub(crate) fn health_of(v: &Valuation, debt: u128, ratio: u128) -> Health {
    // the scenario always keeps a possible world
    let (worst, lowest) = risk::worst_world(&v.values, v.possible).unwrap_or((0, 0));
    Health {
        hf: risk::health_factor(lowest, debt, ratio),
        worst,
        lowest,
    }
}

fn hf_arg(hf: Option<u128>) -> u128 {
    hf.unwrap_or(u128::MAX)
}

/// The real wNEAR and USDC among `pieces`, by books index.
fn real_pieces(pieces: &[(CollateralKey, u128)]) -> [u128; 2] {
    let mut held = [0u128; 2];
    for (piece, amount) in pieces {
        if let CollateralKey::Real(asset) = piece {
            let i = crate::books::asset_index(*asset);
            held[i] = held[i].saturating_add(*amount);
        }
    }
    held
}

/// One market read once: the scenario, the market and its tier state (as
/// stored after an accrual, or projected for a view), and the scenario's
/// prices on both sides.
pub(crate) struct MarketCtx {
    pub id: MarketId,
    pub scenario: Scenario,
    pub market: Market,
    pub state: TierState,
    pub snap: PriceSnapshot,
    pub liq: WorldPrices,
    pub borrow: WorldPrices,
    pub halted: bool,
    /// The `liquidate` flag is set or its grace runs.
    pub liquidation_paused: bool,
}

/// One account in one market, valued on both sides, with what a liquidation
/// could do now.
pub(crate) struct Assessment {
    pub pieces: Vec<(CollateralKey, u128)>,
    pub debt: u128,
    pub liq: Valuation,
    pub liq_health: Health,
    pub borrow_health: Health,
    pub status: LiquidationState,
    pub unpriced_world: Option<u8>,
    /// Most a liquidation may repay (0 without debt).
    pub cap: u128,
    /// Smallest repayment that seizes everything (0 without debt).
    pub fsr: u128,
    /// What `"max"` repays now; 0 unless liquidatable.
    pub max_repay: u128,
    pub write_off_ready: bool,
}

/// A liquidation worked out before anything moves.
pub(crate) struct Plan {
    pub owed_shares: u128,
    pub c_min: u128,
    pub worst: u8,
    pub repay: u128,
    pub target: u128,
    pub seize_all: bool,
    pub pieces: Vec<(CollateralKey, u128)>,
    pub seized: Vec<u128>,
    /// Borrow shares the repayment burns.
    pub shares: u128,
    /// Debt a full seizure leaves, written off in the same call.
    pub written_off: u128,
    /// The liquidation prices' reference factor (WAD).
    pub factor: u128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct SupplyLog<'a> {
    scenario_id: u64,
    #[serde(skip_serializing_if = "Tier::is_normal")]
    tier: Tier,
    account_id: &'a AccountId,
    assets: U128,
    shares: U128,
}

impl MultiverseEvent for SupplyLog<'_> {
    const NAME: &'static str = "supply";
}

/// `shares` are the shares burned.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct WithdrawLog<'a> {
    scenario_id: u64,
    #[serde(skip_serializing_if = "Tier::is_normal")]
    tier: Tier,
    account_id: &'a AccountId,
    assets: U128,
    shares: U128,
}

impl MultiverseEvent for WithdrawLog<'_> {
    const NAME: &'static str = "withdraw";
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct DepositCollateralLog<'a> {
    scenario_id: u64,
    #[serde(skip_serializing_if = "Tier::is_normal")]
    tier: Tier,
    account_id: &'a AccountId,
    piece: String,
    amount: U128,
}

impl MultiverseEvent for DepositCollateralLog<'_> {
    const NAME: &'static str = "deposit_collateral";
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct WithdrawCollateralLog<'a> {
    scenario_id: u64,
    #[serde(skip_serializing_if = "Tier::is_normal")]
    tier: Tier,
    account_id: &'a AccountId,
    piece: String,
    amount: U128,
}

impl MultiverseEvent for WithdrawCollateralLog<'_> {
    const NAME: &'static str = "withdraw_collateral";
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct BorrowLog<'a> {
    scenario_id: u64,
    #[serde(skip_serializing_if = "Tier::is_normal")]
    tier: Tier,
    account_id: &'a AccountId,
    assets: U128,
    shares: U128,
}

impl MultiverseEvent for BorrowLog<'_> {
    const NAME: &'static str = "borrow";
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct RepayLog<'a> {
    scenario_id: u64,
    #[serde(skip_serializing_if = "Tier::is_normal")]
    tier: Tier,
    account_id: &'a AccountId,
    assets: U128,
    shares: U128,
}

impl MultiverseEvent for RepayLog<'_> {
    const NAME: &'static str = "repay";
}

/// `c_min` and `worst_world` are the pre-liquidation worst world, so the
/// coverage of a slice can be checked from the log alone.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct LiquidateLog<'a> {
    scenario_id: u64,
    #[serde(skip_serializing_if = "Tier::is_normal")]
    tier: Tier,
    account_id: &'a AccountId,
    liquidator_id: &'a AccountId,
    repaid: U128,
    shares: U128,
    pieces: Vec<String>,
    seized: Vec<U128>,
    c_min: U128,
    worst_world: u8,
    receive: Receive,
    seize_all: bool,
    written_off: U128,
    price_factor: U128,
}

impl MultiverseEvent for LiquidateLog<'_> {
    const NAME: &'static str = "liquidate";
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct InsuranceFunded<'a> {
    scenario_id: u64,
    tier: Tier,
    account_id: &'a AccountId,
    amount: U128,
}

impl MultiverseEvent for InsuranceFunded<'_> {
    const NAME: &'static str = "insurance_funded";
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct InsuranceWithdrawn<'a> {
    scenario_id: u64,
    tier: Tier,
    amount: U128,
    to: &'a AccountId,
}

impl MultiverseEvent for InsuranceWithdrawn<'_> {
    const NAME: &'static str = "insurance_withdrawn";
}

#[cfg(test)]
thread_local! {
    /// Every (market key, account) that ever posted collateral, so the tests
    /// can sum what lending holds of a key; lookup maps cannot be iterated.
    static COLLATERAL_OWNERS: std::cell::RefCell<std::collections::BTreeSet<(u64, AccountId)>> =
        const { std::cell::RefCell::new(std::collections::BTreeSet::new()) };
}

#[near]
impl Contract {
    /// Withdraws supplied USDC (all of it with `amount` null) to the wallet.
    #[payable]
    #[deny_unknown_arguments]
    pub fn withdraw_supply(
        &mut self,
        scenario_id: u64,
        amount: Option<U128>,
        tier: Option<Tier>,
    ) -> U128 {
        assert_one_yocto();
        self.assert_live(PauseFlag::Exit);
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        let id = MarketId::new(scenario_id, tier);
        let assets = self.withdraw_supply_for(&account, id, amount.map(|a| a.0));
        self.payout(&account, Asset::Usdc, assets);
        self.charge_storage(&account, before);
        U128(assets)
    }

    /// Posts `amount` of a piece the caller holds: a verse token id of this
    /// scenario from the ledger, or `"wnear"` / `"usdc"` from the internal
    /// real balance. Only for the caller's own account. Never paused.
    #[payable]
    #[deny_unknown_arguments]
    pub fn deposit_collateral(
        &mut self,
        scenario_id: u64,
        piece: String,
        amount: U128,
        tier: Option<Tier>,
    ) {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        let key = self.parse_piece(scenario_id, &piece);
        let id = MarketId::new(scenario_id, tier);
        self.deposit_collateral_for(&account, id, key, amount.0);
        self.charge_storage(&account, before);
    }

    /// Takes a piece back: verse tokens to the ledger, real assets to the
    /// wallet. With debt the account must stay healthy on the borrow side.
    #[payable]
    #[deny_unknown_arguments]
    pub fn withdraw_collateral(
        &mut self,
        scenario_id: u64,
        piece: String,
        amount: U128,
        tier: Option<Tier>,
    ) {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let id = MarketId::new(scenario_id, tier);
        // With debt the withdrawal is a lending action; without, an exit.
        if self.borrow_shares_of(id, &account) != 0 {
            self.assert_live(PauseFlag::Lend);
        } else {
            self.assert_live(PauseFlag::Exit);
        }
        let before = env::storage_usage();
        self.scenario(scenario_id);
        let key = CollateralKey::parse(scenario_id, &piece)
            .unwrap_or_else(|| fail!("NotCollateral({piece})"));
        self.withdraw_collateral_for(&account, id, key, amount.0);
        if let CollateralKey::Real(asset) = key {
            self.real_debit(&account, asset, amount.0);
            self.payout(&account, asset, amount.0);
        }
        self.charge_storage(&account, before);
    }

    /// Borrows USDC to the wallet.
    #[payable]
    #[deny_unknown_arguments]
    pub fn borrow(&mut self, scenario_id: u64, amount: U128, tier: Option<Tier>) {
        assert_one_yocto();
        self.assert_live(PauseFlag::Lend);
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        self.borrow_for(&account, MarketId::new(scenario_id, tier), amount.0);
        self.charge_storage(&account, before);
    }

    /// Repays from the internal USDC balance, the whole debt with `amount`
    /// null. Returns what was repaid. Never paused.
    #[payable]
    #[deny_unknown_arguments]
    pub fn repay_from_balance(
        &mut self,
        scenario_id: u64,
        amount: Option<U128>,
        tier: Option<Tier>,
    ) -> U128 {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        let id = MarketId::new(scenario_id, tier);
        let repaid = self.repay_for(&account, id, amount.map_or(u128::MAX, |a| a.0));
        self.charge_storage(&account, before);
        U128(repaid)
    }

    /// Owner: takes insurance out of a frozen market without debt, into the
    /// owner's internal USDC balance. Returns the amount.
    #[payable]
    #[deny_unknown_arguments]
    pub fn withdraw_insurance(&mut self, scenario_id: u64, tier: Tier, amount: U128) -> U128 {
        assert_one_yocto();
        self.assert_live(PauseFlag::Exit);
        self.assert_owner();
        self.scenario(scenario_id);
        let owner = env::predecessor_account_id();
        let before = env::storage_usage();
        let id = MarketId::new(scenario_id, Some(tier));
        let (m, mut st) = self.accrue(id);
        if !st.frozen {
            fail!("MarketNotFrozen({scenario_id}, {tier})");
        }
        if m.total_borrow_shares > 0 {
            fail!("InsuranceLocked({})", m.total_borrow_shares);
        }
        if amount.0 > st.insurance {
            fail!("InsufficientInsurance({}, {})", amount.0, st.insurance);
        }
        let cash = add(m.total_supply_assets, st.insurance).saturating_sub(m.total_borrow_assets);
        if amount.0 > cash {
            fail!("InsufficientLiquidity({}, {cash})", amount.0);
        }
        st.insurance -= amount.0;
        self.store_market(id, m, &st);
        self.real_credit(&owner, Asset::Usdc, amount.0);
        InsuranceWithdrawn {
            scenario_id,
            tier,
            amount,
            to: &owner,
        }
        .emit();
        self.charge_storage(&owner, before);
        amount
    }

    /// Debt including pending interest, rounded up.
    #[deny_unknown_arguments]
    pub fn debt_of(&self, scenario_id: u64, account_id: AccountId, tier: Option<Tier>) -> U128 {
        U128(self.debt_for(MarketId::new(scenario_id, tier), &account_id))
    }

    /// The liquidation side's health factor and worst world.
    #[deny_unknown_arguments]
    pub fn health_factor(
        &self,
        scenario_id: u64,
        account_id: AccountId,
        tier: Option<Tier>,
    ) -> HealthView {
        let ctx = self.market_ctx_view(MarketId::new(scenario_id, tier));
        let a = self.assess(&ctx, &account_id);
        HealthView {
            health_factor: a.liq_health.hf.map(U128),
            worst_world: Some(a.liq_health.worst),
        }
    }

    /// The account's collateral per world at the liquidation prices.
    #[deny_unknown_arguments]
    pub fn collateral_values(
        &self,
        scenario_id: u64,
        account_id: AccountId,
        tier: Option<Tier>,
    ) -> CollateralValuesView {
        let id = MarketId::new(scenario_id, tier);
        let s = self.scenario(scenario_id).clone();
        let px = self
            .price_snapshot(scenario_id)
            .prices(PriceMode::Liquidate);
        let v = value_pieces(&s, &px, &self.pieces(id, &account_id));
        CollateralValuesView {
            values: v.values.into_iter().map(U128).collect(),
            possible: v.possible,
        }
    }

    /// The account's pieces in list order.
    #[deny_unknown_arguments]
    pub fn collateral_of(
        &self,
        scenario_id: u64,
        account_id: AccountId,
        tier: Option<Tier>,
    ) -> Vec<CollateralPieceView> {
        self.pieces(MarketId::new(scenario_id, tier), &account_id)
            .into_iter()
            .map(|(key, amount)| CollateralPieceView {
                piece: key.piece_id(scenario_id),
                amount: U128(amount),
            })
            .collect()
    }

    /// One market with pending interest; zeros for a scenario that does not
    /// exist (v1).
    #[deny_unknown_arguments]
    pub fn market_state(&self, scenario_id: u64, tier: Option<Tier>) -> MarketView {
        let id = MarketId::new(scenario_id, tier);
        let (p, st) = self.projected(id);
        self.market_view(id, &p.market, &st)
    }

    /// What the lender's shares are worth now, pending interest included.
    #[deny_unknown_arguments]
    pub fn supply_balance_of(
        &self,
        scenario_id: u64,
        account_id: AccountId,
        tier: Option<Tier>,
    ) -> U128 {
        let id = MarketId::new(scenario_id, tier);
        let (p, _) = self.projected(id);
        let m = p.market;
        let shares = self.supply_shares_of(id, &account_id);
        U128(to_assets_down(
            shares,
            m.total_supply_assets,
            m.total_supply_shares,
        ))
    }

    /// USDC supplied minus USDC withdrawn (floored at 0), for showing
    /// earnings; gone once the lender's shares are.
    #[deny_unknown_arguments]
    pub fn supply_principal_of(
        &self,
        scenario_id: u64,
        account_id: AccountId,
        tier: Option<Tier>,
    ) -> U128 {
        let id = MarketId::new(scenario_id, tier);
        U128(self.principal_of(id, &account_id))
    }

    /// Whether the account can be liquidated now and, if not, why.
    #[deny_unknown_arguments]
    pub fn liquidation_status(
        &self,
        scenario_id: u64,
        account_id: AccountId,
        tier: Option<Tier>,
    ) -> LiquidationStatusView {
        let ctx = self.market_ctx_view(MarketId::new(scenario_id, tier));
        let a = self.assess(&ctx, &account_id);
        LiquidationStatusView {
            status: a.status,
            unpriced_world: a.unpriced_world,
            tier: ctx.id.tier,
            max_repay: U128(a.max_repay),
            full_seize_repay: U128(a.fsr),
            write_off_ready: a.write_off_ready,
        }
    }
}

impl Contract {
    pub(crate) fn ft_supply(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        amount: u128,
        msg: ScenarioMsg,
    ) {
        Self::require_usdc(asset);
        self.supply_for(
            sender,
            MarketId::new(msg.scenario_id, Some(msg.tier)),
            amount,
        );
    }

    /// Repays `min(attached, debt)`; with `all` the attachment must cover the
    /// whole debt.
    pub(crate) fn ft_repay(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        amount: u128,
        msg: RepayMsg,
    ) {
        Self::require_usdc(asset);
        let id = MarketId::new(msg.scenario_id, Some(msg.tier));
        self.scenario(msg.scenario_id);
        if msg.all {
            let debt = self.debt_for(id, sender);
            if amount < debt {
                fail!("InsufficientRepayment({amount}, {debt})");
            }
        }
        self.repay_for(sender, id, amount);
    }

    pub(crate) fn ft_deposit_collateral(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        amount: u128,
        msg: ScenarioMsg,
    ) {
        let id = MarketId::new(msg.scenario_id, Some(msg.tier));
        self.deposit_collateral_for(sender, id, CollateralKey::Real(asset), amount);
    }

    /// The sender liquidates with the attached USDC; it must cover what the
    /// liquidation repays. With `receive: "cash"` the seized pieces are sold
    /// for real USDC, paid out in the same receipt, at least `min_out`.
    pub(crate) fn ft_liquidate(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        amount: u128,
        msg: LiquidateMsg,
    ) {
        Self::require_usdc(asset);
        match (msg.receive, msg.min_out) {
            (Receive::Cash, None) => fail("MinOutRequired"),
            (Receive::Tokens, Some(_)) => fail("MinOutWithoutCash"),
            _ => {}
        }
        let id = MarketId::new(msg.scenario_id, Some(msg.tier));
        self.liquidate_for(
            sender,
            id,
            &msg.account_id,
            msg.repay_amount.amount(),
            amount,
            msg.receive,
            msg.min_out.map(|m| m.0),
        );
    }

    /// ft action `fund_insurance`: the attached USDC into the market's
    /// insurance reserve, for good. Never paused; works while frozen or
    /// halted.
    pub(crate) fn ft_fund_insurance(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        amount: u128,
        msg: FundInsuranceMsg,
    ) {
        Self::require_usdc(asset);
        self.scenario(msg.scenario_id);
        let id = MarketId::new(msg.scenario_id, Some(msg.tier));
        let (m, mut st) = self.accrue(id);
        st.insurance = add(st.insurance, amount);
        self.real_debit(sender, Asset::Usdc, amount);
        self.store_market(id, m, &st);
        InsuranceFunded {
            scenario_id: msg.scenario_id,
            tier: msg.tier,
            account_id: sender,
            amount: U128(amount),
        }
        .emit();
    }

    fn require_usdc(asset: Asset) {
        if asset != Asset::Usdc {
            fail!("WrongAsset({asset})");
        }
    }

    /// Verse tokens of `key` held as collateral in any tier, for the
    /// conservation check in the tests.
    #[cfg(test)]
    pub(crate) fn collateral_holdings(&self, key: &VerseKey) -> u128 {
        let piece = CollateralKey::Verse {
            asset: key.asset,
            mask: key.mask,
        };
        COLLATERAL_OWNERS.with(|owners| {
            owners
                .borrow()
                .iter()
                .filter(|(k, _)| k & ((1u64 << tiers::TIER_SHIFT) - 1) == key.scenario)
                .flat_map(|(k, a)| {
                    self.collateral
                        .get(&(*k, a.clone()))
                        .cloned()
                        .unwrap_or_default()
                })
                .filter(|(k, _)| *k == piece)
                .map(|(_, amount)| amount)
                .sum()
        })
    }

    // Internal API, for the public methods above and the router. Every
    // function acts for `account` itself (the router passes its caller),
    // moves value through the account's ledger and internal real balance,
    // and leaves storage charging to the entry point.

    /// Supplies `assets` USDC from the internal real balance. Returns shares minted.
    pub(crate) fn supply_for(&mut self, account: &AccountId, id: MarketId, assets: u128) -> u128 {
        if assets == 0 {
            fail("ZeroAmount");
        }
        let sid = id.scenario_id;
        self.scenario(sid);
        let (mut m, st) = self.accrue(id);
        if st.frozen {
            fail!("MarketFrozen({sid}, {})", id.tier);
        }
        if m.total_supply_assets == 0 && m.total_supply_shares > 0 {
            fail!("MarketWipedOut({sid}, {})", id.tier);
        }
        let shares = to_shares_down(assets, m.total_supply_assets, m.total_supply_shares);
        m.total_supply_assets = add(m.total_supply_assets, assets);
        m.total_supply_shares = add(m.total_supply_shares, shares);
        self.store_market(id, m, &st);
        let held = self.supply_shares_of(id, account);
        self.set_supply_shares(id, account, add(held, shares));
        let principal = self.principal_of(id, account);
        self.set_principal(id, account, add(principal, assets));
        self.real_debit(account, Asset::Usdc, assets);
        SupplyLog {
            scenario_id: sid,
            tier: id.tier,
            account_id: account,
            assets: U128(assets),
            shares: U128(shares),
        }
        .emit();
        shares
    }

    /// Burns supply shares for `amount` USDC (everything owned with `None`)
    /// and returns the assets; the caller pays them out.
    pub(crate) fn withdraw_supply_for(
        &mut self,
        account: &AccountId,
        id: MarketId,
        amount: Option<u128>,
    ) -> u128 {
        if amount == Some(0) {
            fail("ZeroAmount");
        }
        self.scenario(id.scenario_id);
        let (mut m, st) = self.accrue(id);
        let user_shares = self.supply_shares_of(id, account);
        let owned = to_assets_down(user_shares, m.total_supply_assets, m.total_supply_shares);
        let assets = amount.unwrap_or(owned);
        if assets == 0 {
            fail("ZeroAmount");
        }
        if assets > owned {
            fail!("InsufficientSupply({assets}, {owned})");
        }
        let liquid = m.liquid();
        if assets > liquid {
            fail!("InsufficientLiquidity({assets}, {liquid})");
        }
        let shares =
            to_shares_up(assets, m.total_supply_assets, m.total_supply_shares).min(user_shares);
        m.total_supply_shares = sub(m.total_supply_shares, shares);
        m.total_supply_assets = sub(m.total_supply_assets, assets);
        self.store_market(id, m, &st);
        let left = user_shares - shares;
        if left > 0 {
            let principal = self.principal_of(id, account);
            self.set_principal(id, account, principal.saturating_sub(assets));
        }
        // at zero shares the principal entry goes too
        self.set_supply_shares(id, account, left);
        WithdrawLog {
            scenario_id: id.scenario_id,
            tier: id.tier,
            account_id: account,
            assets: U128(assets),
            shares: U128(shares),
        }
        .emit();
        assets
    }

    /// Posts `amount` of `piece` from `account`'s ledger (verse) or internal
    /// real balance (real asset). No accrual and no health check: adding
    /// collateral can only help, and it is allowed while frozen, halted or
    /// paused.
    pub(crate) fn deposit_collateral_for(
        &mut self,
        account: &AccountId,
        id: MarketId,
        piece: CollateralKey,
        amount: u128,
    ) {
        if amount == 0 {
            fail("ZeroAmount");
        }
        let sid = id.scenario_id;
        let s = self.scenario(sid);
        let (root, possible) = (s.root(), s.possible);
        if let CollateralKey::Verse { mask, .. } = piece {
            // root is the real asset itself, never a token
            if mask == 0 || mask == root || !masks::is_subset(mask, root) {
                fail!("NotCollateral({})", piece.piece_id(sid));
            }
            if !masks::is_live(mask, possible) {
                fail!("DeadVerse({mask})");
            }
        }
        let mut list = self.pieces(id, account);
        match list.iter_mut().find(|(k, _)| *k == piece) {
            Some((_, held)) => *held = add(*held, amount),
            None => {
                if list.len() >= MAX_COLLATERAL_PIECES {
                    fail("TooManyCollateralTokens");
                }
                list.push((piece, amount));
            }
        }
        self.set_pieces(id, account, list);
        match piece {
            CollateralKey::Real(asset) => self.real_debit(account, asset, amount),
            CollateralKey::Verse { asset, mask } => {
                self.take_into_custody(account, &[(VerseKey::new(sid, asset, mask), amount)], None)
            }
        }
        DepositCollateralLog {
            scenario_id: sid,
            tier: id.tier,
            account_id: account,
            piece: piece.piece_id(sid),
            amount: U128(amount),
        }
        .emit();
    }

    /// With debt: the scenario must not be halted, the market accrues, and
    /// the borrow side must not be blocked. Returns the scenario and the
    /// snapshot, for the health check after the change.
    fn borrow_side_gate(&mut self, id: MarketId) -> (Scenario, PriceSnapshot, TierState) {
        let sid = id.scenario_id;
        let s = self.scenario(sid).clone();
        if self.halted(&s) {
            fail!("ScenarioHalted({sid})");
        }
        let (_, st) = self.accrue(id);
        let snap = self.price_snapshot(sid);
        if let Some(block) = snap.borrow_block() {
            fail(&block.error());
        }
        (s, snap, st)
    }

    /// `Unhealthy(hf, worst)` unless the account's collateral at the borrow
    /// prices carries its debt at the tier's borrow LTV.
    fn assert_can_borrow(
        &self,
        id: MarketId,
        account: &AccountId,
        s: &Scenario,
        snap: &PriceSnapshot,
        st: &TierState,
    ) {
        let debt = self.debt_for(id, account);
        let v = value_pieces(
            s,
            &snap.prices(PriceMode::Borrow),
            &self.pieces(id, account),
        );
        let h = health_of(&v, debt, st.config.borrow_ltv);
        if !risk::is_healthy(h.hf) {
            fail!("Unhealthy({}, {})", hf_arg(h.hf), h.worst);
        }
    }

    /// Takes `amount` of `piece` off the account's collateral and gives it
    /// back to the account (verse tokens to the ledger, real assets to the
    /// internal real balance). With debt the account must stay healthy on
    /// the borrow side; without, nothing reads a price.
    pub(crate) fn withdraw_collateral_for(
        &mut self,
        account: &AccountId,
        id: MarketId,
        piece: CollateralKey,
        amount: u128,
    ) {
        if amount == 0 {
            fail("ZeroAmount");
        }
        self.scenario(id.scenario_id);
        let gate = (self.borrow_shares_of(id, account) != 0).then(|| self.borrow_side_gate(id));
        let mut list = self.pieces(id, account);
        let index = list.iter().position(|(k, _)| *k == piece);
        let held = index.map_or(0, |i| list[i].1);
        if amount > held {
            fail!("InsufficientCollateral({amount}, {held})");
        }
        let i = index.unwrap_or_else(|| env::abort());
        if held == amount {
            list.swap_remove(i);
        } else {
            list[i].1 = held - amount;
        }
        self.set_pieces(id, account, list);
        if let Some((s, snap, st)) = gate {
            self.assert_can_borrow(id, account, &s, &snap, &st);
        }
        self.give_piece(account, id.scenario_id, piece, amount);
        WithdrawCollateralLog {
            scenario_id: id.scenario_id,
            tier: id.tier,
            account_id: account,
            piece: piece.piece_id(id.scenario_id),
            amount: U128(amount),
        }
        .emit();
    }

    /// Takes every piece back to the account (verse tokens to the ledger,
    /// real assets to the internal real balance) and returns them in list
    /// order. With debt this fails `Unhealthy`; nothing posted is a no-op.
    pub(crate) fn withdraw_all_collateral_for(
        &mut self,
        account: &AccountId,
        id: MarketId,
    ) -> Vec<(CollateralKey, u128)> {
        self.scenario(id.scenario_id);
        let list = self.pieces(id, account);
        if list.is_empty() {
            return list;
        }
        let gate = (self.borrow_shares_of(id, account) != 0).then(|| self.borrow_side_gate(id));
        self.set_pieces(id, account, Vec::new());
        if let Some((s, snap, st)) = gate {
            self.assert_can_borrow(id, account, &s, &snap, &st);
        }
        for (piece, amount) in &list {
            self.give_piece(account, id.scenario_id, *piece, *amount);
            WithdrawCollateralLog {
                scenario_id: id.scenario_id,
                tier: id.tier,
                account_id: account,
                piece: piece.piece_id(id.scenario_id),
                amount: U128(*amount),
            }
            .emit();
        }
        list
    }

    /// Borrows `amount` USDC for `account` and pays it out to the account's
    /// wallet. The health check runs on the new debt at the borrow prices.
    pub(crate) fn borrow_for(&mut self, account: &AccountId, id: MarketId, amount: u128) {
        if amount == 0 {
            fail("ZeroAmount");
        }
        let sid = id.scenario_id;
        let s = self.scenario(sid).clone();
        if self.halted(&s) {
            fail!("ScenarioHalted({sid})");
        }
        let (mut m, st) = self.accrue(id);
        if st.frozen {
            fail!("MarketFrozen({sid}, {})", id.tier);
        }
        let snap = self.price_snapshot(sid);
        if let Some(block) = snap.borrow_block() {
            fail(&block.error());
        }
        let liquid = m.liquid();
        if amount > liquid {
            fail!("InsufficientLiquidity({amount}, {liquid})");
        }
        let after = add(m.total_borrow_assets, amount);
        let c = &st.config;
        if after > mul_div_down(c.max_utilization, m.total_supply_assets, WAD) {
            fail!(
                "UtilizationCap({}, {})",
                irm::utilization(after, m.total_supply_assets),
                c.max_utilization
            );
        }
        if after > c.borrow_cap {
            fail!("BorrowCapExceeded({after}, {})", c.borrow_cap);
        }
        let shares = to_shares_up(amount, m.total_borrow_assets, m.total_borrow_shares);
        m.total_borrow_shares = add(m.total_borrow_shares, shares);
        m.total_borrow_assets = after;
        let owed = add(self.borrow_shares_of(id, account), shares);
        let debt_after = to_assets_up(owed, m.total_borrow_assets, m.total_borrow_shares);
        self.store_market(id, m, &st);
        self.set_borrow_shares(id, account, owed);
        let min_loan = self.lending.min_loan;
        if debt_after < min_loan {
            fail!("BelowMinLoan({debt_after}, {min_loan})");
        }
        self.assert_can_borrow(id, account, &s, &snap, &st);
        BorrowLog {
            scenario_id: sid,
            tier: id.tier,
            account_id: account,
            assets: U128(amount),
            shares: U128(shares),
        }
        .emit();
        self.payout(account, Asset::Usdc, amount);
    }

    /// Repays up to `max_amount` of `account`'s debt from its internal USDC
    /// balance; `max_amount >= debt` (e.g. u128::MAX) repays all of it. A
    /// partial repayment may not leave less than the minimum loan. Returns
    /// what was repaid. Nothing to repay is `ZeroAmount`.
    pub(crate) fn repay_for(
        &mut self,
        account: &AccountId,
        id: MarketId,
        max_amount: u128,
    ) -> u128 {
        self.scenario(id.scenario_id);
        let (mut m, st) = self.accrue(id);
        let owed_shares = self.borrow_shares_of(id, account);
        let owed = to_assets_up(owed_shares, m.total_borrow_assets, m.total_borrow_shares);
        let (assets, shares) = if max_amount >= owed {
            (owed, owed_shares)
        } else {
            let shares = to_shares_down(max_amount, m.total_borrow_assets, m.total_borrow_shares);
            (max_amount, shares)
        };
        if assets == 0 {
            fail("ZeroAmount");
        }
        let left = owed - assets;
        let min_loan = self.lending.min_loan;
        if left > 0 && left < min_loan {
            fail!("DustDebtLeft({left}, {min_loan})");
        }
        m.total_borrow_shares = sub(m.total_borrow_shares, shares);
        // the last borrower's rounded-up debt can exceed the total by a unit
        m.total_borrow_assets = m.total_borrow_assets.saturating_sub(assets);
        self.store_market(id, m, &st);
        self.set_borrow_shares(id, account, owed_shares - shares);
        self.real_debit(account, Asset::Usdc, assets);
        RepayLog {
            scenario_id: id.scenario_id,
            tier: id.tier,
            account_id: account,
            assets: U128(assets),
            shares: U128(shares),
        }
        .emit();
        assets
    }

    /// `liquidator` repays part of `account`'s debt from its internal USDC
    /// balance and receives the same fraction `min(1, target / C_min)` of
    /// every piece: verse tokens in its ledger, real assets in its internal
    /// real balance, or, with `Receive::Cash`, real USDC paid out after the
    /// pieces are sold. `repay` None is `"max"`. A repayment above `budget`
    /// fails before anything moves. Debt a full seizure leaves is written
    /// off.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn liquidate_for(
        &mut self,
        liquidator: &AccountId,
        id: MarketId,
        account: &AccountId,
        repay: Option<u128>,
        budget: u128,
        receive: Receive,
        min_out: Option<u128>,
    ) -> Liquidation {
        // one group of lines however many pieces it cuts (ledger.rs)
        let _scope = LogScope::open();
        if repay == Some(0) {
            fail("ZeroAmount");
        }
        let sid = id.scenario_id;
        let s = self.scenario(sid).clone();
        if self.halted(&s) {
            fail!("ScenarioHalted({sid})");
        }
        let (mut m, mut st) = self.accrue(id);
        let snap = self.price_snapshot(sid);
        let plan = self
            .plan_liquidation(id, &s, account, repay, budget, &m, &st, &snap)
            .unwrap_or_else(|e| fail(&e));

        let left_shares = plan.owed_shares - plan.shares;
        m.total_borrow_shares = sub(m.total_borrow_shares, plan.shares);
        m.total_borrow_assets = m.total_borrow_assets.saturating_sub(plan.repay);
        self.set_borrow_shares(id, account, left_shares);

        let mut left = plan.pieces.clone();
        for ((piece, held), amount) in plan.pieces.iter().zip(&plan.seized) {
            if *amount == 0 {
                continue;
            }
            let at = left
                .iter()
                .position(|(k, _)| k == piece)
                .unwrap_or_else(|| env::abort());
            if amount == held {
                left.swap_remove(at);
            } else {
                left[at].1 = held - amount;
            }
        }
        self.set_pieces(id, account, left);

        self.real_debit(liquidator, Asset::Usdc, plan.repay);
        let mut verse = Vec::new();
        for ((piece, _), amount) in plan.pieces.iter().zip(&plan.seized) {
            if *amount == 0 {
                continue;
            }
            match *piece {
                CollateralKey::Real(asset) => self.real_credit(liquidator, asset, *amount),
                CollateralKey::Verse { asset, mask } => {
                    verse.push((VerseKey::new(sid, asset, mask), *amount));
                }
            }
        }
        self.release_from_custody(liquidator, &verse, None);

        let written_off = if plan.seize_all && left_shares > 0 {
            self.write_off(id, &mut m, &mut st, account, liquidator)
        } else {
            0
        };
        self.store_market(id, m, &st);

        let pieces: Vec<CollateralKey> = plan.pieces.iter().map(|(k, _)| *k).collect();
        LiquidateLog {
            scenario_id: sid,
            tier: id.tier,
            account_id: account,
            liquidator_id: liquidator,
            repaid: U128(plan.repay),
            shares: U128(plan.shares),
            pieces: pieces.iter().map(|k| k.piece_id(sid)).collect(),
            seized: plan.seized.iter().map(|a| U128(*a)).collect(),
            c_min: U128(plan.c_min),
            worst_world: plan.worst,
            receive,
            seize_all: plan.seize_all,
            written_off: U128(written_off),
            price_factor: U128(plan.factor),
        }
        .emit();

        if receive == Receive::Cash {
            let min_out = min_out.unwrap_or_else(|| fail("MinOutRequired"));
            let out = self.cash_out(liquidator, id, &s, &pieces, &plan.seized, min_out);
            self.pay_cash_out(liquidator, account, id, &out, min_out);
        }
        Liquidation {
            repaid: plan.repay,
            shares: plan.shares,
            pieces,
            seized: plan.seized,
            seize_all: plan.seize_all,
            written_off,
        }
    }

    /// Steps 5 to 14 of a liquidation on `m` and `st` (accrued for a call,
    /// projected for a quote): the first failing check as an error, or what
    /// the liquidation would do. Pure.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn plan_liquidation(
        &self,
        id: MarketId,
        s: &Scenario,
        account: &AccountId,
        repay: Option<u128>,
        budget: u128,
        m: &Market,
        st: &TierState,
        snap: &PriceSnapshot,
    ) -> Result<Plan, String> {
        let c = &st.config;
        let (lltv, bonus) = (c.lltv, c.liquidation_bonus);
        liquidation_bonus_ok(lltv, bonus)?;
        let pieces = self.pieces(id, account);
        let owed_shares = self.borrow_shares_of(id, account);
        let debt = to_assets_up(owed_shares, m.total_borrow_assets, m.total_borrow_shares);
        let px = snap.prices(PriceMode::Liquidate);
        let v = value_pieces(s, &px, &pieces);
        let h = health_of(&v, debt, lltv);
        let hf = match h.hf {
            Some(hf) if hf < WAD => hf,
            other => return Err(format!("NotLiquidatable({})", hf_arg(other))),
        };
        if v.wnear_exposure != 0 {
            if let Some(guard) = snap.liquidation_guard() {
                return Err(guard.error());
            }
        }
        if v.unpriced != 0 {
            return Err(format!(
                "PriceUnavailable({})",
                masks::lowest_world(v.unpriced)
            ));
        }
        let l = &self.lending;
        let cap = risk::liquidation_cap(debt, hf, l.full_liquidation_hf, l.small_loan);
        let fsr = risk::full_seize_repay(h.lowest, bonus);
        let r = match repay {
            Some(x) if x > cap => return Err(format!("AboveCloseFactor({x}, {cap})")),
            Some(x) => x,
            None => cap.min(fsr),
        };
        if r == 0 {
            return Err("ZeroAmount".to_string());
        }
        if r > budget {
            return Err(format!("InsufficientRepayment({budget}, {r})"));
        }
        let target = risk::liquidation_target(r, bonus);
        let seize_all = target >= h.lowest;
        if !seize_all {
            let n = u32::try_from(pieces.len()).unwrap_or(u32::MAX);
            if risk::is_too_small(r, target, h.lowest, n, v.max_price) {
                return Err(format!("LiquidationTooSmall({r})"));
            }
            let left = debt - r;
            if left > 0 && left < l.min_loan {
                return Err(format!("DustDebtLeft({left}, {})", l.min_loan));
            }
        }
        let seized = pieces
            .iter()
            .map(|(_, held)| risk::seize_amount(*held, target, h.lowest))
            .collect();
        let shares = if r >= debt {
            owed_shares
        } else {
            to_shares_down(r, m.total_borrow_assets, m.total_borrow_shares).min(owed_shares)
        };
        let left_shares = owed_shares - shares;
        let written_off = if seize_all && left_shares > 0 {
            let tba = m.total_borrow_assets.saturating_sub(r);
            let tbs = m.total_borrow_shares.saturating_sub(shares);
            to_assets_up(left_shares, tba, tbs).min(tba)
        } else {
            0
        };
        Ok(Plan {
            owed_shares,
            c_min: h.lowest,
            worst: h.worst,
            repay: r,
            target,
            seize_all,
            pieces,
            seized,
            shares,
            written_off,
            factor: px.factor,
        })
    }

    /// Debt including pending interest, rounded up.
    pub(crate) fn debt_for(&self, id: MarketId, account: &AccountId) -> u128 {
        let (p, _) = self.projected(id);
        to_assets_up(
            self.borrow_shares_of(id, account),
            p.market.total_borrow_assets,
            p.market.total_borrow_shares,
        )
    }

    /// The market read once for a view: projected to now, with the
    /// scenario's prices. Fails `UnknownScenario`.
    pub(crate) fn market_ctx_view(&self, id: MarketId) -> MarketCtx {
        let scenario = self.scenario(id.scenario_id).clone();
        let snap = self.price_snapshot(id.scenario_id);
        let (p, state) = self.projected(id);
        self.market_ctx(id, scenario, p.market, state, snap)
    }

    /// A `MarketCtx` from parts already read.
    pub(crate) fn market_ctx(
        &self,
        id: MarketId,
        scenario: Scenario,
        market: Market,
        state: TierState,
        snap: PriceSnapshot,
    ) -> MarketCtx {
        let halted = self.halted(&scenario);
        MarketCtx {
            liq: snap.prices(PriceMode::Liquidate),
            borrow: snap.prices(PriceMode::Borrow),
            id,
            scenario,
            market,
            state,
            snap,
            halted,
            liquidation_paused: self.liquidations_paused(),
        }
    }

    /// One account in one market, valued on both sides, and its
    /// liquidation status in the order `none` → `paused` → `paused_halted` →
    /// `paused_reference` → `paused_no_price` → `liquidatable`.
    pub(crate) fn assess(&self, ctx: &MarketCtx, account: &AccountId) -> Assessment {
        let id = ctx.id;
        let pieces = self.pieces(id, account);
        let shares = self.borrow_shares_of(id, account);
        let m = &ctx.market;
        let debt = to_assets_up(shares, m.total_borrow_assets, m.total_borrow_shares);
        let c = &ctx.state.config;
        let liq = value_pieces(&ctx.scenario, &ctx.liq, &pieces);
        let liq_health = health_of(&liq, debt, c.lltv);
        let borrow = value_pieces(&ctx.scenario, &ctx.borrow, &pieces);
        let borrow_health = health_of(&borrow, debt, c.borrow_ltv);
        let guarded = liq.wnear_exposure != 0 && ctx.snap.liquidation_guard().is_some();
        let (status, unpriced_world) = if risk::is_healthy(liq_health.hf) {
            (LiquidationState::None, None)
        } else if ctx.liquidation_paused {
            (LiquidationState::Paused, None)
        } else if ctx.halted {
            (LiquidationState::PausedHalted, None)
        } else if guarded {
            (LiquidationState::PausedReference, None)
        } else if liq.unpriced != 0 {
            (
                LiquidationState::PausedNoPrice,
                Some(masks::lowest_world(liq.unpriced)),
            )
        } else {
            (LiquidationState::Liquidatable, None)
        };
        let (cap, fsr) = match liq_health.hf {
            Some(hf) if debt > 0 => (
                risk::liquidation_cap(
                    debt,
                    hf,
                    self.lending.full_liquidation_hf,
                    self.lending.small_loan,
                ),
                risk::full_seize_repay(liq_health.lowest, c.liquidation_bonus),
            ),
            _ => (0, 0),
        };
        let max_repay = if status == LiquidationState::Liquidatable {
            cap.min(fsr)
        } else {
            0
        };
        let write_off_ready = debt > 0 && liq.unpriced == 0 && liq.max_value() == 0;
        Assessment {
            pieces,
            debt,
            liq,
            liq_health,
            borrow_health,
            status,
            unpriced_world,
            cap,
            fsr,
            max_repay,
            write_off_ready,
        }
    }

    /// The JSON of one market.
    pub(crate) fn market_view(&self, id: MarketId, m: &Market, st: &TierState) -> MarketView {
        let c = &st.config;
        let utilization = irm::utilization(m.total_borrow_assets, m.total_supply_assets);
        let rate = c.curve().rate(utilization);
        MarketView {
            total_supply: U128(m.total_supply_assets),
            total_borrow: U128(m.total_borrow_assets),
            total_supply_shares: U128(m.total_supply_shares),
            total_borrow_shares: U128(m.total_borrow_shares),
            utilization: U128(utilization),
            supply_rate_per_sec: U128(irm::supply_rate(
                rate,
                m.total_supply_assets,
                m.total_borrow_assets,
                c.reserve_factor,
            )),
            borrow_rate_per_sec: U128(rate),
            last_update_sec: m.last_update,
            tier: id.tier,
            insurance: U128(st.insurance),
            liquid: U128(m.liquid()),
            bad_debt_covered: U128(st.bad_debt_covered),
            bad_debt_socialized: U128(st.bad_debt_socialized),
            borrowers: self.borrower_count_of(id),
            frozen: st.frozen,
            config: TierConfigView::from(c),
        }
    }

    fn give_piece(
        &mut self,
        account: &AccountId,
        scenario_id: u64,
        piece: CollateralKey,
        amount: u128,
    ) {
        match piece {
            CollateralKey::Real(asset) => self.real_credit(account, asset, amount),
            CollateralKey::Verse { asset, mask } => self.release_from_custody(
                account,
                &[(VerseKey::new(scenario_id, asset, mask), amount)],
                None,
            ),
        }
    }

    fn parse_piece(&self, scenario_id: u64, piece: &str) -> CollateralKey {
        self.scenario(scenario_id);
        CollateralKey::parse(scenario_id, piece).unwrap_or_else(|| fail!("NotCollateral({piece})"))
    }

    /// The account's pieces in one market.
    pub(crate) fn pieces(&self, id: MarketId, account: &AccountId) -> Vec<(CollateralKey, u128)> {
        self.collateral
            .get(&(id.key(), account.clone()))
            .cloned()
            .unwrap_or_default()
    }

    /// The only writer of `collateral`: v1 data is folded first, the books
    /// follow the real pieces and the account's index its lending entries.
    pub(crate) fn set_pieces(
        &mut self,
        id: MarketId,
        account: &AccountId,
        list: Vec<(CollateralKey, u128)>,
    ) {
        self.upgrade_account(account);
        let old_list = self.pieces(id, account);
        let old = real_pieces(&old_list);
        self.books_on_collateral(account, old, real_pieces(&list));
        let (was, is) = (!old_list.is_empty(), !list.is_empty());
        let k = (id.key(), account.clone());
        if list.is_empty() {
            self.collateral.remove(&k);
        } else {
            self.collateral.insert(k, list);
            #[cfg(test)]
            COLLATERAL_OWNERS.with(|o| o.borrow_mut().insert((id.key(), account.clone())));
        }
        self.note_lending(account, id.key(), was, is);
    }

    pub(crate) fn supply_shares_of(&self, id: MarketId, account: &AccountId) -> u128 {
        Self::amount_in(&self.supply_shares, id, account)
    }

    pub(crate) fn borrow_shares_of(&self, id: MarketId, account: &AccountId) -> u128 {
        Self::amount_in(&self.borrow_shares, id, account)
    }

    pub(crate) fn principal_of(&self, id: MarketId, account: &AccountId) -> u128 {
        Self::amount_in(&self.supply_principal, id, account)
    }

    fn set_principal(&mut self, id: MarketId, account: &AccountId, value: u128) {
        let k = (id.key(), account.clone());
        if value == 0 {
            self.supply_principal.remove(&k);
        } else {
            self.supply_principal.insert(k, value);
        }
    }

    fn amount_in(
        map: &near_sdk::store::LookupMap<(u64, AccountId), u128>,
        id: MarketId,
        account: &AccountId,
    ) -> u128 {
        map.get(&(id.key(), account.clone())).copied().unwrap_or(0)
    }

    /// The scenario's per-world prices as v1 reported them: a world prices
    /// lending when its pool is trusted.
    pub(crate) fn world_price_ok(&self, snap: &PriceSnapshot) -> Vec<bool> {
        snap.statuses()
            .into_iter()
            .map(|s| s == WorldStatus::Trusted)
            .collect()
    }
}
