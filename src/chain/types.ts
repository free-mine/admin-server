import type { Action } from '../requests/index.js'
import type { JsonObject } from '../shared/index.js'

export interface Call {
  to: string
  data: string
  value: string
}
export interface Approval {
  token: string
  amount: string
  spender: string
}
export type Guard =
  | {
      method: string
      args: string[]
      expected: string
      contract: 'oreVein' | 'freeMine'
    }
  | {
      fee: number
      token0: string
      token1: string
      budget0: string
      budget1: string
      tickLower: number
      tickUpper: number
      amount0Desired: string
      amount1Desired: string
      contract: 'uniswapPool'
      minimumSqrtPriceX96: string
      maximumSqrtPriceX96: string
      initialSqrtPriceX96?: string
    }
export type PlannedStep = { call: Call } & (
  | { code: 'EXECUTE'; approval?: never }
  | { approval: Approval; code: 'ALLOWANCE_APPROVE' }
  | {
      code: 'ALLOWANCE_RESET'
      approval: Approval & { amount: '0'; resetBelow: string }
    }
)
export interface Plan {
  guards: Guard[]
  summary: JsonObject
  steps: PlannedStep[]
}
export interface SignedTransaction {
  raw: string
  hash: string
  nonce: number
  maxFee: string
}
export interface Receipt {
  fee: string
  hash: string
  status: number
  blockNumber: number
  logs: { data: string; address: string; topics: string[] }[]
}
export interface TransactionTransport {
  owner: string
  nonce(): Promise<number>
  readonly readOnly: boolean
  assertOwner(): Promise<void>
  broadcast(raw: string): Promise<void>
  validate(guards: Guard[]): Promise<void>
  allowance(approval: Approval): Promise<bigint>
  receipt(hash: string): Promise<Receipt | null>
  readResult(action: Action, receipt: Receipt): Promise<JsonObject | undefined>
  sign(
    call: Call,
    remainingGas: bigint,
    approval?: Approval,
  ): Promise<SignedTransaction>
  replacement(
    hash: string,
    signed: SignedTransaction,
  ): Promise<{ receipt: Receipt; matches: boolean }>
}
