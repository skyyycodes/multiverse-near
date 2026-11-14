//! Snapshot views for the app's screens: one call per screen and poll,
//! because NEAR RPC has no batching. Every field reads the same state the
//! actions use, so a screen never shows a number the contract would not act
//! on. Views store nothing.

use near_sdk::json_types::U128;
use near_sdk::serde_json::Value;
use near_sdk::{near, AccountId};

use multiverse_math::risk;

use crate::amm::views::ImpactPoint;
use crate::lending::tiers::{MarketId, Tier};
use crate::lending::{CollateralKey, LiquidationState, MarketCtx, MarketView};
use crate::masks;
use crate::orders::OrderView;
use crate::prices::WorldStatus;
use crate::types::{Asset, EventView, VerseKey, WAD};
use crate::{now_sec, Contract, ContractExt};

/// Best bids and best asks per world in a trade snapshot: 25 up to 4 worlds,
/// 12 at 8, so a snapshot carries at most 200 book orders.
pub fn orders_per_side(world_count: u8) -> u32 {
    25u32.min(100 / u32::from(world_count.max(1)))
}

/// Per-world supply of both assets against the reserves (invariant 1 per
/// world, from the counters): one entry per world.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldSupplyView {
    pub scenario_id: u64,
    pub possible: u8,
    pub wnear_reserves: U128,
    pub usdc_reserves: U128,
    pub wnear: Vec<U128>,
    pub usdc: Vec<U128>,
}

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
    // v2: the market is one tier; `lltv`, rates and market numbers are its.
    pub tier: Tier,
    pub borrow_ltv: U128,
    /// At the borrow prices and `borrow_ltv`; null without debt.
    pub borrow_health_factor: Option<U128>,
    /// `floor(C_min at the borrow prices * borrow_ltv)`.
    pub borrow_limit: U128,
    /// What `borrow` would accept now: the room under the borrow limit,
    /// the liquidity, the utilization cap and the borrow cap; 0 while the
    /// market is frozen, the scenario halted or new borrowing blocked.
    pub max_borrow: U128,
    pub liquidation_bonus: U128,
    pub insurance: U128,
    pub min_loan: U128,
    pub frozen: bool,
    /// What `"max"` would repay now; 0 unless liquidatable.
    pub max_repay: U128,
    pub write_off_ready: bool,
    pub world_status: Vec<WorldStatus>,
    pub borrow_block: Option<String>,
    /// The reference factor on the liquidation prices (WAD).
    pub liquidation_factor: U128,
}

/// One tier of a scenario, for `lending_tiers`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LendingTierView {
    pub tier: Tier,
    pub market: MarketView,
    pub account: Option<AccountView>,
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

    /// The borrow screen of one tier (default Normal).
    #[deny_unknown_arguments]
    pub fn borrow_view(
        &self,
        scenario_id: u64,
        account_id: Option<AccountId>,
        tier: Option<Tier>,
    ) -> BorrowView {
        BorrowView {
            scenario: self.scenario_snapshot(scenario_id, account_id.as_ref()),
            account: self.account_snapshot(MarketId::new(scenario_id, tier), account_id.as_ref()),
            now_sec: now_sec(),
        }
    }

    /// The lend screen of one tier (default Normal).
    #[deny_unknown_arguments]
    pub fn lend_view(
        &self,
        scenario_id: u64,
        account_id: Option<AccountId>,
        tier: Option<Tier>,
    ) -> LendView {
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
            account: self.account_snapshot(MarketId::new(scenario_id, tier), account_id.as_ref()),
            root_lp: self.root_lp_snapshot(scenario_id, account_id.as_ref()),
            worlds,
        }
    }

    /// The resolve screen, with one tier's position (default Normal).
    #[deny_unknown_arguments]
    pub fn resolve_view(
        &self,
        scenario_id: u64,
        account_id: Option<AccountId>,
        tier: Option<Tier>,
    ) -> ResolveView {
        ResolveView {
            scenario: self.scenario_snapshot(scenario_id, account_id.as_ref()),
            events: self.events_of(scenario_id),
            past_fed_event: self.past_fed_event(),
            account: self.account_snapshot(MarketId::new(scenario_id, tier), account_id.as_ref()),
            now_sec: now_sec(),
        }
    }

    /// The three tiers of a scenario (Safe, Normal, Bold): each market and,
    /// with an account, its position there, at one price snapshot.
    pub fn lending_tiers(
        &self,
        scenario_id: u64,
        account_id: Option<AccountId>,
    ) -> Vec<LendingTierView> {
        let s = self.scenario(scenario_id).clone();
        let snap = self.price_snapshot(scenario_id);
        Tier::ALL
            .into_iter()
            .map(|tier| {
                let id = MarketId::new(scenario_id, Some(tier));
                let (p, st) = self.projected(id);
                let ctx = self.market_ctx(id, s.clone(), p.market, st, snap.clone());
                LendingTierView {
                    tier,
                    market: self.market_view(id, &ctx.market, &ctx.state),
                    account: account_id
                        .as_ref()
                        .map(|a| self.account_view(&ctx, Some(a))),
                }
            })
            .collect()
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

    /// The supply of every token paying in each world, per asset, with the
    /// reserves it must equal in every possible world: two reads, where
    /// `backing` reads every mask.
    pub fn world_supply(&self, scenario_id: u64) -> WorldSupplyView {
        let s = self.scenario(scenario_id);
        let counts = |asset: Asset| -> Vec<U128> {
            self.world_supply_of(scenario_id, asset, s.world_count)
                .into_iter()
                .map(U128)
                .collect()
        };
        WorldSupplyView {
            scenario_id,
            possible: s.possible,
            wnear_reserves: U128(self.reserve(scenario_id, Asset::Wnear)),
            usdc_reserves: U128(self.reserve(scenario_id, Asset::Usdc)),
            wnear: counts(Asset::Wnear),
            usdc: counts(Asset::Usdc),
        }
    }

    /// The scenarios where the account holds anything (a verse balance, a
    /// pool position, a lending entry of any tier, Root LP shares),
    /// ascending: the legacy scan, then the account's scenario index.
    pub fn markets_of(&self, account_id: AccountId) -> Vec<u64> {
        self.scenarios_held_by(&account_id)
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
        let per_side = orders_per_side(world_count);
        let mut orders = Vec::new();
        for w in 0..world_count {
            let book = self.orders_for_world(scenario_id, w, Some(per_side));
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
        // invariant 1 per world from the counters (two reads, not 2^W per world)
        let reserves = [
            self.reserve(scenario_id, Asset::Wnear),
            self.reserve(scenario_id, Asset::Usdc),
        ];
        let supplies = [
            self.world_supply_of(scenario_id, Asset::Wnear, s.world_count),
            self.world_supply_of(scenario_id, Asset::Usdc, s.world_count),
        ];
        // posted collateral of all three tiers
        let pieces: Vec<(CollateralKey, u128)> = account
            .map(|a| {
                Tier::ALL
                    .into_iter()
                    .flat_map(|tier| self.pieces(MarketId::new(scenario_id, Some(tier)), a))
                    .collect()
            })
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
                let possible = masks::contains(s.possible, w);
                let i = usize::from(w);
                let backed =
                    !possible || (supplies[0][i] == reserves[0] && supplies[1][i] == reserves[1]);
                WorldView {
                    index: w,
                    mask,
                    label: self.verse_label(scenario_id, mask),
                    possible,
                    pool_initialized: price.is_some(),
                    wnear_price: U128(price.unwrap_or(0)),
                    backed,
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

    /// The lending side of one account in one market; without an account,
    /// the market's numbers and an empty position.
    pub(crate) fn account_snapshot(
        &self,
        id: MarketId,
        account: Option<&AccountId>,
    ) -> AccountView {
        let ctx = self.market_ctx_view(id);
        self.account_view(&ctx, account)
    }

    /// `account_snapshot` on a market already read.
    pub(crate) fn account_view(&self, ctx: &MarketCtx, account: Option<&AccountId>) -> AccountView {
        let id = ctx.id;
        let sid = id.scenario_id;
        let s = &ctx.scenario;
        let (worlds, possible, root) = (s.world_count, s.possible, s.root());
        let market = self.market_view(id, &ctx.market, &ctx.state);
        let c = &ctx.state.config;
        let borrow_block = ctx.snap.borrow_block().map(|b| b.error());
        let mut view = AccountView {
            debt: U128(0),
            health_factor: None,
            worst_world: risk::worst_world(&vec![0; usize::from(worlds)], possible).map(|(w, _)| w),
            collateral_values: vec![U128(0); usize::from(worlds)],
            world_price_ok: self.world_price_ok(&ctx.snap),
            collateral: Vec::new(),
            supplied: U128(0),
            supply_principal: U128(0),
            market_supply: market.total_supply,
            market_borrow: market.total_borrow,
            utilization: market.utilization,
            borrow_rate_per_sec: market.borrow_rate_per_sec,
            supply_rate_per_sec: market.supply_rate_per_sec,
            lltv: U128(c.lltv),
            liquidation: LiquidationState::None,
            unpriced_world: None,
            tier: id.tier,
            borrow_ltv: U128(c.borrow_ltv),
            borrow_health_factor: None,
            borrow_limit: U128(0),
            max_borrow: U128(0),
            liquidation_bonus: U128(c.liquidation_bonus),
            insurance: U128(ctx.state.insurance),
            min_loan: U128(self.lending.min_loan),
            frozen: ctx.state.frozen,
            max_repay: U128(0),
            write_off_ready: false,
            world_status: ctx.snap.statuses(),
            borrow_block: borrow_block.clone(),
            liquidation_factor: U128(ctx.liq.factor),
        };
        let Some(account) = account else {
            return view;
        };
        let a = self.assess(ctx, account);
        view.debt = U128(a.debt);
        view.health_factor = a.liq_health.hf.map(U128);
        view.worst_world = risk::worst_world(&a.liq.values, a.liq.possible).map(|(w, _)| w);
        view.collateral_values = a.liq.values.iter().map(|v| U128(*v)).collect();
        view.collateral = a
            .pieces
            .iter()
            .map(|&(key, amount)| {
                let asset = key.asset();
                let is_real = matches!(key, CollateralKey::Real(_));
                let mask = key.mask(root);
                CollateralPiece {
                    token_id: key.piece_id(sid),
                    label: if is_real {
                        self.asset_cfg(asset).symbol.clone()
                    } else {
                        self.verse_name(sid, asset, mask)
                    },
                    asset,
                    mask,
                    is_real,
                    amount: U128(amount),
                }
            })
            .collect();
        let m = &ctx.market;
        view.supplied = U128(multiverse_math::shares::to_assets_down(
            self.supply_shares_of(id, account),
            m.total_supply_assets,
            m.total_supply_shares,
        ));
        view.supply_principal = U128(self.principal_of(id, account));
        view.liquidation = a.status;
        view.unpriced_world = a.unpriced_world;
        view.borrow_health_factor = a.borrow_health.hf.map(U128);
        let limit = risk::borrow_capacity(a.borrow_health.lowest, c.borrow_ltv);
        view.borrow_limit = U128(limit);
        let open = !ctx.state.frozen && !ctx.halted && borrow_block.is_none();
        if open {
            let util_room =
                multiverse_math::mul_div_down(c.max_utilization, m.total_supply_assets, WAD)
                    .saturating_sub(m.total_borrow_assets);
            let cap_room = c.borrow_cap.saturating_sub(m.total_borrow_assets);
            let max = limit
                .saturating_sub(a.debt)
                .min(m.liquid())
                .min(util_room)
                .min(cap_room);
            view.max_borrow = U128(max);
        }
        view.max_repay = U128(a.max_repay);
        view.write_off_ready = a.write_off_ready;
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
