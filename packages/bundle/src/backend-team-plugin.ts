import { lstat, realpath } from 'node:fs/promises'
import { AgentResultSchema, type PolicyEngine } from '@dsh-backend-team/contracts'
import { ManagedTestEvidence } from './managed-test-evidence.js'
import { createProductionComposition, type ApplicationWorkflowPort, type ProductionComposition, type ProductionSpecificationOptions } from '@dsh-backend-team/core'
import { AgentResultFormatError, decodeHarnessAgentResult } from '@dsh-backend-team/agent-team/agent-result-decoder'
import { createHarnessAgentPort, type HarnessAgentContext, type HarnessAgentResultInput, type HarnessExecutionSessionFactory, type VerifiedHarnessAgentPort } from '@dsh-backend-team/harness-adapter'
import { createManagedAgentToolSetup } from './managed-agent-tools.js'
import type { CommandRequest, CommandResult } from '@dsh-backend-team/contracts'
import { createSpecificationAgentToolSetup } from './specification-agent-tools.js'
import { createLongTaskExecutionSessionFactory, type LongTaskSessionBindingOptions } from './long-task-session-binding.js'

/** The small host surface the opt-in production path is allowed to inspect. */
export interface BackendTeamProductionContext {
  readonly webServer?: unknown
  readonly sessions?: unknown
  readonly agents?: unknown
}

export interface ProductionActivationOptions {
  readonly taskId?: string
  readonly enableManagedNodeTests?: boolean
  /** Official `ctx` (or a test fixture containing its `agents` service). */
  readonly context?: BackendTeamProductionContext
  /** Existing project directory that owns all Backend Team state. */
  readonly workspaceRoot?: unknown
  /** Secret retained by the host for recovering abandoned ownership leases. */
  readonly recoveryToken?: unknown
  /** Application policy implementation; no permissive default is inferred. */
  readonly policyEngine?: unknown
  /** Optional explicit model route. Omit both values to use Harness defaults/Codex auth. */
  readonly provider?: string
  readonly model?: string
  readonly pluginId?: string
  readonly decodeResult?: (input: HarnessAgentResultInput) => unknown
  readonly setupAgent?: (context: unknown, request: unknown) => void | Promise<void>
  /** Optional host-owned ContextManager/LangGraph binding for long tasks. */
  readonly executionSessionFactory?: HarnessExecutionSessionFactory
  /** Optional complete binding inputs; ownership is taken from the composition. */
  readonly longTask?: Omit<LongTaskSessionBindingOptions, 'workspaceRoot' | 'ownership'>
  /** Optional host-owned command boundary for approved project checks/install steps. */
  readonly commandRunner?: { run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> }
  /** Resolves an approval token for the exact command; undefined means cancelled/expired. */
  readonly commandApprovalToken?: (input: { readonly taskId: string; readonly request: CommandRequest }) => Promise<string | undefined>
  /** Legacy externally assembled workflow; omitted keeps the catalog read-only. */
  readonly workflow?: ApplicationWorkflowPort
  /** Structural Spec Kit ports; Core builds the workflow after TeamCoordinator. */
  readonly specification?: ProductionSpecificationOptions
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
  readonly composition: ProductionComposition
  readonly agentPort: VerifiedHarnessAgentPort
  readonly dispose: () => Promise<void>
}

export type ProductionActivation = ReadOnlyProductionActivation | SupportedProductionActivation

/**
 * Build the writable application graph only from explicit, verified host inputs.
 * The normal Bundle entry does not call this function, so a missing host seam can
 * never silently turn the diagnostic Bundle into a writer/process runner.
 */
export async function createProductionActivation(options: ProductionActivationOptions): Promise<ProductionActivation> {
  const missing: string[] = []
  const agents = readAgentContext(options.context)
  if (agents === undefined) missing.push('agents')

  const workspaceRoot = typeof options.workspaceRoot === 'string' && options.workspaceRoot.trim().length > 0 ? options.workspaceRoot : undefined
  if (workspaceRoot === undefined) missing.push('workspaceRoot')

  const recoveryToken = typeof options.recoveryToken === 'string' && options.recoveryToken.length >= 16 ? options.recoveryToken : undefined
  if (recoveryToken === undefined) missing.push('recoveryToken')

  const policyEngine = isPolicyEngine(options.policyEngine) ? options.policyEngine : undefined
  if (policyEngine === undefined) missing.push('policyEngine')

  if (options.workflow !== undefined && options.specification !== undefined) {
    return readOnly([], ['workflow-and-specification-are-mutually-exclusive'])
  }
  if (options.executionSessionFactory !== undefined && options.longTask !== undefined) return readOnly([], ['execution-session-factory-and-long-task-are-mutually-exclusive'])
  if (options.workflow !== undefined && !isWorkflow(options.workflow)) missing.push('workflow')
  if (options.specification !== undefined && !isSpecification(options.specification)) missing.push('specification')

  if (missing.length > 0) return readOnly(missing, ['explicit-production-inputs-required'])

  let canonicalRoot: string
  try {
    canonicalRoot = await canonicalDirectory(workspaceRoot!)
  } catch {
    return readOnly([], ['workspace-root-is-not-an-existing-real-directory'])
  }

  let createdComposition: ProductionComposition | undefined
  try {
    const testEvidence = options.enableManagedNodeTests === true ? new ManagedTestEvidence() : undefined
    const decode = options.decodeResult ?? defaultDecodeResult
    const decodeResult = (input: HarnessAgentResultInput): unknown => {
      const result = decode(input)
      const requiresSuccessfulTest = input.request.agentTask?.verification.some(instruction => instruction.required && instruction.kind === 'test') ?? true
      return testEvidence !== undefined && ['developer', 'tester', 'fixer'].includes(input.request.agentTask?.role ?? '')
        ? testEvidence.verify(AgentResultSchema.parse(result), { requireSuccessfulTest: requiresSuccessfulTest })
        : result
    }
    const setupState: { current?: ReturnType<typeof createManagedAgentToolSetup> } = {}
    let boundExecutionSessionFactory = options.executionSessionFactory
    const agentPort = createHarnessAgentPort({
      context: agents!,
      cwd: canonicalRoot,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
      pluginId: options.pluginId ?? '@dsh-backend-team/bundle',
      decodeResult,
      resultFormatRepair: error => error instanceof AgentResultFormatError ? error.repairInstruction : undefined,
      ...((boundExecutionSessionFactory === undefined && options.longTask === undefined) ? {} : {
        executionSessionFactory: async (input) => {
          if (boundExecutionSessionFactory === undefined) throw new Error('long-task execution binding is not initialized')
          return boundExecutionSessionFactory(input)
        },
      }),
      setupAgent: async (context, request) => {
        if (setupState.current === undefined) throw new Error('production Agent tools are not initialized')
        await setupState.current(context, request)
        await options.setupAgent?.(context, request)
      },
    })
    const composition = await createProductionComposition({
      ...(options.taskId === undefined ? {} : { taskId: options.taskId, coordinatorTaskId: `coordinator-${options.taskId}` }),
      workspaceRoot: canonicalRoot,
      recoveryToken: recoveryToken!,
      agents: agentPort,
      policyEngine: policyEngine!,
      ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
      ...(options.specification === undefined ? {} : { specification: options.specification }),
    })
    createdComposition = composition
    if (options.longTask !== undefined) boundExecutionSessionFactory = createLongTaskExecutionSessionFactory({ ...options.longTask, workspaceRoot: canonicalRoot, ownership: composition.longTaskOwnership })
    const developmentSetup = createManagedAgentToolSetup({ ...(testEvidence === undefined ? {} : { nodeTests: testEvidence }), ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }), ...(options.commandApprovalToken === undefined ? {} : { commandApprovalToken: options.commandApprovalToken }), workspaceRoot: canonicalRoot, recoveryToken: recoveryToken!,
      policyEngine: policyEngine!,
      readPhase: async () => (await composition.stateStore.load())?.phase ?? 'UNAVAILABLE',
      verifyCurrentApproval: composition.verifyDevelopmentApproval,
    })
    const readPhase = async (): Promise<string> => (await composition.stateStore.load())?.phase ?? 'UNAVAILABLE'
    const specificationSetup = options.specification === undefined ? undefined : createSpecificationAgentToolSetup({
      workspaceRoot: canonicalRoot, recoveryToken: recoveryToken!, policyEngine: policyEngine!, readPhase,
      readFeatureDirectory: async () => (await options.specification!.artifactRegistry.snapshot()).featureDirectory,
      verifyCurrentApproval: async () => {
        const phase = await readPhase()
        if (phase === 'SPECIFY') return
        if (composition.approvalService === undefined) throw new Error('specification approval service is unavailable')
        if (phase === 'DESIGN') return composition.approvalService.verifyActiveApproval('requirements')
        if (phase === 'PLAN') return composition.approvalService.verifyActiveApproval('design')
        throw new Error('specification phase changed')
      },
    })
    setupState.current = async (context, request) => {
      const phase = await readPhase()
      if (['SPECIFY', 'DESIGN', 'PLAN'].includes(phase)) {
        if (specificationSetup === undefined) throw new Error('specification ports are unavailable')
        await specificationSetup(context, request)
      } else await developmentSetup(context, request)
    }
    return Object.freeze({ mode: 'supported', missing: Object.freeze([]) as readonly [], reasons: Object.freeze([]) as readonly [], composition, agentPort, dispose: composition.dispose })
  } catch {
    await createdComposition?.dispose().catch(() => {})
    return readOnly([], ['production-composition-failed-closed'])
  }
}

function readOnly(missing: readonly string[], reasons: readonly string[]): ReadOnlyProductionActivation {
  return Object.freeze({ mode: 'read-only', missing: Object.freeze([...missing]), reasons: Object.freeze([...reasons]), dispose: async () => undefined })
}

function readAgentContext(context: BackendTeamProductionContext | undefined): HarnessAgentContext | undefined {
  if (context === undefined || typeof context !== 'object' || context === null) return undefined
  try {
    const agents = Reflect.get(context, 'agents')
    if (typeof agents !== 'object' || agents === null || typeof Reflect.get(agents, 'create') !== 'function') return undefined
    return { agents: agents as HarnessAgentContext['agents'] }
  } catch {
    return undefined
  }
}

function isPolicyEngine(value: unknown): value is PolicyEngine {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'authorize') === 'function'
}

function isWorkflow(value: unknown): value is ApplicationWorkflowPort {
  try {
    if (typeof value !== 'object' || value === null) return false
    for (const method of ['start', 'refine', 'approve', 'status', 'resume'] as const) {
      if (typeof Reflect.get(value, method) !== 'function') return false
    }
    return true
  } catch {
    return false
  }
}

function isSpecification(value: unknown): value is ProductionSpecificationOptions {
  try {
    if (typeof value !== 'object' || value === null) return false
    for (const [parent, method] of [['commandLoader', 'load'], ['artifactRegistry', 'snapshot'], ['artifactValidator', 'validateForGate']] as const) {
      const dependency = Reflect.get(value, parent)
      if (typeof dependency !== 'object' || dependency === null || typeof Reflect.get(dependency, method) !== 'function') return false
    }
    const budget = Reflect.get(value, 'budget')
    if (budget !== undefined && (typeof budget !== 'object' || budget === null || !positiveInteger(Reflect.get(budget, 'maxAgents')) || !positiveInteger(Reflect.get(budget, 'maxSteps')))) return false
    if (budget !== undefined) {
      for (const key of ['maxTokens', 'maxWallMs']) {
        const limit = Reflect.get(budget, key)
        if (limit !== undefined && !positiveInteger(limit)) return false
      }
    }
    const resume = Reflect.get(value, 'resume')
    return resume === undefined || typeof resume === 'function'
  } catch {
    return false
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

async function canonicalDirectory(input: string): Promise<string> {
  const root = await realpath(input)
  const details = await lstat(root)
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('workspace root must be a real directory')
  return root
}

function defaultDecodeResult(input: HarnessAgentResultInput): unknown {
  return decodeHarnessAgentResult({ request: input.request, assistant: input.assistant, hostUsage: input.hostUsage })
}
