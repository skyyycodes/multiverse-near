//! Liquidate and cash out (F3): with `receive: "cash"` the pieces a
//! liquidation seized are turned into real USDC in the same receipt and paid
//! out, so a liquidator needs no market knowledge and keeps no tokens it
//! cannot use.
//!
//! The seized pieces become single-world tokens (real wNEAR is root-split,
//! multi-world tokens are split, collapsed USDC is redeemed), every possible
//! world's wNEAR is sold in its world pool, and the USDC-if-w the liquidator
//! now holds in every possible world merges back to root up to the smallest
//! of them. What is left (`left_usdc`, dead pieces) stays with the
//! liquidator as tokens. A sale may not leave a world it sold into without a
//! liquidation price (every other borrower's liquidations would pause), and
//! the cash must reach the liquidator's `min_out`, or the whole receipt
//! fails and the token refunds the transfer.
//!
//! `liquidation_quote` runs the same plan on the projected market and the
//! same sales on cloned pools, so it equals execution at the same block.

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{near, AccountId};

use super::tiers::{MarketId, Tier};
use super::{CollateralKey, LiquidationState, RepayAmount};
use crate::amm::Pool;
use crate::errors::{add, sub};
use crate::events::MultiverseEvent;
use crate::ops::PauseFlag;
use crate::receiver::Receive;
use crate::types::{Asset, Scenario, VerseKey};
use crate::{masks, now_sec, Contract, ContractExt};

/// What a cash-out did, or would do. Per-world vectors have one entry per
/// world (0 for worlds that can no longer happen).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct CashOut {
    /// wNEAR-if-w sold in each world pool.
    pub sold: Vec<u128>,
    /// USDC-if-w each sale paid.
    pub received: Vec<u128>,
    /// USDC-if-w of every possible world merged back to real USDC.
    pub merged: u128,
    pub real_usdc: u128,
    pub redeemed: u128,
    pub cash: u128,
    /// USDC-if-w left with the liquidator per world.
    pub left_usdc: Vec<u128>,
    /// Dead pieces left with the liquidator, as token ids.
    pub dead: Vec<String>,
    /// Every world sold into is still liquidation-priced.
    pub guard_ok: bool,
}

/// The seized pieces sorted into what the cash-out does with them.
struct Conversion {
    real_usdc: u128,
    real_wnear: u128,
    redeemed: u128,
    /// Single-world amounts the liquidator holds after the conversion, per
    /// asset index and world.
    singles: [Vec<u128>; 2],
    burns: Vec<(VerseKey, u128)>,
    /// Summed per key.
    mints: Vec<(VerseKey, u128)>,
    dead: Vec<String>,
}

fn asset_ix(asset: Asset) -> usize {
    crate::books::asset_index(asset)
}

fn push_summed(items: &mut Vec<(VerseKey, u128)>, key: VerseKey, amount: u128) {
    match items.iter_mut().find(|(k, _)| *k == key) {
        Some((_, total)) => *total = add(*total, amount),
        None => items.push((key, amount)),
    }
}

/// Step 1: every seized piece with a positive amount, in list order.
fn convert(sid: u64, s: &Scenario, pieces: &[CollateralKey], seized: &[u128]) -> Conversion {
    let (worlds, p) = (s.world_count, s.possible);
    let n = usize::from(worlds);
    let mut c = Conversion {
        real_usdc: 0,
        real_wnear: 0,
        redeemed: 0,
        singles: [vec![0; n], vec![0; n]],
        burns: Vec::new(),
        mints: Vec::new(),
        dead: Vec::new(),
    };
    for (piece, &a) in pieces.iter().zip(seized) {
        if a == 0 {
            continue;
        }
        match *piece {
            CollateralKey::Real(Asset::Usdc) => c.real_usdc = add(c.real_usdc, a),
            CollateralKey::Real(Asset::Wnear) => {
                // a root split into every possible world
                c.real_wnear = add(c.real_wnear, a);
                for w in (0..worlds).filter(|w| masks::contains(p, *w)) {
                    let i = usize::from(w);
                    c.singles[0][i] = add(c.singles[0][i], a);
                    push_summed(&mut c.mints, VerseKey::new(sid, Asset::Wnear, 1 << w), a);
                }
            }
            CollateralKey::Verse { asset, mask } => {
                let key = VerseKey::new(sid, asset, mask);
                if mask & p == 0 {
                    c.dead.push(key.token_id());
                } else if asset == Asset::Usdc && mask & p == p {
                    // collapsed USDC: a redeem
                    c.burns.push((key, a));
                    c.redeemed = add(c.redeemed, a);
                } else if masks::is_single_world(mask) {
                    let i = usize::from(masks::lowest_world(mask));
                    c.singles[asset_ix(asset)][i] = add(c.singles[asset_ix(asset)][i], a);
                } else {
                    // a split into its live single worlds
                    c.burns.push((key, a));
                    for w in (0..worlds).filter(|w| masks::contains(mask & p, *w)) {
                        let i = usize::from(w);
                        c.singles[asset_ix(asset)][i] = add(c.singles[asset_ix(asset)][i], a);
                        push_summed(&mut c.mints, VerseKey::new(sid, asset, 1 << w), a);
                    }
                }
            }
        }
    }
    c
}

/// The smallest USDC-if-w over the possible worlds, and what is left per world after merging it.
fn merge_plan(usdc: &[u128], possible: u8) -> (u128, Vec<u128>) {
    let m = (0..usdc.len())
        .filter(|w| masks::contains(possible, *w as u8))
        .map(|w| usdc[w])
        .min()
        .unwrap_or(0);
    let left = (0..usdc.len())
        .map(|w| {
            if masks::contains(possible, w as u8) {
                usdc[w] - m
            } else {
                0
            }
        })
        .collect();
    (m, left)
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct CashOutLog<'a> {
    scenario_id: u64,
    tier: Tier,
    liquidator_id: &'a AccountId,
    account_id: &'a AccountId,
    sold: Vec<U128>,
    received: Vec<U128>,
    merged: U128,
    real_usdc: U128,
    redeemed: U128,
    cash: U128,
    min_out: U128,
    left_usdc: Vec<U128>,
    dead: &'a [String],
}

impl MultiverseEvent for CashOutLog<'_> {
    const NAME: &'static str = "cash_out";
}

fn u128s(v: &[u128]) -> Vec<U128> {
    v.iter().map(|a| U128(*a)).collect()
}

/// One seized piece in a quote.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuotePiece {
    pub piece: String,
    pub held: U128,
    pub seized: U128,
}

/// The cash-out part of a quote.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CashQuote {
    pub sold: Vec<U128>,
    pub received: Vec<U128>,
    pub merged: U128,
    pub real_usdc: U128,
    pub redeemed: U128,
    pub cash: U128,
    pub left_usdc: Vec<U128>,
    pub dead: Vec<String>,
    pub guard_ok: bool,
}

impl From<&CashOut> for CashQuote {
    fn from(c: &CashOut) -> Self {
        Self {
            sold: u128s(&c.sold),
            received: u128s(&c.received),
            merged: U128(c.merged),
            real_usdc: U128(c.real_usdc),
            redeemed: U128(c.redeemed),
            cash: U128(c.cash),
            left_usdc: u128s(&c.left_usdc),
            dead: c.dead.clone(),
            guard_ok: c.guard_ok,
        }
    }
}

/// What a liquidation would do now. `error` is the first check it would
/// fail (null when it would go through); the numbers are filled as far as
/// they can be.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiquidationQuote {
    pub error: Option<String>,
    pub liquidation: LiquidationState,
    pub debt: U128,
    pub health_factor: Option<U128>,
    pub cap: U128,
    pub full_seize_repay: U128,
    pub repay: U128,
    pub target: U128,
    pub seize_all: bool,
    pub written_off: U128,
    pub price_factor: U128,
    pub pieces: Vec<QuotePiece>,
    pub cash: Option<CashQuote>,
}

#[near]
impl Contract {
    /// What `liquidate` would do now with `repay_amount` (default `"max"`)
    /// and `receive` (default tokens), without the attached budget: the
    /// repayment, the pieces it seizes, any write-off and, in cash mode, the
    /// sales, the merge and the cash. A bot attaches `repay` plus a margin
    /// and sets `min_out` a little below `cash`.
    #[deny_unknown_arguments]
    pub fn liquidation_quote(
        &self,
        scenario_id: u64,
        account_id: AccountId,
        tier: Option<Tier>,
        repay_amount: Option<RepayAmount>,
        receive: Option<Receive>,
    ) -> LiquidationQuote {
        let id = MarketId::new(scenario_id, tier);
        let receive = receive.unwrap_or_default();
        let repay = repay_amount.and_then(RepayAmount::amount);
        let mut q = LiquidationQuote {
            error: None,
            liquidation: LiquidationState::None,
            debt: U128(0),
            health_factor: None,
            cap: U128(0),
            full_seize_repay: U128(0),
            repay: U128(0),
            target: U128(0),
            seize_all: false,
            written_off: U128(0),
            price_factor: U128(crate::types::WAD),
            pieces: Vec::new(),
            cash: None,
        };
        if repay == Some(0) {
            q.error = Some("ZeroAmount".to_string());
            return q;
        }
        let Some(s) = self.scenarios.get(&scenario_id).cloned() else {
            q.error = Some(format!("UnknownScenario({scenario_id})"));
            return q;
        };
        let ctx = self.market_ctx_view(id);
        let a = self.assess(&ctx, &account_id);
        q.liquidation = a.status;
        q.debt = U128(a.debt);
        q.health_factor = a.liq_health.hf.map(U128);
        q.cap = U128(a.cap);
        q.full_seize_repay = U128(a.fsr);
        q.price_factor = U128(ctx.liq.factor);
        q.pieces = a
            .pieces
            .iter()
            .map(|(k, held)| QuotePiece {
                piece: k.piece_id(scenario_id),
                held: U128(*held),
                seized: U128(0),
            })
            .collect();
        if let Some(e) = self.liquidation_gate_error(receive) {
            q.error = Some(e);
            return q;
        }
        if ctx.halted {
            q.error = Some(format!("ScenarioHalted({scenario_id})"));
            return q;
        }
        let plan = match self.plan_liquidation(
            id,
            &s,
            &account_id,
            repay,
            u128::MAX,
            &ctx.market,
            &ctx.state,
            &ctx.snap,
        ) {
            Ok(plan) => plan,
            Err(e) => {
                q.error = Some(e);
                return q;
            }
        };
        q.repay = U128(plan.repay);
        q.target = U128(plan.target);
        q.seize_all = plan.seize_all;
        q.written_off = U128(plan.written_off);
        for (piece, seized) in q.pieces.iter_mut().zip(&plan.seized) {
            piece.seized = U128(*seized);
        }
        if receive == Receive::Cash {
            let keys: Vec<CollateralKey> = plan.pieces.iter().map(|(k, _)| *k).collect();
            match self.quote_cash_out(scenario_id, &s, &keys, &plan.seized) {
                Ok((out, unpriced)) => {
                    if let Some(w) = unpriced {
                        q.error = Some(format!("CashOutUnpricesWorld({w})"));
                    }
                    q.cash = Some(CashQuote::from(&out));
                }
                Err(e) => q.error = Some(e),
            }
        }
        q
    }
}

impl Contract {
    /// The pause part of a liquidation as an error, for the quote.
    fn liquidation_gate_error(&self, receive: Receive) -> Option<String> {
        if self.pause.is_paused(PauseFlag::Liquidate) {
            return Some("Paused(liquidate)".to_string());
        }
        let resume_at = self.pause.liquidations_resume_at_sec;
        if now_sec() < resume_at {
            return Some(format!("LiquidationGrace({resume_at})"));
        }
        if receive == Receive::Cash && self.pause.is_paused(PauseFlag::Trade) {
            return Some("Paused(trade)".to_string());
        }
        None
    }

    /// Steps 1 to 6 of the cash-out for `liquidator`, who holds the seized
    /// pieces (verse in its ledger, real in its internal balance). Fails
    /// `PoolNotInitialized(w)`, `CashOutUnpricesWorld(w)` or
    /// `CashOutBelowMin(cash, min_out)`.
    pub(crate) fn cash_out(
        &mut self,
        liquidator: &AccountId,
        id: MarketId,
        s: &Scenario,
        pieces: &[CollateralKey],
        seized: &[u128],
        min_out: u128,
    ) -> CashOut {
        let sid = id.scenario_id;
        let (worlds, p) = (s.world_count, s.possible);
        let c = convert(sid, s, pieces, seized);
        if c.real_usdc > 0 {
            self.real_debit(liquidator, Asset::Usdc, c.real_usdc);
        }
        if c.real_wnear > 0 {
            self.real_debit(liquidator, Asset::Wnear, c.real_wnear);
            let reserve = add(self.reserve(sid, Asset::Wnear), c.real_wnear);
            self.set_reserve(sid, Asset::Wnear, reserve);
        }
        if c.redeemed > 0 {
            let reserve = sub(self.reserve(sid, Asset::Usdc), c.redeemed);
            self.set_reserve(sid, Asset::Usdc, reserve);
        }
        self.burn(liquidator, &c.burns, None);
        self.mint(liquidator, &c.mints, None);

        let n = usize::from(worlds);
        let mut usdc = c.singles[1].clone();
        let (mut sold, mut received) = (vec![0u128; n], vec![0u128; n]);
        let mut sold_pools = Vec::new();
        for w in (0..worlds).filter(|w| masks::contains(p, *w)) {
            let i = usize::from(w);
            let amount = c.singles[0][i];
            if amount == 0 {
                continue;
            }
            let pool_id = self
                .world_pool(sid, w)
                .unwrap_or_else(|| fail!("PoolNotInitialized({w})"));
            // wNEAR-if-w is token0
            let got = self.swap_exact_in_for(liquidator, pool_id, true, amount, 0);
            sold[i] = amount;
            received[i] = got;
            usdc[i] = add(usdc[i], got);
            sold_pools.push((w, pool_id));
        }
        let cfg = self.price_cfg(sid);
        for (w, pool_id) in sold_pools {
            if !self.world_liq_priced_with(sid, self.pool(pool_id), &cfg) {
                fail!("CashOutUnpricesWorld({w})");
            }
        }

        let (merged, left_usdc) = merge_plan(&usdc, p);
        if merged > 0 {
            let items: Vec<(VerseKey, u128)> = (0..worlds)
                .filter(|w| masks::contains(p, *w))
                .map(|w| (VerseKey::new(sid, Asset::Usdc, 1 << w), merged))
                .collect();
            self.burn(liquidator, &items, None);
            let reserve = sub(self.reserve(sid, Asset::Usdc), merged);
            self.set_reserve(sid, Asset::Usdc, reserve);
        }
        let cash = add(add(c.real_usdc, c.redeemed), merged);
        if cash < min_out {
            fail!("CashOutBelowMin({cash}, {min_out})");
        }
        CashOut {
            sold,
            received,
            merged,
            real_usdc: c.real_usdc,
            redeemed: c.redeemed,
            cash,
            left_usdc,
            dead: c.dead,
            guard_ok: true,
        }
    }

    /// Step 7: logs the cash-out and pays the cash to the liquidator's
    /// wallet (a failed payout is re-credited to its internal balance).
    pub(crate) fn pay_cash_out(
        &mut self,
        liquidator: &AccountId,
        account: &AccountId,
        id: MarketId,
        out: &CashOut,
        min_out: u128,
    ) {
        CashOutLog {
            scenario_id: id.scenario_id,
            tier: id.tier,
            liquidator_id: liquidator,
            account_id: account,
            sold: u128s(&out.sold),
            received: u128s(&out.received),
            merged: U128(out.merged),
            real_usdc: U128(out.real_usdc),
            redeemed: U128(out.redeemed),
            cash: U128(out.cash),
            min_out: U128(min_out),
            left_usdc: u128s(&out.left_usdc),
            dead: &out.dead,
        }
        .emit();
        self.payout(liquidator, Asset::Usdc, out.cash);
    }

    /// Steps 1 to 6 on cloned pools, writing nothing. Returns the cash-out
    /// and the first world a sale would leave unpriced, if any.
    pub(crate) fn quote_cash_out(
        &self,
        sid: u64,
        s: &Scenario,
        pieces: &[CollateralKey],
        seized: &[u128],
    ) -> Result<(CashOut, Option<u8>), String> {
        let (worlds, p) = (s.world_count, s.possible);
        let c = convert(sid, s, pieces, seized);
        let n = usize::from(worlds);
        let cfg = self.price_cfg(sid);
        let mut usdc = c.singles[1].clone();
        let (mut sold, mut received) = (vec![0u128; n], vec![0u128; n]);
        let mut unpriced = None;
        for w in (0..worlds).filter(|w| masks::contains(p, *w)) {
            let i = usize::from(w);
            let amount = c.singles[0][i];
            if amount == 0 {
                continue;
            }
            let pool_id = self
                .world_pool(sid, w)
                .ok_or_else(|| format!("PoolNotInitialized({w})"))?;
            let (pool, got) = self.simulate_sale(pool_id, amount)?;
            sold[i] = amount;
            received[i] = got;
            usdc[i] = add(usdc[i], got);
            if unpriced.is_none() && !self.world_liq_priced_with(sid, &pool, &cfg) {
                unpriced = Some(w);
            }
        }
        let (merged, left_usdc) = merge_plan(&usdc, p);
        let out = CashOut {
            sold,
            received,
            merged,
            real_usdc: c.real_usdc,
            redeemed: c.redeemed,
            cash: add(add(c.real_usdc, c.redeemed), merged),
            left_usdc,
            dead: c.dead,
            guard_ok: unpriced.is_none(),
        };
        Ok((out, unpriced))
    }

    /// A sale of `amount` wNEAR-if-w into a clone of the pool, booked on the
    /// clone as `settle_swap` books it (the TWAP observation and the flow).
    fn simulate_sale(&self, pool_id: u64, amount: u128) -> Result<(Pool, u128), String> {
        let mut pool = self
            .pools
            .get(&pool_id)
            .cloned()
            .ok_or_else(|| format!("UnknownPool({pool_id})"))?;
        let fee = self.swap_gate(&pool)?;
        let swap = pool
            .amm
            .swap_exact_in(true, amount, fee)
            .map_err(|e| e.to_string())?;
        if let Some(tick) = pool.amm.tick() {
            pool.twap.write_spaced(now_sec(), tick, self.twap_spacing());
        }
        pool.flow
            .record_swap(swap.zero_for_one, swap.amount_in, swap.amount_out);
        Ok((pool, swap.amount_out))
    }
}
