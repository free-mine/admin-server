import { ZeroAddress } from 'ethers'
import { addresses } from '../config/index.js'
import type { Token } from '../config/index.js'
import { approvalSteps } from '../chain/index.js'
import type { Chain, Call, Plan } from '../chain/index.js'
import { positionManagerAbi, uniswapFactoryAbi, uniswapPoolAbi } from '../contracts/index.js'
import type { Params } from '../requests/index.js'
import { amount, ensure, MAX_UINT128, minimumAmount, publicError, sameAddress } from '../shared/index.js'
import { amountsForLiquidity, encodeInitialPrice, mintAmountsWithSlippage, sqrtRatioAtTick, usableTicks, validateTicks } from './uniswap-math.js'
import type { Position } from './types.js'

async function contracts(chain: Chain) {
  const manager = chain.contract(addresses.uniswapPositionManager, positionManagerAbi)
  ensure(sameAddress(await manager.factory(), addresses.uniswapFactory), 'UNISWAP_FACTORY_MISMATCH')
  return { manager, factory: chain.contract(addresses.uniswapFactory, uniswapFactoryAbi) }
}
async function poolState(chain: Chain, token0: Token, token1: Token, fee: number) {
  const { factory } = await contracts(chain)
  const address: string = await factory.getPool(token0.address, token1.address, fee)
  if (sameAddress(address, ZeroAddress)) return { address, price: 0n }
  const slot = await chain.contract(address, uniswapPoolAbi).slot0()
  return { address, price: BigInt(slot.sqrtPriceX96) }
}
function batch(chain: Chain, calls: [string, unknown[]][]): Call {
  const manager = chain.contract(addresses.uniswapPositionManager, positionManagerAbi)
  return chain.execute(addresses.uniswapPositionManager, positionManagerAbi, 'multicall',
    [calls.map(([method, args]) => manager.interface.encodeFunctionData(method, args))])
}
const collect = (id: bigint) => ({ tokenId: id, recipient: addresses.oreVein, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 })
const approve = (token: Token, value: bigint) => ({ token: token.address, spender: addresses.uniswapPositionManager, amount: value.toString() })

export async function readPosition(chain: Chain, id: string): Promise<Position> {
  const { manager } = await contracts(chain)
  const [owner, position] = await Promise.all([manager.ownerOf(id), manager.positions(id)])
  ensure(sameAddress(owner, addresses.oreVein), 'POSITION_NOT_OWNED')
  const [token0, token1] = await Promise.all([chain.tokenByAddress(position.token0), chain.tokenByAddress(position.token1)])
  return { tokenId: BigInt(id), token0, token1, fee: Number(position.fee), tickLower: Number(position.tickLower),
    tickUpper: Number(position.tickUpper), liquidity: BigInt(position.liquidity),
    tokensOwed0: BigInt(position.tokensOwed0), tokensOwed1: BigInt(position.tokensOwed1) }
}
export async function listPositions(chain: Chain, offset = 0, limit = 20) {
  const { manager } = await contracts(chain)
  const count = BigInt(await manager.balanceOf(addresses.oreVein))
  const positions = []
  for (let i = BigInt(offset); i < count && i < BigInt(offset + limit); i++) {
    const tokenId = String(await manager.tokenOfOwnerByIndex(addresses.oreVein, i))
    try {
      const value = await readPosition(chain, tokenId)
      positions.push({ ...value, tokenId, liquidity: value.liquidity.toString(),
        tokensOwed0: value.tokensOwed0.toString(), tokensOwed1: value.tokensOwed1.toString() })
    } catch (error) { positions.push({ tokenId, error: publicError(error) }) }
  }
  return { total: count.toString(), offset, limit, positions }
}

export async function prepareMint(chain: Chain, params: Params<'uniswap.mint'>, deadline: number): Promise<Plan> {
  const { factory } = await contracts(chain)
  const [tokenA, tokenB] = await Promise.all([chain.token(params.tokenA), chain.token(params.tokenB)])
  ensure(tokenA.symbol !== tokenB.symbol, 'IDENTICAL_TOKENS')
  const amountA = amount(params.amountA, tokenA.decimals, true)
  const amountB = amount(params.amountB, tokenB.decimals, true)
  const sorted = BigInt(tokenA.address) < BigInt(tokenB.address)
  const [token0, token1] = sorted ? [tokenA, tokenB] : [tokenB, tokenA]
  const [budget0, budget1] = sorted ? [amountA, amountB] : [amountB, amountA]
  const spacing = Number(await factory.feeAmountTickSpacing(params.fee))
  const [tickLower, tickUpper] = params.range === 'full' ? usableTicks(spacing) : [params.tickLower!, params.tickUpper!]
  validateTicks(tickLower, tickUpper, spacing)
  const pool = await poolState(chain, token0, token1, params.fee)
  const initialize = pool.price === 0n
  ensure(!initialize || params.initialPrice, 'INITIAL_PRICE_REQUIRED')
  const price = initialize ? encodeInitialPrice(params.initialPrice!, tokenA, tokenB) : pool.price
  const preview = mintAmountsWithSlippage(price, tickLower, tickUpper, budget0, budget1, params.slippageBps)
  await Promise.all([chain.assertBalance(token0, preview.amount0Desired), chain.assertBalance(token1, preview.amount1Desired)])
  const calls: [string, unknown[]][] = []
  if (initialize) calls.push(['createAndInitializePoolIfNecessary', [token0.address, token1.address, params.fee, price]])
  calls.push(['mint', [{ token0: token0.address, token1: token1.address, fee: params.fee, tickLower, tickUpper,
    amount0Desired: preview.amount0Desired, amount1Desired: preview.amount1Desired,
    amount0Min: preview.amount0Min, amount1Min: preview.amount1Min, recipient: addresses.oreVein, deadline }]])
  return { guards: [], summary: { token0: token0.symbol, token1: token1.symbol, fee: params.fee, tickLower, tickUpper,
    initialize, sqrtPriceX96: price.toString(), maximum0: preview.amount0Desired.toString(), maximum1: preview.amount1Desired.toString(),
    minimum0: preview.amount0Min.toString(), minimum1: preview.amount1Min.toString(), deadline, recipient: addresses.oreVein },
    steps: [...await approvalSteps(chain, [approve(token0, preview.amount0Desired), approve(token1, preview.amount1Desired)]),
      { code: 'EXECUTE', call: batch(chain, calls) }] }
}
export async function prepareIncrease(chain: Chain, params: Params<'uniswap.increase'>, deadline: number): Promise<Plan> {
  const position = await readPosition(chain, params.tokenId)
  const { tokenId, token0, token1, fee, tickLower, tickUpper } = position
  const pool = await poolState(chain, token0, token1, fee)
  ensure(pool.price > 0n, 'POOL_NOT_INITIALIZED')
  const preview = mintAmountsWithSlippage(pool.price, tickLower, tickUpper,
    amount(params.amount0, token0.decimals, true), amount(params.amount1, token1.decimals, true), params.slippageBps)
  ensure(position.liquidity + preview.liquidity <= MAX_UINT128, 'LIQUIDITY_OVERFLOW')
  await Promise.all([chain.assertBalance(token0, preview.amount0Desired), chain.assertBalance(token1, preview.amount1Desired)])
  return { guards: [], summary: { tokenId: params.tokenId, token0: token0.symbol, token1: token1.symbol,
    maximum0: preview.amount0Desired.toString(), maximum1: preview.amount1Desired.toString(),
    minimum0: preview.amount0Min.toString(), minimum1: preview.amount1Min.toString(), deadline },
    steps: [...await approvalSteps(chain, [approve(token0, preview.amount0Desired), approve(token1, preview.amount1Desired)]),
      { code: 'EXECUTE', call: chain.execute(addresses.uniswapPositionManager, positionManagerAbi, 'increaseLiquidity', [{
        tokenId, amount0Desired: preview.amount0Desired, amount1Desired: preview.amount1Desired,
        amount0Min: preview.amount0Min, amount1Min: preview.amount1Min, deadline,
      }]) }] }
}
export async function prepareCollect(chain: Chain, params: Params<'uniswap.collect'>): Promise<Plan> {
  const position = await readPosition(chain, params.tokenId)
  return { guards: [], summary: { tokenId: params.tokenId, recipient: addresses.oreVein },
    steps: [{ code: 'EXECUTE', call: chain.execute(addresses.uniswapPositionManager, positionManagerAbi, 'collect', [collect(position.tokenId)]) }] }
}
export async function prepareClose(chain: Chain, params: Params<'uniswap.close'>, deadline: number): Promise<Plan> {
  const position = await readPosition(chain, params.tokenId)
  const { tokenId, token0, token1, fee, tickLower, tickUpper, liquidity } = position
  const calls: [string, unknown[]][] = []
  let minimum0 = 0n, minimum1 = 0n
  if (liquidity > 0n) {
    const pool = await poolState(chain, token0, token1, fee)
    ensure(pool.price > 0n, 'POOL_NOT_INITIALIZED')
    const [amount0, amount1] = amountsForLiquidity(pool.price, sqrtRatioAtTick(tickLower), sqrtRatioAtTick(tickUpper), liquidity)
    minimum0 = minimumAmount(amount0, params.slippageBps); minimum1 = minimumAmount(amount1, params.slippageBps)
    calls.push(['decreaseLiquidity', [{ tokenId, liquidity, amount0Min: minimum0, amount1Min: minimum1, deadline }]])
  }
  calls.push(['collect', [collect(tokenId)]], ['burn', [tokenId]])
  return { guards: [], summary: { tokenId: params.tokenId, liquidity: liquidity.toString(), minimum0: minimum0.toString(),
    minimum1: minimum1.toString(), deadline, recipient: addresses.oreVein }, steps: [{ code: 'EXECUTE', call: batch(chain, calls) }] }
}
