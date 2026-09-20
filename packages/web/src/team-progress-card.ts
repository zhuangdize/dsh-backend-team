import { Users, CircleCheck, Circle, ChevronDown, Pause, Play, FileText } from './ui/icons.js'
import type { BackendTeamReactLike } from './client-overlay.js'
import type { ClientContext } from './client.js'
import { BackendTeamViewStateSchema, type BackendTeamViewState } from './view-model.js'
import { createShadcnComponents } from './ui/primitives.js'
export function progressRows(state: BackendTeamViewState): Array<{ label: string; status: string }> {
  const phases = ['DISCOVER', 'SPECIFY', 'AWAIT_REQUIREMENTS_APPROVAL', 'DESIGN', 'AWAIT_DESIGN_APPROVAL', 'PLAN', 'BUILD', 'VERIFY', 'DELIVER']
  const at = phases.indexOf(state.phase)
  const recorded = (kind: string) => state.approvalHistory?.some(item => item.kind === kind) ? '历史审批记录' : '审批待核实'
  const execution = executionStatus(state)
  return [{ label: '需求分析', status: at > 2 ? recorded('requirements') : at === 2 ? '待你确认' : '整理中' }, { label: '方案设计', status: at > 4 ? recorded('design') : at === 4 ? '待你确认' : at === 3 ? '设计中' : '未开始' }, { label: '功能开发', status: at > 6 ? '已结束' : at >= 5 ? execution : '未开始' }, { label: '测试验收', status: state.phase === 'DELIVER' ? state.verification.blocked || state.verification.failed ? '需关注' : '已结束' : state.phase === 'VERIFY' ? execution : '未开始' }, { label: '交付', status: state.phase === 'DELIVER' ? '查看验收结果' : '待完成' }]
}
export function executionStatus(state: BackendTeamViewState): string {
  const status = state.developmentRun?.status
  if (status === 'running') return '进行中'
  if (status === 'pausing') return '正在暂停'
  if (status === 'paused') return '已暂停'
  if (status === 'failed' || status === 'blocked' || state.risk.level === 'blocked') return '受阻待处理'
  if (status === 'passed') return '执行已结束'
  if (state.usage.activeExperts || state.usage.activeWorkers) return '处理中'
  return '尚未运行'
}
export type TeamProgressControl = 'pause' | 'resume'
export function progressControl(state: BackendTeamViewState): TeamProgressControl | undefined {
  if (!['BUILD', 'VERIFY'].includes(state.phase)) return undefined
  if (state.developmentRun?.status === 'running') return 'pause'
  if (['paused', 'failed', 'blocked', 'idle'].includes(state.developmentRun?.status ?? '') || state.risk.level === 'blocked') return 'resume'
  return undefined
}
export function installTeamProgress(context: ClientContext, react: BackendTeamReactLike, openResources: () => void) {
  const h = react.createElement
  const ui = createShadcnComponents(react)
  function Progress({ sessionId }: { sessionId?: string }) {
    const [state, setState] = react.useState<BackendTeamViewState | undefined>(undefined)
    const [error, setError] = react.useState('')
    const [busy, setBusy] = react.useState(false)
    react.useEffect(() => {
      if (!sessionId) return
      let active = true; let timer: ReturnType<typeof setTimeout> | undefined
      const controller = new AbortController()
      const refresh = async () => {
        try { const response = await fetch('/plugins/backend-team/control/state?' + new URLSearchParams({ sessionId }), { credentials: 'same-origin', signal: controller.signal }); if (!response.ok) return; const result = BackendTeamViewStateSchema.parse(await response.json()); if (active) setState(result) }
        catch { /* The host's ordinary composer must remain usable if this status feed fails. */ }
        finally { if (active) timer = setTimeout(() => { void refresh() }, 5000) }
      }
      void refresh()
      return () => { active = false; controller.abort(); if (timer) clearTimeout(timer) }
    }, [sessionId])
    if (!state || state.taskId === 'unassigned' || !['PLAN', 'BUILD', 'VERIFY', 'DELIVER'].includes(state.phase)) return null
    const rows = progressRows(state)
    const pause = async () => {
      if (busy || !sessionId) return
      setBusy(true); setError('')
      try { const response = await fetch('/plugins/backend-team/control/dispatch?' + new URLSearchParams({ sessionId }), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'pause-run', workspaceId: state.workspaceId, taskId: state.taskId, expectedRevision: state.stateRevision }) }); if (!response.ok) throw new Error('暂停未成功，请刷新进度后重试。') }
      catch (cause) { setError(cause instanceof Error ? cause.message : '暂停失败') }
      finally { setBusy(false) }
    }
    const resume = async () => {
      if (busy || !sessionId) return
      setBusy(true); setError('')
      try { const response = await fetch('/plugins/backend-team/control/dispatch?' + new URLSearchParams({ sessionId }), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'resume-run', workspaceId: state.workspaceId, taskId: state.taskId, expectedRevision: state.stateRevision }) }); if (!response.ok) throw new Error('恢复未成功，请刷新进度后重试。') }
      catch (cause) { setError(cause instanceof Error ? cause.message : '恢复失败') }
      finally { setBusy(false) }
    }
    const label = state.phase === 'DELIVER' ? '查看交付结果' : executionStatus(state)
    const control = progressControl(state)
    return h('details', { className: 'bt-ui bt-card bt-progress' }, h('summary', null, h(Users, { 'aria-hidden': true }), '团队进度', h(ui.Badge, { tone: label === '受阻待处理' ? 'danger' : 'blue' }, label), h(ChevronDown, { 'aria-hidden': true })), h('p', { className: 'bt-muted' }, '当前任务：' + state.workspaceName + '。历史审批仅对应原方案，不代表本次新增或变更需求已确认。'), h('ol', { className: 'bt-timeline' }, ...rows.map(row => { const tone = ['已确认', '已结束'].includes(row.status) ? 'success' : row.status === '进行中' ? 'blue' : row.status === '受阻待处理' ? 'danger' : 'neutral'; return h('li', { key: row.label, 'data-tone': tone }, h(tone === 'success' ? CircleCheck : Circle, { 'aria-hidden': true }), h('span', null, row.label), h(ui.Badge, { tone }, row.status)) })), h('div', { className: 'bt-actions' }, h(ui.Button, { onClick: openResources }, h(FileText, { 'aria-hidden': true }), '查看任务资源'), control === 'pause' ? h(ui.Button, { disabled: busy, onClick: () => { void pause() } }, h(Pause, { 'aria-hidden': true }), busy ? '正在暂停…' : '暂停任务') : control === 'resume' ? h(ui.Button, { disabled: busy, onClick: () => { void resume() } }, h(Play, { 'aria-hidden': true }), busy ? '正在恢复…' : '恢复任务') : null), error ? h('p', { role: 'alert' }, error) : null, state.risk.level !== 'normal' ? h('p', { role: 'status' }, state.risk.messages.join('；')) : null)

  }
  return context.slots.inject('conversation.input.dock', () => context.slots.register({ name: 'conversation.input.dock', id: 'backend-team-progress', order: 80 }, props => h(Progress, { ...(props as Record<string, unknown>), key: (props as { sessionId?: string }).sessionId })))
}
