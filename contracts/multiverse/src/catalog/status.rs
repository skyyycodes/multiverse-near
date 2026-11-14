//! Lazy, monotone proposal status and what each end does with the bond, the
//! reserve and the indexes. A terminal status is applied ("settled") by the
//! first call that needs it; the bytes it frees go back to the proposer.

use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId};

use super::events::ProposalSettled;
use super::{question_hash, Proposal, ProposalKind, ProposalStatus, VoidReason};
use crate::core::MAX_SCENARIOS_PER_EVENT;
use crate::events::MultiverseEvent;
use crate::{now_sec, Contract, ContractExt};

#[near]
impl Contract {
    /// Anyone, no deposit, never paused: applies a terminal status that has
    /// set in (bond and reserve per the outcome table, indexes cleared, the
    /// freed bytes credited to the proposer). Idempotent; returns the status.
    pub fn settle_proposal(&mut self, proposal_id: u64) -> ProposalStatus {
        self.proposal_record(proposal_id);
        self.settle_segment(proposal_id)
    }
}

/// What an end paid out of the proposal's NEAR.
#[derive(Default)]
pub(crate) struct NearOut {
    pub bond_returned: u128,
    pub bond_forfeited: u128,
    pub reserve_returned: u128,
}

impl Contract {
    /// The status as of now (SPEC-C 3.7.2), with the void reason.
    pub(crate) fn effective_status(&self, p: &Proposal) -> (ProposalStatus, VoidReason) {
        let params = self.market_params_stored();
        self.effective_with(p, params.review_ttl_sec)
    }

    pub(crate) fn effective_with(
        &self,
        p: &Proposal,
        review_ttl_sec: u64,
    ) -> (ProposalStatus, VoidReason) {
        if !matches!(p.status, ProposalStatus::Review | ProposalStatus::Pledging) {
            return (p.status, p.void_reason);
        }
        let now = now_sec();
        if p.status == ProposalStatus::Review
            && now >= p.created_at_sec.saturating_add(review_ttl_sec)
        {
            return (ProposalStatus::Void, VoidReason::ReviewTimeout);
        }
        if p.kind == ProposalKind::Market {
            for e in p.event_ids() {
                if self.is_finalized(e) {
                    return (ProposalStatus::Void, VoidReason::EventResolved);
                }
                if self.scenarios_of_event.get(&e).map_or(0, Vec::len) >= MAX_SCENARIOS_PER_EVENT {
                    return (ProposalStatus::Void, VoidReason::EventFull);
                }
            }
        }
        if p.status == ProposalStatus::Pledging && now >= p.expires_at_sec {
            return (ProposalStatus::Expired, VoidReason::None);
        }
        (p.status, VoidReason::None)
    }

    /// Whether the proposal is live (review or pledging) as of now.
    pub(crate) fn proposal_is_live(&self, pid: u64) -> bool {
        self.get_proposal_record(pid).is_some_and(|p| {
            !self.effective_status(&p).0.is_terminal() && p.status != ProposalStatus::Opened
        })
    }

    /// Settles `pid` if its effective status is terminal and not stored yet,
    /// in its own storage segment: the bytes freed are credited to the
    /// proposer. Returns the effective status.
    pub(crate) fn settle_segment(&mut self, pid: u64) -> ProposalStatus {
        let mut p = self.proposal_record(pid);
        let (status, reason) = self.effective_status(&p);
        if status.is_terminal() && p.status != status {
            self.flush_state();
            let before = env::storage_usage();
            self.settle(pid, &mut p, status, reason);
            self.charge_storage(&p.proposer.clone(), before);
        }
        status
    }

    /// Voids a live proposal for `reason` (market listed on its set, or
    /// evicted), or settles it if it already ended; own segment.
    pub(crate) fn void_segment(&mut self, pid: u64, reason: VoidReason) {
        let mut p = self.proposal_record(pid);
        let (status, effective_reason) = self.effective_status(&p);
        if status.is_terminal() {
            self.settle_segment(pid);
            return;
        }
        let _ = effective_reason;
        self.flush_state();
        let before = env::storage_usage();
        self.settle(pid, &mut p, ProposalStatus::Void, reason);
        self.charge_storage(&p.proposer.clone(), before);
    }

    /// Stores the end, pays the bond and the reserve per the outcome table,
    /// clears the indexes and logs `proposal_settled`.
    pub(crate) fn settle(
        &mut self,
        pid: u64,
        p: &mut Proposal,
        status: ProposalStatus,
        reason: VoidReason,
    ) {
        let floor = self.market_params_stored().spam_floor_bps;
        let forfeit = match (status, reason) {
            (ProposalStatus::Expired, _) | (ProposalStatus::Void, VoidReason::Evicted) => {
                p.under_floor(floor)
            }
            _ => false,
        };
        p.status = status;
        p.void_reason = reason;
        let out = self.pay_back(p, forfeit);
        self.release_indexes(pid, p);
        self.save_proposal(pid, p.clone());
        ProposalSettled {
            proposal_id: pid,
            status,
            void_reason: reason,
            bond_returned: U128(out.bond_returned),
            bond_forfeited: U128(out.bond_forfeited),
            reserve_returned: U128(out.reserve_returned),
        }
        .emit();
    }

    /// Moves the proposal's NEAR out: the bond to `storage_fund` when
    /// `forfeit_bond`, else back to the proposer's NEP-145 deposit, and the
    /// reserve back to the proposer. `books.near_held` follows.
    pub(crate) fn pay_back(&mut self, p: &mut Proposal, forfeit_bond: bool) -> NearOut {
        let mut out = NearOut::default();
        if forfeit_bond {
            out.bond_forfeited = p.bond;
            self.catalog.storage_fund = self.catalog.storage_fund.saturating_add(p.bond);
        } else {
            out.bond_returned = p.bond;
        }
        out.reserve_returned = p.reserve;
        self.books.near_held = self
            .books
            .near_held
            .saturating_sub(p.bond.saturating_add(p.reserve));
        let back = out.bond_returned.saturating_add(out.reserve_returned);
        p.bond = 0;
        p.reserve = 0;
        self.credit_deposit(&p.proposer.clone(), back);
        out
    }

    /// Removes what only a live proposal needs: a new event's texts and
    /// question hash, a combination's set and per-event entries, and the
    /// proposer's account entry.
    pub(crate) fn release_indexes(&mut self, pid: u64, p: &Proposal) {
        match p.kind {
            ProposalKind::NewEvent => {
                if let Some(text) = self.catalog.texts.remove(&pid) {
                    let hash = question_hash(&text.question);
                    if self.catalog.question_hashes.get(&hash) == Some(&pid) {
                        self.catalog.question_hashes.remove(&hash);
                    }
                }
            }
            ProposalKind::Market => {
                if self.catalog.proposal_by_set.get(&p.key) == Some(&pid) {
                    self.catalog.proposal_by_set.remove(&p.key);
                }
                for e in p.event_ids() {
                    let Some(mut live) = self.catalog.live_of_event.get(&e).cloned() else {
                        continue;
                    };
                    live.retain(|id| *id != pid);
                    if live.is_empty() {
                        self.catalog.live_of_event.remove(&e);
                    } else {
                        self.catalog.live_of_event.insert(e, live);
                    }
                }
            }
        }
        self.drop_proposal_entry(&p.proposer, pid);
    }

    pub(crate) fn drop_proposal_entry(&mut self, account: &AccountId, pid: u64) {
        let mut m = self.account_markets(account);
        let len = m.proposals.len();
        m.proposals.retain(|id| *id != pid);
        if m.proposals.len() != len {
            self.set_account_markets(account, m);
        }
    }
}
