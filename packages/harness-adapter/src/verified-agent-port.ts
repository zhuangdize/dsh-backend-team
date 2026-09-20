import type { AgentHandle, AgentSpawnRequest } from '@dsh-backend-team/contracts'
import { HarnessAgentRuntime, type HarnessAgentContext, type HarnessAgentResultInput, type HarnessAgentSetup, type HarnessExecutionSessionFactory } from './harness-agent-runtime.js'

/**
 * The exact application boundary accepted by Core's production composition.
 * The provenance marker is fixed by this adapter; callers cannot opt into a
 * production graph with an unverified or mock Agent implementation.
 */
export interface VerifiedHarnessAgentPort {
  readonly verifiedProvenance: true
  spawnAgent(request: AgentSpawnRequest, signal?: AbortSignal): Promise<AgentHandle>
}

export interface VerifiedHarnessAgentPortOptions {
  readonly context: HarnessAgentContext
  readonly cwd: string
  readonly provider?: string
  readonly model?: string
  readonly pluginId: string
  readonly decodeResult: (input: HarnessAgentResultInput) => unknown
  readonly setupAgent?: HarnessAgentSetup
  readonly resultFormatRepair?: (error: unknown) => string | undefined
  readonly executionSessionFactory?: HarnessExecutionSessionFactory
}

/** Adapt the verified public Harness Agent lifecycle to Core's port shape. */
export function createHarnessAgentPort(options: VerifiedHarnessAgentPortOptions): VerifiedHarnessAgentPort {
  const runtime = new HarnessAgentRuntime(options)
  return Object.freeze({
    verifiedProvenance: true as const,
    spawnAgent: (request: AgentSpawnRequest, signal?: AbortSignal) => runtime.spawn(request, signal),
  })
}
