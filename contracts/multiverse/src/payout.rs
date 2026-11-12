//! Real wNEAR/USDC going out. Callers finish every state change first, then
//! call `payout`, which sends whole token units with `ft_transfer` and keeps
//! the sub-unit remainder in the internal balance. If the transfer fails
//! (typically: the receiver is not registered with the token), `on_payout`
//! puts the amount back into the internal balance, from where `withdraw` can
//! try again. Nothing is ever re-minted.

use near_sdk::json_types::U128;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, AccountId, Gas, NearToken, PromiseResult,
};

use crate::errors::fail;
use crate::events::{MultiverseEvent, PayoutFailed, RealWithdraw};
use crate::types::Asset;
use crate::{Contract, ContractExt};

pub const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);
pub const GAS_FOR_ON_PAYOUT: Gas = Gas::from_tgas(5);

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near]
impl Contract {
    /// Withdraws `amount` (internal units) of the caller's internal real
    /// balance to their wallet. Below one token unit nothing is sent.
    #[payable]
    pub fn withdraw(&mut self, asset: Asset, amount: U128) {
        assert_one_yocto();
        if amount.0 == 0 {
            fail("ZeroAmount");
        }
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        self.real_debit(&account, asset, amount.0);
        RealWithdraw {
            account_id: &account,
            asset,
            amount,
        }
        .emit();
        self.payout(&account, asset, amount.0);
        self.charge_storage(&account, before);
    }

    /// Callback of `payout`. Must not panic, or the re-credit would be lost.
    #[private]
    pub fn on_payout(&mut self, account_id: AccountId, asset: Asset, amount: U128) -> bool {
        match env::promise_result(0) {
            PromiseResult::Successful(_) => true,
            PromiseResult::Failed => {
                let before = env::storage_usage();
                // amount * scale cannot overflow: it came from an internal amount / scale.
                let credited = amount.0.saturating_mul(self.scale(asset));
                let balance = self
                    .real_balance(&account_id, asset)
                    .saturating_add(credited);
                self.real.insert((account_id.clone(), asset), balance);
                PayoutFailed {
                    account_id: &account_id,
                    asset,
                    token_amount: amount,
                    credited: U128(credited),
                }
                .emit();
                self.charge_storage_in_callback(&account_id, before);
                false
            }
        }
    }

    pub fn real_balance_of(&self, account_id: AccountId, asset: Asset) -> U128 {
        U128(self.real_balance(&account_id, asset))
    }
}

impl Contract {
    /// Sends `internal_amount` of `asset` to `account`: whole token units by
    /// `ft_transfer` (1 yoctoNEAR attached, as NEP-141 requires), the
    /// remainder below one token unit back to the internal balance at once.
    pub(crate) fn payout(&mut self, account: &AccountId, asset: Asset, internal_amount: u128) {
        let scale = self.scale(asset);
        let token_amount = internal_amount / scale;
        let dust = internal_amount % scale;
        self.real_credit(account, asset, dust);
        if token_amount == 0 {
            return;
        }
        let token = self.asset_cfg(asset).token_id.clone();
        ext_ft::ext(token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(account.clone(), U128(token_amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_PAYOUT)
                    .on_payout(account.clone(), asset, U128(token_amount)),
            );
    }
}
