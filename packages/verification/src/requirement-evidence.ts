import type { CommandCapture } from './verification-command.js'
import type { ResultComparison } from './result-comparator.js'

export interface RequirementTraceEntry { readonly sliceIds: readonly string[]; readonly taskIds: readonly string[]; readonly evidenceIds: readonly string[] }
export interface RequirementTrace { readonly requirements: Readonly<Record<string, RequirementTraceEntry>> }

export type RequirementStatus = 'passed' | 'failed' | 'not-run' | 'blocked'

export interface RequirementEvidence {
  readonly requirementId: string
  readonly status: RequirementStatus
  readonly evidenceIds: readonly string[]
  readonly missingEvidenceIds: readonly string[]
  readonly commandIds: readonly string[]
  readonly relatedSlices: readonly string[]
  readonly expected: string
  readonly actual: string
  readonly baseline: 'new-failure' | 'historical-failure' | 'clean' | 'not-run'
}

/** Maps each acceptance criterion to command evidence without treating missing evidence as success. */
export function buildRequirementEvidence(trace: RequirementTrace, captures: readonly CommandCapture[], comparison: ResultComparison): Readonly<Record<string, RequirementEvidence>> {
  const newFailureIds = new Set(comparison.newFailures.map((capture) => capture.id))
  const historicalFailureIds = new Set(comparison.unchangedFailures.map((capture) => capture.id))
  const result: Record<string, RequirementEvidence> = {}
  for (const [requirementId, entry] of Object.entries(trace.requirements)) {
    const requiredEvidence = [...entry.evidenceIds]
    const related = captures.filter((capture) => requiredEvidence.some((evidenceId) => capture.id === evidenceId || capture.evidenceIds.includes(evidenceId)))
    const missingEvidenceIds = requiredEvidence.filter(evidenceId => !related.some(capture => capture.id === evidenceId || capture.evidenceIds.includes(evidenceId)))
    const statuses = related.map((capture) => capture.status)
    const status: RequirementStatus = related.length === 0
      ? 'not-run'
      : statuses.some((value) => value === 'blocked' || value === 'interrupted') ? 'blocked'
        : statuses.some((value) => value === 'failed') || related.some((capture) => newFailureIds.has(capture.id)) ? 'failed'
          : missingEvidenceIds.length === 0 && statuses.every((value) => value === 'passed') ? 'passed' : 'not-run'
    const baseline = related.length === 0 ? 'not-run' : related.some((capture) => newFailureIds.has(capture.id)) ? 'new-failure' : related.some((capture) => historicalFailureIds.has(capture.id)) ? 'historical-failure' : 'clean'
    result[requirementId] = Object.freeze({ requirementId, status, evidenceIds: requiredEvidence, missingEvidenceIds, commandIds: related.map((capture) => capture.id), relatedSlices: [...entry.sliceIds], expected: requiredEvidence.length > 0 ? `evidence required: ${requiredEvidence.join(', ')}` : 'evidence required', actual: related.length === 0 ? 'no matching verification command ran' : related.map((capture) => `${capture.id}:${capture.status}`).join(', '), baseline })
  }
  return Object.freeze(result)
}

export function allRequirementsPassed(requirements: Readonly<Record<string, RequirementEvidence>>): boolean {
  const values = Object.values(requirements)
  return values.length > 0 && values.every((requirement) => requirement.status === 'passed')
}

export function hasBlockedRequirement(requirements: Readonly<Record<string, RequirementEvidence>>): boolean {
  return Object.values(requirements).some((requirement) => requirement.status === 'blocked')
}
