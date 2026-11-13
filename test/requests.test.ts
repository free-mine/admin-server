import test from 'node:test'
import assert from 'node:assert/strict'

import { MaxUint256 } from 'ethers'

import { idSchema } from '../src/requests/index.js'

test('IDs reject malformed text before numeric conversion and preserve uint256 bounds', () => {
  for (const value of ['', 'abc', '1.2', '1e2', '-1', '0', '01', ' 1', '0x1']) {
    assert.equal(idSchema.safeParse(value).success, false, value)
  }
  assert.equal(idSchema.parse('1'), '1')
  assert.equal(idSchema.parse(MaxUint256.toString()), MaxUint256.toString())
  assert.equal(idSchema.safeParse((MaxUint256 + 1n).toString()).success, false)
  assert.equal(idSchema.safeParse('1'.repeat(79)).success, false)
})
