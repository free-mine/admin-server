import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAIN_ID } from '../config/index.js'
import { AppError, ensure, sameAddress } from '../shared/index.js'
import type { JournalData, Operation } from './types.js'

export class Journal {
  private data: JournalData
  private path: string
  constructor(private directory: string, owner: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.path = join(directory, 'operations.json')
    if (existsSync(this.path)) {
      try {
        this.data = JSON.parse(readFileSync(this.path, 'utf8')) as JournalData
        ensure(this.data.format === 1 && Array.isArray(this.data.operations), 'INVALID_JOURNAL')
        ensure(this.data.chainId === CHAIN_ID && sameAddress(this.data.owner, owner), 'JOURNAL_OWNER_MISMATCH')
        for (const operation of this.data.operations) {
          ensure(typeof operation.id === 'string' && Array.isArray(operation.steps) &&
            typeof operation.maxGasWei === 'string' && typeof operation.expiresAt === 'number', 'INVALID_JOURNAL')
        }
      } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError('INVALID_JOURNAL', 500)
      }
    } else {
      this.data = { format: 1, owner, chainId: CHAIN_ID, operations: [] }
      this.flush()
    }
  }
  all(): Operation[] { return this.data.operations }
  get(id: string): Operation | undefined { return this.data.operations.find(operation => operation.id === id) }
  save(operation: Operation): void {
    const index = this.data.operations.findIndex(value => value.id === operation.id)
    if (index < 0) this.data.operations.push(operation)
    else this.data.operations[index] = operation
    this.flush()
  }
  private flush(): void {
    const temporary = `${this.path}.tmp`
    try {
      const file = openSync(temporary, 'w', 0o600)
      try { writeFileSync(file, JSON.stringify(this.data)); fsyncSync(file) } finally { closeSync(file) }
      renameSync(temporary, this.path)
      // fsync каталога фиксирует rename при отключении питания Linux-хоста.
      if (process.platform !== 'win32') {
        const directory = openSync(this.directory, 'r')
        try { fsyncSync(directory) } finally { closeSync(directory) }
      }
    } catch { throw new AppError('JOURNAL_WRITE_FAILED', 503) }
  }
}
