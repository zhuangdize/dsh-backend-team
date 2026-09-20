import { CircleCheck, Circle, ChevronRight, FileText, Pause, Play, Wrench, AlertCircle } from './ui/icons.js'
import type { BackendTeamReactLike } from './client-overlay.js'
import type { BackendTeamPanelModel } from './panel-model.js'
import type { BackendTeamViewState } from './view-model.js'
import { createShadcnComponents } from './ui/primitives.js'
import { createTaskProgressHomeModel, formatProgressTime } from './task-progress-model.js'

export interface TaskProgressArtifactPreview {
  readonly artifactHash: string
  readonly files: readonly { readonly path: string; readonly content: string }[]
}

export interface TaskProgressHomeActions {
  openResources(): void
  openTechnical(): void
  pause(): void
  resume(): void
  inspect(): void
  approve?(): void
  reject?(): void
  openDatabase?(): void
  openDatabaseLogin?(): void
  hideDatabaseLogin?(): void
}

export interface TaskProgressDatabaseAccess {
  readonly available: boolean
  readonly login?: { readonly username: string; readonly password: string }
}

export function createTaskProgressHome(react: BackendTeamReactLike, state: BackendTeamViewState, panel: BackendTeamPanelModel, actions: TaskProgressHomeActions, artifactPreview?: TaskProgressArtifactPreview, database?: TaskProgressDatabaseAccess): unknown {
  return react.createElement(TaskProgressHome, { react, state, panel, actions, artifactPreview, database })
}

function TaskProgressHome({ react, state, panel, actions, artifactPreview, database }: { react: BackendTeamReactLike; state: BackendTeamViewState; panel: BackendTeamPanelModel; actions: TaskProgressHomeActions; artifactPreview?: TaskProgressArtifactPreview; database?: TaskProgressDatabaseAccess }): unknown {
  const h = react.createElement; const ui = createShadcnComponents(react); const model = createTaskProgressHomeModel(state, panel)
  const [technicalOpen, setTechnicalOpen] = react.useState(false)
  const statusIcon = model.tone === 'success' ? CircleCheck : model.tone === 'danger' ? AlertCircle : model.status === '进行中' || model.status === '等待系统验证' ? Play : Circle
  const summary = (icon: unknown, label: string, value: string, tone: string) => h('div', { className: 'bt-progress-summary-row', 'data-tone': tone }, h(icon, { 'aria-hidden': true }), h('strong', null, label), h('span', null, value))
  const stageNodes = model.stages.map((stage, index) => h('li', { key: stage.label, className: 'bt-progress-stage', 'data-state': stage.state, ...(stage.state === 'current' ? { 'aria-current': 'step' } : {}) }, h(stage.state === 'complete' ? CircleCheck : stage.state === 'current' ? Play : Circle, { 'aria-hidden': true }), h('span', null, stage.label), index < model.stages.length - 1 ? h('i', { 'aria-hidden': true }) : null))
  const activities = model.activities.map(activity => {
    const icon = activity.tone === 'success' ? CircleCheck : activity.tone === 'danger' ? AlertCircle : Circle
    return h('li', { key: activity.id, 'data-tone': activity.tone },
      h(icon, { 'aria-hidden': true }),
      h('div', null, h('strong', null, activity.label), h('span', null, activity.detail)),
      h('time', null, formatProgressTime(activity.time)),
    )
  })
  const databaseAction = database?.available && actions.openDatabase ? h(ui.Button, { variant: 'outline', onClick: actions.openDatabase }, h(Wrench, { 'aria-hidden': true }), '打开数据库工具') : null
  const databaseLogin = database?.login && actions.hideDatabaseLogin ? h('section', { className: 'bt-progress-database-login', role: 'group', 'aria-label': '本次数据库登录' }, h('div', null, h('strong', null, '本次数据库登录'), h('p', { className: 'bt-muted' }, '登录信息仅对当前会话临时有效。')), h('label', null, '用户名', h('input', { readOnly: true, value: database.login.username, autoComplete: 'off' })), h('label', null, '密码', h('input', { readOnly: true, value: database.login.password, autoComplete: 'off', type: 'text' })), h('div', { className: 'bt-progress-database-login-actions' }, h(ui.Button, { variant: 'default', onClick: () => { actions.openDatabaseLogin?.(); actions.hideDatabaseLogin?.() } }, '打开数据库'), h(ui.Button, { variant: 'ghost', onClick: actions.hideDatabaseLogin }, '隐藏登录信息'))) : null
  const header = h('header', { className: 'bt-progress-home-header' },
    h('div', { className: 'bt-progress-title-wrap' }, h('h1', null, model.title), h('div', { className: 'bt-progress-meta' }, h(FileText, { 'aria-hidden': true }), h('span', null, '团队任务'), h('span', { className: 'bt-meta-separator' }, '·'), h('span', null, model.stageLabel), h(ui.Badge, { tone: model.tone }, h(statusIcon, { 'aria-hidden': true }), model.status), model.lastProgressAt ? h('time', null, '最后更新 ' + formatProgressTime(model.lastProgressAt)) : null), h('p', { className: 'bt-progress-status-detail' }, model.statusDetail)),
    h('div', { className: 'bt-progress-actions' }, databaseAction, h(ui.Button, { variant: 'default', onClick: () => { setTechnicalOpen(true); actions.openTechnical() } }, h(Wrench, { 'aria-hidden': true }), '查看技术详情'), h(ui.Button, { variant: 'outline', onClick: actions.openResources }, h(FileText, { 'aria-hidden': true }), '查看任务资源'), model.canPause ? h(ui.Button, { variant: 'outline', onClick: actions.pause }, h(Pause, { 'aria-hidden': true }), model.pauseLabel) : model.canResume ? h(ui.Button, { variant: 'outline', onClick: actions.resume }, h(Play, { 'aria-hidden': true }), '恢复任务') : null))
  const current = h('section', { className: 'bt-progress-card', 'aria-labelledby': 'bt-current-progress' }, h('h2', { id: 'bt-current-progress' }, '当前进展'), h('div', { className: 'bt-progress-summary' }, summary(Play, '正在做', model.current, 'blue'), summary(CircleCheck, '最近完成', model.recent, 'success'), summary(model.status === '已受阻' ? AlertCircle : FileText, '当前问题', model.issue, model.status === '已受阻' || model.status === '等待你处理' ? 'warning' : 'neutral'), summary(ChevronRight, '下一步', model.next, 'neutral')), h('ol', { className: 'bt-progress-stages', 'aria-label': '任务阶段' }, ...stageNodes))
  const approval = panel.approval === undefined ? null : h('section', { className: 'bt-progress-card bt-progress-approval', 'aria-label': '待确认审批' },
    h('div', { className: 'bt-section-heading' }, h('h2', null, '需要确认'), h(ui.Badge, { tone: 'warning' }, panel.approval.kind === 'migration' ? '数据库迁移' : '方案审批')),
    h('p', null, panel.approval.summary),
    artifactPreview?.artifactHash === panel.approval.artifactHash ? h('div', { className: 'bt-progress-approval-preview', role: 'document', 'aria-label': '审批内容预览' }, ...artifactPreview.files.map(file => h('div', { key: file.path }, h('strong', null, file.path), h('pre', null, file.content)))) : h('p', { className: 'bt-muted' }, '请先查看审批内容，确认按钮随后可用。'),
    h('div', { className: 'bt-progress-approval-actions' },
      h(ui.Button, { variant: 'outline', onClick: actions.inspect }, '查看方案'),
      panel.approval.canConfirm && actions.reject ? h(ui.Button, { variant: 'outline', onClick: actions.reject }, '退回修改') : null,
      panel.approval.canConfirm && actions.approve ? h(ui.Button, { variant: 'default', onClick: actions.approve }, '确认并继续') : null,
    ),
  )
  const recent = h('section', { className: 'bt-progress-card bt-recent-card', 'aria-labelledby': 'bt-recent-activity' }, h('div', { className: 'bt-section-heading' }, h('h2', { id: 'bt-recent-activity' }, '最近活动'), h(ui.Button, { variant: 'ghost', onClick: () => { setTechnicalOpen(value => !value); actions.openTechnical() } }, technicalOpen ? '收起技术详情' : '技术详情（含完整轨迹）', h(ChevronRight, { 'aria-hidden': true }))), h('ol', { className: 'bt-progress-activities' }, ...activities))
  const technical = technicalOpen ? h('section', { className: 'bt-progress-technical', 'aria-label': '技术详情', tabIndex: -1 }, h('div', { className: 'bt-section-heading' }, h('h2', null, '技术详情'), h(ui.Button, { variant: 'ghost', onClick: () => setTechnicalOpen(false) }, '收起')), model.technicalDetails.length ? h('ul', null, ...model.technicalDetails.map((item, index) => h('li', { key: index }, item))) : h('p', null, '暂无额外技术详情。'), h('p', { className: 'bt-muted' }, '完整执行轨迹请查看顶部“轨迹”页签。')) : null
  return h('main', { className: 'bt-ui bt-progress-home', 'aria-label': '团队任务进展', 'data-status': model.status }, header, databaseLogin, current, approval, recent, technical)
}
