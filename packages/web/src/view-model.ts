import { z } from 'zod'
import { ApprovalKindSchema, BackendTeamEventSchema, BackendTeamPhaseSchema, RunStatusSchema, DeliveryReviewSchema } from '@dsh-backend-team/contracts'
import type { BackendTeamEvent, BackendTeamState, RunStatus } from '@dsh-backend-team/contracts'

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
export const BackendTeamViewStateSchema = z.object({
  approvalHistory: z.array(z.object({
    kind: ApprovalKindSchema,
    approvedAt: z.string().datetime(),
    artifactHashes: z.record(z.string(), Sha256).optional(),
    provenance: z.object({ status: z.enum(['verified', 'unknown']), sessionId: z.string().min(16).optional(), taskId: z.string().uuid().optional() }).strict().optional(),
  }).strict()).optional(),
  taskId: z.string().min(1).optional(),
  taskHistory: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), phase: BackendTeamPhaseSchema, reportPath: z.string().optional() }).strict()).optional(),
  workflowRetryAvailable: z.boolean().optional(),
  schemaVersion: z.literal(1), workspaceName: z.string().min(1), workspaceId: z.string().min(1).optional(), phase: BackendTeamPhaseSchema,
  compatibility: z.object({ mode: z.enum(['supported', 'read-only']), reason: z.string().min(1).optional() }).strict(),
  approvalRetryAvailable: z.boolean().optional(),
  executionAvailable: z.boolean().optional(),
  developmentRun: z.object({ delivery: DeliveryReviewSchema.optional(), message: z.string().max(1000).optional(), step: z.enum(['implementation', 'final-verification']).optional(), status: z.enum(['idle', 'running', 'pausing', 'paused', 'passed', 'failed', 'blocked']) }).strict().optional(),
  activity: z.array(z.object({ id: z.string().min(1), sequence: z.number().int().positive(), occurredAt: z.string().datetime(), kind: z.enum(['stage', 'run', 'approval']), label: z.string().min(1).max(120) }).strict()).max(20).optional(),
  lastProgressAt: z.string().datetime().optional(),
  pendingApproval: z.object({ id: z.string().min(1), kind: ApprovalKindSchema, summary: z.string().min(1), artifactHash: Sha256 }).strict().optional(),
  experts: z.array(z.object({ id: z.string().min(1), role: z.string().min(1), status: RunStatusSchema, taskSummary: z.string().min(1), childCount: z.number().int().nonnegative() }).strict()),
  risk: z.object({ level: z.enum(['normal', 'attention', 'blocked']), messages: z.array(z.string().min(1)) }).strict(),
  database: z.object({ runtime: z.enum(['not-installed', 'stopped', 'starting', 'ready', 'failed']), engine: z.string().min(1), guiAvailable: z.boolean(), controlsAvailable: z.boolean().optional(), migrationAvailable: z.boolean().optional(), migrationMessage: z.string().max(1000).optional() }).strict(),
  verification: z.object({ total: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), blocked: z.number().int().nonnegative(), reportPath: z.string().min(1).optional() }).strict(),
  usage: z.object({ activeExperts: z.number().int().nonnegative(), activeWorkers: z.number().int().nonnegative(), concurrentWriters: z.number().int().nonnegative(), remainingTaskBudget: z.number().int().nonnegative() }).strict(),
  lastSequence: z.number().int().nonnegative(), stateRevision: z.number().int().nonnegative(),
}).strict()
export type BackendTeamViewState = z.infer<typeof BackendTeamViewStateSchema>

export interface PendingApprovalFeed {
  listPending(): readonly { readonly id: string; readonly workspaceId: string; readonly stateRevision: number; readonly artifactHash: string; readonly request: { readonly kind: NonNullable<BackendTeamViewState['pendingApproval']>['kind']; readonly summary: string } }[]
  subscribe(listener: () => void): () => void
}

export interface DevelopmentRunFeed { snapshot(): { readonly status: 'idle' | 'running' | 'pausing' | 'paused' | 'passed' | 'failed' | 'blocked' }; subscribe(listener: () => void): () => void }

export interface DatabaseStatusFeed { snapshot(): BackendTeamViewState['database']; subscribe(listener: () => void): () => void }
export interface ViewProjectorOptions { readonly databaseFeed?: DatabaseStatusFeed; readonly developmentRun?: DevelopmentRunFeed; readonly approvals?: PendingApprovalFeed; readonly workspaceName: string; readonly workspaceId?: string; readonly compatibility?: BackendTeamViewState['compatibility']; readonly database?: BackendTeamViewState['database']; readonly usage?: BackendTeamViewState['usage']; readonly initialState?: Partial<BackendTeamViewState> }
export interface ReplayResult { readonly state: BackendTeamViewState; readonly lastSequence: number; readonly appliedEventIds: readonly string[] }

export function viewStateFromCore(state: BackendTeamState, options: ViewProjectorOptions): BackendTeamViewState {
  const experts = state.runs.map((run) => ({ id: run.id, role: 'coordinator', status: run.status, taskSummary: run.summary ?? '后端开发任务', childCount: 0 }))
  return BackendTeamViewStateSchema.parse({ schemaVersion: 1, workspaceName: options.workspaceName, ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }), compatibility: options.compatibility ?? { mode: 'supported' }, experts, risk: { level: 'normal', messages: [] }, database: options.database ?? { runtime: 'not-installed', engine: 'PostgreSQL 18.6', guiAvailable: false }, verification: { total: 0, passed: 0, failed: 0, blocked: 0 }, usage: options.usage ?? { activeExperts: 0, activeWorkers: 0, concurrentWriters: 0, remainingTaskBudget: 0 }, lastSequence: 0, ...options.initialState, approvalHistory: state.approvals.map(approvalHistoryItem), phase: state.phase, stateRevision: state.revision })
}

function approvalHistoryItem(item: BackendTeamState['approvals'][number]) {
  return {
    kind: item.kind,
    approvedAt: item.approvedAt,
    artifactHashes: item.artifactHashes,
    provenance: item.provenance === undefined
      ? { status: 'unknown' as const }
      : { status: 'verified' as const, ...item.provenance },
  }
}

export class BackendTeamViewProjector {
  private readonly options: ViewProjectorOptions
  private view: BackendTeamViewState
  private readonly acceptedEvents = new Map<string, BackendTeamEvent>()
  private readonly acceptedSequences = new Map<number, string>()
  constructor(options: ViewProjectorOptions) { this.options = options; this.view = BackendTeamViewStateSchema.parse({ schemaVersion: 1, workspaceName: options.workspaceName, ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }), phase: 'DISCOVER', compatibility: options.compatibility ?? { mode: 'supported' }, experts: [], risk: { level: 'normal', messages: [] }, database: options.database ?? { runtime: 'not-installed', engine: 'PostgreSQL 18.6', guiAvailable: false }, verification: { total: 0, passed: 0, failed: 0, blocked: 0 }, usage: options.usage ?? { activeExperts: 0, activeWorkers: 0, concurrentWriters: 0, remainingTaskBudget: 0 }, lastSequence: 0, stateRevision: 0, ...options.initialState }) }
  replay(events: readonly BackendTeamEvent[]): ReplayResult {
    const unique = new Map<string, BackendTeamEvent>(); const sequenceOwners = new Map<number, string>()
    for (const candidate of events) { const event = BackendTeamEventSchema.parse(candidate); const existing = unique.get(event.id) ?? this.acceptedEvents.get(event.id); if (existing !== undefined) { if (JSON.stringify(existing) !== JSON.stringify(event)) throw new Error('conflicting duplicate event id'); continue }; const owner = sequenceOwners.get(event.sequence) ?? this.acceptedSequences.get(event.sequence); if (owner !== undefined && owner !== event.id) throw new Error('conflicting event sequence'); sequenceOwners.set(event.sequence, event.id); unique.set(event.id, event) }
    const ordered = [...unique.values()].sort((left, right) => left.sequence - right.sequence)
    const fresh = ordered.filter((event) => event.sequence > this.view.lastSequence)
    let current = this.view
    for (const event of fresh) current = applyEvent(current, event)
    this.view = current; for (const event of fresh) { this.acceptedEvents.set(event.id, event); this.acceptedSequences.set(event.sequence, event.id) } return { state: current, lastSequence: current.lastSequence, appliedEventIds: fresh.map((event) => event.id) }
  }
  snapshot(): BackendTeamViewState {
    const base = this.options.databaseFeed === undefined ? this.view : BackendTeamViewStateSchema.parse({ ...this.view, database: this.options.databaseFeed.snapshot() })
    const view = this.options.developmentRun === undefined ? base : BackendTeamViewStateSchema.parse({ ...base, developmentRun: this.options.developmentRun.snapshot() })
    if (this.options.approvals === undefined) return view
    const pending = this.options.approvals.listPending().find((item) => item.workspaceId === this.view.workspaceId && item.stateRevision === this.view.stateRevision && (item.request.kind === 'migration' || (item.request.kind === 'requirements' && this.view.phase === 'AWAIT_REQUIREMENTS_APPROVAL') || (item.request.kind === 'design' && this.view.phase === 'AWAIT_DESIGN_APPROVAL')))
    return BackendTeamViewStateSchema.parse({ ...view, pendingApproval: pending === undefined ? undefined : { id: pending.id, kind: pending.request.kind, summary: pending.request.summary, artifactHash: pending.artifactHash } })
  }
}

function applyEvent(view: BackendTeamViewState, event: BackendTeamEvent): BackendTeamViewState {
  const base = { ...view, lastSequence: Math.max(view.lastSequence, event.sequence), stateRevision: Math.max(view.stateRevision, event.revision) }
  if (event.type === 'phase-changed') return { ...base, phase: event.phase, activity: appendActivity(view.activity, { id: event.id, sequence: event.sequence, occurredAt: event.occurredAt, kind: 'stage', label: `进入${phaseLabel(event.phase)}` }), lastProgressAt: event.occurredAt }
  if (event.type === 'run-recorded') { const expert = { id: event.run.id, role: 'coordinator', status: event.run.status as RunStatus, taskSummary: event.run.summary ?? '后端开发任务', childCount: 0 }; return { ...base, experts: [...view.experts.filter((item) => item.id !== expert.id), expert], activity: appendActivity(view.activity, { id: event.id, sequence: event.sequence, occurredAt: event.occurredAt, kind: 'run', label: event.run.status === 'passed' ? '完成一次执行' : event.run.status === 'failed' || event.run.status === 'blocked' ? '执行遇到阻塞' : '开始执行' }), lastProgressAt: event.occurredAt } }
  if (event.type === 'approval-recorded') {
    const approvalHistory = [...(view.approvalHistory ?? []).filter(item => item.kind !== event.approval.kind), approvalHistoryItem(event.approval)]
    const next = { ...base, approvalHistory, activity: appendActivity(view.activity, { id: event.id, sequence: event.sequence, occurredAt: event.occurredAt, kind: 'approval', label: `记录${event.approval.kind === 'requirements' ? '需求' : event.approval.kind === 'design' ? '设计' : event.approval.kind}审批` }), lastProgressAt: event.occurredAt }
    return view.pendingApproval?.kind === event.approval.kind && Object.values(event.approval.artifactHashes).includes(view.pendingApproval.artifactHash) ? { ...next, pendingApproval: undefined } : next
  }
  return base
}

function appendActivity(current: BackendTeamViewState['activity'], item: NonNullable<BackendTeamViewState['activity']>[number]): NonNullable<BackendTeamViewState['activity']> {
  return [...(current ?? []).filter(existing => existing.id !== item.id), item].sort((a, b) => a.sequence - b.sequence).slice(-20)
}

function phaseLabel(phase: BackendTeamViewState['phase']): string {
  if (phase === 'DISCOVER' || phase === 'SPECIFY' || phase === 'AWAIT_REQUIREMENTS_APPROVAL') return '需求分析'
  if (phase === 'DESIGN' || phase === 'AWAIT_DESIGN_APPROVAL' || phase === 'PLAN') return '方案设计'
  if (phase === 'BUILD') return '功能开发'
  if (phase === 'VERIFY') return '测试验收'
  return '交付'
}
