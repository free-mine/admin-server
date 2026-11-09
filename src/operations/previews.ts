import { randomUUID } from 'node:crypto'

import { prepareFund } from '../fund/index.js'
import { amount, ensure } from '../shared/index.js'
import { canSkipApproval } from '../chain/index.js'
import type { Plan, Chain } from '../chain/index.js'
import { prepareSuccessor } from '../successors/index.js'
import type { PreviewRequest } from '../requests/index.js'
import type { Preview, GasEstimate, PreviewStep } from './types.js'
import {
  prepareAave,
  prepareSwap,
  prepareMint,
  prepareBurn,
  prepareClose,
  prepareCollect,
  prepareIncrease,
} from '../protocols/index.js'

export class Previews {
  private previews = new Map<string, Preview>()
  constructor(
    private chain: Chain,
    private ttlSeconds: number,
  ) {}

  get(id: string): Preview {
    const preview = this.previews.get(id)
    ensure(preview, 'PREVIEW_NOT_FOUND')
    ensure(preview.expiresAt > Date.now(), 'PREVIEW_EXPIRED')
    return structuredClone(preview)
  }
  async create(request: PreviewRequest): Promise<Preview> {
    request = structuredClone(request)
    await this.chain.assertAvailable()
    const budget = amount(request.maxGasAvax, 18)
    let expiresAt = Date.now() + this.ttlSeconds * 1000
    const block = await this.chain.provider.getBlock('latest')
    ensure(block, 'BLOCK_UNAVAILABLE')
    const deadline = Math.min(
      Math.floor(expiresAt / 1000),
      block.timestamp + this.ttlSeconds,
    )
    expiresAt = deadline * 1000
    const { action } = request
    let plan: Plan
    switch (action.kind) {
      case 'successor.schedule':
        expiresAt = Math.min(expiresAt, action.params.timestamp * 1000)
        plan = await prepareSuccessor(this.chain, action)
        break
      case 'successor.remove':
        plan = await prepareSuccessor(this.chain, action)
        break
      case 'contract.setURI':
      case 'fund.closeShift':
      case 'fund.fundShift':
      case 'fund.expireClaim':
      case 'fund.updateEntryPrice':
      case 'fund.changeDollar':
        plan = await prepareFund(this.chain, action)
        break
      case 'aave.supply':
      case 'aave.withdraw':
      case 'aave.borrow':
      case 'aave.repay':
        plan = await prepareAave(this.chain, action)
        break
      case 'lfj.swap':
        plan = await prepareSwap(this.chain, action.params, deadline)
        break
      case 'uniswap.mint':
        plan = await prepareMint(this.chain, action.params, deadline)
        break
      case 'uniswap.increase':
        plan = await prepareIncrease(this.chain, action.params, deadline)
        break
      case 'uniswap.collect':
        plan = await prepareCollect(this.chain, action.params)
        break
      case 'uniswap.close':
        plan = await prepareClose(this.chain, action.params, deadline)
        break
      case 'uniswap.burn':
        plan = await prepareBurn(this.chain, action.params)
        break
    }
    const steps: PreviewStep[] = []
    let dependency = false
    let knownCost = 0n
    for (const step of plan.steps) {
      const skipped = await canSkipApproval(this.chain, step)
      let gasEstimate: GasEstimate
      if (skipped) {
        gasEstimate = { maxGasWei: '0', status: 'skipped' }
      } else if (dependency) {
        gasEstimate = {
          maxGasWei: null,
          status: 'requires_prior_steps',
        }
      } else {
        await this.chain.simulate(step.call)
        const fee = await this.chain.estimate(step.call)
        knownCost += fee.maxCost
        gasEstimate = {
          maxGasWei: fee.maxCost.toString(),
          status: 'estimated',
        }
      }
      steps.push({ ...step, gasEstimate })
      if (step.approval && !skipped) {
        dependency = true
      }
    }
    ensure(knownCost <= budget, 'GAS_BUDGET_EXCEEDED')
    ensure(expiresAt > Date.now(), 'PREVIEW_EXPIRED')
    const preview: Preview = {
      id: randomUUID(),
      expiresAt,
      request,
      plan: { ...plan, steps },
    }
    for (const [id, value] of this.previews) {
      if (value.expiresAt <= Date.now()) {
        this.previews.delete(id)
      }
    }
    ensure(this.previews.size < 200, 'TOO_MANY_PREVIEWS')
    this.previews.set(preview.id, preview)
    return structuredClone(preview)
  }
}
