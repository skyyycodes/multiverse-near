//! Test token for the Multiverse Lending demo on NEAR testnet.
//!
//! NEP-141 core and events, NEP-145 storage management and NEP-148 metadata come from
//! near-contract-standards. On top of that, `mint` is an open faucet: anyone may mint up to
//! `max_mint_per_call` base units to any registered account. An account minting to itself, or the
//! owner minting to anyone, also registers an unregistered receiver on the spot, with this
//! contract paying the storage stake. Testnet only.

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::store::LookupSet;
use near_sdk::{
    assert_one_yocto, env, log, near, require, AccountId, BorshStorageKey, NearToken,
    PanicOnDefault, PromiseOrValue,
};

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    FungibleToken,
    Metadata,
    Sponsored,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct FaucetConfig {
    pub owner_id: AccountId,
    pub max_mint_per_call: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    owner_id: AccountId,
    max_mint_per_call: u128,
    /// Accounts that `mint` registered, i.e. whose storage stake this contract paid.
    sponsored: LookupSet<AccountId>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner_id: AccountId,
        name: String,
        symbol: String,
        decimals: u8,
        max_mint_per_call: U128,
    ) -> Self {
        require!(
            max_mint_per_call.0 > 0,
            "max_mint_per_call must be positive"
        );
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name,
            symbol,
            icon: None,
            reference: None,
            reference_hash: None,
            decimals,
        };
        metadata.assert_valid();
        Self {
            token: FungibleToken::new(StorageKey::FungibleToken),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            owner_id,
            max_mint_per_call: max_mint_per_call.0,
            sponsored: LookupSet::new(StorageKey::Sponsored),
        }
    }

    /// Open faucet. Takes no deposit, so a function-call access key can call it too.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(amount.0 > 0, "amount must be positive");
        require!(
            amount.0 <= self.max_mint_per_call,
            format!(
                "amount {} is above the per-call cap of {}",
                amount.0, self.max_mint_per_call
            )
        );
        if !self.token.accounts.contains_key(&account_id) {
            // Sponsoring any account id would let one caller register thousands of names
            // at this contract's expense; a fresh account must ask for itself.
            let caller = env::predecessor_account_id();
            require!(
                caller == account_id || caller == self.owner_id,
                format!("{account_id} is not registered: call storage_deposit, or mint to yourself")
            );
            self.token.internal_register_account(&account_id);
            self.sponsored.insert(account_id.clone());
        }
        self.token.internal_deposit(&account_id, amount.0);
        FtMint {
            owner_id: &account_id,
            amount,
            memo: Some("faucet"),
        }
        .emit();
    }

    #[payable]
    pub fn set_max_mint_per_call(&mut self, max_mint_per_call: U128) {
        assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.owner_id,
            "only the owner can change the mint cap"
        );
        require!(
            max_mint_per_call.0 > 0,
            "max_mint_per_call must be positive"
        );
        self.max_mint_per_call = max_mint_per_call.0;
    }

    pub fn faucet_config(&self) -> FaucetConfig {
        FaucetConfig {
            owner_id: self.owner_id.clone(),
            max_mint_per_call: U128(self.max_mint_per_call),
        }
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            log!("Account @{} burned {}", sender_id, burned);
        }
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        if !self.sponsored.contains(&account_id) {
            return match self.token.internal_storage_unregister(force) {
                Some((account_id, balance)) => {
                    emit_closed(&account_id, balance);
                    true
                }
                None => false,
            };
        }
        // The faucet paid this account's stake, so nothing is refunded. The standard path refunds
        // the stake to the caller, which would let anyone drain this contract by minting dust to
        // fresh accounts and unregistering them.
        let balance = self.token.accounts.get(&account_id).unwrap_or(0);
        require!(
            balance == 0 || force.unwrap_or(false),
            "Can't unregister the account with the positive balance without force"
        );
        self.token.accounts.remove(&account_id);
        self.token.total_supply -= balance;
        self.sponsored.remove(&account_id);
        emit_closed(&account_id, balance);
        true
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().unwrap()
    }
}

fn emit_closed(account_id: &AccountId, balance: u128) {
    if balance > 0 {
        FtBurn {
            owner_id: account_id,
            amount: U128(balance),
            memo: Some("storage_unregister"),
        }
        .emit();
    }
    log!("Closed @{} with {}", account_id, balance);
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{accounts, get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, Gas, PromiseResult};

    // 1,000,000 tokens at 6 decimals.
    const CAP: u128 = 1_000_000_000_000;

    fn token_id() -> AccountId {
        "usdc.multiverse-lending.testnet".parse().unwrap()
    }

    fn owner() -> AccountId {
        accounts(0)
    }

    fn as_caller(predecessor: AccountId, deposit: NearToken) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(token_id())
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .attached_deposit(deposit);
        testing_env!(builder.build());
    }

    fn setup() -> Contract {
        as_caller(owner(), NearToken::from_yoctonear(0));
        Contract::new(owner(), "Mock USD Coin".into(), "USDC".into(), 6, U128(CAP))
    }

    fn one_yocto() -> NearToken {
        NearToken::from_yoctonear(1)
    }

    fn transfers() -> Vec<(AccountId, NearToken)> {
        get_created_receipts()
            .into_iter()
            .flat_map(|r| {
                let to = r.receiver_id.clone();
                r.actions.into_iter().filter_map(move |a| match a {
                    MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit)),
                    _ => None,
                })
            })
            .collect()
    }

    #[test]
    fn new_sets_metadata_and_faucet_config() {
        let contract = setup();
        let meta = contract.ft_metadata();
        assert_eq!(meta.spec, FT_METADATA_SPEC);
        assert_eq!(meta.name, "Mock USD Coin");
        assert_eq!(meta.symbol, "USDC");
        assert_eq!(meta.decimals, 6);
        assert_eq!(contract.ft_total_supply().0, 0);
        assert_eq!(
            contract.faucet_config(),
            FaucetConfig {
                owner_id: owner(),
                max_mint_per_call: U128(CAP)
            }
        );
    }

    #[test]
    #[should_panic(expected = "max_mint_per_call must be positive")]
    fn new_rejects_a_zero_cap() {
        as_caller(owner(), NearToken::from_yoctonear(0));
        Contract::new(owner(), "Mock WETH".into(), "WETH".into(), 18, U128(0));
    }

    #[test]
    fn the_owner_can_mint_to_a_new_account_and_it_is_registered() {
        let mut contract = setup();
        assert!(contract.storage_balance_of(accounts(2)).is_none());

        as_caller(owner(), NearToken::from_yoctonear(0));
        contract.mint(accounts(2), U128(2_500_000));

        assert_eq!(contract.ft_balance_of(accounts(2)).0, 2_500_000);
        assert_eq!(contract.ft_total_supply().0, 2_500_000);
        let storage = contract.storage_balance_of(accounts(2)).unwrap();
        assert_eq!(storage.total, contract.storage_balance_bounds().min);
        assert_eq!(
            get_logs(),
            vec![format!(
                r#"EVENT_JSON:{{"standard":"nep141","version":"1.0.0","event":"ft_mint","data":[{{"owner_id":"{}","amount":"2500000","memo":"faucet"}}]}}"#,
                accounts(2)
            )]
        );
        assert!(transfers().is_empty(), "the faucet must not move NEAR");
    }

    #[test]
    fn minting_again_adds_to_the_balance() {
        let mut contract = setup();
        as_caller(accounts(1), NearToken::from_yoctonear(0));
        contract.mint(accounts(1), U128(CAP));
        contract.mint(accounts(1), U128(1));
        assert_eq!(contract.ft_balance_of(accounts(1)).0, CAP + 1);
        assert_eq!(contract.ft_total_supply().0, CAP + 1);
    }

    #[test]
    #[should_panic(expected = "amount 1000000000001 is above the per-call cap of 1000000000000")]
    fn mint_above_the_cap_panics() {
        let mut contract = setup();
        as_caller(accounts(1), NearToken::from_yoctonear(0));
        contract.mint(accounts(1), U128(CAP + 1));
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn mint_of_zero_panics() {
        let mut contract = setup();
        as_caller(accounts(1), NearToken::from_yoctonear(0));
        contract.mint(accounts(1), U128(0));
    }

    #[test]
    #[should_panic(expected = "Balance overflow")]
    fn mint_cannot_overflow_a_balance() {
        let mut contract = setup();
        as_caller(owner(), one_yocto());
        contract.set_max_mint_per_call(U128(u128::MAX));
        as_caller(accounts(1), NearToken::from_yoctonear(0));
        contract.mint(accounts(1), U128(u128::MAX));
        contract.mint(accounts(1), U128(1));
    }

    #[test]
    fn ft_transfer_moves_tokens_between_registered_accounts() {
        let mut contract = setup();
        as_caller(owner(), NearToken::from_yoctonear(0));
        contract.mint(accounts(1), U128(1_000));
        contract.mint(accounts(2), U128(1));

        as_caller(accounts(1), one_yocto());
        contract.ft_transfer(accounts(2), U128(400), Some("rent".into()));

        assert_eq!(contract.ft_balance_of(accounts(1)).0, 600);
        assert_eq!(contract.ft_balance_of(accounts(2)).0, 401);
        assert_eq!(contract.ft_total_supply().0, 1_001);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn ft_transfer_requires_one_yocto() {
        let mut contract = setup();
        as_caller(owner(), NearToken::from_yoctonear(0));
        contract.mint(accounts(1), U128(1_000));
        contract.mint(accounts(2), U128(1));
        contract.ft_transfer(accounts(2), U128(400), None);
    }

    // ft_transfer_call debits the sender up front; ft_resolve_transfer then gives back whatever the
    // receiver reports as unused. The scripts rely on the returned "used" amount to spot a refund.
    fn transfer_call_then_resolve(receiver_answer: PromiseResult) -> (Contract, U128) {
        let mut contract = setup();
        as_caller(owner(), NearToken::from_yoctonear(0));
        contract.mint(accounts(1), U128(1_000));
        contract.mint(accounts(3), U128(1));

        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(token_id())
            .signer_account_id(accounts(1))
            .predecessor_account_id(accounts(1))
            .attached_deposit(one_yocto())
            .prepaid_gas(Gas::from_tgas(100));
        testing_env!(builder.build());
        contract.ft_transfer_call(accounts(3), U128(400), None, "deposit".into());
        assert_eq!(contract.ft_balance_of(accounts(1)).0, 600);
        assert_eq!(contract.ft_balance_of(accounts(3)).0, 401);

        builder
            .predecessor_account_id(token_id())
            .attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(
            builder.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![receiver_answer]
        );
        let used = contract.ft_resolve_transfer(accounts(1), accounts(3), U128(400));
        (contract, used)
    }

    #[test]
    fn ft_transfer_call_refunds_what_the_receiver_did_not_use() {
        let unused = near_sdk::serde_json::to_vec(&U128(150)).unwrap();
        let (contract, used) = transfer_call_then_resolve(PromiseResult::Successful(unused));
        assert_eq!(used.0, 250);
        assert_eq!(contract.ft_balance_of(accounts(1)).0, 750);
        assert_eq!(contract.ft_balance_of(accounts(3)).0, 251);
        assert_eq!(contract.ft_total_supply().0, 1_001);
    }

    #[test]
    fn ft_transfer_call_refunds_everything_when_the_receiver_fails() {
        let (contract, used) = transfer_call_then_resolve(PromiseResult::Failed);
        assert_eq!(used.0, 0);
        assert_eq!(contract.ft_balance_of(accounts(1)).0, 1_000);
        assert_eq!(contract.ft_balance_of(accounts(3)).0, 1);
    }

    #[test]
    #[should_panic(expected = "is not registered")]
    fn ft_transfer_to_an_unregistered_account_panics() {
        let mut contract = setup();
        as_caller(accounts(1), NearToken::from_yoctonear(0));
        contract.mint(accounts(1), U128(1_000));
        as_caller(accounts(1), one_yocto());
        contract.ft_transfer(accounts(3), U128(400), None);
    }

    #[test]
    fn storage_deposit_registers_at_the_minimum() {
        let mut contract = setup();
        let min = contract.storage_balance_bounds().min;
        assert_eq!(
            min,
            NearToken::from_yoctonear(1_250_000_000_000_000_000_000)
        );

        as_caller(accounts(1), min);
        let balance = contract.storage_deposit(Some(accounts(4)), None);
        assert_eq!(balance.total, min);
        assert_eq!(contract.ft_balance_of(accounts(4)).0, 0);
    }

    #[test]
    #[should_panic(expected = "The attached deposit is less than the minimum storage balance")]
    fn storage_deposit_below_the_minimum_panics() {
        let mut contract = setup();
        let min = contract.storage_balance_bounds().min;
        as_caller(accounts(1), min.saturating_sub(one_yocto()));
        contract.storage_deposit(None, None);
    }

    #[test]
    fn unregistering_a_self_paid_account_refunds_its_deposit() {
        let mut contract = setup();
        let min = contract.storage_balance_bounds().min;
        as_caller(accounts(1), min);
        contract.storage_deposit(None, None);
        // A later faucet mint must not turn the account into a sponsored one.
        as_caller(owner(), NearToken::from_yoctonear(0));
        contract.mint(accounts(1), U128(5));

        as_caller(accounts(1), one_yocto());
        assert!(contract.storage_unregister(Some(true)));
        assert_eq!(
            transfers(),
            vec![(accounts(1), min.saturating_add(one_yocto()))]
        );
        assert!(contract.storage_balance_of(accounts(1)).is_none());
        assert_eq!(contract.ft_total_supply().0, 0);
    }

    #[test]
    fn unregistering_a_faucet_account_refunds_nothing() {
        let mut contract = setup();
        as_caller(owner(), NearToken::from_yoctonear(0));
        contract.mint(accounts(1), U128(7));

        as_caller(accounts(1), one_yocto());
        assert!(contract.storage_unregister(Some(true)));
        assert!(transfers().is_empty());
        assert!(contract.storage_balance_of(accounts(1)).is_none());
        assert_eq!(contract.ft_total_supply().0, 0);
        assert_eq!(
            get_logs(),
            vec![
                format!(
                    r#"EVENT_JSON:{{"standard":"nep141","version":"1.0.0","event":"ft_burn","data":[{{"owner_id":"{}","amount":"7","memo":"storage_unregister"}}]}}"#,
                    accounts(1)
                ),
                format!("Closed @{} with 7", accounts(1)),
            ]
        );

        // Registering again through the faucet works and is sponsored again.
        as_caller(owner(), NearToken::from_yoctonear(0));
        contract.mint(accounts(1), U128(1));
        assert_eq!(contract.ft_balance_of(accounts(1)).0, 1);
    }

    #[test]
    #[should_panic(
        expected = "Can't unregister the account with the positive balance without force"
    )]
    fn unregistering_with_a_balance_needs_force() {
        let mut contract = setup();
        as_caller(owner(), NearToken::from_yoctonear(0));
        contract.mint(accounts(1), U128(7));
        as_caller(accounts(1), one_yocto());
        contract.storage_unregister(None);
    }

    #[test]
    fn unregistering_an_unknown_account_returns_false() {
        let mut contract = setup();
        as_caller(accounts(5), one_yocto());
        assert!(!contract.storage_unregister(None));
    }

    #[test]
    fn owner_can_change_the_cap() {
        let mut contract = setup();
        as_caller(owner(), one_yocto());
        contract.set_max_mint_per_call(U128(10));
        assert_eq!(contract.faucet_config().max_mint_per_call, U128(10));
    }

    #[test]
    #[should_panic(expected = "only the owner can change the mint cap")]
    fn only_the_owner_can_change_the_cap() {
        let mut contract = setup();
        as_caller(accounts(1), one_yocto());
        contract.set_max_mint_per_call(U128(10));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn changing_the_cap_requires_one_yocto() {
        let mut contract = setup();
        as_caller(owner(), NearToken::from_yoctonear(0));
        contract.set_max_mint_per_call(U128(10));
    }

    #[test]
    #[should_panic(expected = "is not registered: call storage_deposit, or mint to yourself")]
    fn mint_does_not_sponsor_accounts_for_strangers() {
        let mut contract = setup();
        as_caller("griefer.testnet".parse().unwrap(), NearToken::from_yoctonear(0));
        contract.mint("x0.griefer.testnet".parse().unwrap(), U128(1));
    }

    #[test]
    fn mint_sponsors_the_caller_itself_and_the_owners_recipients() {
        let mut contract = setup();
        as_caller(accounts(1), NearToken::from_yoctonear(0));
        contract.mint(accounts(1), U128(5));
        as_caller(owner(), NearToken::from_yoctonear(0));
        contract.mint(accounts(2), U128(5));
        // Both are registered now, so anyone may top them up.
        as_caller(accounts(3), NearToken::from_yoctonear(0));
        contract.mint(accounts(2), U128(5));
        assert_eq!(contract.ft_balance_of(accounts(2)).0, 10);
        assert!(contract.storage_balance_of(accounts(1)).is_some());
    }
}
