import type { AgentTask } from '@dsh-backend-team/contracts'
import type { AgentRole } from '@dsh-backend-team/contracts'
import type { DurableHandoff } from './handoff-store.js'
import type { ContextBuildInput } from './context-builder.js'

export interface RuntimeExpertInput {
  readonly id: string
  readonly role: Exclude<AgentRole, 'coordinator' | 'worker'>
  readonly objective: string
  readonly nonGoals: readonly string[]
  readonly inputArtifacts: AgentTask['inputArtifacts']
  readonly readPaths: readonly string[]
  readonly writePaths: readonly string[]
  readonly capabilities: AgentTask['capabilities']
  readonly budget: AgentTask['budget']
  readonly doneWhen: readonly string[]
  readonly verification: AgentTask['verification']
  readonly returnSchema: string
  readonly context?: ContextBuildInput
}

export interface TeamRuntimeCoordinator {
  dispatchExpert(input: RuntimeExpertInput): Promise<DurableHandoff>
  dispatchWorker(parent: AgentTask, proposed: AgentTask): Promise<DurableHandoff>
}

export interface TeamRuntimeOptions {
  readonly coordinator: TeamRuntimeCoordinator
}

/** Thin application runtime facade; it only forwards bounded coordinator operations. */
export class TeamRuntime {
  readonly coordinator: TeamRuntimeCoordinator
  constructor(options: TeamRuntimeOptions) { this.coordinator = options.coordinator }

  async runExperts(experts: readonly RuntimeExpertInput[]): Promise<readonly DurableHandoff[]> {
    return Promise.all(experts.map((expert) => this.coordinator.dispatchExpert(expert)))
  }

  dispatchWorker(parent: AgentTask, proposed: AgentTask): Promise<DurableHandoff> {
    return this.coordinator.dispatchWorker(parent, proposed)
  }
}
