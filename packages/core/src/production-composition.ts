import { DeliveryLifecycle } from './delivery-lifecycle.js'
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { PolicyEngine, StateStore, WorkspaceLayout } from '@dsh-backend-team/contracts'
import { HandoffStore } from '@dsh-backend-team/agent-team/handoff-store'
import { OwnershipManager } from '@dsh-backend-team/agent-team/ownership-manager'
import { ownershipPort, type LongTaskOwnershipPort } from '@dsh-backend-team/agent-team/long-task-execution-session'
import { TaskScheduler } from '@dsh-backend-team/agent-team/task-scheduler'
import { PersistedEventPort } from './persisted-event-port.js'
import { ApplicationActionCatalog, type ApplicationWorkflowPort } from './application-action-catalog.js'
import { ApprovalService } from './approval-service.js'
import { ControlMediatedApprovalPort } from './control-mediated-approval-port.js'
import { FilePersistedEventStore } from './file-persisted-event-store.js'
import { FileStateStore } from './state-store.js'
import { EventedStateStore } from './evented-state-store.js'
import { createApplicationWorkflowAdapter } from './application-workflow-adapter.js'
import { SpecificationCoordinator, type ArtifactRegistryPort, type ArtifactValidatorPort, type SpecKitCommandLoaderPort, type SpecificationBudget } from './specification-coordinator.js'
import type { ApprovalGate } from './state-machine.js'
import { TeamCoordinator } from './team-coordinator.js'
import { createProductionOrchestrationPort, type VerifiedAgentPort } from './production-orchestration-port.js'

/**
 * Structural ports for the user-facing specification workflow. Concrete Spec
 * Kit implementations belong to the Bundle/host boundary; Core only wires
 * their verified capabilities into the production graph.
 */
export interface ProductionSpecificationOptions {
  readonly autoAdvance?: boolean
  readonly commandLoader: SpecKitCommandLoaderPort
  readonly artifactRegistry: ArtifactRegistryPort
  readonly artifactValidator: ArtifactValidatorPort
  readonly taskPlanLoader?: import('./specification-coordinator.js').TaskPlanLoaderPort
  readonly budget?: SpecificationBudget
  readonly resume?: (input?: unknown) => Promise<unknown>
}

export interface ProductionCompositionOptions {
  readonly taskId?: string
  /** Existing project directory that owns every generated Backend Team file. */
  readonly workspaceRoot: string
  /** Secret retained by the caller for recovering abandoned ownership leases. */
  readonly recoveryToken: string
  /** Agent implementation whose public provenance has already been verified. */
  readonly agents: VerifiedAgentPort
  /** Policy implementation for coordinator path and phase authorization. */
  readonly policyEngine: PolicyEngine
  /** Hashes for the currently approved artifacts, when a workflow is resumed. */
  readonly currentArtifactHashes?: Readonly<Record<string, string>>
  /** Stable identity used in coordinator audit records. */
  readonly coordinatorTaskId?: string
  /** Legacy externally assembled workflow; retained for compatibility. */
  readonly workflow?: ApplicationWorkflowPort
  /** Structural Spec Kit ports; Core builds the workflow after TeamCoordinator. */
  readonly specification?: ProductionSpecificationOptions
}

export interface ProductionComposition {
  readonly taskId?: string
  readonly deliveryLifecycle: DeliveryLifecycle
  readonly verifyDevelopmentApproval: () => Promise<void>
  readonly layout: WorkspaceLayout
  readonly stateStore: StateStore
  readonly events: PersistedEventPort
  readonly approvals: ControlMediatedApprovalPort
  readonly orchestration: ReturnType<typeof createProductionOrchestrationPort>
  readonly scheduler: TaskScheduler
  readonly coordinator: TeamCoordinator
  /** Read-only ownership assertion for an explicit long-task runtime binding. */
  readonly longTaskOwnership: LongTaskOwnershipPort
  readonly approvalService?: ApprovalService
  readonly specification?: SpecificationCoordinator
  readonly workflow?: ApplicationWorkflowPort
  /** Start one user approval request and resolve when its real pending record exists. */
  readonly requestWorkflowApproval: (gate: ApprovalGate) => Promise<void>
  readonly waitForWorkflowAdvance: (gate: ApprovalGate) => Promise<void>
  readonly actions: ApplicationActionCatalog
  /** Release ownership leases recovered after an ungraceful host shutdown. */
  readonly recoverAbandonedOwnership: () => number
  /** Idempotently stop active Agents and settle host-mediated approvals. */
  readonly dispose: () => Promise<void>
}

/**
 * Compose the application-owned production graph without importing any
 * DeepSeek Harness implementation. The Bundle supplies the verified Agent
 * adapter and policy implementation at the host boundary.
 */
export async function createProductionComposition(options: ProductionCompositionOptions): Promise<ProductionComposition> {
  assertWorkflowConfiguration(options)
  assertVerifiedAgent(options.agents)
  const workspaceRoot = await canonicalWorkspaceRoot(options.workspaceRoot)
  const layout = layoutFor(workspaceRoot)
  await ensureManagedDirectories(layout)

  const durableStateStore = new FileStateStore(workspaceRoot, options.taskId)
  const eventPort = new PersistedEventPort(workspaceRoot, new FilePersistedEventStore(workspaceRoot, options.taskId))
  const stateStore = new EventedStateStore(durableStateStore, eventPort)
  if (await stateStore.load() === null) {
    try {
      await stateStore.create({
        schemaVersion: 1,
        revision: 0,
        workspaceRoot,
        phase: 'DISCOVER',
        runs: [],
        approvals: [],
        approvalTokens: [],
      })
    } catch (error: unknown) {
      // Another startup path may have won the create lock after our first
      // read. Treat only that short-lived race as success. A stale lock or
      // any other filesystem failure must still fail closed.
      if (!isLockContention(error) || !await waitForState(stateStore)) throw error
    }
  }

  const approvals = new ControlMediatedApprovalPort(workspaceRoot)
  const orchestration = createProductionOrchestrationPort({
    workspaceId: workspaceRoot,
    events: eventPort,
    approvals,
    agents: options.agents,
  })
  const scheduler = new TaskScheduler({ orchestration, workspaceRoot })
  const ownershipManager = new OwnershipManager({ workspaceRoot, recoveryToken: options.recoveryToken })
  const coordinator = new TeamCoordinator({
    stateStore,
    scheduler,
    handoffStore: new HandoffStore(workspaceRoot),
    currentArtifactHashes: options.currentArtifactHashes ?? {},
    ...(options.specification === undefined ? {} : {
      readCurrentArtifactHashes: async () => {
        const phase = (await stateStore.load())?.phase
        if (phase === 'BUILD' || phase === 'VERIFY') {
          if (approvalService === undefined) throw new Error('production approval service is unavailable')
          return approvalService.verifiedDevelopmentArtifactHashes()
        }
        const snapshot = await options.specification!.artifactRegistry.snapshot()
        const entries = snapshot.artifacts.map(item => [item.path, item.sha256] as const)
        if (entries.length === 0 || new Set(entries.map(([path]) => path)).size !== entries.length || entries.some(([path, hash]) => !path || !/^[a-f0-9]{64}$/u.test(hash))) throw new Error('artifact registry snapshot is invalid')
        return Object.freeze(Object.fromEntries(entries))
      },
    }),
    workspace: layout,
    policyEngine: options.policyEngine,
    ownershipManager,
    ...(options.coordinatorTaskId === undefined ? {} : { coordinatorTaskId: options.coordinatorTaskId }),
  })
  const approvalService = options.specification === undefined ? undefined : new ApprovalService({
    stateStore,
    artifactRegistry: options.specification.artifactRegistry,
    artifactValidator: options.specification.artifactValidator,
    orchestration,
    settlement: approvals,
  })
  await approvalService?.reconcilePersistedApprovals()
  const specification = options.specification === undefined || approvalService === undefined ? undefined : new SpecificationCoordinator({
    workspaceRoot,
    stateStore,
    commandLoader: options.specification.commandLoader,
    artifactRegistry: options.specification.artifactRegistry,
    artifactValidator: options.specification.artifactValidator,
    approvalService,
    ...(options.specification.taskPlanLoader === undefined ? {} : { taskPlanLoader: options.specification.taskPlanLoader }),
    orchestration,
    ...(options.specification.budget === undefined ? {} : { budget: options.specification.budget }),
  })
  let workflowClosed = false
  const verifyDevelopmentApproval = async (): Promise<void> => {
    if (approvalService === undefined) throw new Error('production approval service is unavailable')
    await approvalService.verifiedDevelopmentArtifactHashes()
  }
  const workflow = specification === undefined ? options.workflow : createApplicationWorkflowAdapter({
    specification,
    status: () => coordinator.status(),
    assertActive: () => { if (workflowClosed) throw new Error('production workflow is closed') },
    ...(options.specification?.autoAdvance !== true ? {} : { afterGeneration: async (phase: 'design' | 'plan') => {
      if (phase === 'design') await requestWorkflowApproval('design')
      else if (options.specification?.resume !== undefined) await options.specification.resume()
    } }),
    ...(options.specification?.resume === undefined ? {} : { resume: options.specification.resume }),
  })
  const workflowFlights = new Map<ApprovalGate, WorkflowApprovalFlight>()
  const workflowBackground = new Set<Promise<unknown>>()
  const requestWorkflowApproval = (gate: ApprovalGate): Promise<void> => {
    if (workflowClosed) return Promise.reject(new Error('production workflow approval is closed'))
    if (specification === undefined || workflow === undefined) return Promise.reject(new Error('production workflow approval is unavailable'))
    const existingFlight = workflowFlights.get(gate)
    if (existingFlight !== undefined) return existingFlight.promise
    const existingPending = approvals.listPending().find((pending) => pending.request.kind === gate)
    if (existingPending !== undefined) return Promise.reject(new Error(`${gate} approval is already pending: ${existingPending.id}`))

    let observed = false
    let settled = false
    let resolveFlight!: () => void
    let rejectFlight!: (error: unknown) => void
    const promise = new Promise<void>((resolve, reject) => { resolveFlight = resolve; rejectFlight = reject })
    // A host may recreate an approval during startup without a caller waiting
    // on the returned flight. Keep the rejection observable to diagnostics but
    // never let a shutdown race surface as an unhandled process rejection.
    void promise.catch(() => undefined)
    const flight: WorkflowApprovalFlight = { promise }
    workflowFlights.set(gate, flight)
    let unsubscribe: (() => void) | undefined
    const observe = (): void => {
      if (settled || observed) return
      if (approvals.listPending().some((pending) => pending.request.kind === gate)) {
        observed = true
        unsubscribe?.()
        resolveFlight()
      }
    }
    try {
      unsubscribe = approvals.subscribe(observe)
      observe()
      const background = workflow.approve(gate)
      flight.completion = background
      workflowBackground.add(background)
      void background.catch(() => undefined)
      void background.then(
        () => { if (!observed) rejectFlight(new Error(`${gate} workflow completed without a pending approval`)) },
        (error: unknown) => { if (!observed) rejectFlight(error) },
      ).finally(() => {
        settled = true
        unsubscribe?.()
        workflowBackground.delete(background)
        if (workflowFlights.get(gate) === flight) workflowFlights.delete(gate)
      }).catch(() => undefined)
    } catch (error: unknown) {
      settled = true
      unsubscribe?.()
      workflowFlights.delete(gate)
      rejectFlight(error)
    }
    return promise
  }
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposal !== undefined) return disposal
    disposal = (async () => {
      const failures: unknown[] = []
      workflowClosed = true
      const approvalClosing = approvals.closeAndDrain()
      const workflowClosing = Promise.allSettled([...workflowBackground])
      try { await approvalClosing } catch (error: unknown) { failures.push(error) }
      try { await workflowClosing } catch (error: unknown) { failures.push(error) }
      try { await scheduler.dispose() } catch (error: unknown) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, 'production composition disposal failed')
    })()
    return disposal
  }
  const waitForWorkflowAdvance = async (gate: ApprovalGate): Promise<void> => { await workflowFlights.get(gate)?.completion }
  const recoverAbandonedOwnership = (): number => {
    const activity = scheduler.snapshot()
    if (activity.activeExperts > 0 || activity.activeWriters > 0 || activity.queued > 0) throw new Error('cannot recover ownership while Agent work is active')
    const leases = ownershipManager.snapshot()
    let released = 0
    for (const lease of leases) released += ownershipManager.releaseRecovered(lease.taskId, lease.paths, options.recoveryToken)
    return released
  }
  return Object.freeze({ ...(options.taskId === undefined ? {} : { taskId: options.taskId }), deliveryLifecycle: new DeliveryLifecycle(stateStore, verifyDevelopmentApproval), verifyDevelopmentApproval, layout, stateStore, events: eventPort, approvals, orchestration, scheduler, coordinator, longTaskOwnership: ownershipPort(ownershipManager), ...(approvalService === undefined ? {} : { approvalService }), ...(specification === undefined ? {} : { specification }), ...(workflow === undefined ? {} : { workflow }), requestWorkflowApproval, waitForWorkflowAdvance, actions: new ApplicationActionCatalog(coordinator, workflow), recoverAbandonedOwnership, dispose })
}

interface WorkflowApprovalFlight {
  readonly promise: Promise<void>
  completion?: Promise<unknown>
}

function assertWorkflowConfiguration(options: ProductionCompositionOptions): void {
  if (options.workflow !== undefined && options.specification !== undefined) throw new TypeError('production composition accepts workflow or specification, not both')
}

function isLockContention(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EEXIST'
}

async function waitForState(stateStore: StateStore): Promise<boolean> {
  const deadline = Date.now() + 1_000
  do {
    if (await stateStore.load() !== null) return true
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  return (await stateStore.load()) !== null
}

function assertVerifiedAgent(value: VerifiedAgentPort): void {
  if (value === null || typeof value !== 'object' || value.verifiedProvenance !== true || typeof value.spawnAgent !== 'function') throw new Error('production composition requires verified Agent provenance')
}

async function canonicalWorkspaceRoot(input: string): Promise<string> {
  if (typeof input !== 'string' || input.length === 0) throw new Error('workspace root is required')
  const root = await realpath(input)
  const details = await lstat(root)
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('workspace root must be a real directory')
  return root
}

function layoutFor(root: string): WorkspaceLayout {
  const teamDir = join(root, '.backend-team')
  return { root, teamDir, stateDir: join(teamDir, 'state'), runtimeDir: join(teamDir, 'runtime'), cacheDir: join(teamDir, 'cache'), logsDir: join(teamDir, 'logs'), locksDir: join(teamDir, 'locks'), handoffDir: join(teamDir, 'handoff') }
}

async function ensureManagedDirectories(layout: WorkspaceLayout): Promise<void> {
  for (const directory of [layout.teamDir, layout.stateDir, layout.runtimeDir, layout.cacheDir, layout.logsDir, layout.locksDir, layout.handoffDir]) {
    let details
    try {
      details = await lstat(directory)
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        try { await mkdir(directory, { mode: 0o700 }) } catch (mkdirError: unknown) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
        }
        details = await lstat(directory)
      } else throw error
    }
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`managed directory is unsafe: ${directory}`)
    await chmod(directory, 0o700)
  }
}
