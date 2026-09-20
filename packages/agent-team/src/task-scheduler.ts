import { AgentResultSchema, AgentTaskSchema } from '@dsh-backend-team/contracts'
import type { AgentDelegation, AgentHandle, AgentTask, BackendTeamOrchestrationPort, JsonObject } from '@dsh-backend-team/contracts'
import { BudgetLedger, type BudgetReservation, type BudgetSnapshot } from './budget-ledger.js'
import { DurableBudgetLedger } from './durable-budget-ledger.js'
import { TaskQueue, type TaskPriority } from './task-queue.js'
import { isSafeWorkspacePath } from './capability-intersection.js'

export type TaskSchedulerOptions =
  | { readonly orchestration: Pick<BackendTeamOrchestrationPort, 'spawnAgent'>; readonly ledger: BudgetLedger; readonly workspaceRoot?: never }
  | { readonly orchestration: Pick<BackendTeamOrchestrationPort, 'spawnAgent'>; readonly workspaceRoot: string; readonly ledger?: never }
export interface TaskSchedulerSnapshot { readonly activeExperts: number; readonly activeWriters: number; readonly queued: number; readonly blocked: readonly string[] }
export class TaskSchedulerDisposedError extends Error {
  constructor() { super('task scheduler is disposed'); this.name = 'TaskSchedulerDisposedError' }
}
interface Scheduled { readonly task: AgentTask; readonly context: JsonObject; readonly delegation?: AgentDelegation; readonly overlapToken?: object; readonly resolve: (value: unknown) => void; readonly reject: (reason: unknown) => void; settled: boolean }
interface Active { readonly task: AgentTask; handle: AgentHandle; reservation?: BudgetReservation; readonly writer: boolean; completion: Promise<void>; spawned: boolean; released: boolean; readonly scheduled: Scheduled; readonly controller: AbortController }

function overlaps(left: string, right: string): boolean { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`) }

/** Bounded application scheduler; a workspaceRoot selects durable application-owned budgeting. */
export class TaskScheduler {
  private readonly expertQueue = new TaskQueue<Scheduled>()
  private readonly writerQueue = new TaskQueue<Scheduled>()
  private readonly readQueue = new TaskQueue<Scheduled>()
  private readonly active = new Map<string, Active>()
  private readonly writerPaths = new Map<string, readonly string[]>()
  private readonly blocked = new Set<string>()
  private readonly cancelRequested = new Set<string>()
  private readonly ledger: BudgetLedger
  private disposed = false
  private disposePromise: Promise<void> | undefined
  private activeExperts = 0
  private activeWriters = 0
  constructor(private readonly options: TaskSchedulerOptions) {
    this.ledger = options.ledger ?? new DurableBudgetLedger(options.workspaceRoot)
  }

  submit(input: unknown, priority: TaskPriority = 'normal', context?: JsonObject, delegation?: AgentDelegation, overlapToken?: object): Promise<unknown> {
    if (this.disposed) return Promise.reject(new TaskSchedulerDisposedError())
    const parsed = AgentTaskSchema.safeParse(input)
    if (!parsed.success) return Promise.reject(new Error('invalid task'))
    const task = parsed.data
    if (task.depth === 0) return Promise.reject(new Error('coordinator task cannot be scheduled'))
    if (this.active.has(task.id) || this.hasQueued(task.id)) return Promise.reject(new Error('task ID is already scheduled'))
    if (task.readPaths.some((path) => !isSafeWorkspacePath(path)) || task.writePaths.some((path) => !isSafeWorkspacePath(path))) return Promise.reject(new Error('invalid task path'))
    return new Promise((resolve, reject) => {
      const scheduled: Scheduled = { task, context: context ?? { taskId: task.id }, ...(delegation === undefined ? {} : { delegation }), ...(overlapToken === undefined ? {} : { overlapToken }), resolve, reject, settled: false }
      this.queueFor(task).enqueue(scheduled, priority)
      this.drain()
    })
  }

  async cancel(taskId: string): Promise<void> {
    const queued = this.removeQueued(taskId)
    if (queued !== undefined) { queued.settled = true; queued.resolve(undefined); this.drain(); return }
    const active = this.active.get(taskId)
    if (active === undefined) throw new Error('unknown task')
    this.cancelRequested.add(taskId)
    active.controller.abort()
    await active.handle.cancel()
    await active.completion
  }

  snapshot(): TaskSchedulerSnapshot { return { activeExperts: this.activeExperts, activeWriters: this.activeWriters, queued: this.expertQueue.size + this.writerQueue.size + this.readQueue.size, blocked: [...this.blocked].sort() } }

  /** Stop accepting work, reject queued tasks, and cancel every active Agent. */
  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposed = true
    this.disposePromise = this.disposeActiveWork()
    return this.disposePromise
  }

  budgetSnapshot(taskId: string): BudgetSnapshot { return this.ledger.snapshot(taskId) }

  private drain(): void {
    if (this.disposed) return
    for (;;) {
      const scheduled = this.takeNext()
      if (scheduled === undefined) return
      try { this.start(scheduled) } catch (error) {
        if (error instanceof Error && /budget exhausted/i.test(error.message)) this.blocked.add(scheduled.task.id)
        scheduled.settled = true
        scheduled.reject(error)
      }
    }
  }

  private async disposeActiveWork(): Promise<void> {
    const disposed = new TaskSchedulerDisposedError()
    for (const queue of [this.expertQueue, this.writerQueue, this.readQueue]) {
      for (;;) {
        const scheduled = queue.takeHead(() => true)
        if (scheduled === undefined) break
        if (!scheduled.settled) {
          scheduled.settled = true
          scheduled.reject(disposed)
        }
      }
    }

    const failures: unknown[] = []
    for (const taskId of [...this.active.keys()]) {
      if (!this.active.has(taskId)) continue
      try {
        await this.cancel(taskId)
      } catch (error: unknown) {
        const active = this.active.get(taskId)
        if (active === undefined) continue
        failures.push(error)
        await active.completion.catch(() => undefined)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'task scheduler disposal failed')
  }

  private canStart(scheduled: Scheduled): boolean {
    const { task } = scheduled
    if (task.depth === 1 && this.activeExperts >= 3) return false
    if (task.writePaths.length > 0 && this.activeWriters >= 2) return false
    return ![...this.writerPaths.entries()].some(([ownerTaskId, paths]) => {
      // A coordinator-authorized depth-two worker may run inside its direct
      // parent's scope. DelegationGuard and OwnershipManager prove that
      // relationship; unrelated writers still serialize normally. Direct
      // scheduler callers cannot bypass this without the opaque token.
      if (task.depth === 2 && ownerTaskId === task.parentTaskId && scheduled.overlapToken !== undefined && this.active.get(ownerTaskId)?.scheduled.overlapToken === scheduled.overlapToken) return false
      return task.writePaths.some((path) => paths.some((held) => overlaps(path, held)))
    })
  }

  private start(scheduled: Scheduled): void {
    const { task } = scheduled
    let reservation: BudgetReservation | undefined
    const writer = task.writePaths.length > 0
    if (task.depth === 2) reservation = this.ledger.reserve(task.parentTaskId ?? '', task.id, task.budget)
    else this.ledger.register(task.id, task.budget)
    if (task.depth === 1) this.activeExperts += 1
    if (writer) this.activeWriters += 1
    if (writer) this.writerPaths.set(task.id, task.writePaths)
    const active: Active = { task, handle: { id: task.id, result: async () => undefined, cancel: async () => {} }, writer, completion: Promise.resolve(), spawned: false, released: false, scheduled, controller: new AbortController() }
    if (reservation !== undefined) active.reservation = reservation
    this.active.set(task.id, active)
    active.completion = this.run(active)
  }

  private async run(active: Active): Promise<void> {
    const { task, scheduled, reservation } = active
    let handle: AgentHandle | undefined
    let budgetTimedOut = false
    let timeoutCancellation: Promise<void> | undefined
    let timeoutReject: ((error: Error) => void) | undefined
    const timeout = new Promise<never>((_, reject) => { timeoutReject = reject })
    const timer = setTimeout(() => {
      budgetTimedOut = true
      active.controller.abort(new Error('agent wall-clock budget exhausted'))
      timeoutCancellation = Promise.resolve().then(() => handle?.cancel()).then(() => undefined, () => undefined)
      timeoutReject?.(new Error('agent wall-clock budget exhausted'))
    }, task.budget.maxWallMs)
    try {
      handle = await Promise.race([
        this.options.orchestration.spawnAgent({ task: task.objective, role: task.role, context: scheduled.context, agentTask: task, ...(scheduled.delegation === undefined ? {} : { delegation: scheduled.delegation }) }, active.controller.signal),
        timeout,
      ])
      active.handle = handle
      active.spawned = true
      if (this.cancelRequested.has(task.id)) await handle.cancel()
      let result: unknown
      try {
        result = await Promise.race([handle.result(), timeout])
        if (budgetTimedOut) throw new Error('agent wall-clock budget exhausted')
      } finally {
        clearTimeout(timer)
      }
      // Cancellation is a control operation, not a successful task result.
      // Some Agent implementations resolve their result promise as part of
      // cancel(); keep the scheduler contract consistent with queued cancel
      // and settle those runs without exposing a misleading result payload.
      if (this.cancelRequested.has(task.id)) {
        if (!scheduled.settled) { scheduled.settled = true; scheduled.resolve(undefined) }
        return
      }
      const parsedResult = AgentResultSchema.safeParse(result)
      if (!parsedResult.success) throw new Error('invalid agent result')
      if (parsedResult.data.taskId !== task.id) throw new Error('agent result task ID does not match scheduled task')
      const usage = parsedResult.data.consumedBudget
      if (reservation !== undefined) this.ledger.consume(reservation, usage)
      else {
        // Child budgets are charged when their reservations are consumed. The
        // parent result repeats the child count for the handoff contract, so
        // do not charge that count a second time in the parent's ledger entry.
        // Token, wall-clock, tool-call and retry usage still comes from the
        // host-observed result unchanged.
        this.ledger.record(task.id, { ...usage, children: 0 })
      }
      if (!scheduled.settled) { scheduled.settled = true; scheduled.resolve(result) }
    } catch (error) {
      const wallClockTimedOut = budgetTimedOut || isWallClockBudgetError(error)
      if (error instanceof Error && /budget exhausted/i.test(error.message)) this.blocked.add(task.id)
      let failure = error
      if (wallClockTimedOut) {
        if (timeoutCancellation !== undefined) await timeoutCancellation
        else if (handle !== undefined && !this.cancelRequested.has(task.id)) await handle.cancel().catch(() => undefined)
        const timeoutUsage = { tokens: 0, wallMs: task.budget.maxWallMs, toolCalls: 0, retries: 0, children: 0 }
        try {
          if (reservation !== undefined) {
            this.ledger.consume(reservation, timeoutUsage)
            if (this.ledger.snapshot(reservation.parentId).remaining.maxWallMs === 0) this.ledger.markExhausted(reservation.parentId, timeoutUsage, ['wallMs'])
          } else {
            this.ledger.record(task.id, timeoutUsage)
            this.ledger.markExhausted(task.id, timeoutUsage, ['wallMs'])
          }
        } catch (accountingError: unknown) {
          failure = new Error(`${error instanceof Error ? error.message : String(error)}; budget accounting failed: ${accountingError instanceof Error ? accountingError.message : String(accountingError)}`, { cause: accountingError })
        }
      }
      else if (handle !== undefined && !this.cancelRequested.has(task.id)) await handle.cancel().catch(() => undefined)
      if (!scheduled.settled) {
        scheduled.settled = true
        if (this.cancelRequested.has(task.id)) scheduled.resolve(undefined)
        else scheduled.reject(failure)
      }
    } finally {
      clearTimeout(timer)
      this.release(active)
      this.cancelRequested.delete(task.id)
      this.drain()
    }
  }

  private queueFor(task: AgentTask): TaskQueue<Scheduled> { return task.depth === 1 ? this.expertQueue : task.writePaths.length > 0 ? this.writerQueue : this.readQueue }
  private hasQueued(taskId: string): boolean { return [this.expertQueue, this.writerQueue, this.readQueue].some((queue) => queue.has((entry) => entry.task.id === taskId)) }
  private removeQueued(taskId: string): Scheduled | undefined { for (const queue of [this.expertQueue, this.writerQueue, this.readQueue]) { const entry = queue.remove((item) => item.task.id === taskId); if (entry !== undefined) return entry } return undefined }
  private takeNext(): Scheduled | undefined {
    for (const priority of ['blocking', 'normal'] as const) {
      for (const queue of [this.expertQueue, this.writerQueue, this.readQueue]) {
        if (queue.peekPriority() !== priority) continue
        const head = queue.peek()
        if (head !== undefined && this.canStart(head)) return queue.takeHead(() => true)
      }
    }
    return undefined
  }
  private release(active: Active): void {
    if (active.released) return
    active.released = true
    if (active.reservation !== undefined) this.ledger.release(active.reservation)
    this.active.delete(active.task.id)
    if (active.task.depth === 1) this.activeExperts -= 1
    if (active.writer) { this.activeWriters -= 1; this.writerPaths.delete(active.task.id) }
  }
}

function isWallClockBudgetError(error: unknown): boolean {
  return error instanceof Error && /(?:wall[- ]clock|wall[- ]time).*budget.*exhausted|managed Agent wall-time budget exhausted/iu.test(error.message)
}
