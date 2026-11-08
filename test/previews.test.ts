import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { tokens } from '../src/config/index.js'
import { until, engine, FakeChain } from './helpers.js'
import type { Call, Chain } from '../src/chain/index.js'
import type { PreviewRequest } from '../src/requests/index.js'
import { Previews, previewView } from '../src/operations/index.js'

function previewChain(allowance: bigint) {
  const simulated: string[] = []
  const chain = Object.assign(new FakeChain(), {
    allowanceValue: allowance,
    provider: {
      getBlock: async () => ({ timestamp: Math.floor(Date.now() / 1000) }),
    },
    token: async (symbol: string) => {
      const token = tokens.find(value => value.symbol === symbol)
      assert.ok(token)
      return token
    },
    contract: () => ({
      getReserveData: async () => ({
        aTokenAddress: '0x0000000000000000000000000000000000000001',
      }),
    }),
    assertBalance: async () => {},
    execute: (
      _target: string,
      _abi: unknown,
      method: string,
      args: unknown[],
    ) => ({
      to: 'oreVein',
      value: '0',
      data:
        method === 'approve' ? (args[1] === 0n ? 'reset' : 'approve') : 'main',
    }),
    simulate: async (call: Call) => {
      simulated.push(call.data)
      return '0x'
    },
    estimate: async () => ({ maxCost: 10n }),
  })
  return {
    chain,
    simulated,
    previews: new Previews(chain as unknown as Chain, 60),
  }
}

const request: PreviewRequest = {
  action: { kind: 'aave.supply', params: { token: 'USDC', amount: '0.0001' } },
  maxGasAvax: '0.01',
}

for (const allowance of [0n, 1n, 100n, 500n]) {
  test(`preview estimates and execution agree for allowance ${allowance}`, async t => {
    const { chain, previews, simulated } = previewChain(allowance)
    const { operations, journal } = engine(t, chain)
    const preview = await previews.create(request)
    const view = previewView(preview)
    const sufficient = allowance >= 100n
    assert.deepEqual(
      view.steps.map(step => step.gasEstimate.status),
      sufficient
        ? ['skipped', 'skipped', 'estimated']
        : allowance === 0n
          ? ['skipped', 'estimated', 'requires_prior_steps']
          : ['estimated', 'requires_prior_steps', 'requires_prior_steps'],
    )
    assert.deepEqual(simulated, [
      sufficient ? 'main' : allowance === 0n ? 'approve' : 'reset',
    ])
    assert.equal(view.knownGasEstimateAvax, '0.00000000000000001')
    assert.equal(view.gasEstimateComplete, sufficient)
    for (const step of view.steps) {
      assert.equal(step.code, step.gasEstimate.code)
    }
    const operation = operations.submit(preview, randomUUID())
    await until(() => operations.get(operation.id).status === 'succeeded')
    assert.deepEqual(
      operations.get(operation.id).steps.map(step => step.status),
      sufficient
        ? ['skipped', 'skipped', 'confirmed']
        : allowance === 0n
          ? ['skipped', 'confirmed', 'confirmed']
          : ['confirmed', 'confirmed', 'confirmed'],
    )
    assert.ok(
      journal.get(operation.id)?.steps.every(step => !('gasEstimate' in step)),
    )
  })
}

test('execution checks allowances again after preview creation', async t => {
  const { chain, previews } = previewChain(100n)
  const { operations } = engine(t, chain)
  const preview = await previews.create(request)
  chain.allowanceValue = 1n
  const operation = operations.submit(preview, randomUUID())
  await until(() => operations.get(operation.id).status === 'succeeded')
  assert.deepEqual(
    chain.broadcasts.map(raw => chain.signedCalls.get(raw)?.data),
    ['reset', 'approve', 'main'],
  )
})

test('preview inputs, returned plans and public views cannot mutate cached plans', async () => {
  const { previews } = previewChain(1n)
  const input = structuredClone(request)
  const preview = await previews.create(input)
  const expected = structuredClone(preview)
  input.action = { kind: 'fund.closeShift', params: {} }
  preview.plan.steps.reverse()
  assert.deepEqual(previews.get(preview.id), expected)

  const cached = previews.get(preview.id)
  cached.plan.summary.amount = '999'
  assert.deepEqual(previews.get(preview.id), expected)

  const view = previewView(cached)
  view.request.maxGasAvax = '100'
  view.summary.amount = '888'
  const approval = view.steps[1].approval
  assert.ok(approval)
  approval.amount = '999'
  assert.equal(cached.request.maxGasAvax, '0.01')
  assert.equal(cached.plan.summary.amount, '999')
  assert.equal(cached.plan.steps[1].approval?.amount, '100')
})
