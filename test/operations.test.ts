import test from 'node:test'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

import { AppError } from '../src/shared/index.js'
import type { OperationView } from '../src/operations/index.js'
import { until, engine, preview, temporary } from './helpers.js'
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

test('public operation views cannot mutate queued steps or confirmed receipts', async t => {
  const { chain, operations } = engine(t)
  chain.allowanceValue = 1n
  const operation = operations.submit(preview(true), randomUUID())
  const approval = operation.steps[1].approval
  assert.ok(approval)
  approval.amount = '999'
  await until(() => operations.get(operation.id).status === 'succeeded')
  assert.equal(operations.get(operation.id).steps[1].approval?.amount, '100')

  for (const view of [operations.get(operation.id), operations.list()[0]]) {
    const receipt = view.steps[2].receipt
    assert.ok(receipt)
    receipt.fee = '999'
    receipt.logs.push({ address: 'changed', data: '0x', topics: [] })
  }
  const receipt = operations.get(operation.id).steps[2].receipt
  assert.equal(receipt?.fee, '5')
  assert.deepEqual(receipt?.logs, [])
})

test('subscribers receive independent snapshots of operation state', async t => {
  const { operations } = engine(t)
  operations.subscribe(view => {
    view.status = 'failed'
    view.summary.changed = true
    const approval = view.steps[1].approval
    assert.ok(approval)
    approval.amount = '999'
  })
  const snapshots: OperationView[] = []
  operations.subscribe(view => snapshots.push(view))
  const operation = operations.submit(preview(true), randomUUID())
  await until(() => operations.get(operation.id).status === 'succeeded')
  assert.equal(snapshots[0].status, 'queued')
  assert.equal(snapshots.at(-1)?.status, 'succeeded')
  for (const view of snapshots) {
    assert.equal(view.summary.changed, undefined)
    assert.equal(view.steps[1].approval?.amount, '100')
  }
  assert.equal(operations.get(operation.id).summary.changed, undefined)
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
  const { chain, journal, operations } = engine(t)
  const save = journal.save.bind(journal)
  journal.save = value => {
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
  const { chain, journal, operations } = engine(t)
  chain.shouldMine = false
  const first = operations.submit(preview(), randomUUID())
  await until(() => operations.get(first.id).status === 'waiting')
  const pending = journal.get(first.id)
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

test('read only preserves queued operations and never resends saved signatures', async t => {
  const { chain, directory, operations } = engine(t)
  chain.shouldMine = false
  const pending = operations.submit(preview(), randomUUID())
  await until(() => operations.get(pending.id).status === 'waiting')
  const queued = operations.submit(preview(), randomUUID())
  await operations.stop()
  const path = join(directory, 'operations.json')
  const saved = readFileSync(path, 'utf8')
  const signs = chain.signs.length
  const broadcasts = chain.broadcasts.length
  chain.readOnly = true
  const recovered = new Operations(
    new Journal(directory, chain.owner, true),
    chain,
    5,
  )
  recovered.start()
  await recovered.stop()
  assert.equal(recovered.get(pending.id).status, 'waiting')
  assert.equal(recovered.get(queued.id).status, 'queued')
  assert.equal(recovered.count, 2)
  assert.throws(() => recovered.submit(preview(), randomUUID()), {
    code: 'READ_ONLY',
    status: 403,
  })
  await assert.rejects(recovered.resolve(pending.id, 'replacement'), {
    code: 'READ_ONLY',
    status: 403,
  })
  assert.equal(chain.signs.length, signs)
  assert.equal(chain.broadcasts.length, broadcasts)
  assert.equal(readFileSync(path, 'utf8'), saved)
})

test('read only can inspect an old owner journal without modifying it', async t => {
  const { directory, operations } = engine(t)
  const operation = operations.submit(preview(), randomUUID())
  await until(() => operations.get(operation.id).status === 'succeeded')
  await operations.stop()
  const saved = readFileSync(join(directory, 'operations.json'), 'utf8')
  const reader = new Journal(
    directory,
    '0x0000000000000000000000000000000000000002',
    true,
  )
  assert.deepEqual(reader.all(), JSON.parse(saved).operations)
  const stored = reader.get(operation.id)
  assert.ok(stored)
  assert.throws(() => reader.save(stored), { code: 'READ_ONLY', status: 403 })
  assert.equal(readFileSync(join(directory, 'operations.json'), 'utf8'), saved)
})

test('read only works without creating a data directory or journal', t => {
  const directory = join(temporary(t), 'absent')
  const journal = new Journal(directory, 'owner', true)
  assert.deepEqual(journal.all(), [])
  assert.equal(existsSync(directory), false)
})

for (const rpc of ['receipt', 'nonce', 'broadcast'] as const) {
  for (const rejects of [false, true]) {
    for (const matches of [false, true]) {
      test(`resolved ${matches ? 'speedup' : 'cancellation'} survives pending ${rpc} ${rejects ? 'failure' : 'response'}`, async t => {
        const { chain, directory, operations } = engine(t)
        chain.shouldMine = false
        let release = () => {}
        const gate = new Promise<void>(resolve => {
          release = resolve
        })
        let pending = false
        const pause = async () => {
          if (pending) {
            return
          }
          pending = true
          await gate
          if (rejects) {
            throw new Error('RPC unavailable')
          }
        }
        if (rpc === 'receipt') {
          const receipt = chain.receipt.bind(chain)
          chain.receipt = async hash => {
            if (chain.broadcasts.length > 0 && !pending) {
              await pause()
              return null
            }
            return receipt(hash)
          }
        } else if (rpc === 'nonce') {
          chain.nonce = async () => {
            if (chain.broadcasts.length > 0) {
              await pause()
            }
            return chain.currentNonce
          }
        } else {
          const broadcast = chain.broadcast.bind(chain)
          chain.broadcast = async raw => {
            await broadcast(raw)
            await pause()
          }
        }
        chain.replacement = async hash => ({
          receipt: { hash, blockNumber: 2, status: 1, fee: '7', logs: [] },
          matches,
        })
        const plan = preview()
        plan.plan.steps.push({
          code: 'EXECUTE',
          call: { to: 'oreVein', data: 'next', value: '0' },
          gasEstimate: { status: 'requires_prior_steps', maxGasWei: null },
        })
        try {
          const first = operations.submit(plan, randomUUID())
          await until(() => pending)
          const later = operations.submit(preview(), randomUUID())
          chain.currentNonce = 1
          const resolved = await operations.resolve(first.id, 'replacement')
          if (!matches) {
            assert.equal(resolved.status, 'failed')
            assert.equal(resolved.error?.code, 'TRANSACTION_REPLACED')
            assert.equal(resolved.gasSpentWei, '7')
          }
          chain.shouldMine = true
          release()
          await until(() => operations.get(later.id).status === 'succeeded')
          const result = operations.get(first.id)
          assert.equal(result.steps[0].receipt?.hash, 'replacement')
          assert.equal(result.gasSpentWei, matches ? '12' : '7')
          assert.equal(chain.signs.length, matches ? 3 : 2)
          if (matches) {
            assert.equal(result.status, 'succeeded')
            assert.equal(result.steps[0].status, 'confirmed')
            assert.equal(result.steps[0].error, undefined)
          } else {
            assert.deepEqual(result, resolved)
            assert.equal(result.steps[0].status, 'failed')
            assert.equal(result.steps[1].status, 'pending')
          }
          assert.equal(
            new Journal(directory, chain.owner).get(first.id)?.status,
            result.status,
          )
        } finally {
          release()
          await operations.stop()
        }
      })
    }
  }
}

test('failure to read the result preserves a confirmed withdrawal', async t => {
  const { chain, operations } = engine(t)
  chain.readResult = async () => {
    throw new AppError('RPC_UNAVAILABLE')
  }
  const plan = preview()
  plan.request.action = {
    kind: 'uniswap.close',
    params: { tokenId: '1', slippageBps: 100 },
  }
  const operation = operations.submit(plan, randomUUID())
  await until(() => operations.get(operation.id).status === 'succeeded')
  assert.deepEqual(operations.get(operation.id).result, {
    error: { code: 'RPC_UNAVAILABLE' },
  })
  assert.equal(operations.get(operation.id).gasSpentWei, '5')
})

test('withdrawal result is published and survives a restart', async t => {
  const { chain, directory, operations } = engine(t)
  const plan = preview()
  plan.request.action = {
    kind: 'uniswap.close',
    params: { tokenId: '1', slippageBps: 100 },
  }
  const result = {
    tokenId: '1',
    nftExists: true,
    liquidity: '25',
    blockNumber: 1,
  }
  chain.readResult = async (action, receipt) => {
    assert.deepEqual(action, plan.request.action)
    assert.equal(receipt.blockNumber, result.blockNumber)
    return result
  }
  let published: unknown
  operations.subscribe(value => {
    published = value.result
  })
  const operation = operations.submit(plan, randomUUID())
  await until(() => operations.get(operation.id).status === 'succeeded')
  assert.deepEqual(operations.get(operation.id).result, result)
  assert.deepEqual(published, result)
  await operations.stop()
  assert.deepEqual(
    new Journal(directory, chain.owner).get(operation.id)?.result,
    result,
  )
})
