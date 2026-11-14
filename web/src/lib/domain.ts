// The app's own shapes: view JSON decoded once at the edge, so screens and the pure helpers work on bigint.
import type { Order } from "./orders";
import type { Asset } from "./types";

/** A lending tier of a market (SPEC-contract 2.4 `Tier`); Normal is what a call means when it names none. */
export type Tier = "safe" | "normal" | "bold";
export type PauseFlag = "trade" | "mint" | "transfer" | "lend" | "liquidate" | "oracle" | "pledge" | "exit";
/** How a world prices lending (SPEC-contract 3.5.1). */
export type WorldStatus = "no_pool" | "young" | "shallow" | "out_of_band" | "trusted";

export type World = {
  index: number;
  mask: number;
  label: string;
  possible: boolean;
  poolInitialized: boolean;
  /** The pool's spot price, USDC per NEAR (lending uses the TWAP, not this). */
  wnearPrice: bigint;
  backed: boolean;
  wnearTokenId: string;
  usdcTokenId: string;
  /** NEP-245 balances outside lending. */
  userWnear: bigint;
  userUsdc: bigint;
  collateralWnear: bigint;
  collateralUsdc: bigint;
  odds: bigint;
  poolId: number | null;
};

export type Scenario = {
  scenarioId: number;
  worldCount: number;
  possible: number;
  resolutionCount: number;
  halted: boolean;
  eventIds: number[];
  spotPrice: bigint;
  worlds: World[];
  oddsKnown: boolean;
  impliedSpot: bigint;
};

/** `get_scenario`: what a market is made of, without prices (the market guard's existence check). */
export type ScenarioInfo = {
  scenarioId: number;
  eventIds: number[];
  outcomeCounts: number[];
  worldCount: number;
  root: number;
  possible: number;
  resolutionCount: number;
  resolvedEvents: number;
  halted: boolean;
  poolIds: number[];
};

export type ProposalSource = "admin" | "reporter" | "outlayer";

export type EventState = {
  id: number;
  question: string;
  rule: string;
  outcomeNames: string[];
  deadline: bigint;
  /** 0 when never proposed; kept after a dispute, which is how the UI can say "was disputed". */
  proposedAt: bigint;
  proposedOutcome: number;
  proposalOpen: boolean;
  finalized: boolean;
  outcome: number;
  /** 0 unless a proposal is open. */
  finalizableAt: bigint;
  proposedBy: ProposalSource | null;
};

export type ImpactPoint = { at: number; prices: bigint[] };

export type Collateral = {
  tokenId: string;
  label: string;
  asset: Asset;
  mask: number;
  isReal: boolean;
  amount: bigint;
};

export type LiquidationState = "none" | "paused" | "paused_halted" | "paused_reference" | "paused_no_price" | "liquidatable";

export type Account = {
  debt: bigint;
  /** null means no debt (infinite). */
  healthFactor: bigint | null;
  worstWorld: number | null;
  collateralValues: bigint[];
  worldPriceOk: boolean[];
  collateral: Collateral[];
  supplied: bigint;
  supplyPrincipal: bigint;
  marketSupply: bigint;
  marketBorrow: bigint;
  utilization: bigint;
  borrowRatePerSecond: bigint;
  supplyRatePerSecond: bigint;
  lltv: bigint;
  liquidation: LiquidationState;
  unpricedWorld: number | null;
  // v2 (SPEC-contract 3.9 AccountView). From a v1 view, which the version gate never lets a screen show, they read
  // as v1 behaved: one Normal tier lent up to its lltv, no cushion, no minimum, no insurance, every world trusted
  // where it had a price.
  tier: Tier;
  borrowLtv: bigint;
  /** HF against the borrow-side values (min(spot, TWAP) × factor, × borrow LTV); null without debt. */
  borrowHealthFactor: bigint | null;
  borrowLimit: bigint;
  maxBorrow: bigint;
  liquidationBonus: bigint;
  insurance: bigint;
  minLoan: bigint;
  frozen: boolean;
  maxRepay: bigint;
  writeOffReady: boolean;
  /** One per world of the scenario. */
  worldStatus: WorldStatus[];
  borrowBlock: string | null;
  liquidationFactor: bigint;
};

export type RootLp = {
  shareSupply: bigint;
  yourShares: bigint;
  shareDecimals: number;
  previewWithdraw: { wnear: bigint[]; usdc: bigint[] } | null;
  holdings: { world: number; wnearIdle: bigint; usdcIdle: bigint; wnearFees: bigint; usdcFees: bigint }[];
};

export type LpPreview = { shares: bigint; wnearKept: bigint[]; usdcKept: bigint[] };

export type TradeSnapshot = { scenario: Scenario; events: EventState[]; orders: Order[]; impact: ImpactPoint[]; nowSec: bigint };
export type BorrowSnapshot = { scenario: Scenario; account: Account; nowSec: bigint };
export type LendSnapshot = { account: Account; rootLp: RootLp | null; worlds: { index: number; mask: number; label: string; possible: boolean }[] };
export type ResolveSnapshot = { scenario: Scenario; events: EventState[]; pastFedEvent: EventState | null; account: Account; nowSec: bigint };
export type AdminSnapshot = { scenario: Scenario; events: EventState[]; pastFedEvent: EventState | null; ownerId: string; nowSec: bigint };

export type TokenCfg = { tokenId: string; decimals: number; symbol: string };

export type DemoIds = {
  spiceEvent: number | null;
  fedEvent: number | null;
  pastFedEvent: number | null;
  scenario2x2: number | null;
  scenarioBinary: number | null;
};

export type TierConfig = {
  lltv: bigint;
  borrowLtv: bigint;
  liquidationBonus: bigint;
  reserveFactor: bigint;
  rateBase: bigint;
  rateSlope1: bigint;
  rateSlope2: bigint;
  rateKink: bigint;
  maxUtilization: bigint;
  /** null: no cap. */
  borrowCap: bigint | null;
};

export type LendingConfig = {
  minLoan: bigint;
  fullLiquidationHf: bigint;
  smallLoan: bigint;
  closeFactor: bigint;
  maxCollateralPieces: number;
  defaults: Record<Tier, TierConfig>;
};

export type AppConfig = {
  ownerId: string;
  reporterId: string | null;
  wnear: TokenCfg;
  usdc: TokenCfg;
  lltv: bigint;
  liquidationBonus: bigint;
  borrowRatePerSec: bigint;
  disputeWindowSec: number;
  twapWindowSec: number;
  minPoolDepth: bigint;
  orderBook: boolean;
  rootLp: boolean;
  demo: DemoIds | null;
  // v2 keys; a v1 config reads as state version 1 (the version gate turns it away).
  codeVersion: string;
  stateVersion: number;
  paused: PauseFlag[];
  guardianId: string | null;
  pendingOwnerId: string | null;
  maxWorlds: number;
  maxEvents: number;
  maxTradeFills: number;
  maxTradeFills8w: number;
  referenceConfigured: boolean;
  proposalCount: number;
  spotPoolId: number | null;
  eventCount: number;
  scenarioCount: number;
  lending: LendingConfig;
};

export const worldIndex = (mask: number): number => {
  let i = 0;
  while (i < 8 && ((mask >> i) & 1) === 0) i++;
  return i;
};

export const isPossible = (possible: number, index: number) => ((possible >> index) & 1) === 1;

// ---- v2 shapes (camelCase, bigint amounts) of the SPEC-contract 3.9 views ----

export type ContractVersion = {
  codeVersion: string;
  /** 1 for a contract without `contract_version` (v1). */
  stateVersion: number;
  recordedCodeVersion: string;
  upgradedAtSec: number;
  upgradedFrom: string;
  eventVersion: string;
  legacyScenarioCount: number;
};

export type PauseState = {
  paused: PauseFlag[];
  sinceSec: bigint;
  liquidationsResumeAtSec: bigint;
  guardianId: string | null;
  pendingOwnerId: string | null;
};

export type BooksAsset = {
  reserves: bigint;
  lendingCash: bigint;
  insurance: bigint;
  internal: bigint;
  collateral: bigint;
  spotPool: bigint;
  pledges: bigint;
  total: bigint;
};
export type Books = { fromScenario: number; nextScenario: number | null; wnear: BooksAsset; usdc: BooksAsset };
/** yoctoNEAR; `ownFree` may be negative (M-13 broken). */
export type NearBooks = { balance: bigint; storageStake: bigint; nep145Available: bigint; nearHeld: bigint; storageFund: bigint; ownFree: bigint };

export type WorldSupply = { scenarioId: number; possible: number; wnearReserves: bigint; usdcReserves: bigint; wnear: bigint[]; usdc: bigint[] };

export type WorldPrice = {
  world: number;
  status: WorldStatus;
  twap: bigint;
  spot: bigint;
  borrowPrice: bigint;
  liquidationPrice: bigint;
  depth: bigint;
  ageSec: number;
  fullWindow: boolean;
};
export type MarketPriceCfg = { minAgeSec: number; minDepth: bigint; reference: boolean; maxDeviation: bigint; maxHaircut: bigint };
export type ReferenceSource = "none" | "outlayer" | "reporter";
export type PriceCheck = {
  scenarioId: number;
  config: MarketPriceCfg;
  reference: null | { price: bigint; observedAt: number; ageSec: number; source: ReferenceSource; sourcesUsed: number; spreadBps: number };
  impliedTwapSpot: bigint | null;
  ratio: bigint | null;
  borrowBlock: string | null;
  borrowFactor: bigint;
  liquidationFactor: bigint;
  liquidationGuard: boolean;
};
export type Reference = {
  price: bigint;
  observedAt: number;
  storedAt: number;
  ageSec: number;
  source: string;
  sourcesUsed: number;
  spreadBps: number;
  request: number;
  pending: boolean;
};
export type ResourceLimits = { maxInstructions: number; maxMemoryMb: number; maxExecutionSeconds: number };
export type GuestConfig = { outlayerId: string; wasmUrl: string; wasmSha256: string; resourceLimits: ResourceLimits; deposit: bigint };
export type ReferenceConfig = {
  enabled: boolean;
  guest: GuestConfig | null;
  reporterId: string | null;
  minSources: number;
  maxSpreadBps: number;
  maxResultDelaySec: number;
  borrowMaxAgeSec: number;
  liquidationMaxAgeSec: number;
  minPrice: bigint;
  maxPrice: bigint;
};
export type OutLayerConfig = GuestConfig;
export type FomcDates = { before: string; after: string; pending: boolean; request: number };

export type LendingMarket = {
  tier: Tier;
  totalSupply: bigint;
  totalBorrow: bigint;
  totalSupplyShares: bigint;
  totalBorrowShares: bigint;
  utilization: bigint;
  supplyRatePerSec: bigint;
  borrowRatePerSec: bigint;
  lastUpdateSec: number;
  insurance: bigint;
  /** Cash a borrower can take now. */
  liquid: bigint;
  badDebtCovered: bigint;
  badDebtSocialized: bigint;
  borrowers: number;
  frozen: boolean;
  config: TierConfig;
};
export type TierConfigResult = { config: TierConfig; frozen: boolean; source: "stored" | "default" };
export type LendingTier = { tier: Tier; market: LendingMarket; account: Account | null };
export type LiquidationStatus = {
  status: LiquidationState;
  unpricedWorld: number | null;
  tier: Tier;
  maxRepay: bigint;
  fullSeizeRepay: bigint;
  writeOffReady: boolean;
};
export type HealthView = { healthFactor: bigint | null; worstWorld: number | null };
export type CollateralValues = { values: bigint[]; possible: number };
export type BorrowerRow = {
  index: number;
  accountId: string;
  debt: bigint;
  healthFactor: bigint | null;
  worstWorld: number | null;
  cMin: bigint;
  liquidation: LiquidationState;
  unpricedWorld: number | null;
  maxRepay: bigint;
  fullSeizeRepay: bigint;
  writeOffReady: boolean;
};
export type BorrowersPage = {
  scenarioId: number;
  tier: Tier;
  total: number;
  fromIndex: number;
  nextIndex: number | null;
  nowSec: bigint;
  rows: BorrowerRow[];
};
export type LiquidationQuote = {
  error: string | null;
  liquidation: LiquidationState;
  debt: bigint;
  healthFactor: bigint | null;
  cap: bigint;
  fullSeizeRepay: bigint;
  repay: bigint;
  target: bigint;
  seizeAll: boolean;
  writtenOff: bigint;
  priceFactor: bigint;
  pieces: { piece: string; held: bigint; seized: bigint }[];
  cash: null | {
    sold: bigint[];
    received: bigint[];
    merged: bigint;
    realUsdc: bigint;
    redeemed: bigint;
    cash: bigint;
    leftUsdc: bigint[];
    dead: string[];
    guardOk: boolean;
  };
};

export type MarketStatus = "open" | "deciding" | "partly_resolved" | "resolved";
export type MarketOrigin = "legacy" | "owner" | "pledged";
export type MarketCard = {
  scenarioId: number;
  listed: boolean;
  origin: MarketOrigin;
  proposalId: number | null;
  eventIds: number[];
  worldCount: number;
  possible: number;
  status: MarketStatus;
  categories: number[];
  deadlineSec: number;
  createdAtSec: number;
  odds: bigint[];
  oddsKnown: boolean;
  worldPrices: bigint[];
  impliedSpot: bigint;
  poolValue: bigint;
  minWorldDepth: bigint;
  poolCount: number;
  /** Borrowing is open (every world trusted, and with the outside check on, every odds pool deep enough). */
  lendable: boolean;
  seed: null | { proposalId: number; supply: bigint; unlockAtSec: number };
};
export type MarketList = { markets: MarketCard[]; nextFrom: number | null };
export type RelatedMarket = { scenarioId: number; eventIds: number[]; worldCount: number; status: MarketStatus; listed: boolean };
export type RelatedMarkets = { markets: RelatedMarket[]; proposals: ProposalSummary[] };
export type MarketOfEvents = { canonical: number[]; listedMarket: number | null; liveProposal: number | null };

export type ProposalStatus = "review" | "pledging" | "ready" | "waiting" | "opened" | "rejected" | "cancelled" | "expired" | "void";
export type ProposalKind = "new_event" | "market";
export type VoidReason = "none" | "review_timeout" | "event_resolved" | "event_full" | "market_exists" | "evicted";
export type OpeningTerms = { odds0Bps: number; multBps: [number, number] };
export type NewEvent = {
  question: string;
  outcomeNames: string[];
  /** Absent in list summaries. */
  rule?: string;
  source?: string;
  deadlineSec: number;
  category: number;
  terms: OpeningTerms;
};
export type Opened = { scenarioId: number; openedAtSec: number; sRef: bigint; shares: bigint; unlockAtSec: number };
export type ProposalSummary = {
  proposalId: number;
  kind: ProposalKind;
  proposer: string;
  /** Lists never say ready/waiting; the proposal page does. */
  status: ProposalStatus;
  voidReason: VoidReason | null;
  blocker: string | null;
  eventIds: number[];
  worldCount: number;
  newEvent: NewEvent | null;
  category: number;
  deadlineSec: number;
  createdAtSec: number;
  approvedAtSec: number;
  expiresAtSec: number;
  openNotBeforeSec: number;
  goal: bigint;
  idealWnear: bigint;
  idealUsdc: bigint;
  sHint: bigint;
  pledgedWnear: bigint;
  pledgedUsdc: bigint;
  pledgers: number;
  progressBps: number;
  bond: bigint;
  reserve: bigint;
  seedLockSec: number;
  opened: Opened | null;
};
export type Proposal = ProposalSummary & { preview: OpeningPreview | null };
export type ProposalList = { proposals: ProposalSummary[]; nextFrom: number | null };
export type TokenAmount = { tokenId: string; amount: bigint };
export type OpeningPreview = {
  canOpen: boolean;
  blocker: string | null;
  sRef: bigint | null;
  anchors: { scenarioId: number; implied: bigint }[];
  references: { eventId: number; scenarioId: number; odds0: bigint; ratio0: bigint; ratio1: bigint; implied: bigint }[];
  odds: bigint[];
  prices: bigint[];
  usableValue: bigint;
  usedWnear: bigint;
  usedUsdc: bigint;
  unusedWnear: bigint;
  unusedUsdc: bigint;
  worldPools: { world: number; wnear: bigint; usdc: bigint }[];
  oddsPools: { mask0: number; mask1: number; amount0: bigint; amount1: bigint }[];
  idle: TokenAmount[];
  idleValue: bigint;
  thinnestWorldUsdc: bigint;
  needs: Asset | null;
  storageEstimate: bigint;
  reserveAvailable: bigint;
};
export type Pledge = {
  proposalId: number;
  accountId: string;
  wnear: bigint;
  usdc: bigint;
  state: "pledged" | "refundable" | "seed";
  shares: bigint | null;
  withdrawnShares: bigint;
  unusedWnear: bigint;
  unusedUsdc: bigint;
  unusedPaid: boolean;
  unlockAtSec: number;
  maxWithdrawableShares: bigint;
};
export type PledgePreview = { usableBefore: bigint; usableAfter: bigint; deployedPart: bigint; goalReachedAfter: boolean; needs: Asset | null };
/** `MarketParams` (33 fields); NEAR amounts in yocto, USDC amounts in 18-decimal units. */
export type MarketParams = {
  bondNewEvent: bigint;
  bondMarket: bigint;
  reserveBase: bigint;
  reservePerWorld: bigint;
  proposalTtlSec: number;
  reviewTtlSec: number;
  minPledgeWindowSec: number;
  minMarketLifeSec: number;
  noticeSec: number;
  seedLockSec: number;
  evictMinAgeSec: number;
  spamFloorBps: number;
  goalDepthUsdc: bigint;
  minOpenDepthUsdc: bigint;
  minGoalUsdc: bigint;
  goalRoundUsdc: bigint;
  betaBps: number;
  oddsClampBps: number;
  multABps: [number, number];
  multBBps: [number, number];
  anchors: [number, number, number];
  maxAnchorDivergenceBps: number;
  maxReferenceDivergenceBps: number;
  minReferenceDepthUsdc: bigint;
  minReferenceOddsDepthUsdc: bigint;
  requireExternal: boolean;
  maxExternalDivergenceBps: number;
  minPledgeUsdc: bigint;
  minPledgeWnear: bigint;
  maxPledgesPerAccount: number;
  maxActivePerAccount: number;
  maxLivePerEvent: number;
  seedDepthFloor: boolean;
};
export type MarketParamsView = { params: MarketParams; reserveW2: bigint; reserveW4: bigint; reserveW8: bigint; storageFund: bigint };
export type MarketCheck = {
  canonical: number[];
  worldCount: number;
  blocker: string | null;
  listedMarket: number | null;
  liveProposal: number | null;
  goal: bigint;
  idealWnear: bigint;
  idealUsdc: bigint;
  bond: bigint;
  reserve: bigint;
  expiresAtSec: number;
};
export type EventCheck = {
  blocker: string | null;
  liveProposal: number | null;
  goal: bigint;
  idealWnear: bigint;
  idealUsdc: bigint;
  sRef: bigint | null;
  odds: [bigint, bigint];
  prices: [bigint, bigint];
  bond: bigint;
  reserve: bigint;
};
export type EventMeta = { eventId: number; proposalId: number; proposer: string | null; source: string; category: number };
export type SeedVault = {
  proposalId: number;
  supply: bigint;
  unlockAtSec: number;
  positions: { poolId: number; liquidity: bigint; amount0: bigint; amount1: bigint; fees0: bigint; fees1: bigint }[];
  idle: TokenAmount[];
};
export type SeedPreview = {
  wnearOut: bigint;
  usdcOut: bigint;
  tokens: TokenAmount[];
  maxShares: bigint;
  lockedUntilSec: number;
  perWorld: { wnear: bigint[]; usdc: bigint[] };
};
/** A NEP-245 verse token the account holds: `<scenario>:<asset>:<mask>`. */
export type Holding = { tokenId: string; scenarioId: number; asset: Asset; mask: number; amount: bigint };
