import type { z } from 'zod'

import { AppError } from '../shared/index.js'
import type { JsonObject } from '../shared/index.js'
import type {
  RemoteRecord,
  RequestOptions,
  PublicSnapshot,
  PublicServerOptions,
} from './types.js'
import {
  recordId,
  jsonObject,
  remoteRecord,
  statusResponse,
  revisionSchema,
  recordsResponse,
  refreshResponse,
  snapshotResponse,
} from './schema.js'

function responseData<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new AppError('PUBLIC_SERVER_INVALID_RESPONSE', 502)
  }
  return result.data
}

export class PublicServer {
  private readonly base: URL
  private readonly key?: string
  private readonly timeoutMs: number

  constructor(options: PublicServerOptions) {
    let url: URL
    try {
      url = new URL(options.url)
    } catch {
      throw new AppError('PUBLIC_SERVER_INVALID_CONFIGURATION', 500)
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > 2_147_483_647 ||
      (options.key !== undefined && !/^[\x21-\x7e]+$/.test(options.key))
    ) {
      throw new AppError('PUBLIC_SERVER_INVALID_CONFIGURATION', 500)
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
    this.base = url
    this.key = options.key
    this.timeoutMs = options.timeoutMs
  }

  async state(): Promise<PublicSnapshot> {
    return responseData(snapshotResponse, await this.request('v1/state'))
  }

  async status(): Promise<JsonObject> {
    return responseData(statusResponse, await this.request('v1/status'))
  }

  async refresh(): Promise<JsonObject> {
    return responseData(
      refreshResponse,
      await this.request('v1/refresh', { owner: true, method: 'POST' }),
    )
  }

  async listTransactions(): Promise<RemoteRecord[]> {
    const { records } = responseData(
      recordsResponse,
      await this.request('v1/transactions', { owner: true }),
    )
    if (new Set(records.map(record => record.id)).size !== records.length) {
      throw new AppError('PUBLIC_SERVER_INVALID_RESPONSE', 502)
    }
    return records
  }

  async getTransaction(id: string): Promise<RemoteRecord | undefined> {
    const value = await this.request(this.transactionPath(id), {
      owner: true,
      missingAllowed: true,
    })
    return value === undefined ? undefined : this.record(value, id)
  }

  async putTransaction(
    id: string,
    data: JsonObject,
    revision: number | null,
  ): Promise<RemoteRecord> {
    if (revision !== null && !revisionSchema.safeParse(revision).success) {
      throw new AppError('PUBLIC_SERVER_REQUEST_REJECTED', 400)
    }
    if (!jsonObject.safeParse(data).success) {
      throw new AppError('PUBLIC_SERVER_REQUEST_REJECTED', 400)
    }
    const record = this.record(
      await this.request(this.transactionPath(id), {
        owner: true,
        method: 'PUT',
        body: data,
        headers:
          revision === null
            ? { 'If-None-Match': '*' }
            : { 'If-Match': `"${revision}"` },
      }),
      id,
    )
    if (revision !== null && record.revision <= revision) {
      throw new AppError('PUBLIC_SERVER_INVALID_RESPONSE', 502)
    }
    return record
  }

  private transactionPath(id: string): string {
    if (!recordId.safeParse(id).success) {
      throw new AppError('PUBLIC_SERVER_REQUEST_REJECTED', 400)
    }
    return `v1/transactions/${encodeURIComponent(id)}`
  }

  private record(value: unknown, id: string): RemoteRecord {
    const record = responseData(remoteRecord, value)
    if (record.id !== id) {
      throw new AppError('PUBLIC_SERVER_INVALID_RESPONSE', 502)
    }
    return record
  }

  private async request(
    path: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    if (options.owner && !this.key) {
      throw new AppError('PUBLIC_SERVER_KEY_REQUIRED', 503)
    }
    const signal = AbortSignal.timeout(this.timeoutMs)
    try {
      const response = await fetch(new URL(path, this.base), {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(options.owner ? { Authorization: `Bearer ${this.key}` } : {}),
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        redirect: 'error',
        signal,
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 404 && options.missingAllowed) {
          return undefined
        }
        if (response.status === 401 || response.status === 403) {
          throw new AppError('PUBLIC_SERVER_UNAUTHORIZED', 502)
        }
        if (response.status === 412) {
          throw new AppError('PUBLIC_SERVER_CONFLICT', 409)
        }
        if (response.status >= 500) {
          throw new AppError('PUBLIC_SERVER_UNAVAILABLE', 503)
        }
        throw new AppError('PUBLIC_SERVER_REQUEST_REJECTED', 502)
      }
      try {
        return await response.json()
      } catch (error) {
        if (signal.aborted || !(error instanceof SyntaxError)) {
          throw new AppError('PUBLIC_SERVER_UNAVAILABLE', 503)
        }
        throw new AppError('PUBLIC_SERVER_INVALID_RESPONSE', 502)
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error
      }
      throw new AppError('PUBLIC_SERVER_UNAVAILABLE', 503)
    }
  }
}
