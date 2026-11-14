//! Proposing markets, and what the proposer and the owner can do with a
//! proposal before it opens.
//!
//! Kind A (`propose_event`): a brand-new binary event and its market, opened
//! once the owner approves it and its pledges reach the goal. Kind B
//! (`propose_market`): a market on 1 to 3 open events, priced from each
//! event's reference market, opened as soon as its pledges reach the goal.

use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, AccountId};

use super::events::{
    NewEventLog, ProposalApproved, ProposalCancelled, ProposalClosedLog, ProposalCreated,
    ProposalEvicted, ProposalRejected, ProposalToppedUp,
};
use super::pricing::check_terms;
use super::{
    question_hash, Check, EventCheckView, EventSetKey, MarketCheck, MarketParams, OpenRecord,
    OpeningTerms, Proposal, ProposalKind, ProposalStatus, ProposalText, VoidReason, BPS_WAD,
    MAX_SOURCE_BYTES,
};
use crate::core::MAX_SCENARIOS_PER_EVENT;
use crate::errors::fail;
use crate::events::MultiverseEvent;
use crate::masks::MAX_EVENTS;
use crate::ops::PauseFlag;
use crate::oracle::check_event_text;
use crate::{now_sec, Contract, ContractExt};

/// What a new-event proposal is priced at when created or re-termed.
pub(crate) struct Priced {
    pub s_ref: u128,
    pub goal: u128,
    pub ideal_wnear: u128,
    pub ideal_usdc: u128,
}

/// A combination proposal that passed its checks.
pub(crate) struct MarketPlan {
    pub key: EventSetKey,
    pub ids: Vec<u64>,
    pub world_count: u8,
    pub deadline_sec: u64,
    pub expires_at_sec: u64,
    /// Ended proposals holding the set or a per-event slot, to settle first.
    pub settle: Vec<u64>,
    /// `(proposal, event)` evicted to make room.
    pub evict: Vec<(u64, u64)>,
    pub priced: Priced,
}

#[near]
impl Contract {
    /// A brand-new binary event and its market (Kind A). The deposit must
    /// cover `bond_new_event` plus the opening reserve of 2 worlds; the
    /// excess goes to the proposer's NEP-145 deposit. The event is created
    /// only when the market opens. Returns the proposal id.
    #[payable]
    pub fn propose_event(
        &mut self,
        question: String,
        outcome_names: Vec<String>,
        rule: String,
        source: String,
        deadline_sec: u64,
        category: u8,
        terms: OpeningTerms,
    ) -> u64 {
        self.assert_live(PauseFlag::Pledge);
        let proposer = env::predecessor_account_id();
        self.assert_registered(&proposer);
        check_event_text(&question, &outcome_names, &rule).unwrap_or_else(|e| fail(&e));
        if source.is_empty() {
            fail("EmptyText");
        }
        if source.len() > MAX_SOURCE_BYTES {
            fail("TextTooLong(source)");
        }
        if category >= super::CATEGORIES {
            fail!("BadCategory({category})");
        }
        let params = self.market_params_stored();
        let ended_holder = self
            .event_precheck(&question, &terms, deadline_sec, &params)
            .unwrap_or_else(|e| fail(&e));
        self.check_active(&proposer, &params)
            .unwrap_or_else(|e| fail(&e));
        let priced = self
            .price_new_event(&terms, &params)
            .unwrap_or_else(|e| fail(&e));
        let (bond, reserve) = (params.bond_new_event.0, params.reserve_for(2));
        let attached = self.attached_for(bond, reserve);
        // Ended proposals give up their slots first, each in its own segment.
        if let Some(pid) = ended_holder {
            self.settle_segment(pid);
        }
        self.settle_own_ended(&proposer);

        self.flush_state();
        let before = env::storage_usage();
        let now = now_sec();
        self.catalog.proposal_count += 1;
        let pid = self.catalog.proposal_count;
        let proposal = Proposal {
            kind: ProposalKind::NewEvent,
            status: ProposalStatus::Review,
            void_reason: VoidReason::None,
            proposer: proposer.clone(),
            key: EventSetKey([0; 3]),
            world_count: 2,
            category,
            terms,
            goal: priced.goal,
            ideal_wnear: priced.ideal_wnear,
            ideal_usdc: priced.ideal_usdc,
            s_hint: priced.s_ref,
            beta: u128::from(params.beta_bps) * BPS_WAD,
            seed_lock_sec: params.seed_lock_sec,
            created_at_sec: now,
            approved_at_sec: 0,
            expires_at_sec: 0,
            open_not_before_sec: 0,
            deadline_sec,
            escrow_wnear: 0,
            escrow_usdc: 0,
            pledgers: 0,
            unused_open: 0,
            bond,
            reserve,
            open_scheduled_block: 0,
            open: OpenRecord::default(),
        };
        ProposalCreated {
            proposal_id: pid,
            kind: ProposalKind::NewEvent,
            proposer: &proposer,
            event_ids: &[],
            world_count: 2,
            goal: U128(priced.goal),
            ideal_wnear: U128(priced.ideal_wnear),
            ideal_usdc: U128(priced.ideal_usdc),
            s_hint: U128(priced.s_ref),
            expires_at_sec: 0,
            bond: U128(bond),
            reserve: U128(reserve),
            new_event: Some(NewEventLog {
                question: &question,
                outcome_names: &outcome_names,
                rule: &rule,
                source: &source,
                deadline_sec,
                category,
                terms,
            }),
        }
        .emit();
        self.catalog
            .question_hashes
            .insert(question_hash(&question), pid);
        self.catalog.texts.insert(
            pid,
            ProposalText {
                question,
                outcome_names,
                rule,
                source,
            },
        );
        self.save_proposal(pid, proposal);
        self.add_proposal_entry(&proposer, pid);
        self.hold_near(&proposer, bond, reserve, attached);
        self.charge_storage(&proposer, before);
        pid
    }

    /// A market on 1 to 3 open events (Kind B), in any order. The deposit
    /// must cover `bond_market` plus the opening reserve of its worlds; the
    /// excess goes to the proposer's NEP-145 deposit. Returns the proposal id.
    #[payable]
    pub fn propose_market(&mut self, event_ids: Vec<u64>) -> u64 {
        self.assert_live(PauseFlag::Pledge);
        let proposer = env::predecessor_account_id();
        self.assert_registered(&proposer);
        let params = self.market_params_stored();
        let plan = self
            .check_market(&event_ids, Some(&proposer), &params)
            .unwrap_or_else(|e| fail(&e));
        let bond = params.bond_market.0;
        let reserve = params.reserve_for(plan.world_count);
        let attached = self.attached_for(bond, reserve);
        for pid in &plan.settle {
            self.settle_segment(*pid);
        }
        self.settle_own_ended(&proposer);
        let next = self.catalog.proposal_count + 1;
        for &(victim, event_id) in &plan.evict {
            self.void_segment(victim, VoidReason::Evicted);
            ProposalEvicted {
                proposal_id: victim,
                by_proposal_id: next,
                event_id,
            }
            .emit();
        }

        self.flush_state();
        let before = env::storage_usage();
        let now = now_sec();
        self.catalog.proposal_count = next;
        let pid = next;
        let priced = &plan.priced;
        ProposalCreated {
            proposal_id: pid,
            kind: ProposalKind::Market,
            proposer: &proposer,
            event_ids: &plan.ids,
            world_count: plan.world_count,
            goal: U128(priced.goal),
            ideal_wnear: U128(priced.ideal_wnear),
            ideal_usdc: U128(priced.ideal_usdc),
            s_hint: U128(priced.s_ref),
            expires_at_sec: plan.expires_at_sec,
            bond: U128(bond),
            reserve: U128(reserve),
            new_event: None,
        }
        .emit();
        self.save_proposal(
            pid,
            Proposal {
                kind: ProposalKind::Market,
                status: ProposalStatus::Pledging,
                void_reason: VoidReason::None,
                proposer: proposer.clone(),
                key: plan.key,
                world_count: plan.world_count,
                category: 0,
                terms: OpeningTerms {
                    odds0_bps: 0,
                    mult_bps: [0, 0],
                },
                goal: priced.goal,
                ideal_wnear: priced.ideal_wnear,
                ideal_usdc: priced.ideal_usdc,
                s_hint: priced.s_ref,
                beta: u128::from(params.beta_bps) * BPS_WAD,
                seed_lock_sec: params.seed_lock_sec,
                created_at_sec: now,
                approved_at_sec: now,
                expires_at_sec: plan.expires_at_sec,
                open_not_before_sec: 0,
                deadline_sec: plan.deadline_sec,
                escrow_wnear: 0,
                escrow_usdc: 0,
                pledgers: 0,
                unused_open: 0,
                bond,
                reserve,
                open_scheduled_block: 0,
                open: OpenRecord::default(),
            },
        );
        self.catalog.proposal_by_set.insert(plan.key, pid);
        for e in &plan.ids {
            let mut live = self
                .catalog
                .live_of_event
                .get(e)
                .cloned()
                .unwrap_or_default();
            live.push(pid);
            self.catalog.live_of_event.insert(*e, live);
        }
        self.add_proposal_entry(&proposer, pid);
        self.hold_near(&proposer, bond, reserve, attached);
        self.charge_storage(&proposer, before);
        pid
    }

    /// The proposer withdraws a live proposal nobody has pledged to
    /// (`HasPledges` otherwise). A combination's bond goes to `storage_fund`;
    /// a new event's bond comes back while it is in review. The reserve
    /// comes back.
    #[payable]
    pub fn cancel_proposal(&mut self, proposal_id: u64) {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        let mut p = self.proposal_record(proposal_id);
        if p.proposer != caller {
            fail!("NotProposer({proposal_id})");
        }
        self.assert_live_proposal(proposal_id, &p);
        if p.escrow_wnear > 0 || p.escrow_usdc > 0 {
            fail!("HasPledges({proposal_id})");
        }
        self.flush_state();
        let before = env::storage_usage();
        let forfeit = p.kind == ProposalKind::Market;
        let bond = p.bond;
        p.status = ProposalStatus::Cancelled;
        self.pay_back(&mut p, forfeit);
        self.release_indexes(proposal_id, &p);
        self.save_proposal(proposal_id, p);
        ProposalCancelled(ProposalClosedLog {
            proposal_id,
            forfeited: forfeit && bond > 0,
            bond: U128(bond),
        })
        .emit();
        self.charge_storage(&caller, before);
    }

    /// Owner only, for a new event: approves it (pledges can then open it)
    /// and returns the bond, or re-terms it (the goal is recomputed and
    /// openings wait `notice_sec`).
    #[payable]
    pub fn approve_proposal(&mut self, proposal_id: u64, terms: Option<OpeningTerms>) {
        assert_one_yocto();
        self.assert_owner();
        let mut p = self.proposal_record(proposal_id);
        if p.kind != ProposalKind::NewEvent {
            fail!("WrongKind({proposal_id})");
        }
        let (status, _) = self.effective_status(&p);
        let re_term = status == ProposalStatus::Pledging && terms.is_some();
        if status != ProposalStatus::Review && !re_term {
            fail!("ProposalClosed({proposal_id}, {})", status.name());
        }
        let params = self.market_params_stored();
        let new_terms = terms.unwrap_or(p.terms);
        check_terms(&new_terms, &params).unwrap_or_else(|e| fail(&e));
        self.check_deadline(p.deadline_sec, &params)
            .unwrap_or_else(|e| fail(&e));
        let now = now_sec();
        if new_terms != p.terms {
            let priced = self
                .price_new_event(&new_terms, &params)
                .unwrap_or_else(|e| fail(&e));
            p.terms = new_terms;
            p.goal = priced.goal;
            p.ideal_wnear = priced.ideal_wnear;
            p.ideal_usdc = priced.ideal_usdc;
            p.s_hint = priced.s_ref;
            p.open_not_before_sec = now.saturating_add(params.notice_sec);
        }
        if status == ProposalStatus::Review {
            p.status = ProposalStatus::Pledging;
            p.approved_at_sec = now;
            p.expires_at_sec = now
                .saturating_add(params.proposal_ttl_sec)
                .min(p.deadline_sec.saturating_sub(params.min_market_life_sec));
        }
        let bond = p.bond;
        if bond > 0 {
            p.bond = 0;
            self.books.near_held = self.books.near_held.saturating_sub(bond);
            self.credit_deposit(&p.proposer.clone(), bond);
        }
        ProposalApproved {
            proposal_id,
            terms: p.terms,
            goal: U128(p.goal),
            expires_at_sec: p.expires_at_sec,
            open_not_before_sec: p.open_not_before_sec,
            bond_returned: U128(bond),
        }
        .emit();
        self.save_proposal(proposal_id, p);
        self.schedule_open(proposal_id);
    }

    /// Owner only, for a new event in review or pledging: rejects it. The
    /// bond (if still held) goes to `storage_fund` with `forfeit_bond`, else
    /// back; the reserve comes back; pledges stay withdrawable.
    #[payable]
    pub fn reject_proposal(&mut self, proposal_id: u64, forfeit_bond: bool) {
        assert_one_yocto();
        self.assert_owner();
        let mut p = self.proposal_record(proposal_id);
        if p.kind != ProposalKind::NewEvent {
            fail!("WrongKind({proposal_id})");
        }
        self.assert_live_proposal(proposal_id, &p);
        self.flush_state();
        let before = env::storage_usage();
        let bond = p.bond;
        p.status = ProposalStatus::Rejected;
        self.pay_back(&mut p, forfeit_bond);
        self.release_indexes(proposal_id, &p);
        let proposer = p.proposer.clone();
        self.save_proposal(proposal_id, p);
        ProposalRejected(ProposalClosedLog {
            proposal_id,
            forfeited: forfeit_bond && bond > 0,
            bond: U128(bond),
        })
        .emit();
        self.charge_storage(&proposer, before);
    }

    /// Anyone adds NEAR to a live proposal's opening reserve; what the
    /// opening does not spend goes to the proposer.
    #[payable]
    pub fn top_up_proposal(&mut self, proposal_id: u64) {
        self.assert_live(PauseFlag::Pledge);
        let mut p = self.proposal_record(proposal_id);
        self.assert_live_proposal(proposal_id, &p);
        let amount = env::attached_deposit().as_yoctonear();
        if amount == 0 {
            fail("ZeroAmount");
        }
        p.reserve = p.reserve.saturating_add(amount);
        self.books.near_held = self.books.near_held.saturating_add(amount);
        self.save_proposal(proposal_id, p);
        ProposalToppedUp {
            proposal_id,
            account_id: &env::predecessor_account_id(),
            amount: U128(amount),
        }
        .emit();
    }
}

impl Contract {
    /// `ProposalClosed(pid, status)` unless the proposal is in review or
    /// pledging.
    pub(crate) fn assert_live_proposal(&self, pid: u64, p: &Proposal) {
        let (status, _) = self.effective_status(p);
        if !matches!(status, ProposalStatus::Review | ProposalStatus::Pledging) {
            fail!("ProposalClosed({pid}, {})", status.name());
        }
    }

    /// The deposit, which must cover `bond + reserve`
    /// (`InsufficientDeposit(needed, attached)`).
    fn attached_for(&self, bond: u128, reserve: u128) -> u128 {
        let needed = bond.saturating_add(reserve);
        let attached = env::attached_deposit().as_yoctonear();
        if attached < needed {
            fail!("InsufficientDeposit({needed}, {attached})");
        }
        attached
    }

    /// The NEAR funnel of a new proposal: bond and reserve held
    /// (`books.near_held`), the excess credited to the proposer's deposit.
    fn hold_near(&mut self, proposer: &AccountId, bond: u128, reserve: u128, attached: u128) {
        let held = bond.saturating_add(reserve);
        self.books.near_held = self.books.near_held.saturating_add(held);
        self.credit_deposit(proposer, attached - held);
    }

    fn add_proposal_entry(&mut self, proposer: &AccountId, pid: u64) {
        let mut m = self.account_markets(proposer);
        m.proposals.push(pid);
        self.set_account_markets(proposer, m);
    }

    /// Settles every ended proposal of `proposer` (each in its own segment).
    fn settle_own_ended(&mut self, proposer: &AccountId) {
        for pid in self.account_markets(proposer).proposals {
            self.settle_segment(pid);
        }
    }

    /// `TooManyActiveProposals(max)` when `proposer` already has
    /// `max_active_per_account` live proposals.
    fn check_active(&self, proposer: &AccountId, params: &MarketParams) -> Check<()> {
        let live = self
            .account_markets(proposer)
            .proposals
            .iter()
            .filter(|pid| self.proposal_is_live(**pid))
            .count();
        let max = params.max_active_per_account;
        if live >= usize::from(max) {
            return Err(format!("TooManyActiveProposals({max})"));
        }
        Ok(())
    }

    /// `DeadlineTooSoon(0, deadline)` unless a new event's deadline leaves
    /// the pledge window and the market's minimum life.
    fn check_deadline(&self, deadline_sec: u64, params: &MarketParams) -> Check<()> {
        let earliest = now_sec()
            .saturating_add(params.min_pledge_window_sec)
            .saturating_add(params.min_market_life_sec);
        if deadline_sec < earliest {
            return Err(format!("DeadlineTooSoon(0, {deadline_sec})"));
        }
        Ok(())
    }

    /// A new event's checks from its terms on (`BadTerms`, `DeadlineTooSoon`,
    /// `ProposalExists(pid)` for a live proposal of the same question).
    /// Returns an ended proposal still holding the question, to settle.
    pub(crate) fn event_precheck(
        &self,
        question: &str,
        terms: &OpeningTerms,
        deadline_sec: u64,
        params: &MarketParams,
    ) -> Check<Option<u64>> {
        check_terms(terms, params)?;
        self.check_deadline(deadline_sec, params)?;
        match self.catalog.question_hashes.get(&question_hash(question)) {
            Some(pid) if self.proposal_is_live(*pid) => Err(format!("ProposalExists({pid})")),
            Some(pid) => Ok(Some(*pid)),
            None => Ok(None),
        }
    }

    /// A new event's prices, goal and ideal mix at the current `S_ref`.
    pub(crate) fn price_new_event(
        &self,
        terms: &OpeningTerms,
        params: &MarketParams,
    ) -> Check<Priced> {
        let s_ref = self.spot_reference(params)?.s_ref;
        let shape = self.kind_a_shape(terms, s_ref, params)?;
        let (goal, ideal_wnear, ideal_usdc) = self.goal_of(&shape, s_ref, params)?;
        Ok(Priced {
            s_ref,
            goal,
            ideal_wnear,
            ideal_usdc,
        })
    }

    /// Every check of `propose_market` but registration and the deposit, in
    /// its order (SPEC-C 3.7.1).
    pub(crate) fn check_market(
        &self,
        event_ids: &[u64],
        proposer: Option<&AccountId>,
        params: &MarketParams,
    ) -> Check<MarketPlan> {
        let n = event_ids.len();
        if n == 0 || n > MAX_EVENTS {
            return Err(format!("BadEventCount({n})"));
        }
        let mut ids = event_ids.to_vec();
        ids.sort_unstable();
        if let Some(w) = ids.windows(2).find(|w| w[0] == w[1]) {
            return Err(format!("DuplicateEvent({})", w[0]));
        }
        for &e in &ids {
            self.events
                .get(&e)
                .ok_or_else(|| format!("UnknownEvent({e})"))?;
            if self.is_finalized(e) {
                return Err(format!("EventResolved({e})"));
            }
            if self.has_open_proposal(e) {
                return Err(format!("EventDeciding({e})"));
            }
            if self.scenarios_of_event.get(&e).map_or(0, Vec::len) >= MAX_SCENARIOS_PER_EVENT {
                return Err(format!("TooManyScenarios({e})"));
            }
            let reference = self.catalog.reference_market.get(&e).copied();
            if reference.is_none_or(|sid| self.check_reference(e, sid).is_err()) {
                return Err(format!("NoReferenceMarket({e})"));
            }
        }
        let key = EventSetKey::of(&ids);
        if let Some(sid) = self.catalog.listed_by_set.get(&key) {
            return Err(format!("MarketExists({sid})"));
        }
        let mut settle = Vec::new();
        if let Some(pid) = self.catalog.proposal_by_set.get(&key).copied() {
            if self.proposal_is_live(pid) {
                return Err(format!("ProposalExists({pid})"));
            }
            settle.push(pid);
        }
        let mut evict: Vec<(u64, u64)> = Vec::new();
        for &e in &ids {
            let mut live = Vec::new();
            for pid in self
                .catalog
                .live_of_event
                .get(&e)
                .cloned()
                .unwrap_or_default()
            {
                if !self.proposal_is_live(pid) {
                    if !settle.contains(&pid) {
                        settle.push(pid);
                    }
                } else if !evict.iter().any(|(v, _)| *v == pid) {
                    live.push(pid);
                }
            }
            if live.len() >= usize::from(params.max_live_per_event) {
                let victim = self
                    .eviction_candidate(&live, params)
                    .ok_or_else(|| format!("TooManyProposals({e})"))?;
                evict.push((victim, e));
            }
        }
        let now = now_sec();
        let mut expires_at_sec = now.saturating_add(params.proposal_ttl_sec);
        let mut deadline: Option<(u64, u64)> = None;
        for &e in &ids {
            let d = self.event(e).deadline_sec;
            if d > 0 && deadline.is_none_or(|(_, best)| d < best) {
                deadline = Some((e, d));
            }
        }
        if let Some((e, d)) = deadline {
            expires_at_sec = expires_at_sec.min(d.saturating_sub(params.min_market_life_sec));
            if expires_at_sec.saturating_sub(now) < params.min_pledge_window_sec
                || expires_at_sec <= now
            {
                return Err(format!("DeadlineTooSoon({e}, {d})"));
            }
        }
        if let Some(proposer) = proposer {
            self.check_active(proposer, params)?;
        }
        let s_ref = self.spot_reference(params)?.s_ref;
        let shape = self.kind_b_shape(&ids, s_ref, params)?;
        let (goal, ideal_wnear, ideal_usdc) = self.goal_of(&shape, s_ref, params)?;
        Ok(MarketPlan {
            key,
            world_count: 1 << ids.len(),
            ids,
            deadline_sec: deadline.map_or(0, |(_, d)| d),
            expires_at_sec,
            settle,
            evict,
            priced: Priced {
                s_ref,
                goal,
                ideal_wnear,
                ideal_usdc,
            },
        })
    }

    /// The live combination with the least pledged value at `s_hint` (ties:
    /// the oldest), if it is old enough and under the spam floor.
    fn eviction_candidate(&self, live: &[u64], params: &MarketParams) -> Option<u64> {
        let (pid, p) = live
            .iter()
            .filter_map(|pid| self.get_proposal_record(*pid).map(|p| (*pid, p)))
            .min_by_key(|(pid, p)| (p.pledged_value(), *pid))?;
        let old = now_sec().saturating_sub(p.created_at_sec) >= params.evict_min_age_sec;
        (old && p.under_floor(params.spam_floor_bps)).then_some(pid)
    }
}

#[near]
impl Contract {
    /// `propose_market`'s checks without panicking: the first error as
    /// `blocker`, the canonical set and what a proposal would cost and need.
    pub fn market_check(&self, event_ids: Vec<u64>) -> MarketCheck {
        let params = self.market_params_stored();
        let key = EventSetKey::of(&event_ids);
        let mut canonical = event_ids.clone();
        canonical.sort_unstable();
        let world_count = if event_ids.is_empty() || event_ids.len() > MAX_EVENTS {
            0
        } else {
            1u8 << event_ids.len()
        };
        let listed_market = self.catalog.listed_by_set.get(&key).copied();
        let live_proposal = self
            .catalog
            .proposal_by_set
            .get(&key)
            .copied()
            .filter(|pid| self.proposal_is_live(*pid));
        let mut view = MarketCheck {
            canonical,
            world_count,
            blocker: None,
            listed_market,
            live_proposal,
            goal: U128(0),
            ideal_wnear: U128(0),
            ideal_usdc: U128(0),
            bond: params.bond_market,
            reserve: U128(params.reserve_for(world_count)),
            expires_at_sec: 0,
        };
        match self.check_market(&event_ids, None, &params) {
            Ok(plan) => {
                view.goal = U128(plan.priced.goal);
                view.ideal_wnear = U128(plan.priced.ideal_wnear);
                view.ideal_usdc = U128(plan.priced.ideal_usdc);
                view.expires_at_sec = plan.expires_at_sec;
            }
            Err(e) => view.blocker = Some(e),
        }
        view
    }

    /// `propose_event`'s checks from its terms on, without panicking (texts,
    /// pause, registration and the deposit are the caller's).
    pub fn event_check(
        &self,
        question: String,
        terms: OpeningTerms,
        deadline_sec: u64,
    ) -> EventCheckView {
        let params = self.market_params_stored();
        let live_proposal = self
            .catalog
            .question_hashes
            .get(&question_hash(&question))
            .copied()
            .filter(|pid| self.proposal_is_live(*pid));
        let spot = self.spot_reference(&params);
        let priced = spot.as_ref().ok().and_then(|s| {
            let shape = self.kind_a_shape(&terms, s.s_ref, &params).ok()?;
            let goal = self.goal_of(&shape, s.s_ref, &params).ok();
            Some((shape, goal))
        });
        let blocker = self
            .event_precheck(&question, &terms, deadline_sec, &params)
            .and_then(|_| spot.clone().map(|_| ()))
            .err();
        let pair = |v: Option<&Vec<u128>>| -> [U128; 2] {
            let v = v.cloned().unwrap_or_default();
            [
                U128(v.first().copied().unwrap_or(0)),
                U128(v.get(1).copied().unwrap_or(0)),
            ]
        };
        let (goal, ideal_wnear, ideal_usdc) =
            priced.as_ref().and_then(|(_, g)| *g).unwrap_or((0, 0, 0));
        EventCheckView {
            blocker,
            live_proposal,
            goal: U128(goal),
            ideal_wnear: U128(ideal_wnear),
            ideal_usdc: U128(ideal_usdc),
            s_ref: spot.as_ref().ok().map(|s| U128(s.s_ref)),
            odds: pair(priced.as_ref().map(|(s, _)| &s.q)),
            prices: pair(priced.as_ref().map(|(s, _)| &s.p)),
            bond: params.bond_new_event,
            reserve: U128(params.reserve_for(2)),
        }
    }
}
