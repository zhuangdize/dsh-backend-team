import { sha256Canonical } from '@dsh-backend-team/core'
import type { HandoffStore } from '@dsh-backend-team/agent-team'
import type { DevelopmentPlan } from './vertical-slice.js'
import { SliceExecutor, type PatchTrackerPort, type SliceExecutionResult, type TeamCoordinatorPort } from './slice-executor.js'
import { FailureClassifier } from './failure-classifier.js'
import { RetryPolicy } from './retry-policy.js'
import { ownsSliceTask } from './slice-task-id.js'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface DesignApprovalPort {
  verifyActiveApproval(kind: 'design'): Promise<void>
}

export interface DevelopmentCoordinatorOptions {
  /** Production workspace used to validate materialized files during restart recovery. */
  readonly workspaceRoot?: string
  /** Must resolve only after durable persistence; failure stops further dispatch. */
  readonly saveCheckpoint?: (checkpoint: DevelopmentCheckpoint) => Promise<void>
  /** Re-read accepted records from the workspace-owned durable store before skipping work. */
  readonly handoffStore?: Pick<HandoffStore, 'read'>
  readonly approvals: DesignApprovalPort
  readonly patchTracker: PatchTrackerPort
  readonly teamCoordinator: TeamCoordinatorPort
  readonly sliceExecutor?: Pick<SliceExecutor, 'execute'>
  readonly failureClassifier?: FailureClassifier
  readonly retryPolicy?: RetryPolicy
}

export interface DevelopmentRunResult {
  readonly checkpoint: DevelopmentCheckpoint
  readonly status: 'passed' | 'failed' | 'blocked' | 'paused'
  readonly slices: readonly SliceExecutionResult[]
}

export interface DevelopmentCheckpoint {
  readonly planHash: string
  readonly slices: readonly SliceExecutionResult[]
}

/** Coordinates approved slices and keeps approval/dependency gates ahead of writes. */
export class DevelopmentCoordinator {
  private readonly sliceExecutor: Pick<SliceExecutor, 'execute'>
  private activeRun: Promise<DevelopmentRunResult> | undefined
  private pauseRequested = false

  constructor(private readonly options: DevelopmentCoordinatorOptions) {
    this.sliceExecutor = options.sliceExecutor ?? new SliceExecutor({
      teamCoordinator: options.teamCoordinator,
      patchTracker: options.patchTracker,
      ...(options.failureClassifier === undefined ? {} : { failureClassifier: options.failureClassifier }),
      ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    })
  }

  async execute(plan: DevelopmentPlan): Promise<DevelopmentRunResult> {
    const exactPlan = structuredClone(plan)
    return this.runExclusive(() => this.executeFrom(exactPlan, []))
  }

  /** Finishes the current slice and durable checkpoint, then prevents the next dispatch. */
  async pause(): Promise<DevelopmentRunResult> {
    if (this.activeRun === undefined) throw new Error('development is not running')
    if (this.options.saveCheckpoint === undefined) throw new Error('pause requires durable checkpoint persistence')
    this.pauseRequested = true
    return this.activeRun
  }

  private async runExclusive(operation: () => Promise<DevelopmentRunResult>): Promise<DevelopmentRunResult> {
    if (this.activeRun !== undefined) throw new Error('development is already running')
    this.pauseRequested = false
    const running = Promise.resolve().then(operation)
    this.activeRun = running
    try { return await running } finally { this.activeRun = undefined; this.pauseRequested = false }
  }

  /** Resumes after an interruption; only accepted/passed slices are skipped. */
  async resume(plan: DevelopmentPlan, checkpoint: DevelopmentCheckpoint): Promise<DevelopmentRunResult> {
    const exactPlan = structuredClone(plan)
    const exactCheckpoint = structuredClone(checkpoint)
    return this.runExclusive(() => this.resumeFrom(exactPlan, exactCheckpoint))
  }

  private async resumeFrom(exactPlan: DevelopmentPlan, exactCheckpoint: DevelopmentCheckpoint): Promise<DevelopmentRunResult> {
    validatePlan(exactPlan)
    if (exactCheckpoint.planHash !== developmentPlanHash(exactPlan)) throw new Error('checkpoint plan has changed')
    const known = new Set(exactPlan.slices.map(slice => slice.id))
    const seen = new Set<string>()
    for (const result of exactCheckpoint.slices) {
      if (!known.has(result.sliceId) || seen.has(result.sliceId)) throw new Error('checkpoint contains unknown or duplicate slices')
      seen.add(result.sliceId)
    }
    const accepted = exactCheckpoint.slices.filter(slice => slice.status === 'passed')
    const completed = new Set(accepted.map(slice => slice.sliceId))
    for (const result of accepted) {
      const slice = exactPlan.slices.find(slice => slice.id === result.sliceId)!
      if (slice.dependencies.some(id => !completed.has(id))) throw new Error('checkpoint dependencies are incomplete')
      this.verifyCheckpointResult(result, exactPlan, exactCheckpoint.planHash)
    }
    return this.executeFrom(exactPlan, accepted)
  }

  private async executeFrom(plan: DevelopmentPlan, accepted: readonly SliceExecutionResult[]): Promise<DevelopmentRunResult> {
    validatePlan(plan)
    await this.requireFreshDesignApproval()
    const completed = new Set(accepted.map(slice => slice.sliceId))
    const results: SliceExecutionResult[] = [...accepted]
    await this.persistCheckpoint(plan, results)
    for (const slice of plan.slices) {
      if (completed.has(slice.id)) continue
      if (this.pauseRequested) return runResult(plan, 'paused', results)
      await this.requireFreshDesignApproval()
      if (this.pauseRequested) return runResult(plan, 'paused', results)
      const missing = slice.dependencies.filter((dependency) => !completed.has(dependency))
      if (missing.length > 0) throw new Error(`slice ${slice.id} has incomplete dependencies: ${missing.join(', ')}`)
      const result = await this.sliceExecutor.execute(slice, plan)
      results.push(result)
      await this.persistCheckpoint(plan, results)
      if (result.status !== 'passed') return runResult(plan, result.status, results)
      completed.add(slice.id)
    }
    return runResult(plan, 'passed', results)
  }

  private async persistCheckpoint(plan: DevelopmentPlan, results: readonly SliceExecutionResult[]): Promise<void> {
    await this.options.saveCheckpoint?.(runResult(plan, 'paused', results).checkpoint)
  }

  private verifyCheckpointResult(result: SliceExecutionResult, plan: DevelopmentPlan, planHash: string): void {
    if (this.options.handoffStore === undefined || result.handoffs.length === 0) throw new Error('checkpoint requires durable handoff verification')
    for (const reference of result.handoffs) {
      const persisted = this.options.handoffStore.read(reference.id)
      if (sha256Canonical(persisted) !== sha256Canonical(reference)) throw new Error('checkpoint handoff differs from durable verification')
    }
    const accepted = result.handoffs.filter(handoff => handoff.status === 'completed' && handoff.parentVerification.status === 'accepted' && handoff.acknowledgedBy !== undefined && handoff.acknowledgedAt !== undefined)
    const ownsTask = (taskId: string, role: string) => ownsSliceTask(taskId, role, planHash, result.sliceId)
    const final = result.handoffs.at(-1)
    const hasDeveloper = accepted.some(handoff => ownsTask(handoff.taskId, 'developer'))
    const materializedDeveloperFiles = !hasDeveloper && this.options.workspaceRoot !== undefined && plan.tasks
      .filter(task => task.sliceId === result.sliceId && task.owner === 'developer')
      .every(task => task.files.every(path => materialized(join(this.options.workspaceRoot!, path))))
    if ((!hasDeveloper && !materializedDeveloperFiles) || final === undefined || !accepted.includes(final) || !ownsTask(final.taskId, 'tester')) throw new Error('checkpoint lacks accepted developer and final tester evidence')
  }

  private async requireFreshDesignApproval(): Promise<void> {
    try {
      await this.options.approvals.verifyActiveApproval('design')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (/stale/u.test(message)) throw new Error('design approval is stale', { cause: error })
      if (/missing/u.test(message)) throw new Error('design approval is missing', { cause: error })
      throw error
    }
  }
}

function materialized(path: string): boolean {
  try { return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0 } catch { return false }
}

/** Includes task content, dependencies, expected paths and approved artifact hashes. */
export function developmentPlanHash(plan: DevelopmentPlan): string { return sha256Canonical(plan) }

function validatePlan(plan: DevelopmentPlan): void {
  const seen = new Set<string>()
  for (const slice of plan.slices) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/u.test(slice.id)) throw new Error('development slice ID is invalid or too long')
    if (seen.has(slice.id)) throw new Error('development plan contains duplicate slice IDs')
    if (slice.dependencies.some(id => !seen.has(id))) throw new Error('development plan dependencies must precede their dependent slice')
    seen.add(slice.id)
  }
}

function runResult(plan: DevelopmentPlan, status: DevelopmentRunResult['status'], results: readonly SliceExecutionResult[]): DevelopmentRunResult {
  const ordered = plan.slices.flatMap(slice => results.filter(result => result.sliceId === slice.id))
  const slices = Object.freeze(structuredClone(ordered))
  return { status, slices, checkpoint: { planHash: developmentPlanHash(plan), slices } }
}
