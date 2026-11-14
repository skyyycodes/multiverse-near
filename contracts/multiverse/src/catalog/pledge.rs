//! Pledges: wNEAR or USDC escrowed for a proposal until it opens (then they
//! become its starting liquidity) or ends (then they are returned). A
//! pledger can take everything back at any time before the opening, except
//! under the owner's `exit` pause.

use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, AccountId, Gas, NearToken, Promise};

use super::events::{OpenScheduled, PledgeReturned, Pledged};
use super::{Pledge, PledgeReturn, Proposal, ProposalStatus};
use crate::errors::fail;
use crate::events::MultiverseEvent;
use crate::ops::PauseFlag;
use crate::receiver::PledgeMsg;
use crate::types::Asset;
use crate::{Contract, ContractExt};

/// Gas the detached `auto_open` gets.
pub const GAS_FOR_AUTO_OPEN: Gas = Gas::from_tgas(200);
/// A pledge schedules an opening only with this much gas left.
pub const GAS_TO_SCHEDULE: Gas = Gas::from_tgas(215);
/// Blocks between two scheduled openings of one proposal.
pub const SCHEDULE_SPACING_BLOCKS: u64 = 5;

#[near]
impl Contract {
    /// Takes back `wnear` and `usdc` of the caller's pledge (`None` = all of
    /// that asset, `Some(x)` = exactly `x`) while the proposal has not opened.
    /// Once it has ended without opening, the whole pledge comes back
    /// whatever the arguments.
    #[payable]
    pub fn withdraw_pledge(
        &mut self,
        proposal_id: u64,
        wnear: Option<U128>,
        usdc: Option<U128>,
    ) -> PledgeReturn {
        assert_one_yocto();
        self.assert_live(PauseFlag::Exit);
        let account = env::predecessor_account_id();
        let p = self.proposal_record(proposal_id);
        if p.status == ProposalStatus::Opened {
            fail!("AlreadyOpen({proposal_id}, {})", p.open.scenario_id);
        }
        let pledge = self
            .catalog
            .pledges
            .get(&(proposal_id, account.clone()))
            .cloned()
            .unwrap_or_else(|| fail!("NoPledge({proposal_id}, {account})"));
        let (status, _) = self.effective_status(&p);
        let ended = status.is_terminal();
        let (take_w, take_u) = if ended {
            (pledge.wnear, pledge.usdc)
        } else {
            let take_w = wnear.map_or(pledge.wnear, |x| x.0);
            let take_u = usdc.map_or(pledge.usdc, |x| x.0);
            if take_w == 0 && take_u == 0 {
                fail("ZeroAmount");
            }
            let params = self.market_params_stored();
            let legs = [
                (
                    Asset::Wnear,
                    pledge.wnear,
                    take_w,
                    params.min_pledge_wnear.0,
                ),
                (Asset::Usdc, pledge.usdc, take_u, params.min_pledge_usdc.0),
            ];
            for (asset, have, want, _) in legs {
                if want > have {
                    fail!("InsufficientPledge({asset}, {have}, {want})");
                }
            }
            for (_, have, want, min) in legs {
                let rest = have - want;
                if rest > 0 && rest < min {
                    fail!("PledgeTooSmall({rest}, {min})");
                }
            }
            (take_w, take_u)
        };
        if ended {
            self.settle_segment(proposal_id);
        }
        self.flush_state();
        let before = env::storage_usage();
        let mut p = self.proposal_record(proposal_id);
        let mut pledge = pledge;
        pledge.wnear -= take_w;
        pledge.usdc -= take_u;
        p.escrow_wnear = p.escrow_wnear.saturating_sub(take_w);
        p.escrow_usdc = p.escrow_usdc.saturating_sub(take_u);
        self.escrow_books(Asset::Wnear, take_w, false);
        self.escrow_books(Asset::Usdc, take_u, false);
        if pledge.wnear == 0 && pledge.usdc == 0 {
            self.drop_pledge(proposal_id, &mut p, &account);
        } else {
            self.catalog
                .pledges
                .insert((proposal_id, account.clone()), pledge);
        }
        self.save_proposal(proposal_id, p);
        PledgeReturned {
            proposal_id,
            account_id: &account,
            wnear: U128(take_w),
            usdc: U128(take_u),
            reason: if ended { "refund" } else { "withdraw" },
        }
        .emit();
        self.payout(&account, Asset::Wnear, take_w);
        self.payout(&account, Asset::Usdc, take_u);
        self.charge_storage(&account, before);
        PledgeReturn {
            wnear: U128(take_w),
            usdc: U128(take_u),
        }
    }
}

impl Contract {
    /// ft action `{"action":"pledge","proposal_id":N}` (USDC or wNEAR): the
    /// whole credited amount goes into the proposal's escrow (only the
    /// sub-unit remainder of a 24-decimal token is refunded).
    pub(crate) fn ft_pledge(
        &mut self,
        sender: &AccountId,
        asset: Asset,
        amount: u128,
        msg: PledgeMsg,
    ) {
        let pid = msg.proposal_id;
        let mut p = self.proposal_record(pid);
        let (status, _) = self.effective_status(&p);
        if !matches!(status, ProposalStatus::Review | ProposalStatus::Pledging) {
            fail!("ProposalClosed({pid}, {})", status.name());
        }
        let key = (pid, sender.clone());
        let mut pledge = self.catalog.pledges.get(&key).cloned();
        if pledge.is_none() {
            let params = self.market_params_stored();
            let min = match asset {
                Asset::Wnear => params.min_pledge_wnear.0,
                Asset::Usdc => params.min_pledge_usdc.0,
            };
            if amount < min {
                fail!("PledgeTooSmall({amount}, {min})");
            }
            let mut m = self.account_markets(sender);
            let max = params.max_pledges_per_account;
            if m.pledges.len() >= usize::from(max) {
                fail!("TooManyPledges({max})");
            }
            m.pledges.push(pid);
            self.set_account_markets(sender, m);
            p.pledgers += 1;
            pledge = Some(Pledge::default());
        }
        let mut pledge = pledge.unwrap_or_default();
        self.real_debit(sender, asset, amount);
        match asset {
            Asset::Wnear => {
                pledge.wnear = crate::errors::add(pledge.wnear, amount);
                p.escrow_wnear = crate::errors::add(p.escrow_wnear, amount);
            }
            Asset::Usdc => {
                pledge.usdc = crate::errors::add(pledge.usdc, amount);
                p.escrow_usdc = crate::errors::add(p.escrow_usdc, amount);
            }
        }
        self.escrow_books(asset, amount, true);
        self.catalog.pledges.insert(key, pledge);
        Pledged {
            proposal_id: pid,
            account_id: sender,
            asset,
            amount: U128(amount),
            escrow_wnear: U128(p.escrow_wnear),
            escrow_usdc: U128(p.escrow_usdc),
        }
        .emit();
        self.save_proposal(pid, p);
        self.schedule_open(pid);
    }

    /// Deletes an emptied pledge record and the pledger's entry for it.
    pub(crate) fn drop_pledge(&mut self, pid: u64, p: &mut Proposal, account: &AccountId) {
        self.catalog.pledges.remove(&(pid, account.clone()));
        p.pledgers = p.pledgers.saturating_sub(1);
        let mut m = self.account_markets(account);
        m.pledges.retain(|id| *id != pid);
        self.set_account_markets(account, m);
    }

    /// The auto-open trigger, at the end of a pledge and an approval: when a
    /// pledging proposal's escrow at `s_hint` reaches the goal, no opening
    /// was scheduled in the last few blocks, enough gas is left and
    /// `open_check` passes, schedule a detached `auto_open`, which never
    /// fails the pledge.
    pub(crate) fn schedule_open(&mut self, pid: u64) {
        let mut p = self.proposal_record(pid);
        if p.status != ProposalStatus::Pledging || p.pledged_value() < p.goal {
            return;
        }
        let height = env::block_height();
        if p.open_scheduled_block != 0
            && height
                <= p.open_scheduled_block
                    .saturating_add(SCHEDULE_SPACING_BLOCKS)
        {
            return;
        }
        let left = env::prepaid_gas().saturating_sub(env::used_gas());
        if left < GAS_TO_SCHEDULE || self.effective_status(&p).0.is_terminal() {
            return;
        }
        if self.open_check(pid).is_err() {
            return;
        }
        Promise::new(env::current_account_id()).function_call(
            "auto_open".to_string(),
            near_sdk::serde_json::json!({ "proposal_id": pid })
                .to_string()
                .into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_FOR_AUTO_OPEN,
        );
        p.open_scheduled_block = height.max(1);
        self.save_proposal(pid, p);
        OpenScheduled { proposal_id: pid }.emit();
    }
}
