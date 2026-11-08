import type { Chain } from './context.js'
import { erc20Abi } from '../contracts/index.js'
import type { Approval, PlannedStep } from './types.js'

export async function approvalSteps(
  chain: Chain,
  approvals: Approval[],
): Promise<PlannedStep[]> {
  const steps: PlannedStep[] = []
  for (const approval of approvals) {
    const required = BigInt(approval.amount)
    if (required === 0n) {
      continue
    }
    // Оба условных шага фиксируются заранее и проверяются после ожидания очереди.
    steps.push({
      code: 'ALLOWANCE_RESET',
      approval: { ...approval, amount: '0', resetBelow: approval.amount },
      call: chain.execute(approval.token, erc20Abi, 'approve', [
        approval.spender,
        0n,
      ]),
    })
    steps.push({
      code: 'ALLOWANCE_APPROVE',
      approval,
      call: chain.execute(approval.token, erc20Abi, 'approve', [
        approval.spender,
        required,
      ]),
    })
  }
  return steps
}
