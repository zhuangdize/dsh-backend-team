import type { BackendTeamEvent, BackendTeamState } from './state.js'
import type { PolicyAction, PolicyContext, PolicyDecision } from './policy.js'
import type { AgentTask } from './agent-task.js'
import type { AgentHandoff } from './handoff.js'

export interface CommandRequest {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly purpose: string
  readonly risk: 'read' | 'write' | 'install' | 'migration' | 'destructive'
  readonly executionFingerprint: string
  /** Runtime/install commands must explicitly deny network access. */
  readonly networkPolicy?: 'deny' | 'allow'
  /** Immutable digest required by an install plan for its executable, when applicable. */
  readonly expectedExecutableSha256?: string
  readonly approvalToken?: string
}

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly outputLimitExceeded?: boolean
}

export interface CommandRunner {
  run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult>
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

export interface JsonObject {
  readonly [key: string]: JsonValue
}

/** Application-layer tool shape; not a DeepSeek Harness ToolDefinition. */
export interface BackendTeamApplicationTool {
  readonly name: string
  readonly description: string
  execute(input: unknown, signal?: AbortSignal): Promise<unknown>
}

export interface ApprovalRequest {
  readonly kind: 'requirements' | 'design' | 'install' | 'migration' | 'shared-config'
  readonly summary: string
  readonly artifactHashes: Readonly<Record<string, string>>
}

/** Application-side revision context; this is not a DeepSeek Harness API. */
export interface ApprovalRequestContext {
  readonly stateRevision: number
}

/** Provenance supplied by the authenticated user-facing control route. */
export interface ApprovalProvenance {
  readonly sessionId: string
  readonly taskId?: string
}

export interface ApprovalDecision {
  readonly effect: 'approve' | 'reject' | 'edit'
  readonly reason: string
  readonly provenance?: ApprovalProvenance
}

export interface AgentSpawnRequest {
  readonly task: string
  readonly role: string
  readonly context: JsonObject
  /** Optional structured Task 1 contract; legacy callers continue to use task/role/context. */
  readonly agentTask?: AgentTask
  /** Narrow depth-one delegation seam. Workers never receive this callback. */
  readonly delegation?: AgentDelegation
}

export interface AgentDelegation {
  readonly delegateWorker: (task: AgentTask) => Promise<AgentHandoff>
}

export interface AgentHandle {
  readonly id: string
  result(signal?: AbortSignal): Promise<unknown>
  cancel(): Promise<void>
}

/**
 * Application orchestration port. This is deliberately not the DeepSeek
 * Harness host API; the official host surface lives in harness-adapter.
 */
export interface BackendTeamOrchestrationPort {
  requestApproval(request: ApprovalRequest, context?: ApprovalRequestContext): Promise<ApprovalDecision>
  /** Implementations must reject a pending spawn when the signal is aborted. */
  spawnAgent(request: AgentSpawnRequest, signal?: AbortSignal): Promise<AgentHandle>
  emit(event: BackendTeamEvent): Promise<void>
}

export interface StateStore {
  load(): Promise<BackendTeamState | null>
  create(initial: BackendTeamState): Promise<void>
  transact(
    expectedRevision: number,
    change: StateMutation,
  ): Promise<BackendTeamState>
}

export type StateMutation = (state: BackendTeamState) => BackendTeamState

export type { PolicyAction, PolicyContext, PolicyDecision }
