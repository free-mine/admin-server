import type { PreviewRequest } from '../requests/index.js'
import type { RemoteRecord } from '../public-server/index.js'
import type { JsonObject, PublicError } from '../shared/index.js'
import type {
  Plan,
  Guard,
  Receipt,
  PlannedStep,
  SignedTransaction,
} from '../chain/index.js'

export type OperationStatus =
  'queued' | 'running' | 'waiting' | 'needs_attention' | 'succeeded' | 'failed'
export type StepStatus =
  | 'pending'
  | 'checking'
  | 'signing'
  | 'broadcasting'
  | 'confirming'
  | 'confirmed'
  | 'skipped'
  | 'failed'
export interface Preview {
  id: string
  expiresAt: number
  request: PreviewRequest
  plan: Omit<Plan, 'steps'> & { steps: PreviewStep[] }
}
export type GasEstimate =
  | { maxGasWei: string; status: 'estimated' | 'skipped' }
  | { maxGasWei: null; status: 'requires_prior_steps' }
export type PreviewStep = PlannedStep & { gasEstimate: GasEstimate }
export type OperationStep = PlannedStep & {
  id: number
  receipt?: Receipt
  status: StepStatus
  error?: PublicError
  signed?: SignedTransaction
}
export interface Operation {
  id: string
  version: number
  guards: Guard[]
  previewId: string
  requestId: string
  createdAt: number
  updatedAt: number
  expiresAt: number
  maxGasWei: string
  summary: JsonObject
  result?: JsonObject
  gasSpentWei: string
  error?: PublicError
  steps: OperationStep[]
  status: OperationStatus
  request: PreviewRequest
}
export interface OperationView extends Omit<Operation, 'guards' | 'steps'> {
  steps: {
    id: number
    code: string
    nonce?: number
    receipt?: Receipt
    status: StepStatus
    error?: PublicError
    transactionHash?: string
    approval?: PlannedStep['approval']
  }[]
}
export interface JournalData {
  format: 1
  owner: string
  chainId: number
  operations: Operation[]
}

export interface JournalTransactionStore {
  listTransactions(): Promise<RemoteRecord[]>
  getTransaction(id: string): Promise<RemoteRecord | undefined>
  putTransaction(
    id: string,
    data: JsonObject,
    revision: number | null,
  ): Promise<RemoteRecord>
}

export interface PendingOperation {
  operation: Operation
  baseRevision: number | null
  attempt?: {
    operation: Operation
    baseRevision: number | null
  }
}

export interface AcknowledgedOperation {
  revision: number
  operation: Operation
}

export interface ArchivedOperation {
  revision: number
}

export interface PendingJournal {
  format: 2
  owner: string
  chainId: number
  entries: PendingOperation[]
  active: AcknowledgedOperation[]
}

export interface JournalStatus {
  pending: number
  blocked: boolean
  connected: boolean
  historyLoaded: boolean
  lastError?: PublicError
}
