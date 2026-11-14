// The one door between the site and the contracts, shaped after the method table in BUILD_PLAN.md
// (ABI v0, until it is frozen at Gate 2). Pages call a client and never care which one they got:
//   mockClient  runs every call on the in-browser model (lib/scenario.ts)
//   nearClient  signs real transactions on the core and resolver contracts through NEAR Connect
// Amounts are in whole units (1.5 = 1.5 USDC); the NEAR client converts them to u128 strings.
import type { NearWalletBase } from '@hot-labs/near-connect'
import { chain } from '../config'
import { FAUCET, actions } from './scenario'

export type Asset = 'near' | 'usdc'

export interface OrigamiClient {
  readonly live: boolean // true when calls go on-chain
  // verse
  deposit(scenario: string, asset: Asset, amount: number, via: string): Promise<void>
  // router
  sellMask(scenario: string, mask: number, minUsdc: number): Promise<void>
  claimAll(scenario: string): Promise<void>
  // amm: one USDC deposit, depth in every world's pool (Root LP)
  addRootLiquidity(scenario: string, amount: number): Promise<void>
  // lending
  supply(amount: number): Promise<void>
  borrow(scenario: string, amount: number): Promise<void>
  repay(scenario: string, amount: number): Promise<void>
  // testnet faucet: mint test wNEAR and USDC to your account, and register it with the contract
  getTestTokens(account: string): Promise<void>
  // resolver
  propose(scenario: string, event: number, outcome: number): Promise<void>
  dispute(scenario: string, event: number): Promise<void>
  finalize(scenario: string, event: number): Promise<void>
}

// ---------- mock: the in-browser model ----------
export const mockClient: OrigamiClient = {
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

// ---------- NEAR: testnet contracts ----------
const DECIMALS: Record<Asset, number> = { near: 24, usdc: 6 }
const TGAS = 1_000_000_000_000n
const ONE_YOCTO = '1'

// whole units to a u128 string, without floating-point drift
export function toUnits(amount: number, decimals: number) {
  const [whole, frac = ''] = amount.toFixed(Math.min(decimals, 12)).split('.')
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString()
}

// read-only calls go straight to RPC; no wallet needed
export async function view<T>(contract: string, method: string, args: object = {}): Promise<T> {
  const res = await fetch(chain.rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'view', method: 'query',
      params: { request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
  })
  const json = await res.json()
  if (json.error || json.result?.error) throw new Error(json.error?.data ?? json.result.error)
  return JSON.parse(new TextDecoder().decode(new Uint8Array(json.result.result)))
}

export function nearClient(wallet: NearWalletBase): OrigamiClient {
  const call = (receiverId: string, methodName: string, args: object, deposit = '0', gas = 100n) =>
    wallet.signAndSendTransaction({
      receiverId,
      actions: [{ type: 'FunctionCall', params: { methodName, args, gas: (gas * TGAS).toString(), deposit } }],
    }).then(() => undefined)
  const core = (method: string, args: object, deposit = '0') => call(chain.core, method, args, deposit)
  const resolver = (method: string, args: object) => call(chain.resolver, method, args)
  const usdc = (amount: number) => toUnits(amount, DECIMALS.usdc)

  return {
    live: true,
    // NEP-141 deposit: the token calls core.ft_on_transfer, which mints the root mask
    deposit: (scenario, asset, amount) => call(
      asset === 'near' ? chain.wnear : chain.usdc,
      'ft_transfer_call',
      { receiver_id: chain.core, amount: toUnits(amount, DECIMALS[asset]), msg: JSON.stringify({ scenario_id: scenario }) },
      ONE_YOCTO, 150n,
    ),
    sellMask: (scenario, mask, minUsdc) => core('sell_mask', { scenario_id: scenario, asset: 'near', mask, min_usdc: usdc(minUsdc) }, ONE_YOCTO),
    claimAll: (scenario) => core('claim_all', { scenario_id: scenario }, ONE_YOCTO),
    addRootLiquidity: (scenario, amount) => call(chain.usdc, 'ft_transfer_call', { receiver_id: chain.core, amount: usdc(amount), msg: JSON.stringify({ action: 'root_lp', scenario_id: scenario }) }, ONE_YOCTO, 150n),
    supply: (amount) => call(chain.usdc, 'ft_transfer_call', { receiver_id: chain.core, amount: usdc(amount), msg: JSON.stringify({ action: 'supply' }) }, ONE_YOCTO, 150n),
    // the mock tokens have an open mint (capped per call); then the 0.1 NEAR NEP-145 storage deposit on the contract
    getTestTokens: async (account) => {
      await call(chain.wnear, 'mint', { account_id: account, amount: toUnits(FAUCET.near, DECIMALS.near) }, '0', 30n)
      await call(chain.usdc, 'mint', { account_id: account, amount: toUnits(FAUCET.usdc, DECIMALS.usdc) }, '0', 30n)
      await call(chain.core, 'storage_deposit', { account_id: account, registration_only: false }, toUnits(0.1, DECIMALS.near), 30n)
    },
    borrow: (scenario, amount) => core('borrow', { scenario_id: scenario, amount: usdc(amount) }),
    repay: (scenario, amount) => call(chain.usdc, 'ft_transfer_call', { receiver_id: chain.core, amount: usdc(amount), msg: JSON.stringify({ action: 'repay', scenario_id: scenario }) }, ONE_YOCTO, 150n),
    propose: (scenario, event, outcome) => resolver('propose', { scenario_id: scenario, event, outcome }),
    dispute: (scenario, event) => resolver('dispute', { scenario_id: scenario, event }),
    finalize: (scenario, event) => resolver('finalize', { scenario_id: scenario, event }),
  }
}

// a live client only with a real wallet and a configured core contract; otherwise the model
export const pickClient = (wallet: NearWalletBase | null): OrigamiClient => (wallet && chain.core ? nearClient(wallet) : mockClient)
