import { AgentCapabilitySetSchema } from '@dsh-backend-team/contracts'
import type { AgentCapabilitySet, AgentRole, BackendTeamPhase } from '@dsh-backend-team/contracts'

export interface RolePolicyOptions {
  readonly designApproved: boolean
}

const testerPaths = ['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**', '.backend-team/runs/**/verification/**'] as const
const writablePhase = (phase: BackendTeamPhase): boolean => phase === 'BUILD' || phase === 'VERIFY'
const capabilities = (overrides: Partial<AgentCapabilitySet>): AgentCapabilitySet => AgentCapabilitySetSchema.parse(overrides)

/** Phase-aware capability ceilings. Child grants are narrowed again by delegation and ownership guards. */
export class RolePolicy {
  constructor(private readonly options: RolePolicyOptions) {}

  maxCapabilities(role: AgentRole, phase: BackendTeamPhase): AgentCapabilitySet {
    const writable = this.options.designApproved && writablePhase(phase)
    if ((role === 'developer' || role === 'fixer') && writable) {
      return capabilities({ readProjectFiles: true, writeOwnedFiles: true, businessCodeWrite: true, testCodeWrite: true, configurationWrite: true, commandExecution: true, canDelegate: true })
    }
    if (role === 'tester' && writable) {
      return capabilities({ readProjectFiles: true, writeOwnedFiles: true, testCodeWrite: true, commandExecution: true, canDelegate: true })
    }
    if (role === 'backend-architect' || role === 'database-designer') return capabilities({ readProjectFiles: true, canDelegate: true })
    if (role === 'requirements' || role === 'project-analyzer' || role === 'oss-researcher' || role === 'planner' || role === 'security-reviewer') return capabilities({ readProjectFiles: true })
    return capabilities({})
  }

  writePathPatterns(role: AgentRole, phase: BackendTeamPhase): readonly string[] {
    return role === 'tester' && this.options.designApproved && writablePhase(phase) ? testerPaths : []
  }
}
