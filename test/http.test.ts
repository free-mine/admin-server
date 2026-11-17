import test from 'node:test'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { TestContext } from 'node:test'

import { WebSocket } from 'ws'

import type { Chain } from '../src/chain/index.js'
import { createServer } from '../src/http/index.js'
import { readConfig } from '../src/config/index.js'
import { until, engine, preview } from './helpers.js'
import type { Previews } from '../src/operations/index.js'
import type { Successors } from '../src/successors/index.js'

const pin = '001234'

function server(t: TestContext, domain = 'localhost') {
  const { chain, operations, journal } = engine(t)
  const plan = preview()
  const app = createServer({
    config: readConfig({
      RPC_URL: 'http://127.0.0.1:18545',
      ALLOWED_DOMAIN: domain,
      PANEL_PIN: pin,
      PRIVATE_KEY: '1'.repeat(64),
    }),
    operations,
    journal,
    chain: chain as unknown as Chain,
    previews: { get: () => plan } as unknown as Previews,
    successors: {} as Successors,
  })
  t.after(() => app.close())
  return { app, chain, operations, plan }
}

async function login(
  app: ReturnType<typeof createServer>,
  domain = 'localhost',
) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/session',
    headers: { host: domain, origin: `http://${domain}` },
    payload: { pin },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { authenticated: true })
  const cookie = response.headers['set-cookie']
  assert.equal(typeof cookie, 'string')
  assert.match(String(cookie), /^panel_session=[^;]+;/)
  assert.match(String(cookie), /HttpOnly/i)
  assert.match(String(cookie), /SameSite=Strict/i)
  assert.ok(!String(cookie).includes(pin))
  return String(cookie).split(';')[0]
}

test('authenticated HTTP ordering, idempotency and WebSocket snapshots', async t => {
  const { app, chain, plan } = server(t)
  const headers = { host: 'localhost', cookie: await login(app) }
  const response = await app.inject({ url: '/v1/fund/shifts/abc', headers })
  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), {
    error: { code: 'INVALID_REQUEST', fields: ['id'] },
  })
  const previewResponse = await app.inject({
    method: 'POST',
    url: '/v1/previews',
    headers,
    payload: {
      action: { kind: 'uniswap.collect', params: { tokenId: 'abc' } },
      maxGasAvax: '0.1',
    },
  })
  assert.equal(previewResponse.statusCode, 400)
  assert.deepEqual(previewResponse.json(), {
    error: { code: 'INVALID_REQUEST', fields: ['action.params.tokenId'] },
  })
  const url = await app.listen({ host: '127.0.0.1', port: 0 })
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/v1/ws`, {
    origin: 'http://localhost:5173',
    headers,
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
    headers,
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
    headers,
  })
  assert.equal(repeated.statusCode, 200)
  assert.equal(repeated.json().id, id)
  const page = (
    await app.inject({ url: '/v1/operations?offset=0&limit=1', headers })
  ).json()
  assert.equal(page.total, 1)
  assert.equal(page.operations[0].id, id)
  const emptyPage = (
    await app.inject({ url: '/v1/operations?offset=1&limit=1', headers })
  ).json()
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

test('HTTP accepts only the configured origin hostname', async t => {
  const domain = 'admin.example'
  const { app } = server(t, domain)
  const cookie = await login(app, domain)
  const cases = [
    [undefined, true],
    ['http://admin.example', true],
    ['https://admin.example:9443', true],
    ['https://untrusted.example', false],
    ['http://admin.example.untrusted.example:5173', false],
    ['http://app.admin.example:5173', false],
    ['ftp://admin.example:5173', false],
    ['http://admin.example:65536', false],
    ['http://user@admin.example:5173', false],
    ['http://admin.example:5173/path', false],
    ['http://admin.example.', false],
    ['null', false],
  ] as const
  for (const [origin, allowed] of cases) {
    await t.test(origin ?? 'no Origin', async () => {
      const response = await app.inject({
        url: '/v1/config',
        headers: {
          host: domain,
          cookie,
          ...(origin === undefined ? {} : { origin }),
        },
      })
      assert.equal(response.statusCode, allowed ? 200 : 403)
      assert.equal(
        response.headers['access-control-allow-origin'],
        allowed ? origin : undefined,
      )
      if (!allowed) {
        assert.deepEqual(response.json(), {
          error: { code: 'DOMAIN_NOT_ALLOWED' },
        })
        assert.ok(!JSON.stringify(response.headers).includes(domain))
        assert.ok(!response.body.includes(domain))
      }
    })
  }
})

test('preflight and WebSocket enforce domain checks independently of the session', async t => {
  const domain = 'admin.example'
  const { app } = server(t, domain)
  const cookie = await login(app, domain)
  const url = await app.listen({ host: '127.0.0.1', port: 0 })
  const preflight = await app.inject({
    method: 'OPTIONS',
    url: '/v1/operations',
    headers: {
      'host': `${domain}:5175`,
      'origin': `https://${domain}`,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  })
  assert.equal(preflight.statusCode, 204)
  assert.equal(
    preflight.headers['access-control-allow-origin'],
    `https://${domain}`,
  )
  assert.equal(preflight.headers.vary, 'Origin')
  assert.equal(preflight.headers['access-control-allow-credentials'], 'true')
  assert.equal(
    preflight.headers['access-control-allow-methods'],
    'GET,POST,OPTIONS',
  )
  assert.equal(
    preflight.headers['access-control-allow-headers'],
    'Content-Type',
  )

  for (const headers of [
    { host: domain, origin: 'https://untrusted.example', cookie },
    { 'host': 'untrusted.example', 'x-forwarded-host': domain, cookie },
  ]) {
    assert.equal(
      (await app.inject({ method: 'OPTIONS', url: '/v1/operations', headers }))
        .statusCode,
      403,
    )
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/v1/ws`, {
      headers,
    })
    t.after(() => socket.terminate())
    const [error] = await once(socket, 'error')
    assert.match(error.message, /Unexpected server response: 403/)
  }
})

test('PIN guards reads, mutations and WebSocket before authentication', async t => {
  const { app, chain } = server(t)
  assert.deepEqual((await app.inject('/v1/session')).json(), {
    authenticated: false,
  })
  for (const url of ['/ready', '/v1/config', '/v1/journal', '/v1/operations']) {
    const response = await app.inject(url)
    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { error: { code: 'AUTH_REQUIRED' } })
  }
  for (const url of [
    '/v1/previews',
    '/v1/operations',
    `/v1/operations/${randomUUID()}/resolve`,
  ]) {
    const response = await app.inject({ method: 'POST', url, payload: {} })
    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { error: { code: 'AUTH_REQUIRED' } })
  }
  const url = await app.listen({ host: '127.0.0.1', port: 0 })
  for (const cookie of [undefined, 'panel_session=fake']) {
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/v1/ws`, {
      origin: 'http://localhost',
      headers: { host: 'localhost', ...(cookie ? { cookie } : {}) },
    })
    t.after(() => socket.terminate())
    const [error] = await once(socket, 'error')
    assert.match(error.message, /Unexpected server response: 401/)
  }
  assert.equal(chain.signs.length, 0)
})

test('public access follows the matched route, including HEAD and query strings', async t => {
  const { app } = server(t)
  for (const method of ['GET', 'HEAD'] as const) {
    for (const url of ['/health?probe=1', '/v1/session?probe=1']) {
      assert.equal((await app.inject({ method, url })).statusCode, 200)
      assert.equal(
        (
          await app.inject({
            method,
            url,
            headers: { host: 'untrusted.example' },
          })
        ).statusCode,
        403,
      )
    }
  }
  for (const [method, url] of [
    ['HEAD', '/v1/config'],
    ['GET', '/v1/session/logout'],
    ['GET', '/v1/session/unknown'],
    ['POST', '/health'],
    ['GET', '/unknown'],
  ] as const) {
    assert.equal((await app.inject({ method, url })).statusCode, 401)
  }
})

test('invalid submissions are rejected before querying RPC ownership', async t => {
  const { app, chain, plan } = server(t)
  const headers = { cookie: await login(app) }
  const ownership = t.mock.method(chain, 'assertOwner', async () => {
    throw new Error('RPC unavailable')
  })
  const invalid = await app.inject({
    method: 'POST',
    url: '/v1/operations',
    headers,
    payload: {},
  })
  assert.equal(invalid.statusCode, 400)
  assert.equal(invalid.json().error.code, 'INVALID_REQUEST')
  assert.equal(ownership.mock.callCount(), 0)

  const valid = await app.inject({
    method: 'POST',
    url: '/v1/operations',
    headers,
    payload: { previewId: plan.id, requestId: randomUUID() },
  })
  assert.equal(valid.statusCode, 500)
  assert.equal(ownership.mock.callCount(), 1)
  assert.equal(chain.signs.length, 0)
})

test('session cookie permits access and logout revokes HTTP and an active socket', async t => {
  const { app } = server(t)
  const cookie = await login(app)
  const headers = { host: 'localhost', cookie }
  assert.deepEqual((await app.inject({ url: '/v1/session', headers })).json(), {
    authenticated: true,
  })
  const config = await app.inject({ url: '/v1/config', headers })
  assert.equal(config.statusCode, 200)
  assert.ok(!config.body.includes(pin))
  assert.deepEqual((await app.inject({ url: '/v1/journal', headers })).json(), {
    blocked: false,
  })
  const url = await app.listen({ host: '127.0.0.1', port: 0 })
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/v1/ws`, {
    headers,
  })
  t.after(() => socket.terminate())
  await once(socket, 'message')
  const closed = once(socket, 'close')
  const logout = await app.inject({
    method: 'POST',
    url: '/v1/session/logout',
    headers,
  })
  assert.equal(logout.statusCode, 200)
  assert.deepEqual(logout.json(), { authenticated: false })
  assert.match(String(logout.headers['set-cookie']), /Max-Age=0/i)
  await closed
  assert.deepEqual((await app.inject({ url: '/v1/session', headers })).json(), {
    authenticated: false,
  })
  assert.equal(
    (await app.inject({ url: '/v1/config', headers })).statusCode,
    401,
  )
})

test('session tokens do not survive server restart', async t => {
  const first = server(t)
  const cookie = await login(first.app)
  const second = server(t)
  assert.equal(
    (await second.app.inject({ url: '/v1/config', headers: { cookie } }))
      .statusCode,
    401,
  )
})

test('HTTPS login sets a secure cookie without exposing the PIN', async t => {
  const { app } = server(t, 'admin.example')
  const response = await app.inject({
    method: 'POST',
    url: '/v1/session',
    headers: { host: 'admin.example', origin: 'https://admin.example' },
    payload: { pin },
  })
  assert.equal(response.statusCode, 200)
  assert.match(String(response.headers['set-cookie']), /; Secure/i)
  assert.ok(!response.body.includes(pin))
})

test('PIN guessing is limited even when forwarded addresses change', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const { app } = server(t)
  for (let index = 0; index < 5; index++) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/session',
      headers: { 'x-forwarded-for': `192.0.2.${index}` },
      payload: { pin: '999999' },
    })
    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { error: { code: 'INVALID_PIN' } })
    assert.equal(response.headers['set-cookie'], undefined)
  }
  const limited = await app.inject({
    method: 'POST',
    url: '/v1/session',
    headers: { 'x-forwarded-for': '192.0.2.100' },
    payload: { pin },
  })
  assert.equal(limited.statusCode, 429)
  assert.deepEqual(limited.json(), { error: { code: 'AUTH_RATE_LIMITED' } })
  assert.equal(limited.headers['set-cookie'], undefined)
  t.mock.timers.tick(15 * 60 * 1000 + 1)
  await login(app)
})

test('expired sessions deny HTTP access and require another PIN login', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const { app } = server(t)
  const headers = { cookie: await login(app) }
  t.mock.timers.tick(12 * 60 * 60 * 1000 + 1)
  assert.deepEqual((await app.inject({ url: '/v1/session', headers })).json(), {
    authenticated: false,
  })
  assert.equal(
    (await app.inject({ url: '/v1/config', headers })).statusCode,
    401,
  )
  assert.equal(
    (
      await app.inject({
        url: '/v1/operations',
        method: 'POST',
        headers,
        payload: {},
      })
    ).statusCode,
    401,
  )
  await login(app)
})
