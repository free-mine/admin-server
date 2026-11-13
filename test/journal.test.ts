import test from 'node:test'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

import { CHAIN_ID } from '../src/config/index.js'
import { AppError } from '../src/shared/index.js'
import type { JsonObject } from '../src/shared/index.js'
import { Journal, Operations } from '../src/operations/index.js'
import type { RemoteRecord } from '../src/public-server/index.js'
import { until, preview, temporary, FakeChain } from './helpers.js'
import type {
  Operation,
  JournalTransactionStore,
} from '../src/operations/index.js'

const owner = new FakeChain().owner
const pendingFile = (directory: string) =>
  join(directory, 'operations.pending.json')
const recordId = (id: string) =>
  `ore-vein:${CHAIN_ID}:${owner.toLowerCase()}:${id}`

class RemoteStore implements JournalTransactionStore {
  records = new Map<string, RemoteRecord>()
  available = true
  loseResponse = false
  writes = 0
  nextRevision = 11
  beforeReply?: () => void

  async listTransactions(): Promise<RemoteRecord[]> {
    this.check()
    return structuredClone([...this.records.values()])
  }

  async getTransaction(id: string): Promise<RemoteRecord | undefined> {
    this.check()
    return structuredClone(this.records.get(id))
  }

  async putTransaction(
    id: string,
    data: JsonObject,
    revision: number | null,
  ): Promise<RemoteRecord> {
    this.check()
    const current = this.records.get(id)
    if ((current?.revision ?? null) !== revision) {
      throw new AppError('PUBLIC_SERVER_CONFLICT', 409)
    }
    const record = {
      id,
      data: structuredClone(data),
      revision: this.nextRevision,
      updatedAt: new Date().toISOString(),
    }
    // The real public server allocates a global sequence across ALL records.
    this.nextRevision += 3
    this.records.set(id, record)
    this.writes++
    this.beforeReply?.()
    if (this.loseResponse) {
      throw new AppError('PUBLIC_SERVER_UNAVAILABLE', 503)
    }
    return structuredClone(record)
  }

  private check(): void {
    if (!this.available) {
      throw new AppError('PUBLIC_SERVER_UNAVAILABLE', 503)
    }
  }
}

function operation(): Operation {
  const plan = preview()
  return {
    id: randomUUID(),
    version: 1,
    requestId: randomUUID(),
    previewId: plan.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: plan.expiresAt,
    status: 'queued',
    request: plan.request,
    guards: plan.plan.guards,
    summary: plan.plan.summary,
    maxGasWei: '1000',
    gasSpentWei: '0',
    steps: plan.plan.steps.map((step, id) => {
      const { gasEstimate: _estimate, ...value } = step
      return { ...value, id, status: 'pending' }
    }),
  }
}

test('remote is permanent history; acknowledged active work is only a recovery checkpoint', async t => {
  const directory = temporary(t)
  const remote = new RemoteStore()
  const journal = new Journal(directory, owner, false, remote)
  await journal.sync()
  assert.deepEqual(journal.status, {
    connected: true,
    historyLoaded: true,
    pending: 0,
    blocked: false,
  })
  const value = operation()
  journal.save(value)
  await journal.sync()
  assert.equal(journal.status.pending, 0)
  const recovery = JSON.parse(readFileSync(pendingFile(directory), 'utf8'))
  assert.equal(recovery.entries.length, 0)
  assert.equal(recovery.active[0].operation.id, value.id)
  assert.equal(recovery.active[0].revision, 11)
  value.version++
  value.status = 'failed'
  journal.save(value)
  await journal.sync()
  assert.equal(existsSync(pendingFile(directory)), false)
  assert.equal(remote.records.get(recordId(value.id))?.revision, 14)

  const otherDirectory = temporary(t)
  const restored = new Journal(otherDirectory, owner, false, remote)
  await restored.sync()
  assert.deepEqual(restored.get(value.id), value)
  assert.equal(existsSync(pendingFile(otherDirectory)), false)
})

test('offline operations persist before broadcast and reconnect archives their final state', async t => {
  const directory = temporary(t)
  const remote = new RemoteStore()
  remote.available = false
  const chain = new FakeChain()
  const journal = new Journal(directory, owner, false, remote)
  const operations = new Operations(journal, chain, 5)
  t.after(() => operations.stop())
  await journal.sync()
  assert.equal(journal.status.historyLoaded, false)
  assert.equal(journal.status.blocked, false)
  chain.onBroadcast = () => {
    const saved = JSON.parse(readFileSync(pendingFile(directory), 'utf8'))
    assert.ok(saved.entries[0].operation.steps[0].signed.raw)
  }
  operations.start()
  const value = operations.submit(preview(), randomUUID())
  await until(() => operations.get(value.id).status === 'succeeded')
  await operations.stop()
  const restored = new Journal(directory, owner, false, remote)
  assert.equal(restored.get(value.id)?.status, 'succeeded')
  remote.available = true
  await restored.sync()
  assert.equal(restored.status.pending, 0)
  assert.equal(existsSync(pendingFile(directory)), false)
  assert.equal(
    (remote.records.get(recordId(value.id))?.data.operation as JsonObject)
      .status,
    'succeeded',
  )
  assert.equal(chain.signs.length, 1)
})

test('acknowledged recovery checkpoints exclude unsaved mutations', async t => {
  const directory = temporary(t)
  const remote = new RemoteStore()
  const journal = new Journal(directory, owner, false, remote)
  const value = operation()
  journal.save(value)
  await journal.sync()

  value.version++
  value.status = 'failed'
  journal.save(operation())

  const restored = new Journal(directory, owner)
  assert.equal(restored.get(value.id)?.status, 'queued')
  assert.equal(restored.get(value.id)?.version, 1)
  assert.equal(restored.status.pending, 1)
})

test('removing acknowledged remote history blocks pending updates', async t => {
  const directory = temporary(t)
  const remote = new RemoteStore()
  const journal = new Journal(directory, owner, false, remote)
  const value = operation()
  value.status = 'failed'
  journal.save(value)
  await journal.sync()

  remote.records.delete(recordId(value.id))
  const pending = operation()
  journal.save(pending)
  const writes = remote.writes
  await journal.sync()

  assert.equal(journal.status.lastError?.code, 'JOURNAL_CONFLICT')
  assert.equal(journal.status.blocked, true)
  assert.equal(journal.status.pending, 1)
  assert.equal(remote.writes, writes)
  assert.deepEqual(new Journal(directory, owner).get(pending.id), pending)
})

test('a lost successful PUT response is recognized after restart with global revision gaps', async t => {
  const directory = temporary(t)
  const remote = new RemoteStore()
  const value = operation()
  value.status = 'failed'
  const journal = new Journal(directory, owner, false, remote)
  journal.save(value)
  remote.loseResponse = true
  await journal.sync()
  assert.equal(journal.status.pending, 1)
  assert.equal(journal.status.blocked, false)
  assert.equal(remote.writes, 1)
  remote.loseResponse = false
  const restored = new Journal(directory, owner, false, remote)
  await restored.sync()
  assert.equal(restored.status.pending, 0)
  assert.equal(remote.writes, 1)
  assert.equal(existsSync(pendingFile(directory)), false)
})

test('an update made during upload retains its own durable pending version', async t => {
  const directory = temporary(t)
  const remote = new RemoteStore()
  const journal = new Journal(directory, owner, false, remote)
  const value = operation()
  journal.save(value)
  remote.beforeReply = () => {
    remote.beforeReply = undefined
    value.version++
    value.status = 'failed'
    journal.save(value)
  }
  await journal.sync()
  assert.equal(journal.status.pending, 1)
  const restored = new Journal(directory, owner, false, remote)
  assert.equal(restored.get(value.id)?.status, 'failed')
  await restored.stop()
  assert.equal(restored.status.pending, 0)
  assert.equal(existsSync(pendingFile(directory)), false)
  assert.equal(
    (remote.records.get(recordId(value.id))?.data.operation as JsonObject)
      .version,
    2,
  )
})

test('acknowledged signatures survive offline restart without signing again', async t => {
  const directory = temporary(t)
  const remote = new RemoteStore()
  const chain = new FakeChain()
  chain.shouldMine = false
  const journal = new Journal(directory, owner, false, remote)
  const first = new Operations(journal, chain, 5)
  first.start()
  const value = first.submit(preview(), randomUUID())
  await until(() => first.get(value.id).status === 'waiting')
  await first.stop()
  await journal.sync()
  assert.equal(journal.status.pending, 0)
  const broadcasts = chain.broadcasts.length
  remote.available = false
  const recoveredJournal = new Journal(directory, owner, false, remote)
  await recoveredJournal.sync()
  const recovered = new Operations(recoveredJournal, chain, 5)
  t.after(() => recovered.stop())
  chain.shouldMine = true
  recovered.start()
  await until(() => recovered.get(value.id).status === 'succeeded')
  assert.equal(chain.signs.length, 1)
  assert.equal(chain.broadcasts.length, broadcasts + 1)
})

test('conflicting remote edits preserve pending data and block further execution', async t => {
  const directory = temporary(t)
  const remote = new RemoteStore()
  const journal = new Journal(directory, owner, false, remote)
  const value = operation()
  journal.save(value)
  await journal.sync()
  value.version++
  journal.save(value)
  const key = recordId(value.id)
  const record = remote.records.get(key)
  assert.ok(record)
  const data = structuredClone(record.data)
  ;(data.operation as JsonObject).status = 'failed'
  await remote.putTransaction(key, data, record.revision)
  const writes = remote.writes
  await journal.sync()
  assert.equal(journal.status.blocked, true)
  assert.equal(journal.status.lastError?.code, 'JOURNAL_CONFLICT')
  assert.equal(journal.status.pending, 1)
  assert.equal(remote.writes, writes)
  assert.ok(existsSync(pendingFile(directory)))
  assert.throws(() => journal.save(value), { code: 'JOURNAL_CONFLICT' })
})

test('conflict discovered while RPC nonce is pending prevents broadcast', async t => {
  const directory = temporary(t)
  const remote = new RemoteStore()
  const journal = new Journal(directory, owner, false, remote)
  const chain = new FakeChain()
  const operations = new Operations(journal, chain, 5)
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let polling = false
  chain.nonce = async () => {
    polling = true
    await gate
    return 0
  }
  operations.start()
  const value = operations.submit(preview(), randomUUID())
  try {
    await until(() => polling)
    await journal.sync()
    const key = recordId(value.id)
    const record = remote.records.get(key)
    assert.ok(record)
    await remote.putTransaction(
      key,
      { ...record.data, unexpected: true },
      record.revision,
    )
    await journal.sync()
    assert.equal(operations.fatal, true)
    release()
    await operations.stop()
    assert.equal(chain.broadcasts.length, 0)
  } finally {
    release()
    await operations.stop()
  }
})

test('read only reads remote history and never changes local recovery or remote records', async t => {
  const directory = temporary(t)
  const remote = new RemoteStore()
  const value = operation()
  const writer = new Journal(directory, owner, false, remote)
  writer.save(value)
  await writer.sync()
  const saved = readFileSync(pendingFile(directory), 'utf8')
  const writes = remote.writes
  const reader = new Journal(directory, owner, true, remote)
  await reader.sync()
  await reader.stop()
  assert.equal(reader.get(value.id)?.id, value.id)
  assert.equal(readFileSync(pendingFile(directory), 'utf8'), saved)
  assert.equal(remote.writes, writes)
  assert.throws(() => reader.save(value), { code: 'READ_ONLY' })
})

test('legacy local journal migrates durably and is removed only after staging', async t => {
  const directory = temporary(t)
  const value = operation()
  const legacy = join(directory, 'operations.json')
  writeFileSync(
    legacy,
    JSON.stringify({
      format: 1,
      owner,
      chainId: CHAIN_ID,
      operations: [value],
    }),
  )
  const reader = new Journal(directory, owner, true)
  assert.equal(reader.get(value.id)?.id, value.id)
  assert.ok(existsSync(legacy))
  assert.equal(existsSync(pendingFile(directory)), false)
  const journal = new Journal(directory, owner)
  assert.equal(existsSync(legacy), false)
  assert.ok(existsSync(pendingFile(directory)))
  assert.deepEqual(journal.get(value.id), value)
})

test('read only does not merge legacy and pending journals from different owners', async t => {
  const directory = temporary(t)
  const remote = new RemoteStore()
  const journal = new Journal(directory, owner, false, remote)
  journal.save(operation())
  await journal.sync()
  const saved = readFileSync(pendingFile(directory), 'utf8')
  const legacy = join(directory, 'operations.json')
  writeFileSync(
    legacy,
    JSON.stringify({
      format: 1,
      owner: '0x0000000000000000000000000000000000000002',
      chainId: CHAIN_ID,
      operations: [operation()],
    }),
  )

  assert.throws(() => new Journal(directory, owner, true), {
    code: 'JOURNAL_OWNER_MISMATCH',
  })
  assert.equal(readFileSync(pendingFile(directory), 'utf8'), saved)
  assert.equal(existsSync(legacy), true)
})

test('local staging failure prevents any transaction from being sent', async t => {
  const directory = temporary(t)
  const journal = new Journal(directory, owner)
  mkdirSync(`${pendingFile(directory)}.tmp`)
  const chain = new FakeChain()
  const operations = new Operations(journal, chain, 5)
  operations.start()
  t.after(() => operations.stop())
  assert.throws(() => operations.submit(preview(), randomUUID()), {
    code: 'JOURNAL_WRITE_FAILED',
  })
  assert.equal(operations.fatal, true)
  assert.equal(chain.signs.length, 0)
  assert.equal(chain.broadcasts.length, 0)
})

test('malformed scoped remote records block recovery instead of executing arbitrary states', async t => {
  const remote = new RemoteStore()
  const value = operation()
  remote.records.set(recordId(value.id), {
    id: recordId(value.id),
    revision: 11,
    updatedAt: new Date().toISOString(),
    data: {
      format: 'ore-vein-operation/1',
      owner,
      chainId: CHAIN_ID,
      operation: { id: value.id },
    },
  })
  const journal = new Journal(temporary(t), owner, false, remote)
  await journal.sync()
  assert.equal(journal.status.blocked, true)
  assert.equal(journal.status.lastError?.code, 'INVALID_JOURNAL')
  assert.equal(journal.all().length, 0)
})

test('recovery rejects unknown execution constraints and impossible completed steps', async t => {
  const value = operation()
  const variants = [
    {
      ...value,
      guards: [
        {
          contract: 'oreVein',
          method: 'owner',
          args: [],
          expected: owner,
          additionalConstraint: 'must not be silently discarded',
        },
      ],
    },
    {
      ...value,
      status: 'succeeded',
      steps: [{ ...value.steps[0], status: 'skipped' }],
    },
    {
      ...value,
      status: 'succeeded',
      steps: [
        {
          ...value.steps[0],
          status: 'confirmed',
          signed: { raw: 'signed', hash: 'hash', nonce: 0, maxFee: '1' },
          receipt: {
            hash: 'hash',
            blockNumber: 1,
            status: 0,
            fee: '1',
            logs: [],
          },
        },
      ],
    },
  ]
  for (const variant of variants) {
    const remote = new RemoteStore()
    remote.records.set(recordId(value.id), {
      id: recordId(value.id),
      revision: 11,
      updatedAt: new Date().toISOString(),
      data: JSON.parse(
        JSON.stringify({
          format: 'ore-vein-operation/1',
          owner,
          chainId: CHAIN_ID,
          operation: variant,
        }),
      ),
    })
    const journal = new Journal(temporary(t), owner, false, remote)
    await journal.sync()
    assert.equal(journal.status.blocked, true)
    assert.equal(journal.status.lastError?.code, 'INVALID_JOURNAL')
    assert.equal(journal.all().length, 0)
  }
})
