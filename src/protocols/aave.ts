import { MaxUint256, ZeroAddress } from 'ethers'

import type { AaveAction } from './types.js'
import { approvalSteps } from '../chain/index.js'
import { amount, ensure } from '../shared/index.js'
import type { Plan, Chain } from '../chain/index.js'
import { tokens, addresses } from '../config/index.js'
import { poolAbi, erc20Abi } from '../contracts/index.js'

export async function prepareAave(
  chain: Chain,
  action: AaveAction,
): Promise<Plan> {
  const token = await chain.token(action.params.token)
  const pool = chain.contract(addresses.aave, poolAbi)
  const reserve = await pool.getReserveData(token.address)
  ensure(reserve.aTokenAddress !== ZeroAddress, 'AAVE_RESERVE_NOT_FOUND')
  const units =
    action.params.amount === 'all'
      ? MaxUint256
      : amount(action.params.amount, token.decimals)
  const approvals = []
  let method: string
  let args: unknown[]
  switch (action.kind) {
    case 'aave.supply':
      await chain.assertBalance(token, units)
      approvals.push({
        token: token.address,
        spender: addresses.aave,
        amount: units.toString(),
      })
      method = 'supply'
      args = [token.address, units, addresses.oreVein, 0]
      break
    case 'aave.repay': {
      ensure(
        reserve.variableDebtTokenAddress !== ZeroAddress,
        'AAVE_VARIABLE_DEBT_UNAVAILABLE',
      )
      const debt = BigInt(
        await chain
          .contract(reserve.variableDebtTokenAddress, erc20Abi)
          .balanceOf(addresses.oreVein),
      )
      ensure(debt > 0n, 'AAVE_NO_DEBT')
      await chain.assertBalance(token, units)
      approvals.push({
        token: token.address,
        spender: addresses.aave,
        amount: units.toString(),
      })
      method = 'repay'
      args = [token.address, units, 2, addresses.oreVein]
      break
    }
    case 'aave.borrow':
      ensure(
        reserve.variableDebtTokenAddress !== ZeroAddress,
        'AAVE_VARIABLE_DEBT_UNAVAILABLE',
      )
      method = 'borrow'
      args = [token.address, units, 2, 0, addresses.oreVein]
      break
    case 'aave.withdraw':
      method = 'withdraw'
      args = [token.address, units, addresses.oreVein]
      break
  }
  return {
    guards: [],
    summary: {
      token: token.symbol,
      amount: units.toString(),
      decimals: token.decimals,
      withdrawAll: action.params.amount === 'all',
      recipient: addresses.oreVein,
      interestRateMode: 2,
    },
    steps: [
      ...approvalSteps(chain, approvals),
      {
        code: 'EXECUTE',
        call: chain.execute(addresses.aave, poolAbi, method, args),
      },
    ],
  }
}

export async function readAave(chain: Chain) {
  const pool = chain.contract(addresses.aave, poolAbi)
  const block = await chain.provider.getBlockNumber()
  const account = await pool.getUserAccountData(addresses.oreVein, {
    blockTag: block,
  })
  const reserves = []
  for (const metadata of tokens) {
    const token = await chain.token(metadata.symbol)
    const reserve = await pool.getReserveData(token.address, {
      blockTag: block,
    })
    const supplied =
      reserve.aTokenAddress === ZeroAddress
        ? 0n
        : await chain
            .contract(reserve.aTokenAddress, erc20Abi)
            .balanceOf(addresses.oreVein, { blockTag: block })
    const debt =
      reserve.variableDebtTokenAddress === ZeroAddress
        ? 0n
        : await chain
            .contract(reserve.variableDebtTokenAddress, erc20Abi)
            .balanceOf(addresses.oreVein, { blockTag: block })
    reserves.push({
      ...token,
      supplied: String(supplied),
      variableDebt: String(debt),
      supplyRateRay: String(reserve.currentLiquidityRate),
      variableBorrowRateRay: String(reserve.currentVariableBorrowRate),
    })
  }
  return {
    block,
    totalCollateralBase: String(account.totalCollateralBase),
    totalDebtBase: String(account.totalDebtBase),
    availableBorrowsBase: String(account.availableBorrowsBase),
    baseDecimals: 8,
    currentLiquidationThreshold: String(account.currentLiquidationThreshold),
    ltv: String(account.ltv),
    healthFactor:
      BigInt(account.totalDebtBase) === 0n
        ? null
        : String(account.healthFactor),
    healthFactorDecimals: 18,
    reserves,
  }
}
