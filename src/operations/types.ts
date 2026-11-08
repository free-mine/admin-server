import type { Guard, Plan, PlannedStep, Receipt, SignedTransaction } from '../chain/index.js'
import type { PreviewRequest } from '../requests/index.js'
import type { JsonObject, PublicError } from '../shared/index.js'

export type OperationStatus = 'queued' | 'running' | 'waiting' | 'needs_attention' | 'succeeded' | 'failed'
export type StepStatus = 'pending' | 'checking' | 'signing' | 'broadcasting' | 'confirming' | 'confirmed' | 'skipped' | 'failed'
export interface Preview {
  id: string; expiresAt: number; request: PreviewRequest; plan: Plan
  estimates: { code: string; maxGasWei: string | null; status: 'estimated' | 'requires_prior_steps' | 'skipped' }[]
}
export interface OperationStep extends PlannedStep {
  id: number; status: StepStatus; signed?: SignedTransaction; receipt?: Receipt; error?: PublicError
}
export interface Operation {
  id: string; previewId: string; requestId: string; status: OperationStatus
  createdAt: number; updatedAt: number; version: number; expiresAt: number
  request: PreviewRequest; summary: JsonObject; guards: Guard[]; maxGasWei: string; gasSpentWei: string
  steps: OperationStep[]; error?: PublicError
}
export interface OperationView extends Omit<Operation, 'guards' | 'steps'> {
  steps: { id: number; code: string; status: StepStatus; approval?: PlannedStep['approval'];
    transactionHash?: string; nonce?: number; receipt?: Receipt; error?: PublicError }[]
}
export interface JournalData { format: 1; owner: string; chainId: number; operations: Operation[] }
