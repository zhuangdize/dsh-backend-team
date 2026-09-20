import type { AgentSpawnRequest, AgentTask } from '@dsh-backend-team/contracts'
import {
  FileContextCheckpointStore,
  LongTaskExecutionSession,
  type ContextCheckpointStore,
  type ContextManagerOptions,
  type ContextProjection,
  type LongTaskBudgetLedgerPort,
  type LongTaskOwnershipPort,
  type LongTaskRunLeasePort,
} from '@dsh-backend-team/agent-team'
import type { HarnessExecutionMessage, HarnessExecutionPreparation, HarnessExecutionSession, HarnessExecutionSessionFactory } from '@dsh-backend-team/harness-adapter'

export interface LongTaskSessionBindingOptions {
  readonly workspaceRoot: string
  readonly runLease: LongTaskRunLeasePort
  readonly ownership: LongTaskOwnershipPort
  readonly contextOptions: ContextManagerOptions
  readonly contextStore?: ContextCheckpointStore
  readonly budget?: (task: AgentTask) => { readonly taskMaxTokens: number; readonly windowMaxTokens: number; readonly compactionMaxTokens: number }
  readonly budgetLedger?: (task: AgentTask) => LongTaskBudgetLedgerPort | undefined
  /** Optional host classifier; returning false leaves the normal Harness path untouched. */
  readonly shouldBind?: (task: AgentTask) => boolean
  /** Converts the bounded projection into the exact prompt sent to DSH. */
  readonly renderPrompt?: (input: { readonly request: AgentSpawnRequest; readonly prompt: string; readonly projection: ContextProjection }) => string
}

/**
 * Adapts the production-neutral long-task session to the Harness runtime.
 * Authorization and the cross-process lease remain host-owned inputs.
 */
export function createLongTaskExecutionSessionFactory(options: LongTaskSessionBindingOptions): HarnessExecutionSessionFactory {
  const store = options.contextStore ?? new FileContextCheckpointStore(options.workspaceRoot)
  return async ({ request, prompt }): Promise<HarnessExecutionSession | undefined> => {
    const task = request.agentTask
    if (task === undefined) throw new Error('long-task session requires a structured agent task')
    if (options.shouldBind?.(task) === false) return undefined
    const budgetLedger = options.budgetLedger?.(task)
    const sessionOptions = {
      taskId: task.id,
      readPaths: task.readPaths,
      writePaths: task.writePaths,
      runLease: options.runLease,
      ownership: options.ownership,
      contextStore: store,
      contextOptions: options.contextOptions,
      budget: options.budget?.(task) ?? defaultBudget(task),
      ...(budgetLedger === undefined ? {} : { budgetLedger }),
    }
    const session = await LongTaskExecutionSession.open(sessionOptions)
    return {
      append: (messages: readonly HarnessExecutionMessage[]) => session.append(messages),
      prepareContext: async (): Promise<HarnessExecutionPreparation> => {
        const projection = await session.prepareContext()
        const rendered = options.renderPrompt?.({ request, prompt, projection })
        if (rendered !== undefined && (typeof rendered !== 'string' || rendered.trim().length === 0)) throw new Error('long-task rendered prompt is invalid')
        return { contextHash: projection.contextHash, ...(rendered === undefined ? {} : { prompt: rendered }) }
      },
      consumeModelTokens: (tokens: number) => { session.consumeModelTokens(tokens) },
      close: () => session.close(),
    }
  }
}

function defaultBudget(task: AgentTask): { readonly taskMaxTokens: number; readonly windowMaxTokens: number; readonly compactionMaxTokens: number } {
  const taskMaxTokens = task.budget.maxTokens
  const windowMaxTokens = Math.max(1, Math.min(taskMaxTokens, 262_144))
  const compactionMaxTokens = Math.max(1, Math.min(taskMaxTokens, 16_384))
  return { taskMaxTokens, windowMaxTokens, compactionMaxTokens }
}
