import type { FundAction } from './types.js'
import { addresses } from '../config/index.js'
import { amount, ensure } from '../shared/index.js'
import type { Plan, Chain, Guard } from '../chain/index.js'

export async function prepareFund(
  chain: Chain,
  action: FundAction,
): Promise<Plan> {
  const guards: Guard[] = []
  const guard = async (method: string): Promise<string> => {
    const value = String(await chain.freeMine.getFunction(method)())
    guards.push({ contract: 'freeMine', method, args: [], expected: value })
    return value
  }
  let method: string
  let args: unknown[]
  const summary: Plan['summary'] = {}
  switch (action.kind) {
    case 'contract.setURI':
      method = 'setContractURI'
      args = [action.params.uri]
      summary.uri = action.params.uri
      break
    case 'fund.closeShift':
      summary.shiftId = await guard('currentShiftId')
      method = 'closeShift'
      args = []
      break
    case 'fund.fundShift': {
      const current = BigInt(await guard('currentShiftId'))
      ensure(current > 1n, 'NO_CLOSED_SHIFT')
      const dollar = await guard('dollar')
      await guard('entryPrice')
      const token = await chain.tokenByAddress(dollar)
      const shift = await chain.freeMine.shifts(current - 1n)
      ensure(!shift.funded, 'SHIFT_ALREADY_FUNDED')
      const price = amount(action.params.price, 18)
      const maximum =
        (BigInt(shift.oreAmount) * price) /
        (10n ** 18n * 10n ** BigInt(18 - token.decimals))
      await chain.assertBalance(token, maximum)
      summary.shiftId = (current - 1n).toString()
      summary.price = price.toString()
      summary.token = token.symbol
      summary.maximumFunding = maximum.toString()
      method = 'fundShift'
      args = [price]
      break
    }
    case 'fund.expireClaim':
      method = 'expireClaim'
      args = [action.params.shiftId, action.params.claimId]
      summary.shiftId = action.params.shiftId
      summary.claimId = action.params.claimId
      break
    case 'fund.updateEntryPrice':
      await guard('entryPrice')
      method = 'updateEntryPrice'
      args = [amount(action.params.price, 18)]
      summary.price = String(args[0])
      break
    case 'fund.changeDollar': {
      const token = await chain.token(action.params.token)
      await guard('dollar')
      method = 'changeDollar'
      args = [token.address]
      summary.token = token.symbol
      summary.address = token.address
      break
    }
  }
  return {
    steps: [{ code: 'EXECUTE', call: chain.direct(method, args) }],
    guards,
    summary: { ...summary, capitalHolder: addresses.oreVein },
  }
}
