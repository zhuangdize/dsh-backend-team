import { constants } from 'node:fs'
import { FileStateStore } from '@dsh-backend-team/core'
import { readTaskResources } from './task-resources.js'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { FileDevelopmentCheckpointStore } from '@dsh-backend-team/development/checkpoint-store'
import { BackendTeamViewStateSchema } from '../../web/src/view-model.js'
import { ControlServiceError } from '../../web/src/control-service.js'
import { applyBackendTeamControlRoute } from '../../web/src/control-route.js'
import { applyDbGateLoginRoute } from '../../web/src/dbgate-login-route.js'
import { AuthenticatedLocalSessionSchema } from '../../web/src/remote-contract.js'
import { createVerifiedDshHostPort, createVerifiedDshSessionPort } from './dsh-production-ports.js'
import { createConfiguredWorkflowHost } from './workflow-host.js'
import { formatWorkflowAnswers, pendingWorkflowQuestions, type UserQuestionAnswer, type UserQuestionRequest } from './workflow-questions.js'
import type { BackendTeamProductionContext, SupportedProductionHost } from './production.js'
import type { DshControlRouteRequest } from './dsh-session-adapter.js'
import type { ApprovalRecord } from '@dsh-backend-team/contracts'

const Task = z.object({ id: z.string().uuid(), sessionId: z.string().min(16), title: z.string().min(1).max(100), objective: z.string().min(1).max(8000), shelvedAt: z.string().datetime().optional(), queuedAt: z.string().datetime().optional(), createdAt: z.string().datetime(), managementHistory: z.array(z.object({ at: z.string().datetime(), sessionId: z.string(), action: z.enum(['adopt', 'shelve', 'feedback']), source: z.enum(['conversation', 'web']), note: z.string().max(2000).optional() }).strict()).optional() }).strict()
const Registry = z.object({ version: z.literal(1), tasks: z.array(Task).max(1000) }).strict()

/** One verified workspace route, with durable task identity for each conversation. */
export async function createConversationTaskHost(context: BackendTeamProductionContext, input: unknown) {
  if (input === undefined || (typeof input === 'object' && input !== null && Reflect.get(input, 'enabled') === false)) return undefined
  const config = z.record(z.string(), z.unknown()).parse(input)
  const legacy = await createConfiguredWorkflowHost(context, input, { registerRoutes: false })
  if (legacy === undefined) return undefined
  if (legacy.mode !== 'supported') { await legacy.dispose(); throw new Error(`团队服务无法启动：${legacy.reasons.join('、')}`) }
  const root = legacy.activation.composition.layout.root
  const registryPath = join(root, '.backend-team', 'conversation-tasks.json')
  const release = await new FileDevelopmentCheckpointStore(root, 'conversation-host').acquireRun().catch(async error => { await legacy.dispose(); throw error })
  const records = await readRegistry(registryPath).catch(async error => { await release(); await legacy.dispose(); throw error })
  const hosts = new Map<string, Promise<SupportedProductionHost>>()
  const approvalBridges = new Map<string, Promise<void>>()
  const sessionPort = createVerifiedDshSessionPort({ context, workspaceId: root, workspaceRoot: root })
  const requests = new WeakMap<object, DshControlRouteRequest>()
  let closed = false
  let creating = false
  let activeDispatches = 0
  type Choice = { id: string; title: string; phase: string; revision: number; sessionId: string; shelvedAt?: string }
  const decisions = new Map<string, { id: string; choice: Choice; mode: 'adopt' | 'shelve'; currentId: string | undefined; expiresAt: number }>()
  const sessionInput = (request: DshControlRouteRequest) => {
    const token = sessionPort.input(request) as object
    requests.set(token, { ...request, query: { ...request.query } })
    return token
  }
  const authenticate = (token: unknown) => {
    if (closed) throw new ControlServiceError('UNAVAILABLE')
    try {
      const identity = sessionPort.authenticator.authenticate(token) as { sessionId: string; readOnly: boolean }
      const request = typeof token === 'object' && token !== null ? requests.get(token) : undefined
      if (request === undefined) throw new Error('missing issued request')
      return { ...identity, request }
    } catch { throw new ControlServiceError('UNAUTHENTICATED') }
  }
  const currentTask = (sessionId: string) => records.tasks.findLast(task => task.sessionId === sessionId && !task.shelvedAt && task.queuedAt === undefined)
  const activeTask = async (sessionId: string) => {
    const task = currentTask(sessionId)
    if (task === undefined) return undefined
    const saved = await new FileStateStore(root, task.id).load()
    return saved?.phase === 'DELIVER' ? undefined : task
  }
  const hostFor = (task: z.infer<typeof Task>): Promise<SupportedProductionHost> => {
    let flight = hosts.get(task.id)
    if (flight === undefined) {
      const { finalEvidenceBindings: _bindings, ...base } = config
      void _bindings
      flight = createConfiguredWorkflowHost(context, { ...base, feature: `task-${task.id}`, workspaceName: taskTitle(task.title) }, { taskId: task.id, registerRoutes: false }).then(async host => {
        if (host?.mode !== 'supported') { await host?.dispose(); throw new Error('任务服务未能启动') }
        try {
          const phase = (await host.activation.composition.stateStore.load())?.phase
          if (phase === 'AWAIT_REQUIREMENTS_APPROVAL' || phase === 'AWAIT_DESIGN_APPROVAL') bridgeConversationApproval(task, host, phase === 'AWAIT_REQUIREMENTS_APPROVAL' ? 'requirements' : 'design')
          return host
        } catch (error) { await host.dispose(); throw error }
      })
      hosts.set(task.id, flight)
      void flight.catch(() => { hosts.delete(task.id) })
    }
    return flight
  }
  const stateFor = async (host: SupportedProductionHost, request: DshControlRouteRequest) => {
    const state = BackendTeamViewStateSchema.parse(await host.surface.service.getState(host.sessionInput(request)))
    if (state.developmentRun === undefined) return state
    const step = state.phase === 'VERIFY' && state.developmentRun.status === 'running' ? 'final-verification' as const : 'implementation' as const
    return BackendTeamViewStateSchema.parse({ ...state, developmentRun: { ...state.developmentRun, step } })
  }
  const getState = async (token: unknown) => {
    const identity = authenticate(token)
    const task = currentTask(identity.sessionId)
    const previous = await stateFor(legacy, identity.request)
    const state = task === undefined ? {
      schemaVersion: 1, workspaceId: root, workspaceName: '后端开发团队', phase: 'DISCOVER', compatibility: previous.compatibility,
      experts: [], risk: { level: 'normal', messages: [] }, database: previous.database,
      verification: { total: 0, passed: 0, failed: 0, blocked: 0 }, usage: { activeExperts: 0, activeWorkers: 0, concurrentWriters: 0, remainingTaskBudget: 0 },
      stateRevision: 0, lastSequence: 0,
    } : await stateFor(await hostFor(task), identity.request)
    const history = [{ id: 'legacy', title: previous.workspaceName, phase: previous.phase, ...(previous.developmentRun?.delivery === undefined ? {} : { reportPath: previous.developmentRun.delivery.reportPath }) }]
    for (const item of records.tasks.filter(item => item.sessionId === identity.sessionId && item.id !== task?.id)) {
      const saved = await new FileStateStore(root, item.id).load()
      history.push({ id: item.id, title: taskTitle(item.title), phase: saved?.phase as typeof previous.phase ?? 'DISCOVER', ...(saved?.finalVerification === undefined ? {} : { reportPath: saved.finalVerification.delivery.reportPath }) })
    }
    const activeHost = task === undefined ? undefined : await hostFor(task)
    const durable = await activeHost?.activation.composition.stateStore.load()
    const scheduler = activeHost?.activation.composition.scheduler?.snapshot()
    return BackendTeamViewStateSchema.parse({ ...state, ...(scheduler === undefined ? {} : { usage: { ...state.usage, activeExperts: scheduler.activeExperts, concurrentWriters: scheduler.activeWriters } }), ...(durable === undefined || durable === null ? {} : { stateRevision: durable.revision, approvalHistory: durable.approvals?.map(approvalHistoryItem) ?? [], ...(durable.workflowError === undefined ? {} : { risk: { level: 'blocked', messages: [`团队任务暂停：${durable.workflowError}`] } }) }), taskId: task?.id ?? 'unassigned', taskHistory: history })
  }
  const getResources = async (token: unknown) => {
    const identity = authenticate(token)
    const current = currentTask(identity.sessionId)
    const requested = identity.request.query.resourceTaskId
    const legacyState = await new FileStateStore(root).load()
    const legacyVisible = legacyState !== null && legacyState.phase !== 'DISCOVER'
    const task = requested === undefined ? current : records.tasks.find(item => item.id === requested)
    if (requested && !task && !(requested === 'legacy' && legacyVisible)) throw new ControlServiceError('WORKSPACE_MISMATCH')
    const tasks = await Promise.all(records.tasks.map(async item => {
      const saved = item.queuedAt === undefined ? await new FileStateStore(root, item.id).load() : null
      const checkpoint = item.queuedAt === undefined ? await new FileDevelopmentCheckpointStore(root, item.id).load() : null
      const live = item.queuedAt === undefined ? hosts.get(item.id) : undefined
      const liveState = live === undefined ? undefined : await stateFor(await live, identity.request)
      const activity = live === undefined ? undefined : (await live).activation.composition.scheduler?.snapshot()
      const executionStatus = item.queuedAt !== undefined ? 'queued' : liveState?.developmentRun?.status ?? (activity?.queued ? 'queued' : checkpoint ? 'saved' : 'idle')
      return { id: item.id, title: taskTitle(item.title), objective: item.objective, phase: saved?.phase ?? 'DISCOVER', arrangement: item.shelvedAt ? 'shelved' : saved?.phase === 'DELIVER' ? 'completed' : 'unfinished', current: item.id === current?.id, createdAt: item.createdAt, sessionId: item.sessionId, executionStatus, readOnly: identity.readOnly }
    }))
    if (legacyVisible) tasks.push({ id: 'legacy', title: '早期工作区任务', objective: '会话任务启用前保存的工作区记录，仅供查看。', phase: legacyState.phase, arrangement: legacyState.phase === 'DELIVER' ? 'completed' : 'unfinished', current: false, createdAt: '', sessionId: '', executionStatus: 'saved', readOnly: true })
    if (requested === 'legacy' && legacyVisible) return { taskId: 'legacy', title: '早期工作区任务', objective: '会话任务启用前保存的工作区记录，仅供查看。', phase: legacyState.phase, approvalHistory: legacyState.approvals.map(approvalHistoryItem), files: await readTaskResources(root, String(config.feature), [], legacyState.finalVerification?.delivery.reportPath), tasks }
    if (!task) return { taskId: 'unassigned', files: [], tasks }
    // Browsing another task must not instantiate its coordinator or recreate approvals.
    const saved = await new FileStateStore(root, task.id).load()
    const checkpoint = await new FileDevelopmentCheckpointStore(root, task.id).load()
    const outputs = checkpoint?.slices.flatMap(slice => slice.handoffs.flatMap(handoff => [...handoff.changedPaths.map(file => file.path), ...handoff.evidencePaths])) ?? []
    const files = await readTaskResources(root, 'task-' + task.id, outputs, saved?.finalVerification?.delivery.reportPath)
    const activeHost = task.id === current?.id ? await hostFor(task) : undefined
    // Snapshot inventory is an optional resource. A stopped or recovering
    // database must not make the documents/task list unavailable; snapshot
    // actions still fail closed through the coordinator when the database is
    // not ready.
    let databaseSnapshots: readonly unknown[] = []
    if (activeHost?.databaseSnapshots?.listSnapshots !== undefined) {
      try { databaseSnapshots = await activeHost.databaseSnapshots.listSnapshots() }
      catch { databaseSnapshots = [] }
    }
    const changes = identity.readOnly || task.id !== current?.id || !saved?.phase.startsWith('AWAIT_') ? { available: false, files: [] } : await recordReviewHistory(root, task.id, files).catch(() => ({ available: false, files: [] }))
    return { taskId: task.id, title: taskTitle(task.title), objective: task.objective, managementHistory: task.managementHistory ?? [], phase: saved?.phase, changes, approvalHistory: saved?.approvals?.map(approvalHistoryItem) ?? [], files, databaseSnapshots, tasks }
  }
  const dispatch = async (token: unknown, input: unknown) => {
    const identity = authenticate(token)
    const task = await activeTask(identity.sessionId)
    if (identity.readOnly) throw new ControlServiceError('READ_ONLY')
    if (creating) throw new Error('任务切换中，请稍后重试。')
    const action = z.record(z.string(), z.unknown()).parse(input)
    if (action.type === 'preview-task-resolution' || action.type === 'confirm-task-resolution') {
      if (identity.request.method !== 'POST' || identity.request.path !== 'dispatch') throw new ControlServiceError('UNAUTHENTICATED')
      if (action.type === 'preview-task-resolution') {
        const request = z.object({ type: z.literal('preview-task-resolution'), targetTaskId: z.string().uuid(), mode: z.enum(['adopt', 'shelve']) }).strict().parse(action)
        const choice = (await taskChoices(token)).find(item => item.id === request.targetTaskId)
        if (!choice) throw new ControlServiceError('STALE_VIEW')
        const decision = { id: randomUUID(), choice, mode: request.mode, currentId: task?.id, expiresAt: Date.now() + 300_000 }
        for (const [key, value] of decisions) if (value.expiresAt < Date.now()) decisions.delete(key)
        decisions.set(identity.sessionId, decision)
        return { decisionId: decision.id, title: choice.title, mode: decision.mode, expiresAt: decision.expiresAt }
      }
      const request = z.object({ type: z.literal('confirm-task-resolution'), decisionId: z.string().uuid(), note: z.string().trim().max(2000).optional() }).strict().parse(action)
      const decision = decisions.get(identity.sessionId)
      if (!decision || decision.id !== request.decisionId || decision.expiresAt < Date.now() || decision.currentId !== task?.id) throw new ControlServiceError('STALE_VIEW')
      decisions.delete(identity.sessionId)
      if (request.note) {
        // A qualified confirmation is feedback, never implicit permission to switch.
        creating = true
        try {
          const item = records.tasks.find(item => item.id === decision.choice.id)
          if (!item) throw new ControlServiceError('STALE_VIEW')
          const updated = { ...item, managementHistory: [...item.managementHistory ?? [], { at: new Date().toISOString(), sessionId: identity.sessionId, action: 'feedback' as const, source: 'web' as const, note: request.note }] }
          const next = records.tasks.map(item => item.id === updated.id ? updated : item)
          await writeRegistry(registryPath, { version: 1, tasks: next }); records.tasks = next
          return { status: 'feedback', message: '补充意见已保存到任务操作记录，未接回或搁置任务。' }
        } finally { creating = false }
      }
      return resolveTask(token, decision.choice, decision.mode, 'web')
    }
    if (task === undefined) throw new Error('请在对话中描述需求，让团队创建任务。')
    if (action.taskId !== task.id) throw new ControlServiceError('STALE_VIEW')
    const host = await hostFor(task)
    if (creating || (await activeTask(identity.sessionId))?.id !== task.id) throw new ControlServiceError('STALE_VIEW')
    const { taskId: _taskId, ...forward } = action
    void _taskId
    activeDispatches++
    try { return await host.surface.service.dispatch(host.sessionInput(identity.request), forward) } finally { activeDispatches-- }
  }
  const createTask = async (token: unknown, objective: string, expectedRevision: number, taskId?: string) => {
    const identity = authenticate(token)
    if (identity.readOnly) throw new ControlServiceError('READ_ONLY')
    if (creating) throw new Error('正在创建团队任务，请稍候再试。')
    creating = true
    try {
      const state = await getState(token)
      if (state.taskId !== taskId || state.stateRevision !== expectedRevision) throw new ControlServiceError('STALE_VIEW')
      const normalizedObjective = objective.trim()
      const current = await activeTask(identity.sessionId)
      const blockers: z.infer<typeof Task>[] = []
      // Business files share one workspace. Keep one active task to avoid interleaving approved changes.
      for (const other of records.tasks.filter(item => !item.shelvedAt && item.queuedAt === undefined && item.id !== current?.id)) {
        const saved = await new FileStateStore(root, other.id).load()
        if (saved?.phase !== 'DELIVER') blockers.push(other)
      }
      if ((current !== undefined && state.phase !== 'DELIVER') || blockers.length > 0) {
        const existing = records.tasks.find(item => item.sessionId === identity.sessionId && item.queuedAt !== undefined && item.objective === normalizedObjective)
        if (existing !== undefined) return { taskId: existing.id, status: 'queued', queuePosition: records.tasks.filter(item => item.queuedAt !== undefined && item.createdAt <= existing.createdAt).length }
        const queued = Task.parse({ id: randomUUID(), sessionId: identity.sessionId, title: taskTitle(normalizedObjective), objective: normalizedObjective, queuedAt: new Date().toISOString(), createdAt: new Date().toISOString() })
        await writeRegistry(registryPath, { version: 1, tasks: [...records.tasks, queued] })
        records.tasks.push(queued)
        return { taskId: queued.id, status: 'queued', queuePosition: records.tasks.filter(item => item.queuedAt !== undefined).length }
      }
      const task = Task.parse({ id: randomUUID(), sessionId: identity.sessionId, title: taskTitle(normalizedObjective), objective: normalizedObjective, createdAt: new Date().toISOString() })
      const host = await hostFor(task)
      await writeRegistry(registryPath, { version: 1, tasks: [...records.tasks, task] })
      records.tasks.push(task)
      await host.surface.service.dispatch(host.sessionInput(identity.request), { workspaceId: root, expectedRevision: 0, type: 'submit-clarification', text: task.objective })
      return getState(token)
    } finally { creating = false }
  }
  // Snapshot tickets are issued by the host, never accepted from model arguments.
  const taskChoices = async (token: unknown) => {
    authenticate(token)
    const choices: Choice[] = []
    for (const item of records.tasks) {
      if (item.queuedAt !== undefined) continue
      const saved = await new FileStateStore(root, item.id).load()
      if (saved?.phase !== 'DELIVER') choices.push({ id: item.id, title: taskTitle(item.title), phase: saved?.phase ?? 'DISCOVER', revision: saved?.revision ?? 0, sessionId: item.sessionId, ...(item.shelvedAt === undefined ? {} : { shelvedAt: item.shelvedAt }) })
    }
    return choices
  }
  const drainQueuedTasks = async (sessionId: string): Promise<void> => {
    if (await activeTask(sessionId) !== undefined) return
    for (const other of records.tasks.filter(item => !item.shelvedAt && item.queuedAt === undefined)) {
      const saved = await new FileStateStore(root, other.id).load()
      if (saved?.phase !== 'DELIVER') return
    }
    const queued = records.tasks.filter(item => item.sessionId === sessionId && item.queuedAt !== undefined).sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0]
    if (queued === undefined) return
    const host = await hostFor(queued)
    const saved = await host.activation.composition.stateStore.load()
    if (saved === null) throw new Error('排队任务状态不可用，保留队列记录等待恢复。')
    if (saved.phase === 'DISCOVER') await host.surface.service.dispatch(host.sessionInput({ method: 'POST', path: '/plugins/backend-team/control/dispatch', query: { sessionId: queued.sessionId }, headers: {}, remoteAddress: '127.0.0.1' }), { workspaceId: root, expectedRevision: saved.revision, type: 'submit-clarification', text: queued.objective })
    const activated = { ...queued, queuedAt: undefined }
    const next = records.tasks.map(item => item.id === activated.id ? activated : item)
    await writeRegistry(registryPath, { version: 1, tasks: next })
    records.tasks = next
  }
  const resolveTask = async (token: unknown, choice: Awaited<ReturnType<typeof taskChoices>>[number], mode: 'shelve' | 'adopt', source: 'conversation' | 'web' = 'conversation') => {
    const identity = authenticate(token)
    if (identity.readOnly) throw new ControlServiceError('READ_ONLY')
    if (creating) throw new Error('任务切换中，请稍后重试。')
    creating = true
    try {
      if (activeDispatches) throw new Error('任务操作尚未结束，请稍后重新确认。')
      const item = records.tasks.find(task => task.id === choice.id)
      if (!item || item.sessionId !== choice.sessionId || item.shelvedAt !== choice.shelvedAt) throw new ControlServiceError('STALE_VIEW')
      const host = await hostFor(item)
      const saved = await host.activation.composition.stateStore.load()
      if (saved?.revision !== choice.revision) throw new ControlServiceError('STALE_VIEW')
      const view = await stateFor(host, identity.request)
      const activity = host.activation.composition.scheduler?.snapshot()
      if (activity?.queued || activity?.activeExperts || activity?.activeWriters || view.usage.activeWorkers || ['running', 'pausing'].includes(view.developmentRun?.status ?? '')) throw new Error('该任务仍在执行，尚未释放工作区。请先暂停并等待停止后重新确认。')
      const active = await activeTask(identity.sessionId)
      if (mode === 'adopt' && active !== undefined && active.id !== item.id) throw new Error('当前对话已有任务，请先搁置当前任务。')
      // Await disposal before persisting a release; stale conversations lose mutation access.
      await host.dispose()
      hosts.delete(item.id)
      const managementHistory = [...item.managementHistory ?? [], { at: new Date().toISOString(), sessionId: identity.sessionId, action: mode, source }]
      const updated = mode === 'shelve' ? { ...item, managementHistory, shelvedAt: new Date().toISOString() } : { ...item, managementHistory, sessionId: identity.sessionId, shelvedAt: undefined }
      const next = records.tasks.filter(task => task.id !== item.id).concat(updated)
      await writeRegistry(registryPath, { version: 1, tasks: next })
      records.tasks = next
      if (mode === 'shelve') await drainQueuedTasks(identity.sessionId)
      return { taskId: item.id, status: mode === 'shelve' ? 'shelved' : 'adopted' }
    } finally { creating = false }
  }
  const removeRoute = applyBackendTeamControlRoute({ server: createVerifiedDshHostPort(context).server, sessionInput, service: { getState, dispatch, getResources } })
  const removeLogin = applyDbGateLoginRoute({ server: createVerifiedDshHostPort(context).server, workspaceId: root, sessionInput,
    authenticator: { authenticate: token => AuthenticatedLocalSessionSchema.parse(sessionPort.authenticator.authenticate(token)) },
    consumeLogin: async id => { const task = currentTask(id); return task === undefined ? undefined : (await hostFor(task)).consumeGuiLogin?.(id) },
  })
  return { workspaceRoot: root, sessionInput, getState, getResources, dispatch, createTask, taskChoices, resolveTask, async dispose() {
    closed = true
    decisions.clear()
    approvalBridges.clear()
    removeRoute()
    removeLogin()
    const results = await Promise.allSettled([...hosts.values()].map(async host => (await host).dispose()))
    try { await legacy.dispose() } finally { await release() }
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures, 'task host disposal failed')
  } }

  function bridgeConversationApproval(task: z.infer<typeof Task>, host: SupportedProductionHost, gate: 'requirements' | 'design'): void {
    const userQuestions = readUserQuestions(context)
    const agents = context.agents as { readonly get?: (sessionId: string) => unknown } | undefined
    const agent = typeof agents?.get === 'function' ? agents.get(task.sessionId) : undefined
    if (userQuestions === undefined || agent === undefined || approvalBridges.has(task.id)) return
    const request = { method: 'POST', path: '/plugins/backend-team/control/dispatch', query: { sessionId: task.sessionId }, headers: {}, remoteAddress: '127.0.0.1' } satisfies DshControlRouteRequest
    const promise = presentApproval(userQuestions, agent, host, request, gate)
      .catch(() => undefined)
      .finally(() => { if (approvalBridges.get(task.id) === promise) approvalBridges.delete(task.id) })
    approvalBridges.set(task.id, promise)
  }

  async function presentApproval(userQuestions: UserQuestions, agent: unknown, host: SupportedProductionHost, request: DshControlRouteRequest, gate: 'requirements' | 'design'): Promise<void> {
    const controller = new AbortController()
    const composition = host.activation.composition
    await composition.requestWorkflowApproval(gate)
    controller.signal.throwIfAborted()
    const pending = composition.approvals.listPending().find(item => item.request.kind === gate)
    if (pending === undefined) return
    const token = host.sessionInput(request)
    const preview = await host.surface.service.dispatch(token, { workspaceId: root, expectedRevision: pending.stateRevision, type: 'open-artifact', artifactId: pending.artifactHash }) as { artifactPreview?: unknown }
    controller.signal.throwIfAborted()
    const pendingQuestions = gate === 'requirements' ? pendingWorkflowQuestions(preview) : []
    const approvalId = 'backend-team-review:' + pending.id
    const questions = pendingQuestions.length > 0
      ? pendingQuestions.map(question => ({ ...question, header: '需求确认' }))
      : [{ id: approvalId, header: gate === 'requirements' ? '需求审批' : '设计审批', question: pending.request.summary, detail: '完整文档可在右侧「任务资源」查看。没有补充意见，选择确认通过；需要调整时输入修改意见。', options: [{ label: '确认通过' }, { label: '退回修改' }] }]
    const answer = await askUser(request => userQuestions.ask(request), { agent, signal: controller.signal, questions })
    if (answer === undefined) return
    controller.signal.throwIfAborted()
    const current = BackendTeamViewStateSchema.parse(host.surface.service.getState(token))
    if (current.stateRevision !== pending.stateRevision || current.pendingApproval?.id !== pending.id || current.pendingApproval.artifactHash !== pending.artifactHash) return
    const base = { workspaceId: root, expectedRevision: pending.stateRevision }
    if (pendingQuestions.length > 0) {
      const text = formatWorkflowAnswers(pendingQuestions, answer) + '\n请根据回答更新需求。已解决的问题移入已确认结论，未决问题只保留真正阻碍实施的业务选择，不重复询问，也不新增用户未要求的功能。'
      await host.surface.service.dispatch(token, { ...base, type: 'submit-clarification', text })
      return
    }
    const item = answer.answers[0]
    if (answer.answers.length !== 1 || item?.id !== approvalId || item.selected.some(label => !['确认通过', '退回修改'].includes(label)) || (!item.custom?.trim() && item.selected.length !== 1)) return
    if (item.custom?.trim()) await host.surface.service.dispatch(token, { ...base, type: 'submit-clarification', text: item.custom.trim() })
    else await host.surface.service.dispatch(token, { ...base, type: 'decide-approval', approvalId: pending.id, artifactHash: pending.artifactHash, decision: item.selected[0] === '确认通过' ? 'approve' : 'reject' })
  }
}

interface UserQuestions {
  ask(request: UserQuestionRequest): Promise<UserQuestionAnswer>
}

function readUserQuestions(context: BackendTeamProductionContext): UserQuestions | undefined {
  try {
    const value = Reflect.get(context, 'userQuestions')
    return value !== null && typeof value === 'object' && typeof Reflect.get(value, 'ask') === 'function' ? value as UserQuestions : undefined
  } catch {
    return undefined
  }
}

async function askUser(ask: UserQuestions['ask'], request: UserQuestionRequest): Promise<UserQuestionAnswer | undefined> {
  try { return await ask(request) }
  catch (error) {
    request.signal.throwIfAborted()
    if (error !== null && typeof error === 'object' && ['cancelled', 'ASK_CANCELLED'].includes(String(Reflect.get(error, 'code')))) return undefined
    throw error
  }
}

function approvalHistoryItem(item: ApprovalRecord) {
  return {
    kind: item.kind,
    approvedAt: item.approvedAt,
    artifactHashes: item.artifactHashes,
    provenance: item.provenance === undefined
      ? { status: 'unknown' as const }
      : { status: 'verified' as const, ...item.provenance },
  }
}

function taskTitle(text: string): string {
  const title = text.trim().split(/[\n。；：]/u)[0]?.trim() || '后端开发任务'
  return title.length > 40 ? `${title.slice(0, 39)}…` : title
}

async function readRegistry(path: string): Promise<z.infer<typeof Registry>> {
  let file
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tasks: [] }; throw error }
  try {
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024 || (info.mode & 0o077) !== 0) throw new Error('unsafe task registry')
    return Registry.parse(JSON.parse(await file.readFile('utf8')))
  } finally { await file.close() }
}
async function writeRegistry(path: string, records: z.infer<typeof Registry>): Promise<void> {
  const parent = join(path, '..')
  if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) throw new Error('unsafe task registry directory')
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(JSON.stringify(Registry.parse(records))); await file.sync() } finally { await file.close() }
  try { await rename(temporary, path) } catch (error) { await unlink(temporary).catch(() => undefined); throw error }
}
import { recordReviewHistory } from './review-history.js'
