export interface Successor { address: string; timestamp: number; eligible: boolean }
export interface SuccessorSnapshot { block: number; blockTimestamp: number; successors: Successor[] }
