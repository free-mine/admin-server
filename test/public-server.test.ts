import test from 'node:test'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { TestContext } from 'node:test'
import type { ServerResponse, RequestListener } from 'node:http'

import { AppError } from '../src/shared/index.js'
import { PublicState } from '../src/public-state/index.js'
import { PublicServer } from '../src/public-server/index.js'
import type { RemoteRecord } from '../src/public-server/index.js'
import { CHAIN_ID, addresses, DEPLOYMENT_TX } from '../src/config/index.js'

const key = 'owner-secret-for-tests'
const updatedAt = '2026-11-13T12:00:00.000Z'
const block = { number: 123, hash: `0x${'a'.repeat(64)}`, timestamp: 123456 }
const status = {
  running: false,
  lastError: null,
  lastAttemptAt: updatedAt,
  block,
  updatedAt,
  intervalMs: 600000,
}

function snapshot() {
  const magicOre = '0xfb58d4b7c4c9f834a7211b5ae0e636cbd1b2feac'
  const owner = `0x${'1'.repeat(40)}`
  return {
    format: 1,
    chain: {
      chainId: CHAIN_ID,
      deploymentTx: DEPLOYMENT_TX,
      magicOre,
      freeMine: addresses.freeMine.toLowerCase(),
      oreVein: addresses.oreVein.toLowerCase(),
    },
    block,
    updatedAt,
    fund: {
      magicOre: {
        name: 'Magic Ore',
        owner,
        symbol: 'ORE',
        decimals: 18,
        totalSupply: '0',
        holders: {},
      },
      oreVein: {
        owner,
        freeMine: addresses.freeMine.toLowerCase(),
        pendingOwner: `0x${'0'.repeat(40)}`,
        contractURI: '',
        admins: [],
        successors: {},
      },
      freeMine: {
        owner,
        magicOre,
        entryPrice: '1000000000000000000',
        priceUpdatedAt: '123456',
        currentShiftId: '1',
        dollar: { address: owner, decimals: 6 },
        claims: {},
        shifts: {},
      },
    },
    portfolio: {
      blockNumber: block.number,
      nativeBalance: { symbol: 'AVAX', decimals: 18, amount: '123' },
      balances: [],
      aave: { supplies: [], debts: [], healthFactor: null },
      uniswap: { pools: [], positions: [] },
    },
    extension: { preserved: true },
  }
}

async function mockServer(t: TestContext, handler: RequestListener) {
  const server = createServer(handler)
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

function send(response: ServerResponse, value: unknown, statusCode = 200) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

test('public reads retain snapshot metadata and support a base URL path', async t => {
  const data = {
    ...snapshot(),
    block: { ...block, extension: { preserved: true } },
  }
  const url = await mockServer(t, (request, response) => {
    assert.equal(request.headers.authorization, undefined)
    if (request.url === '/public/v1/state') {
      send(response, data)
    } else {
      assert.equal(request.url, '/public/v1/status')
      send(response, status)
    }
  })
  for (const suffix of ['/public', '/public/', '/public///']) {
    const client = new PublicServer({
      url: `${url}${suffix}`,
      key,
      timeoutMs: 1000,
    })
    assert.deepEqual(await client.state(), data)
    assert.deepEqual(await client.status(), status)
  }
})

test('owner requests use authentication and transaction revision preconditions', async t => {
  let record: RemoteRecord | undefined
  const url = await mockServer(t, async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${key}`)
    if (request.url === '/v1/refresh') {
      assert.equal(request.method, 'POST')
      send(
        response,
        {
          status: 'accepted',
          running: true,
          lastError: null,
          lastAttemptAt: updatedAt,
        },
        202,
      )
      return
    }
    if (request.url === '/v1/transactions') {
      send(response, { records: record ? [record] : [] })
      return
    }
    assert.equal(request.url, '/v1/transactions/operation%3A1')
    if (request.method === 'PUT') {
      assert.equal(request.headers['content-type'], 'application/json')
      assert.equal(request.headers['if-none-match'], record ? undefined : '*')
      assert.equal(request.headers['if-match'], record ? '"1"' : undefined)
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        chunks.push(chunk)
      }
      record = {
        id: 'operation:1',
        revision: record ? 2 : 1,
        updatedAt,
        data: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }
    }
    send(response, record ?? { error: 'Record not found' }, record ? 200 : 404)
  })
  const client = new PublicServer({ url, key, timeoutMs: 1000 })
  assert.equal(await client.getTransaction('operation:1'), undefined)
  const created = await client.putTransaction(
    'operation:1',
    { status: 'queued' },
    null,
  )
  assert.equal(created.revision, 1)
  assert.deepEqual(await client.listTransactions(), [created])
  const changed = await client.putTransaction(
    'operation:1',
    { status: 'signed' },
    1,
  )
  assert.equal(changed.revision, 2)
  assert.deepEqual(await client.getTransaction('operation:1'), changed)
  assert.equal((await client.refresh()).status, 'accepted')
})

test('upstream failures are classified without exposing response text or credentials', async t => {
  let statusCode = 500
  const url = await mockServer(t, (_request, response) => {
    send(response, { error: `Do not expose ${key} at ${url}` }, statusCode)
  })
  const client = new PublicServer({ url, key, timeoutMs: 1000 })
  for (const [code, expected] of [
    [401, 'PUBLIC_SERVER_UNAUTHORIZED'],
    [403, 'PUBLIC_SERVER_UNAUTHORIZED'],
    [412, 'PUBLIC_SERVER_CONFLICT'],
    [503, 'PUBLIC_SERVER_UNAVAILABLE'],
    [422, 'PUBLIC_SERVER_REQUEST_REJECTED'],
  ] as const) {
    statusCode = code
    await assert.rejects(client.listTransactions(), error => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, expected)
      assert.equal(error.message, expected)
      assert.ok(!String(error.stack).includes(key))
      assert.ok(!String(error.stack).includes(url))
      return true
    })
  }
})

test('snapshot identity, structure and block consistency are checked', async t => {
  let data: unknown
  const url = await mockServer(t, (_request, response) => send(response, data))
  const client = new PublicServer({ url, timeoutMs: 1000 })
  const valid = snapshot()
  for (const invalid of [
    { ...valid, chain: { ...valid.chain, chainId: 1 } },
    {
      ...valid,
      chain: { ...valid.chain, deploymentTx: `0x${'0'.repeat(64)}` },
    },
    { ...valid, chain: { ...valid.chain, oreVein: `0x${'0'.repeat(40)}` } },
    {
      ...valid,
      fund: {
        ...valid.fund,
        freeMine: { ...valid.fund.freeMine, magicOre: `0x${'0'.repeat(40)}` },
      },
    },
    { ...valid, fund: [] },
    { ...valid, block: { ...block, number: -1 } },
    { ...valid, block: { ...block, timestamp: -1 } },
    {
      ...valid,
      portfolio: { ...valid.portfolio, blockNumber: block.number + 1 },
    },
    { ...valid, updatedAt: 'not-a-date' },
  ]) {
    data = invalid
    await assert.rejects(client.state(), {
      code: 'PUBLIC_SERVER_INVALID_RESPONSE',
    })
  }
})

test('invalid upstream snapshots cannot replace the cached overview', async t => {
  let data = snapshot()
  const url = await mockServer(t, (_request, response) => send(response, data))
  const state = new PublicState(new PublicServer({ url, timeoutMs: 1000 }))
  t.after(() => state.stop())
  const first = await state.read()
  data = { ...data, block: { ...block, timestamp: -1 } }
  const cached = await state.read()
  assert.equal(cached.cached, true)
  assert.deepEqual(cached.snapshot, first.snapshot)
  assert.equal(state.status.snapshotBlock, block.number)
  assert.equal(state.status.lastError?.code, 'PUBLIC_SERVER_INVALID_RESPONSE')
})

test('invalid JSON and malformed transaction envelopes are rejected', async t => {
  let data: unknown = null
  let malformed = true
  const url = await mockServer(t, (_request, response) => {
    if (malformed) {
      response.end('{broken')
    } else {
      send(response, data)
    }
  })
  const client = new PublicServer({ url, key, timeoutMs: 1000 })
  await assert.rejects(client.status(), {
    code: 'PUBLIC_SERVER_INVALID_RESPONSE',
  })
  malformed = false
  await assert.rejects(client.status(), {
    code: 'PUBLIC_SERVER_INVALID_RESPONSE',
  })
  const record = {
    id: 'operation:1',
    revision: 1,
    updatedAt,
    data: { status: 'queued' },
  }
  for (const invalid of [
    { records: {} },
    { records: [{ ...record, revision: 0 }] },
    { records: [record, record] },
  ]) {
    data = invalid
    await assert.rejects(client.listTransactions(), {
      code: 'PUBLIC_SERVER_INVALID_RESPONSE',
    })
  }
  data = record
  await assert.rejects(client.getTransaction('another-id'), {
    code: 'PUBLIC_SERVER_INVALID_RESPONSE',
  })
  await assert.rejects(client.putTransaction(record.id, record.data, 1), {
    code: 'PUBLIC_SERVER_INVALID_RESPONSE',
  })
})

test('missing owner key only blocks owner methods and invalid IDs never reach HTTP', async t => {
  let calls = 0
  const url = await mockServer(t, (_request, response) => {
    calls++
    send(response, status)
  })
  const client = new PublicServer({ url, timeoutMs: 1000 })
  assert.deepEqual(await client.status(), status)
  for (const call of [
    () => client.refresh(),
    () => client.listTransactions(),
    () => client.getTransaction('operation:1'),
    () => client.putTransaction('operation:1', {}, null),
  ]) {
    await assert.rejects(call(), { code: 'PUBLIC_SERVER_KEY_REQUIRED' })
  }
  const authenticated = new PublicServer({ url, key, timeoutMs: 1000 })
  await assert.rejects(authenticated.getTransaction('../status'), {
    code: 'PUBLIC_SERVER_REQUEST_REJECTED',
  })
  await assert.rejects(authenticated.putTransaction('operation:1', {}, 0), {
    code: 'PUBLIC_SERVER_REQUEST_REJECTED',
  })
  assert.equal(calls, 1)
})

test('timeouts cover response bodies and redirects do not forward the owner key', async t => {
  let forwarded = false
  const destination = await mockServer(t, (_request, response) => {
    forwarded = true
    send(response, { records: [] })
  })
  const url = await mockServer(t, (request, response) => {
    if (request.url === '/v1/status') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.write('{"running":')
    } else {
      response.writeHead(307, { Location: `${destination}/v1/transactions` })
      response.end()
    }
  })
  const client = new PublicServer({ url, key, timeoutMs: 50 })
  await assert.rejects(client.status(), { code: 'PUBLIC_SERVER_UNAVAILABLE' })
  await assert.rejects(client.listTransactions(), {
    code: 'PUBLIC_SERVER_UNAVAILABLE',
  })
  assert.equal(forwarded, false)
})

test('invalid connection configuration is rejected without exposing its contents', () => {
  for (const url of [
    'invalid',
    'ftp://localhost',
    'https://owner:secret@example.com',
    'https://example.com?key=secret',
    'https://example.com#secret',
  ]) {
    assert.throws(() => new PublicServer({ url, timeoutMs: 1000 }), {
      code: 'PUBLIC_SERVER_INVALID_CONFIGURATION',
      message: 'PUBLIC_SERVER_INVALID_CONFIGURATION',
    })
  }
  assert.doesNotThrow(
    () =>
      new PublicServer({ url: 'https://example.com/public', timeoutMs: 1000 }),
  )
  assert.doesNotThrow(
    () => new PublicServer({ url: 'http://localhost:3000', timeoutMs: 1000 }),
  )
})
