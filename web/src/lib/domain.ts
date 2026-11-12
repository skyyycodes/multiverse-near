// The app's own shapes: view JSON decoded once at the edge, so screens and the pure helpers work on bigint.
import type { Order } from "./orders";
import type { Asset } from "./types";

export type World = {
  index: number;
  mask: number;
  label: string;
  possible: boolean;
  poolInitialized: boolean;
  /** The pool's spot price, USDC per WETH (lending uses the TWAP, not this). */
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

export type LiquidationState = "none" | "liquidatable" | "paused_halted" | "paused_no_price";

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
};

export const worldIndex = (mask: number): number => {
  let i = 0;
  while (i < 8 && ((mask >> i) & 1) === 0) i++;
  return i;
};

export const isPossible = (possible: number, index: number) => ((possible >> index) & 1) === 1;
