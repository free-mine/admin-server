import { z } from 'zod'
import { isAddress, getAddress, MaxUint256, ZeroAddress } from 'ethers'

export const tokenSchema = z.enum(['WAVAX', 'USDT', 'USDC', 'BTC.b'])
const decimal = z
  .string()
  .min(1)
  .max(160)
  .regex(/^\d+(?:\.\d+)?$/)
const uint = z
  .string()
  .max(78)
  .regex(/^(?:0|[1-9]\d*)$/)
  .refine(value => BigInt(value) <= MaxUint256)
export const idSchema = uint.refine(value => BigInt(value) > 0n)
const address = z
  .string()
  .refine(isAddress)
  .transform(value => getAddress(value))
  .refine(value => value !== ZeroAddress)
const slippageBps = z.number().int().min(0).max(1000)
const empty = z.strictObject({})
const assetAmount = z.strictObject({ token: tokenSchema, amount: decimal })
const position = z.strictObject({ tokenId: idSchema })

export const actionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('successor.schedule'),
    params: z.strictObject({
      address,
      timestamp: z.number().int().positive().max(253402300799),
    }),
  }),
  z.strictObject({
    kind: z.literal('successor.remove'),
    params: z.strictObject({ address }),
  }),
  z.strictObject({
    kind: z.literal('contract.setURI'),
    params: z.strictObject({ uri: z.string().min(1).max(2048) }),
  }),
  z.strictObject({ kind: z.literal('fund.closeShift'), params: empty }),
  z.strictObject({
    kind: z.literal('fund.fundShift'),
    params: z.strictObject({ price: decimal }),
  }),
  z.strictObject({
    kind: z.literal('fund.expireClaim'),
    params: z.strictObject({ shiftId: idSchema, claimId: idSchema }),
  }),
  z.strictObject({
    kind: z.literal('fund.updateEntryPrice'),
    params: z.strictObject({ price: decimal }),
  }),
  z.strictObject({
    kind: z.literal('fund.changeDollar'),
    params: z.strictObject({ token: tokenSchema }),
  }),
  z.strictObject({ kind: z.literal('aave.supply'), params: assetAmount }),
  z.strictObject({ kind: z.literal('aave.borrow'), params: assetAmount }),
  z.strictObject({ kind: z.literal('aave.repay'), params: assetAmount }),
  z.strictObject({
    kind: z.literal('aave.withdraw'),
    params: z.strictObject({
      token: tokenSchema,
      amount: z.union([decimal, z.literal('all')]),
    }),
  }),
  z.strictObject({
    kind: z.literal('lfj.swap'),
    params: z.strictObject({
      tokenIn: tokenSchema,
      tokenOut: tokenSchema,
      amount: decimal,
      slippageBps,
    }),
  }),
  z.strictObject({
    kind: z.literal('uniswap.mint'),
    params: z.strictObject({
      tokenA: tokenSchema,
      tokenB: tokenSchema,
      amountA: decimal,
      amountB: decimal,
      fee: z.number().int().min(1).max(999999),
      range: z.enum(['full', 'custom']),
      tickLower: z.number().int().min(-887272).max(887272).optional(),
      tickUpper: z.number().int().min(-887272).max(887272).optional(),
      initialPrice: decimal.optional(),
      slippageBps,
    }),
  }),
  z.strictObject({
    kind: z.literal('uniswap.increase'),
    params: position.extend({
      amount0: decimal,
      amount1: decimal,
      slippageBps,
    }),
  }),
  z.strictObject({ kind: z.literal('uniswap.collect'), params: position }),
  z.strictObject({
    kind: z.literal('uniswap.close'),
    params: position.extend({ slippageBps }),
  }),
])
export const previewRequestSchema = z.strictObject({
  action: actionSchema,
  maxGasAvax: decimal,
})
export const submitSchema = z.strictObject({
  previewId: z.uuid(),
  requestId: z.uuid(),
})
export const pageSchema = z.object({
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export const replacementSchema = z.strictObject({
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
})
