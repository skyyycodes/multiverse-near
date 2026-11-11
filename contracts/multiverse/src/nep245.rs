//! NEP-245 multi token core, enumeration and metadata over the verse ledger.
//! Token ids are `"{scenario}:{asset}:{mask}"`; every verse token has 18
//! decimals, because amounts are internal units.
//!
//! Transfers need exactly 1 yoctoNEAR, have no liveness check (a dead verse
//! still moves), and the receiver must be registered for storage. The sender
//! pays for any storage the transfer adds. Approval management is not
//! implemented, so any non-null approval panics.

use near_sdk::json_types::U128;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, serde_json, AccountId, Gas, PromiseOrValue,
    PromiseResult,
};

use crate::errors::fail;
use crate::masks;
use crate::types::VerseKey;
use crate::{Contract, ContractExt};

pub type TokenId = String;

/// Base gas for `mt_resolve_transfer`, plus `GAS_PER_RESOLVED_TOKEN` per token.
pub const GAS_FOR_MT_RESOLVE_TRANSFER: Gas = Gas::from_tgas(10);
pub const GAS_PER_RESOLVED_TOKEN: Gas = Gas::from_tgas(1);
/// Kept back for `mt_transfer_call` itself after the receiver's share.
pub const GAS_FOR_MT_TRANSFER_CALL: Gas = Gas::from_tgas(25);

pub const MT_METADATA_SPEC: &str = "mt-1.0.0";
pub const VERSE_DECIMALS: u8 = 18;

/// `[owner_id, approval_id]` in JSON.
pub type Approval = (AccountId, u64);
/// `[owner_id, approval_id, amount]` per approved account, as the resolver
/// would restore them if approvals existed.
pub type ResolvedApprovals = Option<Vec<Option<Vec<(AccountId, u64, U128)>>>>;

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    pub token_id: TokenId,
    /// Verse tokens are fungible, so there is no single owner.
    pub owner_id: Option<AccountId>,
    /// Metadata extension: each token is its own base metadata.
    pub base_metadata_id: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MtContractMetadata {
    pub spec: String,
    pub name: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MtBaseTokenMetadata {
    pub name: String,
    pub id: String,
    pub symbol: Option<String>,
    pub icon: Option<String>,
    /// A string in the standard.
    pub decimals: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub copies: Option<u64>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MtTokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MtTokenMetadataAll {
    pub base: MtBaseTokenMetadata,
    pub token: MtTokenMetadata,
}

#[ext_contract(ext_mt_receiver)]
pub trait MultiTokenReceiver {
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>>;
}

#[near]
impl Contract {
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        amount: U128,
        approval: Option<Approval>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        if approval.is_some() {
            fail("ApprovalsNotSupported");
        }
        let sender_id = env::predecessor_account_id();
        self.mt_internal_transfer(
            &sender_id,
            &receiver_id,
            &[token_id],
            &[amount],
            memo.as_deref(),
        );
    }

    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<Approval>>>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        check_no_approvals(&approvals, token_ids.len());
        let sender_id = env::predecessor_account_id();
        self.mt_internal_transfer(
            &sender_id,
            &receiver_id,
            &token_ids,
            &amounts,
            memo.as_deref(),
        );
    }

    #[payable]
    pub fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        amount: U128,
        approval: Option<Approval>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        assert_one_yocto();
        if approval.is_some() {
            fail("ApprovalsNotSupported");
        }
        self.mt_internal_transfer_call(receiver_id, vec![token_id], vec![amount], memo, msg)
    }

    #[payable]
    pub fn mt_batch_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<Approval>>>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        assert_one_yocto();
        check_no_approvals(&approvals, token_ids.len());
        self.mt_internal_transfer_call(receiver_id, token_ids, amounts, memo, msg)
    }

    /// Ends an `mt_transfer_call`: moves back what the receiver reported as
    /// unused (everything if it failed or answered garbage), capped by what it
    /// still holds, and returns the amounts it kept. Never panics.
    #[private]
    pub fn mt_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        approvals: ResolvedApprovals,
    ) -> Vec<U128> {
        // Approvals are never issued, so there is nothing to restore.
        drop(approvals);
        let unused: Vec<u128> = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => match serde_json::from_slice::<Vec<U128>>(&bytes) {
                Ok(v) if v.len() == amounts.len() => {
                    v.iter().zip(&amounts).map(|(u, a)| u.0.min(a.0)).collect()
                }
                _ => amounts.iter().map(|a| a.0).collect(),
            },
            PromiseResult::Failed => amounts.iter().map(|a| a.0).collect(),
        };

        // The same id may appear twice in a batch, so track what the receiver
        // has left while deciding each refund.
        let mut refunds: Vec<(VerseKey, u128)> = Vec::new();
        let mut used = Vec::with_capacity(amounts.len());
        for ((token_id, amount), unused) in token_ids.iter().zip(&amounts).zip(unused) {
            let refund = match VerseKey::parse(token_id) {
                Some(key) => {
                    let already: u128 = refunds
                        .iter()
                        .filter(|(k, _)| *k == key)
                        .map(|(_, r)| r)
                        .sum();
                    let left = self
                        .verse_balance(&receiver_id, &key)
                        .saturating_sub(already);
                    let refund = unused.min(left);
                    if refund > 0 {
                        refunds.push((key, refund));
                    }
                    refund
                }
                None => 0,
            };
            used.push(U128(amount.0 - refund));
        }
        self.transfer_verse(&receiver_id, &sender_id, &refunds, Some("refund"));
        used
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: TokenId) -> U128 {
        U128(VerseKey::parse(&token_id).map_or(0, |k| self.verse_balance(&account_id, &k)))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<TokenId>) -> Vec<U128> {
        token_ids
            .iter()
            .map(|id| U128(VerseKey::parse(id).map_or(0, |k| self.verse_balance(&account_id, &k))))
            .collect()
    }

    /// `null` for a token that was never minted or registered.
    pub fn mt_supply(&self, token_id: TokenId) -> Option<U128> {
        self.supply_of_id(&token_id)
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<TokenId>) -> Vec<Option<U128>> {
        token_ids.iter().map(|id| self.supply_of_id(id)).collect()
    }

    pub fn mt_token(&self, token_ids: Vec<TokenId>) -> Vec<Option<Token>> {
        token_ids
            .into_iter()
            .map(|id| {
                VerseKey::parse(&id)
                    .filter(|k| self.is_created(k))
                    .map(|k| token_of(&k))
            })
            .collect()
    }

    /// Enumeration: every token that exists, in (scenario, asset, mask) order.
    pub fn mt_tokens(&self, from_index: Option<U128>, limit: Option<u32>) -> Vec<Token> {
        let keys = self.verse_keys().filter(|k| self.is_created(k));
        page(keys, from_index, limit)
    }

    /// Enumeration: the tokens `account_id` holds a non-zero balance of, in
    /// (scenario, asset, mask) order.
    pub fn mt_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u32>,
    ) -> Vec<Token> {
        let keys = self
            .verse_keys()
            .filter(|k| self.verse_balance(&account_id, k) > 0);
        page(keys, from_index, limit)
    }

    pub fn mt_metadata_contract(&self) -> MtContractMetadata {
        MtContractMetadata {
            spec: MT_METADATA_SPEC.to_string(),
            name: "Multiverse verse tokens".to_string(),
        }
    }

    /// Names follow the EVM tokens: `"WETH-if-DELAYED·HOLDS"`, `"USDC-if-0b1110"`.
    /// Not unique across scenarios; the id is.
    pub fn mt_metadata_base_by_token_id(
        &self,
        token_ids: Vec<TokenId>,
    ) -> Vec<MtBaseTokenMetadata> {
        token_ids
            .iter()
            .map(|id| self.base_metadata(&self.metadata_key(id)))
            .collect()
    }

    /// Base metadata ids are the token ids.
    pub fn mt_metadata_base_by_metadata_id(
        &self,
        base_metadata_ids: Vec<String>,
    ) -> Vec<MtBaseTokenMetadata> {
        self.mt_metadata_base_by_token_id(base_metadata_ids)
    }

    pub fn mt_metadata_token_by_token_id(&self, token_ids: Vec<TokenId>) -> Vec<MtTokenMetadata> {
        token_ids
            .iter()
            .map(|id| self.token_metadata(&self.metadata_key(id)))
            .collect()
    }

    pub fn mt_metadata_token_all(&self, token_ids: Vec<TokenId>) -> Vec<MtTokenMetadataAll> {
        token_ids
            .iter()
            .map(|id| {
                let key = self.metadata_key(id);
                MtTokenMetadataAll {
                    base: self.base_metadata(&key),
                    token: self.token_metadata(&key),
                }
            })
            .collect()
    }
}

impl Contract {
    fn supply_of_id(&self, token_id: &str) -> Option<U128> {
        let key = VerseKey::parse(token_id)?;
        self.is_created(&key).then(|| U128(self.verse_supply(&key)))
    }

    fn mt_internal_transfer(
        &mut self,
        sender_id: &AccountId,
        receiver_id: &AccountId,
        token_ids: &[TokenId],
        amounts: &[U128],
        memo: Option<&str>,
    ) {
        if token_ids.len() != amounts.len() {
            fail!("LengthMismatch({}, {})", token_ids.len(), amounts.len());
        }
        if token_ids.is_empty() {
            fail("EmptyBatch");
        }
        if sender_id == receiver_id {
            fail!("SelfTransfer({sender_id})");
        }
        // Tokens sent to the contract's own account could never move again.
        if *receiver_id == env::current_account_id() {
            fail!("ReceiverIsContract({receiver_id})");
        }
        self.assert_registered(receiver_id);
        let items: Vec<(VerseKey, u128)> = token_ids
            .iter()
            .zip(amounts)
            .map(|(id, amount)| {
                let key = VerseKey::parse(id).unwrap_or_else(|| fail!("InvalidTokenId({id})"));
                if amount.0 == 0 {
                    fail("ZeroAmount");
                }
                (key, amount.0)
            })
            .collect();
        let before = env::storage_usage();
        self.transfer_verse(sender_id, receiver_id, &items, memo);
        self.charge_storage(sender_id, before);
    }

    fn mt_internal_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        let resolve_gas = GAS_FOR_MT_RESOLVE_TRANSFER.saturating_add(Gas::from_gas(
            GAS_PER_RESOLVED_TOKEN
                .as_gas()
                .saturating_mul(token_ids.len() as u64),
        ));
        let reserved = resolve_gas.saturating_add(GAS_FOR_MT_TRANSFER_CALL);
        if env::prepaid_gas() <= reserved {
            fail!(
                "NotEnoughGas({}, {})",
                env::prepaid_gas().as_gas(),
                reserved.as_gas()
            );
        }
        let sender_id = env::predecessor_account_id();
        self.mt_internal_transfer(
            &sender_id,
            &receiver_id,
            &token_ids,
            &amounts,
            memo.as_deref(),
        );
        ext_mt_receiver::ext(receiver_id.clone())
            .with_static_gas(env::prepaid_gas().saturating_sub(reserved))
            .mt_on_transfer(
                sender_id.clone(),
                vec![sender_id.clone(); token_ids.len()],
                token_ids.clone(),
                amounts.clone(),
                msg,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(resolve_gas)
                    .mt_resolve_transfer(sender_id, receiver_id, token_ids, amounts, None),
            )
            .into()
    }

    /// A token id the metadata views accept: a valid, non-root mask of an
    /// existing scenario, whether or not anything was minted yet.
    fn metadata_key(&self, token_id: &str) -> VerseKey {
        let key = VerseKey::parse(token_id).unwrap_or_else(|| fail!("InvalidTokenId({token_id})"));
        let root = self.scenario(key.scenario).root();
        masks::check_mask(key.mask, root);
        if key.mask == root {
            fail("NoTokenForRoot");
        }
        key
    }

    fn base_metadata(&self, key: &VerseKey) -> MtBaseTokenMetadata {
        let name = self.verse_name(key.scenario, key.asset, key.mask);
        MtBaseTokenMetadata {
            symbol: Some(name.clone()),
            name,
            id: key.token_id(),
            icon: None,
            decimals: Some(VERSE_DECIMALS.to_string()),
            base_uri: None,
            reference: None,
            copies: None,
            reference_hash: None,
        }
    }

    fn token_metadata(&self, key: &VerseKey) -> MtTokenMetadata {
        let symbol = &self.asset_cfg(key.asset).symbol;
        let label = self.verse_label(key.scenario, key.mask);
        MtTokenMetadata {
            title: Some(self.verse_name(key.scenario, key.asset, key.mask)),
            description: Some(format!(
                "Pays 1 {symbol} if the world that comes true is in {label} (scenario {})",
                key.scenario
            )),
            media: None,
            media_hash: None,
            issued_at: None,
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: Some(format!(
                "{{\"scenario_id\":{},\"asset\":\"{}\",\"mask\":{}}}",
                key.scenario, key.asset, key.mask
            )),
            reference: None,
            reference_hash: None,
        }
    }
}

fn token_of(key: &VerseKey) -> Token {
    let token_id = key.token_id();
    Token {
        base_metadata_id: token_id.clone(),
        token_id,
        owner_id: None,
    }
}

/// NEP-245 requires `approvals`, when given, to match `token_ids` in length.
fn check_no_approvals(approvals: &Option<Vec<Option<Approval>>>, n: usize) {
    if let Some(approvals) = approvals {
        if approvals.len() != n {
            fail!("LengthMismatch({}, {})", n, approvals.len());
        }
        if approvals.iter().any(Option::is_some) {
            fail("ApprovalsNotSupported");
        }
    }
}

fn page(
    keys: impl Iterator<Item = VerseKey>,
    from_index: Option<U128>,
    limit: Option<u32>,
) -> Vec<Token> {
    let skip = from_index.map_or(0, |i| usize::try_from(i.0).unwrap_or(usize::MAX));
    let take = limit.map_or(usize::MAX, |l| l as usize);
    keys.skip(skip).take(take).map(|k| token_of(&k)).collect()
}
