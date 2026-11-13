import test from 'node:test'
import assert from 'node:assert/strict'

import { AppError } from '../src/shared/index.js'
import { PublicState } from '../src/public-state/index.js'

const snapshot = (number: number) => ({
  block: { number, timestamp: Math.floor(Date.now() / 1000) - 600 },
  updatedAt: new Date().toISOString(),
  fund: { value: 'snapshot, not a trade quote' },
})

test('refresh is retried until the public snapshot includes the confirmed block', async t => {
  let block = 10
  let refreshes = 0
  const state = new PublicState({
    state: async () => snapshot(block),
    refresh: async () => {
      refreshes++
      return { status: 'accepted' }
    },
  })
  t.after(() => state.stop())
  state.requireBlock(12)
  await state.sync()
  assert.equal(refreshes, 1)
  assert.equal(state.status.refreshPending, true)
  block = 11 // An earlier synchronization completed after /refresh returned 202.
  await state.sync()
  assert.equal(refreshes, 2)
  assert.equal(state.status.requiredBlock, 12)
  state.requireBlock(9)
  block = 12
  await state.sync()
  assert.equal(state.status.refreshPending, false)
  assert.equal(refreshes, 2)
  assert.equal((await state.read()).behindConfirmedTransactions, false)
})

test('cached overview keeps block age and outage visible without becoming a current quote', async t => {
  let offline = false
  const state = new PublicState({
    state: async () => {
      if (offline) {
        throw new AppError('PUBLIC_SERVER_UNAVAILABLE', 503)
      }
      return snapshot(10)
    },
    refresh: async () => ({}),
  })
  t.after(() => state.stop())
  const first = await state.read()
  assert.equal(first.source, 'public-server')
  assert.equal(first.cached, false)
  assert.ok(first.ageSeconds >= 600)
  first.snapshot.fund = null
  offline = true
  const cached = await state.read()
  assert.equal(cached.cached, true)
  assert.deepEqual(cached.snapshot.fund, {
    value: 'snapshot, not a trade quote',
  })
  assert.equal(state.status.lastError?.code, 'PUBLIC_SERVER_UNAVAILABLE')
})

test('an unavailable overview without a cached snapshot returns a clear error', async t => {
  const state = new PublicState({
    state: async () => {
      throw new AppError('PUBLIC_SERVER_UNAVAILABLE', 503)
    },
    refresh: async () => ({}),
  })
  t.after(() => state.stop())
  await assert.rejects(state.read(), {
    code: 'PUBLIC_SERVER_UNAVAILABLE',
    status: 503,
  })
  assert.equal(state.status.snapshotBlock, null)
})

test('concurrent overview reads share one in-flight request', async t => {
  let resolve = () => {}
  const gate = new Promise<void>(done => {
    resolve = done
  })
  let reads = 0
  const state = new PublicState({
    state: async () => {
      reads++
      await gate
      return snapshot(10)
    },
    refresh: async () => ({}),
  })
  t.after(() => state.stop())
  const first = state.read()
  const second = state.read()
  resolve()
  assert.deepEqual(await first, await second)
  assert.equal(reads, 1)
})

test('a failed owner refresh does not mark a successful public read as cached', async t => {
  const state = new PublicState({
    state: async () => snapshot(10),
    refresh: async () => {
      throw new AppError('PUBLIC_SERVER_KEY_REQUIRED', 503)
    },
  })
  t.after(() => state.stop())
  state.requireBlock(11)
  const value = await state.read()
  assert.equal(value.cached, false)
  assert.equal(value.behindConfirmedTransactions, true)
  assert.equal(state.status.available, true)
  assert.equal(state.status.lastError?.code, 'PUBLIC_SERVER_KEY_REQUIRED')
})
