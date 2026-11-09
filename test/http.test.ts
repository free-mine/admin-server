import test from 'node:test'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { WebSocket } from 'ws'

import type { Chain } from '../src/chain/index.js'
import { createServer } from '../src/http/index.js'
import { readConfig } from '../src/config/index.js'
import { until, engine, preview } from './helpers.js'
import type { Previews } from '../src/operations/index.js'
import type { Successors } from '../src/successors/index.js'

test('HTTP ordering, idempotency and WebSocket snapshots', async t => {
  const { chain, operations } = engine(t)
  const plan = preview()
  const config = readConfig({
    RPC_URL: 'http://127.0.0.1:18545',
    PRIVATE_KEY: '1'.repeat(64),
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
  const page = (await app.inject('/v1/operations?offset=0&limit=1')).json()
  assert.equal(page.total, 1)
  assert.equal(page.operations[0].id, id)
  const emptyPage = (await app.inject('/v1/operations?offset=1&limit=1')).json()
  assert.equal(emptyPage.total, 1)
  assert.deepEqual(emptyPage.operations, [])
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

test('HTTP and WebSocket accept localhost origins on any port', async t => {
  const { chain, operations } = engine(t)
  const app = createServer({
    config: readConfig({
      RPC_URL: 'http://127.0.0.1:18545',
      PRIVATE_KEY: '1'.repeat(64),
    }),
    operations,
    chain: chain as unknown as Chain,
    previews: {} as Previews,
    successors: {} as Successors,
  })
  t.after(() => app.close())
  const url = await app.listen({ host: '127.0.0.1', port: 0 })
  const cases = [
    [undefined, true],
    ['http://localhost', true],
    ['https://localhost', true],
    ['http://localhost:5173', true],
    ['http://localhost:8080', true],
    ['http://localhost:65535', true],
    ['https://localhost:9443', true],
    ['https://untrusted.example', false],
    ['http://localhost.untrusted.example:5173', false],
    ['http://app.localhost:5173', false],
    ['http://127.0.0.1:5173', false],
    ['http://[::1]:5173', false],
    ['ws://localhost:5173', false],
    ['ftp://localhost:5173', false],
    ['http://localhost:65536', false],
    ['http://user@localhost:5173', false],
    ['http://localhost:5173/', false],
    ['http://localhost:5173/path', false],
    ['http://localhost:5173?query', false],
    ['http://localhost:5173#fragment', false],
    ['null', false],
    ['invalid', false],
  ] as const
  for (const [origin, allowed] of cases) {
    await t.test(origin ?? 'no Origin', async t => {
      for (const method of ['GET', 'OPTIONS'] as const) {
        const response = await app.inject({
          method,
          url: '/v1/config',
          headers: {
            ...(origin === undefined ? {} : { origin }),
            ...(method === 'OPTIONS'
              ? {
                  'access-control-request-method': 'POST',
                  'access-control-request-headers': 'content-type',
                }
              : {}),
          },
        })
        assert.equal(
          response.statusCode,
          allowed ? (method === 'OPTIONS' ? 204 : 200) : 403,
        )
        assert.equal(
          response.headers['access-control-allow-origin'],
          allowed ? origin : undefined,
        )
        if (allowed && origin) {
          assert.equal(response.headers.vary, 'Origin')
          assert.equal(
            response.headers['access-control-allow-methods'],
            'GET,POST,OPTIONS',
          )
          assert.equal(
            response.headers['access-control-allow-headers'],
            'Content-Type',
          )
        }
        if (!allowed) {
          assert.equal(response.json().error.code, 'ORIGIN_NOT_ALLOWED')
        }
      }
      const socket = new WebSocket(`${url.replace('http:', 'ws:')}/v1/ws`, {
        origin,
      })
      t.after(() => socket.terminate())
      if (allowed) {
        const [data] = await once(socket, 'message')
        assert.equal(JSON.parse(String(data)).type, 'operations.snapshot')
      } else {
        const [error] = await once(socket, 'error')
        assert.match(error.message, /Unexpected server response: 403/)
      }
    })
  }
})
