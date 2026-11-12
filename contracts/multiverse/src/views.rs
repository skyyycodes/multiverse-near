//! Snapshot views for the app's screens: one call per screen and poll,
//! because NEAR RPC has no batching. Every field reads the same state the
//! actions use, so a screen never shows a number the contract would not act
//! on. Views store nothing.

use near_sdk::json_types::U128;
use near_sdk::serde_json::Value;
use near_sdk::{near, AccountId};

use multiverse_math::risk;

use crate::amm::views::ImpactPoint;
use crate::lending::{CollateralKey, LiquidationState};
use crate::masks;
use crate::orders::OrderView;
use crate::types::{Asset, EventView, VerseKey};
use crate::{now_sec, Contract, ContractExt};

/// Best bids and best asks per world in a trade snapshot.
pub const SNAPSHOT_ORDERS_PER_SIDE: u32 = 25;

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldView {
    pub index: u8,
    pub mask: u8,
    pub label: String,
    pub possible: bool,
    pub pool_initialized: bool,
    /// Current pool price, USDC per wNEAR; "0" without a pool. Dead worlds
    /// keep their last price.
    pub wnear_price: U128,
    /// Invariant 1 for this world, both assets.
    pub backed: bool,
    pub wnear_token_id: String,
    pub usdc_token_id: String,
    /// The account's single-world tokens outside lending.
    pub user_wnear: U128,
    pub user_usdc: U128,
    /// The account's verse collateral paying in this world (any mask that
    /// contains it; real pieces are not counted).
    pub collateral_wnear: U128,
    pub collateral_usdc: U128,
    pub odds: U128,
    pub pool_id: Option<u64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScenarioView {
    pub scenario_id: u64,
    pub world_count: u8,
    pub possible: u8,
    pub resolution_count: u8,
    pub halted: bool,
    pub event_ids: Vec<u64>,
    pub spot_price: U128,
    pub worlds: Vec<WorldView>,
    pub odds_known: bool,
    pub implied_spot: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CollateralPiece {
    /// `"wnear"` / `"usdc"` for real pieces, the NEP-245 id otherwise.
    pub token_id: String,
    pub label: String,
    pub asset: Asset,
    /// The root mask for a real piece.
    pub mask: u8,
    pub is_real: bool,
    pub amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountView {
    pub debt: U128,
    /// Null without debt.
    pub health_factor: Option<U128>,
    pub worst_world: Option<u8>,
    pub collateral_values: Vec<U128>,
    pub world_price_ok: Vec<bool>,
    pub collateral: Vec<CollateralPiece>,
    pub supplied: U128,
    pub supply_principal: U128,
    pub market_supply: U128,
    pub market_borrow: U128,
    pub utilization: U128,
    pub borrow_rate_per_sec: U128,
    pub supply_rate_per_sec: U128,
    pub lltv: U128,
    pub liquidation: LiquidationState,
    pub unpriced_world: Option<u8>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootLpWithdrawPreview {
    pub wnear: Vec<U128>,
    pub usdc: Vec<U128>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootLpHoldingView {
    pub world: u8,
    pub wnear_idle: U128,
    pub usdc_idle: U128,
    pub wnear_fees: U128,
    pub usdc_fees: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootLpView {
    pub share_supply: U128,
    pub your_shares: U128,
    pub share_decimals: u8,
    pub preview_withdraw: Option<RootLpWithdrawPreview>,
    pub holdings: Vec<RootLpHoldingView>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldLabel {
    pub index: u8,
    pub mask: u8,
    pub label: String,
    pub possible: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradeView {
    pub scenario: ScenarioView,
    pub events: Vec<EventView>,
    /// Orders of the scenario with something left, by id.
    pub orders: Vec<OrderView>,
    pub impact: Vec<ImpactPoint>,
    pub now_sec: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BorrowView {
    pub scenario: ScenarioView,
    pub account: AccountView,
    pub now_sec: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LendView {
    pub account: AccountView,
    pub root_lp: Option<RootLpView>,
    pub worlds: Vec<WorldLabel>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolveView {
    pub scenario: ScenarioView,
    pub events: Vec<EventView>,
    pub past_fed_event: Option<EventView>,
    pub account: AccountView,
    pub now_sec: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdminView {
    pub scenario: ScenarioView,
    pub events: Vec<EventView>,
    pub past_fed_event: Option<EventView>,
    pub owner_id: AccountId,
    pub now_sec: u64,
}

#[near]
impl Contract {
    pub fn trade_view(&self, scenario_id: u64, account_id: Option<AccountId>) -> TradeView {
        TradeView {
            scenario: self.scenario_snapshot(scenario_id, account_id.as_ref()),
            events: self.events_of(scenario_id),
            orders: self.snapshot_orders(scenario_id, account_id.as_ref()),
            impact: self.impact(scenario_id),
            now_sec: now_sec(),
        }
    }

    pub fn borrow_view(&self, scenario_id: u64, account_id: Option<AccountId>) -> BorrowView {
        BorrowView {
            scenario: self.scenario_snapshot(scenario_id, account_id.as_ref()),
            account: self.account_snapshot(scenario_id, account_id.as_ref()),
            now_sec: now_sec(),
        }
    }

    pub fn lend_view(&self, scenario_id: u64, account_id: Option<AccountId>) -> LendView {
        let s = self.scenario(scenario_id);
        let worlds = (0..s.world_count)
            .map(|w| WorldLabel {
                index: w,
                mask: 1 << w,
                label: self.verse_label(scenario_id, 1 << w),
                possible: masks::contains(s.possible, w),
            })
            .collect();
        LendView {
            account: self.account_snapshot(scenario_id, account_id.as_ref()),
            root_lp: self.root_lp_snapshot(scenario_id, account_id.as_ref()),
            worlds,
        }
    }

    pub fn resolve_view(&self, scenario_id: u64, account_id: Option<AccountId>) -> ResolveView {
        ResolveView {
            scenario: self.scenario_snapshot(scenario_id, account_id.as_ref()),
            events: self.events_of(scenario_id),
            past_fed_event: self.past_fed_event(),
            account: self.account_snapshot(scenario_id, account_id.as_ref()),
            now_sec: now_sec(),
        }
    }

    /// `account_id` is accepted for symmetry with the other screens and
    /// ignored: nothing here depends on who is looking.
    pub fn admin_view(&self, scenario_id: u64, account_id: Option<AccountId>) -> AdminView {
        let _ = account_id;
        AdminView {
            scenario: self.scenario_snapshot(scenario_id, None),
            events: self.events_of(scenario_id),
            past_fed_event: self.past_fed_event(),
            owner_id: self.owner_id.clone(),
            now_sec: now_sec(),
        }
    }
}

impl Contract {
    /// The book a trade snapshot carries: each possible world's best
    /// fillable bids and asks, then whatever else the viewer has open in the
    /// scenario (expired and stale orders too, so they can cancel them).
    /// Built from the open-order indexes, never by order id, so old or dust
    /// orders cannot push live ones out.
    fn snapshot_orders(&self, scenario_id: u64, viewer: Option<&AccountId>) -> Vec<OrderView> {
        let world_count = self.scenario(scenario_id).world_count;
        let mut orders = Vec::new();
        for w in 0..world_count {
            let book = self.orders_for_world(scenario_id, w, Some(SNAPSHOT_ORDERS_PER_SIDE));
            orders.extend(book.bids);
            orders.extend(book.asks);
        }
        if let Some(viewer) = viewer {
            for o in self.orders_by_maker(viewer.clone(), scenario_id) {
                if !orders.iter().any(|seen| seen.id == o.id) {
                    orders.push(o);
                }
            }
        }
        orders
    }

    pub(crate) fn scenario_snapshot(
        &self,
        scenario_id: u64,
        account: Option<&AccountId>,
    ) -> ScenarioView {
        let s = self.scenario(scenario_id);
        let (q, odds_known) = self.odds_of(scenario_id);
        let backing = self.backing(scenario_id);
        let pieces = account
            .map(|a| self.pieces(scenario_id, a))
            .unwrap_or_default();
        let worlds = (0..s.world_count)
            .map(|w| {
                let mask = 1u8 << w;
                let wnear_key = VerseKey::new(scenario_id, Asset::Wnear, mask);
                let usdc_key = VerseKey::new(scenario_id, Asset::Usdc, mask);
                let pool_id = self.world_pool(scenario_id, w);
                let price = self.world_spot_price(scenario_id, w);
                let held = |key: &VerseKey| account.map_or(0, |a| self.verse_balance(a, key));
                let posted = |asset: Asset| -> u128 {
                    pieces
                        .iter()
                        .filter(|(k, _)| match k {
                            CollateralKey::Verse { asset: a, mask: m } => {
                                *a == asset && masks::contains(*m, w)
                            }
                            CollateralKey::Real(_) => false,
                        })
                        .map(|(_, amount)| *amount)
                        .sum()
                };
                let b = &backing.worlds[usize::from(w)];
                WorldView {
                    index: w,
                    mask,
                    label: self.verse_label(scenario_id, mask),
                    possible: masks::contains(s.possible, w),
                    pool_initialized: price.is_some(),
                    wnear_price: U128(price.unwrap_or(0)),
                    backed: b.wnear_backed && b.usdc_backed,
                    wnear_token_id: wnear_key.token_id(),
                    usdc_token_id: usdc_key.token_id(),
                    user_wnear: U128(held(&wnear_key)),
                    user_usdc: U128(held(&usdc_key)),
                    collateral_wnear: U128(posted(Asset::Wnear)),
                    collateral_usdc: U128(posted(Asset::Usdc)),
                    odds: U128(q[usize::from(w)]),
                    pool_id,
                }
            })
            .collect();
        ScenarioView {
            scenario_id,
            world_count: s.world_count,
            possible: s.possible,
            resolution_count: s.resolution_count,
            halted: self.halted(s),
            event_ids: s.event_ids.clone(),
            spot_price: U128(self.spot_price_wad()),
            worlds,
            odds_known,
            implied_spot: U128(self.implied_spot_of(scenario_id)),
        }
    }

    /// The lending side of one account; without an account, the market's
    /// numbers and an empty position.
    pub(crate) fn account_snapshot(
        &self,
        scenario_id: u64,
        account: Option<&AccountId>,
    ) -> AccountView {
        let s = self.scenario(scenario_id);
        let (worlds, possible, root) = (s.world_count, s.possible, s.root());
        let market = self.market_state(scenario_id);
        let world_price_ok = (0..worlds)
            .map(|w| self.world_price(scenario_id, w).1)
            .collect();
        let mut view = AccountView {
            debt: U128(0),
            health_factor: None,
            worst_world: risk::worst_world(&vec![0; usize::from(worlds)], possible).map(|(w, _)| w),
            collateral_values: vec![U128(0); usize::from(worlds)],
            world_price_ok,
            collateral: Vec::new(),
            supplied: U128(0),
            supply_principal: U128(0),
            market_supply: market.total_supply,
            market_borrow: market.total_borrow,
            utilization: market.utilization,
            borrow_rate_per_sec: market.borrow_rate_per_sec,
            supply_rate_per_sec: market.supply_rate_per_sec,
            lltv: U128(self.params.lltv),
            liquidation: LiquidationState::None,
            unpriced_world: None,
        };
        let Some(account) = account else {
            return view;
        };
        let (v, h) = self.health(scenario_id, account);
        let status = self.liquidation_status(scenario_id, account.clone());
        view.debt = U128(h.debt);
        view.health_factor = h.hf.map(U128);
        view.worst_world = risk::worst_world(&v.values, v.possible).map(|(w, _)| w);
        view.collateral_values = v.values.into_iter().map(U128).collect();
        view.collateral = self
            .pieces(scenario_id, account)
            .into_iter()
            .map(|(key, amount)| {
                let asset = key.asset();
                let is_real = matches!(key, CollateralKey::Real(_));
                let mask = key.mask(root);
                CollateralPiece {
                    token_id: key.piece_id(scenario_id),
                    label: if is_real {
                        self.asset_cfg(asset).symbol.clone()
                    } else {
                        self.verse_name(scenario_id, asset, mask)
                    },
                    asset,
                    mask,
                    is_real,
                    amount: U128(amount),
                }
            })
            .collect();
        view.supplied = self.supply_balance_of(scenario_id, account.clone());
        view.supply_principal = self.supply_principal_of(scenario_id, account.clone());
        view.liquidation = status.status;
        view.unpriced_world = status.unpriced_world;
        view
    }

    /// The Root LP panel's numbers; null while the vault is switched off.
    pub(crate) fn root_lp_snapshot(
        &self,
        scenario_id: u64,
        account: Option<&AccountId>,
    ) -> Option<RootLpView> {
        if !crate::rootlp::ENABLED {
            return None;
        }
        let v = self.root_lp_view(scenario_id, account)?;
        Some(RootLpView {
            share_supply: v.share_supply,
            your_shares: v.your_shares,
            share_decimals: v.share_decimals,
            preview_withdraw: v.preview_withdraw.map(|p| RootLpWithdrawPreview {
                wnear: p.wnear,
                usdc: p.usdc,
            }),
            holdings: v
                .holdings
                .into_iter()
                .map(|h| RootLpHoldingView {
                    world: h.world,
                    wnear_idle: h.wnear_idle,
                    usdc_idle: h.usdc_idle,
                    wnear_fees: h.wnear_fees,
                    usdc_fees: h.usdc_fees,
                })
                .collect(),
        })
    }

    fn events_of(&self, scenario_id: u64) -> Vec<EventView> {
        self.scenario(scenario_id)
            .event_ids
            .iter()
            .map(|id| self.get_event(*id))
            .collect()
    }

    /// The already-decided FOMC event the demo record names, if it exists.
    /// Ids may be written as numbers or numeric strings.
    fn past_fed_event(&self) -> Option<EventView> {
        let id = match self.demo_record()?.get("past_fed_event")? {
            Value::Number(n) => n.as_u64()?,
            Value::String(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => {
                s.parse().ok()?
            }
            _ => return None,
        };
        self.events.get(&id)?;
        Some(self.get_event(id))
    }
}
