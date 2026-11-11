//! Root LP vault: one deposit of real WETH and USDC provides liquidity in
//! every world of a scenario.
//!
//! A deposit is split from root into every live world and added to each
//! world's pool at that pool's own price, as one vault position per pool.
//! What a pool cannot take comes straight back: the part every live world
//! has left over as the real asset (merged), the rest as world tokens. A
//! share is a claim on `1 / supply` of every live world's position, idle
//! tokens and uncollected fees; the first deposit locks 1,000 shares that
//! belong to nobody, so the supply never returns to zero.
//!
//! Fees are collected into the vault's idle balances on every deposit and
//! withdrawal, before that action's shares are priced, so they belong to the
//! holders of the period they accrued in (a joiner buys into them). Dead
//! worlds are never touched again; after a full resolution a withdrawal is
//! paid in real assets only. Nothing here checks halts: liquidity moves while
//! a scenario is halted, only swaps stop.
//!
//! The vault's tokens stay in the contract's custody (pool reserves, pool
//! fees, idle), so they count in the verse supply but in nobody's balance.

use multiverse_math::cpmm;
use multiverse_math::fixed::{checked_mul_div, mul_div, Rounding};
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{assert_one_yocto, env, near, AccountId};

use crate::amm::Position;
use crate::errors::{add, fail, sub};
use crate::events::MultiverseEvent;
use crate::masks;
use crate::receiver::LpDepositMsg;
use crate::types::{Asset, VerseKey};
use crate::{Contract, ContractExt};

/// Whether the Root LP is live; served to the app by `get_app_config`.
pub const ENABLED: bool = true;

/// Locked on the first deposit (Uniswap v2's MINIMUM_LIQUIDITY): nobody can
/// make a single share worth more than a later deposit.
pub const MINIMUM_SHARES: u128 = 1_000;

/// Shares are pool liquidity units, which scale like the 18-decimal amounts.
pub const SHARE_DECIMALS: u8 = 18;

/// One scenario's vault. Per-world vectors are indexed by world.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Vault {
    /// Share supply, the locked shares included.
    pub supply: u128,
    pub positions: Vec<Position>,
    pub weth_idle: Vec<u128>,
    pub usdc_idle: Vec<u128>,
}

impl Vault {
    fn new(world_count: u8) -> Self {
        let n = usize::from(world_count);
        Self {
            supply: MINIMUM_SHARES,
            positions: vec![Position::default(); n],
            weth_idle: vec![0; n],
            usdc_idle: vec![0; n],
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootLpHolding {
    pub world: u8,
    /// The vault's liquidity units in the world pool.
    pub liquidity: U128,
    /// What that liquidity is worth at the pool's current price, rounded down.
    pub weth_in_pool: U128,
    pub usdc_in_pool: U128,
    pub weth_idle: U128,
    pub usdc_idle: U128,
    /// Fees the position earned and the vault has not collected yet.
    pub weth_fees: U128,
    pub usdc_fees: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LpDepositPreview {
    pub shares: U128,
    /// Per world (0 for dead worlds): what the vault keeps of the deposit.
    /// The depositor gets `amount - kept` back in that world.
    pub weth_kept: Vec<U128>,
    pub usdc_kept: Vec<U128>,
}

/// Per-world amounts, indexed by world (0 for dead worlds).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldAmounts {
    pub weth: Vec<U128>,
    pub usdc: Vec<U128>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LpSharesView {
    pub balance: U128,
    /// Zero before the first deposit.
    pub supply: U128,
}

/// The Root LP part of the lend screen.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootLpView {
    pub share_supply: U128,
    pub your_shares: U128,
    pub share_decimals: u8,
    /// What `your_shares` would withdraw per world, before merging; null
    /// without shares.
    pub preview_withdraw: Option<WorldAmounts>,
    pub holdings: Vec<RootLpHolding>,
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct LpDeposited<'a> {
    pub scenario_id: u64,
    pub account_id: &'a AccountId,
    pub weth_amount: U128,
    pub usdc_amount: U128,
    pub shares: U128,
    /// Real assets merged back; the other leftovers stay as world tokens.
    pub weth_refund: U128,
    pub usdc_refund: U128,
}

impl MultiverseEvent for LpDeposited<'_> {
    const NAME: &'static str = "lp_deposit";
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct LpWithdrawn<'a> {
    pub scenario_id: u64,
    pub account_id: &'a AccountId,
    pub shares: U128,
    /// Real assets paid out; the rest stays as world tokens.
    pub weth_out: U128,
    pub usdc_out: U128,
}

impl MultiverseEvent for LpWithdrawn<'_> {
    const NAME: &'static str = "lp_withdraw";
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct LpFeesCollected {
    pub scenario_id: u64,
    pub world: u8,
    pub weth_fees: U128,
    pub usdc_fees: U128,
}

impl MultiverseEvent for LpFeesCollected {
    const NAME: &'static str = "lp_fees_collected";
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct LpTransferred<'a> {
    pub scenario_id: u64,
    pub old_owner_id: &'a AccountId,
    pub new_owner_id: &'a AccountId,
    pub shares: U128,
}

impl MultiverseEvent for LpTransferred<'_> {
    const NAME: &'static str = "lp_transfer";
}

/// A live world as an action or view finds it.
struct LiveWorld {
    world: u8,
    pool_id: u64,
    amm: cpmm::Pool,
    position: Position,
    weth_idle: u128,
    usdc_idle: u128,
    weth_fees: u128,
    usdc_fees: u128,
}

impl LiveWorld {
    fn mask(&self) -> u8 {
        1 << self.world
    }

    /// Idle tokens plus uncollected fees: what a share claims besides the
    /// position.
    fn held(&self) -> (u128, u128) {
        (
            add(self.weth_idle, self.weth_fees),
            add(self.usdc_idle, self.usdc_fees),
        )
    }

    fn amounts(&self, liquidity: u128, rounding: Rounding) -> (u128, u128) {
        if liquidity == 0 {
            return (0, 0);
        }
        self.amm
            .amounts_for_liquidity(liquidity, rounding)
            .unwrap_or_else(|e| fail!("{e}"))
    }

    /// What `shares` of `supply` withdraw here: the position's share at the
    /// current price plus the share of idle and fees, all rounded down.
    fn withdrawal(&self, shares: u128, supply: u128) -> (u128, u128) {
        let liquidity = mul_div(shares, self.position.liquidity(), supply, Rounding::Down);
        let (weth, usdc) = self.amounts(liquidity, Rounding::Down);
        let (weth_held, usdc_held) = self.held();
        (
            add(weth, mul_div(shares, weth_held, supply, Rounding::Down)),
            add(usdc, mul_div(shares, usdc_held, supply, Rounding::Down)),
        )
    }
}

/// What a deposit does in one world.
#[derive(Clone, Copy, Default)]
struct Leg {
    liquidity: u128,
    /// The pool's pay-in for `liquidity`, rounded up.
    weth_pool: u128,
    usdc_pool: u128,
    /// The buy-in to idle tokens and uncollected fees, rounded up.
    weth_idle: u128,
    usdc_idle: u128,
}

struct Plan {
    shares: u128,
    legs: Vec<Leg>,
}

/// Shares `amount` can fund when one share needs `need / supply`, keeping
/// `unit + 2` back so rounding up the pay-in and the idle buy-in can never
/// overdraw it.
fn affordable(amount: u128, unit: u128, need: u128, supply: u128) -> u128 {
    if need == 0 {
        return u128::MAX;
    }
    amount
        .checked_sub(unit)
        .and_then(|a| a.checked_sub(2))
        .map_or(0, |spare| {
            checked_mul_div(spare, supply, need, Rounding::Down).unwrap_or(u128::MAX)
        })
}

#[near]
impl Contract {
    /// Deposits `weth_amount` and `usdc_amount` from the caller's internal
    /// real balances; the `lp_deposit` action does the same with attached
    /// USDC. Returns the shares minted.
    #[payable]
    pub fn lp_deposit(
        &mut self,
        scenario_id: u64,
        weth_amount: U128,
        usdc_amount: U128,
        min_shares: U128,
    ) -> U128 {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        let shares = self.lp_deposit_for(
            &account,
            scenario_id,
            weth_amount.0,
            usdc_amount.0,
            min_shares.0,
        );
        self.charge_storage(&account, before);
        U128(shares)
    }

    /// Burns `shares` of the caller's and pays out their claim: what every
    /// live world has in common as real WETH and USDC, the rest as world
    /// tokens. Minimums are per world (length `world_count`, dead worlds
    /// ignored) and apply before merging. Returns the real amounts.
    #[payable]
    pub fn lp_withdraw(
        &mut self,
        scenario_id: u64,
        shares: U128,
        min_weth_out: Vec<U128>,
        min_usdc_out: Vec<U128>,
    ) -> (U128, U128) {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        let (weth, usdc) = self.lp_withdraw_for(
            &account,
            scenario_id,
            shares.0,
            &min_weth_out,
            &min_usdc_out,
        );
        self.payout(&account, Asset::Weth, weth);
        self.payout(&account, Asset::Usdc, usdc);
        self.charge_storage(&account, before);
        (U128(weth), U128(usdc))
    }

    /// Moves shares to another registered account.
    #[payable]
    pub fn lp_transfer(&mut self, scenario_id: u64, receiver_id: AccountId, shares: U128) {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        if shares.0 == 0 {
            fail("ZeroAmount");
        }
        if !self.vaults.contains_key(&scenario_id) {
            fail!("NoDeposits({scenario_id})");
        }
        self.assert_registered(&receiver_id);
        self.burn_shares(&account, scenario_id, shares.0);
        let balance = add(self.shares_of(scenario_id, &receiver_id), shares.0);
        self.set_shares(scenario_id, &receiver_id, balance);
        LpTransferred {
            scenario_id,
            old_owner_id: &account,
            new_owner_id: &receiver_id,
            shares,
        }
        .emit();
        self.charge_storage(&account, before);
    }

    /// The vault per live world, ascending.
    pub fn root_lp_holdings(&self, scenario_id: u64) -> Vec<RootLpHolding> {
        self.live_worlds(scenario_id)
            .iter()
            .map(Self::holding)
            .collect()
    }

    /// What a deposit would mint and keep, exactly as `lp_deposit` would in
    /// the same state.
    pub fn preview_lp_deposit(
        &self,
        scenario_id: u64,
        weth_amount: U128,
        usdc_amount: U128,
    ) -> LpDepositPreview {
        if weth_amount.0 == 0 || usdc_amount.0 == 0 {
            fail("ZeroAmount");
        }
        let n = usize::from(self.scenario(scenario_id).world_count);
        let worlds = self.live_worlds(scenario_id);
        let plan = self.plan_deposit(scenario_id, &worlds, weth_amount.0, usdc_amount.0);
        let mut weth_kept = vec![U128(0); n];
        let mut usdc_kept = vec![U128(0); n];
        for (x, leg) in worlds.iter().zip(&plan.legs) {
            let w = usize::from(x.world);
            weth_kept[w] = U128(add(leg.weth_pool, leg.weth_idle));
            usdc_kept[w] = U128(add(leg.usdc_pool, leg.usdc_idle));
        }
        LpDepositPreview {
            shares: U128(plan.shares),
            weth_kept,
            usdc_kept,
        }
    }

    /// What `shares` would withdraw per world before merging, exactly as
    /// `lp_withdraw` computes it. No balance check.
    pub fn root_lp_preview_withdraw(&self, scenario_id: u64, shares: U128) -> WorldAmounts {
        let supply = self
            .vaults
            .get(&scenario_id)
            .map(|v| v.supply)
            .unwrap_or_else(|| fail!("NoDeposits({scenario_id})"));
        self.preview_withdraw(scenario_id, shares.0, supply)
    }

    pub fn root_lp_shares_of(&self, scenario_id: u64, account_id: AccountId) -> LpSharesView {
        LpSharesView {
            balance: U128(self.shares_of(scenario_id, &account_id)),
            supply: U128(self.vaults.get(&scenario_id).map_or(0, |v| v.supply)),
        }
    }
}

impl Contract {
    pub(crate) fn ft_lp_deposit(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        amount: u128,
        msg: LpDepositMsg,
    ) {
        if asset != Asset::Usdc {
            fail!("WrongAsset({asset})");
        }
        self.lp_deposit_for(
            sender,
            msg.scenario_id,
            msg.weth_amount.0,
            amount,
            msg.min_shares.0,
        );
    }

    /// The deposit, drawing both assets from `account`'s internal real
    /// balances. Real leftovers go back to those balances.
    pub(crate) fn lp_deposit_for(
        &mut self,
        account: &AccountId,
        scenario_id: u64,
        weth_amount: u128,
        usdc_amount: u128,
        min_shares: u128,
    ) -> u128 {
        if weth_amount == 0 || usdc_amount == 0 {
            fail("ZeroAmount");
        }
        let worlds = self.live_worlds(scenario_id);
        let plan = self.plan_deposit(scenario_id, &worlds, weth_amount, usdc_amount);
        if plan.shares < min_shares {
            fail!("TooFewShares({}, {min_shares})", plan.shares);
        }
        let s = self.scenario(scenario_id);
        let (root, world_count) = (s.root(), s.world_count);
        let mut vault = self
            .vaults
            .get(&scenario_id)
            .cloned()
            .unwrap_or_else(|| Vault::new(world_count));
        vault.supply = add(vault.supply, plan.shares);
        let balance = add(self.shares_of(scenario_id, account), plan.shares);
        self.set_shares(scenario_id, account, balance);

        // The depositor splits into every live world, then hands the vault
        // what each pool takes plus the idle buy-in; the rest is theirs.
        let singles: Vec<u8> = worlds.iter().map(LiveWorld::mask).collect();
        self.internal_split(
            account,
            scenario_id,
            Asset::Weth,
            root,
            &singles,
            weth_amount,
        );
        self.internal_split(
            account,
            scenario_id,
            Asset::Usdc,
            root,
            &singles,
            usdc_amount,
        );
        let mut kept = Vec::new();
        let mut back = Vec::new();
        for (x, leg) in worlds.iter().zip(&plan.legs) {
            let w = usize::from(x.world);
            let mut position = x.position.clone();
            let moved = if leg.liquidity == 0 && position.is_empty() {
                (0, 0)
            } else {
                let r = self.add_liquidity_held(x.pool_id, &mut position, leg.liquidity);
                self.book_fees(scenario_id, x.world, &mut vault, r.fees0.0, r.fees1.0);
                (r.amount0.0, r.amount1.0)
            };
            vault.positions[w] = position;
            vault.weth_idle[w] = add(vault.weth_idle[w], leg.weth_idle);
            vault.usdc_idle[w] = add(vault.usdc_idle[w], leg.usdc_idle);
            let weth_kept = add(moved.0, leg.weth_idle);
            let usdc_kept = add(moved.1, leg.usdc_idle);
            kept.push((VerseKey::new(scenario_id, Asset::Weth, x.mask()), weth_kept));
            kept.push((VerseKey::new(scenario_id, Asset::Usdc, x.mask()), usdc_kept));
            back.push((sub(weth_amount, weth_kept), sub(usdc_amount, usdc_kept)));
        }
        kept.retain(|(_, a)| *a > 0);
        if !kept.is_empty() {
            self.take_into_custody(account, &kept, None);
        }
        self.vaults.insert(scenario_id, vault);
        let (weth_refund, usdc_refund) = self.merge_common(account, scenario_id, &singles, &back);
        self.real_credit(account, Asset::Weth, weth_refund);
        self.real_credit(account, Asset::Usdc, usdc_refund);
        LpDeposited {
            scenario_id,
            account_id: account,
            weth_amount: U128(weth_amount),
            usdc_amount: U128(usdc_amount),
            shares: U128(plan.shares),
            weth_refund: U128(weth_refund),
            usdc_refund: U128(usdc_refund),
        }
        .emit();
        plan.shares
    }

    /// The withdrawal up to the payout: returns the real WETH and USDC the
    /// caller pays out; world tokens are already in `account`'s ledger.
    pub(crate) fn lp_withdraw_for(
        &mut self,
        account: &AccountId,
        scenario_id: u64,
        shares: u128,
        min_weth_out: &[U128],
        min_usdc_out: &[U128],
    ) -> (u128, u128) {
        if shares == 0 {
            fail("ZeroAmount");
        }
        let mut vault = self
            .vaults
            .get(&scenario_id)
            .cloned()
            .unwrap_or_else(|| fail!("NoDeposits({scenario_id})"));
        let n = usize::from(self.scenario(scenario_id).world_count);
        if min_weth_out.len() != n || min_usdc_out.len() != n {
            fail("LengthMismatch");
        }
        let worlds = self.live_worlds(scenario_id);
        // Priced on the supply before the burn.
        let supply = vault.supply;
        self.burn_shares(account, scenario_id, shares);
        vault.supply = sub(vault.supply, shares);

        let mut outs = Vec::new();
        for x in &worlds {
            let w = usize::from(x.world);
            let mut position = x.position.clone();
            let liquidity = mul_div(shares, position.liquidity(), supply, Rounding::Down);
            let (mut weth_held, mut usdc_held) = (vault.weth_idle[w], vault.usdc_idle[w]);
            let mut principal = (0, 0);
            if liquidity != 0 || !position.is_empty() {
                let r = self.remove_liquidity_held(x.pool_id, &mut position, liquidity);
                self.book_fees(scenario_id, x.world, &mut vault, r.fees0.0, r.fees1.0);
                weth_held = add(weth_held, r.fees0.0);
                usdc_held = add(usdc_held, r.fees1.0);
                principal = (r.amount0.0, r.amount1.0);
            }
            let weth_part = mul_div(shares, weth_held, supply, Rounding::Down);
            let usdc_part = mul_div(shares, usdc_held, supply, Rounding::Down);
            vault.positions[w] = position;
            vault.weth_idle[w] = weth_held - weth_part;
            vault.usdc_idle[w] = usdc_held - usdc_part;
            outs.push((add(principal.0, weth_part), add(principal.1, usdc_part)));
        }
        for (x, out) in worlds.iter().zip(&outs) {
            let w = usize::from(x.world);
            for (asset, amount, min) in [
                (Asset::Weth, out.0, min_weth_out[w].0),
                (Asset::Usdc, out.1, min_usdc_out[w].0),
            ] {
                if amount < min {
                    let token = VerseKey::new(scenario_id, asset, x.mask()).token_id();
                    fail!("InsufficientOutput({w}, {token}, {amount}, {min})");
                }
            }
        }
        self.vaults.insert(scenario_id, vault);

        let mut released = Vec::new();
        for (x, out) in worlds.iter().zip(&outs) {
            released.push((VerseKey::new(scenario_id, Asset::Weth, x.mask()), out.0));
            released.push((VerseKey::new(scenario_id, Asset::Usdc, x.mask()), out.1));
        }
        released.retain(|(_, a)| *a > 0);
        if !released.is_empty() {
            self.release_from_custody(account, &released, None);
        }
        let singles: Vec<u8> = worlds.iter().map(LiveWorld::mask).collect();
        let (weth_out, usdc_out) = self.merge_common(account, scenario_id, &singles, &outs);
        LpWithdrawn {
            scenario_id,
            account_id: account,
            shares: U128(shares),
            weth_out: U128(weth_out),
            usdc_out: U128(usdc_out),
        }
        .emit();
        (weth_out, usdc_out)
    }

    /// Must be true while `account_id` holds Root LP shares; it blocks
    /// `storage_unregister`.
    pub(crate) fn has_lp_shares(&self, account_id: &AccountId) -> bool {
        (1..=self.scenario_count).any(|sid| self.lp_shares.contains_key(&(sid, account_id.clone())))
    }

    /// The lend screen's Root LP part; None while the scenario is unknown or
    /// a live world has no pool to deposit into. `pub` until `lend_view`
    /// calls it.
    pub(crate) fn root_lp_view(
        &self,
        scenario_id: u64,
        account: Option<&AccountId>,
    ) -> Option<RootLpView> {
        let s = self.scenarios.get(&scenario_id)?;
        let pooled = (0..s.world_count)
            .filter(|w| masks::contains(s.possible, *w))
            .all(|w| {
                self.world_pool(scenario_id, w)
                    .and_then(|id| self.pools.get(&id))
                    .is_some_and(|p| !p.amm.is_empty())
            });
        if !pooled {
            return None;
        }
        let supply = self.vaults.get(&scenario_id).map_or(0, |v| v.supply);
        let yours = account.map_or(0, |a| self.shares_of(scenario_id, a));
        let preview_withdraw =
            (yours > 0).then(|| self.preview_withdraw(scenario_id, yours, supply));
        Some(RootLpView {
            share_supply: U128(supply),
            your_shares: U128(yours),
            share_decimals: SHARE_DECIMALS,
            preview_withdraw,
            holdings: self.root_lp_holdings(scenario_id),
        })
    }

    /// Verse tokens of `key` held by Root LP vaults outside the pools (idle),
    /// for the conservation check in the tests. Pool reserves and fees count
    /// as the pools' holdings.
    #[cfg(test)]
    pub(crate) fn vault_holdings(&self, key: &VerseKey) -> u128 {
        if !masks::is_single_world(key.mask) {
            return 0;
        }
        let w = usize::from(masks::lowest_world(key.mask));
        self.vaults
            .get(&key.scenario)
            .map_or(0, |v| match key.asset {
                Asset::Weth => v.weth_idle.get(w).copied().unwrap_or(0),
                Asset::Usdc => v.usdc_idle.get(w).copied().unwrap_or(0),
            })
    }

    pub(crate) fn shares_of(&self, scenario_id: u64, account: &AccountId) -> u128 {
        self.lp_shares
            .get(&(scenario_id, account.clone()))
            .copied()
            .unwrap_or(0)
    }

    fn set_shares(&mut self, scenario_id: u64, account: &AccountId, value: u128) {
        let key = (scenario_id, account.clone());
        if value == 0 {
            self.lp_shares.remove(&key);
        } else {
            self.lp_shares.insert(key, value);
        }
    }

    fn burn_shares(&mut self, account: &AccountId, scenario_id: u64, shares: u128) {
        let balance = self.shares_of(scenario_id, account);
        if balance < shares {
            fail!("ERC20InsufficientBalance({account}, {balance}, {shares})");
        }
        self.set_shares(scenario_id, account, balance - shares);
    }

    /// Every live world, ascending, with its pool and the vault's stake in it.
    fn live_worlds(&self, scenario_id: u64) -> Vec<LiveWorld> {
        let s = self.scenario(scenario_id);
        let vault = self.vaults.get(&scenario_id);
        (0..s.world_count)
            .filter(|w| masks::contains(s.possible, *w))
            .map(|world| {
                let pool_id = self
                    .world_pool(scenario_id, world)
                    .filter(|id| self.pools.get(id).is_some_and(|p| !p.amm.is_empty()))
                    .unwrap_or_else(|| fail!("PoolNotInitialized({world})"));
                let amm = self.pool(pool_id).amm.clone();
                let w = usize::from(world);
                let position = vault
                    .and_then(|v| v.positions.get(w).cloned())
                    .unwrap_or_default();
                let (weth_fees, usdc_fees) = position.pending_fees(&amm);
                LiveWorld {
                    world,
                    pool_id,
                    position,
                    weth_idle: vault.and_then(|v| v.weth_idle.get(w).copied()).unwrap_or(0),
                    usdc_idle: vault.and_then(|v| v.usdc_idle.get(w).copied()).unwrap_or(0),
                    weth_fees,
                    usdc_fees,
                    amm,
                }
            })
            .collect()
    }

    fn holding(x: &LiveWorld) -> RootLpHolding {
        let liquidity = x.position.liquidity();
        let (weth, usdc) = x.amounts(liquidity, Rounding::Down);
        RootLpHolding {
            world: x.world,
            liquidity: U128(liquidity),
            weth_in_pool: U128(weth),
            usdc_in_pool: U128(usdc),
            weth_idle: U128(x.weth_idle),
            usdc_idle: U128(x.usdc_idle),
            weth_fees: U128(x.weth_fees),
            usdc_fees: U128(x.usdc_fees),
        }
    }

    fn preview_withdraw(&self, scenario_id: u64, shares: u128, supply: u128) -> WorldAmounts {
        let n = usize::from(self.scenario(scenario_id).world_count);
        let mut out = WorldAmounts {
            weth: vec![U128(0); n],
            usdc: vec![U128(0); n],
        };
        if shares == 0 {
            return out;
        }
        for x in self.live_worlds(scenario_id) {
            let (weth, usdc) = x.withdrawal(shares, supply);
            out.weth[usize::from(x.world)] = U128(weth);
            out.usdc[usize::from(x.world)] = U128(usdc);
        }
        out
    }

    /// The first deposit gives every world its own maximum liquidity at its
    /// own price and mints the smallest of them, less the locked shares. A
    /// join mints what both amounts afford in every world and takes the
    /// matching slice of each position and of the idle tokens and fees.
    /// Shares round down, everything the vault takes rounds up.
    fn plan_deposit(&self, scenario_id: u64, worlds: &[LiveWorld], weth: u128, usdc: u128) -> Plan {
        let Some(vault) = self.vaults.get(&scenario_id) else {
            let liquidity: Vec<u128> = worlds
                .iter()
                .map(|x| x.amm.liquidity_for_amounts(weth, usdc))
                .collect();
            let total = liquidity.iter().copied().min().unwrap_or(0);
            if total <= MINIMUM_SHARES {
                fail("DepositTooSmall");
            }
            let legs = worlds
                .iter()
                .zip(liquidity)
                .map(|(x, l)| {
                    let (weth_pool, usdc_pool) = x.amounts(l, Rounding::Up);
                    Leg {
                        liquidity: l,
                        weth_pool,
                        usdc_pool,
                        ..Leg::default()
                    }
                })
                .collect();
            return Plan {
                shares: total - MINIMUM_SHARES,
                legs,
            };
        };
        let supply = vault.supply;
        let shares = worlds
            .iter()
            .map(|x| {
                let (weth_pos, usdc_pos) = x.amounts(x.position.liquidity(), Rounding::Up);
                let (weth_unit, usdc_unit) = x.amounts(1, Rounding::Up);
                let (weth_held, usdc_held) = x.held();
                affordable(weth, weth_unit, add(weth_pos, weth_held), supply).min(affordable(
                    usdc,
                    usdc_unit,
                    add(usdc_pos, usdc_held),
                    supply,
                ))
            })
            .min()
            .unwrap_or(0);
        if shares == 0 {
            fail("DepositTooSmall");
        }
        let up = |amount: u128| mul_div(shares, amount, supply, Rounding::Up);
        let legs = worlds
            .iter()
            .map(|x| {
                let liquidity = up(x.position.liquidity());
                let (weth_pool, usdc_pool) = x.amounts(liquidity, Rounding::Up);
                let (weth_held, usdc_held) = x.held();
                Leg {
                    liquidity,
                    weth_pool,
                    usdc_pool,
                    weth_idle: up(weth_held),
                    usdc_idle: up(usdc_held),
                }
            })
            .collect();
        Plan { shares, legs }
    }

    /// Fees a vault position just collected go to idle.
    fn book_fees(
        &mut self,
        scenario_id: u64,
        world: u8,
        vault: &mut Vault,
        weth: u128,
        usdc: u128,
    ) {
        if weth == 0 && usdc == 0 {
            return;
        }
        let w = usize::from(world);
        vault.weth_idle[w] = add(vault.weth_idle[w], weth);
        vault.usdc_idle[w] = add(vault.usdc_idle[w], usdc);
        LpFeesCollected {
            scenario_id,
            world,
            weth_fees: U128(weth),
            usdc_fees: U128(usdc),
        }
        .emit();
    }

    /// Merges what every live world holds in common (`amounts` per world,
    /// already in `account`'s ledger) back into real assets, which leave the
    /// reserves; returns them for the caller to credit or pay out.
    fn merge_common(
        &mut self,
        account: &AccountId,
        scenario_id: u64,
        singles: &[u8],
        amounts: &[(u128, u128)],
    ) -> (u128, u128) {
        let root = self.scenario(scenario_id).root();
        let weth = amounts.iter().map(|a| a.0).min().unwrap_or(0);
        let usdc = amounts.iter().map(|a| a.1).min().unwrap_or(0);
        for (asset, amount) in [(Asset::Weth, weth), (Asset::Usdc, usdc)] {
            if amount > 0 {
                self.internal_merge(account, scenario_id, asset, singles, root, amount);
            }
        }
        (weth, usdc)
    }
}
