import { createProductionActivation as activate } from './backend-team-plugin.js'
import { createManagedAgentToolSetup } from './managed-agent-tools.js'
import type { CommandRequest, CommandResult } from '@dsh-backend-team/contracts'
import type { PolicyEngine } from '@dsh-backend-team/contracts'
import { SliceExecutor, type DevelopmentPlan, type TeamCoordinatorPort } from '@dsh-backend-team/development'
import { DevelopmentRunController, type DevelopmentRunControllerOptions } from '@dsh-backend-team/development/run-controller'
import { FileDevelopmentCheckpointStore } from '@dsh-backend-team/development/checkpoint-store'
import type { LongTaskRunLeasePort } from '@dsh-backend-team/agent-team'
import { FileDevelopmentPlanLoader } from '@dsh-backend-team/development/plan-loader'
import { HandoffStore } from '@dsh-backend-team/agent-team/handoff-store'
import { applyBackendTeamControlRoute as applyControlRoute, createVerifiedWebServerBinding as createWebServerBinding } from '../../web/src/control-route.js'
import { applyDbGateLoginRoute } from '../../web/src/dbgate-login-route.js'
import { CoordinatorControlAdapter } from '../../web/src/coordinator-control-port.js'
import { createBackendTeamControlSurface as createControlSurface } from '../../web/src/control-surface.js'
import { createCoordinatorCommandHandlers as createCommandHandlers } from '../../web/src/coordinator-command-handlers.js'
import type { SnapshotManifest } from '@dsh-backend-team/database'
export { createDshLocalSessionInput } from './dsh-session-adapter.js'
export type { DshControlRouteRequest, DshLocalSessionInputOptions, DshSessionContext } from './dsh-session-adapter.js'
import type { DshControlRouteRequest } from './dsh-session-adapter.js'
import { createVerifiedDshHostPort, createVerifiedDshSessionPort } from './dsh-production-ports.js'
export { createVerifiedDshAgentPort, createVerifiedDshHostPort, createVerifiedDshSessionPort } from './dsh-production-ports.js'
export type { DshProductionContext, DshWebServerBinding, VerifiedDshAgentPort, VerifiedDshAgentPortOptions, VerifiedDshHostPort, VerifiedDshSessionPort, VerifiedDshSessionPortOptions } from './dsh-production-ports.js'
import type { HarnessExecutionSessionFactory } from '@dsh-backend-team/harness-adapter'
export { createLongTaskExecutionSessionFactory } from './long-task-session-binding.js'
export type { LongTaskSessionBindingOptions } from './long-task-session-binding.js'

/** Host context accepted by the explicit production entry. */
export interface BackendTeamProductionContext {
  readonly webServer?: unknown
  readonly sessions?: unknown
  readonly agents?: unknown
}

export interface ProductionAgentResultInput {
  readonly request: unknown
  readonly sessionId: string
  readonly events: readonly unknown[]
  readonly assistant: { readonly content: readonly unknown[] }
  readonly usage?: unknown
  readonly hostUsage: { readonly tokens: number; readonly wallMs: number; readonly toolCalls: number; readonly retries: number }
}

export interface ProductionActivationOptions {
  readonly taskId?: string
  readonly enableManagedNodeTests?: boolean
  readonly context?: BackendTeamProductionContext
  readonly workspaceRoot?: unknown
  readonly recoveryToken?: unknown
  readonly policyEngine?: unknown
  readonly provider?: string
  readonly model?: string
  readonly pluginId?: string
  readonly decodeResult?: (input: ProductionAgentResultInput) => unknown
  readonly setupAgent?: (context: unknown, request: unknown) => void | Promise<void>
  /** Optional host-owned ContextManager/LangGraph binding for long tasks. */
  readonly executionSessionFactory?: HarnessExecutionSessionFactory
  /** Optional complete binding inputs; ownership is taken from the composition. */
  readonly longTask?: Omit<import('./long-task-session-binding.js').LongTaskSessionBindingOptions, 'workspaceRoot' | 'ownership'>
  /** Optional host-owned command boundary for approved project checks/install steps. */
  readonly commandRunner?: { run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> }
  /** Resolves an approval token for the exact command; undefined means cancelled/expired. */
  readonly commandApprovalToken?: (input: { readonly taskId: string; readonly request: CommandRequest }) => Promise<string | undefined>
  /** Core assembles the workflow against its own coordinator and state store. */
  readonly specification?: {
    readonly autoAdvance?: boolean
    /** Required to enter BUILD: wire FileDevelopmentPlanLoader for the same feature registry. */
    readonly taskPlanLoader?: { load(): Promise<unknown> }
    readonly commandLoader: { load(command: string, args: string): { readonly id: string; readonly prompt: string; readonly sourceRealPath: string; readonly sourceSha256: string } | Promise<{ readonly id: string; readonly prompt: string; readonly sourceRealPath: string; readonly sourceSha256: string }> }
    readonly artifactRegistry: { snapshot(): { readonly featureDirectory: string; readonly artifacts: readonly { readonly path: string; readonly sha256: string }[] } | Promise<{ readonly featureDirectory: string; readonly artifacts: readonly { readonly path: string; readonly sha256: string }[] }> }
    readonly artifactValidator: { validateForGate(gate: 'requirements' | 'design'): { readonly valid?: boolean; readonly errors?: readonly { readonly code?: string; readonly file?: string; readonly heading?: string; readonly message?: string }[] } | Promise<{ readonly valid?: boolean; readonly errors?: readonly { readonly code?: string; readonly file?: string; readonly heading?: string; readonly message?: string }[] }> }
    readonly budget?: { readonly maxAgents: number; readonly maxSteps: number; readonly maxTokens?: number; readonly maxWallMs?: number }
    readonly resume?: (input?: unknown) => Promise<unknown>
  }
  /** Optional verified user-facing workflow; omitted keeps production actions read-only. */
  readonly workflow?: {
    readonly start: (objective: string) => Promise<unknown>
    readonly refine: (input: unknown) => Promise<unknown>
    readonly approve: (gate: 'requirements' | 'design') => Promise<unknown>
    readonly status: () => Promise<unknown> | unknown
    readonly resume: (input?: unknown) => Promise<unknown>
  }
}

export interface ProductionPendingApprovalFeed {
  listPending(): readonly { readonly id: string; readonly workspaceId: string; readonly stateRevision: number; readonly artifactHash: string; readonly request: { readonly kind: 'requirements' | 'design' | 'migration'; readonly summary: string } }[]
  subscribe(listener: () => void): () => void
}

export interface ProductionCompositionSummary {
  readonly taskId?: string
  readonly deliveryLifecycle?: import('@dsh-backend-team/core').DeliveryLifecycle
  readonly verifyDevelopmentApproval: () => Promise<void>
  readonly coordinator: { dispatchExpert(input: unknown): Promise<unknown> }
  readonly requestWorkflowApproval: (gate: 'requirements' | 'design') => Promise<void>
  readonly waitForWorkflowAdvance?: (gate: 'requirements' | 'design') => Promise<void>
  readonly stateStore: { transact?: import('@dsh-backend-team/contracts').StateStore['transact']; load(): Promise<{ readonly revision: number; readonly phase: string; readonly approvals?: ReadonlyArray<import('@dsh-backend-team/contracts').ApprovalRecord>; readonly workflowError?: string; readonly finalVerification?: import('@dsh-backend-team/contracts').FinalVerificationRecord } | null> }
  readonly approvals: ProductionPendingApprovalFeed & { decideAndWait(id: string, decision: import('@dsh-backend-team/contracts').ApprovalDecision, artifactHash: string, revision: number): Promise<void> }
  readonly layout: { readonly root: string }
  readonly events: ProductionEventFeed
  readonly actions: { readonly list: () => readonly unknown[]; readonly get: (name: string) => unknown }
  readonly workflow?: ProductionActivationOptions['workflow']
  readonly specification?: { design(): Promise<void>; generateTasks(): Promise<void> }
  readonly scheduler?: { snapshot(): { readonly activeExperts: number; readonly activeWriters: number; readonly queued: number } }
  readonly recoverAbandonedOwnership: () => number
  readonly dispose: () => Promise<void>
}

export interface ReadOnlyProductionActivation {
  readonly mode: 'read-only'
  readonly missing: readonly string[]
  readonly reasons: readonly string[]
  readonly composition?: undefined
  readonly agentPort?: undefined
  readonly dispose: () => Promise<void>
}

export interface SupportedProductionActivation {
  readonly mode: 'supported'
  readonly missing: readonly []
  readonly reasons: readonly []
  readonly composition: ProductionCompositionSummary
  readonly agentPort: { readonly verifiedProvenance: true; readonly spawnAgent: (request: unknown, signal?: AbortSignal) => Promise<unknown> }
  readonly dispose: () => Promise<void>
}

export type ProductionActivation = ReadOnlyProductionActivation | SupportedProductionActivation

export interface ProductionWebServerBinding {
  readonly verifiedProvenance: true
  register(route: { readonly kind: 'prefix'; readonly path: string; readonly handler: (request: unknown, response: unknown) => void | Promise<void> }): () => void
}

export interface ProductionControlRouteOptions {
  readonly server: ProductionWebServerBinding
  readonly service: { getState(sessionInput: unknown): unknown; dispatch(sessionInput: unknown, input: unknown): Promise<unknown> }
  readonly sessionInput: (request: DshControlRouteRequest) => unknown
  readonly path?: string
  readonly maxBodyBytes?: number
}

export interface ProductionCoordinatorControlPort {
  readonly dispatch: (action: unknown, context: unknown) => Promise<unknown>
}

/** Structural callback table accepted by the public Bundle production helper. */
export interface ProductionCoordinatorCommandImplementations {
  readonly currentRevision: () => number | Promise<number>
  readonly submitClarification: (action: unknown, context: unknown) => unknown | Promise<unknown>
  readonly decideApproval: (action: unknown, context: unknown) => unknown | Promise<unknown>
  readonly pauseRun?: (action: unknown, context: unknown) => unknown | Promise<unknown>
  readonly resumeRun?: (action: unknown, context: unknown) => unknown | Promise<unknown>
  readonly retryFailedStep: (action: unknown, context: unknown) => unknown | Promise<unknown>
  readonly openArtifact: (action: unknown, context: unknown) => unknown | Promise<unknown>
  readonly startDatabase?: (action: unknown, context: unknown) => unknown | Promise<unknown>
  readonly stopDatabase?: (action: unknown, context: unknown) => unknown | Promise<unknown>
  readonly prepareDatabaseMigration?: (action: unknown, context: unknown) => unknown | Promise<unknown>
  readonly createDatabaseSnapshot?: (action: unknown, context: unknown) => unknown | Promise<unknown>
  readonly restoreDatabaseSnapshot?: (action: unknown, context: unknown) => unknown | Promise<unknown>
  readonly openDatabaseGui?: (action: unknown, context: unknown) => unknown | Promise<unknown>
}

/** Structural view of the reviewed workspace-local database execution port. */
export interface ProductionDatabaseExecutionPort {
  readonly verifiedProvenance: true
  start(): Promise<unknown>
  /** Optional project database preparation performed after startup. */
  prepare?: (projectId?: string) => Promise<unknown>
  stop(): Promise<unknown>
  openGui(authenticatedSessionId?: string): Promise<{ readonly url: string; readonly expiresAt: string }>
  /** Host-only opaque handoff, validated by the dedicated authenticated route. */
  consumeGuiLogin?: (authenticatedSessionId: string) => unknown
  /** Workspace-owned backup metadata and guarded restore operations. */
  listSnapshots?: () => Promise<readonly ProductionDatabaseSnapshot[]>
  createSnapshot?: (reason: string, kind?: 'data' | 'schema') => Promise<ProductionDatabaseSnapshot>
  restoreSnapshot?: (snapshotId: string, targetDatabase: string) => Promise<{ readonly snapshotId: string; readonly targetDatabase: string; readonly restoredAt: string }>
}

export type ProductionDatabaseSnapshot = Omit<SnapshotManifest, 'dumpFile'>

export interface ProductionEventFeed {
  read(): Promise<readonly unknown[]>
  subscribe(subscriber: (event: unknown) => void | Promise<void>): () => void
}

export interface ProductionDevelopmentRunPort {
  snapshot(): { readonly status: 'idle' | 'running' | 'pausing' | 'paused' | 'passed' | 'failed' | 'blocked' }
  subscribe(listener: () => void): () => void
  pause(): Promise<void>
  pauseAndWait?(): Promise<void>
  resume(): Promise<void>
  dispose(): Promise<void>
}

/** Host-bound file tools installed inside official Agent creation, before publication. */
export function createProductionAgentToolSetup(options: {
  readonly workspaceRoot: string
  readonly recoveryToken: string
  readonly readPhase: () => Promise<string>
  readonly verifyCurrentApproval: () => Promise<void>
  readonly policyEngine: unknown
  readonly commandRunner?: { run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> }
  readonly commandApprovalToken?: (input: { readonly taskId: string; readonly request: CommandRequest }) => Promise<string | undefined>
}): (context: unknown, request: unknown) => Promise<void> {
  if (typeof options.policyEngine !== 'object' || options.policyEngine === null || typeof Reflect.get(options.policyEngine, 'authorize') !== 'function') throw new Error('host policy engine is required')
  const setup = createManagedAgentToolSetup({ ...options, policyEngine: options.policyEngine as PolicyEngine })
  return async (context, request) => { await setup(context as Parameters<typeof setup>[0], request as Parameters<typeof setup>[1]) }
}

/** Bundled implementation; consumers need no private workspace packages. */
export function createProductionDevelopmentRun(options: {
  readonly taskId?: string
  readonly initialSnapshot?: DevelopmentRunControllerOptions['initialSnapshot']
  readonly verifyFinal?: NonNullable<DevelopmentRunControllerOptions['verifyFinal']>
  readonly budget?: { readonly maxTokens: number; readonly maxWallMs: number; readonly maxToolCalls: number; readonly maxRetries: number; readonly maxChildren: number }
  readonly workspaceRoot: string
  readonly loadPlan?: () => Promise<unknown>
  readonly artifactRegistry?: { snapshot(): { readonly featureDirectory: string; readonly artifacts: readonly { readonly path: string; readonly sha256: string }[] } | Promise<{ readonly featureDirectory: string; readonly artifacts: readonly { readonly path: string; readonly sha256: string }[] }> }
  readonly coordinator: { dispatchExpert(input: unknown): Promise<unknown> }
  readonly verifyDesignApproval: () => Promise<void>
  readonly beginPatch: (paths: readonly string[]) => Promise<unknown>
  readonly recoverAbandonedOwnership?: () => number | Promise<number>
  readonly beforeResume?: () => void | Promise<void>
  /** Optional host-shared lease; nested Agent sessions may acquire it by reference. */
  readonly runLease?: LongTaskRunLeasePort
}): ProductionDevelopmentRunPort {
  if (options.loadPlan !== undefined && options.artifactRegistry !== undefined) throw new TypeError('provide a plan loader or artifact registry, not both')
  if (options.loadPlan === undefined && options.artifactRegistry === undefined) throw new TypeError('development artifact registry is required')
  const loader = options.artifactRegistry === undefined ? undefined : new FileDevelopmentPlanLoader(options.workspaceRoot, options.artifactRegistry)
  const fileCheckpoints = new FileDevelopmentCheckpointStore(options.workspaceRoot, options.taskId)
  const checkpoints = options.runLease === undefined ? fileCheckpoints : {
    load: () => fileCheckpoints.load(),
    save: (checkpoint: Parameters<NonNullable<typeof fileCheckpoints['save']>>[0]) => fileCheckpoints.save(checkpoint),
    acquireRun: () => options.runLease!.acquire(),
  }
  return new DevelopmentRunController({
    workspaceRoot: options.workspaceRoot,
    ...(options.initialSnapshot === undefined ? {} : { initialSnapshot: options.initialSnapshot }),
    ...(options.verifyFinal === undefined ? {} : { verifyFinal: options.verifyFinal }),
    loadPlan: async () => loader === undefined ? await options.loadPlan!() as DevelopmentPlan : loader.load(),
    checkpoints,
    sliceExecutor: new SliceExecutor({
      teamCoordinator: options.coordinator as TeamCoordinatorPort,
      patchTracker: { begin: paths => options.beginPatch(paths) },
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      workspaceRoot: options.workspaceRoot,
    }),
    handoffStore: new HandoffStore(options.workspaceRoot),
    teamCoordinator: options.coordinator as TeamCoordinatorPort,
    approvals: { verifyActiveApproval: async () => { await options.verifyDesignApproval() } },
    patchTracker: { begin: paths => options.beginPatch(paths) },
    ...(options.recoverAbandonedOwnership === undefined ? {} : { recoverAbandonedOwnership: options.recoverAbandonedOwnership }),
    ...(options.beforeResume === undefined ? {} : { beforeResume: options.beforeResume }),
  })
}

export interface ProductionControlSurfaceOptions {
  readonly developmentRun?: ProductionDevelopmentRunPort
  readonly approvals?: ProductionPendingApprovalFeed
  readonly events: ProductionEventFeed
  readonly workspaceName: string
  readonly workspaceId?: string
  readonly coordinator: ProductionCoordinatorControlPort
  readonly authenticator: { authenticate(input: unknown): unknown }
  /** Durable state revision used for control fencing when the event projection lags. */
  readonly currentRevision?: () => number | Promise<number>
  readonly compatibility?: { readonly mode: 'supported' | 'read-only'; readonly reason?: string }
  readonly databaseFeed?: { snapshot(): NonNullable<ProductionControlSurfaceOptions['database']>; subscribe(listener: () => void): () => void }
  readonly database?: { readonly migrationMessage?: string; readonly migrationAvailable?: boolean; readonly controlsAvailable?: boolean; readonly runtime: 'not-installed' | 'stopped' | 'starting' | 'ready' | 'failed'; readonly engine: string; readonly guiAvailable: boolean }
  readonly usage?: { readonly activeExperts: number; readonly activeWorkers: number; readonly concurrentWriters: number; readonly remainingTaskBudget: number }
  readonly initialState?: Record<string, unknown>
}

export interface ProductionControlSurface {
  readonly projector: { readonly snapshot: () => unknown }
  readonly subscriptions: { readonly subscribe: (id: string, send: (state: unknown) => void | Promise<void>, initial: unknown) => () => void }
  readonly service: { readonly getState: (sessionInput: unknown) => unknown; readonly dispatch: (sessionInput: unknown, input: unknown) => Promise<unknown> }
  readonly dispose: () => Promise<void>
}

export interface ProductionHostOptions extends ProductionActivationOptions {
  readonly registerRoutes?: boolean
  /** Recreate a durable AWAIT_* gate in the host's user confirmation surface. */
  readonly restorePendingApprovals?: boolean
  readonly developmentRunFactory?: (composition: ProductionCompositionSummary) => ProductionDevelopmentRunPort | Promise<ProductionDevelopmentRunPort>
  /** A WebServer binding whose loopback/provenance checks were completed by the host. */
  readonly server: ProductionWebServerBinding
  /** Host-owned session extraction; no browser object is treated as authenticated. */
  readonly sessionInput: ProductionControlRouteOptions['sessionInput']
  readonly workspaceName: string
  /** A prebuilt complete action table; mutually exclusive with implementations. */
  readonly coordinatorHandlers?: Record<string, unknown>
  /** Explicit workflow/database/artifact callbacks used to build the action table. */
  readonly coordinatorImplementations?: ProductionCoordinatorCommandImplementations
  /** Build callbacks after activation so they use this host's actual state and approvals. */
  readonly coordinatorImplementationFactory?: (composition: ProductionCompositionSummary) => ProductionCoordinatorCommandImplementations
  /** Optional reviewed database port used to fill the three database commands. */
  readonly databasePort?: ProductionDatabaseExecutionPort
  readonly authenticator: ProductionControlSurfaceOptions['authenticator']
  readonly compatibility?: ProductionControlSurfaceOptions['compatibility']
  readonly databaseFeed?: ProductionControlSurfaceOptions['databaseFeed']
  readonly database?: ProductionControlSurfaceOptions['database']
  readonly usage?: ProductionControlSurfaceOptions['usage']
  readonly initialState?: Record<string, unknown>
  readonly path?: string
  readonly maxBodyBytes?: number
}

/** Production host options that derive Host/Session ports directly from one DSH context. */
export type DshProductionHostOptions = Omit<ProductionHostOptions, 'server' | 'sessionInput' | 'authenticator'> & {
  readonly context: BackendTeamProductionContext
  readonly authenticator?: ProductionControlSurfaceOptions['authenticator']
}

export interface ReadOnlyProductionHost {
  readonly mode: 'read-only'
  readonly missing: readonly string[]
  readonly reasons: readonly string[]
  readonly activation: ReadOnlyProductionActivation
  readonly surface?: undefined
  readonly dispose: () => Promise<void>
}

export interface SupportedProductionHost {
  readonly consumeGuiLogin?: (sessionId: string) => unknown
  readonly sessionInput: ProductionControlRouteOptions['sessionInput']
  readonly mode: 'supported'
  readonly missing: readonly []
  readonly reasons: readonly []
  readonly activation: SupportedProductionActivation
  readonly surface: ProductionControlSurface
  readonly databaseSnapshots?: Pick<ProductionDatabaseExecutionPort, 'listSnapshots' | 'createSnapshot' | 'restoreSnapshot'>
  readonly dispose: () => Promise<void>
}

export type ProductionHost = ReadOnlyProductionHost | SupportedProductionHost

/**
 * Explicit opt-in production entry. The default Bundle entry remains the
 * diagnostic-only `apply()` plugin and never calls this helper automatically.
 */
export function createProductionActivation(options: ProductionActivationOptions): Promise<ProductionActivation> {
  return activate(options as never) as Promise<ProductionActivation>
}

/** Re-export the explicit, loopback-only control route for the production host. */
export function applyBackendTeamControlRoute(options: ProductionControlRouteOptions): () => void {
  return applyControlRoute(options as never)
}

/** Mark the exact public WebServer.register shape used by the route adapter. */
export function createVerifiedWebServerBinding(server: unknown): ProductionWebServerBinding {
  return createWebServerBinding(server) as ProductionWebServerBinding
}

/** Validate and freeze the complete action table before exposing it to routes. */
export function createCoordinatorControlAdapter(handlers: Record<string, unknown>): ProductionCoordinatorControlPort {
  return new CoordinatorControlAdapter(handlers as never) as unknown as ProductionCoordinatorControlPort
}

/** Build the revision-fenced command table without performing any command. */
export function createCoordinatorCommandHandlers(options: ProductionCoordinatorCommandImplementations): Record<string, unknown> {
  return createCommandHandlers(completeCoordinatorImplementations(options) as never) as unknown as Record<string, unknown>
}

/** Compose the event projection and authenticated control service explicitly. */
export function createBackendTeamControlSurface(options: ProductionControlSurfaceOptions): Promise<ProductionControlSurface> {
  return createControlSurface(options as never) as Promise<ProductionControlSurface>
}

/**
 * Compose all writable host resources explicitly and dispose them in reverse
 * dependency order. A missing Agent/policy/workspace seam returns a read-only
 * host without registering a route or creating application state.
 */
export async function createBackendTeamProductionHost(options: ProductionHostOptions): Promise<ProductionHost> {
  const useFactory = options.coordinatorImplementationFactory !== undefined
  if (useFactory && (typeof options.coordinatorImplementationFactory !== 'function' || options.coordinatorHandlers !== undefined || options.coordinatorImplementations !== undefined)) throw new TypeError('provide a coordinator factory, handlers or implementations, not multiple sources')
  if (options.developmentRunFactory !== undefined && options.coordinatorHandlers !== undefined) throw new TypeError('development run requires coordinator implementations')
  const coordinator = hasProductionActivationInputs(options) && !useFactory && options.developmentRunFactory === undefined ? buildCoordinator(options) : undefined
  const activation = await createProductionActivation(options)
  if (activation.mode === 'read-only') {
    return Object.freeze({ mode: 'read-only' as const, missing: activation.missing, reasons: activation.reasons, activation, dispose: activation.dispose })
  }

  let developmentRun: ProductionDevelopmentRunPort | undefined
  let surface: ProductionControlSurface | undefined
  let removeRoute: (() => void) | undefined
  let removeLoginRoute: (() => void) | undefined
  try {
    developmentRun = await options.developmentRunFactory?.(activation.composition)
    const wired = { ...options, developmentRun }
    const activatedCoordinator = coordinator ?? (useFactory ? buildFactoryCoordinator(wired, activation.composition) : buildCoordinator(wired))
    const durableState = await activation.composition.stateStore.load()
    if (durableState === null) throw new Error('production state is unavailable')
    surface = await createBackendTeamControlSurface({
      ...(developmentRun === undefined ? {} : { developmentRun }),
      approvals: activation.composition.approvals,
      events: activation.composition.events,
      workspaceName: options.workspaceName,
      workspaceId: activation.composition.layout.root,
      coordinator: activatedCoordinator,
      authenticator: options.authenticator,
      currentRevision: async () => {
        const current = await activation.composition.stateStore.load()
        if (current === null) throw new Error('production state is unavailable')
        return current.revision
      },
      ...(options.compatibility === undefined ? {} : { compatibility: options.compatibility }),
      ...(options.databaseFeed === undefined ? {} : { databaseFeed: options.databaseFeed }),
      ...(options.database === undefined ? {} : { database: options.database }),
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      initialState: { ...options.initialState, phase: durableState.phase, stateRevision: durableState.revision, approvalRetryAvailable: useFactory && activation.composition.workflow !== undefined },
    })
    if (options.registerRoutes !== false) removeRoute = applyBackendTeamControlRoute({
      server: options.server,
      service: surface.service,
      sessionInput: options.sessionInput,
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    })
    if (options.registerRoutes !== false && options.databasePort?.consumeGuiLogin !== undefined) {
      const database = options.databasePort
      removeLoginRoute = applyDbGateLoginRoute({
        server: options.server as never,
        workspaceId: activation.composition.layout.root,
        sessionInput: options.sessionInput,
        authenticator: options.authenticator as never,
        consumeLogin: (sessionId) => database.consumeGuiLogin!(sessionId),
      })
    }
    // Approval requests are intentionally held by the host mediation port, while
    // the workflow phase is durable. Recreate a missing request after a restart
    // so an AWAIT_* state always has a real confirmation entry in the UI.
    const approvalGate = durableApprovalGate(durableState.phase)
    if (options.restorePendingApprovals === true && useFactory && approvalGate !== undefined && activation.composition.workflow !== undefined && !activation.composition.approvals.listPending().some(item => item.request.kind === approvalGate)) {
      void activation.composition.requestWorkflowApproval(approvalGate).catch(() => undefined)
    }
  } catch (error: unknown) {
    removeLoginRoute?.()
    removeRoute?.()
    await surface?.dispose().catch(() => undefined)
    await developmentRun?.dispose().catch(() => undefined)
    await activation.dispose().catch(() => undefined)
    throw error
  }

  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposal !== undefined) return disposal
    disposal = (async () => {
      const failures: unknown[] = []
      try { removeLoginRoute?.() } catch (error: unknown) { failures.push(error) }
      try { removeRoute?.() } catch (error: unknown) { failures.push(error) }
      try { await surface?.dispose() } catch (error: unknown) { failures.push(error) }
      try { await developmentRun?.dispose() } catch (error: unknown) { failures.push(error) }
      try { await activation.dispose() } catch (error: unknown) { failures.push(error) }
      try { await options.databasePort?.stop() } catch (error: unknown) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, 'production host disposal failed')
    })().catch((error: unknown) => { disposal = undefined; throw error })
    return disposal
  }

  return Object.freeze({ mode: 'supported' as const, missing: Object.freeze([]) as readonly [], reasons: Object.freeze([]) as readonly [], activation, surface, sessionInput: options.sessionInput, ...(options.databasePort?.consumeGuiLogin === undefined ? {} : { consumeGuiLogin: (id: string) => options.databasePort!.consumeGuiLogin!(id) }), ...(options.databasePort?.listSnapshots === undefined ? {} : { databaseSnapshots: { listSnapshots: options.databasePort.listSnapshots, ...(options.databasePort.createSnapshot === undefined ? {} : { createSnapshot: options.databasePort.createSnapshot }), ...(options.databasePort.restoreSnapshot === undefined ? {} : { restoreSnapshot: options.databasePort.restoreSnapshot }) } }), dispose })
}

function durableApprovalGate(phase: string): 'requirements' | 'design' | undefined {
  if (phase === 'AWAIT_REQUIREMENTS_APPROVAL') return 'requirements'
  if (phase === 'AWAIT_DESIGN_APPROVAL') return 'design'
  return undefined
}

/**
 * Compose the production host from the official rc.6 context itself. This is
 * the preferred entry for a DSH plugin: the helper verifies the loopback
 * WebServer and exact Session/Agent stores, then delegates to the same gated
 * production assembly used by host-neutral callers.
 */
export function createDshProductionHost(options: DshProductionHostOptions): Promise<ProductionHost> {
  const host = createVerifiedDshHostPort(options.context)
  if (typeof options.workspaceRoot !== 'string' || options.workspaceRoot.trim().length === 0) throw new TypeError('workspaceRoot is required for DSH production host')
  const session = createVerifiedDshSessionPort({ context: options.context, workspaceId: options.workspaceRoot, workspaceRoot: options.workspaceRoot })
  return createBackendTeamProductionHost({ ...options, server: host.server, sessionInput: session.input, authenticator: options.authenticator ?? session.authenticator })
}

function buildFactoryCoordinator(options: WiredProductionHostOptions, composition: ProductionCompositionSummary): ProductionCoordinatorControlPort {
  const implementations = options.coordinatorImplementationFactory!(composition)
  if (typeof implementations?.retryFailedStep !== 'function') throw new TypeError('coordinator implementation is missing: retryFailedStep')
  return buildCoordinator({ ...options, coordinatorImplementations: {
    ...implementations,
    retryFailedStep: async (action, context) => {
      const stepId = typeof action === 'object' && action !== null ? Reflect.get(action, 'stepId') as unknown : undefined
      if (stepId === 'approval:requirements' || stepId === 'approval:design') {
        await composition.requestWorkflowApproval(stepId === 'approval:requirements' ? 'requirements' : 'design')
        return
      }
      return implementations.retryFailedStep(action, context)
    },
  } })
}

function buildCoordinator(options: WiredProductionHostOptions): ProductionCoordinatorControlPort {
  if (options.coordinatorHandlers !== undefined && options.coordinatorImplementations !== undefined) throw new TypeError('provide coordinatorHandlers or coordinatorImplementations, not both')
  const handlers = options.coordinatorHandlers ?? (options.coordinatorImplementations === undefined ? undefined : createCoordinatorCommandHandlers(withDevelopmentPort(withDatabasePort(options.coordinatorImplementations, options.databasePort), options.developmentRun)))
  if (handlers === undefined) throw new TypeError('coordinator handlers or implementations are required')
  return createCoordinatorControlAdapter(handlers)
}

function completeCoordinatorImplementations(options: ProductionCoordinatorCommandImplementations): Required<ProductionCoordinatorCommandImplementations> {
  for (const key of ['startDatabase', 'stopDatabase', 'openDatabaseGui', 'pauseRun', 'resumeRun'] as const) if (typeof options[key] !== 'function') throw new TypeError(`coordinator implementation is missing: ${key}`)
  return options as Required<ProductionCoordinatorCommandImplementations>
}

function withDatabasePort(options: ProductionCoordinatorCommandImplementations, database: ProductionDatabaseExecutionPort | undefined): ProductionCoordinatorCommandImplementations {
  if (database === undefined) return options
  if (database.verifiedProvenance !== true || typeof database.start !== 'function' || typeof database.stop !== 'function' || typeof database.openGui !== 'function') throw new TypeError('database execution port is not verified')
  const createSnapshot = database.createSnapshot
  const restoreSnapshot = database.restoreSnapshot
  return {
    ...options,
    startDatabase: options.startDatabase ?? (async () => { await database.start(); if (database.prepare !== undefined) await database.prepare() }),
    stopDatabase: options.stopDatabase ?? (async () => { await database.stop() }),
    openDatabaseGui: options.openDatabaseGui ?? (async (_action, context) => {
      const sessionId = typeof context === 'object' && context !== null ? Reflect.get(context, 'authenticatedSessionId') as unknown : undefined
      if (typeof sessionId !== 'string' || sessionId.length < 16) throw new Error('authenticated GUI session is required')
      return { navigation: { ...await database.openGui(sessionId), kind: 'one-time-local-url' } }
    }),
    ...(options.createDatabaseSnapshot !== undefined ? { createDatabaseSnapshot: options.createDatabaseSnapshot } : createSnapshot === undefined ? {} : { createDatabaseSnapshot: async (action: unknown) => {
      const reason = typeof action === 'object' && action !== null && typeof Reflect.get(action, 'reason') === 'string' ? Reflect.get(action, 'reason') as string : 'Agent 在数据库变更前创建的工作区备份'
      const kind = typeof action === 'object' && action !== null && Reflect.get(action, 'kind') === 'schema' ? 'schema' as const : 'data' as const
      await createSnapshot(reason, kind)
    } }),
    ...(options.restoreDatabaseSnapshot !== undefined ? { restoreDatabaseSnapshot: options.restoreDatabaseSnapshot } : restoreSnapshot === undefined ? {} : { restoreDatabaseSnapshot: async (action: unknown) => {
      const snapshotId = Reflect.get(action as object, 'snapshotId') as string
      const targetDatabase = Reflect.get(action as object, 'targetDatabase') as string
      await restoreSnapshot(snapshotId, targetDatabase)
    } }),
  }
}

function hasProductionActivationInputs(options: ProductionHostOptions): boolean {
  try {
    const agents = options.context?.agents
    return typeof options.workspaceRoot === 'string' && options.workspaceRoot.trim().length > 0
      && typeof options.recoveryToken === 'string' && options.recoveryToken.length >= 16
      && typeof options.policyEngine === 'object' && options.policyEngine !== null && typeof Reflect.get(options.policyEngine, 'authorize') === 'function'
      && typeof agents === 'object' && agents !== null && typeof Reflect.get(agents, 'create') === 'function'
  } catch {
    return false
  }
}

type WiredProductionHostOptions = ProductionHostOptions & { readonly developmentRun?: ProductionDevelopmentRunPort | undefined }
function withDevelopmentPort(options: ProductionCoordinatorCommandImplementations, run: ProductionDevelopmentRunPort | undefined): ProductionCoordinatorCommandImplementations {
  if (run === undefined) return options
  for (const key of ['snapshot', 'subscribe', 'pause', 'resume', 'dispose'] as const) if (typeof run[key] !== 'function') throw new TypeError('development run implementation is missing: ' + key)
  return { ...options, pauseRun: async () => { await (run.pauseAndWait === undefined ? run.pause() : run.pauseAndWait()) }, resumeRun: async () => { await run.resume() } }
}

export { createProductionWorkflowCommandImplementations } from './production-workflow-commands.js'

export { createConfiguredWorkflowHost } from './workflow-host.js'

/** Optional Cordis plugin entry: enable only with an explicit workspace configuration. */
export const name = '@dsh-backend-team/bundle/production'
export const inject = ['webServer', 'sessions', 'agents', 'tools', 'approval', 'userQuestions'] as const
export async function apply(context: BackendTeamProductionContext & { tools: { register(definition: unknown): () => void }; approval: { request(request: unknown): Promise<string> }; userQuestions?: { ask(request: import('./workflow-questions.js').UserQuestionRequest): Promise<import('./workflow-questions.js').UserQuestionAnswer> }; effect?: (body: () => (() => Promise<void>), label?: string) => unknown }, config: unknown): Promise<void> {
  if (typeof context.effect !== 'function') throw new Error('production host requires lifecycle cleanup')
  const { createConversationTaskHost } = await import('./conversation-task-host.js')
  const host = await createConversationTaskHost(context, config)
  if (host !== undefined) {
    try {
      context.effect(() => () => host.dispose(), 'backendTeam.workflowHost')
      {
        const { createProductionStatusTool } = await import('./production-status-tool.js')
        const { createConversationWorkflowTool } = await import('./conversation-workflow-tool.js')
        const tool = createProductionStatusTool({ sessionInput: host.sessionInput, context: context as import('./dsh-session-adapter.js').DshSessionContext, workspaceRoot: host.workspaceRoot, getState: host.getState })
        const unregister = context.tools.register(tool)
        try { context.effect(() => async () => { unregister() }, 'backendTeam.productionStatus') } catch (error) { unregister(); throw error }
        const workflowTool = createConversationWorkflowTool({ sessionInput: host.sessionInput, context: context as import('./dsh-session-adapter.js').DshSessionContext, workspaceRoot: host.workspaceRoot, getState: host.getState, dispatch: host.dispatch, createTask: host.createTask, taskChoices: host.taskChoices, resolveTask: host.resolveTask, ...(context.userQuestions === undefined ? {} : { askQuestions: request => context.userQuestions!.ask(request) }), requestApproval: request => context.approval.request(request) })
        const removeWorkflow = context.tools.register(workflowTool)
        try { context.effect(() => async () => { removeWorkflow() }, 'backendTeam.conversationWorkflow') } catch (error) { removeWorkflow(); throw error }
      }
    }
    catch (error) { await host.dispose(); throw error }
  }
}
