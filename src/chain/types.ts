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
  resetBelow?: string
}
export interface Guard {
  method: string
  args: string[]
  expected: string
  contract: 'oreVein' | 'freeMine'
}
export interface PlannedStep {
  call: Call
  code: string
  approval?: Approval
}
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
  assertOwner(): Promise<void>
  broadcast(raw: string): Promise<void>
  validate(guards: Guard[]): Promise<void>
  allowance(approval: Approval): Promise<bigint>
  receipt(hash: string): Promise<Receipt | null>
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
