import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { tokens } from '../src/config/index.js'
import { amount } from '../src/shared/index.js'
import { previewRequestSchema } from '../src/requests/index.js'
import {
  TickMath,
  selectRange,
  usableTicks,
  describeRange,
  encodeInitialPrice,
  mintAmountsWithSlippage,
} from '../src/liquidity/index.js'

const sdk = createRequire(import.meta.url)(
  '@uniswap/v3-sdk',
) as typeof import('@uniswap/v3-sdk')
const core = createRequire(import.meta.url)(
  '@uniswap/sdk-core',
) as typeof import('@uniswap/sdk-core')

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

test('range selection respects human percentages, consumes both budgets and agrees with SDK', () => {
  const [wavax, , usdc] = tokens
  const price = encodeInitialPrice('25', wavax, usdc)
  for (const inverse of [false, true]) {
    for (const [fee, spacing] of [
      [100, 1],
      [500, 10],
      [3000, 60],
      [10000, 200],
    ]) {
      for (const ratio of [1n, 3n, 10n]) {
        const amount0 = 10n ** 18n
        const amount1 = 25n * 10n ** 6n * ratio
        const selected = selectRange({
          price,
          amount0,
          amount1,
          spacing,
          baseIsToken0: !inverse,
          minBoundaryPercent: '5',
          slippageBps: 100,
        })
        assert.ok(selected.tickLower % spacing === 0)
        assert.ok(selected.tickUpper % spacing === 0)
        const lower =
          BigInt(TickMath.getSqrtRatioAtTick(selected.tickLower)) ** 2n
        const upper =
          BigInt(TickMath.getSqrtRatioAtTick(selected.tickUpper)) ** 2n
        const square = price * price
        assert.ok(
          inverse
            ? lower * 105n <= square * 100n
            : lower * 100n <= square * 95n,
        )
        assert.ok(
          inverse
            ? upper * 95n >= square * 100n
            : upper * 100n >= square * 105n,
        )
        assert.ok(selected.expected0 * 100n >= amount0 * 99n)
        assert.ok(selected.expected1 * 100n >= amount1 * 99n)
        assert.ok(selected.amount0Desired <= amount0)
        assert.ok(selected.amount1Desired <= amount1)
        const view = describeRange(
          price,
          selected.tickLower,
          selected.tickUpper,
          inverse ? usdc : wavax,
          inverse ? wavax : usdc,
        )
        assert.ok(view.inRange)
        assert.ok(Number(view.range.lowerDistancePercent) >= 5)
        assert.ok(Number(view.range.upperDistancePercent) >= 5)
        assert.ok(
          Math.abs(Number(view.currentPrice) - (inverse ? 0.04 : 25)) < 1e-12,
        )

        const token0 = new core.Token(43114, wavax.address, wavax.decimals)
        const token1 = new core.Token(43114, usdc.address, usdc.decimals)
        const pool = new sdk.Pool(
          token0,
          token1,
          fee,
          price.toString(),
          '0',
          sdk.TickMath.getTickAtSqrtRatio(
            sdk.encodeSqrtRatioX96(
              (price * price).toString(),
              (1n << 192n).toString(),
            ),
          ),
        )
        const position = sdk.Position.fromAmounts({
          pool,
          tickLower: selected.tickLower,
          tickUpper: selected.tickUpper,
          amount0: selected.amount0Desired.toString(),
          amount1: selected.amount1Desired.toString(),
          useFullPrecision: false,
        })
        assert.equal(
          position.mintAmounts.amount0.toString(),
          selected.expected0.toString(),
        )
        assert.equal(
          position.mintAmounts.amount1.toString(),
          selected.expected1.toString(),
        )
        assert.equal(
          position.liquidity.toString(),
          selected.liquidity.toString(),
        )
      }
    }
  }
})

test('range selection widens coarse boundaries and rejects incompatible budget ratios', () => {
  const price = 1n << 96n
  const selected = selectRange({
    price,
    amount0: 10n ** 18n,
    amount1: 7n * 10n ** 17n,
    spacing: 200,
    baseIsToken0: true,
    minBoundaryPercent: '0.000001',
    slippageBps: 100,
  })
  assert.ok(selected.expected0 >= 99n * 10n ** 16n)
  assert.ok(selected.expected1 * 100n >= 7n * 10n ** 17n * 99n)
  for (const amounts of [
    [1n, 1000000n],
    [1000000n, 1n],
  ]) {
    assert.throws(
      () =>
        selectRange({
          price,
          amount0: amounts[0],
          amount1: amounts[1],
          spacing: 10,
          baseIsToken0: true,
          minBoundaryPercent: '10',
          slippageBps: 100,
        }),
      /RANGE_AMOUNTS_INCOMPATIBLE/,
    )
  }
  assert.throws(
    () =>
      selectRange({
        price,
        amount0: 1n,
        amount1: 0n,
        spacing: 10,
        baseIsToken0: true,
        minBoundaryPercent: '10',
        slippageBps: 100,
      }),
    /RANGE_REQUIRES_BOTH_ASSETS/,
  )
})

test('mint API takes a human percentage and rejects old tick input', () => {
  const params = {
    tokenA: 'WAVAX',
    tokenB: 'USDC',
    amountA: '1',
    amountB: '25',
    fee: 500,
    minBoundaryPercent: '10',
    slippageBps: 100,
  }
  const parse = (input: unknown) =>
    previewRequestSchema.safeParse({
      action: { kind: 'uniswap.mint', params: input },
      maxGasAvax: '0.1',
    }).success
  assert.equal(parse(params), true)
  for (const percent of ['0', '100', '-1', '1e1', '0.0000001']) {
    assert.equal(parse({ ...params, minBoundaryPercent: percent }), false)
  }
  assert.equal(parse({ ...params, tickLower: -100, tickUpper: 100 }), false)
  assert.equal(parse({ ...params, range: 'full' }), false)
})
