import { AgentResultSchema, AgentTaskSchema } from '@dsh-backend-team/contracts'
import type { AgentResult, AgentRole, AgentSpawnRequest, BackendTeamOrchestrationPort, BackendTeamPhase, StateStore } from '@dsh-backend-team/contracts'
import { assertTransition } from './state-machine.js'
import { buildContextPacket, type ContextPacket, type ContextPrompt } from './context-packet.js'
import { specificationOutputInstructions } from './specification-output-instructions.js'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export type LoadedCommand = ContextPrompt
export interface SpecKitCommandLoaderPort { load(command: string, args: string): LoadedCommand | Promise<LoadedCommand> }
export interface FeatureArtifactSnapshot { readonly path: string; readonly sha256: string }
export interface FeatureArtifactsSnapshot { readonly featureDirectory: string; readonly artifacts: readonly FeatureArtifactSnapshot[] }
export interface ArtifactRegistryPort { snapshot(): FeatureArtifactsSnapshot | Promise<FeatureArtifactsSnapshot> }
export interface ArtifactValidationError { readonly code?: string; readonly file?: string; readonly heading?: string; readonly message?: string }
export interface ArtifactValidationResult { readonly valid?: boolean; readonly errors?: readonly ArtifactValidationError[] }
export interface ArtifactValidatorPort { validateForGate(gate: 'requirements' | 'design'): ArtifactValidationResult | Promise<ArtifactValidationResult> }
/** Host supplies the real executable-plan loader; errors must propagate. */
export interface TaskPlanLoaderPort { load(): Promise<unknown> }
export interface ApprovalServicePort { requestRequirementsApproval(): Promise<unknown>; requestDesignApproval(): Promise<unknown>; verifyActiveApproval(gate: 'requirements' | 'design'): Promise<void> }
export interface SpecificationBudget {
  readonly maxAgents: number
  readonly maxSteps: number
  readonly maxTokens?: number
  readonly maxWallMs?: number
}
export interface SpecificationCoordinatorOptions {
  readonly workspaceRoot: string
  readonly stateStore: StateStore
  readonly commandLoader: SpecKitCommandLoaderPort
  readonly artifactRegistry: ArtifactRegistryPort
  readonly artifactValidator: ArtifactValidatorPort
  readonly taskPlanLoader?: TaskPlanLoaderPort
  readonly approvalService: ApprovalServicePort
  readonly orchestration: Pick<BackendTeamOrchestrationPort, 'spawnAgent'>
  readonly budget?: SpecificationBudget
}

const DEFAULT_BUDGET = Object.freeze({ maxAgents: 3, maxSteps: 24, maxTokens: 131_072, maxWallMs: 180_000 })
/** The runtime may spend one retry on a repairable result envelope; no child delegation is permitted. */
const TASK_BUDGET = Object.freeze({ maxRetries: 1, maxChildren: 0 })
const COORDINATOR_TASK_ID = 'coordinator-specification'
const SPECIFICATION_ARTIFACT_NAMES = new Set([
  'spec.md', 'clarification.md', 'plan.md', 'architecture.md', 'data-model.md',
  'test-plan.md', 'research.md', 'decisions.md', 'tasks.md', 'contracts/openapi.yaml',
])

export class SpecificationCoordinator {
  private readonly budget: Readonly<{ maxAgents: number; maxSteps: number; maxTokens: number; maxWallMs: number }>
  private readonly taskNamespace = randomUUID()
  private objective = ''
  private taskSequence = 0
  private operationRunning = false
  constructor(private readonly options: SpecificationCoordinatorOptions) {
    if (options.budget !== undefined && (typeof options.budget !== 'object' || options.budget === null)) throw new Error('coordinator budget is invalid')
    const supplied = options.budget
    this.budget = {
      maxAgents: supplied === undefined ? DEFAULT_BUDGET.maxAgents : supplied.maxAgents,
      maxSteps: supplied === undefined ? DEFAULT_BUDGET.maxSteps : supplied.maxSteps,
      maxTokens: supplied === undefined || supplied.maxTokens === undefined ? DEFAULT_BUDGET.maxTokens : supplied.maxTokens,
      maxWallMs: supplied === undefined || supplied.maxWallMs === undefined ? DEFAULT_BUDGET.maxWallMs : supplied.maxWallMs,
    }
    if (!Number.isSafeInteger(this.budget.maxAgents) || this.budget.maxAgents < 1 || !Number.isSafeInteger(this.budget.maxSteps) || this.budget.maxSteps < 1 || !Number.isSafeInteger(this.budget.maxTokens) || this.budget.maxTokens < 1 || !Number.isSafeInteger(this.budget.maxWallMs) || this.budget.maxWallMs < 1) throw new Error('coordinator budget is invalid')
  }

  async start(objective: string): Promise<void> { await this.exclusive(() => this.startWork(objective)) }
  private async startWork(objective: string): Promise<void> {
    if (typeof objective !== 'string' || objective.trim().length === 0) throw new Error('coordinator objective is required')
    const state = await this.options.stateStore.load()
    if (state === null) throw new Error('backend team state has not been created')
    if (state.phase === 'DISCOVER') await this.advance('DISCOVER', 'SPECIFY')
    else if (state.phase !== 'SPECIFY') throw new Error(`cannot run coordinator action in phase ${state.phase}; expected SPECIFY`)
    this.objective = objective
    const prompt = await this.options.commandLoader.load('speckit.specify', objective)
    const artifacts = await this.options.artifactRegistry.snapshot()
    await this.spawn('requirements', 'Refine the request into complete requirements and clarification artifacts.', prompt, artifacts, ['spec.md', 'clarification.md'], ['spec.md', 'clarification.md'])
    await this.requireValid('requirements')
    await this.advance('SPECIFY', 'AWAIT_REQUIREMENTS_APPROVAL')
  }

  /**
   * Reopens the requirements stage for user-provided clarification. The
   * clarification itself is only input to the official Spec Kit command; it
   * never constitutes approval and therefore always returns to the same
   * requirements approval gate after the artifacts are regenerated.
   */
  async refine(clarification: string): Promise<void> { await this.exclusive(() => this.refineWork(clarification)) }
  private async refineWork(clarification: string): Promise<void> {
    if (typeof clarification !== 'string' || clarification.trim().length === 0) throw new Error('clarification must be non-empty')
    await this.requirePhase('AWAIT_REQUIREMENTS_APPROVAL')
    await this.advance('AWAIT_REQUIREMENTS_APPROVAL', 'SPECIFY')
    const prompt = await this.options.commandLoader.load('speckit.clarify', clarification)
    const artifacts = await this.options.artifactRegistry.snapshot()
    await this.spawn('requirements', 'Incorporate the user clarification into the requirements and acceptance artifacts.', prompt, artifacts, ['spec.md', 'clarification.md'], ['spec.md', 'clarification.md'])
    await this.requireValid('requirements')
    await this.advance('SPECIFY', 'AWAIT_REQUIREMENTS_APPROVAL')
  }

  async approveRequirements(): Promise<void> { await this.options.approvalService.requestRequirementsApproval() }

  async design(): Promise<void> { await this.exclusive(() => this.designWork()) }
  async refineDesign(clarification: string): Promise<void> {
    if (!clarification.trim()) throw new Error('design clarification is required')
    await this.exclusive(async () => {
      await this.requirePhase('AWAIT_DESIGN_APPROVAL')
      await this.advance('AWAIT_DESIGN_APPROVAL', 'DESIGN')
      await this.designWork(clarification)
    })
  }
  private async designWork(clarification?: string): Promise<void> {
    await this.requirePhase('DESIGN')
    await this.options.approvalService.verifyActiveApproval('requirements')
    const prompt = await this.options.commandLoader.load('speckit.plan', 'Design the approved backend requirements.' + (clarification === undefined ? '' : `\nRevise the draft design according to this user feedback, preserving approved requirements:\n${clarification}`))
    const designTasks: readonly [AgentRole, string, readonly string[], readonly string[]][] = [
      ['backend-architect', 'Produce the backend architecture, implementation plan, and API contract.', ['plan.md', 'architecture.md', 'contracts/openapi.yaml'], ['plan.md', 'architecture.md', 'contracts/openapi.yaml']],
      ['database-designer', 'Produce the PostgreSQL data model and its executable test plan.', ['data-model.md', 'test-plan.md'], ['data-model.md', 'test-plan.md']],
      ['oss-researcher', 'Research open-source choices and record decisions and evidence.', ['research.md', 'decisions.md'], ['research.md', 'decisions.md']],
    ]
    const [architect, ...followups] = designTasks
    if (architect !== undefined) await this.spawn(architect[0], architect[1], prompt, await this.options.artifactRegistry.snapshot(), architect[2], architect[3])
    await runBounded(followups, this.budget.maxAgents, async ([role, task, schema, ownership]) => this.spawn(role, task, prompt, await this.options.artifactRegistry.snapshot(), schema, ownership))
    await this.requireValid('design')
    await this.advance('DESIGN', 'AWAIT_DESIGN_APPROVAL')
  }

  async approveDesign(): Promise<void> { await this.options.approvalService.requestDesignApproval() }

  async generateTasks(): Promise<void> { await this.exclusive(() => this.generateTasksWork()) }
  private async generateTasksWork(): Promise<void> {
    await this.requirePhase('PLAN')
    await this.options.approvalService.verifyActiveApproval('design')
    if (typeof this.options.taskPlanLoader?.load !== 'function') throw new Error('task plan loader is required before generating implementation tasks')
    const prompt = await this.options.commandLoader.load('speckit.tasks', 'Create implementation tasks from the approved design.')
    const artifacts = await this.options.artifactRegistry.snapshot()
    await this.spawn('planner', 'Create implementation tasks only; do not modify business code.', prompt, artifacts, ['tasks.md'], ['tasks.md'])
    if ((await this.options.artifactRegistry.snapshot()).featureDirectory !== artifacts.featureDirectory) throw new Error('specification feature changed during task generation')
    try { await this.options.taskPlanLoader.load() }
    catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'Executable plan is invalid'
      const repair = await this.options.commandLoader.load('speckit.tasks', `Repair tasks.md only. Host plan validation failed: ${reason}. Preserve approved design and exact evidence-to-AC mappings. Use concrete file paths, never directories. Group a small API into one end-to-end slice, not separate per-layer or host-only slices. Each task evidence ID may cover only the AC IDs bound to that ID in test-plan.md. Host final verification runs automatically; do not create an extra all-AC task with unrelated evidence IDs.`)
      await this.spawn('planner', 'Correct the executable task plan using the host validation error.', repair, await this.options.artifactRegistry.snapshot(), ['tasks.md'], ['tasks.md'])
      await this.options.taskPlanLoader.load()
    }
    await this.options.approvalService.verifyActiveApproval('design')
    await this.advance('PLAN', 'BUILD')
  }

  private async exclusive(operation: () => Promise<void>): Promise<void> {
    if (this.operationRunning) throw new Error('specification operation is already running')
    this.operationRunning = true
    try {
      const previous = await this.options.stateStore.load()
      if (previous?.workflowError !== undefined) await this.options.stateStore.transact(previous.revision, state => { const { workflowError: _error, ...rest } = state; void _error; return rest })
      await operation()
    } catch (error: unknown) {
      const state = await this.options.stateStore.load()
      if (state !== null) await this.options.stateStore.transact(state.revision, current => ({ ...current, workflowError: (error instanceof Error ? error.message : '文档工作流未完成').slice(0, 1000) })).catch(() => undefined)
      throw error
    } finally { this.operationRunning = false }
  }

  private async spawn(role: AgentRole, task: string, prompt: LoadedCommand, artifacts: FeatureArtifactsSnapshot, schema: readonly string[], ownership: readonly string[]): Promise<AgentResult> {
    const featurePrefix = workspaceFeaturePrefix(this.options.workspaceRoot, artifacts.featureDirectory)
    const allArtifacts = normalizeInputArtifacts(artifacts, featurePrefix)
    const designInputs: Partial<Record<AgentRole, readonly string[]>> = {
      'backend-architect': ['spec.md', 'clarification.md', 'plan.md', 'architecture.md', 'contracts/openapi.yaml'],
      'database-designer': ['spec.md', 'clarification.md', 'plan.md', 'architecture.md', 'contracts/openapi.yaml', 'data-model.md', 'test-plan.md'],
      'oss-researcher': ['spec.md', 'clarification.md', 'plan.md', 'architecture.md', 'research.md', 'decisions.md'],
    }
    const selected = designInputs[role]
    const inputArtifacts = selected === undefined ? allArtifacts : allArtifacts.filter(artifact => selected.some(path => artifact.path === `${featurePrefix}/${path}`))
    const requiredOutputSchema = schema.map((path) => prefixFeaturePath(path, featurePrefix, 'required output'))
    const pathOwnership = ownership.map((path) => prefixFeaturePath(path, featurePrefix, 'owned output'))
    const readPaths = [...new Set([...inputArtifacts.map((artifact) => artifact.path), ...pathOwnership])]
    const context = { ...buildContextPacket({ objective: this.objective || task, prompt, artifactHashes: Object.fromEntries(inputArtifacts.map((artifact) => [artifact.path, artifact.sha256])), requiredOutputSchema, pathOwnership, policySummary: 'Write only owned files under the active feature directory; no business-code, credential, shell-profile, global-tool, or raw-conversation access.', budget: this.budget }), outputInstructions: specificationOutputInstructions(role) }
    const agentTask = AgentTaskSchema.parse({
      id: `${COORDINATOR_TASK_ID}-${this.taskNamespace}-${role}-${++this.taskSequence}`,
      parentTaskId: COORDINATOR_TASK_ID,
      depth: 1,
      role,
      objective: task,
      nonGoals: ['Do not modify business code or files outside the active feature artifacts.'],
      inputArtifacts,
      readPaths,
      writePaths: pathOwnership,
      capabilities: {
        readProjectFiles: true,
        writeOwnedFiles: true,
        businessCodeWrite: false,
        testCodeWrite: false,
        configurationWrite: false,
        commandExecution: false,
        networkHosts: [],
        install: false,
        migration: false,
        canDelegate: false,
        canChangePhase: false,
        canApprove: false,
        canContactUser: false,
        canAnnounceCompletion: false,
      },
      budget: { maxTokens: this.budget.maxTokens, maxWallMs: this.budget.maxWallMs, maxToolCalls: this.budget.maxSteps, ...TASK_BUDGET },
      doneWhen: [`All required output artifacts are complete under ${featurePrefix}.`],
      verification: [{ id: 'artifact-review', kind: 'inspection', instruction: 'Review every required output artifact for completeness.', required: true }],
      returnSchema: 'AgentResult',
    })
    const request: AgentSpawnRequest = { role, task, context, agentTask }
    const handle = await this.options.orchestration.spawnAgent(request)
    const result = AgentResultSchema.parse(await handle.result())
    if (result.taskId !== agentTask.id) throw new Error(`agent result task ID does not match dispatched task ${agentTask.id}`)
    if (result.status !== 'passed') throw new Error(`agent result was not successful: ${result.status}`)
    assertConsumedBudget(agentTask, result)
    return result
  }

  private async requireValid(gate: 'requirements' | 'design'): Promise<void> { const result = await this.options.artifactValidator.validateForGate(gate); if (!(result.valid === true || (result.valid === undefined && (result.errors?.length ?? 0) === 0))) throw new Error(`${gate} artifacts are invalid`) }
  private async requirePhase(expected: BackendTeamPhase): Promise<void> { const state = await this.options.stateStore.load(); if (state === null) throw new Error('backend team state has not been created'); if (state.phase !== expected) throw new Error(`cannot run coordinator action in phase ${state.phase}; expected ${expected}`) }
  private async advance(from: BackendTeamPhase, to: BackendTeamPhase): Promise<void> { const state = await this.options.stateStore.load(); if (state === null || state.phase !== from) throw new Error(`coordinator phase changed before ${to}`); assertTransition(from, to); await this.options.stateStore.transact(state.revision, (current) => ({ ...current, phase: to })) }
}

async function runBounded<T, R>(items: readonly T[], limit: number, operation: (item: T) => Promise<R>): Promise<readonly R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await operation(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

function workspaceFeaturePrefix(workspaceRoot: string, featureDirectory: string): string {
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot) || workspaceRoot.includes('\0')) throw new Error('workspace root must be an absolute path')
  if (typeof featureDirectory !== 'string' || !isAbsolute(featureDirectory) || featureDirectory.includes('\0')) throw new Error('feature directory must be an absolute path')
  const root = resolve(workspaceRoot)
  const feature = resolve(featureDirectory)
  const relativePath = relative(root, feature).split(sep).join('/')
  if (relativePath.length === 0 || relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath) || relativePath === 'specs' || !relativePath.startsWith('specs/') || relativePath.split('/').length !== 2) throw new Error('feature directory must be exactly workspace/specs/<feature>')
  return relativePath
}

function normalizeInputArtifacts(snapshot: FeatureArtifactsSnapshot, featurePrefix: string): readonly { readonly path: string; readonly sha256: string }[] {
  if (!Array.isArray(snapshot.artifacts)) throw new Error('artifact snapshot is invalid')
  const artifacts = snapshot.artifacts.map((artifact) => {
    const path = prefixFeaturePath(artifact.path, featurePrefix, 'input artifact')
    const featureRelativePath = path.slice(featurePrefix.length + 1)
    if (!SPECIFICATION_ARTIFACT_NAMES.has(featureRelativePath)) throw new Error(`artifact registry contains unsupported specification input artifact: ${featureRelativePath}`)
    return { path, sha256: artifact.sha256 }
  })
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) throw new Error('artifact snapshot contains duplicate paths')
  return artifacts
}

function prefixFeaturePath(path: string, featurePrefix: string, label: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || path.includes('\\') || path.startsWith('/') || path.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) throw new Error(`${label} path is invalid`)
  if (path === featurePrefix || path.startsWith(`${featurePrefix}/`)) return path
  if (path.startsWith('specs/')) throw new Error(`${label} path is outside the active feature directory`)
  return `${featurePrefix}/${path}`
}

function assertConsumedBudget(task: { readonly budget: { readonly maxTokens: number; readonly maxWallMs: number; readonly maxToolCalls: number; readonly maxRetries: number; readonly maxChildren: number } }, result: AgentResult): void {
  const usage = result.consumedBudget
  const limits: readonly [number, number, string][] = [
    [usage.tokens, task.budget.maxTokens, 'tokens'],
    [usage.wallMs, task.budget.maxWallMs, 'wall-clock milliseconds'],
    [usage.toolCalls, task.budget.maxToolCalls, 'tool calls'],
    [usage.retries, task.budget.maxRetries, 'retries'],
    [usage.children, task.budget.maxChildren, 'children'],
  ]
  for (const [consumed, maximum, name] of limits) if (consumed > maximum) throw new Error(`agent result consumed budget exceeds ${name} limit: used ${consumed}, maximum ${maximum}`)
  if (result.childResultIds.length > task.budget.maxChildren) throw new Error('agent result consumed budget exceeds children limit')
}

export type { ContextPacket }
