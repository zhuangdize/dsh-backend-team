import type { PlannedTask } from './vertical-slice.js'

export interface RequirementTraceEntry {
  readonly sliceIds: readonly string[]
  readonly taskIds: readonly string[]
  readonly evidenceIds: readonly string[]
}

export interface RequirementTrace {
  readonly requirements: Readonly<Record<string, RequirementTraceEntry>>
}

export function buildRequirementTrace(tasks: readonly Pick<PlannedTask, 'id' | 'sliceId' | 'requirementIds' | 'evidence'>[], requirementIds: readonly string[]): RequirementTrace {
  const result: Record<string, RequirementTraceEntry> = {}
  for (const requirementId of requirementIds) {
    const matching = tasks.filter((task) => task.requirementIds.includes(requirementId))
    const evidence = matching.flatMap((task) => task.evidence)
    if (evidence.length === 0) throw new Error(`${requirementId} has no evidence task`)
    result[requirementId] = Object.freeze({
      sliceIds: unique(matching.map((task) => task.sliceId)),
      taskIds: unique(matching.map((task) => task.id)),
      evidenceIds: unique(evidence),
    })
  }
  return Object.freeze({ requirements: Object.freeze(result) })
}

function unique(values: readonly string[]): readonly string[] { return [...new Set(values)] }
