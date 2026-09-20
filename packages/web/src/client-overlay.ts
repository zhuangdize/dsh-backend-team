import { createBackendTeamControlClient } from './control-client.js'
import type { BackendTeamControlClient, BackendTeamControlDispatchResult, BackendTeamControlTransport } from './control-client.js'
import type { BackendTeamControlAction } from './control-actions.js'
import { BackendTeamViewStateSchema } from './view-model.js'
import { createTaskProgressHome } from './task-progress-home.js'
import type { BackendTeamPanelModel } from './panel-model.js'

/** The small React surface needed by the browser entry. Keeping it structural
 * lets the host provide its singleton React module without bundling another
 * copy of React into the plugin. */
export interface BackendTeamReactLike {
  readonly createElement: (type: unknown, props: Readonly<Record<string, unknown>> | null, ...children: unknown[]) => unknown
  readonly useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => void
  readonly useState: <T>(initial: T | (() => T)) => readonly [T, (next: T | ((previous: T) => T)) => void]
}

export interface BackendTeamFetchResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

export type BackendTeamFetch = (input: string, init?: {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly credentials?: 'same-origin'
  readonly cache?: 'no-store'
}) => Promise<BackendTeamFetchResponse>

export interface BackendTeamOverlayOptions {
  /** Must match the host's `applyBackendTeamControlRoute` path. */
  readonly controlPath?: string
  /** Optional fallback for hosts that do not include workspaceId in state. */
  readonly workspaceId?: string
  /** Optional host-provided current DSH session id for authenticated requests. */
  readonly sessionId?: string
  readonly refreshIntervalMs?: number
  readonly fetch?: BackendTeamFetch
  /** Host-owned navigation hook; never accepts a non-loopback URL. */
  readonly openNavigation?: (url: string) => void
  /** Static, non-secret explanation shown when the production route is unavailable. */
  readonly diagnostic?: BackendTeamOverlayDiagnostic
  readonly openResources?: () => void
}

export interface BackendTeamOverlayDiagnostic {
  readonly mode: 'read-only'
  readonly reason: string
  readonly missing?: readonly string[]
}

export interface BackendTeamOverlayProps {
  /** Global Harness slot hook; its snapshot carries the current session id. */
  readonly useSessions?: unknown
  readonly useWorkspaces?: unknown
}

const DEFAULT_CONTROL_PATH = '/plugins/backend-team/control'
const DEFAULT_REFRESH_INTERVAL_MS = 2_000
const MAX_DIAGNOSTIC_ITEMS = 8
const MAX_DIAGNOSTIC_TEXT = 200
const MAX_PREVIEW_FILES = 32
const MAX_PREVIEW_PATH = 240
const MAX_PREVIEW_CONTENT = 128 * 1024

export function formatBackendTeamOverlayDiagnostic(diagnostic: BackendTeamOverlayDiagnostic): string {
  if (diagnostic === null || typeof diagnostic !== 'object' || diagnostic.mode !== 'read-only') throw new TypeError('overlay diagnostic must be read-only')
  const missing = safeDiagnosticList(diagnostic.missing)
  const reason = safeDiagnosticText(diagnostic.reason)
  const missingText = missing.length === 0 ? '' : `缺少能力：${missing.join('、')}。`
  const reasonText = reason.length === 0 ? '' : `原因：${reason}。`
  return `当前为只读诊断模式。${missingText}${reasonText}`
}

export function renderBackendTeamDiagnosticFallback(react: BackendTeamReactLike, diagnostic: BackendTeamOverlayDiagnostic): unknown {
  assertReact(react)
  return react.createElement('div', { role: 'status', 'aria-live': 'polite', style: shellStyle }, formatBackendTeamOverlayDiagnostic(diagnostic))
}

/** Build the same-origin transport used by the overlay. Cookies/session state
 * remain browser-owned; the Bundle never receives or persists credentials. */
export function createBackendTeamFetchTransport(fetcher: BackendTeamFetch, path = DEFAULT_CONTROL_PATH, sessionId?: string): BackendTeamControlTransport {
  assertControlPath(path)
  if (typeof fetcher !== 'function') throw new TypeError('fetcher is required')
  const query = sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(assertSessionId(sessionId))}`
  const request = async (suffix: 'state' | 'dispatch', init?: Parameters<BackendTeamFetch>[1]): Promise<unknown> => {
    const response = await fetcher(`${path}/${suffix}${query}`, { credentials: 'same-origin', cache: 'no-store', ...init })
    const body = await response.json().catch(() => undefined)
    if (!response.ok) throw new BackendTeamOverlayHttpError(response.status, body)
    return body
  }
  return Object.freeze({
    getState: () => request('state'),
    dispatch: (action: BackendTeamControlAction) => request('dispatch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) }),
  })
}

/** Create the additive root overlay component. React is supplied by the
 * Harness module table at materialization time, so this source remains safe
 * to import in Node-side contract tests. */
export function createBackendTeamOverlayComponent(react: BackendTeamReactLike, options: BackendTeamOverlayOptions = {}): (props: BackendTeamOverlayProps) => unknown {
  assertReact(react)
  const path = options.controlPath ?? DEFAULT_CONTROL_PATH
  assertControlPath(path)
  const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 250 || refreshIntervalMs > 60_000) throw new RangeError('overlay refresh interval is invalid')
  const fetcher = options.fetch ?? defaultFetch

  return function BackendTeamOverlay(props: BackendTeamOverlayProps = {}): unknown {
    const sessionId = options.sessionId ?? readCurrentSessionId(props)
    const [client, setClient] = react.useState<BackendTeamControlClient | undefined>(() => undefined)
    const [model, setModel] = react.useState<BackendTeamPanelModel | undefined>(() => undefined)
    const [loading, setLoading] = react.useState(true)
    const [message, setMessage] = react.useState<string | undefined>(() => undefined)
    const [guiLogin, setGuiLogin] = react.useState<{ username: string; password: string; url: string; sessionId: string | undefined } | undefined>(() => undefined)
    const [clarificationText, setClarificationText] = react.useState('')
    const [clarificationSubmitting, setClarificationSubmitting] = react.useState(false)
    const [artifactPreview, setArtifactPreview] = react.useState<BackendTeamArtifactPreview | undefined>(() => undefined)
    const [connectionMessage, setConnectionMessage] = react.useState<string | undefined>(() => undefined)
    const [pendingAction, setPendingAction] = react.useState<string | undefined>(() => undefined)
    const [operation] = react.useState(() => ({ pending: false }))
    const transport = createBackendTeamFetchTransport(fetcher, path, sessionId)

    const refresh = async (existing?: BackendTeamControlClient, isActive: () => boolean = () => true): Promise<boolean> => {
      try {
        if (existing !== undefined) {
          await existing.refresh()
          if (isActive()) {
            setModel(existing.model())
            setConnectionMessage(undefined)
          }
          return true
        }
        const raw = await transport.getState()
        const parsed = BackendTeamViewStateSchema.parse(raw)
        const workspaceId = options.workspaceId ?? parsed.workspaceId
        if (workspaceId === undefined || workspaceId.length === 0) throw new Error('control state did not include workspaceId')
        const next = createBackendTeamControlClient({ workspaceId, transport })
        next.applySnapshot(parsed)
        if (isActive()) {
          setClient(next)
          setModel(next.model())
          setConnectionMessage(undefined)
        }
        return true
      } catch (error: unknown) {
        if (isActive()) setConnectionMessage(readableError(error))
        return false
      } finally {
        if (isActive()) setLoading(false)
      }
    }

    react.useEffect(() => {
      let active = true
      setClient(undefined)
      setModel(undefined)
      setLoading(true)
      setGuiLogin(undefined)
      setArtifactPreview(undefined)
      setMessage(undefined)
      setConnectionMessage(undefined)
      let retry: ReturnType<typeof setTimeout> | undefined
      const connect = async (): Promise<void> => {
        const connected = await refresh(undefined, () => active)
        if (active && !connected) retry = setTimeout(() => { void connect() }, refreshIntervalMs)
      }
      void connect()
      return () => { active = false; clearTimeout(retry) }
    }, [sessionId])

    react.useEffect(() => {
      if (guiLogin === undefined) return
      const timer = setTimeout(() => setGuiLogin(undefined), 60_000)
      return () => clearTimeout(timer)
    }, [guiLogin])

    react.useEffect(() => {
      if (client === undefined) return
      let active = true
      let refreshing = false
      const timer = setInterval(() => {
        if (!active || refreshing) return
        refreshing = true
        void refresh(client, () => active).finally(() => { refreshing = false })
      }, refreshIntervalMs)
      return () => { active = false; clearInterval(timer) }
    }, [client])

    const approvalKey = model?.approval === undefined ? undefined : `${client?.snapshot()?.taskId}:${model.approval.id}:${model.approval.artifactHash}:${model.diagnostics.stateRevision}`
    react.useEffect(() => {
      setArtifactPreview(undefined)
    }, [sessionId, approvalKey])

    react.useEffect(() => {
      if (artifactPreview === undefined || client === undefined || model?.approval?.artifactHash !== artifactPreview.artifactHash) return
      try {
        client.inspectApproval()
        setModel(client.model())
        setMessage('方案预览已显示，现在可以确认')
      } catch (error: unknown) {
        setMessage(readableError(error))
      }
    }, [artifactPreview, client, model?.approval?.artifactHash])

    const workspaceId = client?.snapshot()?.workspaceId ?? options.workspaceId
    const taskId = client?.snapshot()?.taskId
    const base = model === undefined || client === undefined || workspaceId === undefined ? undefined : { workspaceId, expectedRevision: model.diagnostics.stateRevision, ...(taskId === undefined ? {} : { taskId }) }

    const renderAction = (label: string, enabled: boolean, action: unknown, key: string): unknown => react.createElement('button', {
      key,
      type: 'button',
      disabled: !enabled || pendingAction !== undefined || connectionMessage !== undefined,
      onClick: async () => {
        if (!enabled || operation.pending || connectionMessage !== undefined) return
        const result = await dispatch(action)
        if (!isOpenArtifactAction(action)) return
        const artifactHash = readArtifactId(action)
        const preview = result === undefined || artifactHash === undefined ? undefined : parseArtifactPreview(result.response, artifactHash)
        if (preview === undefined) {
          setArtifactPreview(undefined)
          setMessage('方案预览不可用，未标记为已查看')
          return
        }
        setArtifactPreview(preview)
      },
      style: buttonStyle(enabled && pendingAction === undefined && connectionMessage === undefined, key === 'confirm-approval'),
    }, label)

    const dispatch = async (action: unknown): Promise<BackendTeamControlDispatchResult | undefined> => {
      if (client === undefined || operation.pending || connectionMessage !== undefined) return undefined
      operation.pending = true
      setPendingAction('正在处理，请稍候…')
      setGuiLogin(undefined)
      setMessage(undefined)
      try {
        const result = await client.dispatch(action)
        setModel(client.model())
        setMessage(result.response.navigation === undefined ? '操作已提交' : '操作已提交，可打开本机页面继续')
        if (result.response.navigation !== undefined) {
          const target = result.response.navigation.url
          const query = sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`
          const response = await fetcher(`/plugins/backend-team/dbgate-login${query}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: '{}' })
          const login = await response.json() as unknown
          if (response.ok && isGuiLogin(login, target)) {
            setGuiLogin({ ...login, sessionId })
            setMessage('本次登录信息仅临时显示，请保存后打开数据库页面')
          } else {
            setMessage('数据库已启动，但本次登录信息不可用。请重新打开数据库。')
          }
        }
        return result
      } catch (error: unknown) {
        setMessage(readableError(error))
        return undefined
      } finally {
        operation.pending = false
        setPendingAction(undefined)
      }
    }

    const submitClarification = async (): Promise<void> => {
      const text = clarificationText.trim()
      if (!isBackendTeamClarificationAvailable(model) || base === undefined || text.length === 0 || clarificationSubmitting) return
      setClarificationSubmitting(true)
      try {
        const result = await dispatch({ ...base, type: 'submit-clarification', text })
        if (result !== undefined) setClarificationText('')
      } finally {
        setClarificationSubmitting(false)
      }
    }

    if (loading && model === undefined) return react.createElement('div', { role: 'status', 'aria-live': 'polite', style: shellStyle }, '正在加载后端开发状态…')
    if (model === undefined) {
      if (options.diagnostic !== undefined) return react.createElement('section', { style: shellStyle },
        react.createElement('h2', null, '连接后端团队'),
        react.createElement('p', null, connectionMessage === '本地会话未登录' ? '当前会话尚未连接到已配置的团队项目。请切换到对应工作区的会话。' : connectionMessage ?? '正在等待团队服务连接。'),
        react.createElement('p', { style: descriptionStyle }, '普通对话仍可使用；团队任务需要对应项目的配置。'),
      )
      return react.createElement('div', { role: 'status', 'aria-live': 'polite', style: shellStyle }, connectionMessage ?? message ?? '后端开发团队暂不可用')
    }

    const approval = model.approval
    const approvalActions = approval === undefined || base === undefined ? [] : [
      renderAction(approval.viewAction.label, approval.viewAction.enabled, { ...base, type: 'open-artifact', artifactId: approval.viewAction.artifactId }, 'view-approval'),
      renderAction(approval.confirmAction.label, approval.confirmAction.enabled, { ...base, type: 'decide-approval', approvalId: approval.confirmAction.approvalId, decision: 'approve', artifactHash: approval.confirmAction.artifactHash }, 'confirm-approval'),
      renderAction('退回修改', approval.confirmAction.enabled, { ...base, type: 'decide-approval', approvalId: approval.confirmAction.approvalId, decision: 'reject', artifactHash: approval.confirmAction.artifactHash }, 'reject-approval'),
    ]
    const primary = model.primaryAction
    const primaryAction = base === undefined || primary.type === 'none' ? undefined : renderAction(primary.label, primary.enabled, { ...base, type: primary.type, ...(primary.artifactId === undefined ? {} : { artifactId: primary.artifactId }), ...(primary.stepId === undefined ? {} : { stepId: primary.stepId }) }, 'primary')
    const clarificationForm = taskId === 'unassigned' || base === undefined || !isBackendTeamClarificationAvailable(model) ? null : react.createElement('form', {
      'aria-label': '补充需求',
      onSubmit: (event: unknown) => { readPreventDefault(event); void submitClarification() },
      style: approvalStyle,
    },
    react.createElement('label', null, '补充需求', react.createElement('textarea', {
      'aria-label': '补充需求内容',
      value: clarificationText,
      maxLength: 8_000,
      rows: 3,
      onChange: (event: unknown) => setClarificationText(readInputText(event).slice(0, 8_000)),
      style: textAreaStyle,
    })),
    react.createElement('button', {
      type: 'button',
      disabled: clarificationSubmitting || pendingAction !== undefined || connectionMessage !== undefined || clarificationText.trim().length === 0,
      onClick: () => { void submitClarification() },
      style: buttonStyle(!clarificationSubmitting && clarificationText.trim().length > 0),
    }, clarificationSubmitting ? '提交中…' : '提交补充说明'))

    const homeActions = {
      openResources: () => options.openResources?.(),
      openTechnical: () => setMessage('技术详情已展开；完整执行轨迹请查看顶部“轨迹”页签。'),
      pause: () => { if (base) void dispatch({ ...base, type: 'pause-run' }) },
      resume: () => { if (base) void dispatch({ ...base, type: 'resume-run' }) },
      inspect: () => {
        if (!approval || !base) return
        void dispatch({ ...base, type: 'open-artifact', artifactId: approval.artifactHash }).then((result) => {
          const preview = result === undefined ? undefined : parseArtifactPreview(result.response, approval.artifactHash)
          if (preview === undefined) {
            setArtifactPreview(undefined)
            setMessage('方案预览不可用，未标记为已查看')
            return
          }
          setArtifactPreview(preview)
        })
      },
      approve: () => { if (approval && base) void dispatch({ ...base, type: 'decide-approval', approvalId: approval.id, decision: 'approve', artifactHash: approval.artifactHash }) },
      reject: () => { if (approval && base) void dispatch({ ...base, type: 'decide-approval', approvalId: approval.id, decision: 'reject', artifactHash: approval.artifactHash }) },
    }
    const currentGuiLogin = guiLogin?.sessionId === sessionId ? guiLogin : undefined
    const databaseAccess = model.database.guiAvailable || currentGuiLogin !== undefined ? { available: model.database.guiAvailable, ...(currentGuiLogin === undefined ? {} : { login: { username: currentGuiLogin.username, password: currentGuiLogin.password } }) } : undefined
    const openDatabase = () => { if (base && model.database.guiAvailable) void dispatch({ ...base, type: 'open-database-gui' }) }
    const openDatabaseLogin = () => { if (currentGuiLogin === undefined) return; const url = currentGuiLogin.url; setGuiLogin(undefined); openNavigation(url, options.openNavigation) }
    const homeWithDatabase = { ...homeActions, openDatabase, openDatabaseLogin, hideDatabaseLogin: () => setGuiLogin(undefined) }
    if (options.openResources !== undefined && model !== undefined && client !== undefined && workspaceId !== undefined && taskId !== undefined && taskId !== 'unassigned') return createTaskProgressHome(react, client.snapshot()!, model, homeWithDatabase, artifactPreview, databaseAccess)

    return react.createElement('section', { role: 'region', 'aria-label': '后端开发团队', 'aria-busy': pendingAction !== undefined, style: shellStyle },
      react.createElement('p', { style: eyebrowStyle }, '项目工作台 · 后端团队'),
      react.createElement('div', { style: headerStyle },
        react.createElement('h2', { style: titleStyle }, model.title),
        react.createElement('div', { style: { ...phaseStyle, ...(model.phase.value === 'DELIVER' ? { color: '#17684d', background: '#eaf5ef' } : {}) } }, model.phase.label),
      ),
      react.createElement('p', { style: descriptionStyle }, model.phase.description),
      pendingAction === undefined ? null : react.createElement('p', { role: 'status', 'aria-live': 'polite', style: messageStyle }, pendingAction),
      message === undefined ? null : react.createElement('p', { role: 'status', 'aria-live': 'polite', style: messageStyle }, message),
      connectionMessage === undefined ? null : react.createElement('p', { role: 'status', 'aria-live': 'polite', style: messageStyle }, connectionMessage),
      react.createElement('p', { style: hintStyle }, model.approval !== undefined ? '有方案等待你的确认。先阅读内容，再确认通过或退回修改。' : model.phase.value === 'DELIVER' ? '当前任务已交付。直接在对话中提出下一项需求，团队会创建独立任务并保留历史记录。' : taskId === 'unassigned' ? '在下方对话中描述你要做的功能，团队会创建任务，并先整理需求供你确认。' : '这里查看团队进度和阶段产物；需求与补充说明请在对话中提出。'),
      react.createElement('div', { style: gridStyle },
        metric(react, '当前阶段', model.phase.label),
        metric(react, '需要你处理', model.approval !== undefined ? '有方案等待确认' : model.risk.level === 'normal' ? '暂无待确认事项' : model.risk.level === 'attention' ? '请查看待处理事项' : '任务受阻，请查看原因'),
        metric(react, '验收结果', model.verification.summary),
      ),
      model.risk.messages.length === 0 ? null : react.createElement('section', { 'aria-label': '待处理事项', style: approvalStyle },
        react.createElement('strong', null, '待处理事项'),
        react.createElement('ul', null, ...model.risk.messages.map((detail, index) => react.createElement('li', { key: index }, detail))),
      ),
      guiLogin === undefined || guiLogin.sessionId !== sessionId ? null : react.createElement('div', { role: 'group', 'aria-label': '本次数据库登录', style: approvalStyle },
        react.createElement('label', null, '用户名', react.createElement('input', { readOnly: true, value: guiLogin.username, autoComplete: 'off' })),
        react.createElement('label', null, '密码', react.createElement('input', { readOnly: true, value: guiLogin.password, autoComplete: 'off', type: 'text' })),
        react.createElement('button', { type: 'button', onClick: () => { const url = guiLogin.url; setGuiLogin(undefined); openNavigation(url, options.openNavigation) } }, '打开数据库'),
        react.createElement('button', { type: 'button', onClick: () => setGuiLogin(undefined) }, '隐藏登录信息'),
      ),
      model.approval === undefined ? null : react.createElement('div', { style: approvalStyle },
        react.createElement('strong', null, '需要确认'),
        react.createElement('p', { style: descriptionStyle }, approval?.summary),
        approval?.confirmAction.enabled ? null : react.createElement('p', { style: descriptionStyle }, '请先点击“查看方案”阅读当前版本，确认按钮随后可用。'),
        artifactPreview === undefined || artifactPreview.artifactHash !== approval?.artifactHash ? null : renderArtifactPreview(react, artifactPreview),
        react.createElement('div', { style: actionRowStyle }, ...approvalActions),
      ),
      model.delivery === undefined ? null : react.createElement('section', { 'aria-label': '交付检查', style: approvalStyle },
        react.createElement('strong', null, model.delivery.status === 'ready' ? '需求验收已通过' : '交付前仍有待处理项'),
        react.createElement('p', null, model.delivery.scope),
        react.createElement('p', null, `${model.delivery.requirements.filter(item => item.status === 'passed').length}/${model.delivery.requirements.length} 项需求已取得完整验收证据`),
        model.delivery.requirements.length === 0 ? react.createElement('p', null, '尚无需求验收记录，不能确认交付。') : react.createElement('ul', { 'aria-label': '需求验收' }, ...model.delivery.requirements.map(item => react.createElement('li', { key: item.requirementId },
          `${item.requirementId}：${item.status === 'passed' ? '已通过' : item.status === 'failed' ? '未通过' : item.status === 'blocked' ? '受阻' : '待验证'}`,
          item.missingEvidenceIds.length === 0 ? null : react.createElement('p', null, `缺少证据：${item.missingEvidenceIds.join('、')}`),
        ))),
        model.delivery.unresolvedItems.length === 0 ? null : react.createElement('details', null,
          react.createElement('summary', null, `Agent 留下的待处理事项（${model.delivery.unresolvedItems.length}）`),
          react.createElement('ul', null, ...model.delivery.unresolvedItems.map((item, index) => react.createElement('li', { key: index }, item))),
        ),
        react.createElement('details', { style: { marginTop: '16px' } }, react.createElement('summary', { style: summaryStyle }, '报告位置'), react.createElement('p', { style: { overflowWrap: 'anywhere' } }, model.delivery.reportPath)),
      ),
      taskId === 'unassigned' ? null : react.createElement('details', { style: sectionStyle },
        react.createElement('summary', { style: summaryStyle }, '人工接管'),
        react.createElement('p', { style: descriptionStyle }, '通常由 Agent 按任务需要准备环境、执行检查。仅在需要排查或手动介入时使用以下操作。'),
        react.createElement('p', { style: descriptionStyle }, `运行环境：${model.database.label}`),
        clarificationForm,
        primaryAction === undefined ? react.createElement('p', null, primary.label) : react.createElement('div', { style: actionRowStyle }, primaryAction),
        base === undefined || !model.database.controlsAvailable ? null : renderAction('启动数据库', model.database.runtime === 'stopped' || model.database.runtime === 'failed', { ...base, type: 'start-database' }, 'database-start'),
        base === undefined || !model.database.controlsAvailable ? null : renderAction('停止数据库', model.database.runtime === 'ready' || model.database.runtime === 'failed', { ...base, type: 'stop-database' }, 'database-stop'),
        base === undefined || !model.database.guiAvailable ? null : renderAction(model.database.guiAction.label, model.database.guiAction.enabled, { ...base, type: 'open-database-gui' }, 'database-gui'),
        model.database.migrationMessage === undefined ? null : react.createElement('p', { role: 'status', style: descriptionStyle }, model.database.migrationMessage),
        base === undefined || !model.database.migrationAvailable ? null : renderAction('生成数据库迁移', model.database.runtime === 'ready' && model.approval === undefined, { ...base, type: 'prepare-database-migration' }, 'database-migration'),
        !model.database.guiAvailable ? null : react.createElement('p', { style: descriptionStyle }, model.database.migrationAvailable ? '建表请使用数据库工具右上角的“＋ → Table”。保存修改后，生成数据库迁移并检查 SQL；批准后才会应用到项目开发库。停止数据库会丢弃尚未迁移的设计修改。' : '数据库工具使用临时设计库；停止数据库会丢弃其中的修改。启用数据库迁移后，可在本页审核并应用表结构修改。'),
      ),
      model.experts.length === 0 ? null : react.createElement('details', { style: sectionStyle },
        react.createElement('summary', { style: summaryStyle }, `执行记录 · ${model.experts.length} 条`),
        react.createElement('p', { style: descriptionStyle }, '历史记录保留各次执行结果；当前任务状态以上方阶段和验收结果为准。'),
        react.createElement('ul', { style: listStyle, 'aria-label': '专家进度' }, ...model.experts.map(expert => react.createElement('li', { key: expert.id, style: listItemStyle },
          react.createElement('details', null, react.createElement('summary', { style: summaryStyle }, `${expert.role} · ${expert.statusLabel}`),
            react.createElement('p', { style: { ...descriptionStyle, overflowWrap: 'anywhere' } }, expert.taskSummary)),
        ))),
      ),
      (client?.snapshot()?.taskHistory?.length ?? 0) === 0 ? null : react.createElement('details', { style: sectionStyle },
        react.createElement('summary', { style: summaryStyle }, '历史任务'),
        ...(client?.snapshot()?.taskHistory ?? []).map(task => react.createElement('div', { key: task.id, style: sectionStyle },
          react.createElement('strong', null, task.title),
          react.createElement('p', null, task.phase === 'DELIVER' ? '已交付' : '未交付'),
          task.reportPath === undefined ? null : react.createElement('p', { style: descriptionStyle }, `验收报告：${task.reportPath}`),
        )),
      ),
    )
  }
}

/** Default factory used by the Bundle client wrapper. The module loader's
 * `require('react')` result is passed here instead of importing React at the
 * package boundary. */
export function createBackendTeamOverlayClient(react: BackendTeamReactLike, options?: BackendTeamOverlayOptions): (props: BackendTeamOverlayProps) => unknown {
  return createBackendTeamOverlayComponent(react, options)
}

/** A clarification is writable only while the host reports a supported,
 * authenticated, idle discovery phase. All commands still pass through the
 * revision-fenced control client and server authentication boundary. */
export function isBackendTeamClarificationAvailable(model: BackendTeamPanelModel | undefined): boolean {
  if (model === undefined || model.diagnostics.compatibility.mode !== 'supported') return false
  if (model.phase.value !== 'DISCOVER' && model.phase.value !== 'SPECIFY' && model.phase.value !== 'AWAIT_REQUIREMENTS_APPROVAL') return false
  if (model.approval !== undefined) return false
  if (model.usage.activeExperts > 0 || model.usage.activeWorkers > 0) return false
  return !model.experts.some((expert) => expert.status === 'running')
}

function isOpenArtifactAction(value: unknown): boolean {
  return value !== null && typeof value === 'object' && Reflect.get(value, 'type') === 'open-artifact'
}

function readArtifactId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const artifactId = Reflect.get(value, 'artifactId')
  return typeof artifactId === 'string' && artifactId.length > 0 ? artifactId : undefined
}

function parseArtifactPreview(value: unknown, expectedHash: string): BackendTeamArtifactPreview | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = Reflect.get(value, 'artifactPreview')
  if (raw === null || typeof raw !== 'object' || Reflect.get(raw, 'artifactHash') !== expectedHash) return undefined
  const files = Reflect.get(raw, 'files')
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_PREVIEW_FILES) return undefined
  const parsed: BackendTeamArtifactFile[] = []
  for (const file of files) {
    if (file === null || typeof file !== 'object') return undefined
    const path = Reflect.get(file, 'path')
    const content = Reflect.get(file, 'content')
    if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PREVIEW_PATH || path.startsWith('/') || path.includes('..') || typeof content !== 'string' || content.length > MAX_PREVIEW_CONTENT) return undefined
    parsed.push({ path, content })
  }
  return { artifactHash: expectedHash, files: parsed }
}

function renderArtifactPreview(react: BackendTeamReactLike, preview: BackendTeamArtifactPreview): unknown {
  return react.createElement('div', { role: 'document', 'aria-label': '方案预览', style: previewStyle },
    ...preview.files.map((file) => react.createElement('div', { key: file.path },
      react.createElement('strong', null, file.path),
      react.createElement('pre', { style: previewContentStyle }, file.content),
    )),
  )
}

function metric(react: BackendTeamReactLike, label: string, value: string): unknown {
  return react.createElement('div', { key: label, style: metricStyle },
    react.createElement('span', { style: metricLabelStyle }, label),
    react.createElement('span', null, value),
  )
}

function isGuiLogin(value: unknown, target: string): value is { username: string; password: string; url: string } {
  if (value === null || typeof value !== 'object') return false
  const login = value as Record<string, unknown>
  return login.url === target && isLoopbackUrl(target) && typeof login.username === 'string' && login.username.length > 0 && typeof login.password === 'string' && login.password.length > 0
}

function openNavigation(url: string, handler?: (url: string) => void): void {
  if (!isLoopbackUrl(url)) return
  if (handler !== undefined) { handler(url); return }
  const location = (globalThis as { location?: { assign?: (value: string) => void } }).location
  location?.assign?.(url)
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.username === '' && url.password === '' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  } catch { return false }
}

function defaultFetch(input: string, init?: Parameters<BackendTeamFetch>[1]): Promise<BackendTeamFetchResponse> {
  const fetcher = (globalThis as { fetch?: BackendTeamFetch }).fetch
  if (fetcher === undefined) return Promise.reject(new Error('browser fetch is unavailable'))
  return fetcher(input, init)
}

function assertControlPath(path: string): void {
  if (!/^\/[A-Za-z0-9][A-Za-z0-9._~!$&'()*+,;=:@\/-]*$/u.test(path) || path.endsWith('/') || path.includes('//')) throw new Error('control path must be an absolute path without a trailing slash')
}

function assertReact(value: BackendTeamReactLike): void {
  if (value === null || typeof value !== 'object' || typeof value.createElement !== 'function' || typeof value.useEffect !== 'function' || typeof value.useState !== 'function') throw new TypeError('React module with createElement/useEffect/useState is required')
}

function readableError(error: unknown): string {
  if (error instanceof BackendTeamOverlayHttpError) {
    if (error.status === 401) return '本地会话未登录'
    const code = errorCode(error.body)
    if (code === 'READ_ONLY') return '服务处于只读模式，当前操作未执行'
    if (code === 'STALE_VIEW') return '页面状态已变化，请等待刷新后重试'
    if (code === 'WORKSPACE_MISMATCH') return '当前会话与工作区不匹配，操作未执行'
    return `后端团队服务暂不可用（${error.status}）`
  }
  if (error instanceof Error && error.message === 'control state did not include workspaceId') return '服务未提供工作区信息，暂不能执行操作'
  if (error instanceof Error && error.message.length > 0) {
    const detail = safeDiagnosticText(error.message)
    if (detail !== '受保护信息已隐藏') return `操作未完成：${detail}`
  }
  return '操作未完成，请查看诊断信息'
}

function errorCode(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const code = Reflect.get(value, 'code')
  return typeof code === 'string' && /^[A-Z_]+$/u.test(code) ? code : undefined
}

function readPreventDefault(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    const preventDefault = Reflect.get(value, 'preventDefault')
    if (typeof preventDefault === 'function') preventDefault.call(value)
  }
}

function readInputText(value: unknown): string {
  if (value === null || typeof value !== 'object') return ''
  const target = Reflect.get(value, 'target')
  if (target === null || typeof target !== 'object') return ''
  const text = Reflect.get(target, 'value')
  return typeof text === 'string' ? text : ''
}

function safeDiagnosticList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => safeDiagnosticText(item)).filter((item) => item.length > 0).slice(0, MAX_DIAGNOSTIC_ITEMS)
}

function safeDiagnosticText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length === 0) return ''
  if (/[\\/]|(?:https?|file):/iu.test(text)) return '受保护信息已隐藏'
  return text.slice(0, MAX_DIAGNOSTIC_TEXT)
}

function readCurrentSessionId(props: BackendTeamOverlayProps): string | undefined {
  if (typeof props.useSessions !== 'function') return undefined
  try {
    const value = (props.useSessions as (selector: (state: unknown) => unknown) => unknown)((state) => {
      if (state === null || typeof state !== 'object') return undefined
      try { return Reflect.get(state, 'current') } catch { return undefined }
    })
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch { return undefined }
}

function assertSessionId(value: string): string {
  if (typeof value !== 'string' || !/^\S{16,256}$/u.test(value)) throw new Error('session id is invalid')
  return value
}

function buttonStyle(enabled: boolean, primary = false): Readonly<Record<string, string>> {
  return { border: '1px solid var(--dsw-alias-border-l2, #d8dbe2)', borderRadius: '8px', background: enabled && primary ? '#2563eb' : enabled ? 'var(--dsw-alias-bg-module-platform, #fff)' : 'var(--dsw-alias-fill-l1, #f4f4f5)', color: enabled && primary ? '#fff' : enabled ? 'var(--dsw-alias-label-primary, #222)' : 'var(--dsw-alias-label-tertiary, #777)', cursor: enabled ? 'pointer' : 'not-allowed', minHeight: '36px', padding: '7px 14px', fontSize: '14px', fontWeight: primary ? '600' : '400' }
}

const shellStyle = { boxSizing: 'border-box', width: '100%', height: '100%', overflowY: 'auto', minHeight: '0', padding: 'clamp(20px, 4vw, 48px)', paddingBottom: '180px', background: 'var(--dsw-alias-bg-module-platform, #fff)', color: 'var(--dsw-alias-label-primary, #222)', fontSize: '14px', lineHeight: '1.6', overflowWrap: 'anywhere' } as const
const eyebrowStyle = { margin: '0 0 12px', fontSize: '12px', letterSpacing: '.08em', color: 'var(--dsw-alias-label-tertiary, #777)' } as const
const headerStyle = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '12px' } as const
const titleStyle = { margin: '0', fontSize: '26px', fontWeight: '600', flex: '1', minWidth: '160px', lineHeight: '1.3' } as const
const phaseStyle = { color: 'var(--dsw-alias-label-secondary, #555)', background: 'var(--dsw-alias-fill-l1, #f1f3f5)', borderRadius: '20px', padding: '4px 12px', fontSize: '12px', fontWeight: '600' } as const
const descriptionStyle = { margin: '10px 0', color: 'var(--dsw-alias-label-secondary, #555)', lineHeight: '1.65' } as const
const hintStyle = { ...descriptionStyle, paddingBottom: '16px' } as const
const messageStyle = { margin: '8px 0', color: 'var(--dsw-alias-label-secondary, #555)' } as const
const approvalStyle = { margin: '24px 0', padding: '24px', border: '1px solid var(--dsw-alias-border-l2, #e1e5e9)', borderRadius: '14px', background: 'var(--dsw-alias-fill-l1, #f8faf9)' } as const
const sectionStyle = { padding: '18px 0', borderTop: '1px solid var(--dsw-alias-border-l2, #e1e5e9)' } as const
const summaryStyle = { cursor: 'pointer', fontWeight: '500' } as const
const textAreaStyle = { boxSizing: 'border-box', display: 'block', width: '100%', marginTop: '6px', padding: '6px', border: '1px solid var(--dsw-alias-border-l2, #d8dbe2)', borderRadius: '6px', resize: 'vertical', font: 'inherit' } as const
const previewStyle = { marginTop: '8px', maxHeight: '280px', overflow: 'auto', padding: '8px', border: '1px solid var(--dsw-alias-border-l2, #d8dbe2)', borderRadius: '6px', background: 'var(--dsw-alias-bg-page, #fff)' } as const
const previewContentStyle = { margin: '4px 0 10px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace' } as const
const actionRowStyle = { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' } as const
const gridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', margin: '8px 0 24px' } as const
const metricStyle = { display: 'flex', flexDirection: 'column', gap: '8px', padding: '18px', border: '1px solid var(--dsw-alias-border-l2, #e1e5e9)', borderRadius: '12px' } as const
const metricLabelStyle = { color: 'var(--dsw-alias-label-tertiary, #777)' } as const
const listStyle = { margin: '10px 0 0', padding: '0 0 0 18px' } as const
const listItemStyle = { margin: '4px 0', color: 'var(--dsw-alias-label-secondary, #555)' } as const

export class BackendTeamOverlayHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`control request failed: ${status}`)
    this.name = 'BackendTeamOverlayHttpError'
  }
}

interface BackendTeamArtifactPreview {
  readonly artifactHash: string
  readonly files: readonly BackendTeamArtifactFile[]
}

interface BackendTeamArtifactFile {
  readonly path: string
  readonly content: string
}
