import { ZeroAddress } from 'ethers'

import type { Quote } from './types.js'
import type { Token } from '../config/index.js'
import { approvalSteps } from '../chain/index.js'
import type { Params } from '../requests/index.js'
import type { Plan, Chain } from '../chain/index.js'
import { tokens, addresses } from '../config/index.js'
import { lfjQuoterAbi, lfjRouterAbi } from '../contracts/index.js'
import {
  amount,
  ensure,
  MAX_UINT128,
  sameAddress,
  minimumAmount,
} from '../shared/index.js'

function routes(tokenIn: Token, tokenOut: Token): string[][] {
  const bridges = tokens.filter(
    t => t.symbol !== tokenIn.symbol && t.symbol !== tokenOut.symbol,
  )
  const result = [[tokenIn.address, tokenOut.address]]
  const extend = (prefix: string[], remaining: readonly Token[]) => {
    for (const token of remaining) {
      const next = [...prefix, token.address]
      result.push([...next, tokenOut.address])
      extend(
        next,
        remaining.filter(t => t.symbol !== token.symbol),
      )
    }
  }
  extend([tokenIn.address], bridges)
  return result
}
function quotedOutput(quote: Quote): bigint {
  const output = quote.amounts.at(-1)
  ensure(output !== undefined, 'LFJ_NO_ROUTE')
  return output
}

function usable(quote: Quote, route: string[], input: bigint): boolean {
  return (
    quote.route.length === route.length &&
    quote.amounts.length === route.length &&
    quote.pairs.length === route.length - 1 &&
    quote.binSteps.length === quote.pairs.length &&
    quote.versions.length === quote.pairs.length &&
    quote.route.every((v, i) => sameAddress(v, route[i])) &&
    quote.pairs.every(v => !sameAddress(v, ZeroAddress)) &&
    quote.amounts[0] === input &&
    quote.amounts.every(v => v > 0n && v <= MAX_UINT128) &&
    quote.versions.every(v => v >= 0n && v <= 3n)
  )
}
export async function prepareSwap(
  chain: Chain,
  params: Params<'lfj.swap'>,
  deadline: number,
): Promise<Plan> {
  const [tokenIn, tokenOut] = await Promise.all([
    chain.token(params.tokenIn),
    chain.token(params.tokenOut),
  ])
  ensure(tokenIn.symbol !== tokenOut.symbol, 'IDENTICAL_TOKENS')
  const input = amount(params.amount, tokenIn.decimals)
  ensure(input <= MAX_UINT128, 'LFJ_AMOUNT_RANGE')
  await chain.assertBalance(tokenIn, input)
  const quoter = chain.contract(addresses.lfjQuoter, lfjQuoterAbi)
  const candidates = routes(tokenIn, tokenOut)
  const results = await Promise.allSettled(
    candidates.map(
      route => quoter.findBestPathFromAmountIn(route, input) as Promise<Quote>,
    ),
  )
  const quotes = results.flatMap((result, i) =>
    result.status === 'fulfilled' && usable(result.value, candidates[i], input)
      ? [result.value]
      : [],
  )
  ensure(quotes.length, 'LFJ_NO_ROUTE')
  const quote = quotes.reduce((best, next) =>
    quotedOutput(next) > quotedOutput(best) ? next : best,
  )
  const output = quotedOutput(quote)
  const minimum = minimumAmount(output, params.slippageBps)
  const path = {
    tokenPath: [...quote.route],
    versions: [...quote.versions],
    pairBinSteps: [...quote.binSteps],
  }
  return {
    guards: [],
    summary: {
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountIn: input.toString(),
      quotedOut: output.toString(),
      minimumOut: minimum.toString(),
      slippageBps: params.slippageBps,
      route: [...quote.route],
      deadline,
      recipient: addresses.oreVein,
    },
    steps: [
      ...(await approvalSteps(chain, [
        {
          token: tokenIn.address,
          spender: addresses.lfjRouter,
          amount: input.toString(),
        },
      ])),
      {
        code: 'EXECUTE',
        call: chain.execute(
          addresses.lfjRouter,
          lfjRouterAbi,
          'swapExactTokensForTokens',
          [input, minimum, path, addresses.oreVein, deadline],
        ),
      },
    ],
  }
}
