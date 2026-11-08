import { MaxUint256, parseUnits } from 'ethers'
import { ensure } from './errors.js'

export const MAX_UINT128 = (1n << 128n) - 1n
export function amount(text: string, decimals: number, allowZero = false): bigint {
  ensure(/^\d+(?:\.\d+)?$/.test(text) && text.length <= 160, 'INVALID_AMOUNT')
  ensure((text.split('.')[1]?.length ?? 0) <= decimals, 'AMOUNT_PRECISION')
  const value = parseUnits(text, decimals)
  ensure(value <= MaxUint256 && (allowZero ? value >= 0n : value > 0n), 'AMOUNT_RANGE')
  return value
}
export function minimumAmount(value: bigint, slippageBps: number): bigint {
  ensure(Number.isInteger(slippageBps) && slippageBps >= 0 && slippageBps <= 1000, 'INVALID_SLIPPAGE')
  const minimum = value * BigInt(10000 - slippageBps) / 10000n
  return value > 0n && minimum === 0n ? 1n : minimum
}
export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
