import type { RangeRequest } from './types.js'
import type { Token } from '../config/index.js'
import { ensure, AppError } from '../shared/index.js'
import {
  Q96,
  sqrt,
  usableTicks,
  formatRatio,
  sqrtRatioAtTick,
  mintAmountsWithSlippage,
} from './math.js'

// First true element of a monotone predicate; high + 1 means none.
function firstTrue(
  low: number,
  high: number,
  predicate: (index: number) => boolean,
) {
  let end = high + 1
  while (low < end) {
    const middle = Math.floor((low + end) / 2)
    if (predicate(middle)) {
      end = middle
    } else {
      low = middle + 1
    }
  }
  return low
}

function percentage(value: string) {
  ensure(
    /^(?:0|[1-9]\d?)(?:\.\d{1,6})?$/.test(value),
    'INVALID_BOUNDARY_PERCENT',
  )
  const [whole, fraction = ''] = value.split('.')
  const percent = BigInt(whole + fraction)
  const scale = 100n * 10n ** BigInt(fraction.length)
  ensure(percent > 0n && percent < scale, 'INVALID_BOUNDARY_PERCENT')
  return { percent, scale }
}

export function boundaryPriceBounds(
  tickLower: number,
  tickUpper: number,
  minBoundaryPercent: string,
  baseIsToken0: boolean,
) {
  const { percent, scale } = percentage(minBoundaryPercent)
  const lower = sqrtRatioAtTick(tickLower) ** 2n
  const upper = sqrtRatioAtTick(tickUpper) ** 2n
  const minimumNumerator = lower * (baseIsToken0 ? scale : scale + percent)
  const minimumDenominator = baseIsToken0 ? scale - percent : scale
  let minimum = sqrt(minimumNumerator / minimumDenominator)
  if (minimum * minimum * minimumDenominator < minimumNumerator) {
    minimum++
  }
  const maximum = sqrt(
    (upper * (baseIsToken0 ? scale : scale - percent)) /
      (baseIsToken0 ? scale + percent : scale),
  )
  return {
    minimumSqrtPriceX96: minimum.toString(),
    maximumSqrtPriceX96: maximum.toString(),
  }
}

export function selectRange(request: RangeRequest) {
  const { price, amount0, amount1, spacing, baseIsToken0, slippageBps } =
    request
  ensure(amount0 > 0n && amount1 > 0n, 'RANGE_REQUIRES_BOTH_ASSETS')
  const { percent, scale } = percentage(request.minBoundaryPercent)
  const [minimum, maximum] = usableTicks(spacing)
  const minIndex = minimum / spacing
  const maxIndex = maximum / spacing
  const square = price * price
  const at = (index: number) => sqrtRatioAtTick(index * spacing)

  // Boundaries are checked in the requested B/A direction using exact ratios.
  // Inverting a pair also inverts which canonical bound is constrained.
  const lowerAllowed = (index: number) => {
    const bound = at(index) ** 2n
    return baseIsToken0
      ? bound * scale <= square * (scale - percent)
      : bound * (scale + percent) <= square * scale
  }
  const upperAllowed = (index: number) => {
    const bound = at(index) ** 2n
    return baseIsToken0
      ? bound * scale >= square * (scale + percent)
      : bound * (scale - percent) >= square * scale
  }
  const nearestLower =
    firstTrue(minIndex, maxIndex, index => !lowerAllowed(index)) - 1
  const nearestUpper = firstTrue(minIndex, maxIndex, upperAllowed)
  ensure(
    nearestLower >= minIndex && nearestUpper <= maxIndex,
    'RANGE_NOT_AVAILABLE',
  )

  const compare = (lower: number, upper: number) =>
    amount1 * Q96 * Q96 * (at(upper) - price) -
    amount0 * price * at(upper) * (price - at(lower))
  const quote = (lower: number, upper: number) => ({
    tickLower: lower * spacing,
    tickUpper: upper * spacing,
    ...mintAmountsWithSlippage(
      price,
      lower * spacing,
      upper * spacing,
      amount0,
      amount1,
      slippageBps,
    ),
  })

  // Keep the nearest permitted boundary fixed, then fit the other to the
  // asset ratio. Check both adjacent ticks because the exact solution may
  // fall between usable boundaries. A coarser grid can require a wider range.
  for (let widening = 0; ; widening = widening === 0 ? 1 : widening * 2) {
    const lower = Math.max(minIndex, nearestLower - widening)
    const upper = Math.min(maxIndex, nearestUpper + widening)
    const excess1 = compare(lower, upper) >= 0n
    const crossing = excess1
      ? firstTrue(minIndex, lower, index => compare(index, upper) >= 0n)
      : firstTrue(upper, maxIndex, index => compare(lower, index) >= 0n)
    const candidates = [crossing - 1, crossing]
      .filter(index =>
        excess1
          ? index >= minIndex && index <= lower
          : index >= upper && index <= maxIndex,
      )
      .map(index =>
        excess1 ? ([index, upper] as const) : ([lower, index] as const),
      )
    let best: ReturnType<typeof quote> | undefined
    for (const [candidateLower, candidateUpper] of candidates) {
      let result
      try {
        result = quote(candidateLower, candidateUpper)
      } catch (error) {
        if (
          error instanceof AppError &&
          (error.code === 'INSUFFICIENT_LIQUIDITY_AMOUNTS' ||
            error.code === 'LIQUIDITY_OVERFLOW')
        ) {
          continue
        }
        throw error
      }
      const used =
        result.expected0 * amount1 < result.expected1 * amount0
          ? result.expected0 * amount1
          : result.expected1 * amount0
      const bestUsed =
        best === undefined
          ? -1n
          : best.expected0 * amount1 < best.expected1 * amount0
            ? best.expected0 * amount1
            : best.expected1 * amount0
      if (used > bestUsed) {
        best = result
      }
    }
    if (
      best &&
      best.expected0 * 100n >= amount0 * 99n &&
      best.expected1 * 100n >= amount1 * 99n
    ) {
      return best
    }
    if (
      (excess1 && compare(minIndex, upper) > 0n) ||
      (!excess1 && compare(lower, maxIndex) < 0n) ||
      (lower === minIndex && upper === maxIndex)
    ) {
      throw new AppError('RANGE_AMOUNTS_INCOMPATIBLE')
    }
  }
}

export function describeRange(
  price: bigint,
  tickLower: number,
  tickUpper: number,
  tokenA: Token,
  tokenB: Token,
) {
  const sorted = BigInt(tokenA.address) < BigInt(tokenB.address)
  const canonicalLower = sqrtRatioAtTick(tickLower) ** 2n
  const canonicalUpper = sqrtRatioAtTick(tickUpper) ** 2n
  const current = price * price
  const decimalScaleA = 10n ** BigInt(tokenA.decimals)
  const decimalScaleB = 10n ** BigInt(tokenB.decimals)
  const humanPrice = (square: bigint) =>
    sorted
      ? formatRatio(square * decimalScaleA, Q96 * Q96 * decimalScaleB)
      : formatRatio(Q96 * Q96 * decimalScaleA, square * decimalScaleB)
  const below = sorted ? canonicalLower : canonicalUpper
  const above = sorted ? canonicalUpper : canonicalLower
  const inRange = current > canonicalLower && current < canonicalUpper
  return {
    currentPrice: humanPrice(current),
    inRange,
    range: {
      lowerPrice: humanPrice(below),
      upperPrice: humanPrice(above),
      lowerDistancePercent: inRange
        ? sorted
          ? formatRatio((current - below) * 100n, current, 6)
          : formatRatio((below - current) * 100n, below, 6)
        : null,
      upperDistancePercent: inRange
        ? sorted
          ? formatRatio((above - current) * 100n, current, 6)
          : formatRatio((current - above) * 100n, above, 6)
        : null,
    },
  }
}
