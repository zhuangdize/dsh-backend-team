import type { CallId, GenerateOptions, LlmModelInfo, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { CodexAppServerClient } from './codex-app-server-client.js'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface CodexClientPort {
  start(): Promise<void>
  request(method: string, params: unknown): Promise<unknown>
  onNotification(callback: (method: string, params: unknown) => void): () => void
  onServerRequest(callback: (method: string, params: unknown) => Promise<unknown>): () => void
  onFailure?(callback: (error: Error) => void): () => void
  dispose(): Promise<void>
}
export interface CodexLlmAdapterOptions {
  readonly command: string
  readonly cwd: string
  readonly timeoutMs?: number
  readonly createClient?: () => CodexClientPort
}
const PROVIDER = 'codex-app-server'
const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0

/** Codex owns authentication/inference; DSH alone executes the returned tool calls. */
export class CodexLlmAdapter {
  private readonly active = new Set<CodexClientPort>()
  private readonly directories = new Map<CodexClientPort, string>()
  private closed = false
  constructor(private readonly options: CodexLlmAdapterOptions) {}
  providerInfo(provider: string) { return { id: provider, name: 'Codex App Server (ChatGPT login)' } }
  providerRetryPolicy() { return undefined }
  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const client = this.client()
    try {
      await client.start()
      const response = object(await client.request('model/list', {}))
      if (!Array.isArray(response.data)) throw new Error('Codex returned no model catalog')
      return response.data.map(object).filter(model => typeof model.model === 'string').map(model => ({ provider, id: model.model as string, name: typeof model.displayName === 'string' ? model.displayName : model.model as string }))
    } finally { await this.release(client) }
  }
  async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  async accountStatus(): Promise<{ authenticated: boolean; type: string | null }> {
    const client = this.client()
    try {
      await client.start()
      const account = object(object(await client.request('account/read', { refreshToken: false })).account)
      return { authenticated: typeof account.type === 'string', type: typeof account.type === 'string' ? account.type : null }
    } finally { await this.release(client) }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    if (options.provider !== PROVIDER) throw new Error('unsupported Codex provider route')
    if (options.temperature !== undefined) throw new Error('Codex App Server does not expose temperature')
    if (options.stop?.length) throw new Error('Codex App Server does not expose stop sequences')
    if (JSON.stringify(options.messages).length > 4 * 1024 * 1024) throw new Error('Codex request history exceeds 4 MiB')
    if (containsImage(options.messages)) throw new Error('Codex DSH adapter currently supports text and tools only')
    const tools = options.tools ?? []
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('duplicate DSH tool names')
    const client = this.client()
    let threadId: string | undefined
    let turnId: string | undefined
    let text = ''
    let usage: TokenUsage | undefined
    let requested: { id: string; name: string; arguments: string } | undefined
    const complete = Promise.withResolvers<void>()
    // A rejection can arrive during thread creation, before the waiter is attached.
    void complete.promise.catch(() => {})
    const offFailure = client.onFailure?.(error => complete.reject(error))
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      complete.reject(options.signal?.reason ?? new Error('Codex request aborted'))
      void client.dispose()
    }
    const offNotification = client.onNotification((method, input) => {
      const params = object(input)
      if (params.threadId !== threadId) return
      if (method === 'turn/started') turnId = String(object(params.turn).id)
      if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
        text += params.delta
        if (text.length > 4 * 1024 * 1024) complete.reject(new Error('Codex response exceeds 4 MiB'))
      }
      if (method === 'thread/tokenUsage/updated') {
        const total = object(object(params.tokenUsage).total)
        usage = { inputTokens: Math.max(0, count(total.inputTokens) - count(total.cachedInputTokens)), outputTokens: count(total.outputTokens), cacheReadTokens: count(total.cachedInputTokens), reasoningTokens: count(total.reasoningOutputTokens) }
      }
      if (method === 'turn/completed') {
        const turn = object(params.turn)
        if (turn.status === 'completed') complete.resolve()
        else complete.reject(new Error(`Codex turn ${String(turn.status)}: ${String(object(turn.error).message ?? 'no completion')}`))
      }
    })
    const offRequest = client.onServerRequest(async (method, input) => {
      const params = object(input)
      if (method !== 'item/tool/call' || params.threadId !== threadId || typeof params.tool !== 'string' || !tools.some(tool => tool.name === params.tool)) {
        complete.reject(new Error(`Codex attempted an unsupported tool or approval: ${method}`))
        throw new Error('DSH rejects native Codex tools and approvals')
      }
      if (requested !== undefined) throw new Error('DSH accepts one tool call per inference step')
      requested = { id: String(params.callId), name: params.tool, arguments: JSON.stringify(params.arguments) }
      turnId = String(params.turnId)
      complete.resolve()
      // Do not execute the tool inside Codex or allow another model turn. The
      // process is interrupted/disposed; DSH receives and executes this request.
      return new Promise(() => {})
    })
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      timer = setTimeout(() => { complete.reject(new Error('Codex model request timed out')); void client.dispose() }, this.options.timeoutMs ?? 120000)
      await client.start()
      options.signal?.throwIfAborted()
      const account = object(object(await client.request('account/read', { refreshToken: false })).account)
      if (typeof account.type !== 'string') throw new Error('Codex is not logged in. Run codex login with the configured executable, then retry.')
      const inherited = object(object(await client.request('config/read', { includeLayers: false })).config)
      const config: Record<string, unknown> = {
        'orchestrator.skills': { enabled: false }, 'orchestrator.mcp': { enabled: false },
        web_search: 'disabled', project_doc_max_bytes: 0,
        'tools.update_plan.enabled': false, 'tools.experimental_request_user_input.enabled': false,
        'features.shell_tool': false, 'features.multi_agent': false, 'features.apps': false,
        'features.hooks': false, 'features.plugin_hooks': false, 'features.plugins': false,
        'features.remote_plugin': false, 'features.memories': false,
        'features.image_generation': false, 'features.goals': false,
        'features.skill_search': false, 'features.skill_mcp_dependency_install': false,
        'features.in_app_browser': false, 'features.code_mode': false,
      }
      for (const namespace of ['mcp_servers', 'plugins']) for (const name of Object.keys(object(inherited[namespace]))) {
        if (name.includes('.')) throw new Error('Codex configuration contains a dotted integration name that cannot be safely isolated')
        config[`${namespace}.${name}.enabled`] = false
      }
      const response = object(await client.request('thread/start', {
        model: options.model, allowProviderModelFallback: false, ephemeral: true, cwd: this.directories.get(client),
        environments: [], selectedCapabilityRoots: [], runtimeWorkspaceRoots: [], sandbox: 'read-only', approvalPolicy: 'never',
        baseInstructions: 'You provide inference for DSH. Continue the supplied ordered conversation. Use only the client-provided tools when needed. Never access the local environment. Tool execution is owned by DSH.',
        developerInstructions: options.system ?? '',
        dynamicTools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
        config,
      }))
      threadId = String(object(response.thread).id)
      if (threadId === 'undefined') throw new Error('Codex did not return a thread ID')
      const started = object(await client.request('turn/start', { threadId, environments: [], input: [{ type: 'text', text: JSON.stringify({ messages: options.messages.map(message => ({ role: message.role, content: message.content })) }), text_elements: [] }], ...(options.reasoningEffort === undefined ? {} : { effort: options.reasoningEffort }) }))
      turnId ??= String(object(started.turn).id)
      await complete.promise
      options.signal?.throwIfAborted()
      if (options.maxTokens !== undefined && usage !== undefined && usage.outputTokens > options.maxTokens) throw new Error('Codex response exceeded the DSH output token budget')
      if (text) yield { type: 'text-delta', index: 0, text }
      if (requested !== undefined) yield { type: 'tool-call-delta', index: text ? 1 : 0, id: requested.id as CallId, name: requested.name, argumentsDelta: requested.arguments }
      if (usage !== undefined) yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: requested === undefined ? 'stop' : 'tool-calls' } }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      offNotification(); offRequest()
      offFailure?.()
      if (threadId !== undefined && turnId !== undefined) await client.request('turn/interrupt', { threadId, turnId }).catch(() => {})
      await this.release(client)
    }
  }
  async dispose(): Promise<void> { this.closed = true; await Promise.all([...this.active].map(client => this.release(client))) }
  private client(): CodexClientPort {
    if (this.closed) throw new Error('Codex adapter is disposed')
    const directory = mkdtempSync(join(tmpdir(), 'dsh-codex-model-'))
    const client = this.options.createClient?.() ?? new CodexAppServerClient({ command: this.options.command, cwd: directory, args: ['--disable', 'hooks', '--disable', 'plugin_hooks', '--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'apps'] })
    this.directories.set(client, directory)
    this.active.add(client)
    return client
  }
  private async release(client: CodexClientPort): Promise<void> {
    this.active.delete(client)
    await client.dispose()
    const directory = this.directories.get(client)
    this.directories.delete(client)
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  }
}
function containsImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImage)
  const record = object(value)
  return record.type === 'image' || (Array.isArray(record.content) && record.content.some(containsImage))
}
