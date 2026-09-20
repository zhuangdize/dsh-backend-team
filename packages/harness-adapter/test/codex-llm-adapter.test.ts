import { expect, it } from 'vitest'
import { CodexLlmAdapter, type CodexClientPort } from '../src/codex-llm-adapter.js'

function fixture(tool = false) {
  let notify: (method: string, params: unknown) => void = () => {}
  let serverRequest: (method: string, params: unknown) => Promise<unknown> = async () => ({})
  const requests: { method: string; params: unknown }[] = []
  let disposed = false
  const client: CodexClientPort = {
    start: async () => {},
    request: async (method, params) => {
      requests.push({ method, params })
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'config/read') return { config: { mcp_servers: { example: {} }, plugins: { 'example@local': {} } } }
      if (method === 'model/list') return { data: [{ id: 'test-model', model: 'test-model', displayName: 'Test model' }] }
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') {
        queueMicrotask(() => {
          notify('thread/tokenUsage/updated', { threadId: 'thread-1', tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1 } } })
          if (tool) void serverRequest('item/tool/call', { threadId: 'thread-1', turnId: 'turn-1', tool: 'read_owned', callId: 'call-1', arguments: { path: 'src/a.ts' } })
          else {
            notify('item/agentMessage/delta', { threadId: 'thread-1', delta: 'Hello' })
            notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
          }
        })
        return { turn: { id: 'turn-1' } }
      }
      return {}
    },
    onNotification: fn => { notify = fn; return () => {} },
    onServerRequest: fn => { serverRequest = fn; return () => {} },
    dispose: async () => { disposed = true },
  }
  return { adapter: new CodexLlmAdapter({ command: '/test/codex', cwd: '/test', createClient: () => client }), requests, disposed: () => disposed }
}

it('maps real account model metadata, text and disjoint token usage', async () => {
  const f = fixture()
  expect(await f.adapter.listModels('codex-app-server')).toEqual([{ provider: 'codex-app-server', id: 'test-model', name: 'Test model' }])
  const chunks = await collect(f.adapter.stream({ provider: 'codex-app-server', model: 'test-model', messages: [] }))
  expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Hello' })
  expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 2, reasoningTokens: 1 } })
  expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  expect(f.disposed()).toBe(true)
})

it('returns only declared dynamic tool calls for DSH to execute and disables Codex environment access', async () => {
  const f = fixture(true)
  const chunks = await collect(f.adapter.stream({ provider: 'codex-app-server', model: 'test-model', messages: [], tools: [{ name: 'read_owned', description: 'Read owned source', parameters: { type: 'object' } }] }))
  expect(chunks).toContainEqual({ type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read_owned', argumentsDelta: '{"path":"src/a.ts"}' })
  expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  expect(f.requests.find(x => x.method === 'thread/start')?.params).toMatchObject({ environments: [], sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true, config: {
    'orchestrator.skills': { enabled: false }, 'orchestrator.mcp': { enabled: false },
    'mcp_servers.example.enabled': false, 'plugins.example@local.enabled': false,
  } })
  expect(f.requests.some(x => x.method === 'turn/interrupt')).toBe(true)
  expect(f.disposed()).toBe(true)
})

it('does not start a process for already-aborted calls or unsupported sampling settings', async () => {
  const f = fixture()
  await expect(collect(f.adapter.stream({ provider: 'codex-app-server', model: 'test-model', messages: [], signal: AbortSignal.abort() }))).rejects.toThrow()
  await expect(collect(f.adapter.stream({ provider: 'codex-app-server', model: 'test-model', messages: [], temperature: 0.5 }))).rejects.toThrow('temperature')
  expect(f.requests).toHaveLength(0)
})

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const item of items) result.push(item); return result }
