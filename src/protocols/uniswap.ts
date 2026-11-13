import type { Contract } from 'ethers'
import { Interface, ZeroAddress } from 'ethers'

import type { Position } from './types.js'
import { addresses } from '../config/index.js'
import type { Token } from '../config/index.js'
import { approvalSteps } from '../chain/index.js'
import type { Params } from '../requests/index.js'
import type { Call, Plan, Chain } from '../chain/index.js'
import {
  uniswapPoolAbi,
  uniswapFactoryAbi,
  positionManagerAbi,
} from '../contracts/index.js'
import {
  amount,
  ensure,
  MAX_UINT128,
  publicError,
  sameAddress,
  minimumAmount,
} from '../shared/index.js'
import {
  formatRatio,
  selectRange,
  describeRange,
  sqrtRatioAtTick,
  encodeInitialPrice,
  boundaryPriceBounds,
  amountsForLiquidity,
  mintAmountsWithSlippage,
} from '../liquidity/index.js'

const managerInterface = new Interface(positionManagerAbi)

async function contracts(chain: Chain) {
  const manager = chain.contract(
    addresses.uniswapPositionManager,
    positionManagerAbi,
  )
  ensure(
    sameAddress(await manager.factory(), addresses.uniswapFactory),
    'UNISWAP_FACTORY_MISMATCH',
  )
  return {
    manager,
    factory: chain.contract(addresses.uniswapFactory, uniswapFactoryAbi),
  }
}
async function poolPrice(
  chain: Chain,
  factory: Contract,
  token0: Token,
  token1: Token,
  fee: number,
) {
  const address: string = await factory.getPool(
    token0.address,
    token1.address,
    fee,
  )
  if (sameAddress(address, ZeroAddress)) {
    return 0n
  }
  const slot = await chain.contract(address, uniswapPoolAbi).slot0()
  return BigInt(slot.sqrtPriceX96)
}
function batch(chain: Chain, calls: [string, unknown[]][]): Call {
  return chain.execute(
    addresses.uniswapPositionManager,
    positionManagerAbi,
    'multicall',
    [
      calls.map(([method, args]) =>
        managerInterface.encodeFunctionData(method, args),
      ),
    ],
  )
}
const collect = (id: bigint) => ({
  tokenId: id,
  recipient: addresses.oreVein,
  amount0Max: MAX_UINT128,
  amount1Max: MAX_UINT128,
})
const approve = (token: Token, value: bigint) => ({
  token: token.address,
  spender: addresses.uniswapPositionManager,
  amount: value.toString(),
})

async function readPosition(
  chain: Chain,
  manager: Contract,
  id: string,
): Promise<Position> {
  const [owner, position] = await Promise.all([
    manager.ownerOf(id),
    manager.positions(id),
  ])
  ensure(sameAddress(owner, addresses.oreVein), 'POSITION_NOT_OWNED')
  const [token0, token1] = await Promise.all([
    chain.tokenByAddress(position.token0),
    chain.tokenByAddress(position.token1),
  ])
  return {
    tokenId: BigInt(id),
    token0,
    token1,
    fee: Number(position.fee),
    tickLower: Number(position.tickLower),
    tickUpper: Number(position.tickUpper),
    liquidity: BigInt(position.liquidity),
    tokensOwed0: BigInt(position.tokensOwed0),
    tokensOwed1: BigInt(position.tokensOwed1),
  }
}
export async function listPositions(chain: Chain, offset = 0, limit = 20) {
  const { manager, factory } = await contracts(chain)
  const count = BigInt(await manager.balanceOf(addresses.oreVein))
  const positions = []
  for (let i = BigInt(offset); i < count && i < BigInt(offset + limit); i++) {
    const tokenId = String(
      await manager.tokenOfOwnerByIndex(addresses.oreVein, i),
    )
    try {
      const value = await readPosition(chain, manager, tokenId)
      const price = await poolPrice(
        chain,
        factory,
        value.token0,
        value.token1,
        value.fee,
      )
      ensure(price > 0n, 'POOL_NOT_INITIALIZED')
      positions.push({
        tokenId,
        tokenA: value.token0,
        tokenB: value.token1,
        fee: value.fee,
        liquidity: value.liquidity.toString(),
        tokensOwedA: value.tokensOwed0.toString(),
        tokensOwedB: value.tokensOwed1.toString(),
        ...describeRange(
          price,
          value.tickLower,
          value.tickUpper,
          value.token0,
          value.token1,
        ),
      })
    } catch (error) {
      positions.push({ tokenId, error: publicError(error) })
    }
  }
  return { total: count.toString(), offset, limit, positions }
}

export async function prepareMint(
  chain: Chain,
  params: Params<'uniswap.mint'>,
  deadline: number,
): Promise<Plan> {
  const { factory } = await contracts(chain)
  const [tokenA, tokenB] = await Promise.all([
    chain.token(params.tokenA),
    chain.token(params.tokenB),
  ])
  ensure(tokenA.symbol !== tokenB.symbol, 'IDENTICAL_TOKENS')
  const amountA = amount(params.amountA, tokenA.decimals, true)
  const amountB = amount(params.amountB, tokenB.decimals, true)
  const sorted = BigInt(tokenA.address) < BigInt(tokenB.address)
  const [token0, token1] = sorted ? [tokenA, tokenB] : [tokenB, tokenA]
  const [budget0, budget1] = sorted ? [amountA, amountB] : [amountB, amountA]
  const spacing = Number(await factory.feeAmountTickSpacing(params.fee))
  let price = await poolPrice(chain, factory, token0, token1, params.fee)
  const initialize = price === 0n
  if (initialize) {
    ensure(params.initialPrice, 'INITIAL_PRICE_REQUIRED')
    price = encodeInitialPrice(params.initialPrice, tokenA, tokenB)
  }
  const preview = selectRange({
    price,
    spacing,
    amount0: budget0,
    amount1: budget1,
    baseIsToken0: sorted,
    minBoundaryPercent: params.minBoundaryPercent,
    slippageBps: params.slippageBps,
  })
  const { tickLower, tickUpper } = preview
  // The manager enforces near-total use even if the price changes after signing.
  const utilizationMinimum0 = (budget0 * 99n + 99n) / 100n
  const utilizationMinimum1 = (budget1 * 99n + 99n) / 100n
  const amount0Min =
    preview.amount0Min > utilizationMinimum0
      ? preview.amount0Min
      : utilizationMinimum0
  const amount1Min =
    preview.amount1Min > utilizationMinimum1
      ? preview.amount1Min
      : utilizationMinimum1
  await Promise.all([
    chain.assertBalance(token0, preview.amount0Desired),
    chain.assertBalance(token1, preview.amount1Desired),
  ])
  const calls: [string, unknown[]][] = []
  if (initialize) {
    calls.push([
      'createAndInitializePoolIfNecessary',
      [token0.address, token1.address, params.fee, price],
    ])
  }
  calls.push([
    'mint',
    [
      {
        token0: token0.address,
        token1: token1.address,
        fee: params.fee,
        tickLower,
        tickUpper,
        amount0Desired: preview.amount0Desired,
        amount1Desired: preview.amount1Desired,
        amount0Min,
        amount1Min,
        recipient: addresses.oreVein,
        deadline,
      },
    ],
  ])
  const [desiredA, desiredB] = sorted
    ? [preview.amount0Desired, preview.amount1Desired]
    : [preview.amount1Desired, preview.amount0Desired]
  const [expectedA, expectedB] = sorted
    ? [preview.expected0, preview.expected1]
    : [preview.expected1, preview.expected0]
  const [minimumA, minimumB] = sorted
    ? [amount0Min, amount1Min]
    : [amount1Min, amount0Min]
  return {
    guards: [
      {
        contract: 'uniswapPool',
        token0: token0.address,
        token1: token1.address,
        fee: params.fee,
        tickLower,
        tickUpper,
        budget0: budget0.toString(),
        budget1: budget1.toString(),
        amount0Desired: preview.amount0Desired.toString(),
        amount1Desired: preview.amount1Desired.toString(),
        ...boundaryPriceBounds(
          tickLower,
          tickUpper,
          params.minBoundaryPercent,
          sorted,
        ),
        ...(initialize ? { initialSqrtPriceX96: price.toString() } : {}),
      },
    ],
    summary: {
      tokenA: tokenA.symbol,
      tokenB: tokenB.symbol,
      decimalsA: tokenA.decimals,
      decimalsB: tokenB.decimals,
      fee: params.fee,
      minBoundaryPercent: params.minBoundaryPercent,
      minimumUtilizationPercent: '99',
      ...describeRange(price, tickLower, tickUpper, tokenA, tokenB),
      initialize,
      amounts: {
        budgetA: amountA.toString(),
        budgetB: amountB.toString(),
        desiredA: desiredA.toString(),
        desiredB: desiredB.toString(),
        expectedA: expectedA.toString(),
        expectedB: expectedB.toString(),
        minimumA: minimumA.toString(),
        minimumB: minimumB.toString(),
        leftoverA: (amountA - expectedA).toString(),
        leftoverB: (amountB - expectedB).toString(),
        utilizationPercentA: formatRatio(expectedA * 100n, amountA, 6),
        utilizationPercentB: formatRatio(expectedB * 100n, amountB, 6),
      },
      deadline,
      recipient: addresses.oreVein,
    },
    steps: [
      ...approvalSteps(chain, [
        approve(token0, preview.amount0Desired),
        approve(token1, preview.amount1Desired),
      ]),
      { code: 'EXECUTE', call: batch(chain, calls) },
    ],
  }
}
export async function prepareIncrease(
  chain: Chain,
  params: Params<'uniswap.increase'>,
  deadline: number,
): Promise<Plan> {
  const { manager, factory } = await contracts(chain)
  const position = await readPosition(chain, manager, params.tokenId)
  const { tokenId, token0, token1, fee, tickLower, tickUpper } = position
  const price = await poolPrice(chain, factory, token0, token1, fee)
  ensure(price > 0n, 'POOL_NOT_INITIALIZED')
  const preview = mintAmountsWithSlippage(
    price,
    tickLower,
    tickUpper,
    amount(params.amount0, token0.decimals, true),
    amount(params.amount1, token1.decimals, true),
    params.slippageBps,
  )
  ensure(
    position.liquidity + preview.liquidity <= MAX_UINT128,
    'LIQUIDITY_OVERFLOW',
  )
  await Promise.all([
    chain.assertBalance(token0, preview.amount0Desired),
    chain.assertBalance(token1, preview.amount1Desired),
  ])
  return {
    guards: [],
    summary: {
      tokenId: params.tokenId,
      token0: token0.symbol,
      token1: token1.symbol,
      maximum0: preview.amount0Desired.toString(),
      maximum1: preview.amount1Desired.toString(),
      minimum0: preview.amount0Min.toString(),
      minimum1: preview.amount1Min.toString(),
      deadline,
    },
    steps: [
      ...approvalSteps(chain, [
        approve(token0, preview.amount0Desired),
        approve(token1, preview.amount1Desired),
      ]),
      {
        code: 'EXECUTE',
        call: chain.execute(
          addresses.uniswapPositionManager,
          positionManagerAbi,
          'increaseLiquidity',
          [
            {
              tokenId,
              amount0Desired: preview.amount0Desired,
              amount1Desired: preview.amount1Desired,
              amount0Min: preview.amount0Min,
              amount1Min: preview.amount1Min,
              deadline,
            },
          ],
        ),
      },
    ],
  }
}
export async function prepareCollect(
  chain: Chain,
  params: Params<'uniswap.collect'>,
): Promise<Plan> {
  const { manager } = await contracts(chain)
  const position = await readPosition(chain, manager, params.tokenId)
  return {
    guards: [],
    summary: { tokenId: params.tokenId, recipient: addresses.oreVein },
    steps: [
      {
        code: 'EXECUTE',
        call: chain.execute(
          addresses.uniswapPositionManager,
          positionManagerAbi,
          'collect',
          [collect(position.tokenId)],
        ),
      },
    ],
  }
}
export async function prepareClose(
  chain: Chain,
  params: Params<'uniswap.close'>,
  deadline: number,
): Promise<Plan> {
  const { manager, factory } = await contracts(chain)
  const position = await readPosition(chain, manager, params.tokenId)
  const { tokenId, token0, token1, fee, tickLower, tickUpper, liquidity } =
    position
  const calls: [string, unknown[]][] = []
  let minimum0 = 0n,
    minimum1 = 0n
  if (liquidity > 0n) {
    const price = await poolPrice(chain, factory, token0, token1, fee)
    ensure(price > 0n, 'POOL_NOT_INITIALIZED')
    const [amount0, amount1] = amountsForLiquidity(
      price,
      sqrtRatioAtTick(tickLower),
      sqrtRatioAtTick(tickUpper),
      liquidity,
    )
    minimum0 = minimumAmount(amount0, params.slippageBps)
    minimum1 = minimumAmount(amount1, params.slippageBps)
    calls.push([
      'decreaseLiquidity',
      [
        {
          tokenId,
          liquidity,
          amount0Min: minimum0,
          amount1Min: minimum1,
          deadline,
        },
      ],
    ])
  }
  calls.push(['collect', [collect(tokenId)]])
  return {
    guards: [],
    summary: {
      tokenId: params.tokenId,
      liquidity: liquidity.toString(),
      minimum0: minimum0.toString(),
      minimum1: minimum1.toString(),
      deadline,
      recipient: addresses.oreVein,
    },
    steps: [{ code: 'EXECUTE', call: batch(chain, calls) }],
  }
}

export async function prepareBurn(
  chain: Chain,
  params: Params<'uniswap.burn'>,
): Promise<Plan> {
  const { manager } = await contracts(chain)
  const position = await readPosition(chain, manager, params.tokenId)
  ensure(
    position.liquidity === 0n &&
      position.tokensOwed0 === 0n &&
      position.tokensOwed1 === 0n,
    'POSITION_NOT_EMPTY',
  )
  return {
    guards: [],
    summary: { tokenId: params.tokenId },
    steps: [
      {
        code: 'EXECUTE',
        call: chain.execute(
          addresses.uniswapPositionManager,
          positionManagerAbi,
          'burn',
          [position.tokenId],
        ),
      },
    ],
  }
}
