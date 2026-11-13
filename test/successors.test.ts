import test from 'node:test'
import assert from 'node:assert/strict'

import { Interface } from 'ethers'

import type { Chain } from '../src/chain/index.js'
import { readConfig } from '../src/config/index.js'
import { oreVeinAbi } from '../src/contracts/index.js'
import { Successors } from '../src/successors/index.js'

const config = readConfig({
  RPC_URL: 'http://localhost:18545',
  PUBLIC_SERVER_URL: 'http://localhost:18546',
  PRIVATE_KEY: '1'.repeat(64),
  DEPLOYMENT_BLOCK: '1',
  LOG_BLOCK_RANGE: '8',
})

test('default configuration scans history and new blocks in ranges of at most ten', async () => {
  const defaultConfig = readConfig({
    RPC_URL: 'http://localhost:18545',
    PUBLIC_SERVER_URL: 'http://localhost:18546',
    DEPLOYMENT_BLOCK: '1',
  })
  let head = 25
  const requests: [number, number][] = []
  const source = {
    provider: {
      getBlock: async (tag: number | 'latest') => {
        const number = tag === 'latest' ? head : tag
        return { number, timestamp: 1000, hash: `block-${number}` }
      },
      getLogs: async ({
        fromBlock,
        toBlock,
      }: {
        toBlock: number
        fromBlock: number
      }) => {
        requests.push([fromBlock, toBlock])
        if (toBlock - fromBlock + 1 > 10) {
          throw new Error('RPC range limit')
        }
        return []
      },
    },
    oreVein: { interface: new Interface(oreVeinAbi) },
  }
  const calendar = new Successors(source as unknown as Chain, defaultConfig)
  assert.equal((await calendar.read()).block, 25)
  assert.deepEqual(requests, [
    [1, 10],
    [11, 20],
    [21, 25],
  ])

  head = 37
  requests.length = 0
  assert.equal((await calendar.read()).block, 37)
  assert.deepEqual(requests, [
    [26, 35],
    [36, 37],
  ])
})

test('calendar chunks history, verifies mappings and rebuilds after a reorganization', async () => {
  const abi = new Interface(oreVeinAbi)
  const first = '0x0000000000000000000000000000000000000001'
  const second = '0x0000000000000000000000000000000000000002'
  let hash = 'original'
  let scheduled = first
  let timestamp = 2000n
  let requests = 0
  const source = {
    provider: {
      getBlock: async () => ({ number: 8, timestamp: 1000, hash }),
      getLogs: async ({
        fromBlock,
        toBlock,
      }: {
        toBlock: number
        fromBlock: number
      }) => {
        requests++
        if (toBlock - fromBlock >= 2) {
          throw new Error('RPC range limit')
        }
        return fromBlock <= 2 && toBlock >= 2
          ? [
              abi.encodeEventLog('SuccessorScheduled', [
                scheduled,
                0n,
                timestamp,
                first,
              ]),
            ]
          : []
      },
    },
    oreVein: {
      interface: abi,
      successors: async (address: string, options: { blockTag: number }) => {
        assert.equal(options.blockTag, 8)
        return address === scheduled ? timestamp : 0n
      },
    },
  }
  const calendar = new Successors(source as unknown as Chain, config)
  assert.deepEqual((await calendar.read()).successors, [
    { address: first, timestamp: 2000, eligible: false },
  ])
  assert.ok(requests > 4)
  const previousRequests = requests
  timestamp = 0n
  assert.deepEqual((await calendar.read()).successors, [])
  assert.equal(requests, previousRequests)
  hash = 'reorganized'
  scheduled = second
  timestamp = 900n
  assert.deepEqual((await calendar.read()).successors, [
    { address: second, timestamp: 900, eligible: true },
  ])
  assert.ok(requests > previousRequests)
  source.provider.getLogs = async () => {
    throw new Error('RPC unavailable')
  }
  hash = 'reorganized-again'
  await assert.rejects(calendar.read(), /RPC unavailable/)
})

test('malformed events fail immediately without retrying smaller block ranges', async () => {
  const abi = new Interface(oreVeinAbi)
  const event = abi.getEvent('SuccessorScheduled')
  assert.ok(event)
  let requests = 0
  const source = {
    provider: {
      getBlock: async () => ({ number: 8, timestamp: 1000, hash: 'head' }),
      getLogs: async () => {
        requests++
        return [{ topics: [event.topicHash], data: '0x' }]
      },
    },
    oreVein: { interface: abi },
  }
  const calendar = new Successors(source as unknown as Chain, config)
  await assert.rejects(calendar.read())
  assert.equal(requests, 1)
})

test('a failed incremental scan preserves its last complete checkpoint', async () => {
  const abi = new Interface(oreVeinAbi)
  const first = '0x0000000000000000000000000000000000000001'
  const abandoned = '0x0000000000000000000000000000000000000002'
  const replacement = '0x0000000000000000000000000000000000000003'
  let phase = 'initial'
  const requests: number[] = []
  const source = {
    provider: {
      getBlock: async (tag: number | 'latest') => {
        const number = tag === 'latest' ? (phase === 'initial' ? 4 : 8) : tag
        return {
          number,
          timestamp: 1000,
          hash: number === 4 ? 'checkpoint' : phase,
        }
      },
      getLogs: async ({
        fromBlock,
        toBlock,
      }: {
        toBlock: number
        fromBlock: number
      }) => {
        requests.push(fromBlock)
        if (phase === 'failing' && fromBlock >= 7) {
          throw new Error('RPC unavailable')
        }
        const block = phase === 'initial' ? 2 : 5
        const address =
          phase === 'initial'
            ? first
            : phase === 'failing'
              ? abandoned
              : replacement
        return fromBlock <= block && block <= toBlock
          ? [
              abi.encodeEventLog('SuccessorScheduled', [
                address,
                0n,
                900n,
                first,
              ]),
            ]
          : []
      },
    },
    oreVein: {
      interface: abi,
      successors: async () => 900n,
    },
  }
  const calendar = new Successors(source as unknown as Chain, {
    ...config,
    logBlockRange: 2,
  })
  assert.deepEqual(
    (await calendar.read()).successors.map(value => value.address),
    [first],
  )

  phase = 'failing'
  requests.length = 0
  await assert.rejects(calendar.read(), /RPC unavailable/)
  assert.deepEqual(requests, [5, 7, 7])

  phase = 'recovered'
  requests.length = 0
  const recovered = await calendar.read()
  assert.deepEqual(requests, [5, 7])
  assert.deepEqual(
    recovered.successors.map(value => value.address),
    [first, replacement],
  )
})
