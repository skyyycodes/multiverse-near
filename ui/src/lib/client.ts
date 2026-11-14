// The redesign's in-browser model client (lib/scenario.ts). It signs nothing. Screens move off it to the chain
// adapter (src/chain/adapter.tsx) one by one; this file goes once none uses it.
import { actions } from './scenario'

export type Asset = 'near' | 'usdc'

export interface ModelClient {
  readonly live: boolean // always false: the model
  deposit(scenario: string, asset: Asset, amount: number, via: string): Promise<void>
  sellMask(scenario: string, mask: number, minUsdc: number): Promise<void>
  claimAll(scenario: string): Promise<void>
  addRootLiquidity(scenario: string, amount: number): Promise<void>
  supply(amount: number): Promise<void>
  borrow(scenario: string, amount: number): Promise<void>
  repay(scenario: string, amount: number): Promise<void>
  getTestTokens(account: string): Promise<void>
  propose(scenario: string, event: number, outcome: number): Promise<void>
  dispute(scenario: string, event: number): Promise<void>
  finalize(scenario: string, event: number): Promise<void>
}

export const mockClient: ModelClient = {
  live: false,
  async deposit(scenario, asset, amount, via) { actions.deposit(scenario, asset, amount, via) },
  async sellMask(scenario, mask) { actions.sell(scenario, mask) },
  async claimAll(scenario) { actions.claimAll(scenario) },
  async addRootLiquidity(scenario, amount) { actions.addLiquidity(scenario, amount) },
  async getTestTokens() { actions.faucet() },
  async supply(amount) { actions.lend(amount) },
  async borrow(scenario, amount) { actions.borrow(scenario, amount) },
  async repay(scenario, amount) { actions.repay(scenario, amount) },
  async propose(scenario, event, outcome) { actions.propose(scenario, event, outcome) },
  async dispute(scenario, event) { actions.dispute(scenario, event) },
  async finalize(scenario, event) { actions.finalize(scenario, event) },
}
