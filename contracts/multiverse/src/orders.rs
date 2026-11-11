//! Order book: limit orders on any live non-root verse of a scenario.
//!
//! A bid buys WETH-if-mask and escrows USDC-if-mask; an ask sells WETH-if-mask
//! and escrows it. Escrow leaves the maker's ledger balance and is held in the
//! order record itself. Only the USDC leg rounds: whoever pays USDC pays the
//! ceiling, whoever is paid from a bid's escrow gets the floor, so an open
//! bid always covers every fill still possible and the last fill hands the
//! rounding dust back to the maker.
//!
//! An order fills only in the epoch it was posted in (the scenario's
//! resolution count), before its expiry, while its verse is live and while no
//! proposal is open on the scenario. Posting and cancelling work at any time.
//! Closed orders stay stored with `remaining` and `escrow` at zero, for
//! `get_order`; every other read goes through the open-order indexes.

use multiverse_math::orders::{cost, proceeds};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Serialize;
use near_sdk::borsh::BorshSerialize;
use near_sdk::store::LookupMap;
use near_sdk::{assert_one_yocto, env, near, AccountId};

use crate::errors::{fail, sub};
use crate::events::MultiverseEvent;
use crate::masks;
use crate::types::{Asset, VerseKey};
use crate::{now_sec, Contract, ContractExt};

/// Whether the order book is live; served to the app by `get_app_config`.
pub const ENABLED: bool = true;

/// 0.001 WETH. Every order costs its maker storage, and dust orders would
/// only clutter the book.
pub const MIN_ORDER_AMOUNT: u128 = 1_000_000_000_000_000;

/// Smallest order notional, 0.0001 USDC. It rules out bids that escrow a
/// few wei; the EVM rounding cases (0.5 USDC per WETH on the smallest
/// order) stay valid.
pub const MIN_ORDER_VALUE: u128 = 100_000_000_000_000;

/// Open orders one maker may have across all scenarios.
pub const MAX_OPEN_ORDERS_PER_MAKER: usize = 64;

const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 200;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Bid,
    Ask,
}

impl Side {
    /// What the order escrows: USDC for a bid, WETH for an ask.
    pub fn escrow_asset(self) -> Asset {
        match self {
            Side::Bid => Asset::Usdc,
            Side::Ask => Asset::Weth,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    /// Always the user, also when the router posted it.
    pub maker: AccountId,
    /// Fills fail from this second on.
    pub expiry_sec: u64,
    /// The scenario's resolution count at post.
    pub epoch: u8,
    pub side: Side,
    pub scenario_id: u64,
    pub mask: u8,
    /// USDC per WETH, 18 decimals.
    pub price: u128,
    /// WETH size at post.
    pub amount: u128,
    /// WETH still to trade; 0 once filled or cancelled.
    pub remaining: u128,
    /// An ask holds `remaining` WETH-if-mask, a bid at least
    /// `cost(remaining, price)` USDC-if-mask.
    pub escrow: u128,
}

impl Order {
    pub fn escrow_key(&self) -> VerseKey {
        VerseKey::new(self.scenario_id, self.side.escrow_asset(), self.mask)
    }

    pub fn is_open(&self) -> bool {
        self.remaining > 0
    }

    fn view(&self, id: u64) -> OrderView {
        OrderView {
            id: U64(id),
            maker: self.maker.clone(),
            scenario_id: self.scenario_id,
            mask: self.mask,
            side: self.side,
            price: U128(self.price),
            amount: U128(self.amount),
            remaining: U128(self.remaining),
            escrow: U128(self.escrow),
            expiry_sec: self.expiry_sec,
            epoch: self.epoch,
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderView {
    pub id: U64,
    pub maker: AccountId,
    pub scenario_id: u64,
    pub mask: u8,
    pub side: Side,
    pub price: U128,
    pub amount: U128,
    pub remaining: U128,
    pub escrow: U128,
    pub expiry_sec: u64,
    pub epoch: u8,
}

/// The fillable orders of one world: best price first, oldest first on ties.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldBook {
    pub bids: Vec<OrderView>,
    pub asks: Vec<OrderView>,
}

/// `paid` is what the taker gave (WETH-if-mask into a bid, USDC-if-mask for
/// an ask), `received` the other leg.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FillResult {
    pub paid: U128,
    pub received: U128,
}

#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct OrderPosted<'a> {
    pub order_id: U64,
    pub scenario_id: u64,
    pub maker: &'a AccountId,
    pub mask: u8,
    pub side: Side,
    pub price: U128,
    pub amount: U128,
    pub expiry_sec: u64,
    pub epoch: u8,
}

impl MultiverseEvent for OrderPosted<'_> {
    const NAME: &'static str = "order_posted";
}

/// `usdc_amount` is the USDC that changed hands; `remaining` is after the fill.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct OrderFilled<'a> {
    pub order_id: U64,
    pub scenario_id: u64,
    pub taker: &'a AccountId,
    pub amount: U128,
    pub usdc_amount: U128,
    pub remaining: U128,
}

impl MultiverseEvent for OrderFilled<'_> {
    const NAME: &'static str = "order_filled";
}

/// `remaining` is what was left before the cancel.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct OrderCancelled<'a> {
    pub order_id: U64,
    pub scenario_id: u64,
    pub maker: &'a AccountId,
    pub remaining: U128,
    pub refund: U128,
}

impl MultiverseEvent for OrderCancelled<'_> {
    const NAME: &'static str = "order_cancelled";
}

#[near]
impl Contract {
    /// Posts an order for the caller, escrowing from their verse balance.
    #[payable]
    pub fn post_order(
        &mut self,
        scenario_id: u64,
        mask: u8,
        side: Side,
        price: U128,
        amount: U128,
        expiry_sec: u64,
    ) -> U64 {
        assert_one_yocto();
        let maker = env::predecessor_account_id();
        let before = env::storage_usage();
        let id = self.post_order_for(
            &maker,
            scenario_id,
            mask,
            side,
            price.0,
            amount.0,
            expiry_sec,
        );
        self.charge_storage(&maker, before);
        U64(id)
    }

    /// Takes `amount` WETH of the order. `limit_price` guards against filling
    /// a different price than the one seen: a bid must pay at least it, an
    /// ask cost at most it.
    #[payable]
    pub fn fill_order(&mut self, order_id: U64, amount: U128, limit_price: U128) -> FillResult {
        assert_one_yocto();
        let taker = env::predecessor_account_id();
        let before = env::storage_usage();
        let (paid, received) = self.fill_order_for(&taker, order_id.0, amount.0, limit_price.0);
        self.charge_storage(&taker, before);
        FillResult {
            paid: U128(paid),
            received: U128(received),
        }
    }

    /// Maker only. Returns what is left in escrow; works at any time, also
    /// after expiry, resolution or while halted.
    #[payable]
    pub fn cancel_order(&mut self, order_id: U64) -> U128 {
        assert_one_yocto();
        let maker = env::predecessor_account_id();
        let before = env::storage_usage();
        let refund = self.internal_cancel(&maker, order_id.0);
        self.charge_storage(&maker, before);
        U128(refund)
    }

    /// Any order ever posted, closed ones included; null for an unknown id.
    pub fn get_order(&self, order_id: U64) -> Option<OrderView> {
        self.orders.get(&order_id.0).map(|o| o.view(order_id.0))
    }

    pub fn order_count(&self) -> U64 {
        U64(self.order_count)
    }

    /// Orders of the scenario with something left, by id, starting at order
    /// id `from_index`. Expired and stale ones are included (only their
    /// maker can do anything with them).
    pub fn open_orders(
        &self,
        scenario_id: u64,
        from_index: Option<U64>,
        limit: Option<u32>,
    ) -> Vec<OrderView> {
        self.scenario(scenario_id);
        let from = from_index.map_or(1, |i| i.0.max(1));
        let limit = page_limit(limit);
        let ids = self.open_by_scenario.get(&scenario_id);
        ids.into_iter()
            .flatten()
            .filter(|id| **id >= from)
            .take(limit)
            .filter_map(|id| self.orders.get(id).map(|o| o.view(*id)))
            .collect()
    }

    /// The single-world book of `world`: orders that could fill right now
    /// apart from a halt (not expired, not stale, world still possible).
    /// Bids by price descending, asks ascending, oldest first on ties;
    /// `limit` applies to each side.
    pub fn orders_for_world(&self, scenario_id: u64, world: u8, limit: Option<u32>) -> WorldBook {
        let s = self.scenario(scenario_id);
        let limit = page_limit(limit);
        let now = now_sec();
        let mut bids: Vec<(u64, &Order)> = Vec::new();
        let mut asks: Vec<(u64, &Order)> = Vec::new();
        if world >= s.world_count || !masks::contains(s.possible, world) {
            return WorldBook {
                bids: Vec::new(),
                asks: Vec::new(),
            };
        }
        let ids = self.open_by_world.get(&(scenario_id, world));
        for id in ids.into_iter().flatten() {
            let Some(o) = self.orders.get(id) else {
                continue;
            };
            if !o.is_open() || now >= o.expiry_sec || o.epoch != s.resolution_count {
                continue;
            }
            match o.side {
                Side::Bid => bids.push((*id, o)),
                Side::Ask => asks.push((*id, o)),
            }
        }
        bids.sort_by(|(ia, a), (ib, b)| b.price.cmp(&a.price).then(ia.cmp(ib)));
        asks.sort_by(|(ia, a), (ib, b)| a.price.cmp(&b.price).then(ia.cmp(ib)));
        let views = |v: Vec<(u64, &Order)>| -> Vec<OrderView> {
            v.into_iter()
                .take(limit)
                .map(|(id, o)| o.view(id))
                .collect()
        };
        WorldBook {
            bids: views(bids),
            asks: views(asks),
        }
    }

    /// The account's open orders in the scenario, by id.
    pub fn orders_by_maker(&self, account_id: AccountId, scenario_id: u64) -> Vec<OrderView> {
        if !self.has_open_orders(&account_id) {
            return Vec::new();
        }
        let ids = self.open_by_scenario.get(&scenario_id);
        ids.into_iter()
            .flatten()
            .filter_map(|id| self.orders.get(id).map(|o| (*id, o)))
            .filter(|(_, o)| o.maker == account_id)
            .map(|(id, o)| o.view(id))
            .collect()
    }
}

impl Contract {
    /// Posts for `maker`, escrowing from `maker`'s ledger balance. The caller
    /// charges storage. Returns the new order id.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn post_order_for(
        &mut self,
        maker: &AccountId,
        scenario_id: u64,
        mask: u8,
        side: Side,
        price: u128,
        amount: u128,
        expiry_sec: u64,
    ) -> u64 {
        if amount == 0 {
            fail("ZeroAmount");
        }
        if amount < MIN_ORDER_AMOUNT {
            fail!("OrderTooSmall({amount}, {MIN_ORDER_AMOUNT})");
        }
        if price == 0 {
            fail("ZeroPrice");
        }
        let notional = cost(amount, price);
        if notional < MIN_ORDER_VALUE {
            fail!("OrderValueTooSmall({notional}, {MIN_ORDER_VALUE})");
        }
        if expiry_sec <= now_sec() {
            fail!("ExpiryInPast({expiry_sec})");
        }
        let s = self.scenario(scenario_id);
        let root = s.root();
        if mask == 0 || mask == root || !masks::is_subset(mask, root) {
            fail!("InvalidMask({mask})");
        }
        if !s.is_live(mask) {
            fail!("DeadVerse({mask})");
        }
        let epoch = s.resolution_count;

        if self.open_order_count(maker) >= MAX_OPEN_ORDERS_PER_MAKER {
            fail!("TooManyOpenOrders({MAX_OPEN_ORDERS_PER_MAKER})");
        }

        let escrow = match side {
            Side::Ask => amount,
            Side::Bid => notional,
        };
        self.order_count += 1;
        let id = self.order_count;
        let order = Order {
            maker: maker.clone(),
            expiry_sec,
            epoch,
            side,
            scenario_id,
            mask,
            price,
            amount,
            remaining: amount,
            escrow,
        };
        let key = order.escrow_key();
        self.orders.insert(id, order);
        if masks::is_single_world(mask) {
            self.open_by_world
                .entry((scenario_id, masks::lowest_world(mask)))
                .or_default()
                .push(id);
        }
        self.open_by_scenario
            .entry(scenario_id)
            .or_default()
            .push(id);
        self.count_open_order(maker, true);
        OrderPosted {
            order_id: U64(id),
            scenario_id,
            maker,
            mask,
            side,
            price: U128(price),
            amount: U128(amount),
            expiry_sec,
            epoch,
        }
        .emit();
        self.take_into_custody(maker, &[(key, escrow)], None);
        id
    }

    /// Fills for `taker`, who pays from and is paid into their ledger
    /// balance. The caller charges storage. Returns `(paid, received)`.
    pub(crate) fn fill_order_for(
        &mut self,
        taker: &AccountId,
        order_id: u64,
        amount: u128,
        limit_price: u128,
    ) -> (u128, u128) {
        if amount == 0 {
            fail("ZeroAmount");
        }
        let mut o = match self.orders.get(&order_id) {
            Some(o) if o.is_open() => o.clone(),
            _ => fail!("OrderNotOpen({order_id})"),
        };
        if amount > o.remaining {
            fail!(
                "AmountExceedsRemaining({order_id}, {amount}, {})",
                o.remaining
            );
        }
        if now_sec() >= o.expiry_sec {
            fail!("OrderExpired({order_id}, {})", o.expiry_sec);
        }
        let s = self.scenario(o.scenario_id);
        // a dead verse is reported before a stale epoch
        if !s.is_live(o.mask) {
            fail!("DeadVerse({})", o.mask);
        }
        if s.resolution_count != o.epoch {
            fail!(
                "StaleOrder({order_id}, {}, {})",
                o.epoch,
                s.resolution_count
            );
        }
        if self.halted(s) {
            fail!("ScenarioHalted({})", o.scenario_id);
        }
        let beyond = match o.side {
            Side::Bid => o.price < limit_price,
            Side::Ask => o.price > limit_price,
        };
        if beyond {
            fail!("PriceBeyondLimit({order_id}, {}, {limit_price})", o.price);
        }

        let weth = VerseKey::new(o.scenario_id, Asset::Weth, o.mask);
        let usdc = VerseKey::new(o.scenario_id, Asset::Usdc, o.mask);
        o.remaining -= amount;
        let (paid, received, usdc_amount, refund) = match o.side {
            Side::Bid => {
                let received = proceeds(amount, o.price);
                if received == 0 {
                    fail("ZeroValue");
                }
                o.escrow = sub(o.escrow, received);
                // the last fill returns the rounding dust to the maker
                let refund = if o.remaining == 0 {
                    std::mem::take(&mut o.escrow)
                } else {
                    0
                };
                (amount, received, received, refund)
            }
            Side::Ask => {
                let paid = cost(amount, o.price);
                o.escrow = sub(o.escrow, amount);
                (paid, amount, paid, 0)
            }
        };
        let maker = o.maker.clone();
        let (scenario_id, side, closed) = (o.scenario_id, o.side, o.remaining == 0);
        let remaining = o.remaining;
        if closed {
            self.unindex(order_id, &o);
        }
        self.orders.insert(order_id, o);
        OrderFilled {
            order_id: U64(order_id),
            scenario_id,
            taker,
            amount: U128(amount),
            usdc_amount: U128(usdc_amount),
            remaining: U128(remaining),
        }
        .emit();
        match side {
            Side::Bid => {
                self.transfer_verse(taker, &maker, &[(weth, amount)], None);
                self.release_from_custody(taker, &[(usdc, received)], None);
                if refund > 0 {
                    self.release_from_custody(&maker, &[(usdc, refund)], None);
                }
            }
            Side::Ask => {
                self.transfer_verse(taker, &maker, &[(usdc, paid)], None);
                self.release_from_custody(taker, &[(weth, amount)], None);
            }
        }
        (paid, received)
    }

    /// The router's read of an order.
    pub fn order(&self, order_id: u64) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }

    fn internal_cancel(&mut self, caller: &AccountId, order_id: u64) -> u128 {
        // an unknown id has no maker, so it is NotMaker too
        let mut o = match self.orders.get(&order_id) {
            Some(o) if &o.maker == caller => o.clone(),
            _ => fail!("NotMaker({order_id})"),
        };
        if !o.is_open() {
            fail!("OrderNotOpen({order_id})");
        }
        let remaining = std::mem::take(&mut o.remaining);
        let refund = std::mem::take(&mut o.escrow);
        let key = o.escrow_key();
        let scenario_id = o.scenario_id;
        self.unindex(order_id, &o);
        self.orders.insert(order_id, o);
        OrderCancelled {
            order_id: U64(order_id),
            scenario_id,
            maker: caller,
            remaining: U128(remaining),
            refund: U128(refund),
        }
        .emit();
        if refund > 0 {
            self.release_from_custody(caller, &[(key, refund)], None);
        }
        refund
    }

    fn unindex(&mut self, order_id: u64, o: &Order) {
        if masks::is_single_world(o.mask) {
            let k = (o.scenario_id, masks::lowest_world(o.mask));
            remove_id(&mut self.open_by_world, &k, order_id);
        }
        remove_id(&mut self.open_by_scenario, &o.scenario_id, order_id);
        self.count_open_order(&o.maker, false);
    }

    /// Must be true while `account_id` is the maker of an open order; it
    /// blocks `storage_unregister`.
    pub(crate) fn has_open_orders(&self, account_id: &AccountId) -> bool {
        self.open_order_count(account_id) > 0
    }

    /// Verse tokens of `key` held in order escrow, for the conservation check
    /// in the tests.
    #[cfg(test)]
    pub(crate) fn escrow_holdings(&self, key: &VerseKey) -> u128 {
        (1..=self.order_count)
            .filter_map(|id| self.orders.get(&id))
            .filter(|o| o.is_open() && &o.escrow_key() == key)
            .map(|o| o.escrow)
            .sum()
    }
}

/// Drops `id` from an index entry, and the entry once it is empty.
fn remove_id<K>(index: &mut LookupMap<K, Vec<u64>>, key: &K, id: u64)
where
    K: BorshSerialize + Ord + Clone,
{
    let Some(ids) = index.get_mut(key) else {
        return;
    };
    ids.retain(|i| *i != id);
    if ids.is_empty() {
        index.remove(key);
    }
}

fn page_limit(limit: Option<u32>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize
}
