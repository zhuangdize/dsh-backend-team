import {
  AgentCapabilitySetSchema,
  AgentBudgetSchema,
  ArtifactReferenceSchema,
  AgentTaskSchema,
  BackendTeamPhaseSchema,
  PolicyContextSchema,
} from '@dsh-backend-team/contracts'
import type {
  AgentTask,
  PolicyAction,
  PolicyContext,
  PolicyEngine,
} from '@dsh-backend-team/contracts'
import { RolePolicy } from './role-policy.js'
import type { ExpertPreset } from './preset-loader.js'
import { intersectCapabilities, intersectPaths, isPathWithin, isSafeWorkspacePath, pathsOverlap } from './capability-intersection.js'

export interface DelegationArtifactHash {
  readonly path: string
  readonly sha256: string
}

export interface DelegationSnapshot {
  readonly phase: PolicyContext['phase']
  readonly designApproved: boolean
  readonly childCount: number
  readonly artifactHashes: readonly DelegationArtifactHash[]
  readonly remainingBudget: AgentTask['budget']
  readonly ownedWritePaths: readonly string[]
  readonly occupiedWritePaths: readonly string[]
  readonly policyContext: PolicyContext
}

export interface DelegationAllowDecision {
  readonly effect: 'allow'
  readonly task: AgentTask
}

export interface DelegationOptions {
  readonly preset: ExpertPreset
  readonly snapshot: DelegationSnapshot
  readonly policyEngine: PolicyEngine
}

function deny(message: string): never { throw new Error(message) }

function sameArtifacts(left: readonly DelegationArtifactHash[], right: readonly DelegationArtifactHash[]): boolean {
  if (left.length !== right.length) return false
  const expected = new Map(right.map((artifact) => [artifact.path, artifact.sha256]))
  return left.every((artifact) => expected.get(artifact.path) === artifact.sha256) && expected.size === left.length
}

function minBudget(...budgets: readonly AgentTask['budget'][]): AgentTask['budget'] {
  return {
    maxTokens: Math.min(...budgets.map((budget) => budget.maxTokens)),
    maxWallMs: Math.min(...budgets.map((budget) => budget.maxWallMs)),
    maxToolCalls: Math.min(...budgets.map((budget) => budget.maxToolCalls)),
    maxRetries: Math.min(...budgets.map((budget) => budget.maxRetries)),
    // Depth-two workers cannot delegate, regardless of the requested value.
    maxChildren: 0,
  }
}

function assertSelfContained(proposed: AgentTask): void {
  if (proposed.objective.trim().length === 0 || proposed.nonGoals.length === 0 || proposed.doneWhen.length === 0) deny('child task must be self-contained')
  if (proposed.verification.length === 0 || proposed.returnSchema.trim().length === 0) deny('child task must define verification and return schema')
}

function actionForPath(kind: 'read' | 'write', targetPath: string): PolicyAction {
  return { kind, targetPath }
}

/** Authorizes an expert-created worker using only the current immutable snapshot. */
export class DelegationGuard {
  constructor(private readonly options: DelegationOptions) {}

  async authorizeChild(parent: AgentTask, proposed: AgentTask): Promise<DelegationAllowDecision> {
    const { preset, snapshot, policyEngine } = this.options
    const parentResult = AgentTaskSchema.safeParse(parent)
    if (!parentResult.success) deny('parent task is invalid')
    const phaseResult = BackendTeamPhaseSchema.safeParse(snapshot.phase)
    if (!phaseResult.success) deny('delegation phase is invalid')
    const contextResult = PolicyContextSchema.safeParse(snapshot.policyContext)
    if (!contextResult.success) deny('policy context is invalid')
    const remainingBudgetResult = AgentBudgetSchema.safeParse(snapshot.remainingBudget)
    if (!remainingBudgetResult.success) deny('remaining budget is invalid')
    const currentArtifacts = snapshot.artifactHashes.map((artifact) => {
      const result = ArtifactReferenceSchema.safeParse(artifact)
      if (!result.success) deny('current artifact hashes are invalid')
      if (!isSafeWorkspacePath(result.data.path)) deny('current artifact path is unsafe')
      return result.data
    })
    if (snapshot.childCount < 0 || !Number.isInteger(snapshot.childCount)) deny('child count is invalid')
    if (snapshot.ownedWritePaths.some((path) => !isSafeWorkspacePath(path)) || snapshot.occupiedWritePaths.some((path) => !isSafeWorkspacePath(path))) deny('ownership snapshot contains an unsafe path')
    const validatedParent = parentResult.data
    if (validatedParent.depth !== 1 || validatedParent.role === 'coordinator' || validatedParent.role === 'worker') deny('maximum agent depth reached')
    if (!validatedParent.capabilities.canDelegate) deny('parent delegation capability is not granted')
    if (snapshot.childCount >= Math.min(3, validatedParent.budget.maxChildren, remainingBudgetResult.data.maxChildren)) deny('maximum children exceeded')
    if (!snapshot.designApproved) deny('design approval is required before delegation')
    if (validatedParent.role !== preset.role) deny('parent role does not match the expert preset')
    if (!preset.allowedPhases.includes(phaseResult.data)) deny('expert preset is not allowed in the current phase')
    if (contextResult.data.phase !== phaseResult.data) deny('policy context phase is stale')
    assertSelfContained(proposed)
    if (proposed.id === validatedParent.id) deny('child task ID must differ from parent task ID')
    if (!sameArtifacts(validatedParent.inputArtifacts, currentArtifacts)) deny('parent input artifacts are stale')
    if (!sameArtifacts(proposed.inputArtifacts, currentArtifacts)) deny('child input artifacts are stale')

    const requestedReadPaths = proposed.readPaths
    const requestedWritePaths = proposed.writePaths
    if ([...requestedReadPaths, ...requestedWritePaths].some((path) => !isSafeWorkspacePath(path))) deny('child path is unsafe')
    const readPaths = intersectPaths(validatedParent.readPaths, requestedReadPaths, preset.readPathPatterns)
    if (readPaths.length !== requestedReadPaths.length) deny('child read path exceeds parent or preset scope')
    const policy = new RolePolicy({ designApproved: snapshot.designApproved })
    const writePatterns = preset.role === 'tester' ? policy.writePathPatterns(preset.role, phaseResult.data) : preset.writePathPatterns
    const writePaths = intersectPaths(validatedParent.writePaths, requestedWritePaths, writePatterns)
    if (writePaths.length !== requestedWritePaths.length) deny('child write path is unowned or exceeds preset scope')
    if (writePaths.some((path) => snapshot.occupiedWritePaths.some((occupied) => pathsOverlap(path, occupied)))) deny('child write path overlaps an occupied path')
    if (writePaths.some((path) => !snapshot.ownedWritePaths.some((owned) => isPathWithin(path, owned)))) deny('child write path is outside ownership')

    const roleMaximum = policy.maxCapabilities(preset.role, phaseResult.data)
    const presetMaximum = AgentCapabilitySetSchema.parse(preset.defaultCapabilities)
    const capabilities = intersectCapabilities(validatedParent.capabilities, proposed.capabilities, roleMaximum, presetMaximum)
    if (requestedReadPaths.length > 0 && !capabilities.readProjectFiles) deny('child read capability is not granted')
    if (requestedWritePaths.length > 0 && !capabilities.writeOwnedFiles) deny('child write capability is not granted')
    for (const path of readPaths) await this.requirePolicy(policyEngine, actionForPath('read', path), contextResult.data)
    for (const path of writePaths) await this.requirePolicy(policyEngine, actionForPath('write', path), contextResult.data)

    const budget = minBudget(proposed.budget, validatedParent.budget, remainingBudgetResult.data, preset.defaultBudget)
    const task = AgentTaskSchema.parse({
      id: proposed.id,
      parentTaskId: validatedParent.id,
      depth: 2,
      role: 'worker',
      objective: proposed.objective,
      nonGoals: proposed.nonGoals,
      inputArtifacts: currentArtifacts,
      readPaths,
      writePaths,
      capabilities,
      budget,
      doneWhen: proposed.doneWhen,
      verification: proposed.verification,
      returnSchema: proposed.returnSchema,
    })
    return { effect: 'allow', task }
  }

  private async requirePolicy(engine: PolicyEngine, action: PolicyAction, context: PolicyContext): Promise<void> {
    const decision = await engine.authorize(action, context)
    if (decision.effect !== 'allow') deny(`policy denied child ${action.kind} path: ${decision.reason}`)
  }
}
