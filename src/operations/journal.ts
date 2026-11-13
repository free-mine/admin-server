import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  openSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'

import { CHAIN_ID } from '../config/index.js'
import type { RemoteRecord } from '../public-server/index.js'
import type { JsonObject, PublicError } from '../shared/index.js'
import { parseOperation, parsePendingJournal } from './validation.js'
import { ensure, AppError, publicError, sameAddress } from '../shared/index.js'
import type {
  Operation,
  JournalData,
  JournalStatus,
  PendingJournal,
  PendingOperation,
  ArchivedOperation,
  AcknowledgedOperation,
  JournalTransactionStore,
} from './types.js'

const format = 'ore-vein-operation/1'

function checkpoint(
  operation: Operation,
  revision: number,
): AcknowledgedOperation | ArchivedOperation {
  return operation.status === 'succeeded' || operation.status === 'failed'
    ? { revision }
    : { operation: structuredClone(operation), revision }
}

export class Journal {
  private readonly path: string
  private readonly operations = new Map<string, Operation>()
  private readonly saved = new Map<
    string,
    PendingOperation | AcknowledgedOperation | ArchivedOperation
  >()
  private readonly listeners = new Set<() => void>()
  private connected = false
  private historyLoaded = false
  private blocked = false
  private lastError?: PublicError
  private timer?: ReturnType<typeof setInterval>
  private task?: Promise<void>

  constructor(
    private readonly directory: string,
    private owner: string,
    private readonly readOnly = false,
    private readonly remote?: JournalTransactionStore,
  ) {
    this.path = join(directory, 'operations.pending.json')
    this.loadPending()
    this.migrateLegacy()
    this.checkIdentities()
  }

  get isBlocked(): boolean {
    return this.blocked
  }

  get status(): JournalStatus {
    return {
      connected: this.connected,
      historyLoaded: this.historyLoaded,
      pending: this.pending.length,
      blocked: this.blocked,
      ...(this.lastError ? { lastError: { ...this.lastError } } : {}),
    }
  }

  all(): Operation[] {
    return [...this.operations.values()].sort(
      (left, right) => left.createdAt - right.createdAt,
    )
  }

  get(id: string): Operation | undefined {
    return this.operations.get(id)
  }

  private get pending(): PendingOperation[] {
    return [...this.saved.values()].filter(entry => 'baseRevision' in entry)
  }

  assertWritable(): void {
    if (this.readOnly) {
      throw new AppError('READ_ONLY', 403)
    }
    if (this.blocked) {
      throw new AppError(this.lastError?.code ?? 'JOURNAL_UNAVAILABLE', 503)
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  save(operation: Operation): void {
    this.assertWritable()
    const value = parseOperation(JSON.parse(JSON.stringify(operation)))
    const current = this.saved.get(operation.id)
    this.saved.set(operation.id, {
      operation: value,
      baseRevision: current
        ? 'baseRevision' in current
          ? current.baseRevision
          : current.revision
        : null,
      ...(current && 'attempt' in current ? { attempt: current.attempt } : {}),
    })
    this.operations.set(operation.id, operation)
    this.checkIdentities()
    // A temporary write-ahead entry is durable before any signed transaction
    // can be broadcast. It is removed only after the public server acknowledges it.
    this.persist()
    if (this.remote && this.timer) {
      queueMicrotask(() => void this.sync())
    }
  }

  start(intervalMs = 5000): void {
    if (!this.timer) {
      this.timer = setInterval(() => void this.sync(), intervalMs)
      this.timer.unref()
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    this.timer = undefined
    await this.task
    if (!this.readOnly && this.pending.length > 0) {
      await this.sync()
    }
  }

  sync(): Promise<void> {
    if (!this.task) {
      this.task = this.synchronize().finally(() => {
        this.task = undefined
      })
    }
    return this.task
  }

  private async synchronize(): Promise<void> {
    if (!this.remote || this.blocked) {
      return
    }
    try {
      const records = await this.remote.listTransactions()
      const seen = new Set<string>()
      for (const record of records) {
        if (!record.id.startsWith(this.prefix)) {
          continue
        }
        const operation = this.readRecord(record)
        ensure(!seen.has(operation.id), 'INVALID_JOURNAL')
        seen.add(operation.id)
        this.reconcile(record, operation)
      }
      for (const [id, entry] of this.saved) {
        const revision =
          'baseRevision' in entry ? entry.baseRevision : entry.revision
        if (revision !== null && !seen.has(id)) {
          throw new AppError('JOURNAL_CONFLICT', 503)
        }
      }
      this.checkIdentities()
      this.historyLoaded = true
      if (!this.readOnly) {
        this.persist()
        for (const entry of this.pending) {
          await this.upload(entry.operation.id)
        }
      }
      this.connected = true
      this.lastError = undefined
    } catch (error) {
      this.connected = false
      this.lastError = publicError(error)
      if (
        ![
          'PUBLIC_SERVER_UNAVAILABLE',
          'PUBLIC_SERVER_UNAUTHORIZED',
          'PUBLIC_SERVER_KEY_REQUIRED',
        ].includes(this.lastError.code)
      ) {
        this.blocked = true
      }
    }
    this.notify()
  }

  private get prefix(): string {
    return `ore-vein:${CHAIN_ID}:${this.owner.toLowerCase()}:`
  }

  private recordData(operation: Operation): JsonObject {
    return JSON.parse(
      JSON.stringify({
        format,
        owner: this.owner,
        chainId: CHAIN_ID,
        operation,
      }),
    ) as JsonObject
  }

  private readRecord(record: RemoteRecord): Operation {
    ensure(
      record.data.format === format &&
        record.data.chainId === CHAIN_ID &&
        typeof record.data.owner === 'string' &&
        sameAddress(record.data.owner, this.owner),
      'INVALID_JOURNAL',
    )
    const operation = parseOperation(record.data.operation)
    ensure(record.id === `${this.prefix}${operation.id}`, 'INVALID_JOURNAL')
    return operation
  }

  private reconcile(record: RemoteRecord, operation: Operation): void {
    const id = operation.id
    const entry = this.saved.get(id)
    if (entry && 'baseRevision' in entry) {
      if (
        entry.attempt &&
        record.revision > (entry.attempt.baseRevision ?? 0) &&
        isDeepStrictEqual(operation, entry.attempt.operation)
      ) {
        this.acknowledge(id, record.revision, operation)
      } else if (record.revision !== entry.baseRevision) {
        throw new AppError('JOURNAL_CONFLICT', 503)
      }
      return
    }
    if (entry && entry.revision !== record.revision) {
      throw new AppError('JOURNAL_CONFLICT', 503)
    }
    if (!this.operations.has(id)) {
      this.operations.set(id, operation)
      this.saved.set(id, checkpoint(operation, record.revision))
    }
  }

  private async upload(id: string): Promise<void> {
    const remote = this.remote
    ensure(remote, 'INTERNAL_ERROR')
    const entry = this.saved.get(id)
    if (!entry || !('baseRevision' in entry)) {
      return
    }
    if (!entry.attempt) {
      entry.attempt = {
        operation: structuredClone(entry.operation),
        baseRevision: entry.baseRevision,
      }
      this.persist()
    }
    const attempt = entry.attempt
    const key = `${this.prefix}${id}`
    let record: RemoteRecord
    try {
      record = await remote.putTransaction(
        key,
        this.recordData(attempt.operation),
        attempt.baseRevision,
      )
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        error.code !== 'PUBLIC_SERVER_CONFLICT'
      ) {
        throw error
      }
      const current = await remote.getTransaction(key)
      if (!current) {
        throw new AppError('JOURNAL_CONFLICT', 503)
      }
      record = current
    }
    const operation = this.readRecord(record)
    if (
      record.revision <= (attempt.baseRevision ?? 0) ||
      !isDeepStrictEqual(operation, attempt.operation)
    ) {
      throw new AppError('JOURNAL_CONFLICT', 503)
    }
    this.acknowledge(id, record.revision, operation)
  }

  private acknowledge(
    id: string,
    revision: number,
    operation: Operation,
  ): void {
    const entry = this.saved.get(id)
    ensure(entry && 'baseRevision' in entry, 'INTERNAL_ERROR')
    if (isDeepStrictEqual(entry.operation, operation)) {
      this.saved.set(id, checkpoint(operation, revision))
    } else {
      entry.baseRevision = revision
      delete entry.attempt
    }
    if (!this.readOnly) {
      this.persist()
    }
  }

  private loadPending(): void {
    if (!existsSync(this.path)) {
      return
    }
    let data: PendingJournal
    try {
      data = parsePendingJournal(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch {
      throw new AppError('INVALID_JOURNAL', 503)
    }
    ensure(data.chainId === CHAIN_ID, 'JOURNAL_NETWORK_MISMATCH')
    ensure(
      this.readOnly || sameAddress(data.owner, this.owner),
      'JOURNAL_OWNER_MISMATCH',
    )
    this.owner = data.owner
    for (const entry of data.active) {
      const id = entry.operation.id
      ensure(!this.operations.has(id), 'INVALID_JOURNAL')
      ensure(
        entry.operation.status !== 'succeeded' &&
          entry.operation.status !== 'failed',
        'INVALID_JOURNAL',
      )
      this.saved.set(id, entry)
      this.operations.set(id, structuredClone(entry.operation))
    }
    for (const entry of data.entries) {
      const id = entry.operation.id
      ensure(!this.operations.has(id), 'INVALID_JOURNAL')
      ensure(
        !entry.attempt ||
          (entry.attempt.operation.id === id &&
            entry.attempt.baseRevision === entry.baseRevision &&
            entry.attempt.operation.version <= entry.operation.version),
        'INVALID_JOURNAL',
      )
      this.saved.set(id, entry)
      this.operations.set(id, structuredClone(entry.operation))
    }
  }

  private migrateLegacy(): void {
    const path = join(this.directory, 'operations.json')
    if (!existsSync(path)) {
      return
    }
    let data: JournalData
    try {
      data = JSON.parse(readFileSync(path, 'utf8')) as JournalData
      ensure(
        data.format === 1 && Array.isArray(data.operations),
        'INVALID_JOURNAL',
      )
      ensure(data.chainId === CHAIN_ID, 'JOURNAL_NETWORK_MISMATCH')
      ensure(
        typeof data.owner === 'string' &&
          (sameAddress(data.owner, this.owner) ||
            (this.readOnly && this.saved.size === 0)),
        'JOURNAL_OWNER_MISMATCH',
      )
      if (this.readOnly && this.saved.size === 0) {
        this.owner = data.owner
      }
      for (const value of data.operations) {
        const operation = parseOperation(value)
        const existing = this.operations.get(operation.id)
        ensure(
          !existing || isDeepStrictEqual(existing, operation),
          'JOURNAL_CONFLICT',
        )
        if (!existing) {
          this.saved.set(operation.id, { operation, baseRevision: null })
          this.operations.set(operation.id, structuredClone(operation))
        }
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error
      }
      throw new AppError('INVALID_JOURNAL', 503)
    }
    if (!this.readOnly) {
      this.persist()
      try {
        unlinkSync(path)
        this.syncDirectory()
      } catch {
        throw new AppError('JOURNAL_WRITE_FAILED', 503)
      }
    }
  }

  private checkIdentities(): void {
    const requests = new Set<string>()
    const previews = new Set<string>()
    for (const operation of this.operations.values()) {
      ensure(
        !requests.has(operation.requestId) &&
          !previews.has(operation.previewId),
        'JOURNAL_CONFLICT',
      )
      requests.add(operation.requestId)
      previews.add(operation.previewId)
    }
  }

  private persist(): void {
    try {
      const data: PendingJournal = {
        format: 2,
        owner: this.owner,
        chainId: CHAIN_ID,
        entries: [],
        active: [],
      }
      for (const entry of this.saved.values()) {
        if ('baseRevision' in entry) {
          data.entries.push(entry)
        } else if ('operation' in entry) {
          data.active.push(entry)
        }
      }
      if (data.entries.length === 0 && data.active.length === 0) {
        if (existsSync(this.path)) {
          unlinkSync(this.path)
          this.syncDirectory()
        }
        return
      }
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.tmp`
      const file = openSync(temporary, 'w', 0o600)
      try {
        writeFileSync(file, JSON.stringify(data))
        fsyncSync(file)
      } finally {
        closeSync(file)
      }
      renameSync(temporary, this.path)
      this.syncDirectory()
    } catch {
      this.blocked = true
      this.lastError = { code: 'JOURNAL_WRITE_FAILED' }
      throw new AppError('JOURNAL_WRITE_FAILED', 503)
    }
  }

  private syncDirectory(): void {
    if (process.platform !== 'win32') {
      const directory = openSync(this.directory, 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A subscriber cannot change the durability result.
      }
    }
  }
}
