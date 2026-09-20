import type { AgentTask } from '@dsh-backend-team/contracts'
import type { ExpertPreset } from './preset-loader.js'
import { DelegationGuard, type DelegationAllowDecision } from './delegation-guard.js'

export type AgentFactoryDecision = DelegationAllowDecision | { readonly effect: 'deny'; readonly reason: string }

export interface AgentFactoryOptions {
  readonly parent: AgentTask
  readonly preset: ExpertPreset
  readonly guard: DelegationGuard
}

/** Mock-only task factory. A later stage will connect this to the orchestration port. */
export class AgentFactory {
  constructor(private readonly options: AgentFactoryOptions) {}

  async spawn(proposed: AgentTask): Promise<AgentFactoryDecision> {
    try {
      return await this.options.guard.authorizeChild(this.options.parent, proposed)
    } catch (error) {
      return { effect: 'deny', reason: error instanceof Error ? error.message : 'child delegation denied' }
    }
  }
}
