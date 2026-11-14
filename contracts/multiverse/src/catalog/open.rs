//! Opening a market from its pledges, in one receipt: the event (Kind A),
//! the scenario, the custody seeding, every world pool and odds pool, the
//! seed vault that holds them for the pledgers, and the registry entry.
//!
//! `open_check` is the single source of truth: `open_market` panics with its
//! error, `auto_open` logs it and returns, the views show it. The market's
//! bytes are paid from the proposal's reserve, then from `storage_fund`; the
//! opener's NEP-145 record is never touched.

use multiverse_math::seed::{self, PlanError, SeedAsset, SeedInput, SeedPlan};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId};

use super::events::{MarketOpened, OpenDeferred, ReferenceMarketSet};
use super::pricing::SpotRef;
use super::{
    question_hash, Check, EventMeta, EventSetKey, IdleToken, MarketEntry, MarketOrigin, OpenRecord,
    Proposal, ProposalKind, ProposalStatus, SeedPosition, SeedVault, VMarketEntry, VSeedVault,
};
use crate::amm::create::PoolFunding;
use crate::core::MAX_SCENARIOS_PER_EVENT;
use crate::errors::fail;
use crate::events::MultiverseEvent;
use crate::ops::PauseFlag;
use crate::types::{Asset, VerseKey};
use crate::{now_sec, Contract, ContractExt};

/// Storage estimate of an opening (SPEC-C 3.7.5 step 12), in bytes:
/// `(OPEN_BYTES_BASE + BYTES_PER_POOL (2W - 1) + BYTES_PER_KEY keys + texts) x
/// 5 / 4`. Calibrated on the measured openings of `tests/catalog_open.rs`,
/// which assert the estimate stays above the measured bytes; the measured
/// charge is the authority.
pub const OPEN_BYTES_BASE: u64 = 2_400;
pub const BYTES_PER_POOL: u64 = 450;
pub const BYTES_PER_KEY: u64 = 130;

/// Everything an opening needs, as `open_check` found it.
pub(crate) struct OpenPlan {
    pub p: Proposal,
    /// A combination's events (canonical); empty for a new event.
    pub ids: Vec<u64>,
    pub spot: SpotRef,
    pub plan: SeedPlan,
}

#[near]
impl Contract {
    /// Anyone, no deposit: opens a ready proposal; panics with the blocker
    /// otherwise. Returns the new scenario id.
    pub fn open_market(&mut self, proposal_id: u64) -> u64 {
        let plan = self.open_check(proposal_id).unwrap_or_else(|e| fail(&e));
        self.execute_open(proposal_id, plan, &env::predecessor_account_id())
    }

    /// The detached self-call a pledge or an approval schedules. Never panics
    /// on a blocker: it logs `open_deferred` and returns null.
    #[private]
    pub fn auto_open(&mut self, proposal_id: u64) -> Option<u64> {
        match self.open_check(proposal_id) {
            Ok(plan) => Some(self.execute_open(proposal_id, plan, &env::current_account_id())),
            Err(blocker) => {
                OpenDeferred {
                    proposal_id,
                    blocker: &blocker,
                }
                .emit();
                None
            }
        }
    }
}

/// The single-world (asset, mask) key of world `w`.
fn single(asset: Asset, w: usize) -> (Asset, u8) {
    (asset, 1u8 << w)
}

/// Custody keys an opening mints: every world's wNEAR and USDC single, plus
/// the multi-world USDC sides of the odds pools.
pub(crate) fn custody_keys(world_count: u8) -> u64 {
    let w = u64::from(world_count);
    if w <= 2 {
        2 * w
    } else {
        3 * w - 2
    }
}

/// Bytes of a new event's texts and meta that the opening stores.
fn text_bytes(c: &Contract, pid: u64, p: &Proposal) -> u64 {
    if p.kind != ProposalKind::NewEvent {
        return 0;
    }
    let texts = c.catalog.texts.get(&pid).map_or(0, |t| {
        t.question.len()
            + t.rule.len()
            + t.source.len()
            + t.outcome_names.iter().map(String::len).sum::<usize>()
    });
    (texts + p.proposer.len()) as u64
}

impl Contract {
    /// The checks of an opening (SPEC-C 3.7.5), first error wins: pause,
    /// unknown, stored and effective status, approval, notice, the events'
    /// oracle and slots, anchors, references and shape, planner, storage.
    pub(crate) fn open_check(&self, pid: u64) -> Check<OpenPlan> {
        if self.pause.is_paused(PauseFlag::Mint) {
            return Err("Paused(mint)".to_string());
        }
        let p = self.proposal_or(pid)?;
        if p.status == ProposalStatus::Opened {
            return Err(format!("AlreadyOpen({pid}, {})", p.open.scenario_id));
        }
        if p.status.is_terminal() {
            return Err(format!("ProposalClosed({pid}, {})", p.status.name()));
        }
        let (status, _) = self.effective_status(&p);
        if status.is_terminal() {
            return Err(format!("ProposalClosed({pid}, {})", status.name()));
        }
        if status == ProposalStatus::Review {
            return Err(format!("NotApproved({pid})"));
        }
        let now = now_sec();
        if now < p.open_not_before_sec {
            return Err(format!("NoticePeriod({pid}, {})", p.open_not_before_sec));
        }
        let ids = match p.kind {
            ProposalKind::Market => p.event_ids(),
            ProposalKind::NewEvent => Vec::new(),
        };
        for &e in &ids {
            if self.has_open_proposal(e) {
                return Err(format!("EventDeciding({e})"));
            }
        }
        for &e in &ids {
            self.check_slot(pid, e)?;
        }
        let params = self.market_params_stored();
        let spot = self.spot_reference(&params)?;
        let shape = match p.kind {
            ProposalKind::Market => self.kind_b_shape(&ids, spot.s_ref, &params)?,
            ProposalKind::NewEvent => self.kind_a_shape(&p.terms, spot.s_ref, &params)?,
        };
        let plan = match seed::seed_plan(&SeedInput {
            world_count: p.world_count,
            q: &shape.q,
            p: &shape.p,
            s: spot.s_ref,
            beta: p.beta,
            pledged_wnear: p.escrow_wnear,
            pledged_usdc: p.escrow_usdc,
        }) {
            Ok(plan) => plan,
            Err(PlanError::ZeroBase) => return Err(format!("GoalNotReached(0, {})", p.goal)),
            Err(e) => return Err(format!("PlanFailed({e})")),
        };
        if plan.usable_value < p.goal {
            return Err(format!("GoalNotReached({}, {})", plan.usable_value, p.goal));
        }
        let min = params.min_open_depth_usdc.0;
        if let Some((w, (_, usdc))) = plan
            .world
            .iter()
            .enumerate()
            .min_by_key(|(_, (_, usdc))| *usdc)
        {
            if *usdc < min {
                return Err(format!("TooThin({w}, {usdc}, {min})"));
            }
        }
        let storage_estimate = self.open_storage_estimate(pid, &p);
        let available = p.reserve.saturating_add(self.catalog.storage_fund);
        if storage_estimate > available {
            return Err(format!("OpenStorageShort({storage_estimate}, {available})"));
        }
        Ok(OpenPlan { p, ids, spot, plan })
    }

    /// yoctoNEAR the opening's bytes are estimated to cost.
    pub(crate) fn open_storage_estimate(&self, pid: u64, p: &Proposal) -> u128 {
        let w = u64::from(p.world_count);
        let bytes = OPEN_BYTES_BASE
            + BYTES_PER_POOL * (2 * w - 1)
            + BYTES_PER_KEY * custody_keys(p.world_count)
            + text_bytes(self, pid, p);
        env::storage_byte_cost()
            .as_yoctonear()
            .saturating_mul(u128::from(bytes * 5 / 4))
    }

    /// Slot priority on event `e`: the other live combinations funded in
    /// both assets that rank higher (the smaller of their two fill ratios;
    /// ties to the lower id) and have no event deciding must leave a slot
    /// free, else `OutrankedForSlot(e, best)`.
    fn check_slot(&self, pid: u64, e: u64) -> Check<()> {
        let free = MAX_SCENARIOS_PER_EVENT
            .saturating_sub(self.scenarios_of_event.get(&e).map_or(0, Vec::len));
        let own = self.get_proposal_record(pid).map_or(0, |p| fill_rank(&p));
        let mut better: Vec<(u128, u64)> = Vec::new();
        for other in self
            .catalog
            .live_of_event
            .get(&e)
            .cloned()
            .unwrap_or_default()
        {
            if other == pid {
                continue;
            }
            let Some(q) = self.get_proposal_record(other) else {
                continue;
            };
            let funded = q.ideal_usdc > 0
                && q.ideal_wnear > 0
                && q.escrow_usdc >= q.ideal_usdc
                && q.escrow_wnear >= q.ideal_wnear;
            if !funded
                || !matches!(self.effective_status(&q).0, ProposalStatus::Pledging)
                || q.event_ids().iter().any(|x| self.has_open_proposal(*x))
            {
                continue;
            }
            let rank = fill_rank(&q);
            if rank > own || (rank == own && other < pid) {
                better.push((rank, other));
            }
        }
        if better.len() >= free {
            let best = better
                .iter()
                .max_by_key(|(rank, id)| (*rank, u64::MAX - id))
                .map_or(0, |(_, id)| *id);
            return Err(format!("OutrankedForSlot({e}, {best})"));
        }
        Ok(())
    }

    /// The opening itself (SPEC-C 3.7.5 segments A and B).
    fn execute_open(&mut self, pid: u64, plan: OpenPlan, opener: &AccountId) -> u64 {
        let OpenPlan {
            mut p,
            ids,
            spot,
            plan,
        } = plan;
        let now = now_sec();
        let w_count = usize::from(p.world_count);
        let proposer = p.proposer.clone();

        // Segment A: the market's bytes, paid in NEAR from the reserve, then
        // from storage_fund.
        self.flush_state();
        let before_a = env::storage_usage();
        let (ids, event_id) = match p.kind {
            ProposalKind::Market => (ids, None),
            ProposalKind::NewEvent => {
                let text = self
                    .catalog
                    .texts
                    .get(&pid)
                    .cloned()
                    .unwrap_or_else(|| fail!("UnknownProposal({pid})"));
                let eid = self.internal_create_event(
                    text.question,
                    text.outcome_names,
                    text.rule,
                    p.deadline_sec,
                );
                self.catalog.event_meta.insert(
                    eid,
                    EventMeta {
                        proposal_id: pid,
                        proposer: Some(proposer.clone()),
                        source: text.source,
                        category: p.category,
                    },
                );
                (vec![eid], Some(eid))
            }
        };
        let sid = self.internal_create_scenario(&ids);
        self.on_scenario_created(sid);

        // Custody: every world covered by exactly UW wNEAR and UU USDC.
        let mut usdc_masks: Vec<(u8, u128)> = Vec::new();
        let mut add_usdc =
            |mask: u8, amount: u128| match usdc_masks.iter_mut().find(|(m, _)| *m == mask) {
                Some((_, total)) => *total += amount,
                None => usdc_masks.push((mask, amount)),
            };
        for (w, (_, usdc)) in plan.world.iter().enumerate() {
            add_usdc(single(Asset::Usdc, w).1, *usdc);
        }
        for (x, y, ax, ay) in &plan.odds_pools {
            add_usdc(*x, *ax);
            add_usdc(*y, *ay);
        }
        let mut idle = Vec::new();
        for (asset, mask, amount) in &plan.idle {
            match asset {
                SeedAsset::Wnear => {}
                SeedAsset::Usdc => add_usdc(*mask, *amount),
            }
            idle.push(IdleToken {
                asset: match asset {
                    SeedAsset::Wnear => Asset::Wnear,
                    SeedAsset::Usdc => Asset::Usdc,
                },
                mask: *mask,
                amount: *amount,
            });
        }
        let mut items: Vec<(VerseKey, u128)> = (0..w_count)
            .map(|w| (VerseKey::new(sid, Asset::Wnear, 1 << w), plan.used_wnear))
            .collect();
        usdc_masks.sort_unstable_by_key(|(m, _)| *m);
        items.extend(
            usdc_masks
                .iter()
                .map(|(m, a)| (VerseKey::new(sid, Asset::Usdc, *m), *a)),
        );
        self.fund_from_escrow(sid, plan.used_wnear, plan.used_usdc, &items);

        // Pools: world pools in world order, then odds pools in pairs() order.
        let mut positions = Vec::with_capacity(2 * w_count - 1);
        for (w, (wnear, usdc)) in plan.world.iter().enumerate() {
            let mask = 1u8 << w;
            let kind = self.admit_pair(
                VerseKey::new(sid, Asset::Wnear, mask),
                VerseKey::new(sid, Asset::Usdc, mask),
            );
            let (pool_id, position) =
                self.open_pool_core(sid, kind, *wnear, *usdc, PoolFunding::Custody);
            positions.push(SeedPosition { pool_id, position });
        }
        for (x, y, ax, ay) in &plan.odds_pools {
            let kind = self.admit_pair(
                VerseKey::new(sid, Asset::Usdc, *x),
                VerseKey::new(sid, Asset::Usdc, *y),
            );
            let (pool_id, position) =
                self.open_pool_core(sid, kind, *ax, *ay, PoolFunding::Custody);
            positions.push(SeedPosition { pool_id, position });
        }
        self.record_impact(sid);
        let pool_ids: Vec<u64> = positions.iter().map(|s| s.pool_id).collect();

        let open = OpenRecord {
            scenario_id: sid,
            opened_at_sec: now,
            s_ref: spot.s_ref,
            pledged_wnear: p.escrow_wnear,
            pledged_usdc: p.escrow_usdc,
            used_wnear: plan.used_wnear,
            used_usdc: plan.used_usdc,
            shares: seed::OpenTotals {
                pledged_wnear: p.escrow_wnear,
                pledged_usdc: p.escrow_usdc,
                used_wnear: plan.used_wnear,
                used_usdc: plan.used_usdc,
                s: spot.s_ref,
            }
            .total_shares(),
        };
        let unlock_at_sec = now.saturating_add(p.seed_lock_sec);
        self.catalog.seed_vaults.insert(
            sid,
            VSeedVault::V1(SeedVault {
                proposal_id: pid,
                supply: open.shares,
                unlock_at_sec,
                positions,
                idle,
            }),
        );
        self.catalog.registry.insert(
            sid,
            VMarketEntry::V1(MarketEntry {
                listed: true,
                origin: MarketOrigin::Pledged,
                proposal_id: pid,
                created_at_sec: now,
            }),
        );
        let set_key = p.key;
        let key = EventSetKey::of(&ids);
        self.catalog.listed_by_set.insert(key, sid);
        if let Some(eid) = event_id {
            self.catalog.reference_market.insert(eid, sid);
            ReferenceMarketSet {
                event_id: eid,
                scenario_id: Some(sid),
            }
            .emit();
        }
        self.escrow_books(Asset::Wnear, plan.used_wnear, false);
        self.escrow_books(Asset::Usdc, plan.used_usdc, false);
        p.escrow_wnear -= plan.used_wnear;
        p.escrow_usdc -= plan.used_usdc;
        p.status = ProposalStatus::Opened;
        p.key = key;
        p.unused_open = p.pledgers;
        let (pledged_wnear, pledged_usdc, shares) =
            (open.pledged_wnear, open.pledged_usdc, open.shares);
        p.open = open;

        self.flush_state();
        let storage_bytes = env::storage_usage().saturating_sub(before_a);
        let cost = env::storage_byte_cost()
            .as_yoctonear()
            .saturating_mul(u128::from(storage_bytes));
        let from_reserve = cost.min(p.reserve);
        let from_fund = cost - from_reserve;
        if from_fund > self.catalog.storage_fund {
            fail!(
                "OpenStorageShort({cost}, {})",
                p.reserve.saturating_add(self.catalog.storage_fund)
            );
        }
        p.reserve -= from_reserve;
        self.catalog.storage_fund -= from_fund;
        self.books.near_held = self.books.near_held.saturating_sub(from_reserve);
        // A combination's bond comes back now (a new event's came back at
        // approval), with what the reserve did not spend.
        let back = p.bond.saturating_add(p.reserve);
        self.books.near_held = self.books.near_held.saturating_sub(back);
        p.bond = 0;
        p.reserve = 0;
        self.credit_deposit(&proposer, back);
        self.save_proposal(pid, p);
        MarketOpened {
            proposal_id: pid,
            scenario_id: sid,
            event_id,
            opener,
            s_ref: U128(spot.s_ref),
            pledged_wnear: U128(pledged_wnear),
            pledged_usdc: U128(pledged_usdc),
            used_wnear: U128(plan.used_wnear),
            used_usdc: U128(plan.used_usdc),
            shares: U128(shares),
            pool_ids: &pool_ids,
            unlock_at_sec,
            storage_bytes,
            storage_cost: U128(cost),
        }
        .emit();

        // Segment B: the proposer's bytes of the live proposal, credited back.
        self.flush_state();
        let before_b = env::storage_usage();
        match event_id {
            Some(_) => {
                if let Some(text) = self.catalog.texts.remove(&pid) {
                    let hash = question_hash(&text.question);
                    if self.catalog.question_hashes.get(&hash) == Some(&pid) {
                        self.catalog.question_hashes.remove(&hash);
                    }
                }
            }
            None => {
                if self.catalog.proposal_by_set.get(&set_key) == Some(&pid) {
                    self.catalog.proposal_by_set.remove(&set_key);
                }
                for e in set_key.ids() {
                    let mut live = self
                        .catalog
                        .live_of_event
                        .get(&e)
                        .cloned()
                        .unwrap_or_default();
                    live.retain(|id| *id != pid);
                    if live.is_empty() {
                        self.catalog.live_of_event.remove(&e);
                    } else {
                        self.catalog.live_of_event.insert(e, live);
                    }
                }
            }
        }
        self.drop_proposal_entry(&proposer, pid);
        self.charge_storage(&proposer, before_b);
        sid
    }
}

/// `min(escrow_usdc / ideal_usdc, escrow_wnear / ideal_wnear)` in WAD; 0 for
/// a proposal without both ideals.
fn fill_rank(p: &Proposal) -> u128 {
    if p.ideal_usdc == 0 || p.ideal_wnear == 0 {
        return 0;
    }
    let ratio = |have: u128, ideal: u128| {
        multiverse_math::checked_mul_div(
            have,
            crate::types::WAD,
            ideal,
            multiverse_math::Rounding::Down,
        )
        .unwrap_or(u128::MAX)
    };
    ratio(p.escrow_usdc, p.ideal_usdc).min(ratio(p.escrow_wnear, p.ideal_wnear))
}
