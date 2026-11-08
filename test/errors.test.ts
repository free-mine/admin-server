import test from 'node:test'
import assert from 'node:assert/strict'

import { Interface } from 'ethers'

import { publicError } from '../src/shared/index.js'
import { oreVeinAbi, aaveErrorsAbi } from '../src/contracts/index.js'

test('Aave custom errors remain identifiable through OreVein CallFailed', () => {
  const inner = new Interface(aaveErrorsAbi).encodeErrorResult(
    'SupplyCapExceeded',
    [],
  )
  const data = new Interface(oreVeinAbi).encodeErrorResult('CallFailed', [
    inner,
  ])
  assert.deepEqual(publicError({ code: 'CALL_EXCEPTION', data }), {
    code: 'CONTRACT_REVERT',
    reason: 'SupplyCapExceeded',
  })
})
