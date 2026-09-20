import { AgentResultSchema } from '@dsh-backend-team/contracts'
import type { AgentBudget, AgentHandle, AgentSpawnRequest, ApprovalDecision, ApprovalRequest, ApprovalRequestContext, BackendTeamEvent, BackendTeamOrchestrationPort, AgentResult, RunStatus } from '@dsh-backend-team/contracts'
import type { ControlMediatedApprovalPort, ApprovalContext } from './control-mediated-approval-port.js'
import type { PersistedEventPort } from './persisted-event-port.js'
export interface VerifiedAgentPort extends Pick<BackendTeamOrchestrationPort, 'spawnAgent'> { readonly verifiedProvenance: true }
export interface ProductionOrchestrationOptions { readonly workspaceId: string; readonly events: PersistedEventPort; readonly approvals: ControlMediatedApprovalPort; readonly agents: VerifiedAgentPort }
export function createProductionOrchestrationPort(options: ProductionOrchestrationOptions | { readonly orchestration: unknown }): BackendTeamOrchestrationPort {
  if ('orchestration' in options) {
    if (options.orchestration === null || typeof options.orchestration !== 'object' || options.orchestration.constructor.name.includes('Mock')) throw new Error('production orchestration cannot use mocks')
    throw new Error('production orchestration dependencies are incomplete')
  }
  if (options.agents.verifiedProvenance !== true) throw new Error('production orchestration requires verified Agent provenance')
  if (options.approvals.constructor.name.includes('Mock') || options.events.constructor.name.includes('Mock')) throw new Error('production orchestration cannot use mocks')
  return new ProductionOrchestrationPort(options)
}
class ProductionOrchestrationPort implements BackendTeamOrchestrationPort {
  constructor(private readonly options: ProductionOrchestrationOptions) {}
  requestApproval(request: ApprovalRequest, context: ApprovalRequestContext = { stateRevision: 0 }): Promise<ApprovalDecision> { return this.options.approvals.requestApproval(request, { workspaceId: this.options.workspaceId, stateRevision: context.stateRevision } satisfies ApprovalContext) }
  async spawnAgent(request: AgentSpawnRequest, signal?: AbortSignal): Promise<AgentHandle> {
    const startedAt = new Date().toISOString()
    const handle = await this.options.agents.spawnAgent(request, signal)
    const runId = `agent-${handle.id}`
    try {
      await this.appendRun(`run-started-${handle.id}`, { id: runId, status: 'running', startedAt, completedAt: null, summary: 'Agent running' })
    } catch (error) {
      await handle.cancel().catch(() => undefined)
      throw error
    }
    let terminal: Promise<void> | undefined
    let terminalStatus: RunStatus | undefined
    let resultPromise: Promise<unknown> | undefined
    let cancelPromise: Promise<void> | undefined
    const persist = (status: RunStatus, summary: string, consumedBudget?: AgentResult['consumedBudget']): Promise<void> => {
      if (terminal !== undefined) return terminal
      terminalStatus = status
      terminal = (async () => {
        const run = {
          id: runId,
          status,
          startedAt,
          completedAt: new Date().toISOString(),
          summary,
          ...(consumedBudget === undefined ? {} : { consumedBudget }),
        }
        await this.appendRun(`run-recorded-${handle.id}`, run)
      })()
      return terminal
    }
    return {
      id: handle.id,
      result: (resultSignal) => {
        resultPromise ??= (async () => {
          try {
            const value = await handle.result(resultSignal)
            const result = AgentResultSchema.parse(value)
            const overrun = budgetOverrun(request.agentTask?.budget, result)
            await persist(overrun.length === 0 ? result.status : 'blocked', overrun.length === 0 ? result.summary : formatBudgetOverrun(overrun), result.consumedBudget)
            return value
          } catch (error) {
            const timedOut = isWallClockBudgetError(error) || isWallClockBudgetSignal(signal)
            const interrupted = isAbortError(error) || cancelPromise !== undefined || signal?.aborted === true
            const status: RunStatus = timedOut ? 'blocked' : interrupted ? 'interrupted' : 'failed'
            await persist(status, timedOut ? 'Agent wall-clock budget exhausted' : status === 'interrupted' ? 'Agent interrupted' : 'Agent result failed', timedOut ? timeoutUsage(request) : undefined)
            throw error
          }
        })()
        return resultPromise
      },
      cancel: () => {
        if (terminalStatus !== undefined) return terminal ?? Promise.resolve()
        cancelPromise ??= (async () => {
          await handle.cancel()
          const timedOut = isWallClockBudgetSignal(signal)
          await persist(timedOut ? 'blocked' : 'interrupted', timedOut ? 'Agent wall-clock budget exhausted' : 'Agent cancelled', timedOut ? timeoutUsage(request) : undefined)
        })()
        return cancelPromise
      },
    }
  }
  emit(event: BackendTeamEvent): Promise<void> { return this.options.events.emit(event) }
  private async appendRun(id: string, run: { readonly id: string; readonly status: RunStatus; readonly startedAt: string; readonly completedAt: string | null; readonly summary: string; readonly consumedBudget?: AgentResult['consumedBudget'] }): Promise<void> {
    await this.options.events.emitNext({ id, occurredAt: new Date().toISOString(), type: 'run-recorded', revision: 0, run })
  }
}

function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError' }
function isWallClockBudgetError(error: unknown): boolean { return error instanceof Error && /(?:wall[- ]clock|wall[- ]time).*budget.*exhausted/iu.test(error.message) }
function isWallClockBudgetSignal(signal: AbortSignal | undefined): boolean { return signal?.aborted === true && isWallClockBudgetError(signal.reason) }
function timeoutUsage(request: AgentSpawnRequest): AgentResult['consumedBudget'] | undefined {
  const budget = request.agentTask?.budget
  return budget === undefined ? undefined : { tokens: 0, wallMs: budget.maxWallMs, toolCalls: 0, retries: 0, children: 0 }
}

function budgetOverrun(budget: AgentBudget | undefined, result: AgentResult): readonly string[] {
  if (budget === undefined || budget === null || typeof budget !== 'object') return []
  const limits = [
    ['tokens', result.consumedBudget.tokens, budget.maxTokens],
    ['wallMs', result.consumedBudget.wallMs, budget.maxWallMs],
    ['toolCalls', result.consumedBudget.toolCalls, budget.maxToolCalls],
    ['retries', result.consumedBudget.retries, budget.maxRetries],
    ['children', Math.max(result.consumedBudget.children, result.childResultIds.length), budget.maxChildren],
  ] as const
  return limits.filter(([, used, limit]) => used > limit).map(([dimension, used, limit]) => `${dimension} used ${used} > limit ${limit}`)
}

function formatBudgetOverrun(overrun: readonly string[]): string { return `Agent result blocked: declared budget exhausted (${overrun.join(', ')})` }
