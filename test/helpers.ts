import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join, relative } from 'node:path'
import type { TestContext } from 'node:test'
import { rmSync, mkdtempSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

import type { Action } from '../src/requests/index.js'
import type { JsonObject } from '../src/shared/index.js'
import type { Preview } from '../src/operations/index.js'
import { Journal, Operations } from '../src/operations/index.js'
import type {
  Call,
  Plan,
  Guard,
  Receipt,
  Approval,
  SignedTransaction,
  TransactionTransport,
} from '../src/chain/index.js'

export class FakeChain implements TransactionTransport {
  owner = '0x0000000000000000000000000000000000000001'
  signs: SignedTransaction[] = []
  broadcasts: string[] = []
  mined = new Map<string, Receipt>()
  signedCalls = new Map<string, Call>()
  allowanceValue = 0n
  shouldMine = true
  loseResponse = false
  currentNonce = 0
  onBroadcast?: () => void
  onSign?: () => void
  async assertOwner() {}
  async validate(_guards: Guard[]) {}
  async allowance(_approval: Approval) {
    return this.allowanceValue
  }
  async sign(call: Call, _budget: bigint, _approval?: Approval) {
    this.onSign?.()
    const signed = {
      raw: `signed-secret-${this.signs.length}`,
      hash: `hash-${this.signs.length}`,
      nonce: this.signs.length,
      maxFee: '10',
    }
    this.signs.push(signed)
    this.signedCalls.set(signed.raw, call)
    return signed
  }
  async broadcast(raw: string) {
    this.onBroadcast?.()
    this.broadcasts.push(raw)
    if (this.shouldMine) {
      const signed = this.signs.find(value => value.raw === raw)
      assert.ok(signed)
      if (this.signedCalls.get(raw)?.data === 'approve') {
        this.allowanceValue = 100n
      }
      if (this.signedCalls.get(raw)?.data === 'reset') {
        this.allowanceValue = 0n
      }
      this.mined.set(signed.hash, {
        hash: signed.hash,
        blockNumber: 1,
        status: 1,
        fee: '5',
        logs: [],
      })
      this.currentNonce = signed.nonce + 1
    }
    if (this.loseResponse) {
      throw new Error('RPC response lost')
    }
  }
  async receipt(hash: string) {
    return this.mined.get(hash) ?? null
  }
  async nonce() {
    return this.currentNonce
  }
  async readResult(
    _action: Action,
    _receipt: Receipt,
  ): Promise<JsonObject | undefined> {
    return undefined
  }
  async replacement(hash: string, _signed: SignedTransaction) {
    return {
      receipt: { hash, blockNumber: 2, status: 1, fee: '5', logs: [] },
      matches: false,
    }
  }
}
export function preview(withApproval = false): Preview {
  const call = (data: string) => ({ to: 'oreVein', data, value: '0' })
  const approval = { token: 'token', spender: 'pool', amount: '100' }
  const plan: Plan = {
    guards: [],
    summary: {},
    steps: [],
  }
  if (withApproval) {
    plan.steps.push(
      {
        code: 'ALLOWANCE_RESET',
        call: call('reset'),
        approval: { ...approval, amount: '0', resetBelow: '100' },
      },
      { code: 'ALLOWANCE_APPROVE', call: call('approve'), approval },
    )
  }
  plan.steps.push({ code: 'EXECUTE', call: call('main') })
  return {
    id: randomUUID(),
    expiresAt: Date.now() + 60000,
    request: {
      action: { kind: 'contract.setURI', params: { uri: 'ipfs://test' } },
      maxGasAvax: '0.01',
    },
    plan: {
      ...plan,
      steps: plan.steps.map(step => ({
        ...step,
        gasEstimate: { status: 'estimated', maxGasWei: '10' },
      })),
    },
  }
}
export function temporary(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'ore-vein-test-'))
  t.after(() => {
    assert.ok(!relative(tmpdir(), directory).startsWith('..'))
    assert.ok(relative(tmpdir(), directory).startsWith('ore-vein-test-'))
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}
export function engine(t: TestContext, chain = new FakeChain()) {
  const directory = temporary(t)
  const journal = new Journal(directory, chain.owner)
  const operations = new Operations(journal, chain, 5)
  t.after(() => operations.stop())
  operations.start()
  return { chain, journal, directory, operations }
}
export async function until(predicate: () => boolean, timeout = 3000) {
  const started = Date.now()
  while (!predicate()) {
    assert.ok(Date.now() - started < timeout, 'Timed out')
    await delay(5)
  }
}
