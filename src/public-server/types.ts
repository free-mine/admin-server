import type { z } from 'zod'

import type { snapshotResponse } from './schema.js'
import type { JsonObject } from '../shared/index.js'

export type PublicSnapshot = z.infer<typeof snapshotResponse>

export interface PublicServerOptions {
  url: string
  key?: string
  timeoutMs: number
}

export interface RemoteRecord {
  id: string
  revision: number
  data: JsonObject
  updatedAt: string
}

export interface RequestOptions {
  owner?: boolean
  body?: JsonObject
  missingAllowed?: boolean
  method?: 'GET' | 'POST' | 'PUT'
  headers?: Record<string, string>
}
