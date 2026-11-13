import { AppError, publicError } from '../shared/index.js'
import type {
  StateView,
  StateStatus,
  StateSource,
  StateSnapshot,
} from './types.js'

export class PublicState {
  private snapshot?: StateSnapshot
  private required: number | null = null
  private available = false
  private checkedAt: number | null = null
  private lastError: StateStatus['lastError'] = null
  private pending?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private stopped = false

  constructor(private readonly remote: StateSource) {}

  get status(): StateStatus {
    return {
      available: this.available,
      snapshotBlock: this.snapshot?.block.number ?? null,
      requiredBlock: this.required,
      refreshPending: this.behind,
      lastCheckedAt: this.checkedAt,
      lastError: this.lastError && { ...this.lastError },
    }
  }

  private get behind(): boolean {
    return (
      this.required !== null &&
      (this.snapshot === undefined ||
        this.snapshot.block.number < this.required)
    )
  }

  // Receipts from RPC establish the minimum acceptable snapshot block.
  // A 202 from /refresh may join an older sync, so the target is checked again.
  requireBlock(block: number): void {
    if (
      !Number.isSafeInteger(block) ||
      block < 0 ||
      block <= (this.required ?? -1)
    ) {
      return
    }
    this.required = block
    if (!this.stopped) {
      void this.sync()
    }
  }

  start(intervalMs: number): void {
    if (this.timer) {
      return
    }
    this.stopped = false
    this.timer = setInterval(() => void this.sync(), intervalMs)
    this.timer.unref()
    void this.sync()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = undefined
    await this.pending
  }

  sync(): Promise<void> {
    this.pending ??= this.update().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private async update(): Promise<void> {
    try {
      const snapshot = await this.remote.state()
      this.snapshot = structuredClone(snapshot)
      this.available = true
      this.lastError = null
      if (this.behind && !this.stopped) {
        try {
          await this.remote.refresh()
        } catch (error) {
          // Public reads can remain available when the owner key is missing.
          this.lastError = publicError(error)
        }
      }
    } catch (error) {
      this.available = false
      this.lastError = publicError(error)
    } finally {
      this.checkedAt = Date.now()
    }
  }

  async read(): Promise<StateView> {
    await this.sync()
    if (!this.snapshot) {
      throw new AppError(
        this.lastError?.code ?? 'PUBLIC_SERVER_UNAVAILABLE',
        503,
      )
    }
    return {
      source: 'public-server',
      cached: !this.available,
      ageSeconds: Math.max(
        0,
        Math.floor(Date.now() / 1000) - this.snapshot.block.timestamp,
      ),
      behindConfirmedTransactions: this.behind,
      snapshot: structuredClone(this.snapshot),
    }
  }

  async refresh(): Promise<StateStatus> {
    await this.remote.refresh()
    void this.sync()
    return this.status
  }
}
