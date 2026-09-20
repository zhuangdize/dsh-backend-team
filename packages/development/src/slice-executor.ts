import { sha256Canonical } from '@dsh-backend-team/core'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentBudget, AgentRole, ArtifactReference, AgentTask } from '@dsh-backend-team/contracts'
import type { DurableHandoff } from '@dsh-backend-team/agent-team'
import type { DevelopmentPlan, VerticalSlice } from './vertical-slice.js'
import { FailureClassifier, type ClassifiedFailure } from './failure-classifier.js'
import { RetryPolicy, type RetryAction } from './retry-policy.js'
import { sliceTaskId } from './slice-task-id.js'

export interface ExpertDispatchRequest {
  readonly id: string
  readonly role: Extract<AgentRole, 'developer' | 'tester' | 'fixer'>
  readonly objective: string
  readonly nonGoals: readonly string[]
  readonly inputArtifacts: readonly ArtifactReference[]
  readonly readPaths: readonly string[]
  readonly writePaths: readonly string[]
  readonly capabilities: AgentTask['capabilities']
  readonly budget: AgentBudget
  readonly doneWhen: readonly string[]
  readonly verification: AgentTask['verification']
  readonly returnSchema: string
}

export interface TeamCoordinatorPort {
  dispatchExpert(input: ExpertDispatchRequest): Promise<DurableHandoff>
}

export interface PatchTrackerPort {
  begin(paths: readonly string[]): Promise<unknown>
}

export interface SliceExecutorOptions {
  readonly teamCoordinator: TeamCoordinatorPort
  readonly patchTracker: PatchTrackerPort
  readonly failureClassifier?: FailureClassifier
  readonly retryPolicy?: RetryPolicy
  readonly budget?: AgentBudget
  readonly sleep?: (milliseconds: number) => Promise<void>
  /** Production workspace used to avoid re-dispatching already materialized tasks after restart. */
  readonly workspaceRoot?: string
}

export interface SliceExecutionResult {
  readonly sliceId: string
  readonly status: 'passed' | 'failed' | 'blocked'
  readonly attempts: number
  readonly handoffs: readonly DurableHandoff[]
  readonly failure?: ClassifiedFailure
}

/** Runs one vertical slice through developer, tester, and bounded repair handoffs. */
export class SliceExecutor {
  private readonly classifier: FailureClassifier
  private readonly retryPolicy: RetryPolicy
  private readonly sleep: (milliseconds: number) => Promise<void>

  constructor(private readonly options: SliceExecutorOptions) {
    this.classifier = options.failureClassifier ?? new FailureClassifier()
    this.retryPolicy = options.retryPolicy ?? new RetryPolicy()
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  async execute(slice: VerticalSlice, plan: DevelopmentPlan): Promise<SliceExecutionResult> {
    const planHash = sha256Canonical(plan)
    if (slice.expectedPaths.length === 0) throw new Error(`slice ${slice.id} has no owned paths`)
    await this.options.patchTracker.begin(slice.expectedPaths)
    const handoffs: DurableHandoff[] = []
    let attempt = 0
    while (true) {
      const developerAttempt = await this.tryDispatchDevelopers(slice, plan, planHash, attempt)
      if (!developerAttempt.ok) {
        handoffs.push(...developerAttempt.handoffs)
        const outcome = await this.handleClassifiedFailure(developerAttempt.failure, attempt)
        if (outcome.action === 'retry') { attempt = outcome.attempt; continue }
        if (outcome.action === 'repair') {
          const fixerAttempt = await this.tryDispatch('fixer', sliceTaskId('fixer', planHash, slice.id, outcome.attempt), slice, plan, `Repair ${slice.id} after developer dispatch failure.`)
          if (!fixerAttempt.ok) return failed(slice.id, outcome.attempt, handoffs, fixerAttempt.failure)
          handoffs.push(fixerAttempt.handoff)
          attempt = outcome.attempt
          continue
        }
        return failed(slice.id, attempt, handoffs, outcome.failure)
      }
      handoffs.push(...developerAttempt.handoffs)
      const developerFailure = developerAttempt.handoffs.find(handoff => !isAccepted(handoff))
      if (developerFailure !== undefined) {
        const outcome = await this.handleFailure(developerFailure, attempt, handoffs)
        if (outcome.action === 'retry') { attempt = outcome.attempt; continue }
        if (outcome.action === 'repair') {
          const fixer = await this.dispatch('fixer', sliceTaskId('fixer', planHash, slice.id, outcome.attempt), slice, plan, `Repair ${slice.id} using the failed developer handoff as evidence.`)
          handoffs.push(fixer)
          if (!isAccepted(fixer)) return failed(slice.id, outcome.attempt, handoffs, this.classifier.classify(fixer.summary))
          attempt = outcome.attempt
          continue
        }
        return failed(slice.id, attempt, handoffs, outcome.failure)
      }

      const testerAttempt = await this.tryDispatch('tester', sliceTaskId('tester', planHash, slice.id, attempt), slice, plan, `Verify the acceptance evidence for vertical slice ${slice.id}.`)
      if (!testerAttempt.ok) {
        const outcome = await this.handleClassifiedFailure(testerAttempt.failure, attempt)
        if (outcome.action === 'retry') { attempt = outcome.attempt; continue }
        if (outcome.action === 'repair') {
          const fixerAttempt = await this.tryDispatch('fixer', sliceTaskId('fixer', planHash, slice.id, outcome.attempt), slice, plan, `Repair ${slice.id} from tester dispatch evidence.`)
          if (!fixerAttempt.ok) return failed(slice.id, outcome.attempt, handoffs, fixerAttempt.failure)
          handoffs.push(fixerAttempt.handoff)
          attempt = outcome.attempt
          continue
        }
        return failed(slice.id, attempt, handoffs, outcome.failure)
      }
      const tester = testerAttempt.handoff
      handoffs.push(tester)
      if (isAccepted(tester)) return { sliceId: slice.id, status: 'passed', attempts: attempt, handoffs: Object.freeze([...handoffs]) }
      const outcome = await this.handleFailure(tester, attempt, handoffs)
      if (outcome.action === 'retry') { attempt = outcome.attempt; continue }
      if (outcome.action === 'repair') {
        const fixer = await this.dispatch('fixer', sliceTaskId('fixer', planHash, slice.id, outcome.attempt), slice, plan, `Repair ${slice.id} from tester evidence: ${tester.summary}`)
        handoffs.push(fixer)
        if (!isAccepted(fixer)) return failed(slice.id, outcome.attempt, handoffs, this.classifier.classify(fixer.summary))
        const retest = await this.dispatch('tester', sliceTaskId('tester', planHash, slice.id, outcome.attempt), slice, plan, `Re-run verification for ${slice.id} after the approved repair.`)
        handoffs.push(retest)
        if (isAccepted(retest)) return { sliceId: slice.id, status: 'passed', attempts: outcome.attempt, handoffs: Object.freeze([...handoffs]) }
        const terminal = this.classifier.classify(retest.summary)
        const next = this.retryPolicy.decide(terminal, outcome.attempt)
        if (next.action === 'retry') { attempt = next.attempt; continue }
        return failed(slice.id, outcome.attempt, handoffs, terminal)
      }
      return failed(slice.id, attempt, handoffs, outcome.failure)
    }
  }

  private async tryDispatch(role: ExpertDispatchRequest['role'], id: string, slice: VerticalSlice, plan: DevelopmentPlan, objective: string, scope?: DispatchScope): Promise<DispatchResult> {
    try {
      return { ok: true, handoff: await this.dispatch(role, id, slice, plan, objective, scope) }
    } catch (error: unknown) {
      return { ok: false, failure: this.classifier.classify(error) }
    }
  }

  private async tryDispatchDevelopers(slice: VerticalSlice, plan: DevelopmentPlan, planHash: string, attempt: number): Promise<DeveloperDispatchResult> {
    const batches = developerBatches(slice, plan, this.options.workspaceRoot)
    const handoffs: DurableHandoff[] = []
    for (const batch of batches) {
      const result = await this.tryDispatch('developer', sliceTaskId('developer', planHash, slice.id, attempt), slice, plan, `Implement ${batch.taskIds.join(', ')} for vertical slice ${slice.id}.`, batch)
      if (!result.ok) return { ok: false, failure: result.failure, handoffs: Object.freeze(handoffs) }
      handoffs.push(result.handoff)
      if (!isAccepted(result.handoff)) return { ok: true, handoffs: Object.freeze(handoffs) }
    }
    return { ok: true, handoffs: Object.freeze(handoffs) }
  }

  private async dispatch(role: ExpertDispatchRequest['role'], id: string, slice: VerticalSlice, plan: DevelopmentPlan, objective: string, scope?: DispatchScope): Promise<DurableHandoff> {
    const artifacts: ArtifactReference[] = Object.entries(plan.artifactHashes).map(([path, sha256]) => ({ path, sha256 }))
    const expectedPaths = scope?.paths ?? slice.expectedPaths
    const taskIds = scope?.taskIds ?? slice.taskIds
    const canReadMigration = role === 'tester'
    const readPaths = new Set([
      ...expectedPaths.filter(path => canReadMigration || !isMigrationPath(path)),
      ...(plan.artifactReadPaths ?? []).filter(path => canReadMigration || !isMigrationPath(path)),
    ])
    // A developer handoff may be narrowed to one task file after a restart or
    // when a slice is split into bounded task batches. Keep writes narrowed to
    // that task, but expose the task's declared task dependencies as readonly
    // inputs; otherwise the Agent has to guess the exports of already-written
    // files and can spend its whole wall-clock budget probing them.
    const readableTaskIds = new Set<string>()
    const addTaskDependencies = (taskId: string): void => {
      if (readableTaskIds.has(taskId)) return
      readableTaskIds.add(taskId)
      const task = plan.tasks.find(candidate => candidate.id === taskId)
      if (task === undefined) return
      for (const dependencyId of task.dependencies) addTaskDependencies(dependencyId)
    }
    for (const taskId of taskIds) addTaskDependencies(taskId)
    for (const task of plan.tasks) {
      if (!readableTaskIds.has(task.id)) continue
      for (const path of task.files) if (canReadMigration || !isMigrationPath(path)) readPaths.add(path)
    }
    const visited = new Set<string>([slice.id])
    const includeDependencies = (current: VerticalSlice): void => {
      for (const id of current.dependencies) {
        if (visited.has(id)) continue
        visited.add(id)
        const dependency = plan.slices.find(candidate => candidate.id === id)
        if (dependency === undefined) throw new Error('missing prerequisite slice: ' + id)
        for (const path of dependency.expectedPaths) if (canReadMigration || !isMigrationPath(path)) readPaths.add(path)
        includeDependencies(dependency)
      }
    }
    includeDependencies(slice)
    // Some already-materialized feature modules are shared dependencies but are
    // not owned by the current slice (for example the audit helper used by
    // status/roster). Testers may read these files; ownership and writes remain
    // restricted to the declared slice paths.
    if (role === 'tester' && this.options.workspaceRoot !== undefined && materialized(join(this.options.workspaceRoot, 'src/personnel/domain/audit.ts'))) {
      readPaths.add('src/personnel/domain/audit.ts')
    }
    const instructions = taskIds.map(id => plan.tasks.find(task => task.id === id)).filter(task => task !== undefined).map(task => task.id + ': ' + task.objective)
    const migrationPaths = expectedPaths.filter(isMigrationPath)
    const taskObjective = [objective, ...instructions, ...(migrationPaths.length === 0 ? [] : ['Host-owned migration files are excluded from this role\'s read/write scope. Do not call backend_team_write for migrations; the host generates and applies approved migrations separately.'])].join('\n')
    const writePaths = role === 'tester'
      ? expectedPaths.filter((path) => /(?:^|\/)(?:test|tests)(?:\/|$)|\.(?:test|spec)\./u.test(path))
      : expectedPaths.filter((path) => !isMigrationPath(path))
    return this.options.teamCoordinator.dispatchExpert({
      id,
      role,
      objective: taskObjective,
      nonGoals: ['Do not change files outside this vertical slice.', 'Do not change requirements or approvals.', 'Do not perform migrations or dependency installs.'],
      inputArtifacts: artifacts,
      readPaths: [...readPaths],
      writePaths,
      capabilities: {
        readProjectFiles: true,
        writeOwnedFiles: true,
        businessCodeWrite: role !== 'tester',
        testCodeWrite: true,
        configurationWrite: role !== 'tester',
        commandExecution: true,
        networkHosts: [],
        install: false,
        migration: false,
        canDelegate: role !== 'tester',
        canChangePhase: false,
        canApprove: false,
        canContactUser: false,
        canAnnounceCompletion: false,
      },
      budget: this.options.budget ?? { maxTokens: 20_000, maxWallMs: 300_000, maxToolCalls: 100, maxRetries: 2, maxChildren: 0 },
      doneWhen: scope === undefined
        ? [...slice.completionConditions]
        : taskIds.map(taskId => plan.tasks.find(task => task.id === taskId)?.objective ?? `Complete ${taskId}.`),
      // A scope object is also used for legacy slices that carry task IDs but
      // no task metadata. Those dispatches still represent the complete slice
      // and must use slice-level verification; task-scoped review applies only
      // when at least one declared plan task is actually being narrowed.
      verification: role === 'developer' && isTaskScoped(scope, plan)
        ? [{ id: 'task-scope-review', kind: 'inspection', instruction: 'Review the declared task files for consistency with the task objective and report any unresolved issue.', required: true }]
        : [{ id: 'slice-tests', kind: 'test', instruction: slice.testEvidence.join('; ') || 'Run the slice tests.', required: true }],
      returnSchema: 'backend-team-slice-handoff-v1',
    })
  }

  private async handleFailure(handoff: DurableHandoff, attempt: number, handoffs: readonly DurableHandoff[]): Promise<RetryOutcome> {
    const failure = this.classifier.classify({ message: handoff.summary, output: handoff.risks.join('; ') })
    return this.handleClassifiedFailure(failure, attempt, handoffs)
  }

  private async handleClassifiedFailure(failure: ClassifiedFailure, attempt: number, handoffs: readonly DurableHandoff[] = []): Promise<RetryOutcome> {
    const decision = this.retryPolicy.decide(failure, attempt)
    if (decision.delayMs > 0) await this.sleep(decision.delayMs)
    return { ...decision, failure, handoffs }
  }
}

interface RetryOutcome {
  readonly action: RetryAction
  readonly attempt: number
  readonly delayMs: number
  readonly reason: string
  readonly failure: ClassifiedFailure
  readonly handoffs: readonly DurableHandoff[]
}

type DispatchResult = { readonly ok: true; readonly handoff: DurableHandoff } | { readonly ok: false; readonly failure: ClassifiedFailure }
type DeveloperDispatchResult = { readonly ok: true; readonly handoffs: readonly DurableHandoff[] } | { readonly ok: false; readonly failure: ClassifiedFailure; readonly handoffs: readonly DurableHandoff[] }
interface DispatchScope { readonly taskIds: readonly string[]; readonly paths: readonly string[] }

function isTaskScoped(scope: DispatchScope | undefined, plan: DevelopmentPlan): boolean {
  return scope !== undefined && scope.taskIds.some((taskId) => plan.tasks.some((task) => task.id === taskId))
}

function developerBatches(slice: VerticalSlice, plan: DevelopmentPlan, workspaceRoot?: string): readonly DispatchScope[] {
  const tasks = slice.taskIds.map(id => plan.tasks.find(task => task.id === id)).filter(task => task !== undefined)
  const incomplete = workspaceRoot === undefined ? tasks : tasks.filter(task => !task.files.every(path => materialized(join(workspaceRoot, path))))
  // Plans without task metadata (legacy fixtures and hand-authored slices)
  // still need the original developer handoff for checkpoint verification.
  if (tasks.length === 0) return [{ taskIds: slice.taskIds, paths: slice.expectedPaths }]
  if (incomplete.length === 0) return []
  if (incomplete.length <= 1) return [{ taskIds: incomplete.map(task => task.id), paths: slice.expectedPaths.filter(path => incomplete.some(task => task.files.includes(path))) }]
  return incomplete.map(task => {
    const paths = task.files.filter(path => slice.expectedPaths.includes(path))
    return { taskIds: [task.id], paths: paths.length === 0 ? slice.expectedPaths : paths }
  })
}

function materialized(path: string): boolean {
  try { return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0 } catch { return false }
}

function isAccepted(handoff: DurableHandoff): boolean {
  return handoff.status === 'completed' && handoff.parentVerification.status === 'accepted'
}

function isMigrationPath(path: string): boolean { return /(?:^|\/)(?:migrations?|drizzle)(?:\/|$)|\.sql$/u.test(path) }

function failed(sliceId: string, attempts: number, handoffs: readonly DurableHandoff[], failure: ClassifiedFailure): SliceExecutionResult {
  const status = failure.category === 'requirements-contradiction' || failure.category === 'permission-denied' || failure.category === 'migration-data-risk' || failure.category === 'resource-budget' || failure.category === 'harness-incompatibility' ? 'blocked' : 'failed'
  return { sliceId, status, attempts, handoffs: Object.freeze([...handoffs]), failure }
}
