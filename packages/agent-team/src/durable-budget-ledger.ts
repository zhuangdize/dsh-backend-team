import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { AgentBudget, ConsumedBudget } from '@dsh-backend-team/contracts'
import { BudgetLedger, recoverBudgetLedgerState, type BudgetLedgerState, type BudgetReservation } from './budget-ledger.js'
import { ownershipLockDirectory, withOwnershipMutex } from './path-overlap.js'

export interface BudgetLedgerStorage {
  load(): unknown | null
  save(state: BudgetLedgerState): void
  withExclusiveLock<T>(operation: () => T): T
}

export interface DurableBudgetLedgerOptions {
  readonly storage?: BudgetLedgerStorage
}

/** Synchronous, workspace-local persistence for parent/child budget reservations. */
export class WorkspaceBudgetLedgerStorage implements BudgetLedgerStorage {
  readonly workspaceRoot: string
  private readonly directory: string
  private readonly statePath: string
  private readonly lockDirectory: string

  constructor(workspaceRoot: string) {
    if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) throw new Error('workspace root is required')
    this.workspaceRoot = realpathSync(workspaceRoot)
    this.directory = join(this.workspaceRoot, '.backend-team', 'state')
    this.statePath = join(this.directory, 'budget-ledger.json')
    this.lockDirectory = ownershipLockDirectory(this.workspaceRoot)
  }

  withExclusiveLock<T>(operation: () => T): T { return withOwnershipMutex(this.lockDirectory, operation) }

  load(): unknown | null {
    if (!this.ensureDirectory(false)) return null
    let descriptor: number
    try {
      descriptor = openSync(this.statePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const metadata = fstatSync(descriptor)
      if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) throw new Error('budget ledger file is unsafe')
      return JSON.parse(readFileSync(descriptor, 'utf8'))
    } finally {
      closeSync(descriptor)
    }
  }

  save(state: BudgetLedgerState): void {
    this.ensureDirectory(true)
    this.assertSafeOutput()
    const temporary = join(this.directory, `.budget-ledger-${process.pid}-${randomBytes(12).toString('hex')}.tmp`)
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(descriptor, JSON.stringify(state))
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    try {
      this.assertSafeOutput()
      renameSync(temporary, this.statePath)
      syncDirectory(this.directory)
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* preserve the primary failure */ }
      throw error
    }
  }

  private ensureDirectory(create: boolean): boolean {
    let current = this.workspaceRoot
    for (const segment of ['.backend-team', 'state']) {
      current = join(current, segment)
      try {
        const metadata = lstatSync(current)
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('budget ledger directory is unsafe')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (!create) return false
        mkdirSync(current, { mode: 0o700 })
      }
      const metadata = lstatSync(current)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('budget ledger directory is unsafe')
      chmodSync(current, 0o700)
      if ((lstatSync(current).mode & 0o777) !== 0o700) throw new Error('budget ledger directory permissions are unsafe')
      if (realpathSync(current) !== current) throw new Error('budget ledger directory is not canonical')
    }
    return true
  }

  private assertSafeOutput(): void {
    try {
      const metadata = lstatSync(this.statePath)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) throw new Error('budget ledger file is unsafe')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/** Keeps the synchronous BudgetLedger API while making every state transition durable. */
export class DurableBudgetLedger extends BudgetLedger {
  private readonly storage: BudgetLedgerStorage
  private unavailable: Error | undefined

  constructor(workspaceRoot: string, options: DurableBudgetLedgerOptions = {}) {
    super()
    this.storage = options.storage ?? new WorkspaceBudgetLedgerStorage(workspaceRoot)
    try {
      this.storage.withExclusiveLock(() => this.recoverInitialState())
    } catch (error) {
      throw new Error('budget ledger recovery failed: malformed or conflicting records', { cause: error })
    }
  }

  override register(parentId: string, budget: AgentBudget): void {
    this.mutate(() => super.register(parentId, budget))
  }

  override reserve(parentId: string, childId: string, budget: AgentBudget): BudgetReservation {
    return this.mutate(() => super.reserve(parentId, childId, budget))
  }

  override consume(reservation: BudgetReservation, usage: ConsumedBudget): void {
    this.mutate(() => super.consume(reservation, usage))
  }

  override record(parentId: string, usage: ConsumedBudget): void {
    this.mutate(() => super.record(parentId, usage))
  }

  override markExhausted(parentId: string, usage: ConsumedBudget, exceeded: readonly ('tokens' | 'wallMs' | 'toolCalls' | 'retries' | 'children')[]): void {
    this.mutate(() => super.markExhausted(parentId, usage, exceeded))
  }

  override release(reservation: BudgetReservation): void {
    this.mutate(() => super.release(reservation))
  }

  private mutate<T>(operation: () => T): T {
    if (this.unavailable !== undefined) throw new Error('budget ledger persistence is unavailable', { cause: this.unavailable })
    return this.storage.withExclusiveLock(() => this.mutateLocked(operation))
  }

  private mutateLocked<T>(operation: () => T): T {
    try {
      const recovered = this.storage.load()
      if (recovered === null) {
        if (this.exportState().records.length > 0) throw new Error('budget ledger persistence disappeared')
      } else {
        const recovery = recoverBudgetLedgerState(recovered)
        this.replaceState(recovery.state)
        if (recovery.migratedFromV1) this.storage.save(this.exportState())
      }
    } catch (error) {
      this.unavailable = error instanceof Error ? error : new Error('budget ledger recovery failed')
      throw new Error('budget ledger persistence is unavailable', { cause: error })
    }
    const before = JSON.stringify(this.exportState())
    let result: T | undefined
    let failure: unknown
    try {
      result = operation()
    } catch (error) {
      failure = error
    }
    if (before !== JSON.stringify(this.exportState())) {
      try {
        this.storage.save(this.exportState())
      } catch (error) {
        this.unavailable = error instanceof Error ? error : new Error('budget ledger persistence failed')
        throw new Error('budget ledger persistence failed', { cause: error })
      }
    }
    if (failure !== undefined) throw failure
    return result as T
  }

  private recoverInitialState(): void {
    const recovered = this.storage.load()
    if (recovered === null) return
    const recovery = recoverBudgetLedgerState(recovered)
    this.restoreState(recovery.state)
    if (recovery.migratedFromV1) this.storage.save(this.exportState())
  }
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}
