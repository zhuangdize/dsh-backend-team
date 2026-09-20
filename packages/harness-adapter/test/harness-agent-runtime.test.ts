import { describe, expect, it, vi } from 'vitest'
import { HarnessAgentRuntime } from '../src/harness-agent-runtime.js'
import { createHarnessAgentPort } from '../src/verified-agent-port.js'
import { AgentTaskSchema, type AgentSpawnRequest } from '@dsh-backend-team/contracts'
import type { HarnessAgentHandle, HarnessSessionEvent, HarnessUserMessage } from '../src/harness-agent-runtime.js'

function makeAgent(events: HarnessSessionEvent[]) {
  let cancelled = false
  let disposed = false
  let followupText = ''
  let followupMessage: HarnessUserMessage | undefined
  let createOptions: unknown
  const agent = {
    id: 'session-1',
    session: { events },
    followup(message: HarnessUserMessage) {
      followupMessage = message
      const content = message.content
      followupText = Array.isArray(content) && typeof content[0] === 'object' && content[0] !== null && 'text' in content[0] && typeof content[0].text === 'string' ? content[0].text : ''
      events.push(
        { seq: 1, time: 100, type: 'user/message', data: message },
        {
          seq: 2,
          time: 130,
          type: 'assistant/message',
          data: {
            message: { content: [{ type: 'text', text: 'done' }] },
            usage: { inputTokens: 3, outputTokens: 5 },
          },
        },
      )
    },
    cancel() { cancelled = true },
    async whenIdle() {},
  }
  return {
    agent,
    async dispose() { disposed = true },
    setCreateOptions: (options: unknown) => { createOptions = options },
    state: () => ({ cancelled, disposed, followupText, followupMessage, createOptions }),
  } satisfies HarnessAgentHandle & { setCreateOptions: (options: unknown) => void; state: () => { cancelled: boolean; disposed: boolean; followupText: string; followupMessage: HarnessUserMessage | undefined; createOptions: unknown } }
}

function makeRuntime(handle: ReturnType<typeof makeAgent>) {
  return new HarnessAgentRuntime({
    context: {
      agents: { create: async (options) => { handle.setCreateOptions(options); return handle } },
    },
    cwd: '/workspace',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    pluginId: '@dsh-backend-team/bundle',
    decodeResult: ({ assistant, usage }) => {
      const first = assistant.content[0]
      const text = typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string' ? first.text : undefined
      return { text, usage }
    },
  })
}

it('counts every model step and disjoint cache tokens in the current task budget', async () => {
  const events: HarnessSessionEvent[] = [{ seq: 0, time: 0, type: 'assistant/message', data: { usage: { inputTokens: 999, outputTokens: 999 } } }]
  const handle = makeAgent(events)
  const runtime = new HarnessAgentRuntime({ context: { agents: { create: async () => handle } }, cwd: '/workspace', pluginId: 'test', decodeResult: input => input.hostUsage })
  const owned = await runtime.spawn({ task: 'two model calls', role: 'worker', context: {} })
  events.push({ seq: 3, time: 140, type: 'tool/call' }, { seq: 4, time: 150, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'final' }] }, usage: { inputTokens: 7, outputTokens: 11, cacheReadTokens: 13, cacheWriteTokens: 17, reasoningTokens: 5 } } })
  expect(await owned.result()).toEqual({ tokens: 56, wallMs: 50, toolCalls: 1, retries: 0 })
})

it('rejects invalid cache usage instead of understating the budget and disposes the agent', async () => {
  const events: HarnessSessionEvent[] = []
  const handle = makeAgent(events)
  const runtime = new HarnessAgentRuntime({ context: { agents: { create: async () => handle } }, cwd: '/workspace', pluginId: 'test', decodeResult: input => input.hostUsage })
  const owned = await runtime.spawn({ task: 'invalid usage', role: 'worker', context: {} })
  events.push({ seq: 3, time: 150, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'final' }] }, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: -10 } } })
  await expect(owned.result()).rejects.toThrow('invalid token counts')
  expect(handle.state().disposed).toBe(true)
})

const agentTask = AgentTaskSchema.parse({
  id: 'task-1',
  parentTaskId: 'coordinator',
  depth: 1,
  role: 'developer',
  objective: 'implement API',
  nonGoals: ['do not deploy'],
  inputArtifacts: [],
  readPaths: ['src'],
  writePaths: ['src'],
  capabilities: {
    readProjectFiles: true,
    writeOwnedFiles: true,
    businessCodeWrite: true,
    testCodeWrite: true,
    configurationWrite: false,
    commandExecution: false,
    networkHosts: [],
    install: false,
    migration: false,
    canDelegate: false,
    canChangePhase: false,
    canApprove: false,
    canContactUser: false,
    canAnnounceCompletion: true,
  },
  budget: { maxTokens: 64, maxWallMs: 10_000, maxToolCalls: 10, maxRetries: 1, maxChildren: 0 },
  doneWhen: ['tests pass'],
  verification: [{ id: 'tests', kind: 'test', instruction: 'run tests', required: true }],
  returnSchema: 'AgentResult',
})

describe('HarnessAgentRuntime', () => {
  it('binds an optional long-task session around the real Agent request and result', async () => {
    const handle = makeAgent([])
    const calls: string[] = []
    const tokenCharges: number[] = []
    const runtime = new HarnessAgentRuntime({
      context: { agents: { create: async () => handle } },
      cwd: '/workspace', pluginId: 'test', decodeResult: ({ assistant }) => ({ text: assistant.content[0] }),
      executionSessionFactory: async ({ request, sessionId, prompt }) => {
        calls.push(`open:${sessionId}:${request.agentTask?.id ?? 'legacy'}`)
        return {
          async append(messages) { calls.push(`append:${messages[0]?.role}:${messages[0]?.content.includes(prompt) ? 'prompt' : 'assistant'}`) },
          async prepareContext() { calls.push('prepare'); return { prompt: `${prompt}\n[prepared-context]` } },
          consumeModelTokens(tokens) { tokenCharges.push(tokens) },
          async close() { calls.push('close') },
        }
      },
    })

    const result = await (await runtime.spawn({ task: 'persist this task', role: 'worker', context: {}, agentTask })).result()

    expect(result).toEqual({ text: { type: 'text', text: 'done' } })
    expect(calls[0]).toMatch(/^open:[0-9a-f-]+:task-1$/u)
    expect(calls.slice(1, 4)).toEqual(['append:user:prompt', 'prepare', 'append:assistant:assistant'])
    expect(tokenCharges).toEqual([8])
    expect(calls.at(-1)).toBe('close')
    expect(handle.state().followupText).toContain('[prepared-context]')
  })

  it('charges context preparation against the managed wall-clock budget', async () => {
    let created = false
    let closed = false
    const runtime = new HarnessAgentRuntime({
      context: { agents: { create: async () => { created = true; return makeAgent([]) } } },
      cwd: '/workspace', pluginId: 'test', decodeResult: () => ({}),
      executionSessionFactory: async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        return { append: async () => {}, prepareContext: async () => ({}), consumeModelTokens: () => {}, close: async () => { closed = true } }
      },
    })
    const boundedTask = { ...agentTask, budget: { ...agentTask.budget, maxWallMs: 1 } }
    await expect(runtime.spawn({ task: 'budget prep', role: 'worker', context: {}, agentTask: boundedTask })).rejects.toThrow(/wall-time budget exhausted/u)
    expect(created).toBe(false)
    expect(closed).toBe(true)
  })

  it('installs host-owned setup before the official create call returns or followup starts', async () => {
    const handle = makeAgent([])
    const setupContext = { agent: handle.agent, tools: { register: () => () => {}, guard: () => () => {} } }
    const order: string[] = []
    const runtime = new HarnessAgentRuntime({
      context: { agents: { create: async options => {
        order.push('create')
        await options.setup?.(setupContext)
        expect(handle.state().followupText).toBe('')
        order.push('publish')
        return handle
      } } },
      cwd: '/workspace', pluginId: 'test', decodeResult: () => ({}),
      setupAgent: async (context, request) => {
        expect(context).toBe(setupContext)
        expect(request.agentTask?.id).toBe('task-1')
        order.push('setup')
      },
    })
    const application = await runtime.spawn({ task: 'implement API', role: 'worker', context: {}, agentTask })
    expect(order).toEqual(['create', 'setup', 'publish'])
    expect(handle.state().followupText).toContain('implement API')
    await application.cancel()
  })
  it('rejects unserializable task input before creating a Harness session', async () => {
    const handle = makeAgent([])
    const context: { -readonly [Key in keyof AgentSpawnRequest['context']]: AgentSpawnRequest['context'][Key] } = {}
    context.self = context
    await expect(makeRuntime(handle).spawn({ task: 'invalid', role: 'worker', context })).rejects.toThrow('serializable JSON')
    expect(handle.state().createOptions).toBeUndefined()
  })
  it('maps the public session result and usage, then disposes the owned handle', async () => {
    const handle = makeAgent([])
    const runtime = makeRuntime(handle)

    const result = await (await runtime.spawn({ task: 'implement API', role: 'worker', context: {}, agentTask })).result()

    expect(result).toEqual({ text: 'done', usage: { inputTokens: 3, outputTokens: 5 } })
    expect(handle.state()).toMatchObject({ disposed: true })
    expect(handle.state().followupText).toContain('implement API')
    const prompt = handle.state().followupText
    expect(prompt).toContain('Return exactly one JSON object')
    const schema = JSON.parse(prompt.split('\nResult JSON schema:\n')[1]!.split('\nTask payload:\n')[0]!)
    expect(schema.required).toEqual(expect.arrayContaining(['taskId', 'status', 'verification', 'changedPaths']))
    expect(schema.required).not.toContain('consumedBudget')
    expect(schema.properties.taskId.const).toBe(agentTask.id)
    expect(schema.properties.verification.properties.records.minItems).toBe(1)
    expect(schema.properties.verification.properties.records.items.properties.instructionId.enum).toEqual(['tests'])
    expect(handle.state().followupMessage).toMatchObject({
      id: expect.any(String),
      role: 'user',
      source: { kind: 'plugin', plugin: '@dsh-backend-team/bundle' },
    })
    expect(handle.state().createOptions).toMatchObject({ agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 64 } })
  })

  it('cancels the public Agent and disposes it when the application handle is cancelled', async () => {
    const handle = makeAgent([])
    const applicationHandle = await makeRuntime(handle).spawn({ task: 'cancel', role: 'worker', context: {} })

    await applicationHandle.cancel()

    expect(handle.state()).toMatchObject({ cancelled: true, disposed: true })
  })

  it('does not call cancel again after the owned Agent was already disposed', async () => {
    const handle = makeAgent([])
    const applicationHandle = await makeRuntime(handle).spawn({ task: 'complete', role: 'worker', context: {} })

    await applicationHandle.result()
    await applicationHandle.cancel()

    expect(handle.state()).toMatchObject({ cancelled: false, disposed: true })
  })

  it('cancels and disposes the owned Agent when a result signal aborts', async () => {
    const handle = makeAgent([])
    const applicationHandle = await makeRuntime(handle).spawn({ task: 'abort', role: 'worker', context: {} })
    const controller = new AbortController()
    controller.abort()

    await expect(applicationHandle.result(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(handle.state()).toMatchObject({ cancelled: true, disposed: true })
  })

  it('exposes the runtime through the production VerifiedAgentPort boundary', async () => {
    const handle = makeAgent([])
    const port = createHarnessAgentPort({
      context: {
        agents: { create: async (options) => { handle.setCreateOptions(options); return handle } },
      },
      cwd: '/workspace',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      pluginId: '@dsh-backend-team/bundle',
      decodeResult: ({ assistant }) => ({ text: assistant.content[0] }),
    })

    expect(port.verifiedProvenance).toBe(true)
    const applicationHandle = await port.spawnAgent({ task: 'implement API', role: 'worker', context: {}, agentTask })
    await applicationHandle.cancel()

    expect(handle.state()).toMatchObject({ cancelled: true, disposed: true })
    expect(typeof port.spawnAgent).toBe('function')
  })

  it('can defer provider and model selection to the Harness default configured by Codex auth', async () => {
    const handle = makeAgent([])
    const runtime = new HarnessAgentRuntime({
      context: {
        agents: { create: async (options) => { handle.setCreateOptions(options); return handle } },
      },
      cwd: '/workspace',
      pluginId: '@dsh-backend-team/bundle',
      decodeResult: ({ assistant }) => ({ text: assistant.content[0] }),
    })

    await (await runtime.spawn({ task: 'use configured model', role: 'worker', context: {}, agentTask })).result()

    expect(handle.state().createOptions).toMatchObject({ agentOptions: { maxTokens: 64 } })
    expect(handle.state().createOptions).not.toHaveProperty('agentOptions.provider')
    expect(handle.state().createOptions).not.toHaveProperty('agentOptions.model')
  })
})

it('allows one budgeted format correction with all tools disabled and counts both model calls', async () => {
  const events: HarnessSessionEvent[] = []
  const handle = makeAgent(events)
  let denied = false
  let calls = 0
  const runtime = new HarnessAgentRuntime({
    context: { agents: { create: async options => {
      await options.setup?.({ agent: handle.agent, tools: { register: () => () => {}, guard: () => { denied = true; return () => {} } } })
      return handle
    } } }, cwd: '/workspace', pluginId: 'test',
    resultFormatRepair: () => 'Remove the extra field and retain the facts.',
    decodeResult: input => { if (++calls === 1) throw new Error('format'); expect(denied).toBe(true); return input.hostUsage },
  })
  const result = await (await runtime.spawn({ role: 'developer', task: 'do work', context: {}, agentTask })).result()
  expect(result).toMatchObject({ tokens: 16, retries: 1 })
  expect(handle.state().followupText).toContain('Do not use tools')
  expect(handle.state().disposed).toBe(true)
})

it.each(['semantic', 'repeat', 'budget', 'tokens'] as const)('does not repair beyond the permitted %s boundary', async mode => {
  const handle = makeAgent([])
  let decodes = 0
  const runtime = new HarnessAgentRuntime({
    context: { agents: { create: async options => {
      await options.setup?.({ agent: handle.agent, tools: { register: () => () => {}, guard: () => () => {} } })
      return handle
    } } }, cwd: '/workspace', pluginId: 'test',
    resultFormatRepair: () => mode === 'semantic' ? undefined : 'Fix JSON formatting only.',
    decodeResult: () => { decodes++; throw new Error('result rejected') },
  })
  const task = mode === 'budget' ? { ...agentTask, budget: { ...agentTask.budget, maxRetries: 0 } } : mode === 'tokens' ? { ...agentTask, budget: { ...agentTask.budget, maxTokens: 8 } } : agentTask
  await expect((await runtime.spawn({ role: 'developer', task: 'do work', context: {}, agentTask: task })).result()).rejects.toThrow('result rejected')
  expect(decodes).toBe(mode === 'repeat' ? 2 : 1)
  expect(handle.state().disposed).toBe(true)
})

it('never starts a correction after cancellation', async () => {
  const handle = makeAgent([])
  let decodes = 0
  const runtime = new HarnessAgentRuntime({
    context: { agents: { create: async options => {
      await options.setup?.({ agent: handle.agent, tools: { register: () => () => {}, guard: () => () => {} } })
      return handle
    } } }, cwd: '/workspace', pluginId: 'test', resultFormatRepair: () => 'Fix format.',
    decodeResult: () => { decodes++; void application.cancel(); throw new Error('format rejected') },
  })
  const application = await runtime.spawn({ role: 'developer', task: 'do work', context: {}, agentTask })
  await expect(application.result()).rejects.toThrow('format rejected')
  expect(decodes).toBe(1)
  expect(handle.state().cancelled).toBe(true)
})

it('awaits the same pending disposal when cancellation races result cleanup', async () => {
  const handle = makeAgent([])
  const entered = Promise.withResolvers<void>()
  const cleanup = Promise.withResolvers<void>()
  let disposals = 0
  const runtime = new HarnessAgentRuntime({
    context: { agents: { create: async () => ({ agent: handle.agent, dispose: async () => { disposals++; entered.resolve(); await cleanup.promise } }) } },
    cwd: '/workspace', pluginId: 'test', decodeResult: () => ({}),
  })
  const application = await runtime.spawn({ role: 'worker', task: 'finish', context: {} })
  const result = application.result()
  await entered.promise
  let cancellationFinished = false
  const cancelled = application.cancel().then(() => { cancellationFinished = true })
  await Promise.resolve()
  try { expect(cancellationFinished).toBe(false) } finally { cleanup.resolve() }
  await Promise.all([result, cancelled])
  expect(disposals).toBe(1)
})

it('cancels model generation when the managed wall-time budget expires', async () => {
  vi.useFakeTimers()
  try {
    const handle = makeAgent([])
    const idle = Promise.withResolvers<void>()
    handle.agent.whenIdle = () => idle.promise
    const originalCancel = handle.agent.cancel.bind(handle.agent)
    handle.agent.cancel = () => { originalCancel(); idle.resolve() }
    const application = await makeRuntime(handle).spawn({ role: 'developer', task: 'bounded work', context: {}, agentTask: { ...agentTask, budget: { ...agentTask.budget, maxWallMs: 50 } } })
    const result = application.result()
    const rejected = expect(result).rejects.toThrow('wall-time budget exhausted')
    await vi.advanceTimersByTimeAsync(51)
    // Release the fixture even on the unfixed implementation.
    idle.resolve()
    await rejected
    expect(handle.state()).toMatchObject({ cancelled: true, disposed: true })
  } finally { vi.useRealTimers() }
})

it('snapshots task data without cloning or serializing the live delegation callback', async () => {
  const handle = makeAgent([])
  let active = true
  const context = { note: 'original' }
  const delegation = { delegateWorker: async () => {if (!active) throw new Error('delegation revoked'); return { id: 'worker-result' } as never} }
  const runtime = new HarnessAgentRuntime({ context: { agents: {create: async () => handle} }, cwd: '/workspace', pluginId: 'test', decodeResult: input => input.request })
  const owned = await runtime.spawn({task: 'implement task', role: 'developer', context, delegation})
  context.note = 'changed'
  const snapshot = await owned.result() as AgentSpawnRequest
  expect(snapshot.context).toEqual({note: 'original'})
  expect(await snapshot.delegation!.delegateWorker(agentTask)).toEqual({id: 'worker-result'})
  active = false
  await expect(snapshot.delegation!.delegateWorker(agentTask)).rejects.toThrow('delegation revoked')
  expect(handle.state().followupText).not.toContain('delegateWorker')
})
