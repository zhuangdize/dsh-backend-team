import type { BackendTeamPhase } from '@dsh-backend-team/contracts'

export type ApprovalGate = 'requirements' | 'design'

export type ArtifactChangePhase = 'SPECIFY' | 'DESIGN' | 'PLAN'

const NEXT: Readonly<Record<BackendTeamPhase, readonly BackendTeamPhase[]>> = {
  DISCOVER: ['SPECIFY'],
  SPECIFY: ['AWAIT_REQUIREMENTS_APPROVAL'],
  AWAIT_REQUIREMENTS_APPROVAL: ['SPECIFY', 'DESIGN'],
  DESIGN: ['AWAIT_DESIGN_APPROVAL'],
  AWAIT_DESIGN_APPROVAL: ['DESIGN', 'PLAN'],
  PLAN: ['BUILD'],
  BUILD: ['VERIFY'],
  VERIFY: ['BUILD', 'DELIVER'],
  DELIVER: ['VERIFY'],
}

export function assertTransition(from: BackendTeamPhase, to: BackendTeamPhase): void {
  if (!NEXT[from].includes(to)) {
    throw new Error(`illegal phase transition: ${from} -> ${to}`)
  }
}

export function phaseAwaitingApproval(gate: ApprovalGate): BackendTeamPhase {
  return gate === 'requirements' ? 'AWAIT_REQUIREMENTS_APPROVAL' : 'AWAIT_DESIGN_APPROVAL'
}

export function phaseAfterApproval(gate: ApprovalGate): BackendTeamPhase {
  return gate === 'requirements' ? 'DESIGN' : 'PLAN'
}

export function phaseForArtifactPath(path: string): ArtifactChangePhase | null {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  const file = normalized.split('/').at(-1)
  if (file === 'spec.md' || file === 'clarification.md') return 'SPECIFY'
  if (file === 'tasks.md') return 'PLAN'
  if (file === 'plan.md' || file === 'architecture.md' || file === 'data-model.md' || file === 'test-plan.md' || file === 'research.md' || file === 'decisions.md' || normalized === 'contracts/openapi.yaml' || normalized.endsWith('/contracts/openapi.yaml')) return 'DESIGN'
  return null
}
