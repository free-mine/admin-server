import type { JsonObject, PublicError } from '../shared/index.js'

export interface StateSnapshot extends JsonObject {
  block: { number: number; timestamp: number }
}

export interface StateSource {
  refresh(): Promise<unknown>
  state(): Promise<StateSnapshot>
}

export interface StateStatus {
  available: boolean
  refreshPending: boolean
  snapshotBlock: number | null
  requiredBlock: number | null
  lastCheckedAt: number | null
  lastError: PublicError | null
}

export interface StateView {
  cached: boolean
  ageSeconds: number
  snapshot: JsonObject
  source: 'public-server'
  behindConfirmedTransactions: boolean
}
