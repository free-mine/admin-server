import { z } from 'zod'

import { CHAIN_ID, addresses, DEPLOYMENT_TX } from '../config/index.js'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const units = z.string().regex(/^(0|[1-9][0-9]*)$/)
const decimal = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)
const integer = z.number().int().nonnegative().safe()
const timestamp = z.iso.datetime()
const decimals = z.number().int().min(0).max(255)
const magicOre = '0xfb58d4b7c4c9f834a7211b5ae0e636cbd1b2feac'
const identity = (value: string) =>
  address.refine(candidate => candidate.toLowerCase() === value.toLowerCase())

export const jsonObject = z.record(z.string(), z.json())
export const recordId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
export const revisionSchema = z.number().int().positive().safe()
export const remoteRecord = z.object({
  id: recordId,
  revision: revisionSchema,
  updatedAt: timestamp,
  data: jsonObject,
})
export const recordsResponse = z.object({ records: z.array(remoteRecord) })

const block = z.object({ number: integer, hash, timestamp: integer })
const syncStatus = z.object({
  running: z.boolean(),
  lastError: z.string().nullable(),
  lastAttemptAt: timestamp.nullable(),
})
export const statusResponse = syncStatus
  .extend({
    block: block.nullable(),
    updatedAt: timestamp.nullable(),
    intervalMs: z.number().int().positive().safe(),
  })
  .and(jsonObject)
export const refreshResponse = syncStatus
  .extend({ status: z.literal('accepted') })
  .and(jsonObject)

const tokenBalance = z.object({
  symbol: z.string().min(1),
  address,
  decimals,
  amount: units,
})
const pairAmounts = z.object({ base: units, quote: units })
const pool = z.object({
  baseSymbol: z.string().min(1),
  quoteSymbol: z.string().min(1),
  fee: z.number().int().positive(),
  address: address.nullable(),
  price: decimal.nullable(),
})
const position = z.object({
  tokenId: units,
  pool: address,
  baseSymbol: z.string().min(1),
  quoteSymbol: z.string().min(1),
  fee: z.number().int().positive(),
  liquidity: units,
  range: z.object({
    lowerPrice: decimal,
    upperPrice: decimal,
    fullRange: z.boolean(),
  }),
  inRange: z.boolean(),
  price: decimal,
  amounts: pairAmounts,
  newlyAccruedFees: pairAmounts,
  storedOwed: pairAmounts,
  totalCollectable: pairAmounts,
})

export const snapshotResponse = z
  .object({
    format: z.literal(1),
    chain: z.object({
      chainId: z.literal(CHAIN_ID),
      deploymentTx: hash.refine(value => value.toLowerCase() === DEPLOYMENT_TX),
      magicOre: identity(magicOre),
      freeMine: identity(addresses.freeMine),
      oreVein: identity(addresses.oreVein),
    }),
    block,
    updatedAt: timestamp,
    fund: z.object({
      magicOre: z.object({
        name: z.string(),
        owner: address,
        symbol: z.string(),
        decimals: z.literal(18),
        totalSupply: units,
        holders: z.record(address, units),
      }),
      oreVein: z.object({
        owner: address,
        freeMine: identity(addresses.freeMine),
        pendingOwner: address,
        contractURI: z.string(),
        admins: z.array(address),
        successors: z.record(address, units),
      }),
      freeMine: z.object({
        owner: address,
        magicOre: identity(magicOre),
        entryPrice: units,
        priceUpdatedAt: units,
        currentShiftId: units,
        dollar: z.object({ address, decimals }),
        claims: z.record(
          z.string(),
          z.object({
            miner: address,
            shiftId: units,
            claimId: units,
            oreAmount: units,
          }),
        ),
        shifts: z.record(
          units,
          z.object({
            funded: z.boolean(),
            price: units,
            dollar: address,
            fundedAt: units,
            oreAmount: units,
            dollarScale: units,
            currentClaimId: units,
          }),
        ),
      }),
    }),
    portfolio: z.object({
      blockNumber: integer,
      nativeBalance: z.object({
        symbol: z.literal('AVAX'),
        decimals: z.literal(18),
        amount: units,
      }),
      balances: z.array(tokenBalance),
      aave: z.object({
        supplies: z.array(tokenBalance),
        debts: z.array(
          tokenBalance.extend({ variableDebt: units, stableDebt: units }),
        ),
        healthFactor: decimal.nullable(),
      }),
      uniswap: z.object({ pools: z.array(pool), positions: z.array(position) }),
    }),
  })
  .refine(value => value.portfolio.blockNumber === value.block.number)
  .and(jsonObject)
