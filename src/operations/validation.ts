import { z } from 'zod'

import { AppError } from '../shared/index.js'
import type { Operation, PendingJournal } from './types.js'

const units = z.string().regex(/^(0|[1-9]\d*)$/)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const jsonObject = z.record(z.string(), z.json())
const error = z.object({ code: z.string(), reason: z.string().optional() })
const receipt = z.object({
  fee: units,
  hash: z.string().min(1),
  status: z.union([z.literal(0), z.literal(1)]),
  blockNumber: integer,
  logs: z.array(
    z.object({
      data: z.string(),
      address: z.string(),
      topics: z.array(z.string()),
    }),
  ),
})
const step = z.strictObject({
  id: integer,
  code: z.enum(['EXECUTE', 'ALLOWANCE_APPROVE', 'ALLOWANCE_RESET']),
  call: z.strictObject({
    to: z.string().min(1),
    data: z.string(),
    value: units,
  }),
  approval: z
    .strictObject({
      token: z.string(),
      spender: z.string(),
      amount: units,
      resetBelow: units.optional(),
    })
    .optional(),
  status: z.enum([
    'pending',
    'checking',
    'signing',
    'broadcasting',
    'confirming',
    'confirmed',
    'skipped',
    'failed',
  ]),
  error: error.optional(),
  receipt: receipt.optional(),
  signed: z
    .strictObject({
      raw: z.string().min(1),
      hash: z.string().min(1),
      nonce: integer,
      maxFee: units,
    })
    .optional(),
})
const operationSchema = z.object({
  id: z.uuid(),
  version: integer,
  previewId: z.uuid(),
  requestId: z.uuid(),
  createdAt: integer,
  updatedAt: integer,
  expiresAt: integer,
  maxGasWei: units,
  gasSpentWei: units,
  summary: jsonObject,
  result: jsonObject.optional(),
  error: error.optional(),
  status: z.enum([
    'queued',
    'running',
    'waiting',
    'needs_attention',
    'succeeded',
    'failed',
  ]),
  // Persisted plans already contain their calls. Their original parameters can
  // predate the current HTTP input schema, so do not re-prepare them on recovery.
  request: z.object({
    action: z.object({ kind: z.string().min(1), params: jsonObject }),
    maxGasAvax: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/),
  }),
  guards: z.array(
    z.union([
      z.strictObject({
        contract: z.enum(['oreVein', 'freeMine']),
        method: z.string().min(1),
        args: z.array(z.string()),
        expected: z.string(),
      }),
      z.strictObject({
        contract: z.literal('uniswapPool'),
        token0: z.string(),
        token1: z.string(),
        fee: integer.positive(),
        tickLower: z.number().int(),
        tickUpper: z.number().int(),
        budget0: units,
        budget1: units,
        amount0Desired: units,
        amount1Desired: units,
        minimumSqrtPriceX96: units,
        maximumSqrtPriceX96: units,
        initialSqrtPriceX96: units.optional(),
      }),
    ]),
  ),
  steps: z.array(step).min(1),
})

export function parseOperation(value: unknown): Operation {
  const result = operationSchema.safeParse(value)
  if (!result.success) {
    throw new AppError('INVALID_JOURNAL', 503)
  }
  const operation = result.data
  for (const [index, step] of operation.steps.entries()) {
    if (
      step.id !== index ||
      (step.code !== 'EXECUTE' && !step.approval) ||
      (step.code === 'ALLOWANCE_RESET' &&
        (step.approval?.amount !== '0' || !step.approval.resetBelow)) ||
      ((step.status === 'broadcasting' || step.status === 'confirming') &&
        !step.signed) ||
      (step.status === 'confirmed' &&
        (!step.signed || step.receipt?.status !== 1)) ||
      (step.status === 'skipped' &&
        (step.code === 'EXECUTE' || step.signed || step.receipt)) ||
      (operation.status === 'succeeded' &&
        step.status !== 'confirmed' &&
        step.status !== 'skipped')
    ) {
      throw new AppError('INVALID_JOURNAL', 503)
    }
  }
  return operation as Operation
}

export function parsePendingJournal(value: unknown): PendingJournal {
  const revision = integer.positive().nullable()
  const result = z
    .object({
      format: z.literal(2),
      owner: z.string().min(1),
      chainId: integer,
      entries: z.array(
        z.object({
          operation: z.unknown(),
          baseRevision: revision,
          attempt: z
            .object({ operation: z.unknown(), baseRevision: revision })
            .optional(),
        }),
      ),
      active: z
        .array(
          z.object({ operation: z.unknown(), revision: integer.positive() }),
        )
        .default([]),
    })
    .safeParse(value)
  if (!result.success) {
    throw new AppError('INVALID_JOURNAL', 503)
  }
  return {
    ...result.data,
    entries: result.data.entries.map(entry => ({
      ...entry,
      operation: parseOperation(entry.operation),
      attempt: entry.attempt
        ? {
            ...entry.attempt,
            operation: parseOperation(entry.attempt.operation),
          }
        : undefined,
    })),
    active: result.data.active.map(entry => ({
      ...entry,
      operation: parseOperation(entry.operation),
    })),
  }
}
