import { isError, Interface } from 'ethers'

import type { PublicError } from './types.js'
import { oreVeinAbi, freeMineAbi, aaveErrorsAbi } from '../contracts/index.js'

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(code)
  }
}

const errors = new Interface([
  ...aaveErrorsAbi,
  ...[...oreVeinAbi, ...freeMineAbi].filter(entry => entry.type === 'error'),
])
function revertName(data: unknown, depth = 0): string | undefined {
  if (typeof data !== 'string' || depth > 3) {
    return undefined
  }
  try {
    const parsed = errors.parseError(data)
    if (parsed?.name === 'CallFailed') {
      return revertName(parsed.args[0], depth + 1)
    }
    // Произвольные строки из внешнего контракта не попадают в ответ API.
    if (parsed?.name === 'Error') {
      return 'EXTERNAL_REVERT'
    }
    return (
      parsed?.name ??
      (data.length >= 10 ? `UNKNOWN_${data.slice(0, 10)}` : undefined)
    )
  } catch {
    return undefined
  }
}

export function publicError(error: unknown): PublicError {
  if (error instanceof AppError) {
    return { code: error.code }
  }
  if (isError(error, 'CALL_EXCEPTION')) {
    return {
      code: 'CONTRACT_REVERT',
      reason: revertName(error.data) ?? 'SIMULATION_FAILED',
    }
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code)
    if (
      [
        'NETWORK_ERROR',
        'SERVER_ERROR',
        'TIMEOUT',
        'INSUFFICIENT_FUNDS',
        'NONCE_EXPIRED',
        'REPLACEMENT_UNDERPRICED',
        'UNKNOWN_ERROR',
        'BAD_DATA',
      ].includes(code)
    ) {
      return { code }
    }
  }
  return { code: 'INTERNAL_ERROR' }
}

export function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new AppError(code)
  }
}
