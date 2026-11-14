//! Operations: the granular pause, the guardian and the two-step owner
//! transfer.
//!
//! Eight flags, each stopping one group of actions. Every entry point checks
//! its flag right after
//! `assert_one_yocto`, before any access or argument check, so a paused action
//! always fails `Paused(<flag>)` first; `ft_on_transfer` leaves the check to
//! `dispatch`, so a paused action panics and the token refunds in full.
//! Repay, collateral top-ups, plain deposits, storage deposits, owner
//! setters, callbacks and views are never paused.
//!
//! The owner or the guardian may pause; only the owner may set `exit` and
//! only the owner may unpause. Unpausing `liquidate` starts a grace period
//! (one TWAP window by default) so that no account is liquidated at prices
//! that moved or went stale while liquidations were off.

use near_sdk::serde::Serialize;
use near_sdk::{assert_one_yocto, env, near, AccountId};

use crate::errors::fail;
use crate::events::MultiverseEvent;
use crate::receiver::Receive;
use crate::{now_sec, Contract, ContractExt};

/// Grace after `liquidate` is unpaused when the owner names none: one TWAP
/// window.
pub const LIQUIDATION_GRACE_SEC: u64 = 1_800;
/// The longest grace the owner may set.
pub const MAX_LIQUIDATION_GRACE_SEC: u64 = 86_400;
/// The longest pause reason, in bytes. It is logged, never stored.
pub const MAX_PAUSE_REASON_BYTES: usize = 256;

/// One pause flag; its bit in `PauseState.flags` is the variant index.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PauseFlag {
    Trade,
    Mint,
    Transfer,
    Lend,
    Liquidate,
    Oracle,
    Pledge,
    Exit,
}

impl PauseFlag {
    /// Every flag, in bit order.
    pub const ALL: [PauseFlag; 8] = [
        PauseFlag::Trade,
        PauseFlag::Mint,
        PauseFlag::Transfer,
        PauseFlag::Lend,
        PauseFlag::Liquidate,
        PauseFlag::Oracle,
        PauseFlag::Pledge,
        PauseFlag::Exit,
    ];

    /// The flags the guardian may set: all but `exit`, which only the owner
    /// controls. `migrate` leaves these set.
    pub const GUARDIAN: [PauseFlag; 7] = [
        PauseFlag::Trade,
        PauseFlag::Mint,
        PauseFlag::Transfer,
        PauseFlag::Lend,
        PauseFlag::Liquidate,
        PauseFlag::Oracle,
        PauseFlag::Pledge,
    ];

    pub const fn bit(self) -> u32 {
        1 << (self as u32)
    }

    /// The JSON name, as `Paused(..)` prints it.
    pub const fn name(self) -> &'static str {
        match self {
            PauseFlag::Trade => "trade",
            PauseFlag::Mint => "mint",
            PauseFlag::Transfer => "transfer",
            PauseFlag::Lend => "lend",
            PauseFlag::Liquidate => "liquidate",
            PauseFlag::Oracle => "oracle",
            PauseFlag::Pledge => "pledge",
            PauseFlag::Exit => "exit",
        }
    }

    /// The bits of `flags`, OR-ed.
    pub fn bits_of(flags: &[PauseFlag]) -> u32 {
        flags.iter().fold(0, |bits, f| bits | f.bit())
    }

    /// The flags whose bits are set in `bits`, in bit order, each once.
    pub fn of_bits(bits: u32) -> Vec<PauseFlag> {
        PauseFlag::ALL
            .into_iter()
            .filter(|f| bits & f.bit() != 0)
            .collect()
    }
}

/// 20 bytes. `since_sec` is when a flag was last set; liquidation stays off
/// until `liquidations_resume_at_sec` after `liquidate` is unpaused.
#[near(serializers = [borsh])]
#[derive(Clone, Default, Debug, PartialEq, Eq)]
pub struct PauseState {
    pub flags: u32,
    pub since_sec: u64,
    pub liquidations_resume_at_sec: u64,
}

impl PauseState {
    pub fn is_paused(&self, flag: PauseFlag) -> bool {
        self.flags & flag.bit() != 0
    }

    /// The set flags, in bit order.
    pub fn paused(&self) -> Vec<PauseFlag> {
        PauseFlag::of_bits(self.flags)
    }
}

/// `pause_state()`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PauseView {
    pub paused: Vec<PauseFlag>,
    pub since_sec: u64,
    pub liquidations_resume_at_sec: u64,
    pub guardian_id: Option<AccountId>,
    pub pending_owner_id: Option<AccountId>,
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct PausedLog<'a> {
    pub flags: &'a [PauseFlag],
    pub by: &'a AccountId,
    pub reason: &'a str,
}

impl MultiverseEvent for PausedLog<'_> {
    const NAME: &'static str = "paused";
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct UnpausedLog<'a> {
    pub flags: &'a [PauseFlag],
    pub by: &'a AccountId,
    pub liquidations_resume_at_sec: u64,
}

impl MultiverseEvent for UnpausedLog<'_> {
    const NAME: &'static str = "unpaused";
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct GuardianSet<'a> {
    pub guardian_id: Option<&'a AccountId>,
}

impl MultiverseEvent for GuardianSet<'_> {
    const NAME: &'static str = "guardian_set";
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct OwnerProposed<'a> {
    pub owner_id: &'a AccountId,
    pub pending_owner_id: Option<&'a AccountId>,
}

impl MultiverseEvent for OwnerProposed<'_> {
    const NAME: &'static str = "owner_proposed";
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct OwnerChanged<'a> {
    pub previous_owner_id: &'a AccountId,
    pub owner_id: &'a AccountId,
}

impl MultiverseEvent for OwnerChanged<'_> {
    const NAME: &'static str = "owner_changed";
}

#[near]
impl Contract {
    /// Sets `flags`. The owner may set any flag; the guardian every flag but
    /// `exit`. Takes no deposit, so the guardian's function-call key can sign
    /// it. The reason is logged, never stored.
    pub fn pause(&mut self, flags: Vec<PauseFlag>, reason: String) {
        let caller = env::predecessor_account_id();
        let by_owner = caller == self.owner_id;
        if !by_owner && self.guardian_id.as_ref() != Some(&caller) {
            fail!("NotGuardian({caller})");
        }
        if flags.is_empty() {
            fail("EmptyPauseFlags");
        }
        if !by_owner && flags.contains(&PauseFlag::Exit) {
            fail("GuardianCannotPauseExit");
        }
        if reason.len() > MAX_PAUSE_REASON_BYTES {
            fail("TextTooLong(reason)");
        }
        let bits = PauseFlag::bits_of(&flags);
        self.pause.flags |= bits;
        self.pause.since_sec = now_sec();
        PausedLog {
            flags: &PauseFlag::of_bits(bits),
            by: &caller,
            reason: &reason,
        }
        .emit();
    }

    /// Clears `flags` (owner only). Naming `lend` or `liquidate` while a
    /// legacy market's borrower index is short re-runs the index proof and is
    /// refused until it balances. Naming `liquidate` (re)starts the grace:
    /// liquidations resume `liquidation_grace_sec` (default 1,800, at most
    /// 86,400) from now; `Some(0)` ends a running grace at once.
    #[payable]
    pub fn unpause(&mut self, flags: Vec<PauseFlag>, liquidation_grace_sec: Option<u64>) {
        assert_one_yocto();
        self.assert_owner();
        if flags.is_empty() {
            fail("EmptyPauseFlags");
        }
        let names = |f: PauseFlag| flags.contains(&f);
        if (names(PauseFlag::Lend) || names(PauseFlag::Liquidate)) && self.legacy_backfill_open {
            if let Some((sid, indexed, tbs)) = self.lending_backfill_proof() {
                fail!("BorrowerBackfillIncomplete({sid}, {indexed}, {tbs})");
            }
            self.legacy_backfill_open = false;
        }
        let bits = PauseFlag::bits_of(&flags);
        self.pause.flags &= !bits;
        if names(PauseFlag::Liquidate) {
            let grace = liquidation_grace_sec
                .unwrap_or(LIQUIDATION_GRACE_SEC)
                .min(MAX_LIQUIDATION_GRACE_SEC);
            self.pause.liquidations_resume_at_sec = now_sec().saturating_add(grace);
        }
        UnpausedLog {
            flags: &PauseFlag::of_bits(bits),
            by: &env::predecessor_account_id(),
            liquidations_resume_at_sec: self.pause.liquidations_resume_at_sec,
        }
        .emit();
    }

    /// Sets or clears the guardian (owner only).
    #[payable]
    pub fn set_guardian(&mut self, guardian_id: Option<AccountId>) {
        assert_one_yocto();
        self.assert_owner();
        self.guardian_id = guardian_id;
        GuardianSet {
            guardian_id: self.guardian_id.as_ref(),
        }
        .emit();
    }

    /// First step of an owner transfer (owner only): `owner_id` becomes the
    /// pending owner until it calls `accept_owner`; `None` cancels.
    #[payable]
    pub fn propose_owner(&mut self, owner_id: Option<AccountId>) {
        assert_one_yocto();
        self.assert_owner();
        if owner_id.as_ref() == Some(&env::current_account_id()) {
            fail("OwnerIsContract");
        }
        self.pending_owner_id = owner_id;
        OwnerProposed {
            owner_id: &self.owner_id,
            pending_owner_id: self.pending_owner_id.as_ref(),
        }
        .emit();
    }

    /// Second step: the pending owner takes over. The yoctoNEAR proves a
    /// full-access key.
    #[payable]
    pub fn accept_owner(&mut self) {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        let Some(pending) = self.pending_owner_id.clone() else {
            fail("NoPendingOwner");
        };
        if caller != pending {
            fail!("NotPendingOwner({caller})");
        }
        let previous = std::mem::replace(&mut self.owner_id, caller);
        self.pending_owner_id = None;
        OwnerChanged {
            previous_owner_id: &previous,
            owner_id: &self.owner_id,
        }
        .emit();
    }

    pub fn pause_state(&self) -> PauseView {
        PauseView {
            paused: self.pause.paused(),
            since_sec: self.pause.since_sec,
            liquidations_resume_at_sec: self.pause.liquidations_resume_at_sec,
            guardian_id: self.guardian_id.clone(),
            pending_owner_id: self.pending_owner_id.clone(),
        }
    }
}

impl Contract {
    /// Fails `Paused(<flag>)` while `flag` is set.
    pub(crate) fn assert_live(&self, flag: PauseFlag) {
        if self.pause.is_paused(flag) {
            fail!("Paused({})", flag.name());
        }
    }

    /// Whether liquidations are off: the `liquidate` flag is set or the grace
    /// after its unpause is still running. `liquidation_status` reads
    /// `paused` then.
    pub(crate) fn liquidations_paused(&self) -> bool {
        self.pause.is_paused(PauseFlag::Liquidate)
            || now_sec() < self.pause.liquidations_resume_at_sec
    }

    /// The pause part of a liquidation, in order: `Paused(liquidate)`, then
    /// `LiquidationGrace(resume_at)` while the grace after an unpause runs,
    /// then `Paused(trade)` when the seized pieces are to be sold for cash.
    pub(crate) fn liquidation_gate(&self, receive: Receive) {
        self.assert_live(PauseFlag::Liquidate);
        let resume_at = self.pause.liquidations_resume_at_sec;
        if now_sec() < resume_at {
            fail!("LiquidationGrace({resume_at})");
        }
        if receive == Receive::Cash {
            self.assert_live(PauseFlag::Trade);
        }
    }
}
