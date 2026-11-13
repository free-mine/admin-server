export interface SuccessorHistory {
  hash: string
  number: number
  candidates: Set<string>
}

export interface Successor {
  address: string
  timestamp: number
  eligible: boolean
}
export interface SuccessorSnapshot {
  block: number
  blockTimestamp: number
  successors: Successor[]
}
