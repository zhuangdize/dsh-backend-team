import { ContextBudgetWindow, ContextManager, type ContextBudgetWindowOptions, type ContextBudgetWindowSnapshot, type ContextCheckpoint, type ContextCheckpointStore, type ContextManagerOptions, type ContextMessage, type ContextProjection } from './context-manager.js'
import { isPathWithin } from './path-overlap.js'
import type { ConsumedBudget } from '@dsh-backend-team/contracts'
import type { OwnershipManager } from './ownership-manager.js'

/** Host-owned cross-process run lock. The release function must be idempotent. */
export interface LongTaskRunLeasePort {
  acquire(): Promise<() => Promise<void>>
}

/**
 * Shares one host run lease across nested in-process sessions while retaining
 * the wrapped lease's cross-process exclusion. Each caller receives its own
 * idempotent release; the underlying lock is released after the last caller.
 */
export class SharedLongTaskRunLease implements LongTaskRunLeasePort {
  private state: { readonly release: () => Promise<void>; refs: number } | undefined
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly underlying: LongTaskRunLeasePort) {}

  async acquire(): Promise<() => Promise<void>> {
    return this.serial(async () => {
      if (this.state === undefined) this.state = { release: await this.underlying.acquire(), refs: 0 }
      this.state.refs += 1
      let released = false
      return async () => {
        if (released) return
        released = true
        await this.serial(async () => {
          const state = this.state
          if (state === undefined) return
          state.refs -= 1
          if (state.refs > 0) return
          this.state = undefined
          await state.release()
        })
      }
    })
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }
}

/**
 * The host must prove that the task already owns its declared workspace paths.
 * This keeps the context/checkpoint layer from becoming a second authorization
 * system and makes the ownership decision explicit at the LangGraph boundary.
 */
export interface LongTaskOwnershipPort {
  assert(taskId: string, readPaths: readonly string[], writePaths: readonly string[]): void
}

/** Durable task-level accounting supplied by the existing host ledger. */
export interface LongTaskBudgetLedgerPort {
  record(parentId: string, usage: ConsumedBudget): void
}

export interface LongTaskExecutionSessionOptions {
  readonly taskId: string
  readonly readPaths?: readonly string[]
  readonly writePaths?: readonly string[]
  readonly runLease: LongTaskRunLeasePort
  readonly ownership: LongTaskOwnershipPort
  readonly contextStore: ContextCheckpointStore
  readonly contextOptions: ContextManagerOptions
  readonly budget: ContextBudgetWindowOptions
  readonly budgetLedger?: LongTaskBudgetLedgerPort
}

export interface LongTaskToolResult {
  readonly executed: boolean
}

export interface LongTaskExecutionSnapshot {
  readonly context: ContextCheckpoint
  readonly budget: ContextBudgetWindowSnapshot
}

/**
 * Provider-neutral execution boundary for a resumable long task.
 *
 * The session deliberately does not import LangGraph. A LangGraph kernel (or
 * another graph runner) uses this seam for context preparation, tool
 * idempotency and budget accounting while the host keeps ownership and run
 * authorization authoritative.
 */
export class LongTaskExecutionSession {
  private readonly managerPromise: Promise<ContextManager>
  private readonly budgetWindow: ContextBudgetWindow
  private runRelease: (() => Promise<void>) | undefined
  private closed = false
  private closePromise: Promise<void> | undefined
  private lock: Promise<void> = Promise.resolve()

  private constructor(
    private readonly options: LongTaskExecutionSessionOptions,
    manager: ContextManager,
    runRelease: () => Promise<void>,
  ) {
    this.managerPromise = Promise.resolve(manager)
    this.runRelease = runRelease
    this.budgetWindow = new ContextBudgetWindow(options.budget)
  }

  /** Acquires the host run lease before loading any resumable state. */
  static async open(options: LongTaskExecutionSessionOptions): Promise<LongTaskExecutionSession> {
    assertTaskId(options.taskId)
    const readPaths = options.readPaths ?? []
    const writePaths = options.writePaths ?? []
    if (!Array.isArray(readPaths) || !Array.isArray(writePaths)) throw new Error('long task ownership paths are invalid')
    const release = await options.runLease.acquire()
    let released = false
    const releaseOnce = async (): Promise<void> => {
      if (released) return
      released = true
      await release()
    }
    try {
      options.ownership.assert(options.taskId, readPaths, writePaths)
      const manager = await ContextManager.open(options.taskId, options.contextStore, options.contextOptions)
      return new LongTaskExecutionSession(options, manager, releaseOnce)
    } catch (error: unknown) {
      await releaseOnce().catch(() => undefined)
      throw error
    }
  }

  async append(messages: readonly ContextMessage[]): Promise<void> {
    await this.withLock(async () => {
      const manager = await this.manager()
      manager.append(messages)
      await manager.saveCheckpoint()
    })
  }

  async prepareContext(): Promise<ContextProjection> {
    return this.withLock(async () => {
      const manager = await this.manager()
      const projection = await manager.prepare()
      await manager.saveCheckpoint()
      return projection
    })
  }

  /** Executes a side effect at most once after a successful checkpoint. */
  async runTool(idempotencyKey: string, effect: () => Promise<void>): Promise<LongTaskToolResult> {
    return this.withLock(async () => {
      const manager = await this.manager()
      if (!manager.shouldExecuteTool(idempotencyKey)) return { executed: false }
      try {
        await effect()
        manager.recordToolCall(idempotencyKey, 'completed')
        await manager.saveCheckpoint()
        return { executed: true }
      } catch (error: unknown) {
        manager.recordToolCall(idempotencyKey, 'failed')
        await manager.saveCheckpoint().catch(() => undefined)
        throw error
      }
    })
  }

  consumeModelTokens(tokens: number): void {
    this.assertOpen()
    this.budgetWindow.consumeModel(tokens)
    this.options.budgetLedger?.record(this.options.taskId, { tokens, wallMs: 0, toolCalls: 0, retries: 0, children: 0 })
  }

  consumeCompactionTokens(tokens: number): void {
    this.assertOpen()
    this.budgetWindow.consumeCompaction(tokens)
    this.options.budgetLedger?.record(this.options.taskId, { tokens, wallMs: 0, toolCalls: 0, retries: 0, children: 0 })
  }

  openNextContextWindow(): void {
    this.assertOpen()
    this.budgetWindow.openNextWindow()
  }

  async snapshot(): Promise<LongTaskExecutionSnapshot> {
    return this.withLock(async () => ({
      context: (await this.manager()).snapshot(),
      budget: this.budgetWindow.snapshot(),
    }))
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closePromise = this.withLock(async () => {
      if (this.closed) return
      await this.managerPromise.then(manager => manager.saveCheckpoint())
      this.closed = true
      const release = this.runRelease
      this.runRelease = undefined
      await release?.()
    })
    return this.closePromise
  }

  private async manager(): Promise<ContextManager> {
    this.assertOpen()
    return this.managerPromise
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const previous = this.lock
    let release!: () => void
    this.lock = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('long task execution session is closed')
  }
}

/** Adapts the existing OwnershipManager to the explicit host ownership port. */
export function ownershipPort(manager: OwnershipManager): LongTaskOwnershipPort {
  return {
    assert: (taskId, readPaths, writePaths) => {
      const leases = manager.snapshot().filter(lease => lease.taskId === taskId)
      for (const path of readPaths) {
        if (!leases.some(lease => lease.paths.some(scope => isPathWithin(path, scope)))) throw new Error(`read lease is missing for ${path}`)
      }
      for (const path of writePaths) {
        if (!leases.some(lease => lease.mode === 'write' && lease.paths.some(scope => isPathWithin(path, scope)))) throw new Error(`write lease is missing for ${path}`)
      }
    },
  }
}

function assertTaskId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new Error('long task ID is invalid')
}
