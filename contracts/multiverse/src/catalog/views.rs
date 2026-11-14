//! The catalogue's views: proposals and their opening preview, pledges and
//! seed claims, and the market list the app reads (none calls `backing()`).

use multiverse_math::seed::{self, SeedAsset, SeedInput, SeedPlan};
use multiverse_math::{checked_mul_div, Rounding};
use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use super::seed::totals_of;
use super::{
    AnchorView, EventMetaView, EventSetKey, MarketCard, MarketCardStatus, MarketList,
    MarketOfEvents, NewEventSummary, NewEventView, OddsPoolPlan, OpenedView, OpeningPreview,
    PerWorldAmounts, Pledge, PledgePreview, PledgeState, PledgeView, Proposal, ProposalKind,
    ProposalList, ProposalStatus, ProposalSummary, ProposalView, ProposalViewStatus, RelatedMarket,
    RelatedMarkets, SeedPositionView, SeedSummary, SeedVaultView, SeedWithdrawPreview, TokenAmount,
    WorldPoolPlan, BPS_DENOM,
};
use crate::errors::fail;
use crate::masks;
use crate::ops::PauseFlag;
use crate::prices::WorldStatus;
use crate::types::{Asset, EventView, Scenario, VerseKey, WAD};
use crate::{now_sec, Contract, ContractExt};

/// Most ids `get_events` and `market_cards` take.
pub const MAX_EVENT_IDS: usize = 24;
pub const MAX_CARD_IDS: usize = 12;
/// `list_markets`: cards per page and ids scanned per call.
pub const MARKETS_DEFAULT_LIMIT: u32 = 12;
pub const MARKETS_MAX_LIMIT: u32 = 30;
pub const MARKETS_MAX_SCAN: u64 = 128;
/// `list_proposals`: per page; at most 4 x limit ids are scanned.
pub const PROPOSALS_DEFAULT_LIMIT: u32 = 20;
pub const PROPOSALS_MAX_LIMIT: u32 = 50;
/// `related_markets`: at most this many markets and proposals.
pub const MAX_RELATED: usize = 48;

fn mul(a: u128, b: u128) -> u128 {
    checked_mul_div(a, b, WAD, Rounding::Down).unwrap_or(u128::MAX)
}

fn u128s(v: &[u128]) -> Vec<U128> {
    v.iter().map(|x| U128(*x)).collect()
}

/// The asset that adds more usable value: the one whose escrow fills less of
/// its ideal; None once the goal is reached.
fn needs(p: &Proposal, wnear: u128, usdc: u128, usable: u128) -> Option<Asset> {
    if usable >= p.goal {
        return None;
    }
    let fill = |have: u128, ideal: u128| {
        checked_mul_div(have, WAD, ideal.max(1), Rounding::Down).unwrap_or(u128::MAX)
    };
    if fill(wnear, p.ideal_wnear) < fill(usdc, p.ideal_usdc) {
        Some(Asset::Wnear)
    } else {
        Some(Asset::Usdc)
    }
}

fn card_status(c: &Contract, s: &Scenario) -> MarketCardStatus {
    if c.halted(s) {
        MarketCardStatus::Deciding
    } else if s.resolution_count > 0 && usize::from(s.resolution_count) < s.event_ids.len() {
        MarketCardStatus::PartlyResolved
    } else if masks::is_single_world(s.possible) {
        MarketCardStatus::Resolved
    } else {
        MarketCardStatus::Open
    }
}

#[near]
impl Contract {
    pub fn proposal_count(&self) -> u64 {
        self.catalog.proposal_count
    }

    /// The proposal with its status as of now (`ready` / `waiting` split out
    /// of `pledging`), its blocker and its opening preview.
    pub fn get_proposal(&self, proposal_id: u64) -> Option<ProposalView> {
        let p = self.get_proposal_record(proposal_id)?;
        let s = self.summary(proposal_id, &p, true);
        let live = matches!(s.status, ProposalStatus::Review | ProposalStatus::Pledging);
        let blocker = if live {
            self.open_check(proposal_id).err()
        } else {
            None
        };
        let status = match s.status {
            ProposalStatus::Pledging => match &blocker {
                None => ProposalViewStatus::Ready,
                Some(b) if b.starts_with("GoalNotReached") => ProposalViewStatus::Pledging,
                Some(_) => ProposalViewStatus::Waiting,
            },
            ProposalStatus::Review => ProposalViewStatus::Review,
            ProposalStatus::Opened => ProposalViewStatus::Opened,
            ProposalStatus::Rejected => ProposalViewStatus::Rejected,
            ProposalStatus::Cancelled => ProposalViewStatus::Cancelled,
            ProposalStatus::Expired => ProposalViewStatus::Expired,
            ProposalStatus::Void => ProposalViewStatus::Void,
        };
        let new_event = self.new_event_view(proposal_id, &p);
        Some(ProposalView {
            proposal_id,
            kind: p.kind,
            proposer: s.proposer,
            status,
            void_reason: s.void_reason,
            blocker,
            event_ids: s.event_ids,
            world_count: s.world_count,
            new_event,
            category: s.category,
            deadline_sec: s.deadline_sec,
            created_at_sec: s.created_at_sec,
            approved_at_sec: s.approved_at_sec,
            expires_at_sec: s.expires_at_sec,
            open_not_before_sec: s.open_not_before_sec,
            goal: s.goal,
            ideal_wnear: s.ideal_wnear,
            ideal_usdc: s.ideal_usdc,
            s_hint: s.s_hint,
            pledged_wnear: s.pledged_wnear,
            pledged_usdc: s.pledged_usdc,
            pledgers: s.pledgers,
            progress_bps: s.progress_bps,
            bond: s.bond,
            reserve: s.reserve,
            seed_lock_sec: s.seed_lock_sec,
            preview: live.then(|| self.opening_preview(proposal_id)),
            opened: s.opened,
        })
    }

    /// Newest first. `filter`: `live` (review or pledging), `review`,
    /// `pledging`, `opened`, `closed` (ended without opening) or `all`
    /// (default). At most `4 x limit` ids are scanned; `next_from` is the
    /// next id to scan, null past id 1.
    pub fn list_proposals(
        &self,
        from_id: Option<u64>,
        limit: Option<u32>,
        filter: Option<String>,
    ) -> ProposalList {
        let limit = limit
            .unwrap_or(PROPOSALS_DEFAULT_LIMIT)
            .clamp(1, PROPOSALS_MAX_LIMIT) as usize;
        let filter = filter.unwrap_or_else(|| "all".to_string());
        if !["live", "review", "pledging", "opened", "closed", "all"].contains(&filter.as_str()) {
            fail!("BadFilter({filter})");
        }
        let mut id = from_id
            .unwrap_or(self.catalog.proposal_count)
            .min(self.catalog.proposal_count);
        let mut scanned = 0;
        let mut proposals = Vec::new();
        while id > 0 && scanned < 4 * limit && proposals.len() < limit {
            scanned += 1;
            if let Some(p) = self.get_proposal_record(id) {
                let s = self.summary(id, &p, false);
                let keep = match filter.as_str() {
                    "live" => matches!(s.status, ProposalStatus::Review | ProposalStatus::Pledging),
                    "review" => s.status == ProposalStatus::Review,
                    "pledging" => s.status == ProposalStatus::Pledging,
                    "opened" => s.status == ProposalStatus::Opened,
                    "closed" => s.status.is_terminal(),
                    _ => true,
                };
                if keep {
                    proposals.push(s);
                }
            }
            id -= 1;
        }
        ProposalList {
            proposals,
            next_from: (id > 0).then_some(id),
        }
    }

    /// The live combination proposals that contain the event (at most 16).
    pub fn proposals_of_event(&self, event_id: u64) -> Vec<ProposalSummary> {
        self.live_summaries(&[event_id], usize::MAX)
    }

    pub fn pledge_of(&self, proposal_id: u64, account_id: AccountId) -> Option<PledgeView> {
        let pledge = self
            .catalog
            .pledges
            .get(&(proposal_id, account_id.clone()))?
            .clone();
        let p = self.get_proposal_record(proposal_id)?;
        Some(self.pledge_view(proposal_id, &account_id, &pledge, &p))
    }

    /// Every pledge and seed claim of the account.
    pub fn pledges_of(&self, account_id: AccountId) -> Vec<PledgeView> {
        self.account_markets(&account_id)
            .pledges
            .iter()
            .filter_map(|pid| self.pledge_of(*pid, account_id.clone()))
            .collect()
    }

    /// What pledging `amount` of `asset` would do to the opening's usable
    /// value at today's prices.
    pub fn pledge_preview(&self, proposal_id: u64, asset: Asset, amount: U128) -> PledgePreview {
        let p = self.proposal_record(proposal_id);
        let shape = self.preview_shape(&p);
        let (mut wnear, mut usdc) = (p.escrow_wnear, p.escrow_usdc);
        let before = shape
            .as_ref()
            .and_then(|(s, q, pr)| plan_of(&p, *s, q, pr, wnear, usdc));
        match asset {
            Asset::Wnear => wnear = wnear.saturating_add(amount.0),
            Asset::Usdc => usdc = usdc.saturating_add(amount.0),
        }
        let after = shape
            .as_ref()
            .and_then(|(s, q, pr)| plan_of(&p, *s, q, pr, wnear, usdc));
        let usable = |plan: &Option<SeedPlan>| plan.as_ref().map_or(0, |x| x.usable_value);
        let used = |plan: &Option<SeedPlan>| {
            plan.as_ref().map_or(0, |x| match asset {
                Asset::Wnear => x.used_wnear,
                Asset::Usdc => x.used_usdc,
            })
        };
        let usable_after = usable(&after);
        PledgePreview {
            usable_before: U128(usable(&before)),
            usable_after: U128(usable_after),
            deployed_part: U128(used(&after).saturating_sub(used(&before)).min(amount.0)),
            goal_reached_after: usable_after >= p.goal && usable_after > 0,
            needs: needs(&p, wnear, usdc, usable_after),
        }
    }

    /// What an opening would do now. The planned amounts are computed from
    /// the current pledges even when `can_open` is false.
    pub fn opening_preview(&self, proposal_id: u64) -> OpeningPreview {
        let p = self.proposal_record(proposal_id);
        let blocker = self.open_check(proposal_id).err();
        let params = self.market_params_stored();
        let spot = self.spot_reference(&params).ok();
        let n = usize::from(p.world_count);
        let shape = spot.as_ref().and_then(|s| match p.kind {
            ProposalKind::Market => self.kind_b_shape(&p.event_ids(), s.s_ref, &params).ok(),
            ProposalKind::NewEvent => self.kind_a_shape(&p.terms, s.s_ref, &params).ok(),
        });
        let plan = match (&spot, &shape) {
            (Some(s), Some(sh)) => {
                plan_of(&p, s.s_ref, &sh.q, &sh.p, p.escrow_wnear, p.escrow_usdc)
            }
            _ => None,
        };
        let sid_hint = 0;
        let token = |asset: SeedAsset, mask: u8| {
            let a = match asset {
                SeedAsset::Wnear => Asset::Wnear,
                SeedAsset::Usdc => Asset::Usdc,
            };
            VerseKey::new(sid_hint, a, mask).token_id()
        };
        let usable = plan.as_ref().map_or(0, |x| x.usable_value);
        OpeningPreview {
            can_open: blocker.is_none(),
            blocker,
            s_ref: spot.as_ref().map(|s| U128(s.s_ref)),
            anchors: spot.as_ref().map_or_else(Vec::new, |s| {
                s.anchors
                    .iter()
                    .map(|(sid, implied)| AnchorView {
                        scenario_id: *sid,
                        implied: U128(*implied),
                    })
                    .collect()
            }),
            references: shape
                .as_ref()
                .map_or_else(Vec::new, |s| s.references.clone()),
            odds: shape.as_ref().map_or(vec![U128(0); n], |s| u128s(&s.q)),
            prices: shape.as_ref().map_or(vec![U128(0); n], |s| u128s(&s.p)),
            usable_value: U128(usable),
            used_wnear: U128(plan.as_ref().map_or(0, |x| x.used_wnear)),
            used_usdc: U128(plan.as_ref().map_or(0, |x| x.used_usdc)),
            unused_wnear: U128(p.escrow_wnear - plan.as_ref().map_or(0, |x| x.used_wnear)),
            unused_usdc: U128(p.escrow_usdc - plan.as_ref().map_or(0, |x| x.used_usdc)),
            world_pools: plan.as_ref().map_or_else(Vec::new, |x| {
                x.world
                    .iter()
                    .enumerate()
                    .map(|(w, (a, u))| WorldPoolPlan {
                        world: w as u8,
                        wnear: U128(*a),
                        usdc: U128(*u),
                    })
                    .collect()
            }),
            odds_pools: plan.as_ref().map_or_else(Vec::new, |x| {
                x.odds_pools
                    .iter()
                    .map(|(m0, m1, a0, a1)| OddsPoolPlan {
                        mask0: *m0,
                        mask1: *m1,
                        amount0: U128(*a0),
                        amount1: U128(*a1),
                    })
                    .collect()
            }),
            idle: plan.as_ref().map_or_else(Vec::new, |x| {
                x.idle
                    .iter()
                    .map(|(asset, mask, amount)| TokenAmount {
                        token_id: token(*asset, *mask),
                        amount: U128(*amount),
                    })
                    .collect()
            }),
            idle_value: U128(plan.as_ref().map_or(0, |x| x.idle_value)),
            thinnest_world_usdc: U128(
                plan.as_ref()
                    .and_then(|x| x.world.iter().map(|(_, u)| *u).min())
                    .unwrap_or(0),
            ),
            needs: needs(&p, p.escrow_wnear, p.escrow_usdc, usable),
            storage_estimate: U128(self.open_storage_estimate(proposal_id, &p)),
            reserve_available: U128(p.reserve.saturating_add(self.catalog.storage_fund)),
        }
    }

    /// Ascending from `from_id` (default 1): up to `limit` cards (default 12,
    /// max 30), scanning at most 128 ids; `next_from` is the next unscanned
    /// id, null past the last scenario. `listed_only` defaults to true.
    pub fn list_markets(
        &self,
        from_id: Option<u64>,
        limit: Option<u32>,
        listed_only: Option<bool>,
    ) -> MarketList {
        let limit = limit
            .unwrap_or(MARKETS_DEFAULT_LIMIT)
            .clamp(1, MARKETS_MAX_LIMIT) as usize;
        let listed_only = listed_only.unwrap_or(true);
        let mut id = from_id.unwrap_or(1).max(1);
        let end = id.saturating_add(MARKETS_MAX_SCAN);
        let mut markets = Vec::new();
        while id <= self.scenario_count && id < end && markets.len() < limit {
            if !listed_only || self.market_entry(id).listed {
                if let Some(card) = self.market_card(id) {
                    markets.push(card);
                }
            }
            id += 1;
        }
        MarketList {
            markets,
            next_from: (id <= self.scenario_count).then_some(id),
        }
    }

    /// Cards of up to 12 markets, in the order given (unknown ids skipped).
    pub fn market_cards(&self, scenario_ids: Vec<u64>) -> Vec<MarketCard> {
        if scenario_ids.len() > MAX_CARD_IDS {
            fail!("TooManyIds({}, {MAX_CARD_IDS})", scenario_ids.len());
        }
        scenario_ids
            .iter()
            .filter_map(|sid| self.market_card(*sid))
            .collect()
    }

    pub fn get_market(&self, scenario_id: u64) -> Option<MarketCard> {
        self.market_card(scenario_id)
    }

    /// Listed markets sharing an event with this one (itself excluded) and
    /// the live combination proposals on its events; no pool reads.
    pub fn related_markets(&self, scenario_id: u64) -> RelatedMarkets {
        let s = self.scenario(scenario_id);
        let mut markets: Vec<RelatedMarket> = Vec::new();
        for e in &s.event_ids {
            for other in self.scenarios_of_event(*e) {
                if other == scenario_id
                    || markets.len() >= MAX_RELATED
                    || markets.iter().any(|m| m.scenario_id == other)
                    || !self.market_entry(other).listed
                {
                    continue;
                }
                let o = self.scenario(other);
                markets.push(RelatedMarket {
                    scenario_id: other,
                    event_ids: o.event_ids.clone(),
                    world_count: o.world_count,
                    status: card_status(self, o),
                    listed: true,
                });
            }
        }
        RelatedMarkets {
            markets,
            proposals: self.live_summaries(&s.event_ids, MAX_RELATED),
        }
    }

    /// The listed market and the live proposal on an event set, in any order.
    pub fn market_of_events(&self, event_ids: Vec<u64>) -> MarketOfEvents {
        let key = EventSetKey::of(&event_ids);
        MarketOfEvents {
            canonical: key.ids(),
            listed_market: self.catalog.listed_by_set.get(&key).copied(),
            live_proposal: self
                .catalog
                .proposal_by_set
                .get(&key)
                .copied()
                .filter(|pid| self.proposal_is_live(*pid)),
        }
    }

    pub fn reference_market_of(&self, event_id: u64) -> Option<u64> {
        self.catalog.reference_market.get(&event_id).copied()
    }

    pub fn event_meta(&self, event_id: u64) -> Option<EventMetaView> {
        self.catalog
            .event_meta
            .get(&event_id)
            .map(|m| EventMetaView {
                event_id,
                proposal_id: m.proposal_id,
                proposer: m.proposer.clone(),
                source: m.source.clone(),
                category: m.category,
            })
    }

    /// The seed vault of a market opened from pledges.
    pub fn seed_vault(&self, scenario_id: u64) -> Option<SeedVaultView> {
        let vault = self.seed_vault_record(scenario_id)?;
        let positions = vault
            .positions
            .iter()
            .map(|slot| {
                let (amount0, amount1, fees) =
                    self.pools
                        .get(&slot.pool_id)
                        .map_or((0, 0, (0, 0)), |pool| {
                            let (a0, a1) = if slot.position.liquidity() == 0 {
                                (0, 0)
                            } else {
                                pool.amm
                                    .amounts_for_liquidity(
                                        slot.position.liquidity(),
                                        Rounding::Down,
                                    )
                                    .unwrap_or((0, 0))
                            };
                            (a0, a1, slot.position.pending_fees(&pool.amm))
                        });
                SeedPositionView {
                    pool_id: slot.pool_id,
                    liquidity: U128(slot.position.liquidity()),
                    amount0: U128(amount0),
                    amount1: U128(amount1),
                    fees0: U128(fees.0),
                    fees1: U128(fees.1),
                }
            })
            .collect();
        Some(SeedVaultView {
            proposal_id: vault.proposal_id,
            supply: U128(vault.supply),
            unlock_at_sec: vault.unlock_at_sec,
            positions,
            idle: vault
                .idle
                .iter()
                .map(|t| TokenAmount {
                    token_id: VerseKey::new(scenario_id, t.asset, t.mask).token_id(),
                    amount: U128(t.amount),
                })
                .collect(),
        })
    }

    /// What `seed_withdraw` of `shares` (default: all the account's shares)
    /// would pay now: real amounts, world tokens and, per world, what the
    /// account would hold before the merge (what the minimums compare).
    pub fn preview_seed_withdraw(
        &self,
        proposal_id: u64,
        account_id: AccountId,
        shares: Option<U128>,
    ) -> SeedWithdrawPreview {
        let (p, pledge) = self
            .opened_pledge(proposal_id, &account_id)
            .unwrap_or_else(|e| fail(&e));
        let sid = p.open.scenario_id;
        let vault = self
            .seed_vault_record(sid)
            .unwrap_or_else(|| fail!("NotOpen({proposal_id})"));
        let have = totals_of(&p)
            .shares(pledge.wnear, pledge.usdc)
            .saturating_sub(pledge.withdrawn_shares);
        let max_shares = self
            .depth_floor(sid, &vault, have)
            .map_or(have, |(_, max)| max);
        let shares = shares.map_or(have, |s| s.0);
        let exit = self.seed_exit_preview(sid, &vault, shares);
        let s = self.scenario(sid);
        let locked = now_sec() < vault.unlock_at_sec && !masks::is_single_world(s.possible);
        SeedWithdrawPreview {
            wnear_out: U128(exit.merged[0]),
            usdc_out: U128(exit.merged[1]),
            tokens: exit
                .tokens
                .iter()
                .map(|(k, a)| TokenAmount {
                    token_id: k.token_id(),
                    amount: U128(*a),
                })
                .collect(),
            max_shares: U128(max_shares),
            locked_until_sec: if locked { vault.unlock_at_sec } else { 0 },
            per_world: PerWorldAmounts {
                wnear: u128s(&exit.per_world[0]),
                usdc: u128s(&exit.per_world[1]),
            },
        }
    }

    /// v1 `EventView` per id, in order; at most 24 ids.
    pub fn get_events(&self, event_ids: Vec<u64>) -> Vec<EventView> {
        if event_ids.len() > MAX_EVENT_IDS {
            fail!("TooManyIds({}, {MAX_EVENT_IDS})", event_ids.len());
        }
        event_ids.into_iter().map(|id| self.get_event(id)).collect()
    }
}

/// The planner at `s` for these pledges; None when it cannot plan.
fn plan_of(
    p: &Proposal,
    s: u128,
    q: &[u128],
    prices: &[u128],
    wnear: u128,
    usdc: u128,
) -> Option<SeedPlan> {
    seed::seed_plan(&SeedInput {
        world_count: p.world_count,
        q,
        p: prices,
        s,
        beta: p.beta,
        pledged_wnear: wnear,
        pledged_usdc: usdc,
    })
    .ok()
}

impl Contract {
    /// The proposal for lists: status without the ready/waiting split, and
    /// as blocker only what the status, the oracle and the slots say (no
    /// pricing, so a list stays cheap).
    fn summary(&self, pid: u64, p: &Proposal, with_rule: bool) -> ProposalSummary {
        let (status, reason) = self.effective_status(p);
        let new_event = self.new_event_view(pid, p).map(|e| NewEventSummary {
            question: e.question,
            outcome_names: e.outcome_names,
            deadline_sec: e.deadline_sec,
            category: e.category,
            terms: e.terms,
        });
        let _ = with_rule;
        let opened = (p.status == ProposalStatus::Opened).then(|| OpenedView {
            scenario_id: p.open.scenario_id,
            opened_at_sec: p.open.opened_at_sec,
            s_ref: U128(p.open.s_ref),
            shares: U128(p.open.shares),
            unlock_at_sec: self
                .seed_vault_record(p.open.scenario_id)
                .map_or(0, |v| v.unlock_at_sec),
        });
        let (pledged_wnear, pledged_usdc) = if p.status == ProposalStatus::Opened {
            (p.open.pledged_wnear, p.open.pledged_usdc)
        } else {
            (p.escrow_wnear, p.escrow_usdc)
        };
        let progress = checked_mul_div(p.pledged_value(), BPS_DENOM, p.goal.max(1), Rounding::Down)
            .unwrap_or(u128::MAX);
        let blocker = if matches!(status, ProposalStatus::Review | ProposalStatus::Pledging) {
            self.cheap_blocker(pid, p)
        } else {
            None
        };
        ProposalSummary {
            proposal_id: pid,
            kind: p.kind,
            proposer: p.proposer.clone(),
            status,
            void_reason: (status == ProposalStatus::Void).then_some(reason),
            blocker,
            event_ids: p.event_ids(),
            world_count: p.world_count,
            new_event,
            category: p.category,
            deadline_sec: p.deadline_sec,
            created_at_sec: p.created_at_sec,
            approved_at_sec: p.approved_at_sec,
            expires_at_sec: p.expires_at_sec,
            open_not_before_sec: p.open_not_before_sec,
            goal: U128(p.goal),
            ideal_wnear: U128(p.ideal_wnear),
            ideal_usdc: U128(p.ideal_usdc),
            s_hint: U128(p.s_hint),
            pledged_wnear: U128(pledged_wnear),
            pledged_usdc: U128(pledged_usdc),
            pledgers: p.pledgers,
            progress_bps: u32::try_from(progress).unwrap_or(u32::MAX),
            bond: U128(p.bond),
            reserve: U128(p.reserve),
            seed_lock_sec: p.seed_lock_sec,
            opened,
        }
    }

    /// `open_check`'s steps that read no pool: pause, approval, notice, the
    /// events' oracle.
    fn cheap_blocker(&self, pid: u64, p: &Proposal) -> Option<String> {
        if self.pause.is_paused(PauseFlag::Mint) {
            return Some("Paused(mint)".to_string());
        }
        if p.status == ProposalStatus::Review {
            return Some(format!("NotApproved({pid})"));
        }
        if now_sec() < p.open_not_before_sec {
            return Some(format!("NoticePeriod({pid}, {})", p.open_not_before_sec));
        }
        p.event_ids()
            .into_iter()
            .find(|e| self.has_open_proposal(*e))
            .map(|e| format!("EventDeciding({e})"))
    }

    /// A new event's texts and terms: from the proposal while it is live,
    /// from the event and its meta once opened; None for a combination or
    /// an ended proposal.
    fn new_event_view(&self, pid: u64, p: &Proposal) -> Option<NewEventView> {
        if p.kind != ProposalKind::NewEvent {
            return None;
        }
        if let Some(t) = self.catalog.texts.get(&pid) {
            return Some(NewEventView {
                question: t.question.clone(),
                outcome_names: t.outcome_names.clone(),
                rule: t.rule.clone(),
                source: t.source.clone(),
                deadline_sec: p.deadline_sec,
                category: p.category,
                terms: p.terms,
            });
        }
        let eid = *p.event_ids().first()?;
        let e = self.events.get(&eid)?;
        Some(NewEventView {
            question: e.question.clone(),
            outcome_names: e.outcome_names.clone(),
            rule: e.rule.clone(),
            source: self
                .catalog
                .event_meta
                .get(&eid)
                .map_or_else(String::new, |m| m.source.clone()),
            deadline_sec: p.deadline_sec,
            category: p.category,
            terms: p.terms,
        })
    }

    /// Live combination proposals on any of `events`, at most `max`.
    fn live_summaries(&self, events: &[u64], max: usize) -> Vec<ProposalSummary> {
        let mut seen: Vec<u64> = Vec::new();
        let mut out = Vec::new();
        for e in events {
            for pid in self
                .catalog
                .live_of_event
                .get(e)
                .cloned()
                .unwrap_or_default()
            {
                if out.len() >= max || seen.contains(&pid) {
                    continue;
                }
                seen.push(pid);
                if let Some(p) = self.get_proposal_record(pid) {
                    if self.proposal_is_live(pid) {
                        out.push(self.summary(pid, &p, false));
                    }
                }
            }
        }
        out
    }

    fn pledge_view(
        &self,
        pid: u64,
        account: &AccountId,
        pledge: &Pledge,
        p: &Proposal,
    ) -> PledgeView {
        let opened = p.status == ProposalStatus::Opened;
        let totals = totals_of(p);
        let shares = totals.shares(pledge.wnear, pledge.usdc);
        let (unused_wnear, unused_usdc) = if opened && !pledge.unused_paid {
            totals.unused(pledge.wnear, pledge.usdc)
        } else {
            (0, 0)
        };
        let vault = opened
            .then(|| self.seed_vault_record(p.open.scenario_id))
            .flatten();
        let have = shares.saturating_sub(pledge.withdrawn_shares);
        let max_withdrawable = match &vault {
            Some(v) => self
                .depth_floor(p.open.scenario_id, v, have)
                .map_or(have, |(_, max)| max),
            None => 0,
        };
        let state = if opened {
            PledgeState::Seed
        } else if self.effective_status(p).0.is_terminal() {
            PledgeState::Refundable
        } else {
            PledgeState::Pledged
        };
        PledgeView {
            proposal_id: pid,
            account_id: account.clone(),
            wnear: U128(pledge.wnear),
            usdc: U128(pledge.usdc),
            state,
            shares: opened.then_some(U128(shares)),
            withdrawn_shares: U128(pledge.withdrawn_shares),
            unused_wnear: U128(unused_wnear),
            unused_usdc: U128(unused_usdc),
            unused_paid: pledge.unused_paid,
            unlock_at_sec: vault.map_or(0, |v| v.unlock_at_sec),
            max_withdrawable_shares: U128(max_withdrawable),
        }
    }

    /// `(S_ref, odds, prices)` a live proposal would open at now.
    fn preview_shape(&self, p: &Proposal) -> Option<(u128, Vec<u128>, Vec<u128>)> {
        let params = self.market_params_stored();
        let s_ref = self.spot_reference(&params).ok()?.s_ref;
        let shape = match p.kind {
            ProposalKind::Market => self.kind_b_shape(&p.event_ids(), s_ref, &params).ok()?,
            ProposalKind::NewEvent => self.kind_a_shape(&p.terms, s_ref, &params).ok()?,
        };
        Some((s_ref, shape.q, shape.p))
    }

    /// One market of the list (SPEC-C 3.9 `MarketCard`).
    pub(crate) fn market_card(&self, sid: u64) -> Option<MarketCard> {
        let s = self.scenarios.get(&sid)?;
        let entry = self.market_entry(sid);
        let n = usize::from(s.world_count);
        let (odds, odds_known) = self.odds_of(sid);
        let mut world_prices = vec![0u128; n];
        let mut pool_value = 0u128;
        let mut min_world_depth: Option<u128> = None;
        for w in 0..s.world_count {
            let Some(pool) = self.world_pool(sid, w).and_then(|id| self.pools.get(&id)) else {
                if masks::contains(s.possible, w) {
                    min_world_depth = Some(0);
                }
                continue;
            };
            let (r0, r1) = pool.amm.reserves();
            let price = pool.amm.price_wad().unwrap_or(0);
            world_prices[usize::from(w)] = price;
            pool_value = pool_value
                .saturating_add(mul(odds[usize::from(w)], r1.saturating_add(mul(r0, price))));
            if masks::contains(s.possible, w) {
                min_world_depth = Some(min_world_depth.map_or(r1, |d| d.min(r1)));
            }
        }
        for &(x, y) in multiverse_math::odds::pairs(s.world_count) {
            let Some(pool) = self
                .between
                .get(&(sid, x, y))
                .and_then(|id| self.pools.get(id))
            else {
                continue;
            };
            let (rx, ry) = pool.amm.reserves();
            let q_of = |mask: u8| -> u128 {
                (0..s.world_count)
                    .filter(|w| masks::contains(mask, *w))
                    .map(|w| odds[usize::from(w)])
                    .sum()
            };
            pool_value = pool_value
                .saturating_add(mul(rx, q_of(x)))
                .saturating_add(mul(ry, q_of(y)));
        }
        let implied_spot = if odds_known {
            self.implied_spot_of(sid)
        } else {
            0
        };
        let cfg = self.price_cfg(sid);
        let trusted = (0..s.world_count)
            .filter(|w| masks::contains(s.possible, *w))
            .all(|w| self.world_quote(sid, w, &cfg).status == WorldStatus::Trusted);
        let lendable = trusted && (!cfg.reference || self.twap_odds(sid, &cfg).is_some());
        let deadline_sec = s
            .event_ids
            .iter()
            .filter(|e| !self.is_finalized(**e))
            .filter_map(|e| self.events.get(e).map(|d| d.deadline_sec))
            .filter(|d| *d > 0)
            .min()
            .unwrap_or(0);
        let seed = self.seed_vault_record(sid).map(|v| SeedSummary {
            proposal_id: v.proposal_id,
            supply: U128(v.supply),
            unlock_at_sec: v.unlock_at_sec,
        });
        Some(MarketCard {
            scenario_id: sid,
            listed: entry.listed,
            origin: entry.origin,
            proposal_id: (entry.proposal_id != 0).then_some(entry.proposal_id),
            event_ids: s.event_ids.clone(),
            world_count: s.world_count,
            possible: s.possible,
            status: card_status(self, s),
            categories: s
                .event_ids
                .iter()
                .map(|e| self.catalog.event_meta.get(e).map_or(0, |m| m.category))
                .collect(),
            deadline_sec,
            created_at_sec: entry.created_at_sec,
            odds: u128s(&odds),
            odds_known,
            world_prices: u128s(&world_prices),
            implied_spot: U128(implied_spot),
            pool_value: U128(pool_value),
            min_world_depth: U128(min_world_depth.unwrap_or(0)),
            pool_count: s.pool_ids.len() as u32,
            lendable,
            seed,
        })
    }
}
