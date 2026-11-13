//! Operations: the granular pause.
//!
//! Eight flags, each stopping one group of actions. Every entry point checks
//! its flag right after
//! `assert_one_yocto`, before any access or argument check, so a paused action
//! always fails `Paused(<flag>)` first; `ft_on_transfer` leaves the check to
//! `dispatch`, so a paused action panics and the token refunds in full.
//! Repay, collateral top-ups, plain deposits, storage deposits, owner
//! setters, callbacks and views are never paused.

use near_sdk::near;

use crate::receiver::Receive;
use crate::{now_sec, Contract};

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
        PauseFlag::ALL
            .into_iter()
            .filter(|f| self.is_paused(*f))
            .collect()
    }
}

impl Contract {
    /// Fails `Paused(<flag>)` while `flag` is set.
    pub(crate) fn assert_live(&self, flag: PauseFlag) {
        if self.pause.is_paused(flag) {
            fail!("Paused({})", flag.name());
        }
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
