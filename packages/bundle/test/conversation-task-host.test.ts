import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createConversationTaskHost } from '../src/conversation-task-host.js'

it('creates independent conversation state, preserves legacy records, fences old actions and restores after restart', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'conversation-task-')))
  const sessionId = 'conversation-session-1234567890'
  const anotherId = 'conversation-session-0987654321'
  const register = vi.fn(() => () => undefined)
  const context = { webServer: { host: '127.0.0.1', register }, sessions: { get: (id: string) => ({ id, header: { cwd: root } }) }, agents: { get: (id: string) => ({ id }), create: async () => { throw new Error('model unavailable in test') } } }
  const config = { enabled: true, workspaceRoot: root, feature: 'legacy' }
  let host: Awaited<ReturnType<typeof createConversationTaskHost>>
  try {
    await mkdir(join(root, '.specify'))
    await mkdir(join(root, '.backend-team/runtime/spec-kit/commands'), { recursive: true })
    await writeFile(join(root, '.specify/integration.json'), JSON.stringify({ version: '0.16.5', integration_state_schema: 1, installed_integrations: ['generic'], integration_settings: { generic: { script: 'sh', raw_options: '--commands-dir .backend-team/runtime/spec-kit/commands', parsed_options: { commands_dir: '.backend-team/runtime/spec-kit/commands' }, invoke_separator: '.' } }, integration: 'generic', default_integration: 'generic' }))
    for (const name of ['specify', 'clarify', 'plan', 'tasks']) await writeFile(join(root, `.backend-team/runtime/spec-kit/commands/speckit.${name}.md`), 'fixture $ARGUMENTS')
    host = await createConversationTaskHost(context, config)
    expect(register).toHaveBeenCalledTimes(2)
    const legacy = await readFile(join(root, '.backend-team/state/current.json'), 'utf8')
    const request = (id: string) => ({ method: 'GET', path: '/plugins/backend-team/control/state', query: { sessionId: id }, headers: {}, remoteAddress: '127.0.0.1' })
    const token = host!.sessionInput(request(sessionId))
    expect(await host!.getState(token)).toMatchObject({ taskId: 'unassigned', phase: 'DISCOVER' })
    await expect(host!.getState({ sessionId })).rejects.toThrow('UNAUTHENTICATED')
    await expect(host!.createTask(token, '创建订单接口', 0, 'unassigned')).rejects.toThrow()
    const created = await host!.getState(token)
    expect(created).toMatchObject({ workspaceName: '创建订单接口', phase: 'SPECIFY' })
    expect(created.taskId).not.toBe('unassigned')
    expect(await readFile(join(root, '.backend-team/state/current.json'), 'utf8')).toBe(legacy)
    await expect(host!.dispatch(token, { workspaceId: root, type: 'resume-run', expectedRevision: created.stateRevision, taskId: 'unassigned' })).rejects.toThrow('STALE_VIEW')
    const another = host!.sessionInput(request(anotherId))
    expect(await host!.getState(another)).toMatchObject({ phase: 'DISCOVER', taskId: 'unassigned' })
    expect(await host!.getResources(another)).toMatchObject({ taskId: 'unassigned', tasks: [{ id: created.taskId, current: false, arrangement: 'unfinished' }] })
    const previewToken = host!.sessionInput({ ...request(anotherId), query: { sessionId: anotherId, resourceTaskId: created.taskId! } })
    const beforeBrowse = await readFile(join(root, `.backend-team/state-${created.taskId}/current.json`), 'utf8')
    expect(await host!.getResources(previewToken)).toMatchObject({ taskId: created.taskId, title: '创建订单接口' })
    expect(await readFile(join(root, `.backend-team/state-${created.taskId}/current.json`), 'utf8')).toBe(beforeBrowse)
    expect(await host!.getState(another)).toMatchObject({ taskId: 'unassigned' })
    await expect(host!.getResources(host!.sessionInput({ ...request(anotherId), query: { sessionId: anotherId, resourceTaskId: 'unknown' } }))).rejects.toThrow('WORKSPACE_MISMATCH')
    await host!.dispose()
    host = await createConversationTaskHost(context, config)
    expect(await host!.getState(host!.sessionInput(request(sessionId)))).toMatchObject({ taskId: created.taskId, phase: 'SPECIFY' })
    const originalToken = host!.sessionInput(request(sessionId))
    const destination = host!.sessionInput(request(anotherId))
    const choice = (await host!.taskChoices(destination))[0]!
    await expect(host!.resolveTask(destination, { ...choice, revision: choice.revision + 1 }, 'shelve')).rejects.toThrow('STALE_VIEW')
    await host!.resolveTask(destination, choice, 'adopt')
    expect(await host!.getState(originalToken)).toMatchObject({ taskId: 'unassigned' })
    expect(await host!.getState(destination)).toMatchObject({ taskId: created.taskId, phase: 'SPECIFY' })
    await expect(host!.resolveTask(destination, choice, 'shelve')).rejects.toThrow('STALE_VIEW')
    await host!.resolveTask(destination, (await host!.taskChoices(destination))[0]!, 'shelve')
    expect(await host!.getState(destination)).toMatchObject({ taskId: 'unassigned' })
    const registry = JSON.parse(await readFile(join(root, '.backend-team/conversation-tasks.json'), 'utf8'))
    expect(registry.tasks[0].shelvedAt).toBeTruthy()
    expect(await host!.getResources(originalToken)).toMatchObject({ taskId: 'unassigned', tasks: [{ id: created.taskId, arrangement: 'shelved' }] })
    await expect(host!.dispatch(originalToken, { workspaceId: root, type: 'resume-run', expectedRevision: created.stateRevision, taskId: created.taskId })).rejects.toThrow('描述需求')
    await host!.dispose()
    host = await createConversationTaskHost(context, config)
    const restored = host!.sessionInput(request(anotherId))
    expect(await host!.getState(restored)).toMatchObject({ taskId: 'unassigned' })
    await host!.resolveTask(restored, (await host!.taskChoices(restored))[0]!, 'adopt')
    expect(await host!.getState(restored)).toMatchObject({ taskId: created.taskId, phase: 'SPECIFY' })
    await host!.resolveTask(restored, (await host!.taskChoices(restored))[0]!, 'shelve')
    await expect(host!.createTask(restored, '新的客户管理需求', 0, 'unassigned')).rejects.toThrow()
    const nextTask = await host!.getState(restored)
    expect(nextTask.taskId).not.toBe(created.taskId)
    expect(nextTask.taskId).not.toBe('unassigned')
    expect(nextTask.phase).toBe('SPECIFY')
    expect(await readFile(join(root, '.backend-team/state/current.json'), 'utf8')).toBe(legacy)
    const webToken = host!.sessionInput({ ...request(sessionId), method: 'POST', path: 'dispatch' })
    const previewAction = { type: 'preview-task-resolution', targetTaskId: created.taskId, mode: 'adopt' }
    const first = await host!.dispatch(webToken, previewAction) as { decisionId: string }
    const second = await host!.dispatch(webToken, previewAction) as { decisionId: string }
    await expect(host!.dispatch(webToken, { type: 'confirm-task-resolution', decisionId: first.decisionId })).rejects.toThrow('STALE_VIEW')
    expect(await host!.dispatch(webToken, { type: 'confirm-task-resolution', decisionId: second.decisionId, note: '先保留，暂不执行' })).toMatchObject({ status: 'feedback' })
    expect(await host!.getState(webToken)).toMatchObject({ taskId: 'unassigned' })
    const feedback = JSON.parse(await readFile(join(root, '.backend-team/conversation-tasks.json'), 'utf8'))
    expect(feedback.tasks.find((item: { id: string }) => item.id === created.taskId).managementHistory.at(-1)).toMatchObject({ action: 'feedback', note: '先保留，暂不执行', source: 'web' })
    const third = await host!.dispatch(webToken, previewAction) as { decisionId: string }
    expect(await host!.dispatch(webToken, { type: 'confirm-task-resolution', decisionId: third.decisionId, note: '' })).toMatchObject({ status: 'adopted' })
    await expect(host!.dispatch(webToken, { type: 'confirm-task-resolution', decisionId: third.decisionId })).rejects.toThrow('STALE_VIEW')
    expect(await host!.getState(webToken)).toMatchObject({ taskId: created.taskId, phase: 'SPECIFY' })
    await expect(host!.dispatch(host!.sessionInput(request(sessionId)), previewAction)).rejects.toThrow('UNAUTHENTICATED')
  } finally { await host?.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('allows adopting a shelved task when the current conversation task is already delivered', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'conversation-task-delivered-')))
  const sessionId = 'conversation-delivered-session-1234567890'
  const currentId = randomUUID()
  const shelvedId = randomUUID()
  const now = new Date().toISOString()
  const register = vi.fn(() => () => undefined)
  const context = {
    webServer: { host: '127.0.0.1', register },
    sessions: { get: (id: string) => ({ id, header: { cwd: root } }) },
    agents: { get: (id: string) => ({ id }), create: async () => { throw new Error('model unavailable in test') } },
  }
  const config = { enabled: true, workspaceRoot: root, feature: 'legacy' }
  let host: Awaited<ReturnType<typeof createConversationTaskHost>>
  try {
    await mkdir(join(root, '.specify'))
    await mkdir(join(root, '.backend-team/runtime/spec-kit/commands'), { recursive: true })
    await writeFile(join(root, '.specify/integration.json'), JSON.stringify({ version: '0.16.5', integration_state_schema: 1, installed_integrations: ['generic'], integration_settings: { generic: { script: 'sh', raw_options: '--commands-dir .backend-team/runtime/spec-kit/commands', parsed_options: { commands_dir: '.backend-team/runtime/spec-kit/commands' }, invoke_separator: '.' } }, integration: 'generic', default_integration: 'generic' }))
    for (const name of ['specify', 'clarify', 'plan', 'tasks']) await writeFile(join(root, `.backend-team/runtime/spec-kit/commands/speckit.${name}.md`), 'fixture $ARGUMENTS')
    const state = (phase: 'DELIVER' | 'SPECIFY') => ({ schemaVersion: 1, revision: 0, workspaceRoot: root, phase, runs: [], approvals: [], approvalTokens: [] })
    await mkdir(join(root, `.backend-team/state-${currentId}`), { recursive: true })
    await writeFile(join(root, `.backend-team/state-${currentId}/current.json`), JSON.stringify(state('DELIVER')), { mode: 0o600 })
    await mkdir(join(root, `.backend-team/state-${shelvedId}`), { recursive: true })
    await writeFile(join(root, `.backend-team/state-${shelvedId}/current.json`), JSON.stringify(state('SPECIFY')), { mode: 0o600 })
    await writeFile(join(root, '.backend-team/conversation-tasks.json'), JSON.stringify({ version: 1, tasks: [
      { id: currentId, sessionId, title: '已交付任务', objective: '已交付任务', createdAt: now },
      { id: shelvedId, sessionId: 'conversation-shelved-session-1234567890', title: '客户管理任务', objective: '客户管理任务', shelvedAt: now, createdAt: now },
    ] }), { mode: 0o600 })
    host = await createConversationTaskHost(context, config)
    const request = { method: 'POST', path: 'dispatch', query: { sessionId }, headers: {}, remoteAddress: '127.0.0.1' }
    const token = host!.sessionInput(request)
    const resources = await host!.getResources(token)
    expect(resources.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: currentId, arrangement: 'completed', current: true }),
      expect.objectContaining({ id: shelvedId, arrangement: 'shelved', current: false }),
    ]))
    const choice = (await host!.taskChoices(token)).find(item => item.id === shelvedId)!
    const preview = await host!.dispatch(token, { type: 'preview-task-resolution', targetTaskId: shelvedId, mode: 'adopt' }) as { decisionId: string }
    expect(await host!.dispatch(token, { type: 'confirm-task-resolution', decisionId: preview.decisionId, note: '' })).toMatchObject({ status: 'adopted', taskId: shelvedId })
    expect(await host!.getState(token)).toMatchObject({ taskId: shelvedId, phase: 'SPECIFY' })
    expect(choice.revision).toBe(0)
  } finally { await host?.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('persists a queued task and activates it after the same conversation shelves the blocker', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'conversation-task-queue-')))
  const sessionId = 'conversation-queue-session-1234567890'
  const anotherId = 'conversation-queue-session-0987654321'
  const register = vi.fn(() => () => undefined)
  let agentSequence = 0
  const context = {
    webServer: { host: '127.0.0.1', register },
    sessions: { get: (id: string) => ({ id, header: { cwd: root } }) },
    agents: {
      get: (id: string) => ({ id }),
      create: async () => {
        const events: Array<{ seq: number; time: number; type: string; data?: unknown }> = []
        let pending = Promise.resolve()
        const agent = {
          id: `fake-agent-${++agentSequence}`,
          session: { events },
          followup: (message: { content: readonly unknown[] }) => {
            const block = message.content[0]
            const prompt = typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string' ? block.text : ''
            const payload = JSON.parse(prompt.split('\nTask payload:\n')[1]!) as { agentTask: { id: string; writePaths: string[] } }
            pending = (async () => {
              for (const path of payload.agentTask.writePaths) {
                const absolute = join(root, path)
                await mkdir(dirname(absolute), { recursive: true })
                await writeFile(absolute, path.endsWith('/spec.md') ? '# Specification\n\n## Actors\nCustomer.\n## Flows\nCreate a record.\n## Rules\nRecords are valid.\n## Permissions\nAuthorized users only.\n## Data and Privacy\nData is protected.\n## Integrations\nNone.\n## Non-Functional Requirements\nReliable.\n## Non-Goals\nNo unrelated features.\n## Acceptance Criteria\n1. Given a request, when submitted, then it is recorded.\n' : '# Clarification\n\nNo open questions.\n')
              }
              events.push({ seq: 0, time: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ taskId: payload.agentTask.id, status: 'passed', summary: 'requirements written', changedPaths: [], commands: [], evidencePaths: [], risks: [], unresolvedItems: [], childResultIds: [], verification: { status: 'passed', verifiedBy: 'fake-agent', verifiedAt: '2026-09-10T00:00:00.000Z', records: [{ instructionId: 'artifact-review', outcome: 'passed', evidencePaths: [] }] } }) }] }, usage: { inputTokens: 0, outputTokens: 0 } } })
            })()
          },
          cancel: () => undefined,
          whenIdle: async () => { await pending },
        }
        return { agent, dispose: async () => undefined }
      },
    },
  }
  const config = { enabled: true, workspaceRoot: root, feature: 'legacy' }
  let host: Awaited<ReturnType<typeof createConversationTaskHost>>
  try {
    await mkdir(join(root, '.specify'))
    await mkdir(join(root, '.backend-team/runtime/spec-kit/commands'), { recursive: true })
    await writeFile(join(root, '.specify/integration.json'), JSON.stringify({ version: '0.16.5', integration_state_schema: 1, installed_integrations: ['generic'], integration_settings: { generic: { script: 'sh', raw_options: '--commands-dir .backend-team/runtime/spec-kit/commands', parsed_options: { commands_dir: '.backend-team/runtime/spec-kit/commands' }, invoke_separator: '.' } }, integration: 'generic', default_integration: 'generic' }))
    for (const name of ['specify', 'clarify', 'plan', 'tasks']) await writeFile(join(root, `.backend-team/runtime/spec-kit/commands/speckit.${name}.md`), 'fixture $ARGUMENTS')
    host = await createConversationTaskHost(context, config)
    const request = (id: string) => ({ method: 'GET', path: '/plugins/backend-team/control/state', query: { sessionId: id }, headers: {}, remoteAddress: '127.0.0.1' })
    const blocker = host!.sessionInput(request(sessionId))
    await host!.createTask(blocker, '创建订单接口', 0, 'unassigned')
    const blockerState = await host!.getState(blocker)
    expect(blockerState.phase).toBe('AWAIT_REQUIREMENTS_APPROVAL')
    let queuedSession = host!.sessionInput(request(anotherId))
    const queued = await host!.createTask(queuedSession, '另一项任务', 0, 'unassigned')
    expect(queued).toMatchObject({ status: 'queued', queuePosition: 1 })
    const queuedId = (queued as { taskId: string }).taskId
    const resources = await host!.getResources(queuedSession)
    expect(resources.taskId).toBe('unassigned')
    expect(resources.tasks.find(item => item.id === queuedId)).toMatchObject({ executionStatus: 'queued', phase: 'DISCOVER', current: false })
    const registryBefore = JSON.parse(await readFile(join(root, '.backend-team/conversation-tasks.json'), 'utf8'))
    expect(registryBefore.tasks.find((item: { id: string }) => item.id === queuedId).queuedAt).toBeTruthy()
    await expect(access(join(root, `.backend-team/state-${queuedId}`))).rejects.toMatchObject({ code: 'ENOENT' })
    await host!.dispose()
    host = await createConversationTaskHost(context, config)
    queuedSession = host!.sessionInput(request(anotherId))
    const blockerAfterRestart = host!.sessionInput(request(sessionId))
    expect(await host!.getResources(queuedSession)).toMatchObject({ taskId: 'unassigned' })
    expect(await host!.taskChoices(queuedSession)).toHaveLength(1)
    const choice = (await host!.taskChoices(queuedSession))[0]!
    await host!.resolveTask(queuedSession, choice, 'shelve')
    expect(await host!.getState(queuedSession)).toMatchObject({ taskId: queuedId, phase: 'AWAIT_REQUIREMENTS_APPROVAL' })
    expect(await host!.getState(blockerAfterRestart)).toMatchObject({ taskId: 'unassigned', phase: 'DISCOVER' })
    const registryAfter = JSON.parse(await readFile(join(root, '.backend-team/conversation-tasks.json'), 'utf8'))
    expect(registryAfter.tasks.find((item: { id: string }) => item.id === choice.id).shelvedAt).toBeTruthy()
    expect(registryAfter.tasks.find((item: { id: string }) => item.id === queuedId).queuedAt).toBeUndefined()
    expect(registryAfter.tasks).toHaveLength(2)
  } finally { await host?.dispose(); await rm(root, { recursive: true, force: true }) }
})
