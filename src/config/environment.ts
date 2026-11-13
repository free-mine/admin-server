import { z } from 'zod'

import type { Config } from './types.js'
import { AppError } from '../shared/index.js'

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback)
const httpUrl = z.url().refine(value => {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
})
const schema = z.object({
  RPC_URL: z.url().refine(value => /^https?:\/\//.test(value)),
  PRIVATE_KEY: z.string().optional(),
  HOST: z.string().default('0.0.0.0'),
  LOG_BLOCK_RANGE: integer(10, 1, 10),
  DEPLOYMENT_BLOCK: z.coerce.number().int().nonnegative().optional(),
  POLL_INTERVAL_MS: integer(3000, 100, 60000),
  PREVIEW_TTL_SECONDS: integer(120, 30, 600),
  RPC_TIMEOUT_MS: integer(20000, 1000, 120000),
  PUBLIC_SERVER_URL: httpUrl,
  PUBLIC_SERVER_KEY: z.string().trim().optional(),
  PUBLIC_SERVER_TIMEOUT_MS: integer(5000, 100, 120000),
  SYNC_INTERVAL_MS: integer(15000, 1000, 600000),
})
export function readConfig(env = process.env): Config {
  const result = schema.safeParse(env)
  if (!result.success) {
    throw new AppError(`INVALID_ENV_${String(result.error.issues[0].path[0])}`)
  }
  const value = result.data
  const privateKey = value.PRIVATE_KEY?.trim()
  return {
    rpcUrl: value.RPC_URL,
    privateKey: privateKey
      ? privateKey.startsWith('0x')
        ? privateKey
        : `0x${privateKey}`
      : undefined,
    host: value.HOST,
    logBlockRange: value.LOG_BLOCK_RANGE,
    deploymentBlock: value.DEPLOYMENT_BLOCK,
    pollMs: value.POLL_INTERVAL_MS,
    previewTtlSeconds: value.PREVIEW_TTL_SECONDS,
    rpcTimeoutMs: value.RPC_TIMEOUT_MS,
    publicServerUrl: value.PUBLIC_SERVER_URL,
    publicServerKey: value.PUBLIC_SERVER_KEY || undefined,
    publicServerTimeoutMs: value.PUBLIC_SERVER_TIMEOUT_MS,
    syncIntervalMs: value.SYNC_INTERVAL_MS,
  }
}
