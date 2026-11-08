import type { Token } from '../config/index.js'

export interface Quote {
  route: string[]
  pairs: string[]
  amounts: bigint[]
  binSteps: bigint[]
  versions: bigint[]
}
export interface Position {
  fee: number
  token0: Token
  token1: Token
  tokenId: bigint
  tickLower: number
  tickUpper: number
  liquidity: bigint
  tokensOwed0: bigint
  tokensOwed1: bigint
}
