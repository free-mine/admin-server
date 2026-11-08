import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { tokens } from '../src/config/index.js'
import { amount } from '../src/shared/index.js'
import { previewRequestSchema } from '../src/requests/index.js'
import {
  TickMath,
  usableTicks,
  encodeInitialPrice,
  mintAmountsWithSlippage,
} from '../src/protocols/index.js'

const sdk = createRequire(import.meta.url)(
  '@uniswap/v3-sdk',
) as typeof import('@uniswap/v3-sdk')

test('native TickMath agrees with the official SDK including boundary ticks', () => {
  const ticks = [-887272, -887271, -1, 0, 1, 887271, 887272]
  for (let tick = -887272; tick <= 887272; tick += 257) {
    ticks.push(tick)
  }
  for (const tick of ticks) {
    assert.equal(
      TickMath.getSqrtRatioAtTick(tick).toString(),
      sdk.TickMath.getSqrtRatioAtTick(tick).toString(),
    )
  }
})
test('liquidity spending never exceeds budgets for either token order or price scale', () => {
  const [wavax, , usdc] = tokens
  const price = encodeInitialPrice('25', wavax, usdc)
  const reversed = encodeInitialPrice('0.04', usdc, wavax)
  assert.equal(price, reversed)
  const [lower, upper] = usableTicks(10)
  for (let i = 1; i <= 30; i++) {
    const first = BigInt(i) * 10n ** 18n
    const second = BigInt(i) * 25n * 10n ** 6n
    const output = mintAmountsWithSlippage(
      price,
      lower,
      upper,
      first,
      second,
      40,
    )
    assert.ok(output.amount0Desired <= first && output.amount1Desired <= second)
    assert.ok(
      output.amount0Min <= output.expected0 &&
        output.amount1Min <= output.expected1,
    )
  }
})
test('amount parsing preserves uint256 precision and refuses invalid formats', () => {
  assert.equal(
    amount('12345678901234567890.123456789012345678', 18),
    12345678901234567890123456789012345678n,
  )
  for (const input of ['-1', '1e5', '1,5', '0', 'NaN']) {
    assert.throws(() => amount(input, 6))
  }
  assert.throws(() => amount('1.0000001', 6), /AMOUNT_PRECISION/)
  assert.throws(() => amount((1n << 256n).toString(), 0), /AMOUNT_RANGE/)
})
test('API forbids arbitrary execution, ownership changes and unknown token symbols', () => {
  for (const kind of [
    'execute',
    'transferOwnership',
    'renounceOwnership',
    'removeAdmin',
  ]) {
    assert.equal(
      previewRequestSchema.safeParse({
        action: { kind, params: {} },
        maxGasAvax: '0.1',
      }).success,
      false,
    )
  }
  assert.equal(
    previewRequestSchema.safeParse({
      action: {
        kind: 'aave.supply',
        params: { token: 'MagicOre', amount: '1' },
      },
      maxGasAvax: '0.1',
    }).success,
    false,
  )
})
