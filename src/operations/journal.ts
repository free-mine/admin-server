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
import type { PublicError } from '../shared/index.js'
import { ensure, AppError, sameAddress } from '../shared/index.js'
import type { Operation, JournalData, JournalStatus } from './types.js'
import {
  parseJournal,
  parseOperation,
  parsePendingJournal,
} from './validation.js'

export class Journal {
  private readonly path: string
  private readonly operations = new Map<string, Operation>()
  // Keep only explicitly saved snapshots on disk, not later in-memory mutations.
  private readonly saved = new Map<string, Operation>()
  private blocked = false
  private lastError?: PublicError

  constructor(
    private readonly directory: string,
    private owner: string,
    private readonly readOnly = false,
  ) {
    this.path = join(directory, 'operations.json')
    this.load()
    this.migratePending()
    this.checkIdentities()
  }

  get isBlocked(): boolean {
    return this.blocked
  }

  get status(): JournalStatus {
    return {
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

  assertWritable(): void {
    if (this.readOnly) {
      throw new AppError('READ_ONLY', 403)
    }
    if (this.blocked) {
      throw new AppError(this.lastError?.code ?? 'JOURNAL_UNAVAILABLE', 503)
    }
  }

  save(operation: Operation): void {
    this.assertWritable()
    const value = parseOperation(operation)
    ensure(
      [...this.saved.values()].every(
        existing =>
          existing.id === value.id ||
          (existing.requestId !== value.requestId &&
            existing.previewId !== value.previewId),
      ),
      'JOURNAL_CONFLICT',
    )
    this.saved.set(value.id, value)
    this.operations.set(value.id, operation)
    // The signature is durable before broadcast; terminal operations remain
    // in this journal so history and idempotency also survive a restart.
    this.persist()
  }

  private checkOwner(owner: string, chainId: number): void {
    ensure(chainId === CHAIN_ID, 'JOURNAL_NETWORK_MISMATCH')
    ensure(
      sameAddress(owner, this.owner) ||
        (this.readOnly && !existsSync(this.path)),
      'JOURNAL_OWNER_MISMATCH',
    )
    this.owner = owner
  }

  private load(): void {
    if (!existsSync(this.path)) {
      return
    }
    let data: JournalData
    try {
      data = parseJournal(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch {
      throw new AppError('INVALID_JOURNAL', 503)
    }
    ensure(data.chainId === CHAIN_ID, 'JOURNAL_NETWORK_MISMATCH')
    ensure(
      this.readOnly || sameAddress(data.owner, this.owner),
      'JOURNAL_OWNER_MISMATCH',
    )
    this.owner = data.owner
    for (const operation of data.operations) {
      ensure(!this.saved.has(operation.id), 'INVALID_JOURNAL')
      this.saved.set(operation.id, operation)
      this.operations.set(operation.id, structuredClone(operation))
    }
  }

  private migratePending(): void {
    const path = join(this.directory, 'operations.pending.json')
    if (!existsSync(path)) {
      return
    }
    let data
    try {
      data = parsePendingJournal(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      throw new AppError('INVALID_JOURNAL', 503)
    }
    this.checkOwner(data.owner, data.chainId)
    const ids = new Set<string>()
    for (const entry of [...data.active, ...data.entries]) {
      const operation = entry.operation
      ensure(!ids.has(operation.id), 'INVALID_JOURNAL')
      ids.add(operation.id)
      if ('attempt' in entry && entry.attempt) {
        ensure(
          entry.attempt.operation.id === operation.id &&
            entry.attempt.baseRevision === entry.baseRevision &&
            entry.attempt.operation.version <= operation.version,
          'INVALID_JOURNAL',
        )
      }
      const existing = this.saved.get(operation.id)
      // Both files can remain after a crash between durable migration and
      // deleting the pending file. Only identical duplicate records are safe.
      ensure(
        !existing || isDeepStrictEqual(existing, operation),
        'JOURNAL_CONFLICT',
      )
      this.saved.set(operation.id, operation)
      this.operations.set(operation.id, structuredClone(operation))
    }
    this.checkIdentities()
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
    for (const operation of this.saved.values()) {
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
      const data: JournalData = {
        format: 1,
        owner: this.owner,
        chainId: CHAIN_ID,
        operations: [...this.saved.values()],
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
}
