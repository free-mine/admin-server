import type { Token } from '../config/index.js'
export interface Quote {
  route: string[]; pairs: string[]; binSteps: bigint[]; versions: bigint[]; amounts: bigint[]
}
export interface Position {
  tokenId: bigint; token0: Token; token1: Token; fee: number
  tickLower: number; tickUpper: number; liquidity: bigint; tokensOwed0: bigint; tokensOwed1: bigint
}
