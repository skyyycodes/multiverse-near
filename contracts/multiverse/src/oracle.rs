//! EventOracle: binary events, outcome proposals, a dispute window, and
//! finalization, which resolves every scenario using the event at once.
//!
//! While a proposal is open, exactly one of `dispute` (owner, before
//! `proposed_at + window`) and `finalize` (anyone, from that second on) is
//! possible. The window is read at call time, so changing it also moves
//! open proposals. `report_outcome` is the automated path: one
//! reporter account, ideally holding only a function-call key for it.
//! Times are whole seconds of block time.

use near_sdk::{assert_one_yocto, env, near, AccountId};

use crate::errors::fail;
use crate::events::{
    DisputeWindowSet, EventCreated, EventFinalized, MultiverseEvent, OutcomeProposed,
    ProposalDisputed, ReportReceived, ReporterSet,
};
use crate::ops::PauseFlag;
use crate::types::{EventData, EventView, ProposedBy, Source};
use crate::{now_sec, Contract, ContractExt};

/// Longest evidence string `report_outcome` accepts, in bytes.
pub const MAX_EVIDENCE_BYTES: usize = 512;

/// Owner text is logged in full by `event_created`; these caps keep that log
/// far below the 16 KiB a receipt may emit.
pub const MAX_QUESTION_BYTES: usize = 280;
pub const MAX_RULE_BYTES: usize = 1024;
pub const MAX_OUTCOME_NAME_BYTES: usize = 32;

#[near]
impl Contract {
    /// Owner only; the attached deposit (or the owner's storage balance) pays
    /// for the event. `deadline_sec` is informational and never checked.
    #[payable]
    pub fn create_event(
        &mut self,
        question: String,
        outcome_names: Vec<String>,
        rule: String,
        deadline_sec: u64,
    ) -> u64 {
        self.assert_live(PauseFlag::Mint);
        self.assert_owner();
        if question.is_empty() || rule.is_empty() {
            fail("EmptyText");
        }
        if outcome_names.len() != 2 {
            fail!("NotBinary({})", outcome_names.len());
        }
        if outcome_names.iter().any(String::is_empty) {
            fail("EmptyText");
        }
        if question.len() > MAX_QUESTION_BYTES {
            fail("TextTooLong(question)");
        }
        if rule.len() > MAX_RULE_BYTES {
            fail("TextTooLong(rule)");
        }
        if outcome_names
            .iter()
            .any(|n| n.len() > MAX_OUTCOME_NAME_BYTES)
        {
            fail("TextTooLong(outcome_names)");
        }
        let before = env::storage_usage();
        self.event_count += 1;
        let event_id = self.event_count;
        EventCreated {
            event_id,
            question: &question,
            outcome_names: &outcome_names,
            rule: &rule,
            deadline_sec,
        }
        .emit();
        self.events.insert(
            event_id,
            EventData {
                question,
                rule,
                outcome_names,
                deadline_sec,
                proposed_at_sec: 0,
                proposed_outcome: 0,
                proposal_open: false,
                finalized: false,
                outcome: 0,
                proposed_by: ProposedBy::Nobody,
            },
        );
        self.charge_storage_or_deposit(&env::predecessor_account_id(), before);
        event_id
    }

    /// The resolver's entry point; no deposit, so a function-call key can
    /// sign it. `target` must be this contract (a replay guard
    /// against other deployments), and the evidence (e.g. the FRED rows used) is logged.
    pub fn report_outcome(
        &mut self,
        event_id: u64,
        outcome: u8,
        target: AccountId,
        evidence: String,
    ) {
        self.assert_live(PauseFlag::Oracle);
        let caller = env::predecessor_account_id();
        if self.reporter_id.as_ref() != Some(&caller) {
            fail!("NotReporter({caller})");
        }
        if target != env::current_account_id() {
            fail!("WrongTarget({target})");
        }
        if evidence.len() > MAX_EVIDENCE_BYTES {
            fail!("EvidenceTooLong({}, {MAX_EVIDENCE_BYTES})", evidence.len());
        }
        let before = env::storage_usage();
        self.propose(event_id, outcome, Source::Reporter);
        ReportReceived {
            event_id,
            outcome,
            reporter_id: &caller,
            evidence: &evidence,
        }
        .emit();
        self.charge_storage(&caller, before);
    }

    /// Cancels the open proposal while its window runs. The proposal's time,
    /// outcome and source are kept; a new proposal may follow.
    #[payable]
    pub fn dispute(&mut self, event_id: u64) {
        assert_one_yocto();
        self.assert_owner();
        let mut e = self.event(event_id).clone();
        if !e.proposal_open {
            fail!("NoOpenProposal({event_id})");
        }
        // Added in u128, so a huge window can still be disputed (it cannot be
        // finalized until the owner lowers it).
        let ends = u128::from(e.proposed_at_sec) + u128::from(self.params.dispute_window_sec);
        if u128::from(now_sec()) >= ends {
            fail!("DisputeWindowOver({event_id})");
        }
        let before = env::storage_usage();
        cancel(event_id, &mut e);
        self.events.insert(event_id, e);
        self.charge_storage(&env::predecessor_account_id(), before);
    }

    /// Anyone, no deposit, from `finalizable_at` on.
    pub fn finalize(&mut self, event_id: u64) {
        self.assert_live(PauseFlag::Oracle);
        if !self.event(event_id).proposal_open {
            fail!("NoOpenProposal({event_id})");
        }
        let at = self.finalizable_at(event_id);
        if now_sec() < at {
            fail!("DisputeWindowNotOver({event_id}, {at})");
        }
        let before = env::storage_usage();
        self.finalize_proposal(event_id);
        self.charge_storage(&env::predecessor_account_id(), before);
    }

    /// Owner override: cancels any open proposal (even one whose window has
    /// passed), then proposes and finalizes `outcome` at once.
    #[payable]
    pub fn admin_resolve(&mut self, event_id: u64, outcome: u8) {
        assert_one_yocto();
        self.assert_owner();
        let mut e = self.event(event_id).clone();
        let before = env::storage_usage();
        if e.proposal_open {
            cancel(event_id, &mut e);
            self.events.insert(event_id, e);
        }
        self.propose(event_id, outcome, Source::Admin);
        self.finalize_proposal(event_id);
        self.charge_storage(&env::predecessor_account_id(), before);
    }

    /// `None` disables reports.
    #[payable]
    pub fn set_reporter(&mut self, reporter_id: Option<AccountId>) {
        assert_one_yocto();
        self.assert_owner();
        ReporterSet {
            reporter_id: reporter_id.as_ref(),
        }
        .emit();
        self.reporter_id = reporter_id;
    }

    /// Any value, 0 included (then a proposal can be finalized in its own
    /// block and never disputed).
    #[payable]
    pub fn set_dispute_window(&mut self, dispute_window_sec: u64) {
        assert_one_yocto();
        self.assert_owner();
        self.params.dispute_window_sec = dispute_window_sec;
        DisputeWindowSet { dispute_window_sec }.emit();
    }

    pub fn get_event(&self, event_id: u64) -> EventView {
        let e = self.event(event_id);
        let finalizable_at_sec = if e.proposal_open {
            e.proposed_at_sec
                .saturating_add(self.params.dispute_window_sec)
        } else {
            0
        };
        EventView {
            id: event_id,
            question: e.question.clone(),
            rule: e.rule.clone(),
            outcome_names: e.outcome_names.clone(),
            deadline_sec: e.deadline_sec,
            proposed_at_sec: e.proposed_at_sec,
            proposed_outcome: e.proposed_outcome,
            proposal_open: e.proposal_open,
            finalized: e.finalized,
            outcome: e.outcome,
            finalizable_at_sec,
            proposed_by: e.proposed_by.source(),
        }
    }

    pub fn event_count(&self) -> u64 {
        self.event_count
    }

    pub fn dispute_window_sec(&self) -> u64 {
        self.params.dispute_window_sec
    }

    pub fn reporter_id(&self) -> Option<AccountId> {
        self.reporter_id.clone()
    }

    /// 0 for an unknown event, without failing.
    pub fn outcome_count(&self, event_id: u64) -> u8 {
        self.events
            .get(&event_id)
            .map_or(0, |e| e.outcome_names.len() as u8)
    }

    pub fn outcome_name(&self, event_id: u64, outcome: u8) -> String {
        let e = self.event(event_id);
        e.outcome_names
            .get(usize::from(outcome))
            .cloned()
            .unwrap_or_else(|| fail!("InvalidOutcome({outcome})"))
    }

    /// False for an unknown event.
    pub fn is_finalized(&self, event_id: u64) -> bool {
        self.events.get(&event_id).is_some_and(|e| e.finalized)
    }

    /// False for an unknown event.
    pub fn has_open_proposal(&self, event_id: u64) -> bool {
        self.events.get(&event_id).is_some_and(|e| e.proposal_open)
    }

    /// 0 unless a proposal is open; otherwise `proposed_at + window` with the
    /// current window, failing on u64 overflow.
    pub fn finalizable_at(&self, event_id: u64) -> u64 {
        match self.events.get(&event_id) {
            Some(e) if e.proposal_open => e
                .proposed_at_sec
                .checked_add(self.params.dispute_window_sec)
                .unwrap_or_else(|| fail("ArithmeticOverflow")),
            _ => 0,
        }
    }
}

impl Contract {
    pub(crate) fn event(&self, event_id: u64) -> &EventData {
        self.events
            .get(&event_id)
            .unwrap_or_else(|| fail!("UnknownEvent({event_id})"))
    }

    /// Shared by the reporter and the admin path. Checks: unknown, then
    /// finalized, then already open, then the outcome's range.
    pub(crate) fn propose(&mut self, event_id: u64, outcome: u8, source: Source) {
        let mut e = self.event(event_id).clone();
        if e.finalized {
            fail!("AlreadyFinalized({event_id})");
        }
        if e.proposal_open {
            fail!("ProposalAlreadyOpen({event_id})");
        }
        if usize::from(outcome) >= e.outcome_names.len() {
            fail!("InvalidOutcome({outcome})");
        }
        let now = now_sec();
        let finalizable_at_sec = now
            .checked_add(self.params.dispute_window_sec)
            .unwrap_or_else(|| fail("ArithmeticOverflow"));
        e.proposal_open = true;
        e.proposed_outcome = outcome;
        e.proposed_at_sec = now;
        e.proposed_by = source.into();
        self.events.insert(event_id, e);
        OutcomeProposed {
            event_id,
            outcome,
            source,
            finalizable_at_sec,
        }
        .emit();
    }

    /// Stores the result first, then resolves each scenario using the event
    /// in creation order. An event no scenario uses finalizes with `[]`.
    fn finalize_proposal(&mut self, event_id: u64) {
        let mut e = self.event(event_id).clone();
        let outcome = e.proposed_outcome;
        e.proposal_open = false;
        e.finalized = true;
        e.outcome = outcome;
        self.events.insert(event_id, e);
        let scenario_ids = self.scenarios_of_event(event_id);
        for sid in &scenario_ids {
            self.resolve(*sid, event_id, outcome);
        }
        EventFinalized {
            event_id,
            outcome,
            scenario_ids: &scenario_ids,
        }
        .emit();
    }
}

fn cancel(event_id: u64, e: &mut EventData) {
    e.proposal_open = false;
    ProposalDisputed {
        event_id,
        outcome: e.proposed_outcome,
    }
    .emit();
}
