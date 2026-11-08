import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { WebSocket } from 'ws'

import type { Chain } from '../src/chain/index.js'
import { createServer } from '../src/http/index.js'
import { readConfig } from '../src/config/index.js'
import { until, engine, preview } from './helpers.js'
import type { Previews } from '../src/operations/index.js'
import type { Successors } from '../src/successors/index.js'

test('HTTP ordering, idempotency, origin policy and WebSocket snapshots', async t => {
  const { chain, operations, directory } = engine(t)
  const plan = preview()
  const config = readConfig({
    RPC_URL: 'http://127.0.0.1:18545',
    PRIVATE_KEY: '1'.repeat(64),
    DATA_DIR: directory,
  })
  const app = createServer({
    config,
    operations,
    chain: chain as unknown as Chain,
    previews: { get: () => plan } as unknown as Previews,
    successors: {} as Successors,
  })
  t.after(() => app.close())
  assert.equal((await app.inject('/health')).statusCode, 200)
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/v1/config',
        headers: { origin: 'https://untrusted.example' },
      })
    ).statusCode,
    403,
  )
  assert.equal(
    (await app.inject({ method: 'POST', url: '/v1/operations', payload: {} }))
      .statusCode,
    400,
  )
  const url = await app.listen({ host: '127.0.0.1', port: 0 })
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/v1/ws`, {
    origin: 'http://localhost:5173',
  })
  t.after(() => socket.terminate())
  const messages: {
    type: string
    operation?: { id: string; status: string; version: number }
  }[] = []
  socket.on('message', data => messages.push(JSON.parse(String(data))))
  await until(() =>
    messages.some(message => message.type === 'operations.snapshot'),
  )
  const payload = { previewId: plan.id, requestId: randomUUID() }
  const submitted = await app.inject({
    method: 'POST',
    url: '/v1/operations',
    payload,
  })
  assert.equal(submitted.statusCode, 202)
  const id = submitted.json().id as string
  await until(() =>
    messages.some(
      message =>
        message.operation?.id === id &&
        message.operation.status === 'succeeded',
    ),
  )
  const repeated = await app.inject({
    method: 'POST',
    url: '/v1/operations',
    payload,
  })
  assert.equal(repeated.statusCode, 200)
  assert.equal(repeated.json().id, id)
  assert.equal(chain.signs.length, 1)
  assert.ok(!JSON.stringify(messages).includes('signed-secret'))
  const versions = messages.flatMap(message =>
    message.operation ? [message.operation.version] : [],
  )
  assert.deepEqual(
    versions,
    [...versions].sort((a, b) => a - b),
  )
})
