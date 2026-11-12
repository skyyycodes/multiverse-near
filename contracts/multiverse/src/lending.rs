//! Money markets: one real-USDC market per scenario, with no creation step.
//!
//! Lenders supply USDC and earn one fixed per-second rate. Borrowers post
//! collateral pieces (live verse tokens of the scenario, or real wNEAR/USDC)
//! and borrow USDC up to what the worst still-possible world carries:
//! `HF = floor(C_min * lltv / debt)`. Below HF 1 anyone can liquidate: the
//! repayment (at most half the debt) buys the same fraction of every piece,
//! sized so the slice covers it in every world.
//!
//! Shares carry virtual offsets (1e6 shares, 1 asset). Interest is simple
//! over each interval and compounds at every touch; views add what is
//! pending without writing. A world without a valid price counts as zero for
//! borrowing, but pauses liquidation, and so does an open oracle proposal:
//! resolution can only raise a health factor, so liquidating during the
//! dispute window would front-run it.

use multiverse_math::mul_div_down;
use multiverse_math::risk;
use multiverse_math::shares::{to_assets_down, to_assets_up, to_shares_down, to_shares_up};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{assert_one_yocto, env, near, AccountId};

use crate::errors::{add, fail, mul, sub};
use crate::events::MultiverseEvent;
use crate::receiver::{LiquidateMsg, RepayMsg, ScenarioMsg};
use crate::types::{Asset, VerseKey, WAD};
use crate::{masks, now_sec, Contract, ContractExt};

/// Most pieces one account may post in one market.
pub const MAX_COLLATERAL_PIECES: usize = 16;

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
    /// USDC value per world; 0 for worlds that can no longer happen.
    pub values: Vec<U128>,
    pub possible: u8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CollateralPieceView {
    pub piece: String,
    pub amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketView {
    /// Supplied assets including interest not yet accrued.
    pub total_supply: U128,
    /// Borrowed assets including interest not yet accrued.
    pub total_borrow: U128,
    pub total_supply_shares: U128,
    pub total_borrow_shares: U128,
    /// WAD.
    pub utilization: U128,
    /// WAD per second.
    pub supply_rate_per_sec: U128,
    pub borrow_rate_per_sec: U128,
    pub last_update_sec: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LiquidationState {
    None,
    Liquidatable,
    PausedHalted,
    PausedNoPrice,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiquidationStatusView {
    pub status: LiquidationState,
    /// The lowest possible world without a price in which the account holds
    /// wNEAR-valued collateral, when that is what pauses liquidation.
    pub unpriced_world: Option<u8>,
}

/// Collateral of one account valued in every world of the scenario.
pub(crate) struct Valuation {
    pub values: Vec<u128>,
    pub possible: u8,
    /// Highest valid wNEAR price over all possible worlds.
    pub max_price: u128,
    /// Possible worlds without a price in which the account holds wNEAR-valued pieces.
    pub unpriced: u8,
}

pub(crate) struct Health {
    pub hf: Option<u128>,
    pub worst: u8,
    pub lowest: u128,
    pub debt: u128,
}

/// What a liquidation did; `pieces` is the list as it was before seizure,
/// `seized` aligned with it (zeros kept).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Liquidation {
    pub repaid: u128,
    pub shares: u128,
    pub pieces: Vec<CollateralKey>,
    pub seized: Vec<u128>,
}

/// Liquidating just below HF 1 must raise HF. That needs `C_min / debt >
/// 1 + bonus` while HF < 1 means `C_min / debt < 1 / lltv`, so the
/// parameters must satisfy `lltv * (1 + bonus) < 1`.
pub fn check_liquidation_bonus(lltv: u128, bonus: u128) {
    if bonus == 0 || mul_div_down(lltv, add(WAD, bonus), WAD) >= WAD {
        fail!("InvalidLiquidationBonus({bonus})");
    }
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct SupplyLog<'a> {
    scenario_id: u64,
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
    account_id: &'a AccountId,
    assets: U128,
    shares: U128,
}

impl MultiverseEvent for RepayLog<'_> {
    const NAME: &'static str = "repay";
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct AccrueLog {
    scenario_id: u64,
    interest: U128,
}

impl MultiverseEvent for AccrueLog {
    const NAME: &'static str = "accrue";
}

/// `c_min` and `worst_world` are the pre-liquidation worst world, so the
/// coverage of a slice can be checked from the log alone.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct LiquidateLog<'a> {
    scenario_id: u64,
    account_id: &'a AccountId,
    liquidator_id: &'a AccountId,
    repaid: U128,
    shares: U128,
    pieces: Vec<String>,
    seized: Vec<U128>,
    c_min: U128,
    worst_world: u8,
}

impl MultiverseEvent for LiquidateLog<'_> {
    const NAME: &'static str = "liquidate";
}

#[cfg(test)]
thread_local! {
    /// Every (market, account) that ever posted collateral, so the tests can
    /// sum what lending holds of a key; lookup maps cannot be iterated.
    static COLLATERAL_OWNERS: std::cell::RefCell<std::collections::BTreeSet<(u64, AccountId)>> =
        const { std::cell::RefCell::new(std::collections::BTreeSet::new()) };
}

fn hf_arg(hf: Option<u128>) -> u128 {
    hf.unwrap_or(u128::MAX)
}

#[near]
impl Contract {
    /// Withdraws supplied USDC (all of it with `amount` null) to the wallet.
    #[payable]
    pub fn withdraw_supply(&mut self, scenario_id: u64, amount: Option<U128>) -> U128 {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        let assets = self.withdraw_supply_for(&account, scenario_id, amount.map(|a| a.0));
        self.payout(&account, Asset::Usdc, assets);
        self.charge_storage(&account, before);
        U128(assets)
    }

    /// Posts `amount` of a piece the caller holds: a verse token id of this
    /// scenario from the ledger, or `"wnear"` / `"usdc"` from the internal
    /// real balance. Only for the caller's own account.
    #[payable]
    pub fn deposit_collateral(&mut self, scenario_id: u64, piece: String, amount: U128) {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        let key = self.parse_piece(scenario_id, &piece);
        self.deposit_collateral_for(&account, scenario_id, key, amount.0);
        self.charge_storage(&account, before);
    }

    /// Takes a piece back: verse tokens to the ledger, real assets to the
    /// wallet. With debt the account must stay healthy.
    #[payable]
    pub fn withdraw_collateral(&mut self, scenario_id: u64, piece: String, amount: U128) {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        let key = CollateralKey::parse(scenario_id, &piece)
            .unwrap_or_else(|| fail!("NotCollateral({piece})"));
        self.withdraw_collateral_for(&account, scenario_id, key, amount.0);
        if let CollateralKey::Real(asset) = key {
            self.real_debit(&account, asset, amount.0);
            self.payout(&account, asset, amount.0);
        }
        self.charge_storage(&account, before);
    }

    /// Borrows USDC to the wallet.
    #[payable]
    pub fn borrow(&mut self, scenario_id: u64, amount: U128) {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        self.borrow_for(&account, scenario_id, amount.0);
        self.charge_storage(&account, before);
    }

    /// Repays from the internal USDC balance, the whole debt with `amount`
    /// null. Returns what was repaid.
    #[payable]
    pub fn repay_from_balance(&mut self, scenario_id: u64, amount: Option<U128>) -> U128 {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        let repaid = self.repay_for(&account, scenario_id, amount.map_or(u128::MAX, |a| a.0));
        self.charge_storage(&account, before);
        U128(repaid)
    }

    /// Debt including pending interest, rounded up.
    pub fn debt_of(&self, scenario_id: u64, account_id: AccountId) -> U128 {
        U128(self.debt_for(scenario_id, &account_id))
    }

    pub fn health_factor(&self, scenario_id: u64, account_id: AccountId) -> HealthView {
        let (_, h) = self.health(scenario_id, &account_id);
        HealthView {
            health_factor: h.hf.map(U128),
            worst_world: Some(h.worst),
        }
    }

    pub fn collateral_values(
        &self,
        scenario_id: u64,
        account_id: AccountId,
    ) -> CollateralValuesView {
        let v = self.valuation(scenario_id, &account_id);
        CollateralValuesView {
            values: v.values.into_iter().map(U128).collect(),
            possible: v.possible,
        }
    }

    /// The account's pieces in list order.
    pub fn collateral_of(
        &self,
        scenario_id: u64,
        account_id: AccountId,
    ) -> Vec<CollateralPieceView> {
        self.pieces(scenario_id, &account_id)
            .into_iter()
            .map(|(key, amount)| CollateralPieceView {
                piece: key.piece_id(scenario_id),
                amount: U128(amount),
            })
            .collect()
    }

    pub fn market_state(&self, scenario_id: u64) -> MarketView {
        let m = self.market(scenario_id);
        let (total_borrow, interest) = self.expected_borrow(&m);
        let total_supply = add(m.total_supply_assets, interest);
        let utilization = if total_supply == 0 {
            0
        } else {
            mul_div_down(total_borrow, WAD, total_supply)
        };
        let rate = self.params.borrow_rate_per_sec;
        MarketView {
            total_supply: U128(total_supply),
            total_borrow: U128(total_borrow),
            total_supply_shares: U128(m.total_supply_shares),
            total_borrow_shares: U128(m.total_borrow_shares),
            utilization: U128(utilization),
            supply_rate_per_sec: U128(mul_div_down(rate, utilization, WAD)),
            borrow_rate_per_sec: U128(rate),
            last_update_sec: m.last_update,
        }
    }

    /// What the lender's shares are worth now, pending interest included.
    pub fn supply_balance_of(&self, scenario_id: u64, account_id: AccountId) -> U128 {
        let m = self.market(scenario_id);
        let (_, interest) = self.expected_borrow(&m);
        let shares = self.supply_shares_of(scenario_id, &account_id);
        U128(to_assets_down(
            shares,
            add(m.total_supply_assets, interest),
            m.total_supply_shares,
        ))
    }

    /// USDC supplied minus USDC withdrawn (floored at 0), for showing earnings.
    pub fn supply_principal_of(&self, scenario_id: u64, account_id: AccountId) -> U128 {
        U128(Self::amount_in(
            &self.supply_principal,
            scenario_id,
            &account_id,
        ))
    }

    pub fn liquidation_status(
        &self,
        scenario_id: u64,
        account_id: AccountId,
    ) -> LiquidationStatusView {
        let (v, h) = self.health(scenario_id, &account_id);
        let (status, unpriced_world) = if risk::is_healthy(h.hf) {
            (LiquidationState::None, None)
        } else if self.is_halted(scenario_id) {
            (LiquidationState::PausedHalted, None)
        } else if v.unpriced != 0 {
            (
                LiquidationState::PausedNoPrice,
                Some(masks::lowest_world(v.unpriced)),
            )
        } else {
            (LiquidationState::Liquidatable, None)
        };
        LiquidationStatusView {
            status,
            unpriced_world,
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
        self.supply_for(sender, msg.scenario_id, amount);
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
        if msg.all {
            let debt = self.debt_for(msg.scenario_id, sender);
            if amount < debt {
                fail!("InsufficientRepayment({amount}, {debt})");
            }
        }
        self.repay_for(sender, msg.scenario_id, amount);
    }

    pub(crate) fn ft_deposit_collateral(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        amount: u128,
        msg: ScenarioMsg,
    ) {
        self.deposit_collateral_for(sender, msg.scenario_id, CollateralKey::Real(asset), amount);
    }

    /// The sender liquidates with the attached USDC; it must cover what the
    /// liquidation repays.
    pub(crate) fn ft_liquidate(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        amount: u128,
        msg: LiquidateMsg,
    ) {
        Self::require_usdc(asset);
        let repay = match msg.repay_amount {
            RepayAmount::Max(_) => None,
            RepayAmount::Amount(a) => Some(a.0),
        };
        self.liquidate_for(sender, msg.scenario_id, &msg.account_id, repay, amount);
    }

    fn require_usdc(asset: Asset) {
        if asset != Asset::Usdc {
            fail!("WrongAsset({asset})");
        }
    }

    /// True while `account_id` has supply, debt or collateral in any market;
    /// it blocks `storage_unregister`.
    pub(crate) fn has_lending_position(&self, account_id: &AccountId) -> bool {
        (1..=self.scenario_count).any(|s| {
            let k = (s, account_id.clone());
            self.supply_shares.contains_key(&k)
                || self.supply_principal.contains_key(&k)
                || self.borrow_shares.contains_key(&k)
                || self.collateral.contains_key(&k)
        })
    }

    /// Verse tokens of `key` held as collateral, for the conservation check
    /// in the tests.
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
                .filter(|(s, _)| *s == key.scenario)
                .flat_map(|(s, a)| self.pieces(*s, a))
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
    pub(crate) fn supply_for(
        &mut self,
        account: &AccountId,
        scenario_id: u64,
        assets: u128,
    ) -> u128 {
        if assets == 0 {
            fail("ZeroAmount");
        }
        self.scenario(scenario_id);
        let mut m = self.accrue(scenario_id);
        let shares = to_shares_down(assets, m.total_supply_assets, m.total_supply_shares);
        m.total_supply_assets = add(m.total_supply_assets, assets);
        m.total_supply_shares = add(m.total_supply_shares, shares);
        self.markets.insert(scenario_id, m);
        let held = self.supply_shares_of(scenario_id, account);
        Self::set_amount(
            &mut self.supply_shares,
            scenario_id,
            account,
            add(held, shares),
        );
        let principal = Self::amount_in(&self.supply_principal, scenario_id, account);
        Self::set_amount(
            &mut self.supply_principal,
            scenario_id,
            account,
            add(principal, assets),
        );
        self.real_debit(account, Asset::Usdc, assets);
        SupplyLog {
            scenario_id,
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
        scenario_id: u64,
        amount: Option<u128>,
    ) -> u128 {
        let mut m = self.accrue(scenario_id);
        let user_shares = self.supply_shares_of(scenario_id, account);
        let owned = to_assets_down(user_shares, m.total_supply_assets, m.total_supply_shares);
        let assets = amount.unwrap_or(owned);
        if assets == 0 {
            fail("ZeroAmount");
        }
        if assets > owned {
            fail!("InsufficientSupply({assets}, {owned})");
        }
        let liquid = sub(m.total_supply_assets, m.total_borrow_assets);
        if assets > liquid {
            fail!("InsufficientLiquidity({assets}, {liquid})");
        }
        let shares =
            to_shares_up(assets, m.total_supply_assets, m.total_supply_shares).min(user_shares);
        m.total_supply_shares = sub(m.total_supply_shares, shares);
        m.total_supply_assets = sub(m.total_supply_assets, assets);
        self.markets.insert(scenario_id, m);
        Self::set_amount(
            &mut self.supply_shares,
            scenario_id,
            account,
            user_shares - shares,
        );
        let principal = Self::amount_in(&self.supply_principal, scenario_id, account);
        Self::set_amount(
            &mut self.supply_principal,
            scenario_id,
            account,
            principal.saturating_sub(assets),
        );
        WithdrawLog {
            scenario_id,
            account_id: account,
            assets: U128(assets),
            shares: U128(shares),
        }
        .emit();
        assets
    }

    /// Posts `amount` of `piece` from `account`'s ledger (verse) or internal
    /// real balance (real asset). No accrual and no health check: adding
    /// collateral can only help, and it is allowed while halted.
    pub(crate) fn deposit_collateral_for(
        &mut self,
        account: &AccountId,
        scenario_id: u64,
        piece: CollateralKey,
        amount: u128,
    ) {
        if amount == 0 {
            fail("ZeroAmount");
        }
        let s = self.scenario(scenario_id);
        let (root, possible) = (s.root(), s.possible);
        if let CollateralKey::Verse { mask, .. } = piece {
            // root is the real asset itself, never a token
            if mask == 0 || mask == root || !masks::is_subset(mask, root) {
                fail!("NotCollateral({})", piece.piece_id(scenario_id));
            }
            if !masks::is_live(mask, possible) {
                fail!("DeadVerse({mask})");
            }
        }
        let mut list = self.pieces(scenario_id, account);
        match list.iter_mut().find(|(k, _)| *k == piece) {
            Some((_, held)) => *held = add(*held, amount),
            None => {
                if list.len() >= MAX_COLLATERAL_PIECES {
                    fail("TooManyCollateralTokens");
                }
                list.push((piece, amount));
            }
        }
        self.set_pieces(scenario_id, account, list);
        match piece {
            CollateralKey::Real(asset) => self.real_debit(account, asset, amount),
            CollateralKey::Verse { asset, mask } => self.take_into_custody(
                account,
                &[(VerseKey::new(scenario_id, asset, mask), amount)],
                None,
            ),
        }
        DepositCollateralLog {
            scenario_id,
            account_id: account,
            piece: piece.piece_id(scenario_id),
            amount: U128(amount),
        }
        .emit();
        #[cfg(test)]
        COLLATERAL_OWNERS.with(|o| o.borrow_mut().insert((scenario_id, account.clone())));
    }

    /// Takes `amount` of `piece` off the account's collateral and gives it
    /// back to the account (verse tokens to the ledger, real assets to the
    /// internal real balance). With debt the account must stay healthy.
    pub(crate) fn withdraw_collateral_for(
        &mut self,
        account: &AccountId,
        scenario_id: u64,
        piece: CollateralKey,
        amount: u128,
    ) {
        if amount == 0 {
            fail("ZeroAmount");
        }
        self.accrue(scenario_id);
        let mut list = self.pieces(scenario_id, account);
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
        self.set_pieces(scenario_id, account, list);
        if self.borrow_shares_of(scenario_id, account) != 0 {
            self.assert_healthy(scenario_id, account);
        }
        self.give_piece(account, scenario_id, piece, amount);
        WithdrawCollateralLog {
            scenario_id,
            account_id: account,
            piece: piece.piece_id(scenario_id),
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
        scenario_id: u64,
    ) -> Vec<(CollateralKey, u128)> {
        self.scenario(scenario_id);
        let list = self.pieces(scenario_id, account);
        if list.is_empty() {
            return list;
        }
        self.accrue(scenario_id);
        self.set_pieces(scenario_id, account, Vec::new());
        if self.borrow_shares_of(scenario_id, account) != 0 {
            self.assert_healthy(scenario_id, account);
        }
        for (piece, amount) in &list {
            self.give_piece(account, scenario_id, *piece, *amount);
            WithdrawCollateralLog {
                scenario_id,
                account_id: account,
                piece: piece.piece_id(scenario_id),
                amount: U128(*amount),
            }
            .emit();
        }
        list
    }

    /// Borrows `amount` USDC for `account` and pays it out to the account's
    /// wallet. The health check runs on the new debt.
    pub(crate) fn borrow_for(&mut self, account: &AccountId, scenario_id: u64, amount: u128) {
        if amount == 0 {
            fail("ZeroAmount");
        }
        let mut m = self.accrue(scenario_id);
        let liquid = sub(m.total_supply_assets, m.total_borrow_assets);
        if amount > liquid {
            fail!("InsufficientLiquidity({amount}, {liquid})");
        }
        let shares = to_shares_up(amount, m.total_borrow_assets, m.total_borrow_shares);
        m.total_borrow_shares = add(m.total_borrow_shares, shares);
        m.total_borrow_assets = add(m.total_borrow_assets, amount);
        self.markets.insert(scenario_id, m);
        let owed = self.borrow_shares_of(scenario_id, account);
        Self::set_amount(
            &mut self.borrow_shares,
            scenario_id,
            account,
            add(owed, shares),
        );
        self.assert_healthy(scenario_id, account);
        BorrowLog {
            scenario_id,
            account_id: account,
            assets: U128(amount),
            shares: U128(shares),
        }
        .emit();
        self.payout(account, Asset::Usdc, amount);
    }

    /// Repays up to `max_amount` of `account`'s debt from its internal USDC
    /// balance; `max_amount >= debt` (e.g. u128::MAX) repays all of it.
    /// Returns what was repaid. Nothing to repay is `ZeroAmount`.
    pub(crate) fn repay_for(
        &mut self,
        account: &AccountId,
        scenario_id: u64,
        max_amount: u128,
    ) -> u128 {
        let mut m = self.accrue(scenario_id);
        let owed_shares = self.borrow_shares_of(scenario_id, account);
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
        Self::set_amount(
            &mut self.borrow_shares,
            scenario_id,
            account,
            owed_shares - shares,
        );
        m.total_borrow_shares = sub(m.total_borrow_shares, shares);
        // the last borrower's rounded-up debt can exceed the total by a unit
        m.total_borrow_assets = m.total_borrow_assets.saturating_sub(assets);
        self.markets.insert(scenario_id, m);
        self.real_debit(account, Asset::Usdc, assets);
        RepayLog {
            scenario_id,
            account_id: account,
            assets: U128(assets),
            shares: U128(shares),
        }
        .emit();
        assets
    }

    /// `liquidator` repays part of `account`'s debt from its internal USDC
    /// balance (half the debt with `repay` None) and receives the same
    /// fraction `min(1, target / C_min)` of every piece: verse tokens in its
    /// ledger, real assets in its internal real balance. A repayment above
    /// `budget` fails before anything moves.
    pub(crate) fn liquidate_for(
        &mut self,
        liquidator: &AccountId,
        scenario_id: u64,
        account: &AccountId,
        repay: Option<u128>,
        budget: u128,
    ) -> Liquidation {
        let (lltv, bonus) = (self.params.lltv, self.params.liquidation_bonus);
        check_liquidation_bonus(lltv, bonus);
        if repay == Some(0) {
            fail("ZeroAmount");
        }
        if self.is_halted(scenario_id) {
            fail!("ScenarioHalted({scenario_id})");
        }
        let mut m = self.accrue(scenario_id);
        let owed_shares = self.borrow_shares_of(scenario_id, account);
        let (v, h) = self.health(scenario_id, account);
        if risk::is_healthy(h.hf) {
            fail!("NotLiquidatable({})", hf_arg(h.hf));
        }
        if v.unpriced != 0 {
            fail!("PriceUnavailable({})", masks::lowest_world(v.unpriced));
        }
        let max_repay = risk::max_repay(h.debt);
        let repaid = match repay {
            Some(r) if r > max_repay => fail!("AboveCloseFactor({r}, {max_repay})"),
            Some(r) => r,
            None => max_repay,
        };
        if repaid == 0 {
            fail("ZeroAmount");
        }
        if repaid > budget {
            fail!("InsufficientRepayment({budget}, {repaid})");
        }
        let target = risk::liquidation_target(repaid, bonus);
        let list = self.pieces(scenario_id, account);
        let n = u32::try_from(list.len()).unwrap_or(u32::MAX);
        if risk::is_too_small(repaid, target, h.lowest, n, v.max_price) {
            fail!("LiquidationTooSmall({repaid})");
        }

        let shares =
            to_shares_down(repaid, m.total_borrow_assets, m.total_borrow_shares).min(owed_shares);
        Self::set_amount(
            &mut self.borrow_shares,
            scenario_id,
            account,
            owed_shares - shares,
        );
        m.total_borrow_shares = sub(m.total_borrow_shares, shares);
        m.total_borrow_assets = m.total_borrow_assets.saturating_sub(repaid);
        self.markets.insert(scenario_id, m);

        let mut left = list.clone();
        let mut seized = vec![0u128; list.len()];
        for (i, (piece, held)) in list.iter().enumerate() {
            let amount = risk::seize_amount(*held, target, h.lowest);
            if amount == 0 {
                continue;
            }
            seized[i] = amount;
            let at = left
                .iter()
                .position(|(k, _)| k == piece)
                .unwrap_or_else(|| env::abort());
            if amount == *held {
                left.swap_remove(at);
            } else {
                left[at].1 = held - amount;
            }
        }
        self.set_pieces(scenario_id, account, left);

        self.real_debit(liquidator, Asset::Usdc, repaid);
        let mut verse = Vec::new();
        for ((piece, _), amount) in list.iter().zip(&seized) {
            if *amount == 0 {
                continue;
            }
            match *piece {
                CollateralKey::Real(asset) => self.real_credit(liquidator, asset, *amount),
                CollateralKey::Verse { asset, mask } => {
                    verse.push((VerseKey::new(scenario_id, asset, mask), *amount));
                }
            }
        }
        self.release_from_custody(liquidator, &verse, None);

        let pieces: Vec<CollateralKey> = list.iter().map(|(k, _)| *k).collect();
        LiquidateLog {
            scenario_id,
            account_id: account,
            liquidator_id: liquidator,
            repaid: U128(repaid),
            shares: U128(shares),
            pieces: pieces.iter().map(|k| k.piece_id(scenario_id)).collect(),
            seized: seized.iter().map(|a| U128(*a)).collect(),
            c_min: U128(h.lowest),
            worst_world: h.worst,
        }
        .emit();
        Liquidation {
            repaid,
            shares,
            pieces,
            seized,
        }
    }

    /// Debt including pending interest, rounded up.
    pub(crate) fn debt_for(&self, scenario_id: u64, account: &AccountId) -> u128 {
        let m = self.market(scenario_id);
        let (borrowed, _) = self.expected_borrow(&m);
        to_assets_up(
            self.borrow_shares_of(scenario_id, account),
            borrowed,
            m.total_borrow_shares,
        )
    }

    /// Every world of the scenario valued at its wNEAR price; worlds that can
    /// no longer happen stay 0, and so does wNEAR in a world without a price.
    pub(crate) fn valuation(&self, scenario_id: u64, account: &AccountId) -> Valuation {
        let s = self.scenario(scenario_id);
        let (worlds, possible, root) = (s.world_count, s.possible, s.root());
        let mut prices = vec![0u128; usize::from(worlds)];
        let mut priced = 0u8;
        let mut max_price = 0u128;
        for w in 0..worlds {
            if !masks::contains(possible, w) {
                continue;
            }
            let (price, ok) = self.world_price(scenario_id, w);
            if ok {
                prices[usize::from(w)] = price;
                priced |= 1 << w;
                max_price = max_price.max(price);
            }
        }
        let mut values = vec![0u128; usize::from(worlds)];
        let mut unpriced = 0u8;
        for (piece, amount) in self.pieces(scenario_id, account) {
            let mask = piece.mask(root);
            let usdc = piece.asset() == Asset::Usdc;
            if !usdc {
                unpriced |= mask & possible & !priced;
            }
            for w in 0..worlds {
                if !masks::contains(possible & mask, w) {
                    continue;
                }
                let i = usize::from(w);
                let value = if usdc {
                    amount
                } else {
                    risk::wnear_value(amount, prices[i])
                };
                values[i] = add(values[i], value);
            }
        }
        Valuation {
            values,
            possible,
            max_price,
            unpriced,
        }
    }

    pub(crate) fn health(&self, scenario_id: u64, account: &AccountId) -> (Valuation, Health) {
        let v = self.valuation(scenario_id, account);
        // the scenario always keeps a possible world
        let (worst, lowest) = risk::worst_world(&v.values, v.possible).unwrap_or((0, 0));
        let debt = self.debt_for(scenario_id, account);
        let hf = risk::health_factor(lowest, debt, self.params.lltv);
        (
            v,
            Health {
                hf,
                worst,
                lowest,
                debt,
            },
        )
    }

    fn assert_healthy(&self, scenario_id: u64, account: &AccountId) {
        let (_, h) = self.health(scenario_id, account);
        if !risk::is_healthy(h.hf) {
            fail!("Unhealthy({}, {})", hf_arg(h.hf), h.worst);
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

    pub(crate) fn market(&self, scenario_id: u64) -> Market {
        self.markets.get(&scenario_id).cloned().unwrap_or_default()
    }

    /// Borrowed assets with pending interest, and that interest:
    /// `floor(B * rate * elapsed / 1e18)`.
    fn expected_borrow(&self, m: &Market) -> (u128, u128) {
        let borrowed = m.total_borrow_assets;
        let elapsed = if m.last_update == 0 {
            0
        } else {
            now_sec().saturating_sub(m.last_update)
        };
        if elapsed == 0 || borrowed == 0 {
            return (borrowed, 0);
        }
        let factor = mul(self.params.borrow_rate_per_sec, u128::from(elapsed));
        let interest = mul_div_down(borrowed, factor, WAD);
        (add(borrowed, interest), interest)
    }

    /// Adds pending interest to both sides and stamps the time, also on the
    /// first touch. Returns the updated market (already stored).
    fn accrue(&mut self, scenario_id: u64) -> Market {
        let mut m = self.market(scenario_id);
        let (borrowed, interest) = self.expected_borrow(&m);
        m.last_update = now_sec();
        if interest > 0 {
            m.total_borrow_assets = borrowed;
            m.total_supply_assets = add(m.total_supply_assets, interest);
            AccrueLog {
                scenario_id,
                interest: U128(interest),
            }
            .emit();
        }
        self.markets.insert(scenario_id, m.clone());
        m
    }

    pub(crate) fn pieces(
        &self,
        scenario_id: u64,
        account: &AccountId,
    ) -> Vec<(CollateralKey, u128)> {
        self.collateral
            .get(&(scenario_id, account.clone()))
            .cloned()
            .unwrap_or_default()
    }

    fn set_pieces(
        &mut self,
        scenario_id: u64,
        account: &AccountId,
        list: Vec<(CollateralKey, u128)>,
    ) {
        let k = (scenario_id, account.clone());
        if list.is_empty() {
            self.collateral.remove(&k);
        } else {
            self.collateral.insert(k, list);
        }
    }

    pub(crate) fn supply_shares_of(&self, scenario_id: u64, account: &AccountId) -> u128 {
        Self::amount_in(&self.supply_shares, scenario_id, account)
    }

    pub(crate) fn borrow_shares_of(&self, scenario_id: u64, account: &AccountId) -> u128 {
        Self::amount_in(&self.borrow_shares, scenario_id, account)
    }

    fn amount_in(
        map: &near_sdk::store::LookupMap<(u64, AccountId), u128>,
        scenario_id: u64,
        account: &AccountId,
    ) -> u128 {
        map.get(&(scenario_id, account.clone()))
            .copied()
            .unwrap_or(0)
    }

    fn set_amount(
        map: &mut near_sdk::store::LookupMap<(u64, AccountId), u128>,
        scenario_id: u64,
        account: &AccountId,
        value: u128,
    ) {
        let k = (scenario_id, account.clone());
        if value == 0 {
            map.remove(&k);
        } else {
            map.insert(k, value);
        }
    }
}
