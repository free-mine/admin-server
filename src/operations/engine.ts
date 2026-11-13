import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { operationView } from './views.js'
import type { Journal } from './journal.js'
import { canSkipApproval } from '../chain/index.js'
import type { PublicError } from '../shared/index.js'
import type { Receipt, TransactionTransport } from '../chain/index.js'
import { amount, ensure, AppError, publicError } from '../shared/index.js'
import type {
  Preview,
  Operation,
  OperationStep,
  OperationView,
} from './types.js'

const terminal = (operation: Operation) =>
  operation.status === 'succeeded' || operation.status === 'failed'

export class Operations {
  private stopped = true
  private abort = new AbortController()
  private task?: Promise<void>
  private listeners = new Set<(operation: OperationView) => void>()
  private failed = false
  private unsubscribeJournal?: () => void

  constructor(
    private readonly journal: Journal,
    private chain: TransactionTransport,
    private pollMs: number,
  ) {}
  get fatal(): boolean {
    return this.failed || this.journal.isBlocked
  }
  start(): void {
    if (this.chain.readOnly || !this.stopped) {
      return
    }
    this.abort = new AbortController()
    this.stopped = false
    this.unsubscribeJournal ??= this.journal.subscribe(() => this.kick())
    this.kick()
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.abort.abort()
    this.unsubscribeJournal?.()
    this.unsubscribeJournal = undefined
    await this.task
  }
  subscribe(listener: (operation: OperationView) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  get count(): number {
    return this.journal.all().length
  }
  list(offset = 0, limit = 20): OperationView[] {
    return [...this.journal.all()]
      .reverse()
      .slice(offset, offset + limit)
      .map(operationView)
  }
  get(id: string): OperationView {
    const operation = this.journal.get(id)
    if (!operation) {
      throw new AppError('OPERATION_NOT_FOUND', 404)
    }
    return operationView(operation)
  }
  existing(requestId: string, previewId: string): OperationView | undefined {
    const existing = this.journal
      .all()
      .find(operation => operation.requestId === requestId)
    if (existing) {
      if (existing.previewId !== previewId) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 409)
      }
      return operationView(existing)
    }
  }
  submit(preview: Preview, requestId: string): OperationView {
    if (this.chain.readOnly) {
      throw new AppError('READ_ONLY', 403)
    }
    this.journal.assertWritable()
    const existing = this.existing(requestId, preview.id)
    if (existing) {
      return existing
    }
    ensure(!this.fatal && !this.stopped, 'SERVICE_NOT_READY')
    ensure(preview.expiresAt > Date.now(), 'PREVIEW_EXPIRED')
    if (
      this.journal.all().some(operation => operation.previewId === preview.id)
    ) {
      throw new AppError('PREVIEW_ALREADY_SUBMITTED', 409)
    }
    ensure(
      this.journal.all().filter(operation => !terminal(operation)).length < 50,
      'QUEUE_FULL',
    )
    const operation: Operation = {
      id: randomUUID(),
      previewId: preview.id,
      requestId,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 0,
      expiresAt: preview.expiresAt,
      request: structuredClone(preview.request),
      summary: structuredClone(preview.plan.summary),
      guards: structuredClone(preview.plan.guards),
      maxGasWei: amount(preview.request.maxGasAvax, 18).toString(),
      gasSpentWei: '0',
      steps: preview.plan.steps.map((step, id) => {
        const { gasEstimate: _estimate, ...planned } = structuredClone(step)
        return { ...planned, id, status: 'pending' }
      }),
    }
    this.publish(operation)
    this.kick()
    return operationView(operation)
  }
  private publish(operation: Operation): void {
    operation.version++
    operation.updatedAt = Date.now()
    try {
      this.journal.save(operation)
    } catch (error) {
      this.failed = true
      throw error
    }
    for (const listener of this.listeners) {
      try {
        listener(operationView(operation))
      } catch {
        /* Ошибка подписчика не меняет результат транзакции. */
      }
    }
  }
  private kick(): void {
    if (this.task || this.stopped || this.fatal) {
      return
    }
    this.task = Promise.resolve()
      .then(() => this.drain())
      .catch(() => {
        this.failed = true
      })
      .finally(() => {
        this.task = undefined
        if (this.journal.all().some(operation => !terminal(operation))) {
          this.kick()
        }
      })
  }
  private async drain(): Promise<void> {
    while (!this.stopped && !this.fatal) {
      const pending = this.journal.all().filter(value => !terminal(value))
      // A recovered signature already owns its nonce. Finish it before starting
      // a queued operation, including after an offline restart.
      const operation =
        pending.find(value =>
          value.steps.some(step => step.signed && !step.receipt),
        ) ?? pending[0]
      if (!operation) {
        return
      }
      await this.run(operation)
    }
  }
  private async run(operation: Operation): Promise<void> {
    let active: OperationStep | undefined
    try {
      for (const step of operation.steps) {
        if (this.stopped || this.fatal) {
          return
        }
        if (step.status === 'confirmed' || step.status === 'skipped') {
          continue
        }
        active = step
        if (!step.signed) {
          ensure(operation.expiresAt > Date.now(), 'PLAN_EXPIRED')
          operation.status = 'running'
          step.status = 'checking'
          this.publish(operation)
          await this.chain.assertOwner()
          if (await canSkipApproval(this.chain, step)) {
            step.status = 'skipped'
            this.publish(operation)
            continue
          }
          await this.chain.validate(operation.guards)
          step.status = 'signing'
          this.publish(operation)
          this.journal.assertWritable()
          const signed = await this.chain.sign(
            step.call,
            BigInt(operation.maxGasWei) - BigInt(operation.gasSpentWei),
            step.approval,
          )
          // До записи подписи ещё можно безопасно отменить отправку при остановке.
          if (this.stopped) {
            return
          }
          await this.chain.validate(operation.guards)
          if (this.stopped) {
            return
          }
          ensure(operation.expiresAt > Date.now(), 'PLAN_EXPIRED')
          step.signed = signed
          step.status = 'broadcasting'
          this.publish(operation)
        }
        const receipt = await this.waitForReceipt(operation, step)
        if (!receipt || this.stopped) {
          return
        }
        if (operation.status === 'failed') {
          return
        }
        step.receipt = receipt
        operation.gasSpentWei = (
          BigInt(operation.gasSpentWei) + BigInt(receipt.fee)
        ).toString()
        ensure(receipt.status === 1, 'TRANSACTION_REVERTED')
        step.status = 'confirmed'
        operation.status = 'running'
        delete operation.error
        this.publish(operation)
        if (step.approval && step.code === 'ALLOWANCE_APPROVE') {
          ensure(
            (await this.chain.allowance(step.approval)) >=
              BigInt(step.approval.amount),
            'ALLOWANCE_NOT_GRANTED',
          )
        }
      }
      const receipt = operation.steps.at(-1)?.receipt
      if (receipt) {
        try {
          operation.result = await this.chain.readResult(
            operation.request.action,
            receipt,
          )
        } catch (error) {
          // Неудачное чтение результата не отменяет подтверждённую транзакцию.
          operation.result = { error: { ...publicError(error) } }
        }
      }
      if (this.stopped || this.fatal) {
        return
      }
      operation.status = 'succeeded'
      delete operation.error
      this.publish(operation)
    } catch (error) {
      if (this.fatal) {
        throw error
      }
      if (this.stopped) {
        return
      }
      operation.status = 'failed'
      operation.error = publicError(error)
      if (
        active &&
        active.status !== 'confirmed' &&
        active.status !== 'skipped'
      ) {
        active.status = 'failed'
        active.error = operation.error
      }
      this.publish(operation)
    }
  }
  private async waitForReceipt(
    operation: Operation,
    step: OperationStep,
  ): Promise<Receipt | null> {
    const signed = step.signed
    ensure(signed, 'INTERNAL_ERROR')
    let lastBroadcast = 0
    // RPC только собирает результат. Состояние меняется ниже, без await,
    // после проверки, не завершил ли /resolve это ожидание.
    const poll = async (): Promise<Receipt | PublicError | null> => {
      try {
        const receipt = await this.chain.receipt(signed.hash)
        if (receipt) {
          return receipt
        }
        const nonce = await this.chain.nonce()
        if (this.stopped || this.fatal || terminal(operation) || step.receipt) {
          return null
        }
        if (nonce > signed.nonce || operation.expiresAt <= Date.now()) {
          return {
            code:
              nonce > signed.nonce
                ? 'NONCE_CONFLICT'
                : 'EXPIRED_PENDING_TRANSACTION',
          }
        }
        // Повторяется только та же подпись с тем же nonce и хэшем.
        if (Date.now() - lastBroadcast >= Math.max(15000, this.pollMs)) {
          lastBroadcast = Date.now()
          try {
            this.journal.assertWritable()
            await this.chain.broadcast(signed.raw)
          } catch {
            /* Ответ RPC мог потеряться после приёма. */
          }
        }
        return null
      } catch {
        return { code: 'RPC_UNAVAILABLE' }
      }
    }
    while (!this.stopped && !this.fatal && !terminal(operation)) {
      if (step.receipt) {
        return step.receipt
      }
      const result = await poll()
      if (this.stopped || this.fatal || terminal(operation)) {
        return null
      }
      if (step.receipt) {
        return step.receipt
      }
      if (result && 'hash' in result) {
        return result
      }
      const status =
        result && result.code !== 'RPC_UNAVAILABLE'
          ? 'needs_attention'
          : 'waiting'
      if (
        operation.status !== status ||
        operation.error?.code !== result?.code ||
        step.status !== 'confirming'
      ) {
        operation.status = status
        operation.error = result ?? undefined
        step.status = 'confirming'
        this.publish(operation)
      }
      try {
        await delay(this.pollMs, undefined, { signal: this.abort.signal })
      } catch {
        return null
      }
    }
    return null
  }
  async resolve(id: string, transactionHash: string): Promise<OperationView> {
    if (this.chain.readOnly) {
      throw new AppError('READ_ONLY', 403)
    }
    this.journal.assertWritable()
    const operation = this.journal.get(id)
    ensure(operation && !terminal(operation), 'OPERATION_NOT_PENDING')
    const step = operation.steps.find(
      value => value.signed && !value.receipt && value.status !== 'confirmed',
    )
    ensure(step?.signed, 'TRANSACTION_NOT_PENDING')
    const result = await this.chain.replacement(transactionHash, step.signed)
    this.journal.assertWritable()
    ensure(!terminal(operation) && !step.receipt, 'OPERATION_ALREADY_RESOLVED')
    step.receipt = result.receipt
    if (!result.matches) {
      operation.status = 'failed'
      operation.error = { code: 'TRANSACTION_REPLACED' }
      step.status = 'failed'
      step.error = operation.error
      operation.gasSpentWei = (
        BigInt(operation.gasSpentWei) + BigInt(result.receipt.fee)
      ).toString()
    }
    this.publish(operation)
    return operationView(operation)
  }
}
