import type { BackendTeamPhase } from '@dsh-backend-team/contracts'
import type { BackendTeamPanelModel } from './panel-model.js'
import type { BackendTeamViewState } from './view-model.js'

export type TaskProgressStatus = '进行中' | '等待系统验证' | '等待你处理' | '已受阻' | '已完成' | '已暂停'
export type TaskProgressTone = 'blue' | 'success' | 'warning' | 'danger' | 'neutral'
export interface ProgressStage { label: string; state: 'complete' | 'current' | 'future' }
export interface ProgressActivity { id: string; label: string; detail: string; time?: string; tone: TaskProgressTone }
export interface TaskProgressHomeModel {
  title: string
  status: TaskProgressStatus
  tone: TaskProgressTone
  statusDetail: string
  stageLabel: string
  lastProgressAt?: string
  current: string
  recent: string
  issue: string
  next: string
  stages: ProgressStage[]
  activities: ProgressActivity[]
  canPause: boolean
  pauseLabel: string
  canResume: boolean
  technicalDetails: string[]
}

const stageMap: Readonly<Record<BackendTeamPhase, { index: number; label: string }>> = {
  DISCOVER: { index: 0, label: '需求分析' }, SPECIFY: { index: 0, label: '需求分析' }, AWAIT_REQUIREMENTS_APPROVAL: { index: 0, label: '需求分析' },
  DESIGN: { index: 1, label: '方案设计' }, AWAIT_DESIGN_APPROVAL: { index: 1, label: '方案设计' }, PLAN: { index: 1, label: '方案设计' },
  BUILD: { index: 2, label: '功能开发' }, VERIFY: { index: 3, label: '测试验收' }, DELIVER: { index: 4, label: '交付' },
}
const stageLabels = ['需求分析', '方案设计', '功能开发', '测试验收', '交付']

export function createTaskProgressHomeModel(state: BackendTeamViewState, panel: BackendTeamPanelModel): TaskProgressHomeModel {
  const stage = stageMap[state.phase]
  const pending = state.pendingApproval !== undefined
  // A restored approval is actionable even if the previous recovery attempt
  // left a diagnostic error in durable state. Let the confirmation take
  // precedence so the user is not shown a dead-end "blocked" state while a
  // valid approval is present.
  const blocked = !pending && (state.risk.level === 'blocked' || ['failed', 'blocked'].includes(state.developmentRun?.status ?? ''))
  const paused = state.developmentRun?.status === 'paused'
  const verifying = state.developmentRun?.status === 'running' && state.phase === 'VERIFY'
  const delivered = state.phase === 'DELIVER' && state.developmentRun?.delivery?.status === 'ready' && state.developmentRun.delivery.requirements.length > 0 && state.developmentRun.delivery.requirements.every(item => item.status === 'passed') && state.developmentRun.delivery.unresolvedItems.length === 0
  const status: TaskProgressStatus = blocked ? '已受阻' : pending ? '等待你处理' : paused ? '已暂停' : delivered ? '已完成' : verifying ? '等待系统验证' : '进行中'
  const tone: TaskProgressTone = status === '已完成' ? 'success' : status === '等待你处理' ? 'warning' : status === '已受阻' ? 'danger' : status === '已暂停' ? 'neutral' : status === '等待系统验证' ? 'success' : 'blue'
  const run = state.developmentRun
  const active = run?.status === 'running' || state.usage.activeExperts > 0 || state.usage.activeWorkers > 0
  const current = pending ? (state.pendingApproval?.summary ?? '有一份方案等待你的确认') : blocked ? '任务已受阻，处理原因后可恢复' : paused ? '开发已暂停，进度已保存' : delivered ? '交付结果已准备好' : active ? (run?.message ?? `团队正在${stage.label}，请稍候`) : state.phase === 'PLAN' ? '开发计划已准备好，等待进入执行' : `正在${panel.phase.label}`
  const recent = state.verification.total > 0 ? `${state.verification.passed}/${state.verification.total} 项检查通过` : state.approvalHistory?.length ? `已记录 ${state.approvalHistory.length} 项历史审批` : '暂无可展示的最近完成项'
  const issue = pending ? '有事项需要你处理' : blocked ? (state.risk.messages.join('；') || '任务暂时受阻') : '暂无需要你处理的事项'
  const next = pending ? '查看方案并完成确认后继续' : blocked ? '查看技术详情并处理阻塞原因' : paused ? '恢复任务后继续下一步' : delivered ? '查看交付结果和验收报告' : verifying ? '系统完成检查后进入交付' : `完成${stage.label}后进入下一阶段`
  const activities: ProgressActivity[] = []
  for (const item of (state.activity ?? []).slice(-3)) activities.push({ id: item.id, label: item.label, detail: item.kind === 'stage' ? '任务阶段已更新' : item.kind === 'approval' ? '审批记录已保存' : '团队执行状态已更新', time: item.occurredAt, tone: item.kind === 'approval' ? 'success' : item.kind === 'run' ? 'blue' : 'neutral' })
  for (const expert of state.experts.slice(-2)) activities.push({ id: `run:${expert.id}`, label: expert.status === 'running' ? '正在处理' : expert.status === 'passed' ? '已完成' : expert.status === 'blocked' ? '已受阻' : '执行记录', detail: expert.taskSummary, tone: expert.status === 'running' ? 'blue' : expert.status === 'passed' ? 'success' : expert.status === 'blocked' ? 'danger' : 'neutral' })
  for (const approval of (state.approvalHistory ?? []).slice(-2)) activities.push({ id: `approval:${approval.kind}:${approval.approvedAt}`, label: '已记录审批', detail: approval.kind === 'requirements' ? '需求审批记录' : approval.kind === 'design' ? '设计审批记录' : `${approval.kind} 审批记录`, time: approval.approvedAt, tone: approval.provenance?.status === 'verified' ? 'success' : 'neutral' })
  if (activities.length === 0) activities.push({ id: 'empty', label: '暂无最近活动', detail: '任务开始后，团队生成的进展会显示在这里。', tone: 'neutral' })
  activities.sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''))
  return { title: panel.title, status, tone, statusDetail: status === '等待系统验证' ? '系统正在执行交付前检查，你暂时无需操作' : panel.phase.description, stageLabel: stage.label, ...(state.lastProgressAt === undefined ? {} : { lastProgressAt: state.lastProgressAt }), current, recent, issue, next, stages: stageLabels.map((label, index) => ({ label, state: index < stage.index ? 'complete' : index === stage.index ? 'current' : 'future' })), activities: activities.slice(0, 3), canPause: ['BUILD', 'VERIFY'].includes(state.phase) && run?.status === 'running', pauseLabel: run?.status === 'pausing' ? '正在暂停…' : '暂停任务', canResume: ['BUILD', 'VERIFY'].includes(state.phase) && ['paused', 'idle', 'failed', 'blocked'].includes(run?.status ?? ''), technicalDetails: [...state.risk.messages, ...state.experts.map(expert => `${expert.role}：${expert.taskSummary}`)] }
}

export function formatProgressTime(value?: string): string {
  if (!value) return '时间暂不可用'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '时间暂不可用' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
