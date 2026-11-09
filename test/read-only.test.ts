import test from 'node:test'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { TestContext } from 'node:test'

import Fastify from 'fastify'
import { WebSocket } from 'ws'
import { Wallet, Interface, Transaction } from 'ethers'

import { temporary } from './helpers.js'
import { Chain } from '../src/chain/index.js'
import { createServer } from '../src/http/index.js'
import { Successors } from '../src/successors/index.js'
import { Journal, Previews, Operations } from '../src/operations/index.js'
import { erc20Abi, oreVeinAbi, freeMineAbi } from '../src/contracts/index.js'
import { tokens, CHAIN_ID, addresses, readConfig } from '../src/config/index.js'

const ownerKey = '1'.repeat(64)
const owner = new Wallet(ownerKey).address
const ore = new Interface(oreVeinAbi)
const fund = new Interface(freeMineAbi)
const erc20 = new Interface(erc20Abi)

async function rpc(t: TestContext) {
  const calls: { method: string; params: unknown[] }[] = []
  const state = { chainId: CHAIN_ID, owner, available: true }
  const server = Fastify()
  server.post('/', async request => {
    const { id, method, params } = request.body as {
      id: number
      method: string
      params: unknown[]
    }
    calls.push({ method, params })
    if (!state.available) {
      return { id, jsonrpc: '2.0', error: { code: -32000, message: 'offline' } }
    }
    let result: unknown
    switch (method) {
      case 'eth_chainId':
        result = `0x${state.chainId.toString(16)}`
        break
      case 'eth_blockNumber':
        result = '0x1'
        break
      case 'eth_getTransactionCount':
        result = '0x0'
        break
      case 'eth_getBalance':
        result = '0xde0b6b3a7640000'
        break
      case 'eth_gasPrice':
      case 'eth_maxPriorityFeePerGas':
        result = '0x3b9aca00'
        break
      case 'eth_estimateGas':
        result = '0x5208'
        break
      case 'eth_getBlockByNumber':
        result = {
          number: '0x1',
          hash: `0x${'1'.repeat(64)}`,
          parentHash: `0x${'0'.repeat(64)}`,
          timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
          nonce: '0x0000000000000000',
          difficulty: '0x0',
          gasLimit: '0x1c9c380',
          gasUsed: '0x0',
          miner: owner,
          extraData: '0x',
          baseFeePerGas: '0x3b9aca00',
          transactions: [],
        }
        break
      case 'eth_call': {
        const [call] = params as [{ to: string; data: string }]
        if (call.to.toLowerCase() === addresses.oreVein.toLowerCase()) {
          const transaction = ore.parseTransaction(call)
          assert.ok(transaction)
          const values =
            transaction.name === 'owner'
              ? [state.owner]
              : transaction.name === 'freeMine'
                ? [addresses.freeMine]
                : []
          result = ore.encodeFunctionResult(transaction.name, values)
        } else if (call.to.toLowerCase() === addresses.freeMine.toLowerCase()) {
          result = fund.encodeFunctionResult('owner', [addresses.oreVein])
        } else {
          const token = tokens.find(
            value => value.address.toLowerCase() === call.to.toLowerCase(),
          )
          assert.ok(token)
          const transaction = erc20.parseTransaction(call)
          assert.ok(transaction)
          result = erc20.encodeFunctionResult(transaction.name, [
            transaction.name === 'decimals' ? token.decimals : 100,
          ])
        }
        break
      }
      case 'eth_sendRawTransaction':
        result = Transaction.from(String(params[0])).hash
        break
      default:
        assert.fail(`Unexpected RPC method: ${method}`)
    }
    return { id, jsonrpc: '2.0', result }
  })
  const url = await server.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => server.close())
  return { url, calls, state }
}

for (const [label, key] of [
  ['missing key', undefined],
  ['empty key', ''],
  ['another wallet', '2'.repeat(64)],
  ['invalid key', 'invalid'],
  ['zero key', '0'.repeat(64)],
] as const) {
  test(`read only with ${label}: reads and previews work without transactions`, async t => {
    const { url, calls, state } = await rpc(t)
    const config = readConfig({ RPC_URL: url, PRIVATE_KEY: key })
    const chain = await Chain.connect(config)
    t.after(() => chain.dispose())
    assert.equal(chain.owner, owner)
    assert.equal(chain.readOnly, true)
    const operations = new Operations(
      new Journal(temporary(t), chain.owner, chain.readOnly),
      chain,
      5,
    )
    operations.start()
    t.after(() => operations.stop())
    const app = createServer({
      config,
      chain,
      operations,
      previews: new Previews(chain, config.previewTtlSeconds),
      successors: new Successors(chain, config),
    })
    t.after(() => app.close())
    const publicConfig = (await app.inject('/v1/config')).json()
    assert.equal(publicConfig.owner, owner)
    assert.equal(publicConfig.readOnly, true)
    assert.ok(!('privateKey' in publicConfig))
    assert.ok(!('rpcUrl' in publicConfig))
    const ready = await app.inject('/ready')
    assert.equal(ready.statusCode, 200)
    assert.deepEqual(ready.json(), { status: 'ready', readOnly: true })
    const balances = await app.inject('/v1/balances')
    assert.equal(balances.statusCode, 200)
    assert.equal(balances.json().owner, owner)
    assert.equal(balances.json().ownerAvax, '1.0')
    const preview = await app.inject({
      method: 'POST',
      url: '/v1/previews',
      payload: {
        action: { kind: 'contract.setURI', params: { uri: 'ipfs://preview' } },
        maxGasAvax: '0.01',
      },
    })
    assert.equal(preview.statusCode, 201, preview.body)
    assert.equal(preview.json().gasEstimateComplete, true)
    const estimates = calls.filter(call => call.method === 'eth_estimateGas')
    assert.ok(estimates.length > 0)
    for (const call of estimates) {
      assert.equal(
        (call.params[0] as { from: string }).from.toLowerCase(),
        owner.toLowerCase(),
      )
    }
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/operations',
      payload: { previewId: preview.json().id, requestId: randomUUID() },
    })
    assert.equal(submitted.statusCode, 403)
    assert.equal(submitted.json().error.code, 'READ_ONLY')
    const resolved = await app.inject({
      method: 'POST',
      url: `/v1/operations/${randomUUID()}/resolve`,
      payload: { transactionHash: `0x${'1'.repeat(64)}` },
    })
    assert.equal(resolved.statusCode, 403)
    assert.equal(resolved.json().error.code, 'READ_ONLY')
    assert.equal((await app.inject('/v1/operations')).json().total, 0)
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
    const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/v1/ws`, {
      origin: 'http://localhost:8080',
    })
    t.after(() => socket.terminate())
    const [snapshot] = await once(socket, 'message')
    assert.deepEqual(JSON.parse(String(snapshot)), {
      type: 'operations.snapshot',
      operations: [],
    })
    await assert.rejects(
      chain.sign(chain.direct('setContractURI', ['ipfs://test']), 10n ** 18n),
      { code: 'READ_ONLY', status: 403 },
    )
    await assert.rejects(chain.broadcast('0x'), {
      code: 'READ_ONLY',
      status: 403,
    })
    assert.ok(!calls.some(call => call.method === 'eth_sendRawTransaction'))
    state.available = false
    assert.equal((await app.inject('/ready')).statusCode, 503)
  })
}

test('the owner key enables signing and sending; ownership is rechecked before sending', async t => {
  const { url, calls, state } = await rpc(t)
  const chain = await Chain.connect(
    readConfig({ RPC_URL: url, PRIVATE_KEY: ownerKey }),
  )
  t.after(() => chain.dispose())
  assert.equal(chain.readOnly, false)
  const signed = await chain.sign(
    chain.direct('setContractURI', ['ipfs://test']),
    10n ** 18n,
  )
  assert.equal(Transaction.from(signed.raw).from, owner)
  await chain.broadcast(signed.raw)
  assert.equal(
    calls.filter(call => call.method === 'eth_sendRawTransaction').length,
    1,
  )
  state.owner = new Wallet('2'.repeat(64)).address
  await assert.rejects(chain.broadcast(signed.raw), { code: 'OWNER_MISMATCH' })
  assert.equal(
    calls.filter(call => call.method === 'eth_sendRawTransaction').length,
    1,
  )
})

test('read only still rejects a wrong RPC network', async t => {
  const { url, state } = await rpc(t)
  state.chainId = 1
  await assert.rejects(Chain.connect(readConfig({ RPC_URL: url })), {
    code: 'WRONG_NETWORK',
  })
})
