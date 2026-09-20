import { Annotation, Command, END, interrupt, START, StateGraph, type BaseCheckpointSaver, type LangGraphRunnableConfig } from '@langchain/langgraph'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import type { Pool } from 'pg'
import {
  PostgresContextCheckpointStore,
  type ContextCheckpointStore,
  type ContextMessage,
  type ContextManagerOptions,
  type ContextProjection,
  type ContextSummarizer,
  type PostgresCheckpointQueryPort,
} from '../../../packages/agent-team/src/context-manager.js'
import { LongTaskExecutionSession, type LongTaskBudgetLedgerPort, type LongTaskOwnershipPort, type LongTaskRunLeasePort } from '../../../packages/agent-team/src/long-task-execution-session.js'

const TOOL_IDEMPOTENCY_KEY = 'database-inspection:v1'

export interface KernelState {
  readonly contextHash: string
  readonly contextActions: readonly string[]
  readonly toolExecutions: number
  readonly approval?: string
  readonly result?: string
}

export interface KernelRun {
  readonly threadId: string
  readonly state: KernelState & { readonly __interrupt__?: readonly unknown[] }
  readonly projection: ContextProjection
  readonly interrupted: boolean
}

export interface LongTaskKernelOptions {
  readonly checkpointer: BaseCheckpointSaver
  readonly contextStore: ContextCheckpointStore
  readonly contextOptions: ContextManagerOptions
  readonly tool: () => Promise<void>
  readonly summarizer?: ContextSummarizer
  readonly runLease?: (threadId: string) => LongTaskRunLeasePort
  readonly ownership?: (threadId: string) => LongTaskOwnershipPort
  readonly budget?: { readonly taskMaxTokens: number; readonly windowMaxTokens: number; readonly compactionMaxTokens: number }
  readonly budgetLedger?: (threadId: string) => LongTaskBudgetLedgerPort | undefined
}

const KernelStateAnnotation = Annotation.Root({
  contextHash: Annotation<string>({ reducer: (_left, right) => right, default: () => '' }),
  contextActions: Annotation<string[]>({ reducer: (_left, right) => [...right], default: () => [] }),
  toolExecutions: Annotation<number>({ reducer: (_left, right) => right, default: () => 0 }),
  approval: Annotation<string | undefined>({ reducer: (_left, right) => right, default: () => undefined }),
  result: Annotation<string | undefined>({ reducer: (_left, right) => right, default: () => undefined }),
})

/**
 * A deliberately small LangGraph execution kernel for T25.
 * The existing Agent Team remains the production orchestrator; this class only
 * proves the boundary between ContextManager, thread checkpoints and HITL.
 */
export class LongTaskKernel {
  private readonly sessions = new Map<string, LongTaskExecutionSession>()
  private readonly threadLocks = new Map<string, Promise<void>>()
  private readonly graph: ReturnType<typeof buildGraph>

  constructor(private readonly options: LongTaskKernelOptions) {
    this.graph = buildGraph(options.checkpointer, async (threadId) => this.sessionFor(threadId), options.tool)
  }

  async appendContext(threadId: string, messages: readonly ContextMessage[]): Promise<void> {
    await this.withThreadLock(threadId, async () => {
      await (await this.sessionFor(threadId)).append(messages)
    })
  }

  async prepareContext(threadId: string): Promise<ContextProjection> {
    return this.withThreadLock(threadId, async () => {
      return (await this.sessionFor(threadId)).prepareContext()
    })
  }

  async run(threadId: string, input?: { readonly userMessage?: string; readonly resume?: unknown }): Promise<KernelRun> {
    return this.withThreadLock(threadId, async () => {
      if (input?.userMessage !== undefined) {
        await (await this.sessionFor(threadId)).append([{
          id: `user:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          content: input.userMessage,
        }])
      }
      const projection = await (await this.sessionFor(threadId)).prepareContext()
      const update = { contextHash: projection.contextHash, contextActions: [...projection.actions] }
      const config = { configurable: { thread_id: threadId } }
      const graphInput: Parameters<ReturnType<typeof buildGraph>['invoke']>[0] = input?.resume === undefined
        ? update
        : new Command({ resume: input.resume, update })
      const state = await this.graph.invoke(graphInput, config)
      const interruptValue = (state as Record<string, unknown>).__interrupt__
      return {
        threadId,
        state: state as KernelRun['state'],
        projection,
        interrupted: Array.isArray(interruptValue) && interruptValue.length > 0,
      }
    })
  }

  async getState(threadId: string): Promise<KernelState> {
    const state = await this.graph.getState({ configurable: { thread_id: threadId } })
    return state.values as KernelState
  }

  async managerSnapshot(threadId: string) {
    return (await this.sessionFor(threadId)).snapshot().then(snapshot => snapshot.context)
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.sessions.get(threadId)?.close()
    await this.options.checkpointer.deleteThread(threadId)
    this.sessions.delete(threadId)
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(session => session.close()))
    const maybeEnd = this.options.checkpointer as BaseCheckpointSaver & { end?: () => Promise<void> }
    await maybeEnd.end?.()
  }

  private async sessionFor(threadId: string): Promise<LongTaskExecutionSession> {
    const cached = this.sessions.get(threadId)
    if (cached !== undefined) return cached
    const session = await LongTaskExecutionSession.open({
      taskId: threadId,
      runLease: this.options.runLease?.(threadId) ?? NOOP_RUN_LEASE,
      ownership: this.options.ownership?.(threadId) ?? NOOP_OWNERSHIP,
      contextStore: this.options.contextStore,
      contextOptions: {
        ...this.options.contextOptions,
        ...(this.options.summarizer === undefined ? {} : { summarizer: this.options.summarizer }),
      },
      budget: this.options.budget ?? { taskMaxTokens: 1_000_000, windowMaxTokens: 262_144, compactionMaxTokens: 16_384 },
      ...(this.options.budgetLedger === undefined ? {} : { budgetLedger: this.options.budgetLedger(threadId) }),
    })
    this.sessions.set(threadId, session)
    return session
  }

  private async withThreadLock<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.threadLocks.get(threadId) ?? Promise.resolve()
    let release: (() => void) | undefined
    const turn = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.then(() => turn, () => turn)
    this.threadLocks.set(threadId, queued)
    await previous
    try { return await operation() } finally {
      release?.()
      if (this.threadLocks.get(threadId) === queued) this.threadLocks.delete(threadId)
    }
  }
}

function buildGraph(
  checkpointer: BaseCheckpointSaver,
  sessionFor: (threadId: string) => Promise<LongTaskExecutionSession>,
  tool: () => Promise<void>,
) {
  const graph = new StateGraph(KernelStateAnnotation)
    .addNode('executeTool', async (_state: KernelState, config: LangGraphRunnableConfig) => {
      const threadId = readThreadId(config)
      const session = await sessionFor(threadId)
      await session.runTool(TOOL_IDEMPOTENCY_KEY, tool)
      const snapshot = await session.snapshot()
      const executions = snapshot.context.toolCalls.filter(call => call.idempotencyKey === TOOL_IDEMPOTENCY_KEY && call.status === 'completed').length
      return { toolExecutions: executions }
    })
    .addNode('requestApproval', async (state: KernelState) => {
      const answer = interrupt({ kind: 'approval', question: 'Approve the inspected database result?' })
      return { approval: String(answer), contextHash: state.contextHash }
    })
    .addNode('finalize', async (state: KernelState) => ({ result: `approved:${state.approval ?? ''}` }))
    .addEdge(START, 'executeTool')
    .addEdge('executeTool', 'requestApproval')
    .addEdge('requestApproval', 'finalize')
    .addEdge('finalize', END)
  return graph.compile({ checkpointer })
}

const NOOP_RUN_LEASE: LongTaskRunLeasePort = { acquire: async () => async () => {} }
const NOOP_OWNERSHIP: LongTaskOwnershipPort = { assert: () => {} }

function readThreadId(config: LangGraphRunnableConfig): string {
  const value = config.configurable?.thread_id
  if (typeof value !== 'string' || value.length === 0) throw new Error('LangGraph config is missing configurable.thread_id')
  return value
}

export interface PostgresKernelHandle {
  readonly kernel: LongTaskKernel
  readonly pool: Pool
}

export async function createPostgresKernel(options?: {
  readonly connectionString?: string
  readonly contextOptions?: LongTaskKernelOptions['contextOptions']
  readonly tool?: () => Promise<void>
  readonly summarizer?: ContextSummarizer
}): Promise<PostgresKernelHandle> {
  const { Pool: PgPool } = await import('pg')
  const pool = new PgPool({ connectionString: options?.connectionString ?? process.env.T25_POSTGRES_URL ?? 'postgresql:///postgres?host=/tmp' })
  const checkpointer = new PostgresSaver(pool)
  await checkpointer.setup()
  const queryPort: PostgresCheckpointQueryPort = {
    query: async <T extends Record<string, unknown>>(text: string, values: readonly unknown[]) => {
      const result = await pool.query<T>(text, [...values])
      return result.rows
    },
  }
  const contextStore = new PostgresContextCheckpointStore(queryPort)
  const kernel = new LongTaskKernel({
    checkpointer,
    contextStore,
    contextOptions: options?.contextOptions ?? {
      contextWindowTokens: 420,
      outputLimitTokens: 40,
      toolBufferTokens: 20,
      safetyMarginTokens: 20,
      retainRecentMessages: 2,
      maxSummaryTokens: 96,
    },
    tool: options?.tool ?? (async () => undefined),
    summarizer: options?.summarizer,
  })
  return { kernel, pool }
}
