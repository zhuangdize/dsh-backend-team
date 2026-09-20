import type { BackendTeamPhase, RunStatus } from '@dsh-backend-team/contracts'
import type { BackendTeamViewState } from './view-model.js'

export type BackendTeamPanelActionType = 'diagnose' | 'open-artifact' | 'start-database' | 'open-database-gui' | 'retry-failed-step' | 'pause-run' | 'resume-run' | 'none'

export interface BackendTeamPanelAction {
  readonly type: BackendTeamPanelActionType
  readonly label: string
  readonly enabled: boolean
  readonly artifactId?: string
  readonly stepId?: string
}

export interface BackendTeamPanelApproval {
  readonly required: true
  readonly id: string
  readonly kind: string
  readonly summary: string
  readonly artifactHash: string
  readonly viewed: boolean
  readonly canConfirm: boolean
  readonly viewAction: BackendTeamPanelAction & { readonly type: 'open-artifact'; readonly artifactId: string }
  readonly confirmAction: BackendTeamPanelConfirmAction
}

export interface BackendTeamPanelConfirmAction {
  readonly type: 'decide-approval'
  readonly label: string
  readonly enabled: boolean
  readonly approvalId: string
  readonly artifactHash: string
  readonly expectedRevision: number
}

export interface BackendTeamApprovalInteraction {
  snapshot(): BackendTeamPanelApproval
  inspect(): BackendTeamPanelApproval
  reset(): BackendTeamPanelApproval
}

export interface BackendTeamPanelModel {
  readonly delivery?: NonNullable<BackendTeamViewState['developmentRun']>['delivery']
  readonly title: string
  readonly phase: { readonly value: BackendTeamPhase; readonly label: string; readonly description: string }
  readonly primaryAction: BackendTeamPanelAction
  readonly approval?: BackendTeamPanelApproval
  readonly experts: readonly { readonly id: string; readonly role: string; readonly status: RunStatus; readonly statusLabel: string; readonly taskSummary: string; readonly childCount: number }[]
  readonly database: { readonly runtime: BackendTeamViewState['database']['runtime']; readonly label: string; readonly detail: string; readonly guiAvailable: boolean; readonly controlsAvailable: boolean; readonly migrationAvailable: boolean; readonly migrationMessage?: string; readonly guiAction: BackendTeamPanelAction }
  readonly verification: { readonly summary: string; readonly total: number; readonly passed: number; readonly failed: number; readonly blocked: number; readonly reportPath?: string }
  readonly risk: BackendTeamViewState['risk']
  readonly usage: BackendTeamViewState['usage']
  readonly diagnostics: { readonly compatibility: BackendTeamViewState['compatibility']; readonly lastSequence: number; readonly stateRevision: number }
}

const PHASE_COPY: Readonly<Record<BackendTeamPhase, { readonly label: string; readonly description: string }>> = {
  DISCOVER: { label: '了解需求', description: '先把要做的后端功能说清楚。' },
  SPECIFY: { label: '完善需求', description: '正在把需求整理成可以开发的说明。' },
  AWAIT_REQUIREMENTS_APPROVAL: { label: '确认需求', description: '请检查需求说明，确认后才能继续。' },
  DESIGN: { label: '设计方案', description: '正在整理实现方案与验收计划。' },
  AWAIT_DESIGN_APPROVAL: { label: '确认方案', description: '请检查实现方案与验收计划，确认后开始开发。' },
  PLAN: { label: '制定开发计划', description: '正在拆分开发步骤和验证任务。' },
  BUILD: { label: '开发后端', description: '正在编写接口、业务逻辑和数据库代码。' },
  VERIFY: { label: '验证结果', description: '正在检查接口、数据库、测试和安全性。' },
  DELIVER: { label: '交付结果', description: '开发结果和验证报告已经准备好。' },
}

const STATUS_COPY: Readonly<Record<RunStatus, string>> = {
  running: '进行中',
  passed: '已完成',
  failed: '失败',
  blocked: '受阻',
  interrupted: '已中断',
}

export function createBackendTeamPanelModel(state: BackendTeamViewState): BackendTeamPanelModel {
  const phaseCopy = PHASE_COPY[state.phase]
  const documentIdle = state.workflowRetryAvailable && (state.phase === 'DESIGN' || state.phase === 'PLAN') && !state.experts.some(expert => expert.status === 'running')
  const plannedWithoutExecution = state.phase === 'BUILD' && state.executionAvailable === false
  const approval = state.pendingApproval === undefined ? undefined : createApproval(state)
  const primaryAction = primaryActionFor(state, approval)
  const review = state.developmentRun?.delivery
  const checks = review === undefined ? state.verification : {
    total: review.requirements.length,
    passed: review.requirements.filter(item => item.status === 'passed').length,
    failed: review.requirements.filter(item => item.status === 'failed').length,
    blocked: review.requirements.filter(item => item.status === 'blocked' || item.status === 'not-run').length,
    reportPath: review.reportPath,
  }
  const total = checks.total
  const summary = total === 0 ? '尚无全项目验收汇总' : review === undefined ? `${checks.passed}/${total} 项检查通过` : `${checks.passed}/${total} 项需求验收通过`
  const database = {
    runtime: state.database.runtime,
    label: databaseLabel(state.database.runtime),
    detail: state.database.engine,
    guiAvailable: state.database.guiAvailable,
    migrationAvailable: state.database.migrationAvailable ?? false,
    ...(state.database.migrationMessage === undefined ? {} : { migrationMessage: state.database.migrationMessage }),
    controlsAvailable: state.database.controlsAvailable ?? false,
    guiAction: { type: 'open-database-gui' as const, label: '打开数据库工具', enabled: state.database.guiAvailable },
  }
  const verification = {
    summary,
    total,
    passed: checks.passed,
    failed: checks.failed,
    blocked: checks.blocked,
    ...(checks.reportPath === undefined ? {} : { reportPath: checks.reportPath }),
  }
  return {
    title: state.workspaceName,
    ...(state.developmentRun?.delivery === undefined ? {} : { delivery: state.developmentRun.delivery }),
    phase: { value: state.phase, ...phaseCopy, ...(documentIdle ? { description: '当前阶段尚未完成，可以继续生成并校验文档。' } : {}), ...(!['BUILD', 'VERIFY'].includes(state.phase) || state.developmentRun === undefined ? {} : { description: state.developmentRun.message ?? developmentDescription(state.developmentRun.status) }), ...(plannedWithoutExecution ? { label: '规划已完成', description: '任务计划已通过校验。当前入口尚未启用代码执行。' } : {}) },
    primaryAction,
    ...(approval === undefined ? {} : { approval }),
    experts: state.experts.map((expert) => ({ ...expert, statusLabel: STATUS_COPY[expert.status] })),
    database,
    verification,
    risk: state.risk,
    usage: state.usage,
    diagnostics: { compatibility: state.compatibility, lastSequence: state.lastSequence, stateRevision: state.stateRevision },
  }
}

export function createBackendTeamApprovalInteraction(state: BackendTeamViewState): BackendTeamApprovalInteraction {
  if (state.pendingApproval === undefined) throw new Error('approval is required')
  let viewed = false
  const snapshot = () => createApproval(state, viewed)
  return {
    snapshot,
    inspect: () => { viewed = true; return snapshot() },
    reset: () => { viewed = false; return snapshot() },
  }
}

function createApproval(state: BackendTeamViewState, viewed = false): BackendTeamPanelApproval {
  const approval = state.pendingApproval
  if (approval === undefined) throw new Error('approval is required')
  return {
    required: true,
    id: approval.id,
    kind: approval.kind,
    summary: approval.summary,
    artifactHash: approval.artifactHash,
    viewed,
    canConfirm: viewed,
    viewAction: { type: 'open-artifact', label: '查看方案', enabled: true, artifactId: approval.artifactHash },
    confirmAction: { type: 'decide-approval', label: '确认并继续', enabled: viewed, approvalId: approval.id, artifactHash: approval.artifactHash, expectedRevision: state.stateRevision },
  }
}

function primaryActionFor(state: BackendTeamViewState, approval: BackendTeamPanelApproval | undefined): BackendTeamPanelAction {
  if (state.compatibility.mode === 'read-only' || state.risk.level === 'blocked') return { type: 'diagnose', label: '查看诊断信息', enabled: true }
  if (approval !== undefined) return approval.viewAction
  if (state.workflowRetryAvailable && (state.phase === 'DESIGN' || state.phase === 'PLAN') && !state.experts.some(expert => expert.status === 'running')) return { type: 'retry-failed-step', label: state.phase === 'DESIGN' ? '继续设计' : '继续规划', enabled: true, stepId: state.phase === 'DESIGN' ? 'workflow:design' : 'workflow:plan' }
  if (state.approvalRetryAvailable && (state.phase === 'AWAIT_REQUIREMENTS_APPROVAL' || state.phase === 'AWAIT_DESIGN_APPROVAL')) return { type: 'retry-failed-step', label: '发起确认', enabled: true, stepId: state.phase === 'AWAIT_REQUIREMENTS_APPROVAL' ? 'approval:requirements' : 'approval:design' }
  if ((state.phase === 'BUILD' || state.phase === 'VERIFY') && state.executionAvailable === false) return { type: 'none', label: '规划已完成，开发执行尚未启用', enabled: false }
  if ((state.phase === 'BUILD' || state.phase === 'VERIFY') && state.developmentRun !== undefined) {
    const status = state.developmentRun.status
    if (status === 'running') return { type: 'pause-run', label: '完成当前步骤后暂停', enabled: true }
    if (status === 'pausing') return { type: 'none', label: '正在等待当前步骤结束', enabled: false }
    if (status === 'passed') return { type: 'none', label: '本轮开发已结束，请查看上方验证结果', enabled: false }
    return { type: 'resume-run', label: status === 'idle' ? '开始或恢复开发' : '恢复开发', enabled: true }
  }
  if (state.phase === 'DELIVER') return { type: 'none', label: '本次需求验收已完成', enabled: false }
  if (state.database.runtime === 'failed') return { type: 'diagnose', label: '查看诊断信息', enabled: true }
  if ((state.phase === 'BUILD' || state.phase === 'VERIFY') && state.database.runtime === 'not-installed') return { type: 'start-database', label: '准备数据库', enabled: true }
  return { type: 'none', label: '等待下一步', enabled: false }
}

function developmentDescription(status: NonNullable<BackendTeamViewState['developmentRun']>['status']): string {
  if (status === 'idle') return '可以开始开发，或恢复已保存的开发进度。'
  if (status === 'pausing') return '正在完成当前步骤并保存进度，请稍候。'
  if (status === 'paused') return '开发已暂停，进度已保存。'
  if (status === 'passed') return '开发步骤已完成，等待后续验证。'
  if (status === 'failed' || status === 'blocked') return '本次开发未完成，可以从已保存的进度恢复。'
  return PHASE_COPY.BUILD.description
}

function databaseLabel(runtime: BackendTeamViewState['database']['runtime']): string {
  if (runtime === 'not-installed') return '数据库未安装'
  if (runtime === 'stopped') return '数据库已停止'
  if (runtime === 'starting') return '数据库启动中'
  if (runtime === 'ready') return '数据库已就绪'
  return '数据库启动失败'
}
