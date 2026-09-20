import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProductionStatusTool } from '../src/production-status-tool.js'
import { createConversationWorkflowTool } from '../src/conversation-workflow-tool.js'
import { createVerifiedDshSessionPort } from '../src/dsh-production-ports.js'
import { apply } from '../src/index.js'
import type { UserQuestionRequest } from '../src/workflow-questions.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'conversation-tools-'))); roots.push(root)
  const agent = { id: 'session-conversation-test-123' }
  const state = { schemaVersion: 1, workspaceId: root, workspaceName: 'test', phase: 'BUILD', compatibility: { mode: 'supported' }, experts: [], risk: { level: 'normal', messages: [] }, database: { runtime: 'not-installed', engine: 'PostgreSQL', guiAvailable: false, controlsAvailable: false, migrationAvailable: false }, verification: { total: 0, passed: 0, failed: 0, blocked: 0 }, usage: { activeExperts: 0, activeWorkers: 0, concurrentWriters: 0, remainingTaskBudget: 1 }, lastSequence: 0, stateRevision: 3 }
  const context = { agents: { get: (id: string) => id === agent.id ? agent : undefined }, sessions: { get: (id: string) => ({ id, header: { cwd: root } }) } }
  const sessions = createVerifiedDshSessionPort({ context, workspaceRoot: root, workspaceId: root })
  const options = { context, sessionInput: sessions.input, workspaceRoot: root, getState: vi.fn((input: unknown): unknown => { sessions.authenticator.authenticate(input); return state }), dispatch: vi.fn(async (_session: unknown, _action: unknown): Promise<unknown> => { void _session; void _action; return { accepted: true } }), requestApproval: vi.fn(async (): Promise<string> => 'allowed-once') }
  return { options, state, execution: { agent, signal: new AbortController().signal, callId: 'call-test' }, status: createProductionStatusTool(options), workflow: createConversationWorkflowTool(options) }
}
it('uses the actual authenticated projection, not a generic runtime diagnostic', async () => {
  const f = await fixture()
  expect(await f.status.execute({}, f.execution)).toMatchObject({ mode: 'supported', phase: 'BUILD', expectedRevision: 3 })
  expect(f.options.getState).toHaveBeenCalledOnce()
  expect(await f.status.execute({}, { ...f.execution, agent: { ...f.execution.agent } })).toMatchObject({ mode: 'unavailable' })
  expect(f.options.getState).toHaveBeenCalledOnce()
})
it('returns lossless JSON while waiting without an approval or a development record', async () => {
  const f = await fixture()
  f.options.getState.mockReturnValue({ ...f.state, phase: 'DELIVER' })
  const result = await f.workflow.execute({ action: 'wait', expectedRevision: 3 }, f.execution)
  expect(result).toEqual(JSON.parse(JSON.stringify(result)))
  expect(result.status).toBe('completed')
  expect(f.options.dispatch).not.toHaveBeenCalled()
})
it('uses live task activity after restart instead of a historical running record', async () => {
  const f = await fixture()
  f.options.getState.mockReturnValue({ ...f.state, taskId: 'restarted-task', workflowRetryAvailable: true, phase: 'DESIGN', experts: [{ id: 'old-run', role: 'coordinator', status: 'running', taskSummary: 'interrupted before restart', childCount: 0 }] })
  expect(await f.workflow.execute({ action: 'wait', expectedRevision: 3 }, f.execution)).toMatchObject({ status: 'needs-resume' })
  expect(f.options.dispatch).not.toHaveBeenCalled()
})
it('keeps waiting when the durable development run is active even if worker counts are empty', async () => {
  const f = await fixture()
  f.options.getState.mockReturnValueOnce({ ...f.state, developmentRun: { status: 'running' } }).mockReturnValue({ ...f.state, phase: 'DELIVER', developmentRun: { status: 'passed' } })
  expect(await f.workflow.execute({ action: 'wait', expectedRevision: 3 }, f.execution)).toMatchObject({ status: 'completed' })
  expect(f.options.getState).toHaveBeenCalledTimes(2)
  expect(f.options.dispatch).not.toHaveBeenCalled()
})
it('stops waiting immediately when chat generation is cancelled while a durable task is running', async () => {
  const f = await fixture()
  const controller = new AbortController()
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  f.options.dispatch.mockImplementationOnce(async () => { controller.abort(new Error('chat stopped')); await pending })
  await expect(f.workflow.execute({ action: 'continue', expectedRevision: 3 }, { ...f.execution, signal: controller.signal })).rejects.toThrow('chat stopped')
  finish()
})
it('rejects another workspace and rejects stale or cancelled calls without dispatch', async () => {
  const f = await fixture()
  await expect(f.workflow.execute({ action: 'continue', expectedRevision: 2 }, f.execution)).rejects.toThrow('状态已变化')
  f.options.context.sessions.get = id => ({ id, header: { cwd: tmpdir() } })
  await expect(f.workflow.execute({ action: 'continue', expectedRevision: 3 }, f.execution)).rejects.toThrow('workspace')
  await expect(f.workflow.execute({ action: 'continue', expectedRevision: 3 }, { ...f.execution, signal: AbortSignal.abort() })).rejects.toThrow()
  expect(f.options.dispatch).not.toHaveBeenCalled()
})
it('routes start, design, plan and development through the same control dispatcher', async () => {
  const f = await fixture()
  f.state.database = { ...f.state.database, runtime: 'ready', controlsAvailable: true, guiAvailable: true }
  for (const [phase, input, expected] of [
    ['DISCOVER', { action: 'start', text: 'build health' }, { type: 'submit-clarification', text: 'build health' }],
    ['DESIGN', { action: 'continue' }, { type: 'retry-failed-step', stepId: 'workflow:design' }],
    ['PLAN', { action: 'continue' }, { type: 'retry-failed-step', stepId: 'workflow:plan' }],
    ['BUILD', { action: 'continue' }, { type: 'resume-run' }],
    ['VERIFY', { action: 'continue' }, { type: 'resume-run' }],
    ['BUILD', { action: 'start-database' }, { type: 'start-database' }],
    ['BUILD', { action: 'stop-database' }, { type: 'stop-database' }],
    ['BUILD', { action: 'open-database-gui' }, { type: 'open-database-gui' }],
  ] as const) {
    f.state.phase = phase
    await f.workflow.execute({ ...input, expectedRevision: 3 }, f.execution)
    expect(f.options.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: f.execution.agent.id }), expect.objectContaining({ ...expected, expectedRevision: 3 }))
  }
})

it('lets the Agent open the authenticated DbGate handoff through the same control route', async () => {
  const f = await fixture()
  f.state.database = { ...f.state.database, runtime: 'ready', controlsAvailable: true, guiAvailable: true }
  f.options.dispatch.mockResolvedValue({ accepted: true, navigation: { kind: 'one-time-local-url', url: 'http://127.0.0.1:3081/', expiresAt: '2026-09-14T14:00:00.000Z' } })
  const result = await f.workflow.execute({ action: 'open-database-gui', expectedRevision: 3 }, f.execution)
  expect(result).toMatchObject({ status: 'submitted', result: { navigation: { url: 'http://127.0.0.1:3081/' } } })
  expect(f.options.dispatch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ type: 'open-database-gui', expectedRevision: 3 }))
})
it('reports a queued independent task without claiming it started', async () => {
  const f = await fixture()
  const createTask = vi.fn(async () => ({ taskId: 'queued-task', status: 'queued', queuePosition: 1 }))
  const workflow = createConversationWorkflowTool({ ...f.options, createTask })
  const result = await workflow.execute({ action: 'start', text: '新增跟进', expectedRevision: 3 }, f.execution)
  expect(result).toMatchObject({ status: 'queued', message: expect.stringContaining('排队') })
  expect(createTask).toHaveBeenCalled()
  expect(f.options.dispatch).not.toHaveBeenCalled()
})
it('requires preview and explicit host approval, never a model-supplied approval flag', async () => {
  const f = await fixture()
  f.options.getState.mockReturnValue({ ...f.state, phase: 'AWAIT_DESIGN_APPROVAL', pendingApproval: { id: 'pending', kind: 'design', artifactHash: 'a'.repeat(64), summary: 'current design' } })
  await expect(f.workflow.execute({ action: 'approve', expectedRevision: 3 }, f.execution)).rejects.toThrow('先读取')
  await f.workflow.execute({ action: 'preview', expectedRevision: 3 }, f.execution)
  f.options.requestApproval.mockResolvedValueOnce('rejected')
  expect(await f.workflow.execute({ action: 'approve', expectedRevision: 3 }, f.execution)).toMatchObject({ status: 'not-applied' })
  expect(f.options.dispatch).toHaveBeenCalledTimes(1)
  await f.workflow.execute({ action: 'approve', expectedRevision: 3 }, f.execution)
  expect(f.options.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ agent: f.execution.agent, callId: 'call-test', reason: expect.stringContaining('a'.repeat(64)) }))
  expect(f.options.dispatch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ type: 'decide-approval', decision: 'approve', artifactHash: 'a'.repeat(64), expectedRevision: 3 }))
  await expect(f.workflow.execute({ action: 'approve', expectedRevision: 3 }, f.execution)).rejects.toThrow('先读取')
})
it('passes rejection feedback into actual design refinement after explicit confirmation', async () => {
  const f = await fixture()
  f.options.getState.mockReturnValue({ ...f.state, phase: 'AWAIT_DESIGN_APPROVAL', pendingApproval: { id: 'pending', kind: 'design', artifactHash: 'a'.repeat(64), summary: 'current design' } })
  await f.workflow.execute({ action: 'preview', expectedRevision: 3 }, f.execution)
  await f.workflow.execute({ action: 'reject', expectedRevision: 3, text: 'Use only three test files' }, f.execution)
  expect(f.options.dispatch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ type: 'submit-clarification', text: 'Use only three test files' }))
})
it('does not reuse a preview after the pending artifact changes or overwrite delivered work', async () => {
  const f = await fixture()
  const pending = { id: 'pending', kind: 'design', artifactHash: 'a'.repeat(64), summary: 'design' }
  f.options.getState.mockReturnValue({ ...f.state, pendingApproval: pending })
  await f.workflow.execute({ action: 'preview', expectedRevision: 3 }, f.execution)
  f.options.getState.mockReturnValue({ ...f.state, pendingApproval: { ...pending, artifactHash: 'b'.repeat(64) } })
  await expect(f.workflow.execute({ action: 'approve', expectedRevision: 3 }, f.execution)).rejects.toThrow('先读取')
  expect(f.options.requestApproval).not.toHaveBeenCalled()
  f.options.getState.mockReturnValue({ ...f.state, phase: 'DELIVER' })
  expect(await f.workflow.execute({ action: 'continue', expectedRevision: 3 }, f.execution)).toMatchObject({ status: 'completed' })
  await expect(f.workflow.execute({ action: 'start', text: 'overwrite', expectedRevision: 3 }, f.execution)).rejects.toThrow('不能直接覆盖')
})
it('can disable the legacy status registration when the production tools are installed', async () => {
  const register = vi.fn()
  await apply({ tools: { register, guard: vi.fn() } } as never, { diagnosticStatusTool: false })
  expect(register).not.toHaveBeenCalled()
})

it('prepares the database before generating a migration and stops on preparation failure', async () => {
  const f = await fixture()
  f.options.getState.mockReturnValue({ ...f.state, database: { ...f.state.database, runtime: 'stopped', controlsAvailable: true } })
  f.options.dispatch.mockImplementation(async (_session?: unknown, action?: unknown) => {
    if ((action as { type: string }).type === 'start-database') f.options.getState.mockReturnValue({ ...f.state, database: { ...f.state.database, runtime: 'ready', controlsAvailable: true } })
    return { accepted: true }
  })
  await f.workflow.execute({ action: 'prepare-migration', expectedRevision: 3 }, f.execution)
  expect(f.options.dispatch.mock.calls.map(call => (call[1] as { type: string }).type)).toEqual(['start-database', 'prepare-database-migration'])
  f.options.dispatch.mockClear().mockRejectedValueOnce(new Error('startup failed'))
  f.options.getState.mockReturnValue({ ...f.state, database: { ...f.state.database, runtime: 'stopped', controlsAvailable: true } })
  await expect(f.workflow.execute({ action: 'prepare-migration', expectedRevision: 3 }, f.execution)).rejects.toThrow('startup failed')
  expect(f.options.dispatch).toHaveBeenCalledTimes(1)
})

it('collects optional review feedback through native questions without approving the old document', async () => {
  const f = await fixture()
  f.options.getState.mockReturnValue({ ...f.state, phase: 'AWAIT_REQUIREMENTS_APPROVAL', pendingApproval: { id: 'pending', kind: 'requirements', artifactHash: 'a'.repeat(64), summary: '确认需求' } })
  const askQuestions = vi.fn(async () => ({ answers: [{ id: 'backend-team-review:pending', selected: [], custom: '增加负责人字段' }] }))
  const workflow = createConversationWorkflowTool({ ...f.options, askQuestions })
  await workflow.execute({ action: 'preview', expectedRevision: 3 }, f.execution)
  await workflow.execute({ action: 'approve', expectedRevision: 3 }, f.execution)
  expect(f.options.requestApproval).not.toHaveBeenCalled()
  expect(f.options.dispatch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ type: 'submit-clarification', text: '增加负责人字段' }))
})
it('accepts a blank optional comment and refuses a stale answer after the user reads a newer version', async () => {
  const f = await fixture()
  const state = { ...f.state, phase: 'AWAIT_REQUIREMENTS_APPROVAL', pendingApproval: { id: 'pending', kind: 'requirements', artifactHash: 'a'.repeat(64), summary: '确认需求' } }
  f.options.getState.mockReturnValue(state)
  const askQuestions = vi.fn(async () => ({ answers: [{ id: 'backend-team-review:pending', selected: ['确认通过'], custom: '  ' }] }))
  const workflow = createConversationWorkflowTool({ ...f.options, askQuestions })
  await workflow.execute({ action: 'preview', expectedRevision: 3 }, f.execution)
  await workflow.execute({ action: 'approve', expectedRevision: 3 }, f.execution)
  expect(f.options.dispatch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ type: 'decide-approval', decision: 'approve' }))
  await workflow.execute({ action: 'preview', expectedRevision: 3 }, f.execution)
  askQuestions.mockImplementationOnce(async () => { f.options.getState.mockReturnValue({ ...state, stateRevision: 4 }); return { answers: [{ id: 'backend-team-review:pending', selected: ['确认通过'], custom: '' }] } })
  const count = f.options.dispatch.mock.calls.length
  await expect(workflow.execute({ action: 'approve', expectedRevision: 3 }, f.execution)).rejects.toThrow('方案已更新')
  expect(f.options.dispatch).toHaveBeenCalledTimes(count)
})
it('asks pending questions as one paged batch and sends every answer for revision before approval', async () => {
  const f = await fixture()
  f.options.getState.mockReturnValue({ ...f.state, phase: 'AWAIT_REQUIREMENTS_APPROVAL', pendingApproval: { id: 'pending', kind: 'requirements', artifactHash: 'a'.repeat(64), summary: '确认需求' } })
  f.options.dispatch.mockResolvedValueOnce({ artifactPreview: { files: [{ path: 'specs/task/clarification.md', content: '<!-- backend-team:questions\n[{"id":"Q1","question":"客户归属？","options":[{"label":"团队共享"},{"label":"个人私有"}]},{"id":"Q2","question":"唯一规则？"}]\n-->' }] } })
  const askQuestions = vi.fn(async () => ({ answers: [{ id: 'Q1', selected: ['团队共享'] }, { id: 'Q2', selected: [], custom: '名称加电话' }] }))
  const workflow = createConversationWorkflowTool({ ...f.options, askQuestions })
  await workflow.execute({ action: 'preview', expectedRevision: 3 }, f.execution)
  await workflow.execute({ action: 'approve', expectedRevision: 3 }, f.execution)
  expect(askQuestions).toHaveBeenCalledWith(expect.objectContaining({ questions: expect.arrayContaining([expect.objectContaining({ id: 'Q1' }), expect.objectContaining({ id: 'Q2' })]) }))
  expect(f.options.dispatch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ type: 'submit-clarification', text: expect.stringContaining('名称加电话') }))
})

it('defers cancelled questions without applying a decision or reporting a failed approval', async () => {
  const f = await fixture()
  f.options.getState.mockReturnValue({ ...f.state, phase: 'AWAIT_DESIGN_APPROVAL', pendingApproval: { id: 'pending', kind: 'design', artifactHash: 'a'.repeat(64), summary: '确认设计' } })
  const workflow = createConversationWorkflowTool({ ...f.options, askQuestions: vi.fn(async () => { throw Object.assign(new Error('the user cancelled ask_user_question'), { code: 'ASK_CANCELLED' }) }) })
  await workflow.execute({ action: 'preview', expectedRevision: 3 }, f.execution)
  const count = f.options.dispatch.mock.calls.length
  expect(await workflow.execute({ action: 'approve', expectedRevision: 3 }, f.execution)).toMatchObject({ status: 'deferred' })
  expect(await workflow.execute({ action: 'ask', expectedRevision: 3, questions: [{ id: 'Q1', question: '归属范围？' }] }, f.execution)).toMatchObject({ status: 'deferred' })
  expect(f.options.dispatch).toHaveBeenCalledTimes(count)
})
it('accepts explicitly requested business questions only in an editable phase', async () => {
  const f = await fixture()
  const askQuestions = vi.fn(async () => ({ answers: [{ id: 'Q1', selected: [], custom: '团队共享' }] }))
  const workflow = createConversationWorkflowTool({ ...f.options, askQuestions })
  const input = { action: 'ask', expectedRevision: 3, questions: [{ id: 'Q1', question: '归属范围？' }] }
  await expect(workflow.execute(input, f.execution)).rejects.toThrow('refine')
  expect(askQuestions).not.toHaveBeenCalled()
  f.options.getState.mockReturnValue({ ...f.state, phase: 'AWAIT_DESIGN_APPROVAL' })
  await workflow.execute(input, f.execution)
  expect(f.options.dispatch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ type: 'submit-clarification', text: expect.stringContaining('团队共享') }))
})

it('resolves a selected old task only after explicit in-chat confirmation', async () => {
  const f = await fixture()
  const choice = { id: 'old-task', title: '演示接口', phase: 'VERIFY', revision: 23, sessionId: 'old-session-123456' }
  const resolveTask = vi.fn(async () => ({ status: 'shelved' }))
  const askQuestions = vi.fn(async (request: UserQuestionRequest) => ({ answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.header === '已有任务' ? '1. 演示接口' : '搁置并释放占用'] }] }))
  const tool = createConversationWorkflowTool({ ...f.options, taskChoices: async () => [choice], resolveTask, askQuestions })
  expect(await tool.execute({ action: 'resolve-task', expectedRevision: 3 }, f.execution)).toMatchObject({ status: 'resolved' })
  expect(resolveTask).toHaveBeenCalledWith(expect.anything(), choice, 'shelve')
  expect(f.options.dispatch).not.toHaveBeenCalled()
})
it('does not report a shelve when the task service returns adopted', async () => {
  const f = await fixture()
  const choice = { id: 'old-task', title: '客户管理', phase: 'BUILD', revision: 6, sessionId: 'old-session-123456' }
  const resolveTask = vi.fn(async () => ({ status: 'adopted' }))
  const askQuestions = vi.fn(async (request: UserQuestionRequest) => ({ answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.header === '已有任务' ? '1. 客户管理' : '搁置并释放占用'] }] }))
  const tool = createConversationWorkflowTool({ ...f.options, taskChoices: async () => [choice], resolveTask, askQuestions })
  await expect(tool.execute({ action: 'resolve-task', expectedRevision: 3 }, f.execution)).rejects.toThrow('任务处置结果与用户选择不一致')
  expect(resolveTask).toHaveBeenCalledWith(expect.anything(), choice, 'shelve')
})
it('keeps old tasks unchanged when the user defers or adds an ambiguous instruction', async () => {
  const f = await fixture()
  const resolveTask = vi.fn()
  const askQuestions = vi.fn(async (request: UserQuestionRequest) => ({ answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.header === '已有任务' ? '1. 演示接口' : '搁置并释放占用'], ...(request.questions[0]!.header === '已有任务' ? {} : { custom: '等一下' }) }] }))
  const tool = createConversationWorkflowTool({ ...f.options, taskChoices: async () => [{ id: 'old', title: '演示接口', phase: 'VERIFY', revision: 1, sessionId: 'old-session-123456' }], resolveTask, askQuestions })
  expect(await tool.execute({ action: 'resolve-task', expectedRevision: 3 }, f.execution)).toMatchObject({ status: 'deferred' })
  expect(resolveTask).not.toHaveBeenCalled()
})
it('reaches tasks beyond the first page and rejects replayed answers from another request', async () => {
  const f = await fixture()
  const choices = Array.from({ length: 9 }, (_, index) => ({ id: `task-${index}`, title: `任务${index}`, phase: 'VERIFY', revision: 1, sessionId: 'old-session-123456' }))
  const selections = ['下一页', '下一页', '上一页', '下一页', '9. 任务8', '搁置并释放占用']
  const issued: string[] = []
  const askQuestions = vi.fn(async (request: UserQuestionRequest) => {
    const question = request.questions[0]!
    issued.push(question.id)
    expect(question.options!.length).toBeLessThanOrEqual(6)
    return { answers: [{ id: question.id, selected: [selections.shift()!] }] }
  })
  const resolveTask = vi.fn(async () => ({}))
  const tool = createConversationWorkflowTool({ ...f.options, taskChoices: async () => choices, askQuestions, resolveTask })
  expect(await tool.execute({ action: 'resolve-task', expectedRevision: 3 }, f.execution)).toMatchObject({ status: 'resolved', message: expect.stringContaining('已搁置“任务8”') })
  expect(resolveTask).toHaveBeenCalledWith(expect.anything(), choices[8], 'shelve')
  expect(new Set(issued).size).toBe(issued.length)
  askQuestions.mockImplementationOnce(async () => ({ answers: [{ id: issued[0]!, selected: ['1. 任务0'] }] }))
  expect(await tool.execute({ action: 'resolve-task', expectedRevision: 3 }, f.execution)).toMatchObject({ status: 'not-applied' })
  expect(resolveTask).toHaveBeenCalledTimes(1)
})
it('stops polling an idle BUILD and explains that old approval does not cover new requirements', async () => {
  const f = await fixture()
  const result = await f.workflow.execute({ action:'wait', expectedRevision:3 }, f.execution)
  expect(result.status).toBe('needs-resume')
  expect(result.message).toContain('历史审批不能用于新需求')
  expect(f.options.dispatch).not.toHaveBeenCalled()
})
it('explains that an idle task need not be paused and directs release through confirmation', async () => {
  const f = await fixture()
  expect(await f.workflow.execute({action:'pause',expectedRevision:3},f.execution)).toMatchObject({status:'not-running'})
  expect(f.options.dispatch).not.toHaveBeenCalled()
})
it('requires a fresh explicit choice before modifying a development task', async () => {
  const f = await fixture()
  const askQuestions = vi.fn(async (request: UserQuestionRequest) => ({ answers: [{ id: request.questions[0]!.id, selected: ['修改当前任务'] }] }))
  const tool = createConversationWorkflowTool({ ...f.options, askQuestions })
  await tool.execute({ action: 'refine', text: '增加跟进记录', expectedRevision: 3 }, f.execution)
  expect(askQuestions).toHaveBeenCalledOnce()
  expect(f.options.dispatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'submit-clarification', text: '增加跟进记录' }))
})
it('keeps the old task unchanged for a new task choice, free text, or stale confirmation', async () => {
  for (const mode of ['new', 'custom', 'stale']) {
    const f = await fixture()
    const tool = createConversationWorkflowTool({ ...f.options, askQuestions: async request => {
      if (mode === 'stale') f.state.stateRevision++
      return { answers: [{ id: request.questions[0]!.id, selected: [mode === 'new' ? '另开新任务' : '修改当前任务'], ...(mode === 'custom' ? { custom: '先讨论' } : {}) }] }
    } })
    const result = tool.execute({ action: 'refine', text: '增加跟进记录', expectedRevision: 3 }, f.execution)
    if (mode === 'stale') await expect(result).rejects.toThrow('任务已变化')
    else await result
    expect(f.options.dispatch).not.toHaveBeenCalled()
  }
})
