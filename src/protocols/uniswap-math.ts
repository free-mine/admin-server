import { TickMath } from './tick-math.js'
import { AppError } from '../shared/index.js'
import type { Token } from '../config/index.js'

export const Q96 = 1n << 96n
export const MIN_TICK = TickMath.MIN_TICK
export const MAX_TICK = TickMath.MAX_TICK
const MAX_LIQUIDITY = (1n << 128n) - 1n

// TickMath взят из официального SDK, денежные расчёты ниже используют только bigint.
export const sqrtRatioAtTick = (tick: number) => {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new AppError('INVALID_TICK')
  }
  return BigInt(TickMath.getSqrtRatioAtTick(tick).toString())
}

export const usableTicks = (spacing: number): [number, number] => {
  if (!Number.isInteger(spacing) || spacing <= 0 || spacing > MAX_TICK) {
    throw new AppError('INVALID_TICK_SPACING')
  }
  return [
    Math.ceil(MIN_TICK / spacing) * spacing,
    Math.floor(MAX_TICK / spacing) * spacing,
  ]
}

export const validateTicks = (
  lower: number,
  upper: number,
  spacing: number,
) => {
  const [minimum, maximum] = usableTicks(spacing)
  if (
    !Number.isInteger(lower) ||
    !Number.isInteger(upper) ||
    lower < minimum ||
    upper > maximum ||
    lower >= upper ||
    lower % spacing !== 0 ||
    upper % spacing !== 0
  ) {
    throw new AppError('INVALID_TICK')
  }
}

const sqrt = (value: bigint): bigint => {
  if (value < 0n) {
    throw new AppError('INVALID_SQUARE_ROOT')
  }
  if (value < 2n) {
    return value
  }
  let current = 1n << BigInt(Math.ceil(value.toString(2).length / 2))
  while (true) {
    const next = (current + value / current) >> 1n
    if (next >= current) {
      return current
    }
    current = next
  }
}

const decimalFraction = (text: string): [bigint, bigint] => {
  if (
    typeof text !== 'string' ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text.trim()) ||
    text.trim().length > 160
  ) {
    throw new AppError('INVALID_INITIAL_PRICE')
  }
  const [whole, fraction = ''] = text.trim().split('.')
  const numerator = BigInt(whole + fraction)
  if (numerator === 0n) {
    throw new AppError('INVALID_INITIAL_PRICE')
  }
  return [numerator, 10n ** BigInt(fraction.length)]
}

// Пользователь вводит tokenB/tokenA в человеческих единицах. При сортировке
// адресов направление цены и масштаб decimals меняются одновременно.
export const encodeInitialPrice = (
  text: string,
  tokenA: Token,
  tokenB: Token,
) => {
  let [numerator, denominator] = decimalFraction(text)
  numerator *= 10n ** BigInt(tokenB.decimals)
  denominator *= 10n ** BigInt(tokenA.decimals)
  if (BigInt(tokenA.address) > BigInt(tokenB.address)) {
    ;[numerator, denominator] = [denominator, numerator]
  }
  const ratio = sqrt((numerator << 192n) / denominator)
  if (
    ratio < BigInt(TickMath.MIN_SQRT_RATIO.toString()) ||
    ratio >= BigInt(TickMath.MAX_SQRT_RATIO.toString())
  ) {
    throw new AppError('INITIAL_PRICE_RANGE')
  }
  return ratio
}

// Десятичная цена для предпросмотра; транзакция всегда использует исходное Q64.96.
export const formatPoolPrice = (
  sqrtPriceX96: bigint,
  token0: Token,
  token1: Token,
) => {
  const numerator = sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(token0.decimals)
  const denominator = (1n << 192n) * 10n ** BigInt(token1.decimals)
  const scale = 10n ** 24n
  const scaled = (numerator * scale) / denominator
  if (scaled === 0n) {
    return '<0.000000000000000000000001'
  }
  const fraction = (scaled % scale)
    .toString()
    .padStart(24, '0')
    .replace(/0+$/, '')
  return `${scaled / scale}${fraction ? `.${fraction}` : ''}`
}

const divide = (numerator: bigint, denominator: bigint, roundUp: boolean) => {
  const quotient = numerator / denominator
  return quotient + (roundUp && numerator % denominator !== 0n ? 1n : 0n)
}

// Формулы LiquidityAmounts/SqrtPriceMath. При внесении pool округляет списание
// вверх, а при выводе — вниз. Это различие важно для маленьких сумм.
export const amountsForLiquidity = (
  price: bigint,
  lower: bigint,
  upper: bigint,
  liquidity: bigint,
  roundUp = false,
): [bigint, bigint] => {
  const from = price <= lower ? lower : price
  const to = price >= upper ? upper : price
  const amount0 =
    price >= upper
      ? 0n
      : divide(liquidity * Q96 * (upper - from), upper * from, roundUp)
  const amount1 =
    price <= lower ? 0n : divide(liquidity * (to - lower), Q96, roundUp)
  return [amount0, amount1]
}

export const liquidityForAmounts = (
  price: bigint,
  lower: bigint,
  upper: bigint,
  amount0: bigint,
  amount1: bigint,
) => {
  const for0 = (from: bigint, to: bigint) =>
    (amount0 * ((from * to) / Q96)) / (to - from)
  const for1 = (from: bigint, to: bigint) => (amount1 * Q96) / (to - from)
  let liquidity
  if (price <= lower) {
    liquidity = for0(lower, upper)
  } else if (price >= upper) {
    liquidity = for1(lower, upper)
  } else {
    const liquidity0 = for0(price, upper)
    const liquidity1 = for1(lower, price)
    liquidity = liquidity0 < liquidity1 ? liquidity0 : liquidity1
  }
  if (liquidity <= 0n) {
    throw new AppError('INSUFFICIENT_LIQUIDITY_AMOUNTS')
  }
  if (liquidity > MAX_LIQUIDITY) {
    throw new AppError('LIQUIDITY_OVERFLOW')
  }
  return liquidity
}

// Как Position.mintAmountsWithSlippage в официальном SDK: убираем излишек
// бюджетов, затем считаем минимумы на границах допустимого изменения цены.
// Расчёт не зависит от статического списка fee tiers в SDK Pool.
export const mintAmountsWithSlippage = (
  price: bigint,
  tickLower: number,
  tickUpper: number,
  amount0: bigint,
  amount1: bigint,
  slippageBps: number,
) => {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 1000) {
    throw new AppError('INVALID_SLIPPAGE')
  }
  const lower = sqrtRatioAtTick(tickLower)
  const upper = sqrtRatioAtTick(tickUpper)
  const quotedLiquidity = liquidityForAmounts(
    price,
    lower,
    upper,
    amount0,
    amount1,
  )
  const [amount0Desired, amount1Desired] = amountsForLiquidity(
    price,
    lower,
    upper,
    quotedLiquidity,
    true,
  )
  // Менеджер повторно вычислит ликвидность из урезанных desired; учитываем
  // его округление, чтобы минимумы не мешали исполнению при исходной цене.
  const liquidity = liquidityForAmounts(
    price,
    lower,
    upper,
    amount0Desired,
    amount1Desired,
  )
  const [expected0, expected1] = amountsForLiquidity(
    price,
    lower,
    upper,
    liquidity,
    true,
  )
  let priceLower = sqrt((price * price * BigInt(10000 - slippageBps)) / 10000n)
  let priceUpper = sqrt((price * price * BigInt(10000 + slippageBps)) / 10000n)
  const minimumPrice = BigInt(TickMath.MIN_SQRT_RATIO.toString())
  const maximumPrice = BigInt(TickMath.MAX_SQRT_RATIO.toString()) - 1n
  if (priceLower < minimumPrice) {
    priceLower = minimumPrice
  }
  if (priceUpper > maximumPrice) {
    priceUpper = maximumPrice
  }
  return {
    liquidity,
    amount0Desired,
    amount1Desired,
    expected0,
    expected1,
    amount0Min: amountsForLiquidity(
      priceUpper,
      lower,
      upper,
      liquidity,
      true,
    )[0],
    amount1Min: amountsForLiquidity(
      priceLower,
      lower,
      upper,
      liquidity,
      true,
    )[1],
  }
}
