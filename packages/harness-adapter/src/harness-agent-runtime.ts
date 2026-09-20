import { randomUUID } from 'node:crypto'
import type { AgentHandle, AgentSpawnRequest } from '@dsh-backend-team/contracts'
import { AgentResultSchema } from '@dsh-backend-team/contracts'
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { UserMessage } from '@deepseek-ai/dsh-llm/message'
import type { HarnessToolService } from './structural-context.js'

export interface HarnessSessionEvent {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data?: unknown
}

export interface HarnessAssistantMessage {
  readonly content: readonly unknown[]
  readonly source?: unknown
}

export interface HarnessTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/**
 * The small input shape owned by this plugin before it crosses the Harness
 * message boundary. The official constructor adds the id and user role.
 */
export interface HarnessUserMessageInput {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }]
  readonly source: { readonly kind: 'plugin'; readonly plugin: string }
}

/** The official immutable Harness user message passed to Agent.followup(). */
export type HarnessUserMessage = UserMessage

export interface HarnessAgent {
  readonly id: string
  readonly session: { readonly events: readonly HarnessSessionEvent[] }
  followup(message: HarnessUserMessage): void
  cancel(cause: { readonly kind: 'user' }): void
  whenIdle(): Promise<void>
}

export interface HarnessAgentHandle {
  readonly agent: HarnessAgent
  dispose(): Promise<void>
}

export interface HarnessCreateAgentOptions {
  readonly sessionId: string
  readonly meta: { readonly cwd: string; readonly origin: 'subagent'; readonly delegationDepth: number }
  readonly agentOptions: { readonly provider?: string; readonly model?: string; readonly maxTokens?: number }
  readonly signal?: AbortSignal
  readonly setup?: (context: HarnessAgentSetupContext) => void | Promise<void>
}

export interface HarnessAgentSetupContext {
  /** Agent-scoped Cordis lifecycle; disposal awaits outstanding file operations. */
  readonly effect?: (body: () => () => void | Promise<void>, label?: string) => unknown
  readonly agent?: object
  readonly tools: HarnessToolService
}
export type HarnessAgentSetup = (context: HarnessAgentSetupContext, request: AgentSpawnRequest) => void | Promise<void>

export interface HarnessAgentContext {
  readonly agents: {
    create(options: HarnessCreateAgentOptions): Promise<HarnessAgentHandle>
  }
}

export interface HarnessUsageSummary {
  readonly tokens: number
  readonly wallMs: number
  readonly toolCalls: number
  readonly retries: number
}

/** Structural message shape used by an optional host-owned long-task session. */
export interface HarnessExecutionMessage {
  readonly id: string
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
  readonly toolCallId?: string
  readonly toolName?: string
}

/**
 * Host-owned persistence boundary for a long Agent task. The runtime does not
 * implement checkpointing itself; a host may bind ContextManager/LangGraph
 * through this small structural port without making DSH depend on either.
 */
export interface HarnessExecutionSession {
  append(messages: readonly HarnessExecutionMessage[]): Promise<void>
  prepareContext(): Promise<HarnessExecutionPreparation>
  consumeModelTokens(tokens: number): void
  close(): Promise<void>
}

/** Optional model-facing prompt produced by the host's context projection. */
export interface HarnessExecutionPreparation {
  readonly prompt?: string
  readonly contextHash?: string
}

export interface HarnessExecutionSessionFactoryInput {
  readonly request: AgentSpawnRequest
  readonly sessionId: string
  readonly prompt: string
}

/**
 * A host may decline to bind short-lived agents (for example specification
 * agents that do not own a durable workspace lease). Returning undefined keeps
 * the normal Harness lifecycle intact without installing a no-op session.
 */
export type HarnessExecutionSessionFactory = (input: HarnessExecutionSessionFactoryInput) => Promise<HarnessExecutionSession | undefined>

export interface HarnessAgentResultInput {
  readonly request: AgentSpawnRequest
  readonly sessionId: string
  readonly events: readonly HarnessSessionEvent[]
  readonly assistant: HarnessAssistantMessage
  readonly usage?: HarnessTokenUsage
  readonly hostUsage: HarnessUsageSummary
}

export interface HarnessAgentRuntimeOptions {
  readonly context: HarnessAgentContext
  readonly cwd: string
  /** Optional: when omitted, the Harness uses its configured default (e.g. Codex auth). */
  readonly provider?: string
  /** Optional: when omitted, the Harness uses its configured default model. */
  readonly model?: string
  readonly pluginId: string
  readonly decodeResult: (input: HarnessAgentResultInput) => unknown
  readonly setupAgent?: HarnessAgentSetup
  /** Host classifier: only representational errors may receive one tool-free correction. */
  readonly resultFormatRepair?: (error: unknown) => string | undefined
  /** Optional host binding for durable long-task context and budget accounting. */
  readonly executionSessionFactory?: HarnessExecutionSessionFactory
}

export class HarnessAgentRuntime {
  readonly verifiedProvenance = true as const

  constructor(private readonly options: HarnessAgentRuntimeOptions) {}

  async spawn(request: AgentSpawnRequest, signal?: AbortSignal): Promise<AgentHandle> {
    throwIfAborted(signal)
    const prompt = formatTask(request)
    const { delegation, ...data } = request
    const exactRequest: AgentSpawnRequest = { ...structuredClone(data), ...(delegation === undefined ? {} : { delegation: Object.freeze({ delegateWorker: delegation.delegateWorker }) }) }
    const sessionId = randomUUID()
    const startedAt = Date.now()
    const deadline = exactRequest.agentTask === undefined ? Number.POSITIVE_INFINITY : startedAt + exactRequest.agentTask.budget.maxWallMs
    const openedExecutionSession = await this.openExecutionSession(exactRequest, sessionId, prompt)
    const executionSession = openedExecutionSession?.session
    const executionPrompt = openedExecutionSession?.prompt ?? prompt
    if (Date.now() >= deadline) {
      await executionSession?.close().catch(() => undefined)
      throw new Error('managed Agent wall-time budget exhausted')
    }
    let setupContext: HarnessAgentSetupContext | undefined
    const agentOptions = {
      ...(this.options.provider === undefined ? {} : { provider: this.options.provider }),
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      ...(exactRequest.agentTask === undefined ? {} : { maxTokens: exactRequest.agentTask.budget.maxTokens }),
    }
    let created: HarnessAgentHandle
    try {
      created = await this.options.context.agents.create({
        sessionId,
        meta: { cwd: this.options.cwd, origin: 'subagent', delegationDepth: exactRequest.agentTask?.depth ?? 1 },
        agentOptions,
        ...(signal === undefined ? {} : { signal }),
        ...((this.options.setupAgent === undefined && this.options.resultFormatRepair === undefined) ? {} : { setup: async (context: HarnessAgentSetupContext) => { setupContext = context; await this.options.setupAgent?.(context, exactRequest) } }),
      })
    } catch (error: unknown) {
      await executionSession?.close().catch(() => undefined)
      throw error
    }
    let disposed = false
    let disposePromise: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      disposed = true
      disposePromise ??= (async () => {
        try { await created.dispose() } finally { await executionSession?.close() }
      })()
      return disposePromise
    }
    if (signal?.aborted) {
      await dispose()
      throw abortError()
    }

    const startSeq = nextSequence(created.agent.session.events)
    try {
      throwIfAborted(signal)
      created.agent.followup(createUserMessage({
        content: [{ type: 'text', text: executionPrompt }],
        source: { kind: 'plugin', plugin: this.options.pluginId },
      }))
    } catch (error) {
      await dispose()
      throw error
    }

    let resultPromise: Promise<unknown> | undefined
    let cancelPromise: Promise<void> | undefined
    const result = (resultSignal?: AbortSignal): Promise<unknown> => {
      resultPromise ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const resolved = this.resolveResult(created.agent, exactRequest, sessionId, startSeq, { tools: () => setupContext?.tools, deadline, startedAt, stopped: () => disposed || cancelPromise !== undefined || signal?.aborted === true, ...(executionSession === undefined ? {} : { executionSession }) })
          if (exactRequest.agentTask === undefined) return await resolved
          const expired = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('managed Agent wall-time budget exhausted'))
              void cancel().catch(() => undefined)
            }, Math.max(0, deadline - Date.now()))
          })
          return await Promise.race([resolved, expired])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
          await dispose()
        }
      })()
      return resultSignal === undefined ? resultPromise : raceWithAbort(resultPromise, resultSignal, () => { void cancel().catch(() => undefined) })
    }
    const cancel = (): Promise<void> => {
      if (disposed) return disposePromise ?? Promise.resolve()
      cancelPromise ??= (async () => {
        created.agent.cancel({ kind: 'user' })
        await created.agent.whenIdle()
        await dispose()
      })()
      return cancelPromise
    }
    return { id: String(created.agent.id), result, cancel }
  }

  private async resolveResult(agent: HarnessAgent, request: AgentSpawnRequest, sessionId: string, startSeq: number, repair: { tools: () => HarnessToolService | undefined; deadline: number; startedAt: number; stopped: () => boolean; executionSession?: HarnessExecutionSession }): Promise<unknown> {
    let corrections = 0
    const recordedAssistantEvents = new Set<number>()
    for (;;) {
      await agent.whenIdle()
      const events = agent.session.events.filter((event) => event.seq >= startSeq)
      const event = [...events].reverse().find((candidate) => candidate.type === 'assistant/message')
      if (event === undefined || !isRecord(event.data)) throw new Error('Harness Agent did not publish an assistant result')
      const assistant = event.data.message
      if (!isRecord(assistant) || !Array.isArray(assistant.content)) throw new Error('Harness assistant result has an invalid message')
      const usage = isTokenUsage(event.data.usage) ? event.data.usage : undefined
      if (repair.executionSession !== undefined && !recordedAssistantEvents.has(event.seq)) {
        recordedAssistantEvents.add(event.seq)
        await repair.executionSession.append([{ id: `assistant:${sessionId}:${event.seq}`, role: 'assistant', content: serializeContent(assistant.content) }])
        if (usage !== undefined) repair.executionSession.consumeModelTokens(tokenUsage(usage))
      }
      const observed = summarizeUsage(events)
      const hostUsage = { ...observed, wallMs: repair.executionSession === undefined ? observed.wallMs : Math.max(observed.wallMs, Date.now() - repair.startedAt), retries: observed.retries + corrections }
      try {
        return this.options.decodeResult({ request, sessionId, events, assistant: assistant as unknown as HarnessAssistantMessage, ...(usage === undefined ? {} : { usage }), hostUsage })
      } catch (error) {
        const instruction = this.options.resultFormatRepair?.(error)
        const budget = request.agentTask?.budget
        const tools = repair.tools()
        if (instruction === undefined || corrections >= 1 || budget === undefined || tools === undefined || repair.stopped() || Date.now() >= repair.deadline || hostUsage.tokens >= budget.maxTokens || hostUsage.wallMs >= budget.maxWallMs || hostUsage.toolCalls > budget.maxToolCalls || hostUsage.retries >= budget.maxRetries) throw error
        // A correction cannot re-run work or modify the artifacts already produced.
        // The monotonic guard lasts until this owned Agent is disposed.
        tools.guard(() => 'Tools are disabled during result format correction')
        if (repair.stopped() || Date.now() >= repair.deadline) throw error
        corrections++
        await repair.executionSession?.append([{ id: `correction:${sessionId}:${corrections}`, role: 'user', content: formatCorrection(request, instruction) }])
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: formatCorrection(request, instruction) }],
          source: { kind: 'plugin', plugin: this.options.pluginId },
        }))
      }
    }
  }

  private async openExecutionSession(request: AgentSpawnRequest, sessionId: string, prompt: string): Promise<{ readonly session: HarnessExecutionSession; readonly prompt?: string } | undefined> {
    const factory = this.options.executionSessionFactory
    if (factory === undefined) return undefined
    const session = await factory({ request, sessionId, prompt })
    if (session === undefined) return undefined
    try {
      await session.append([{ id: `user:${sessionId}:0`, role: 'user', content: prompt }])
      const preparation = await session.prepareContext()
      const preparedPrompt = preparation !== undefined && typeof preparation.prompt === 'string' && preparation.prompt.trim().length > 0 ? preparation.prompt : undefined
      return { session, ...(preparedPrompt === undefined ? {} : { prompt: preparedPrompt }) }
    } catch (error: unknown) {
      await session.close().catch(() => undefined)
      throw error
    }
  }
}

function formatTask(request: AgentSpawnRequest): string {
  let payload: string
  try {
    payload = JSON.stringify({ role: request.role, task: request.task, context: request.context, agentTask: request.agentTask })
  } catch (error) {
    throw new Error('Agent task context must be serializable JSON', { cause: error })
  }
  const schema = resultSchema(request)
  return `You are the ${request.role} in a backend development team. Return exactly one JSON object matching the result schema, without surrounding prose. The host records consumedBudget; do not supply it. Report only actions and verification actually performed. Never invent passing checks. Use failed, blocked, interrupted, or not-run outcomes when appropriate. A passed result requires every verification record to have outcome passed and zero exit codes for every reported command. Never combine status passed with a failed, blocked or not-run verification record. Required checks that you could not execute mean the result is blocked or not-run; do not claim success. Checks explicitly assigned to the host in the approved test plan run after this role: mention them as deferred in risks, never claim they ran, and do not classify them as unresolved work for this role. unresolvedItems is for actual unfinished work within your assigned scope. Report commands only for the file revision after your latest edit; superseded failures remain in the host session history. Use only instruction IDs declared in agentTask.verification; acceptance labels and evidence names are not instruction IDs. Keep the summary to at most two short sentences. Do not repeat the task document, every assertion, or the tool transcript in summary. Keep risks and unresolvedItems brief and avoid listing downstream host checks as blockers for a completed role. All file and evidence paths must be workspace-relative, without traversal. Changed paths require a real before or after SHA-256 hash; never set both to null. Follow only the declared task capabilities, paths and budget.\nResult JSON schema:\n${JSON.stringify(schema)}\nTask payload:\n${payload}`
}

function resultSchema(request: AgentSpawnRequest) {
  const schema = z.toJSONSchema(z.object(AgentResultSchema.shape).omit({ consumedBudget: true }).strict())
  const taskIdSchema = schema.properties?.taskId
  if (request.agentTask !== undefined && typeof taskIdSchema === 'object') taskIdSchema.const = request.agentTask.id
  const verification = schema.properties?.verification
  if (request.agentTask !== undefined && typeof verification === 'object') {
    const records = verification.properties?.records
    const item = typeof records === 'object' ? records.items : undefined
    const instructionId = typeof item === 'object' && !Array.isArray(item) ? item.properties?.instructionId : undefined
    if (typeof instructionId === 'object') instructionId.enum = request.agentTask.verification.map(instruction => instruction.id)
  }
  return schema
}

function formatCorrection(request: AgentSpawnRequest, instruction: string): string {
  return 'Your final result failed JSON format validation. Correct only its representation. Do not use tools, redo work, change verification outcomes, or invent evidence. Preserve the actions and facts already reported. If the work failed or is blocked, keep that outcome. Return exactly one object matching this strict schema; no extra fields or surrounding prose. The host supplies consumedBudget.\n' + instruction + '\nResult JSON schema:\n' + JSON.stringify(resultSchema(request))
}

function nextSequence(events: readonly HarnessSessionEvent[]): number {
  let max = -1
  for (const event of events) if (Number.isSafeInteger(event.seq) && event.seq > max) max = event.seq
  return max + 1
}

function summarizeUsage(events: readonly HarnessSessionEvent[]): HarnessUsageSummary {
  const times = events.map((event) => event.time).filter((time) => Number.isFinite(time))
  const first = times.length === 0 ? 0 : Math.min(...times)
  const last = times.length === 0 ? first : Math.max(...times)
  // DSH emits per-call usage on every assistant message, including tool steps.
  // Cache input buckets are disjoint; reasoning is already part of output.
  const tokens = events.reduce((sum, event) => {
    if (event.type !== 'assistant/message' || !isRecord(event.data) || event.data.usage === undefined) return sum
    const usage = event.data.usage
    if (!isTokenUsage(usage)) throw new Error('Harness model usage has invalid token counts')
    const next = sum + usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    if (!Number.isFinite(next)) throw new Error('Harness model usage exceeds numeric range')
    return next
  }, 0)
  return {
    tokens,
    wallMs: Math.max(0, last - first),
    toolCalls: events.filter((event) => event.type === 'tool/call').length,
    retries: events.filter((event) => event.type === 'llm/retry').length,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

function isTokenUsage(value: unknown): value is HarnessTokenUsage {
  return isRecord(value) && isFiniteNonNegative(value.inputTokens) && isFiniteNonNegative(value.outputTokens)
    && (value.cacheReadTokens === undefined || isFiniteNonNegative(value.cacheReadTokens))
    && (value.cacheWriteTokens === undefined || isFiniteNonNegative(value.cacheWriteTokens))
}

function tokenUsage(usage: HarnessTokenUsage): number {
  return usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

function serializeContent(content: readonly unknown[]): string {
  try { return JSON.stringify(content) }
  catch { return String(content) }
}

function isFiniteNonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }

function throwIfAborted(signal: AbortSignal | undefined): void { if (signal?.aborted) throw abortError() }

function abortError(): Error { const error = new Error('Agent operation aborted'); error.name = 'AbortError'; return error }

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => void): Promise<T> {
  if (signal.aborted) {
    onAbort()
    return Promise.reject(abortError())
  }
  return new Promise<T>((resolve, reject) => {
    const abortListener = () => { onAbort(); reject(abortError()) }
    signal.addEventListener('abort', abortListener, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', abortListener); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', abortListener); reject(error) },
    )
  })
}
