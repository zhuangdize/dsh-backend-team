import { ArrowLeft, X, RefreshCw, FileText, FolderOpen, CircleCheck, AlertCircle } from './ui/icons.js'
import { attachResourceLayout } from './ui/resource-layout.js'
import { reviewSections } from './review-diff.js'
import type { BackendTeamReactLike } from './client-overlay.js'
import type { ClientContext } from './client.js'
import type { ReviewSessionStore } from './review-session.js'
import { createReviewFooter } from './task-review-card.js'
import { createShadcnComponents } from './ui/primitives.js'
import { BackendTeamViewStateSchema } from './view-model.js'
import { createTaskCenter } from './task-center.js'

interface Resource { path: string; content?: string; sha256?: string; category: string; error?: string }
interface DatabaseSnapshot { id: string; database: string; kind: 'data' | 'schema'; createdAt: string; reason: string; serverVersion: string; sha256: string }
interface Resources { approvalHistory?: Array<{ kind: string; approvedAt: string; artifactHashes?: Record<string, string>; provenance?: { status: 'verified' | 'unknown'; sessionId?: string; taskId?: string } }>; taskId: string; title?: string; phase?: string; changes?: { available: boolean; files: Array<{ path: string; before: string; after: string }> }; files: Resource[]; databaseSnapshots?: DatabaseSnapshot[]; tasks: Array<{ id: string; title: string }> }
interface Layout { openDetails(): void; closeDetails(): void }

export function installTaskResources(context: ClientContext, react: BackendTeamReactLike, markdown: unknown, reviews?: ReviewSessionStore): { dispose(): void; open(): void } {
  const layout = Reflect.get(context, 'layout') as Layout | undefined
  if (!layout) return { dispose() {}, open() {} }
  const h = react.createElement
  const reading = new Map<string, { selected: string; task: string; tab: string; offsets: Map<string, number> }>()
  let removePanel: (() => void) | undefined
  const close = () => { layout.closeDetails(); removePanel?.(); removePanel = undefined }
  const Footer = reviews ? createReviewFooter(react, reviews, close) : undefined
  const ui = createShadcnComponents(react)
  const TaskCenter = createTaskCenter(react, resourceTitle)
  type Page = { kind: 'tasks' | 'resources'; taskId?: string; path?: string }
  let page: Page = { kind: 'tasks' }
  let navigate: ((page: Page) => void) | undefined
  function Root(props: { sessionId?: string }) {
    const [view, setView] = react.useState(page)
    react.useEffect(() => { navigate = setView; return () => { navigate = undefined } }, [])
    return view.kind === 'tasks' ? h(TaskCenter, { ...props, close, openDocument: (taskId: string, path: string) => setView({ kind: 'resources', taskId, path }) }) : h(Panel, { ...props, resourceTaskId: view.taskId, resourcePath: view.path, onAllTasks: () => setView({ kind: 'tasks' }) })
  }
  function Panel(props: { sessionId?: string; resourceTaskId?: string; resourcePath?: string; onAllTasks(): void }) {
    const [panelElement, setPanelElement] = react.useState<HTMLElement | null>(null)
    react.useEffect(() => panelElement ? attachResourceLayout(panelElement) : undefined, [panelElement])
    const sessionKey = props.sessionId ?? ''
    if (!reading.has(sessionKey)) reading.set(sessionKey, { selected: '', task: '', tab: 'document', offsets: new Map() })
    const saved = reading.get(sessionKey)!
    const [data, setData] = react.useState<Resources | undefined>(undefined)
    const [error, setError] = react.useState('')
    const [selected, setSelected] = react.useState(props.resourcePath ?? saved.selected)
    const [task, setTask] = react.useState(props.resourceTaskId ?? '')
    const [refresh, setRefresh] = react.useState(0)
    const [listing, setListing] = react.useState(false)
    const [tab, setTab] = react.useState(saved.tab)
    react.useEffect(() => { saved.selected = selected; saved.task = task; saved.tab = tab }, [selected, task, tab])
    const [reviewFiles, setReviewFiles] = react.useState<Resource[] | undefined>(undefined)
    const [reviewVersion, setReviewVersion] = react.useState('')
    const [, updateReview] = react.useState(0)
    const [poll, setPoll] = react.useState(0)
    const [snapshotReason, setSnapshotReason] = react.useState('')
    const [restoreSnapshotId, setRestoreSnapshotId] = react.useState('')
    const [restoreTargetDatabase, setRestoreTargetDatabase] = react.useState('')
    const [snapshotBusy, setSnapshotBusy] = react.useState(false)
    const [snapshotMessage, setSnapshotMessage] = react.useState('')
    react.useEffect(() => { const timer = setInterval(() => setPoll(value => value + 1), 5000); return () => clearInterval(timer) }, [props.sessionId])
    const review = props.sessionId ? reviews?.get(props.sessionId) : undefined
    react.useEffect(() => reviews?.subscribe(() => updateReview(value => value + 1)), [])
    react.useEffect(() => {
      if (!props.sessionId || !review || !['pending', 'sending'].includes(review.status)) return
      let active = true
      const controller = new AbortController()
      const query = new URLSearchParams({ sessionId: props.sessionId })
      reviews?.clearInspection(props.sessionId, review.wait.key)
      setReviewFiles(undefined)
      const load = async () => {
        const response = await fetch('/plugins/backend-team/control/state?' + query, { credentials: 'same-origin', signal: controller.signal })
        if (!response.ok) throw new Error('无法核对审批版本，请重试。')
        const state = BackendTeamViewStateSchema.parse(await response.json())
        if (task && task !== state.taskId) return
        const pending = state.pendingApproval
        if (!pending || review.wait.payload.questions[0]?.id !== 'backend-team-review:' + pending.id) throw new Error('方案已变化，请在聊天中请求最新确认。')
        const preview = await fetch('/plugins/backend-team/control/dispatch?' + query, { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'open-artifact', workspaceId: state.workspaceId, taskId: state.taskId, expectedRevision: state.stateRevision, artifactId: pending.artifactHash }) })
        if (!preview.ok) throw new Error('当前方案无法读取，请刷新资源重试。')
        const result = await preview.json() as { artifactPreview?: { artifactHash: string; files: Array<{ path: string; content: string }> } }
        if (!result.artifactPreview || result.artifactPreview.artifactHash !== pending.artifactHash) throw new Error('方案版本不匹配。')
        if (active) {
          setReviewFiles(result.artifactPreview.files.map(file => ({ ...file, category: '方案文档' })))
          setReviewVersion('状态版本 r' + state.stateRevision)
          setSelected(result.artifactPreview.files.some(file => file.path === saved.selected) ? saved.selected : result.artifactPreview.files.find(file => file.path.endsWith(pending.kind === 'design' ? '/plan.md' : '/spec.md'))?.path ?? result.artifactPreview.files[0]?.path ?? '')
          reviews?.inspected(props.sessionId!, review.wait.key, pending.artifactHash)
        }
      }
      void load().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '读取失败') })
      return () => { active = false; controller.abort() }
    }, [props.sessionId, review?.wait.key, refresh, task])
    react.useEffect(() => {
      let active = true
      const controller = new AbortController()
      setError('')
      if (!props.sessionId) { setError('请先选择一个项目会话。'); return }
      const query = new URLSearchParams({ sessionId: props.sessionId, ...(task ? { resourceTaskId: task } : {}) })
      fetch('/plugins/backend-team/control/resources?' + query, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
        .then(async response => { if (!response.ok) throw new Error(response.status === 401 ? '会话未登录，请刷新重试。' : '资源暂时无法加载，请重试。'); return response.json() as Promise<Resources> })
        .then(value => { if (active) { setData(value); setTask(previous => previous || value.taskId); setSelected(previous => value.files.some(file => file.path === previous) ? previous : value.files[0]?.path ?? '') } })
        .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '加载失败') })
      return () => { active = false; controller.abort() }
    }, [props.sessionId, task, refresh, poll])
    const ownReview = !task || data?.tasks.some(item => item.id === task && Reflect.get(item, 'current') === true)
    const files = (ownReview ? reviewFiles : undefined) ?? data?.files ?? []
    const file = files.find(item => item.path === selected) ?? files[0]
    const pending = ownReview && !!review && ['pending', 'sending'].includes(review.status)
    const feedbackSent = ownReview && review?.status === 'submitted' && review.outcome === 'feedback'
    const approved = !!data?.approvalHistory?.length && !pending && !feedbackSent
    const approvalDetails = (item: NonNullable<Resources['approvalHistory']>[number]) => {
      const source = item.provenance?.status === 'verified'
        ? '来源已记录' + (item.provenance.sessionId ? ` · 会话 ${item.provenance.sessionId}` : '') + (item.provenance.taskId ? ` · 任务 ${item.provenance.taskId}` : '')
        : '来源未知（历史记录未保存来源）'
      const versions = item.artifactHashes === undefined
        ? '文档版本未知'
        : Object.entries(item.artifactHashes).map(([path, hash]) => `${resourceTitle(path)} ${hash.slice(0, 12)}`).join('；')
      return `${source} · ${versions}`
    }
    const badge = pending ? '待确认' : feedbackSent ? '意见已提交' : approved ? '历史审批记录' : '草稿'
    const tone = pending ? 'warning' : feedbackSent ? 'blue' : 'neutral'
    const selectFile = (path: string) => { setSelected(path); setListing(false) }
    const runDatabaseAction = async (action: { type: 'create-database-snapshot'; reason?: string; kind?: 'data' | 'schema' } | { type: 'restore-database-snapshot'; snapshotId: string; targetDatabase: string }): Promise<void> => {
      if (!props.sessionId || !task || !ownReview || snapshotBusy) return
      setSnapshotBusy(true); setError(''); setSnapshotMessage('')
      try {
        const query = new URLSearchParams({ sessionId: props.sessionId })
        const stateResponse = await fetch('/plugins/backend-team/control/state?' + query, { credentials: 'same-origin', cache: 'no-store' })
        if (!stateResponse.ok) throw new Error('当前任务状态无法读取，请刷新资源重试。')
        const state = BackendTeamViewStateSchema.parse(await stateResponse.json())
        if (!state.workspaceId || state.taskId !== task) throw new Error('当前资源已切换，请重新打开任务。')
        const response = await fetch('/plugins/backend-team/control/dispatch?' + query, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...action, workspaceId: state.workspaceId, taskId: state.taskId, expectedRevision: state.stateRevision }) })
        if (!response.ok) {
          const result = await response.json().catch(() => ({})) as { code?: string }
          throw new Error(result.code === 'STALE_VIEW' ? '任务状态已变化，请刷新后重试。' : '数据库操作未完成，请查看任务状态后重试。')
        }
        setRestoreSnapshotId(''); setRestoreTargetDatabase(''); setSnapshotReason(''); setRefresh(value => value + 1)
        setSnapshotMessage(action.type === 'create-database-snapshot' ? '数据库备份已完成，可在下方查看校验摘要。' : `数据库已恢复到新库：${action.targetDatabase}`)
      } catch (cause) { setError(cause instanceof Error ? cause.message : '数据库操作失败') } finally { setSnapshotBusy(false) }
    }
    const iconButton = (label: string, icon: unknown, onClick: () => void) => h(ui.Button, { variant: 'ghost', size: 'icon', 'aria-label': label, title: label, onClick }, h(icon, { 'aria-hidden': true }))
    const empty = (title: string, description: string, icon: unknown = FolderOpen, retry = false) => h('div', { className: 'bt-empty', role: retry ? 'alert' : 'status' }, h(icon, { 'aria-hidden': true }), h('h2', null, title), h('p', null, description), h(ui.Button, { variant: 'outline', onClick: retry ? () => setRefresh(value => value + 1) : close }, retry ? '重新加载' : '返回对话'))
    const changeContent = data?.changes?.available
      ? h('div', null, h('h2', null, '本次文档变化'), h('p', { className: 'bt-muted' }, '与上一份待审阅记录比较，以下显示实际修改内容。'), ...data.changes.files.filter(change => change.path === file?.path).flatMap(change => reviewSections(change.before, change.after).map((section, index) => h('section', { key: change.path + index, className: 'bt-change-row' }, h('span', { className: 'bt-change-number' }, String(index + 1) + '.'), h(ui.Badge, { tone: section.kind === '新增' ? 'success' : section.kind === '调整' ? 'blue' : 'warning' }, section.kind), h('div', { className: 'bt-change-copy' }, h('h3', null, section.title), section.after ? h('div', { className: 'bt-document' }, h(markdown, { text: section.after })) : h('p', { className: 'bt-muted' }, '此内容已从方案中移除。'), section.before ? h('details', { className: 'bt-change-before' }, h('summary', null, '查看修改前'), h('div', { className: 'bt-document' }, h(markdown, { text: section.before }))) : null)))), !data.changes.files.some(change => change.path === file?.path) ? h('p', { className: 'bt-muted' }, '此文档与上一份记录一致。') : null)
      : h('div', { className: 'bt-empty' }, h(FileText, { 'aria-hidden': true }), h('h2', null, '暂无上一版本可比较'), h('p', null, '你可以查看完整文档。后续方案更新后，这里会展示实际变化。'), h(ui.Button, { onClick: () => setTab('document') }, '阅读完整文档'))
    const snapshots = data?.databaseSnapshots ?? []
    const renderSnapshot = (snapshot: DatabaseSnapshot) => h('article', { className: 'bt-snapshot-card', key: snapshot.id },
      h('div', { className: 'bt-snapshot-title' }, h('strong', null, snapshot.kind === 'schema' ? '结构备份' : '数据备份'), h('code', null, snapshot.id)),
      h('p', { className: 'bt-muted' }, `${snapshot.database} · PostgreSQL ${snapshot.serverVersion} · ${new Date(snapshot.createdAt).toLocaleString('zh-CN')}`),
      h('p', null, snapshot.reason),
      h('details', null, h('summary', null, '校验摘要'), h('code', null, snapshot.sha256)),
      ownReview ? h(ui.Button, { size: 'sm', variant: restoreSnapshotId === snapshot.id ? 'default' : 'outline', disabled: snapshotBusy, onClick: () => { setRestoreSnapshotId(restoreSnapshotId === snapshot.id ? '' : snapshot.id); setRestoreTargetDatabase('') } }, restoreSnapshotId === snapshot.id ? '取消恢复' : '恢复到新库') : null,
      restoreSnapshotId === snapshot.id ? h('div', { className: 'bt-snapshot-restore', role: 'group', 'aria-label': '确认数据库恢复' },
        h('p', { className: 'bt-muted' }, '恢复只写入新建的空数据库，不会覆盖备份来源库。请先准备目标数据库，再明确确认。'),
        h('input', { value: restoreTargetDatabase, maxLength: 50, disabled: snapshotBusy, 'aria-label': '恢复目标数据库', placeholder: '目标数据库名，例如 restored_preview', onChange: (event: { target: { value: string } }) => setRestoreTargetDatabase(event.target.value.toLowerCase()) }),
        h(ui.Button, { size: 'sm', disabled: snapshotBusy || !/^[a-z0-9_]{1,50}$/.test(restoreTargetDatabase), onClick: () => void runDatabaseAction({ type: 'restore-database-snapshot', snapshotId: snapshot.id, targetDatabase: restoreTargetDatabase }) }, snapshotBusy ? '恢复中…' : '确认恢复')) : null,
    )
    const snapshotSection = snapshots.length === 0 && !ownReview ? null : h('section', { className: 'bt-related bt-database-snapshots', 'aria-label': '数据库备份' },
      h('div', { className: 'bt-resource-subheading' }, h('h3', null, '数据库备份'), snapshots.length ? h(ui.Badge, { tone: 'blue' }, `${snapshots.length} 份`) : h(ui.Badge, null, '暂无备份')),
      h('p', { className: 'bt-muted' }, 'Agent 在数据库变更前保存的工作区备份，可用于恢复前核对版本。'),
      snapshotMessage ? h('p', { className: 'bt-snapshot-result', role: 'status', 'aria-live': 'polite' }, snapshotMessage) : null,
      ownReview ? h('div', { className: 'bt-snapshot-create' }, h('input', { value: snapshotReason, maxLength: 1000, disabled: snapshotBusy, 'aria-label': '备份原因', placeholder: '备份原因（可选）', onChange: (event: { target: { value: string } }) => setSnapshotReason(event.target.value) }), h(ui.Button, { size: 'sm', disabled: snapshotBusy, onClick: () => void runDatabaseAction({ type: 'create-database-snapshot', ...(snapshotReason.trim() ? { reason: snapshotReason.trim() } : {}), kind: 'data' }) }, snapshotBusy ? '处理中…' : '立即备份')) : null,
      snapshots.length ? h('div', { className: 'bt-snapshot-list' }, ...snapshots.map(renderSnapshot)) : h('p', { className: 'bt-muted' }, ownReview ? '尚无备份，可由 Agent 或这里的操作创建。' : '尚无可查看的备份。'),
    )
    const preview = file ? h('article', { 'aria-label': '资源预览', className: 'bt-resource-preview' }, tab === 'changes' ? changeContent : file.error ? h('p', { role: 'status' }, file.error) : h('div', { className: 'bt-document' }, file.path.endsWith('.md') ? h(markdown, { text: file.content ?? '' }) : h('pre', null, file.content)), files.length > 1 ? h('section', { className: 'bt-related' }, h('h3', null, '相关文档'), h('div', null, ...files.filter(item => item.path !== file.path).slice(0, 2).map(item => h('button', { className: 'bt-file', type: 'button', key: item.path, onClick: () => { selectFile(item.path); setTab('document') } }, h(FileText, { 'aria-hidden': true }), resourceTitle(item.path))))) : null, file.sha256 ? h('details', { className: 'bt-version' }, h('summary', null, '版本校验信息'), h('code', null, file.sha256)) : null, snapshotSection) : snapshotSection
    return h('aside', { ref: setPanelElement, className: 'bt-ui bt-resource-panel', 'aria-label': '任务资源' },
      h('header', { className: 'bt-resource-header' }, h(ui.Button, { variant: 'ghost', onClick: props.onAllTasks }, h(ArrowLeft, { 'aria-hidden': true }), '团队任务'), h('div', { className: 'bt-resource-tools' }, data?.files.length ? iconButton('刷新资源', RefreshCw, () => setRefresh(value => value + 1)) : null, iconButton('关闭资源', X, close))),
      error ? empty('资源暂时无法加载', error, AlertCircle, true) : data === undefined ? empty('正在加载资源', '正在读取当前任务的文档和产物。') : !data.files.length && !snapshots.length ? empty('任务产物会保存在这里', '在对话中提出需求。团队生成的需求、设计和交付文件会集中显示在这里。') : h('div', { className: 'bt-resource-body' },
        h('div', { className: 'bt-resource-heading' }, h(ui.Button, { variant: 'ghost', className: 'bt-back', onClick: () => setListing(value => !value) }, h(ArrowLeft, { 'aria-hidden': true }), listing ? '返回文档' : '所有资源'), h('div', { className: 'bt-resource-title' }, h(FileText, { 'aria-hidden': true }), h('h2', null, listing ? '全部任务资源' : file ? resourceTitle(file.path) : '任务文档'), reviewVersion && reviewFiles && !listing ? h(ui.Badge, { tone: 'blue' }, reviewVersion.replace('状态版本 ', '')) : null, !listing ? h(ui.Badge, { tone }, badge) : null)),
        listing ? h('nav', { className: 'bt-resource-files', 'aria-label': '资源文件' }, data.tasks.length > 1 && !reviewFiles ? h('select', { 'aria-label': '选择任务', value: task || data.taskId, onChange: (event: { target: { value: string } }) => setTask(event.target.value) }, ...data.tasks.map(item => h('option', { key: item.id, value: item.id }, item.title))) : null, ...['方案文档', '开发产物', '验收报告'].flatMap(category => { const categoryFiles = files.filter(item => item.category === category); return categoryFiles.length ? [h('h3', { key: category }, category), ...categoryFiles.map(item => h('button', { key: item.path, type: 'button', className: 'bt-file', 'aria-pressed': item.path === selected, onClick: () => selectFile(item.path) }, h(FileText, { 'aria-hidden': true }), resourceTitle(item.path)))] : [] }))
          : h(ui.Tabs, { value: tab, onValueChange: setTab, scrollKey: (file?.path ?? '') + ':' + tab, offsets: saved.offsets }, preview)),
      Footer && props.sessionId && review && ownReview ? h(Footer, { sessionId: props.sessionId }) : approved ? h('footer', { className: 'bt-review-footer' }, h('div', { className: 'bt-receipt', 'data-tone': 'neutral' }, h(CircleCheck, { 'aria-hidden': true }), h('div', null, h('strong', null, '已有任务的审批记录'), h('p', { className: 'bt-muted' }, '所属任务：' + (data?.title ?? '已有任务') + '。以下记录不代表当前新增或变更需求已经确认。'))), h('details', null, h('summary', null, '审批记录'), ...data!.approvalHistory!.map(item => h('p', { key: item.kind + item.approvedAt, className: 'bt-muted' }, (item.kind === 'design' ? '设计' : item.kind === 'requirements' ? '需求' : item.kind) + ' · ' + new Date(item.approvedAt).toLocaleString('zh-CN') + ' · ' + approvalDetails(item))))) : null)
  }
  const open = () => {
    page = { kind: 'resources' }
    navigate?.(page)
    mount()
  }
  const openTasks = () => { page = { kind: 'tasks' }; navigate?.(page); mount() }
  const mount = () => {
    removePanel ??= context.slots.register({ name: 'details', priority: -100 }, props => h(Root, { ...(props as Record<string, unknown>), key: (props as { sessionId?: string }).sessionId }))
    layout.openDetails()
  }
  function Binding(props: { sessionId?: string }) {
    const [title, setTitle] = react.useState('正在核对任务…')
    react.useEffect(() => {
      const controller = new AbortController()
      const load = async () => {
        if (!props.sessionId) return
        try {
          const response = await fetch('/plugins/backend-team/control/state?' + new URLSearchParams({ sessionId: props.sessionId }), { credentials: 'same-origin', signal: controller.signal })
          if (!response.ok) throw new Error('load failed')
          const state = BackendTeamViewStateSchema.parse(await response.json())
          if (!controller.signal.aborted) setTitle(state.taskId && state.taskId !== 'unassigned' ? state.workspaceName : '尚未关联')
        } catch { if (!controller.signal.aborted) setTitle('任务状态暂不可用') }
      }
      void load(); const timer = setInterval(() => void load(), 5000)
      return () => { controller.abort(); clearInterval(timer) }
    }, [props.sessionId])
    return h('span', { className: 'bt-ui bt-task-binding' }, h(ui.Button, { variant: 'ghost', size: 'sm', onClick: openTasks, title: '当前团队任务：' + title }, h(FolderOpen, { 'aria-hidden': true }), h('span', null, '团队任务：' + title)))
  }
  const removeBinding = context.slots.inject('conversation.session.header.actions', () => context.slots.register({ name: 'conversation.session.header.actions', id: 'backend-team-binding', order: 60 }, props => h(Binding, props as Record<string, unknown>)))
  const removeButton = context.slots.inject('conversation.session.header.utilities', () => context.slots.register({ name: 'conversation.session.header.utilities', id: 'backend-team-resources', order: 50 }, () => h('span', { className: 'bt-ui bt-header-resource-trigger' }, h(ui.Button, { onClick: openTasks, size: 'sm', title: '团队任务' }, h(FolderOpen, { 'aria-hidden': true }), h('span', null, '团队任务')))))
  return { open, dispose() { removePanel?.(); removeButton(); removeBinding(); reading.clear() } }
}
export function resourceTitle(path: string): string {
  const titles: Record<string, string> = { 'spec.md': '需求规格', 'clarification.md': '需求确认记录', 'plan.md': '设计方案', 'architecture.md': '架构设计', 'data-model.md': '数据设计', 'openapi.yaml': '接口契约', 'test-plan.md': '验收方案', 'research.md': '调研记录', 'decisions.md': '设计决策', 'tasks.md': '开发任务', 'report.json': '验收报告' }
  return titles[path.split('/').at(-1)!] ?? path.split('/').slice(-2).join('/')
}
