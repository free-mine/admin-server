import test from 'node:test'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

import { CHAIN_ID } from '../src/config/index.js'
import type { Operation } from '../src/operations/index.js'
import { preview, temporary, FakeChain } from './helpers.js'
import { Journal, Operations } from '../src/operations/index.js'

const owner = new FakeChain().owner
const journalFile = (directory: string) => join(directory, 'operations.json')
const pendingFile = (directory: string) =>
  join(directory, 'operations.pending.json')

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

function writeJournal(
  directory: string,
  operations: unknown[],
  journalOwner = owner,
  chainId = CHAIN_ID,
) {
  writeFileSync(
    journalFile(directory),
    JSON.stringify({ format: 1, owner: journalOwner, chainId, operations }),
  )
}

function writePending(
  directory: string,
  entries: unknown[],
  active: unknown[] = [],
  journalOwner = owner,
) {
  writeFileSync(
    pendingFile(directory),
    JSON.stringify({
      format: 2,
      owner: journalOwner,
      chainId: CHAIN_ID,
      entries,
      active,
    }),
  )
}

test('saving another operation never persists unsaved in-memory mutations', t => {
  const directory = temporary(t)
  const journal = new Journal(directory, owner)
  const value = operation()
  journal.save(value)
  value.summary = { unsaved: true }
  journal.save(operation())
  assert.deepEqual(new Journal(directory, owner).get(value.id)?.summary, {})
})

test('a rejected identity conflict cannot enter memory or a later disk snapshot', t => {
  const directory = temporary(t)
  const journal = new Journal(directory, owner)
  const first = operation()
  journal.save(first)
  for (const key of ['requestId', 'previewId'] as const) {
    const rejected = { ...operation(), [key]: first[key] }
    assert.throws(() => journal.save(rejected), { code: 'JOURNAL_CONFLICT' })
    assert.equal(journal.get(rejected.id), undefined)
  }
  const second = operation()
  journal.save(second)
  assert.deepEqual(new Journal(directory, owner).all(), [first, second])
})

test('pending signatures, terminal records and acknowledged active work migrate durably', t => {
  const directory = temporary(t)
  const pending = operation()
  pending.status = 'waiting'
  pending.steps[0].status = 'confirming'
  pending.steps[0].signed = {
    raw: 'signed-secret',
    hash: 'hash',
    nonce: 4,
    maxFee: '10',
  }
  const terminal = operation()
  terminal.status = 'failed'
  terminal.steps[0].status = 'failed'
  const active = operation()
  writePending(
    directory,
    [
      {
        operation: pending,
        baseRevision: 12,
        attempt: { operation: pending, baseRevision: 12 },
      },
      { operation: terminal, baseRevision: null },
    ],
    [{ operation: active, revision: 5 }],
  )
  const restored = new Journal(directory, owner)
  assert.deepEqual(restored.get(pending.id), pending)
  assert.deepEqual(restored.get(terminal.id), terminal)
  assert.deepEqual(restored.get(active.id), active)
  assert.equal(existsSync(pendingFile(directory)), false)
  assert.deepEqual(new Journal(directory, owner).all(), restored.all())
})

test('migration resumes safely if both durable files contain identical records', t => {
  const directory = temporary(t)
  const value = operation()
  writeJournal(directory, [value])
  writePending(directory, [{ operation: value, baseRevision: null }])
  assert.deepEqual(new Journal(directory, owner).all(), [value])
  assert.equal(existsSync(pendingFile(directory)), false)
})

test('migration preserves legacy data if the durable local write fails', t => {
  const directory = temporary(t)
  writePending(directory, [{ operation: operation(), baseRevision: null }])
  const before = readFileSync(pendingFile(directory), 'utf8')
  mkdirSync(`${journalFile(directory)}.tmp`)
  assert.throws(() => new Journal(directory, owner), {
    code: 'JOURNAL_WRITE_FAILED',
  })
  assert.equal(readFileSync(pendingFile(directory), 'utf8'), before)
  assert.equal(existsSync(journalFile(directory)), false)
})

test('read only loads pending data without migrating or changing either file', t => {
  const directory = temporary(t)
  const first = operation()
  const second = operation()
  writeJournal(directory, [first])
  writePending(directory, [{ operation: second, baseRevision: null }])
  const saved = readFileSync(journalFile(directory), 'utf8')
  const pending = readFileSync(pendingFile(directory), 'utf8')
  const reader = new Journal(
    directory,
    '0x0000000000000000000000000000000000000002',
    true,
  )
  assert.equal(reader.all().length, 2)
  assert.throws(() => reader.save(first), { code: 'READ_ONLY' })
  assert.equal(readFileSync(journalFile(directory), 'utf8'), saved)
  assert.equal(readFileSync(pendingFile(directory), 'utf8'), pending)
})

test('read only can inspect an old owner pending journal without creating a local journal', t => {
  const directory = temporary(t)
  const value = operation()
  writePending(directory, [{ operation: value, baseRevision: null }])
  const reader = new Journal(
    directory,
    '0x0000000000000000000000000000000000000002',
    true,
  )
  assert.deepEqual(reader.all(), [value])
  assert.equal(existsSync(journalFile(directory)), false)
})

test('different journal owners and conflicting copies are refused without overwriting data', t => {
  const directory = temporary(t)
  const value = operation()
  writeJournal(directory, [value])
  writePending(
    directory,
    [{ operation: value, baseRevision: null }],
    [],
    '0x0000000000000000000000000000000000000002',
  )
  assert.throws(() => new Journal(directory, owner, true), {
    code: 'JOURNAL_OWNER_MISMATCH',
  })
  writePending(directory, [
    { operation: { ...value, version: 2 }, baseRevision: null },
  ])
  const before = readFileSync(journalFile(directory), 'utf8')
  assert.throws(() => new Journal(directory, owner), {
    code: 'JOURNAL_CONFLICT',
  })
  assert.equal(readFileSync(journalFile(directory), 'utf8'), before)
  assert.ok(existsSync(pendingFile(directory)))
})

test('local persistence failure prevents signing and sending transactions', async t => {
  const directory = temporary(t)
  const journal = new Journal(directory, owner)
  mkdirSync(`${journalFile(directory)}.tmp`)
  const chain = new FakeChain()
  const operations = new Operations(journal, chain, 5)
  operations.start()
  t.after(() => operations.stop())
  assert.throws(() => operations.submit(preview(), randomUUID()), {
    code: 'JOURNAL_WRITE_FAILED',
  })
  assert.deepEqual(journal.status, {
    blocked: true,
    lastError: { code: 'JOURNAL_WRITE_FAILED' },
  })
  assert.equal(operations.fatal, true)
  assert.equal(chain.signs.length, 0)
  assert.equal(chain.broadcasts.length, 0)
})

test('invalid journal identity and duplicate requests are rejected on startup', t => {
  const directory = temporary(t)
  const value = operation()
  writeJournal(directory, [value], '0x0000000000000000000000000000000000000002')
  assert.throws(() => new Journal(directory, owner), {
    code: 'JOURNAL_OWNER_MISMATCH',
  })
  writeJournal(directory, [value], owner, 1)
  assert.throws(() => new Journal(directory, owner), {
    code: 'JOURNAL_NETWORK_MISMATCH',
  })
  writeJournal(directory, [value, value])
  assert.throws(() => new Journal(directory, owner), {
    code: 'INVALID_JOURNAL',
  })
  writeJournal(directory, [
    value,
    { ...operation(), requestId: value.requestId },
  ])
  assert.throws(() => new Journal(directory, owner), {
    code: 'JOURNAL_CONFLICT',
  })
})

test('recovery rejects unknown execution constraints and impossible completed steps', t => {
  const value = operation()
  const variants = [
    {
      ...value,
      steps: [
        {
          ...value.steps[0],
          approval: { token: owner, spender: owner, amount: '1' },
        },
      ],
    },
    {
      ...value,
      steps: [
        {
          ...value.steps[0],
          code: 'ALLOWANCE_RESET',
          approval: { token: owner, spender: owner, amount: '0' },
        },
      ],
    },
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
    const directory = temporary(t)
    writeJournal(directory, [variant])
    assert.throws(() => new Journal(directory, owner), {
      code: 'INVALID_JOURNAL',
    })
  }
})
