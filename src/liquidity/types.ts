export interface RangeRequest {
  price: bigint
  amount0: bigint
  amount1: bigint
  spacing: number
  slippageBps: number
  baseIsToken0: boolean
  minBoundaryPercent: string
}
