import { formatEther } from 'ethers'

import type { Preview, Operation, OperationView } from './types.js'

export function operationView(operation: Operation): OperationView {
  const { guards: _guards, steps, ...rest } = operation
  return structuredClone({
    ...rest,
    steps: steps.map(step => ({
      id: step.id,
      code: step.code,
      status: step.status,
      approval: step.approval,
      transactionHash: step.receipt?.hash ?? step.signed?.hash,
      nonce: step.signed?.nonce,
      receipt: step.receipt,
      error: step.error,
    })),
  })
}

export function previewView(preview: Preview) {
  return structuredClone({
    id: preview.id,
    expiresAt: preview.expiresAt,
    request: preview.request,
    summary: preview.plan.summary,
    steps: preview.plan.steps.map((step, index) => ({
      id: index,
      code: step.code,
      approval: step.approval,
      gasEstimate: { code: step.code, ...step.gasEstimate },
    })),
    knownGasEstimateAvax: formatEther(
      preview.plan.steps.reduce(
        (sum, step) => sum + BigInt(step.gasEstimate.maxGasWei ?? '0'),
        0n,
      ),
    ),
    gasEstimateComplete: preview.plan.steps.every(
      step => step.gasEstimate.status !== 'requires_prior_steps',
    ),
  })
}
