import { getAddress } from 'ethers'

import { ensure } from '../shared/index.js'
import type { Config } from '../config/index.js'
import type { Action } from '../requests/index.js'
import type { SuccessorSnapshot } from './types.js'
import type { Plan, Chain } from '../chain/index.js'
import { addresses, DEPLOYMENT_TX } from '../config/index.js'

export class Successors {
  private candidates = new Set<string>()
  private cursor?: { hash: string; number: number }
  private start?: number
  private pending?: Promise<SuccessorSnapshot>
  constructor(
    private chain: Chain,
    private config: Config,
  ) {}

  read(): Promise<SuccessorSnapshot> {
    // Одновременные HTTP-запросы используют один проход по истории.
    if (!this.pending) {
      this.pending = this.scan().finally(() => {
        this.pending = undefined
      })
    }
    return this.pending
  }
  private async scan(): Promise<SuccessorSnapshot> {
    const { provider, oreVein } = this.chain
    const head = await provider.getBlock('latest')
    ensure(head?.hash, 'BLOCK_UNAVAILABLE')
    if (this.start === undefined) {
      if (this.config.deploymentBlock !== undefined) {
        this.start = this.config.deploymentBlock
      } else {
        const deployment = await provider.getTransactionReceipt(DEPLOYMENT_TX)
        ensure(deployment, 'DEPLOYMENT_BLOCK_UNAVAILABLE')
        this.start = deployment.blockNumber
      }
    }
    ensure(this.start <= head.number, 'INVALID_DEPLOYMENT_BLOCK')
    if (this.cursor) {
      const previous = await provider.getBlock(this.cursor.number)
      if (previous?.hash !== this.cursor.hash) {
        this.cursor = undefined
        this.candidates.clear()
      }
    }
    const candidates = new Set(this.candidates)
    const scheduledEvent = oreVein.interface.getEvent('SuccessorScheduled')
    ensure(scheduledEvent, 'INTERNAL_ERROR')
    const topic = scheduledEvent.topicHash
    let from = this.cursor ? this.cursor.number + 1 : this.start
    let span = this.config.logBlockRange
    while (from <= head.number) {
      const to = Math.min(head.number, from + span - 1)
      try {
        const logs = await provider.getLogs({
          address: addresses.oreVein,
          topics: [topic],
          fromBlock: from,
          toBlock: to,
        })
        for (const log of logs) {
          const event = oreVein.interface.parseLog(log)
          if (event) {
            candidates.add(getAddress(event.args.successor))
          }
        }
        from = to + 1
      } catch (error) {
        if (span === 1) {
          throw error
        }
        span = Math.max(1, Math.floor(span / 2))
      }
    }
    const successors: SuccessorSnapshot['successors'] = []
    for (const address of candidates) {
      const timestamp = Number(
        await oreVein.successors(address, { blockTag: head.number }),
      )
      ensure(Number.isSafeInteger(timestamp), 'SUCCESSOR_TIMESTAMP_RANGE')
      if (timestamp !== 0) {
        successors.push({
          address,
          timestamp,
          eligible: timestamp <= head.timestamp,
        })
      }
    }
    const check = await provider.getBlock(head.number)
    ensure(check?.hash === head.hash, 'CHAIN_REORGANIZED')
    this.candidates = candidates
    this.cursor = { number: head.number, hash: head.hash }
    successors.sort(
      (a, b) => a.timestamp - b.timestamp || a.address.localeCompare(b.address),
    )
    return { block: head.number, blockTimestamp: head.timestamp, successors }
  }
}

export async function prepareSuccessor(
  chain: Chain,
  action: Action,
): Promise<Plan> {
  ensure(
    action.kind === 'successor.schedule' || action.kind === 'successor.remove',
    'UNSUPPORTED_ACTION',
  )
  const address = action.params.address
  const current = BigInt(await chain.oreVein.successors(address))
  const guards: Plan['guards'] = [
    {
      contract: 'oreVein',
      method: 'successors',
      args: [address],
      expected: current.toString(),
    },
  ]
  if (action.kind === 'successor.remove') {
    ensure(current > 0n, 'SUCCESSOR_NOT_FOUND')
    return {
      guards,
      summary: { address, previousTimestamp: current.toString() },
      steps: [
        { code: 'EXECUTE', call: chain.direct('removeSuccessor', [address]) },
      ],
    }
  }
  const block = await chain.provider.getBlock('latest')
  ensure(block, 'BLOCK_UNAVAILABLE')
  ensure(
    action.params.timestamp >
      Math.max(block.timestamp, Math.floor(Date.now() / 1000)),
    'TIMESTAMP_NOT_FUTURE',
  )
  ensure(BigInt(action.params.timestamp) > current, 'TIMESTAMP_NOT_LATER')
  return {
    guards,
    summary: {
      address,
      previousTimestamp: current.toString(),
      timestamp: action.params.timestamp,
    },
    steps: [
      {
        code: 'EXECUTE',
        call: chain.direct('scheduleSuccessor', [
          address,
          action.params.timestamp,
        ]),
      },
    ],
  }
}
