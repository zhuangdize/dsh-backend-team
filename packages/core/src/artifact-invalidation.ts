import type { ApprovalKind, BackendTeamPhase, BackendTeamState, RunRecord } from '@dsh-backend-team/contracts'
import { phaseForArtifactPath, type ArtifactChangePhase } from './state-machine.js'

const PHASE_ORDER: readonly BackendTeamPhase[] = [
  'DISCOVER',
  'SPECIFY',
  'AWAIT_REQUIREMENTS_APPROVAL',
  'DESIGN',
  'AWAIT_DESIGN_APPROVAL',
  'PLAN',
  'BUILD',
  'VERIFY',
  'DELIVER',
]

const DOWNSTREAM_RUN_KINDS: Readonly<Record<ArtifactChangePhase, readonly string[]>> = {
  SPECIFY: ['design', 'plan', 'build', 'verify'],
  DESIGN: ['plan', 'build', 'verify'],
  PLAN: ['plan', 'build', 'verify'],
}

export function invalidateChangedArtifacts(
  state: BackendTeamState,
  changedPaths: readonly string[],
): BackendTeamState {
  const affected = changedPaths
    .map(phaseForArtifactPath)
    .filter((phase): phase is ArtifactChangePhase => phase !== null)
  if (affected.length === 0) return state

  const earliest = affected.reduce((left, right) => phaseOrder(right) < phaseOrder(left) ? right : left)
  const target = phaseForInvalidation(earliest)
  const approvals = removeInvalidApprovals(state.approvals, earliest)
  const runs = removeInvalidRuns(state.runs, earliest)
  const phase = phaseOrder(state.phase) > phaseOrder(target) ? target : state.phase

  if (phase === state.phase && sameArray(approvals, state.approvals) && sameArray(runs, state.runs)) return state
  return { ...state, phase, approvals, runs }
}

function phaseForInvalidation(affected: ArtifactChangePhase): BackendTeamPhase {
  return affected
}

function removeInvalidApprovals(
  approvals: BackendTeamState['approvals'],
  affected: ArtifactChangePhase,
): BackendTeamState['approvals'] {
  const invalidKinds: readonly ApprovalKind[] = affected === 'SPECIFY'
    ? ['requirements', 'design']
    : affected === 'DESIGN'
      ? ['design']
      : []
  if (invalidKinds.length === 0) return approvals
  return approvals.filter((approval) => !invalidKinds.includes(approval.kind))
}

function removeInvalidRuns(
  runs: BackendTeamState['runs'],
  affected: ArtifactChangePhase,
): BackendTeamState['runs'] {
  const downstream = DOWNSTREAM_RUN_KINDS[affected]
  return runs.filter((run) => {
    const kind = (run as RunRecord & { readonly kind?: unknown }).kind
    if (typeof kind === 'string') return !downstream.includes(kind)
    // The v1 shared RunRecord has no stage discriminator. Without one, retain
    // no run whose provenance cannot be proved to precede this edit.
    return affected === 'SPECIFY' ? false : false
  })
}

function phaseOrder(phase: BackendTeamPhase): number {
  const index = PHASE_ORDER.indexOf(phase)
  if (index < 0) throw new Error(`unknown backend team phase: ${phase}`)
  return index
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
