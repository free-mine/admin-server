import test from 'node:test'
import assert from 'node:assert/strict'

import { Interface } from 'ethers'

import type { Chain } from '../src/chain/index.js'
import { readConfig } from '../src/config/index.js'
import { oreVeinAbi } from '../src/contracts/index.js'
import { Successors } from '../src/successors/index.js'

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
  const config = readConfig({
    RPC_URL: 'http://localhost:18545',
    PRIVATE_KEY: '1'.repeat(64),
    DEPLOYMENT_BLOCK: '1',
    LOG_BLOCK_RANGE: '8',
  })
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
