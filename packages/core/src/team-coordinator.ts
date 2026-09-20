import { isDeepStrictEqual } from 'node:util'
import { AgentCapabilitySetSchema, AgentHandoffSchema, AgentResultSchema, AgentTaskSchema } from '@dsh-backend-team/contracts'
import type { AgentDelegation, AgentResult, AgentRole, AgentTask, BackendTeamPhase, JsonObject, PolicyEngine, StateStore, WorkspaceLayout } from '@dsh-backend-team/contracts'
import { ContextBuilder, type ContextBuildInput } from '@dsh-backend-team/agent-team/context-builder'
import { DelegationGuard } from '@dsh-backend-team/agent-team/delegation-guard'
import { HandoffStore, type DurableHandoff } from '@dsh-backend-team/agent-team/handoff-store'
import { OwnershipManager, type OwnershipLease } from '@dsh-backend-team/agent-team/ownership-manager'
import type { ExpertPreset } from '@dsh-backend-team/agent-team/preset-loader'
import { ResultVerifier } from '@dsh-backend-team/agent-team/result-verifier'
import { RolePolicy } from '@dsh-backend-team/agent-team/role-policy'
import { TaskScheduler, type TaskSchedulerSnapshot } from '@dsh-backend-team/agent-team/task-scheduler'

export interface ExpertDispatchInput {
  readonly id: string
  readonly role: Exclude<AgentRole, 'coordinator' | 'worker'>
  readonly objective: string
  readonly nonGoals: readonly string[]
  readonly inputArtifacts: AgentTask['inputArtifacts']
  readonly readPaths: readonly string[]
  readonly writePaths: readonly string[]
  readonly capabilities: AgentTask['capabilities']
  readonly budget: AgentTask['budget']
  readonly doneWhen: readonly string[]
  readonly verification: AgentTask['verification']
  readonly returnSchema: string
  readonly context?: ContextBuildInput
}

export interface TeamCoordinatorOptions {
  readonly stateStore: StateStore
  readonly scheduler: TaskScheduler
  readonly handoffStore: HandoffStore
  readonly currentArtifactHashes: Readonly<Record<string, string>>
  readonly readCurrentArtifactHashes?: () => Promise<Readonly<Record<string, string>>>
  readonly workspace: WorkspaceLayout
  readonly policyEngine: PolicyEngine
  readonly ownershipManager: OwnershipManager
  readonly verifier?: ResultVerifier
  readonly contextBuilder?: ContextBuilder
  readonly coordinatorTaskId?: string
  readonly onProgress?: (event: CoordinatorProgressEvent) => void | Promise<void>
}

export interface CoordinatorProgressEvent {
  readonly type: 'expert-dispatched' | 'handoff-accepted' | 'handoff-needs-rework'
  readonly taskId: string
  readonly phase: BackendTeamPhase
}

export interface CoordinatorStatus extends TaskSchedulerSnapshot {
  readonly phase: BackendTeamPhase
  readonly unacknowledgedHandoffs: readonly string[]
}

export interface AcceptedExpertResult {
  readonly decision: Awaited<ReturnType<ResultVerifier['verify']>>
  readonly handoff: DurableHandoff
}

const expertRoles = new Set<AgentTask['role']>(['requirements', 'project-analyzer', 'backend-architect', 'database-designer', 'oss-researcher', 'planner', 'developer', 'tester', 'security-reviewer', 'fixer'])

/** Coordinator-only application boundary. It exposes no phase, approval, or user-message mutator to child agents. */
export class TeamCoordinator {
  private readonly verifier: ResultVerifier
  private readonly contextBuilder: ContextBuilder
  private readonly coordinatorTaskId: string
  private readonly currentArtifactHashes: Readonly<Record<string, string>>
  private readonly tasks = new Map<string, AgentTask>()
  private readonly contexts = new Map<string, string>()
  private readonly activeLeases = new Map<string, readonly OwnershipLease[]>()
  private readonly activeDelegations = new Map<string, DelegationCapability>()

  constructor(private readonly options: TeamCoordinatorOptions) {
    this.verifier = options.verifier ?? new ResultVerifier()
    this.contextBuilder = options.contextBuilder ?? new ContextBuilder()
    this.coordinatorTaskId = assertId(options.coordinatorTaskId ?? 'coordinator')
    this.currentArtifactHashes = Object.freeze({ ...options.currentArtifactHashes })
  }

  async dispatchExpert(input: ExpertDispatchInput): Promise<DurableHandoff> {
    const state = await this.requireDispatchPhase()
    const capabilities = boundedExpertCapabilities(input, state.phase, state.approvals.some((approval) => approval.kind === 'design'))
    const task = AgentTaskSchema.parse({ ...input, parentTaskId: this.coordinatorTaskId, depth: 1, capabilities })
    await this.assertFreshArtifacts(task)
    if (task.id === this.coordinatorTaskId || this.tasks.has(task.id) || this.options.handoffStore.exists(`handoff-${task.id}`)) throw new Error('expert task ID is already in use')
    await this.authorizeTaskPaths(task, state.phase)
    const leases = acquireTaskLeases(this.options.ownershipManager, task)
    const delegation = delegationFor(this, task)
    const startedAt = new Date().toISOString()
    let submitted = false
    try {
      this.tasks.set(task.id, task)
      this.activeLeases.set(task.id, leases.leases)
      if (delegation !== undefined) this.activeDelegations.set(task.id, delegation.token)
      this.contexts.set(task.id, this.contextBuilder.build(task, input.context))
      await this.emit({ type: 'expert-dispatched', taskId: task.id, phase: state.phase })
      submitted = true
      const result = await this.options.scheduler.submit(transportTask(task), 'normal', this.contextFor(task.id), delegation?.delegation, delegation?.token)
      return (await this.acceptExpertResult(task, result)).handoff
    } catch (error) {
      if (submitted) await this.recordDispatchFailure(task.id, startedAt, error).catch(() => undefined)
      this.tasks.delete(task.id)
      this.contexts.delete(task.id)
      throw error
    } finally {
      delegation?.revoke()
      this.activeDelegations.delete(task.id)
      this.activeLeases.delete(task.id)
      leases.release()
    }
  }

  async dispatchWorker(parent: AgentTask, proposed: AgentTask, capability?: DelegationCapability): Promise<DurableHandoff> {
    await this.requireDispatchPhase()
    const parentTask = AgentTaskSchema.parse(parent)
    if (capability === undefined || this.activeDelegations.get(parentTask.id) !== capability) throw new Error('worker delegation requires an active expert callback')
    const registeredParent = this.tasks.get(parentTask.id)
    if (registeredParent === undefined || !isDeepStrictEqual(registeredParent, parentTask) || parentTask.depth !== 1 || parentTask.parentTaskId !== this.coordinatorTaskId || !expertRoles.has(parentTask.role) || !parentTask.capabilities.canDelegate) throw new Error('worker parent must be a direct delegating expert')
    const requested = AgentTaskSchema.parse(proposed)
    if (requested.id === parentTask.id || requested.id === this.coordinatorTaskId) throw new Error('worker task ID must be unique from its parent and coordinator')
    const state = await this.requireState()
    const task = await this.authorizeWorker(parentTask, requested, state)
    await this.assertFreshArtifacts(task)
    if (this.tasks.has(task.id) || this.options.handoffStore.exists(`handoff-${task.id}`)) throw new Error('worker task ID is already in use')
    const leases = acquireTaskLeases(this.options.ownershipManager, task, this.activeLeases.get(parentTask.id))
    try {
      this.tasks.set(task.id, task)
      this.contexts.set(task.id, this.contextBuilder.build(task))
      const result = await this.options.scheduler.submit(transportTask(task), 'normal', this.contextFor(task.id), undefined, capability)
      return (await this.acceptWorkerResult(parentTask, task, result)).handoff
    } catch (error) {
      this.tasks.delete(task.id)
      this.contexts.delete(task.id)
      throw error
    } finally {
      leases.release()
    }
  }

  async acceptExpertResult(taskInput: AgentTask, resultInput: unknown): Promise<AcceptedExpertResult> {
    const task = AgentTaskSchema.parse(taskInput)
    const registered = this.tasks.get(task.id)
    if (registered === undefined || !isDeepStrictEqual(registered, task) || task.parentTaskId !== this.coordinatorTaskId || task.depth !== 1 || !expertRoles.has(task.role)) throw new Error('only dispatched direct expert tasks can be accepted')
    return this.acceptChildResult(task, resultInput, this.coordinatorTaskId)
  }

  async acceptWorkerResult(parentInput: AgentTask, taskInput: AgentTask, resultInput: unknown): Promise<AcceptedExpertResult> {
    const parent = AgentTaskSchema.parse(parentInput)
    const task = AgentTaskSchema.parse(taskInput)
    const registeredParent = this.tasks.get(parent.id)
    const registeredTask = this.tasks.get(task.id)
    if (registeredParent === undefined || !isDeepStrictEqual(registeredParent, parent) || registeredTask === undefined || !isDeepStrictEqual(registeredTask, task) || parent.depth !== 1 || parent.parentTaskId !== this.coordinatorTaskId || !expertRoles.has(parent.role)) throw new Error('worker parent must be a dispatched direct expert')
    if (task.parentTaskId !== parent.id || task.depth !== 2 || task.role !== 'worker') throw new Error('only depth-two worker tasks can be accepted')
    return this.acceptChildResult(task, resultInput, parent.id)
  }

  private async acceptChildResult(task: AgentTask, resultInput: unknown, parentTaskId: string): Promise<AcceptedExpertResult> {
    if (this.tasks.get(task.id) === undefined) throw new Error('task was not dispatched by the coordinator')
    const result = AgentResultSchema.parse(resultInput)
    const currentArtifactHashes = await this.assertFreshArtifacts(task)
    const decision = await this.verifier.verify(task, result, { currentArtifactHashes, handoffStore: this.options.handoffStore })
    const id = `handoff-${task.id}`
    // A task ID is a single-use capability. Do not replay or compare a durable
    // handoff here: accepting a second result for the same ID would make the
    // audit trail ambiguous and could turn a retry into a result substitution.
    if (this.options.handoffStore.exists(id)) throw new Error('task handoff ID is already in use')
    const handoff = AgentHandoffSchema.parse({
      id,
      taskId: task.id,
      status: result.status === 'passed' ? 'completed' : result.status,
      summary: result.summary,
      changedPaths: result.changedPaths,
      commands: result.commands,
      evidencePaths: result.evidencePaths,
      risks: result.risks,
      unresolvedItems: result.unresolvedItems,
      consumedBudget: result.consumedBudget,
      childResultIds: result.childResultIds,
      parentVerification: { status: 'pending' },
    })
    const stored = this.options.handoffStore.write(handoff, parentTaskId)
    const acknowledged = this.options.handoffStore.acknowledge(id, parentTaskId, decision.status)
    await this.recordRun(task.id, result)
    await this.emit({ type: decision.status === 'accepted' ? 'handoff-accepted' : 'handoff-needs-rework', taskId: task.id, phase: (await this.requireState()).phase })
    return { decision, handoff: acknowledged ?? stored }
  }

  private contextFor(taskId: string): JsonObject {
    const serialized = this.contexts.get(taskId)
    if (serialized === undefined) throw new Error('task context is not available')
    const parsed: unknown = JSON.parse(serialized)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('task context is invalid')
    return parsed as JsonObject
  }

  async status(): Promise<CoordinatorStatus> {
    const state = await this.requireState()
    return { ...this.options.scheduler.snapshot(), phase: state.phase, unacknowledgedHandoffs: this.unacknowledgedHandoffs() }
  }

  unacknowledgedHandoffs(): readonly string[] {
    return this.options.handoffStore.list().filter((handoff) => handoff.parentVerification.status === 'pending').map((handoff) => handoff.id).sort()
  }

  /** Context is retained only for the coordinator's dispatch audit; child agents receive a serialized bounded packet. */
  contextPacket(taskId: string): string {
    const id = assertId(taskId)
    const packet = this.contexts.get(id)
    if (packet === undefined) throw new Error('task context is not available')
    return packet
  }

  private async recordRun(taskId: string, result: AgentResult): Promise<void> {
    await this.enqueueStateWrite(async () => {
      const state = await this.requireState()
      if (state.runs.some((run) => run.id === `agent-${taskId}`)) return
      const now = new Date().toISOString()
      await this.options.stateStore.transact(state.revision, (current) => ({
        ...current,
        runs: [...current.runs, { id: `agent-${taskId}`, status: result.status === 'passed' ? 'passed' : result.status, startedAt: now, completedAt: now, summary: result.summary }],
      }))
    })
  }

  /** Keep a scheduler/verifier failure visible after the in-memory host restarts. */
  private async recordDispatchFailure(taskId: string, startedAt: string, error: unknown): Promise<void> {
    await this.enqueueStateWrite(async () => {
      const state = await this.requireState()
      if (state.runs.some((run) => run.id === `agent-${taskId}`)) return
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000)
      const status = /budget|quota|resource/iu.test(message)
        ? 'blocked' as const
        : /cancel|interrupt|abort/iu.test(message)
          ? 'interrupted' as const
          : 'failed' as const
      let consumedBudget: ReturnType<TaskScheduler['budgetSnapshot']>['consumed'] | undefined
      try { consumedBudget = this.options.scheduler.budgetSnapshot(taskId).consumed } catch { /* no ledger entry for preflight failures */ }
      await this.options.stateStore.transact(state.revision, (current) => ({
        ...current,
        ...(status === 'interrupted' ? {} : { workflowError: message }),
        runs: [...current.runs, {
          id: `agent-${taskId}`,
          status,
          startedAt,
          completedAt: new Date().toISOString(),
          summary: message,
          ...(consumedBudget === undefined ? {} : { consumedBudget }),
        }],
      }))
    })
  }

  private stateWriteTail: Promise<void> = Promise.resolve()
  private enqueueStateWrite(operation: () => Promise<void>): Promise<void> {
    const current = this.stateWriteTail.then(operation)
    this.stateWriteTail = current.catch(() => undefined)
    return current
  }

  private async requireDispatchPhase(): Promise<Awaited<ReturnType<TeamCoordinator['requireState']>>> {
    const state = await this.requireState()
    if (state.phase !== 'BUILD' && state.phase !== 'VERIFY') throw new Error(`agent dispatch is not allowed in phase ${state.phase}`)
    return state
  }

  private async requireState() {
    const state = await this.options.stateStore.load()
    if (state === null) throw new Error('backend team state has not been created')
    return state
  }

  private async emit(event: CoordinatorProgressEvent): Promise<void> {
    await this.options.onProgress?.(event)
  }

  private async assertFreshArtifacts(task: AgentTask): Promise<Readonly<Record<string, string>>> {
    const current = Object.freeze({ ...await (this.options.readCurrentArtifactHashes?.() ?? Promise.resolve(this.currentArtifactHashes)) })
    if (!sameArtifacts(task.inputArtifacts, current)) throw new Error('stale input artifacts')
    return current
  }

  private async authorizeWorker(parent: AgentTask, proposed: AgentTask, state: Awaited<ReturnType<TeamCoordinator['requireState']>>): Promise<AgentTask> {
    const budget = this.options.scheduler.budgetSnapshot(parent.id)
    if (budget.status !== 'ready') throw new Error('parent budget exhausted')
    const designApproved = state.approvals.some((approval) => approval.kind === 'design')
    const rolePolicy = new RolePolicy({ designApproved })
    const preset: ExpertPreset = {
      role: parent.role,
      purpose: 'Coordinator-generated bounded worker scope.',
      allowedPhases: [state.phase],
      defaultCapabilities: rolePolicy.maxCapabilities(parent.role, state.phase),
      readPathPatterns: parent.readPaths,
      writePathPatterns: parent.writePaths,
      requiredInputs: ['approved design'],
      requiredOutputs: ['durable handoff'],
      nonGoals: ['Do not change phase or contact the user.'],
      defaultBudget: parent.budget,
      verification: parent.verification,
    }
    const snapshot = {
      phase: state.phase,
      designApproved,
      childCount: parent.budget.maxChildren - budget.remaining.maxChildren,
      artifactHashes: parent.inputArtifacts,
      remainingBudget: budget.remaining,
      ownedWritePaths: parent.writePaths,
      occupiedWritePaths: this.options.ownershipManager.snapshot().filter((lease) => lease.taskId !== parent.id && lease.mode === 'write').flatMap((lease) => lease.paths),
      policyContext: { workspace: this.options.workspace, phase: state.phase },
    }
    return (await new DelegationGuard({ preset, snapshot, policyEngine: this.options.policyEngine }).authorizeChild(parent, proposed)).task
  }

  private async authorizeTaskPaths(task: AgentTask, phase: BackendTeamPhase): Promise<void> {
    const context = { workspace: this.options.workspace, phase }
    for (const path of task.readPaths) await requirePolicy(this.options.policyEngine, { kind: 'read', targetPath: path }, context)
    for (const path of task.writePaths) await requirePolicy(this.options.policyEngine, { kind: 'write', targetPath: path }, context)
  }
}

function assertId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new Error('coordinator task ID is invalid')
  return value
}

function sameArtifacts(artifacts: AgentTask['inputArtifacts'], current: Readonly<Record<string, string>>): boolean {
  return artifacts.every((artifact) => current[artifact.path] === artifact.sha256)
}

function boundedExpertCapabilities(input: ExpertDispatchInput, phase: BackendTeamPhase, designApproved: boolean): AgentTask['capabilities'] {
  const maximum = new RolePolicy({ designApproved }).maxCapabilities(input.role, phase)
  const keys = ['readProjectFiles', 'writeOwnedFiles', 'businessCodeWrite', 'testCodeWrite', 'configurationWrite', 'commandExecution', 'install', 'migration', 'canDelegate', 'canChangePhase', 'canApprove', 'canContactUser', 'canAnnounceCompletion'] as const
  const capabilities: Record<string, unknown> = Object.fromEntries(keys.map((key) => [key, Boolean(input.capabilities[key]) && maximum[key]]))
  capabilities.networkHosts = (input.capabilities.networkHosts ?? []).filter((host) => maximum.networkHosts.includes(host))
  if (input.readPaths.length > 0 && !capabilities.readProjectFiles) throw new Error('expert role cannot read declared paths in the current phase')
  if (input.writePaths.length > 0 && !capabilities.writeOwnedFiles) throw new Error('expert role cannot write declared paths in the current phase')
  return AgentCapabilitySetSchema.parse(capabilities)
}

interface TaskLeases { readonly leases: readonly OwnershipLease[]; release(): void }

function acquireTaskLeases(manager: OwnershipManager, task: AgentTask, parentLeases?: readonly OwnershipLease[]): TaskLeases {
  const leases = [] as ReturnType<OwnershipManager['acquire']>[]
  try {
    const readParent = parentLeases?.find((lease) => lease.mode === 'read')
    const writeParent = parentLeases?.find((lease) => lease.mode === 'write')
    if (task.readPaths.length > 0) leases.push(manager.acquire(task.id, task.readPaths, 'read', readParent === undefined ? {} : { delegatedFrom: readParent }))
    if (task.writePaths.length > 0) leases.push(manager.acquire(task.id, task.writePaths, 'write', writeParent === undefined ? {} : { delegatedFrom: writeParent }))
  } catch (error) {
    for (const lease of leases) manager.release(lease)
    throw error
  }
  return { leases: Object.freeze([...leases]), release: () => { for (const lease of leases) manager.release(lease) } }
}

type DelegationCapability = object
interface ActiveDelegation { readonly token: DelegationCapability; readonly delegation: AgentDelegation; revoke(): void }

function delegationFor(coordinator: TeamCoordinator, task: AgentTask): ActiveDelegation | undefined {
  if (!task.capabilities.canDelegate) return undefined
  const token: DelegationCapability = Object.freeze({})
  let active = true
  return {
    token,
    delegation: { delegateWorker: async (proposed) => { if (!active) throw new Error('expert delegation window is closed'); return coordinator.dispatchWorker(task, proposed, token) } },
    revoke: () => { active = false },
  }
}

async function requirePolicy(engine: PolicyEngine, action: { kind: 'read' | 'write'; targetPath: string }, context: { workspace: WorkspaceLayout; phase: BackendTeamPhase }): Promise<void> {
  const decision = await engine.authorize(action, context)
  if (decision.effect !== 'allow') throw new Error(`policy denied expert ${action.kind} path: ${decision.reason}`)
}

const secretAssignment = /\b(?:password|secret|token|credential|private[._-]?key|api[._-]?key|authorization|connection[._-]?string|database[._-]?url)\b\s*[:=]\s*[^\s,;]+/giu
const secretWord = /\b(?:password|secret|token|credential|private[._-]?key|api[._-]?key|authorization|connection[._-]?string|database[._-]?url)\b/giu

function transportText(value: string): string {
  return value.replace(secretAssignment, '<redacted>').replace(secretWord, '<redacted>')
}

function transportTask(task: AgentTask): AgentTask {
  return AgentTaskSchema.parse({
    ...task,
    objective: transportText(task.objective),
    nonGoals: task.nonGoals.map(transportText),
    doneWhen: task.doneWhen.map(transportText),
    returnSchema: transportText(task.returnSchema),
    verification: task.verification.map((instruction) => ({ ...instruction, instruction: transportText(instruction.instruction) })),
  })
}
