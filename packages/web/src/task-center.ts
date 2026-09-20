import { FolderOpen, FileText, ArrowLeft, X, RefreshCw, Search, Clock, Pause } from './ui/icons.js'
import { createShadcnComponents } from './ui/primitives.js'
import { attachResourceLayout } from './ui/resource-layout.js'
import type { BackendTeamReactLike } from './client-overlay.js'

export interface WorkspaceTask { id: string; title: string; objective?: string; phase: string; arrangement: 'unfinished' | 'shelved' | 'completed'; current: boolean; createdAt: string; sessionId: string; executionStatus: string; readOnly?: boolean }
interface TaskData { taskId: string; title?: string; objective?: string; files: Array<{ path: string; category: string }>; tasks: WorkspaceTask[]; managementHistory?: Array<{ at: string; action: string; note?: string }> }
export function taskArrangement(task: WorkspaceTask): string { return task.arrangement === 'shelved' ? '已搁置' : task.arrangement === 'completed' ? '已完成' : '未完成' }
export function taskExecution(task: WorkspaceTask): string {
  if (task.arrangement === 'completed') return '已交付'
  const phase: Record<string, string> = { DISCOVER: '需求收集', SPECIFY: '需求分析', AWAIT_REQUIREMENTS_APPROVAL: '需求待确认', DESIGN: '方案设计', AWAIT_DESIGN_APPROVAL: '设计待确认', PLAN: '开发规划', BUILD: '功能开发', VERIFY: '测试验收' }
  const status: Record<string, string> = { idle: '尚未运行', queued: '排队中', running: '正在执行', pausing: '正在暂停', paused: '已暂停', saved: '进度已保存', passed: '执行已结束', failed: '执行失败', blocked: '受阻待处理' }
  return (phase[task.phase] ?? task.phase) + (task.executionStatus === 'queued' ? ' · 排队中' : ['BUILD', 'VERIFY'].includes(task.phase) ? ' · ' + (status[task.executionStatus] ?? '状态待核实') : '')
}
export function filterWorkspaceTasks(tasks: WorkspaceTask[], filter: string, query: string): WorkspaceTask[] { return tasks.filter(task => (filter === '全部' || taskArrangement(task) === filter) && (task.title + ' ' + (task.objective ?? '')).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) }
export function hasBlockingCurrentTask(current?: WorkspaceTask): boolean { return current !== undefined && current.arrangement !== 'completed' }

export function createTaskCenter(react: BackendTeamReactLike, resourceTitle: (path: string) => string) {
  const h = react.createElement
  const ui = createShadcnComponents(react)
  return function TaskCenter(props: { sessionId?: string; close(): void; openDocument(taskId: string, path: string): void }) {
    const [element, setElement] = react.useState<HTMLElement | null>(null)
    react.useEffect(() => element ? attachResourceLayout(element) : undefined, [element])
    const [data, setData] = react.useState<TaskData | undefined>(undefined)
    const [selected, setSelected] = react.useState('')
    const [filter, setFilter] = react.useState('全部')
    const [query, setQuery] = react.useState('')
    const [error, setError] = react.useState('')
    const [refresh, setRefresh] = react.useState(0)
    const [busy, setBusy] = react.useState(false)
    const [decision, setDecision] = react.useState<{ decisionId: string; title: string; mode: 'adopt' | 'shelve' } | undefined>(undefined)
    const [note, setNote] = react.useState('')
    const [receipt, setReceipt] = react.useState('')
    react.useEffect(() => { const timer = setInterval(() => setRefresh(value => value + 1), 5000); return () => clearInterval(timer) }, [])
    react.useEffect(() => {
      const controller = new AbortController()
      if (!props.sessionId) { setError('请先选择项目会话。'); return }
      const search = new URLSearchParams({ sessionId: props.sessionId, ...(selected ? { resourceTaskId: selected } : {}) })
      void fetch('/plugins/backend-team/control/resources?' + search, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error('任务暂时无法加载，请重试。')
        const value = await response.json() as TaskData
        if (!controller.signal.aborted) { setData(value); setError('') }
      }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '加载失败') })
      return () => controller.abort()
    }, [props.sessionId, selected, refresh])
    const dispatch = async (action: unknown) => {
      const response = await fetch('/plugins/backend-team/control/dispatch?' + new URLSearchParams({ sessionId: props.sessionId! }), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })
      const result = await response.json() as { code?: string; message?: string; decisionId: string; title: string; mode: 'adopt' | 'shelve'; status?: string }
      if (!response.ok) throw new Error(result.code === 'STALE_VIEW' ? '任务已变化或确认已过期，请重新查看后操作。' : result.message ?? '任务暂时无法变更，请稍后重试。')
      return result
    }
    const preview = async (mode: 'adopt' | 'shelve') => {
      setBusy(true); setError(''); setReceipt('')
      try { setDecision(await dispatch({ type: 'preview-task-resolution', targetTaskId: selected, mode })); setNote('') } catch (cause) { setError(cause instanceof Error ? cause.message : '无法准备确认') } finally { setBusy(false) }
    }
    const confirm = async () => {
      if (!decision) return
      setBusy(true); setError('')
      try {
        const result = await dispatch({ type: 'confirm-task-resolution', decisionId: decision.decisionId, note })
        setReceipt(result.status === 'feedback' ? result.message! : result.status === 'adopted' ? `已接回“${decision.title}”。尚未恢复执行，也未批准新需求。` : `已搁置“${decision.title}”，已有代码和文档保留。`)
        setDecision(undefined); setRefresh(value => value + 1)
      } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); setDecision(undefined) } finally { setBusy(false) }
    }
    const choose = (id: string) => { setSelected(id); setDecision(undefined); setNote(''); setReceipt(''); setData(undefined) }
    const task = data?.tasks.find(task => task.id === selected)
    const current = data?.tasks.find(task => task.current)
    const currentBlocksSwitch = hasBlockingCurrentTask(current)
    const iconButton = (label: string, icon: unknown, onClick: () => void) => h(ui.Button, { size: 'icon', variant: 'ghost', 'aria-label': label, onClick }, h(icon, { 'aria-hidden': true }))
    return h('aside', { ref: setElement, className: 'bt-ui bt-resource-panel', 'aria-label': '团队任务' },
      h('header', { className: 'bt-resource-header' }, h('strong', null, '团队任务'), h('div', { className: 'bt-resource-tools' }, iconButton('刷新任务', RefreshCw, () => setRefresh(v => v + 1)), iconButton('关闭团队任务', X, props.close))),
      error ? h('div', { className: 'bt-task-alert', role: 'alert' }, error, h(ui.Button, { size: 'sm', onClick: () => setRefresh(v => v + 1) }, '重试')) : null,
      receipt ? h('div', { className: 'bt-task-alert', role: 'status' }, receipt) : null,
      !data ? h('div', { className: 'bt-empty', role: 'status' }, '正在读取工作区任务…') : !selected ? h('div', { className: 'bt-resource-body' },
        h('div', { className: 'bt-task-tools' }, h('label', { className: 'bt-task-search' }, h(Search, { 'aria-hidden': true }), h('input', { value: query, 'aria-label': '搜索工作区任务', placeholder: '搜索工作区任务', onChange: (e: { target: { value: string } }) => setQuery(e.target.value) })), h('div', { className: 'bt-task-filters', role: 'group', 'aria-label': '任务状态' }, ...['全部', '未完成', '已搁置', '已完成'].map(value => h(ui.Button, { key: value, size: 'sm', variant: 'ghost', 'aria-pressed': filter === value, onClick: () => setFilter(value) }, value))), h('p', { className: 'bt-muted' }, '此工作区的全部任务，包括其他会话中的任务。')),
        h('nav', { className: 'bt-task-list', 'aria-label': '工作区任务' }, ...filterWorkspaceTasks(data.tasks, filter, query).map(task => h('button', { type: 'button', className: 'bt-task-row', key: task.id, onClick: () => choose(task.id) }, h('div', { className: 'bt-task-row-title' }, h(FolderOpen, { 'aria-hidden': true }), h('strong', null, task.title), h(ui.Badge, { tone: task.arrangement === 'completed' ? 'success' : 'neutral' }, taskArrangement(task))), h('p', null, task.objective ?? task.title), h('small', null, taskExecution(task) + (task.createdAt ? ' · ' + new Date(task.createdAt).toLocaleDateString('zh-CN') : '')), task.current ? h('small', { className: 'bt-task-current' }, '当前对话的任务') : null)), !filterWorkspaceTasks(data.tasks, filter, query).length ? h('div', { className: 'bt-empty' }, h(FolderOpen, { 'aria-hidden': true }), h('h2', null, data.tasks.length ? '没有符合条件的任务' : '尚无团队任务'), h('p', null, '在聊天中提出需求，团队任务会保存在这里。')) : null)) : task ? h('div', { className: 'bt-resource-body' },
        h('div', { className: 'bt-resource-heading' }, h(ui.Button, { variant: 'ghost', className: 'bt-back', onClick: () => choose(''), disabled: busy }, h(ArrowLeft, { 'aria-hidden': true }), '所有任务'), h('div', { className: 'bt-resource-title' }, h('h2', null, task.title), h(ui.Badge, null, taskArrangement(task))), h('p', { className: 'bt-muted' }, task.current ? '当前对话的任务' : '其他会话的任务 · 仅查看')),
        h('div', { className: 'bt-task-detail' }, h('div', { className: 'bt-task-status' }, h(Clock, { 'aria-hidden': true }), h('div', null, h('strong', null, taskExecution(task)), h('p', { className: 'bt-muted' }, '查看资料不会开始执行'))), h('h3', null, '原任务范围'), h('p', null, data.objective ?? task.objective), h('h3', null, '任务资源'), ...data.files.map(file => h('button', { type: 'button', key: file.path, className: 'bt-task-document', onClick: () => props.openDocument(task.id, file.path) }, h(FileText, { 'aria-hidden': true }), resourceTitle(file.path), h('span', null, '查看'))), !data.files.length ? h('p', { className: 'bt-muted' }, '暂未生成文档。') : null, h('h3', null, '操作记录'), ...(data.managementHistory ?? []).map((event, index) => h('p', { key: index, className: 'bt-muted' }, new Date(event.at).toLocaleString('zh-CN') + ' · ' + ({ adopt: '接回当前对话', shelve: '搁置任务', feedback: '补充意见' }[event.action] ?? event.action), event.note ? '：' + event.note : '')), !(data.managementHistory?.length) ? h('p', { className: 'bt-muted' }, '暂无任务管理记录；文档审批记录在资源中查看。') : null),
        decision ? h('footer', { className: 'bt-task-decision' }, h('h3', null, (decision.mode === 'shelve' ? '搁置任务：' : '接回当前对话：') + decision.title), h('p', null, decision.mode === 'shelve' ? '保留代码、文档和进度，释放工作区占用；不会标记为完成。' : '当前对话将管理这个原任务。不会自动恢复执行，也不会批准新增需求。'), h('label', { htmlFor: 'bt-task-note' }, '补充意见（可选）'), h(ui.Textarea, { id: 'bt-task-note', value: note, maxLength: 2000, disabled: busy, placeholder: '有其他要求，可以在这里补充', onChange: (e: { target: { value: string } }) => setNote(e.target.value) }), h('div', { className: 'bt-task-actions' }, h(ui.Button, { disabled: busy, onClick: () => setDecision(undefined) }, '取消'), h(ui.Button, { variant: 'default', disabled: busy, onClick: () => void confirm() }, busy ? '正在保存…' : note.trim() ? '提交意见，暂不变更' : decision.mode === 'shelve' ? '确认搁置' : '确认接回'))) : task.arrangement !== 'completed' && !task.readOnly ? h('footer', { className: 'bt-task-decision' }, h('p', { className: 'bt-muted' }, currentBlocksSwitch ? `当前对话已关联“${current?.title ?? '现有任务'}”，接回前需先处理当前任务。` : '管理操作需要明确确认，不会自动批准文档。'), h('div', { className: 'bt-task-actions' }, task.arrangement !== 'shelved' ? h(ui.Button, { disabled: busy, onClick: () => void preview('shelve') }, h(Pause, { 'aria-hidden': true }), '搁置任务') : null, !task.current ? h(ui.Button, { variant: 'default', disabled: busy || currentBlocksSwitch, onClick: () => void preview('adopt') }, '接回当前对话') : null)) : null) : h('div', { className: 'bt-empty' }, '任务已变化，请返回列表。', h(ui.Button, { onClick: () => choose('') }, '所有任务')))
  }
}
