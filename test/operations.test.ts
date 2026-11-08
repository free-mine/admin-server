import test from 'node:test'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { AppError } from '../src/shared/index.js'
import { until, engine, preview } from './helpers.js'
import { Journal, Operations } from '../src/operations/index.js'

test('one order executes reset, approval and action sequentially; signatures are private', async t => {
  const { chain, directory, operations } = engine(t)
  chain.allowanceValue = 1n
  chain.onBroadcast = () => {
    const saved = JSON.parse(
      readFileSync(join(directory, 'operations.json'), 'utf8'),
    )
    assert.ok(
      saved.operations[0].steps.some(
        (step: { signed?: unknown }) => step.signed,
      ),
    )
  }
  const operation = operations.submit(preview(true), randomUUID())
  await until(() => operations.get(operation.id).status === 'succeeded')
  assert.deepEqual(
    chain.broadcasts.map(raw => chain.signedCalls.get(raw)?.data),
    ['reset', 'approve', 'main'],
  )
  assert.equal(operations.get(operation.id).gasSpentWei, '15')
  assert.ok(
    !JSON.stringify(operations.get(operation.id)).includes('signed-secret'),
  )
})

test('sufficient allowances skip both optional transactions', async t => {
  const { chain, operations } = engine(t)
  chain.allowanceValue = 500n
  const operation = operations.submit(preview(true), randomUUID())
  await until(() => operations.get(operation.id).status === 'succeeded')
  assert.equal(chain.signs.length, 1)
  assert.deepEqual(
    operations.get(operation.id).steps.map(step => step.status),
    ['skipped', 'skipped', 'confirmed'],
  )
})

test('lost broadcast response is resolved by receipt without a second action', async t => {
  const { chain, operations } = engine(t)
  chain.loseResponse = true
  const operation = operations.submit(preview(), randomUUID())
  await until(() => operations.get(operation.id).status === 'succeeded')
  assert.equal(chain.signs.length, 1)
  assert.equal(chain.broadcasts.length, 1)
})

test('restart recovers an unmined signature, preserving nonce and hash', async t => {
  const { chain, directory, operations } = engine(t)
  chain.shouldMine = false
  const operation = operations.submit(preview(), randomUUID())
  await until(() => operations.get(operation.id).status === 'waiting')
  await operations.stop()
  chain.shouldMine = true
  const recovered = new Operations(
    new Journal(directory, chain.owner),
    chain,
    5,
  )
  t.after(() => recovered.stop())
  recovered.start()
  await until(() => recovered.get(operation.id).status === 'succeeded')
  assert.equal(chain.signs.length, 1)
  assert.equal(new Set(chain.broadcasts).size, 1)
})

test('mined transaction survives restart after lost local confirmation', async t => {
  const { chain, directory, operations } = engine(t)
  chain.shouldMine = false
  const operation = operations.submit(preview(), randomUUID())
  await until(() => operations.get(operation.id).status === 'waiting')
  await operations.stop()
  chain.shouldMine = true
  await chain.broadcast(chain.signs[0].raw)
  const count = chain.broadcasts.length
  const recovered = new Operations(
    new Journal(directory, chain.owner),
    chain,
    5,
  )
  t.after(() => recovered.stop())
  recovered.start()
  await until(() => recovered.get(operation.id).status === 'succeeded')
  assert.equal(chain.broadcasts.length, count)
  assert.equal(chain.signs.length, 1)
})

test('idempotency survives a restart and rejects conflicting input', async t => {
  const { chain, directory, operations } = engine(t)
  const plan = preview(),
    requestId = randomUUID()
  const operation = operations.submit(plan, requestId)
  assert.equal(operations.submit(plan, requestId).id, operation.id)
  assert.throws(
    () => operations.submit(plan, randomUUID()),
    /PREVIEW_ALREADY_SUBMITTED/,
  )
  await until(() => operations.get(operation.id).status === 'succeeded')
  await operations.stop()
  const recovered = new Operations(
    new Journal(directory, chain.owner),
    chain,
    5,
  )
  assert.equal(recovered.existing(requestId, plan.id)?.id, operation.id)
  assert.throws(
    () => recovered.existing(requestId, randomUUID()),
    /IDEMPOTENCY_CONFLICT/,
  )
  assert.equal(chain.signs.length, 1)
})

test('storage failure before broadcast stops the worker', async t => {
  const { chain, operations } = engine(t)
  const save = operations.journal.save.bind(operations.journal)
  operations.journal.save = value => {
    if (value.steps.some(step => step.signed)) {
      throw new AppError('JOURNAL_WRITE_FAILED')
    }
    save(value)
  }
  operations.submit(preview(), randomUUID())
  await until(() => operations.fatal)
  assert.equal(chain.broadcasts.length, 0)
})

test('expired pending signatures are never rebroadcast; queue waits for resolution', async t => {
  const { chain, operations } = engine(t)
  chain.shouldMine = false
  const first = operations.submit(preview(), randomUUID())
  await until(() => operations.get(first.id).status === 'waiting')
  const pending = operations.journal.get(first.id)
  assert.ok(pending)
  pending.expiresAt = Date.now() - 1
  await until(() => operations.get(first.id).status === 'needs_attention')
  const second = operations.submit(preview(), randomUUID())
  assert.equal(chain.signs.length, 1)
  chain.shouldMine = true
  await operations.resolve(first.id, 'replacement')
  await until(() => operations.get(second.id).status === 'succeeded')
  assert.equal(operations.get(first.id).error?.code, 'TRANSACTION_REPLACED')
  assert.equal(chain.broadcasts.length, 2)
})

test('main transaction revert stops remaining steps and records spent gas', async t => {
  const { chain, operations } = engine(t)
  chain.receipt = async hash => {
    const result = chain.mined.get(hash)
    return result ? { ...result, status: 0 } : null
  }
  const operation = operations.submit(preview(true), randomUUID())
  await until(() => operations.get(operation.id).status === 'failed')
  assert.equal(chain.signs.length, 1)
  assert.equal(operations.get(operation.id).error?.code, 'TRANSACTION_REVERTED')
  assert.equal(operations.get(operation.id).gasSpentWei, '5')
})

test('journal from another owner is refused', async t => {
  const { directory } = engine(t)
  assert.throws(
    () => new Journal(directory, '0x0000000000000000000000000000000000000002'),
    /JOURNAL_OWNER_MISMATCH/,
  )
})
