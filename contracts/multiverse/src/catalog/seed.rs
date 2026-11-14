//! After an opening: each pledger's unused part comes back (`claim_unused`)
//! and their share of the seed vault can be withdrawn once the lock ends
//! (`seed_withdraw`): a slice of every live position, idle token and fee,
//! paid as real assets where every live world agrees and as world tokens for
//! the rest.

use multiverse_math::fixed::{mul_div_u256, Q96};
use multiverse_math::seed::OpenTotals;
use multiverse_math::{checked_mul_div, Rounding, U256};
use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, AccountId};

use super::events::{PledgeReturned, SeedWithdrawn};
use super::{
    Check, IdleToken, Pledge, PledgeReturn, Proposal, ProposalStatus, SeedVault, VSeedVault,
};
use crate::amm::{Pool, PoolKind};
use crate::errors::fail;
use crate::events::{DustSwept, MultiverseEvent};
use crate::masks;
use crate::ops::PauseFlag;
use crate::types::{Asset, VerseKey};
use crate::{now_sec, Contract, ContractExt};

/// What one seed withdrawal comes to: per world, what the account would hold
/// there before the merge (dead worlds 0), the merged real amounts and the
/// world tokens left after the merge. Index 0 is wNEAR, 1 USDC.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SeedExit {
    pub per_world: [Vec<u128>; 2],
    pub merged: [u128; 2],
    pub tokens: Vec<(VerseKey, u128)>,
}

const ASSETS: [Asset; 2] = [Asset::Wnear, Asset::Usdc];

fn floor_share(shares: u128, amount: u128, supply: u128) -> u128 {
    checked_mul_div(shares, amount, supply, Rounding::Down).unwrap_or(0)
}

/// The tokens of a pool: (asset, mask) of token0 and token1.
fn pool_tokens(pool: &Pool) -> [(Asset, u8); 2] {
    match pool.kind {
        PoolKind::Within { world } => [(Asset::Wnear, 1 << world), (Asset::Usdc, 1 << world)],
        PoolKind::Between { mask0, mask1 } => [(Asset::Usdc, mask0), (Asset::Usdc, mask1)],
        PoolKind::Spot => [(Asset::Wnear, 0), (Asset::Usdc, 0)],
    }
}

fn add_to(list: &mut Vec<(Asset, u8, u128)>, asset: Asset, mask: u8, amount: u128) {
    if amount == 0 {
        return;
    }
    match list.iter_mut().find(|(a, m, _)| *a == asset && *m == mask) {
        Some((_, _, total)) => *total = total.saturating_add(amount),
        None => list.push((asset, mask, amount)),
    }
}

fn add_idle(idle: &mut Vec<IdleToken>, asset: Asset, mask: u8, amount: u128) {
    if amount == 0 {
        return;
    }
    match idle.iter_mut().find(|t| t.asset == asset && t.mask == mask) {
        Some(t) => t.amount = t.amount.saturating_add(amount),
        None => idle.push(IdleToken {
            asset,
            mask,
            amount,
        }),
    }
}

/// Holdings per world (before the merge) and what the merge and the tokens
/// come to, for live worlds of `world_count` given `possible`.
fn settle_holdings(
    sid: u64,
    world_count: u8,
    possible: u8,
    holdings: &[(Asset, u8, u128)],
) -> SeedExit {
    let n = usize::from(world_count);
    let mut exit = SeedExit {
        per_world: [vec![0; n], vec![0; n]],
        ..SeedExit::default()
    };
    for &(asset, mask, amount) in holdings {
        let i = crate::books::asset_index(asset);
        for w in 0..world_count {
            if masks::contains(mask, w) && masks::contains(possible, w) {
                exit.per_world[i][usize::from(w)] =
                    exit.per_world[i][usize::from(w)].saturating_add(amount);
            }
        }
    }
    for (i, asset) in ASSETS.into_iter().enumerate() {
        let merged = (0..world_count)
            .filter(|w| masks::contains(possible, *w))
            .map(|w| exit.per_world[i][usize::from(w)])
            .min()
            .unwrap_or(0);
        exit.merged[i] = merged;
        for w in 0..world_count {
            let left = exit.per_world[i][usize::from(w)].saturating_sub(merged);
            if masks::contains(possible, w) && left > 0 {
                exit.tokens.push((VerseKey::new(sid, asset, 1 << w), left));
            }
        }
    }
    exit
}

/// Smallest liquidity whose depth at `tick` reaches `min_depth`.
fn min_liquidity(min_depth: u128, tick: i32) -> u128 {
    let sqrt = multiverse_math::tick::get_sqrt_ratio_at_tick(tick);
    let l = mul_div_u256(U256::from(min_depth), Q96, sqrt, Rounding::Up);
    if l > U256::from(u128::MAX) {
        u128::MAX
    } else {
        l.low_u128()
    }
}

#[near]
impl Contract {
    /// Pays the caller's unused pledge back (what the opening did not use);
    /// zeros once paid.
    #[payable]
    pub fn claim_unused(&mut self, proposal_id: u64) -> PledgeReturn {
        assert_one_yocto();
        self.assert_live(PauseFlag::Exit);
        let account = env::predecessor_account_id();
        let (mut p, mut pledge) = self
            .opened_pledge(proposal_id, &account)
            .unwrap_or_else(|e| fail(&e));
        let before = env::storage_usage();
        let (wnear, usdc) = self.claim_unused_for(proposal_id, &mut p, &account, &mut pledge);
        self.store_pledge(proposal_id, &mut p, &account, pledge);
        self.save_proposal(proposal_id, p);
        self.payout(&account, Asset::Wnear, wnear);
        self.payout(&account, Asset::Usdc, usdc);
        self.charge_storage(&account, before);
        PledgeReturn {
            wnear: U128(wnear),
            usdc: U128(usdc),
        }
    }

    /// Withdraws `shares` (default: all) of the caller's seed claim: per
    /// world minimums (`world_count` long, dead worlds ignored) apply before
    /// the merge. Locked until `unlock_at_sec` unless one world is left; with
    /// debt in the market no live world pool may fall below its lending
    /// depth. A unused part still due is paid with it. Returns the real
    /// (wNEAR, USDC) the shares paid out.
    #[payable]
    pub fn seed_withdraw(
        &mut self,
        proposal_id: u64,
        shares: Option<U128>,
        min_wnear_out: Vec<U128>,
        min_usdc_out: Vec<U128>,
    ) -> (U128, U128) {
        assert_one_yocto();
        self.assert_live(PauseFlag::Exit);
        let account = env::predecessor_account_id();
        let (mut p, mut pledge) = self
            .opened_pledge(proposal_id, &account)
            .unwrap_or_else(|e| fail(&e));
        let sid = p.open.scenario_id;
        let mut vault = self
            .seed_vault_record(sid)
            .unwrap_or_else(|| fail!("NotOpen({proposal_id})"));
        let s = self.scenario(sid);
        let (world_count, possible) = (s.world_count, s.possible);
        if now_sec() < vault.unlock_at_sec && !masks::is_single_world(possible) {
            fail!("SeedLocked({proposal_id}, {})", vault.unlock_at_sec);
        }
        let n = usize::from(world_count);
        if min_wnear_out.len() != n || min_usdc_out.len() != n {
            fail("LengthMismatch");
        }
        let have = totals_of(&p)
            .shares(pledge.wnear, pledge.usdc)
            .saturating_sub(pledge.withdrawn_shares);
        let shares = shares.map_or(have, |s| s.0);
        if shares == 0 {
            fail("ZeroAmount");
        }
        if shares > have {
            fail!("InsufficientBalance({account}, {have}, {shares})");
        }
        if let Some((w, max)) = self.depth_floor(sid, &vault, have) {
            if shares > max {
                fail!("SeedDepthFloor({w}, {max})");
            }
        }
        let before = env::storage_usage();
        // The unused part, when still due, is paid with the withdrawal.
        let unused = self.claim_unused_for(proposal_id, &mut p, &account, &mut pledge);

        // 1-2: a slice of every live position (fees booked into idle first),
        // then of every live idle token.
        let supply = vault.supply;
        let mut holdings: Vec<(Asset, u8, u128)> = Vec::new();
        let mut parked: Vec<(Asset, u8, u128)> = Vec::new();
        for slot in vault.positions.iter_mut() {
            let pool = self.pool(slot.pool_id).clone();
            let tokens = pool_tokens(&pool);
            if tokens.iter().all(|(_, m)| m & possible == 0) {
                continue;
            }
            let liquidity = floor_share(shares, slot.position.liquidity(), supply);
            if liquidity == 0 && slot.position.is_empty() {
                continue;
            }
            let r = self.remove_liquidity_held(slot.pool_id, &mut slot.position, liquidity);
            for ((asset, mask), (principal, fee)) in tokens
                .into_iter()
                .zip([(r.amount0.0, r.fees0.0), (r.amount1.0, r.fees1.0)])
            {
                add_idle(&mut vault.idle, asset, mask, fee);
                if mask & possible == 0 {
                    add_to(&mut parked, asset, mask, principal);
                } else {
                    add_to(&mut holdings, asset, mask, principal);
                }
            }
        }
        for token in vault.idle.iter_mut() {
            if token.mask & possible == 0 {
                continue;
            }
            let take = floor_share(shares, token.amount, supply);
            token.amount -= take;
            add_to(&mut holdings, token.asset, token.mask, take);
        }
        for (asset, mask, amount) in parked {
            add_idle(&mut vault.idle, asset, mask, amount);
        }
        vault.idle.retain(|t| t.amount > 0);

        // Per-world minimums, before anything is merged.
        let exit = settle_holdings(sid, world_count, possible, &holdings);
        for w in 0..world_count {
            if !masks::contains(possible, w) {
                continue;
            }
            for (i, (asset, mins)) in [(Asset::Wnear, &min_wnear_out), (Asset::Usdc, &min_usdc_out)]
                .into_iter()
                .enumerate()
            {
                let amount = exit.per_world[i][usize::from(w)];
                let min = mins[usize::from(w)].0;
                if amount < min {
                    let token = VerseKey::new(sid, asset, 1 << w).token_id();
                    fail!("InsufficientOutput({w}, {token}, {amount}, {min})");
                }
            }
        }

        // 3: flatten live multi-world tokens into their live singles.
        let mut burn = Vec::new();
        let mut mint: Vec<(VerseKey, u128)> = Vec::new();
        for &(asset, mask, amount) in &holdings {
            if masks::is_single_world(mask) {
                continue;
            }
            burn.push((VerseKey::new(sid, asset, mask), amount));
            for w in 0..world_count {
                if masks::contains(mask, w) && masks::contains(possible, w) {
                    let key = VerseKey::new(sid, asset, 1 << w);
                    match mint.iter_mut().find(|(k, _)| *k == key) {
                        Some((_, total)) => *total += amount,
                        None => mint.push((key, amount)),
                    }
                }
            }
        }
        if !burn.is_empty() {
            self.burn_from_custody(&burn, None);
            self.mint_into_custody(&mint, None);
        }
        // 4: merge what every live world has in common; 5: release the rest.
        let singles: Vec<u8> = (0..world_count)
            .filter(|w| masks::contains(possible, *w))
            .map(|w| 1u8 << w)
            .collect();
        for (i, asset) in ASSETS.into_iter().enumerate() {
            self.custody_merge_to_root(sid, asset, &singles, exit.merged[i]);
        }
        if !exit.tokens.is_empty() {
            self.release_from_custody(&account, &exit.tokens, None);
        }

        // 6-7: the claim goes down; the pledge ends once nothing is left.
        pledge.withdrawn_shares = pledge.withdrawn_shares.saturating_add(shares);
        vault.supply = vault.supply.saturating_sub(shares);
        self.catalog.seed_vaults.insert(sid, VSeedVault::V1(vault));
        self.store_pledge(proposal_id, &mut p, &account, pledge);
        self.save_proposal(proposal_id, p);
        let [wnear_out, usdc_out] = exit.merged;
        SeedWithdrawn {
            proposal_id,
            scenario_id: sid,
            account_id: &account,
            shares: U128(shares),
            wnear_out: U128(wnear_out),
            usdc_out: U128(usdc_out),
        }
        .emit();
        self.payout(&account, Asset::Wnear, wnear_out + unused.0);
        self.payout(&account, Asset::Usdc, usdc_out + unused.1);
        self.charge_storage(&account, before);
        (U128(wnear_out), U128(usdc_out))
    }
}

/// The amounts frozen at the opening.
pub(crate) fn totals_of(p: &Proposal) -> OpenTotals {
    OpenTotals {
        pledged_wnear: p.open.pledged_wnear,
        pledged_usdc: p.open.pledged_usdc,
        used_wnear: p.open.used_wnear,
        used_usdc: p.open.used_usdc,
        s: p.open.s_ref,
    }
}

impl Contract {
    /// `UnknownProposal`, `NotOpen(pid)`, `NoPledge(pid, account)`.
    pub(crate) fn opened_pledge(&self, pid: u64, account: &AccountId) -> Check<(Proposal, Pledge)> {
        let p = self.proposal_or(pid)?;
        if p.status != ProposalStatus::Opened {
            return Err(format!("NotOpen({pid})"));
        }
        let pledge = self
            .catalog
            .pledges
            .get(&(pid, account.clone()))
            .cloned()
            .ok_or_else(|| format!("NoPledge({pid}, {account})"))?;
        Ok((p, pledge))
    }

    /// Settles `account`'s unused part once (the caller pays it out); the
    /// last claim sweeps the escrow's rounding dust to the contract's own
    /// balance.
    fn claim_unused_for(
        &mut self,
        pid: u64,
        p: &mut Proposal,
        account: &AccountId,
        pledge: &mut Pledge,
    ) -> (u128, u128) {
        if pledge.unused_paid {
            return (0, 0);
        }
        let (wnear, usdc) = totals_of(p).unused(pledge.wnear, pledge.usdc);
        let wnear = wnear.min(p.escrow_wnear);
        let usdc = usdc.min(p.escrow_usdc);
        pledge.unused_paid = true;
        p.escrow_wnear -= wnear;
        p.escrow_usdc -= usdc;
        self.escrow_books(Asset::Wnear, wnear, false);
        self.escrow_books(Asset::Usdc, usdc, false);
        p.unused_open = p.unused_open.saturating_sub(1);
        if p.unused_open == 0 {
            let contract = env::current_account_id();
            for (asset, dust) in [(Asset::Wnear, p.escrow_wnear), (Asset::Usdc, p.escrow_usdc)] {
                if dust == 0 {
                    continue;
                }
                self.escrow_books(asset, dust, false);
                self.real_credit(&contract, asset, dust);
                DustSwept {
                    account_id: &contract,
                    asset,
                    amount: U128(dust),
                }
                .emit();
            }
            p.escrow_wnear = 0;
            p.escrow_usdc = 0;
        }
        PledgeReturned {
            proposal_id: pid,
            account_id: account,
            wnear: U128(wnear),
            usdc: U128(usdc),
            reason: "unused",
        }
        .emit();
        (wnear, usdc)
    }

    /// Stores the pledge, or deletes it once its unused part is paid and
    /// every share is withdrawn.
    fn store_pledge(&mut self, pid: u64, p: &mut Proposal, account: &AccountId, pledge: Pledge) {
        let shares = totals_of(p).shares(pledge.wnear, pledge.usdc);
        if pledge.unused_paid && pledge.withdrawn_shares >= shares {
            self.drop_pledge(pid, p, account);
        } else {
            self.catalog.pledges.insert((pid, account.clone()), pledge);
        }
    }

    /// With `seed_depth_floor` and debt in the market: the most shares (up
    /// to `have`) a withdrawal may take without any live world pool falling
    /// below the market's lending depth, and the world that binds. None when
    /// the floor does not apply.
    pub(crate) fn depth_floor(
        &self,
        sid: u64,
        vault: &SeedVault,
        have: u128,
    ) -> Option<(u8, u128)> {
        if !self.market_params_stored().seed_depth_floor || !self.has_debt(sid) {
            return None;
        }
        let min_depth = self.price_cfg(sid).min_depth.0;
        let possible = self.scenario(sid).possible;
        let mut bound: Option<(u8, u128)> = None;
        for slot in &vault.positions {
            let pool = self.pool(slot.pool_id);
            let PoolKind::Within { world } = pool.kind else {
                continue;
            };
            if !masks::contains(possible, world) || slot.position.liquidity() == 0 {
                continue;
            }
            let tick = self
                .pool_mean_tick(pool)
                .or_else(|| pool.amm.tick())
                .unwrap_or(0);
            let removable = pool
                .amm
                .liquidity()
                .saturating_sub(min_liquidity(min_depth, tick));
            let max = checked_mul_div(
                removable,
                vault.supply,
                slot.position.liquidity(),
                Rounding::Down,
            )
            .unwrap_or(u128::MAX)
            .min(have);
            if bound.is_none_or(|(_, b)| max < b) {
                bound = Some((world, max));
            }
        }
        bound
    }

    /// What `shares` of the vault would withdraw now, exactly as
    /// `seed_withdraw` computes it.
    pub(crate) fn seed_exit_preview(&self, sid: u64, vault: &SeedVault, shares: u128) -> SeedExit {
        let s = self.scenario(sid);
        let (world_count, possible) = (s.world_count, s.possible);
        let supply = vault.supply.max(1);
        let mut holdings: Vec<(Asset, u8, u128)> = Vec::new();
        let mut idle: Vec<(Asset, u8, u128)> = vault
            .idle
            .iter()
            .map(|t| (t.asset, t.mask, t.amount))
            .collect();
        for slot in &vault.positions {
            let Some(pool) = self.pools.get(&slot.pool_id) else {
                continue;
            };
            let tokens = pool_tokens(pool);
            if tokens.iter().all(|(_, m)| m & possible == 0) {
                continue;
            }
            let liquidity = floor_share(shares, slot.position.liquidity(), supply);
            let principal = if liquidity == 0 {
                (0, 0)
            } else {
                pool.amm
                    .amounts_for_liquidity(liquidity, Rounding::Down)
                    .unwrap_or((0, 0))
            };
            let fees = slot.position.pending_fees(&pool.amm);
            for ((asset, mask), (amount, fee)) in tokens
                .into_iter()
                .zip([(principal.0, fees.0), (principal.1, fees.1)])
            {
                add_to(&mut idle, asset, mask, fee);
                if mask & possible != 0 {
                    add_to(&mut holdings, asset, mask, amount);
                }
            }
        }
        for (asset, mask, amount) in idle {
            if mask & possible != 0 {
                add_to(
                    &mut holdings,
                    asset,
                    mask,
                    floor_share(shares, amount, supply),
                );
            }
        }
        settle_holdings(sid, world_count, possible, &holdings)
    }
}
