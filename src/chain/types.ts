import type { JsonObject } from '../shared/index.js'

export interface Call { to: string; data: string; value: string }
export interface Approval { token: string; spender: string; amount: string; resetBelow?: string }
export interface Guard {
  contract: 'oreVein' | 'freeMine'; method: string; args: string[]; expected: string
}
export interface PlannedStep { code: string; call: Call; approval?: Approval }
export interface Plan { steps: PlannedStep[]; summary: JsonObject; guards: Guard[] }
export interface SignedTransaction { raw: string; hash: string; nonce: number; maxFee: string }
export interface Receipt {
  hash: string; blockNumber: number; status: number; fee: string
  logs: { address: string; topics: string[]; data: string }[]
}
export interface TransactionTransport {
  owner: string
  assertOwner(): Promise<void>
  validate(guards: Guard[]): Promise<void>
  allowance(approval: Approval): Promise<bigint>
  sign(call: Call, remainingGas: bigint, approval?: Approval): Promise<SignedTransaction>
  broadcast(raw: string): Promise<void>
  receipt(hash: string): Promise<Receipt | null>
  nonce(): Promise<number>
  replacement(hash: string, signed: SignedTransaction): Promise<{ receipt: Receipt; matches: boolean }>
}
