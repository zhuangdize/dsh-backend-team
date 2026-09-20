export type SliceLayer = 'contract' | 'domain' | 'persistence' | 'test'

export interface PlannedTask {
  readonly id: string
  readonly sliceId: string
  readonly requirementIds: readonly string[]
  readonly owner: string
  readonly risk: string
  readonly dependencies: readonly string[]
  readonly layer: SliceLayer
  readonly evidence: readonly string[]
  readonly files: readonly string[]
  readonly objective: string
}

export interface VerticalSlice {
  readonly id: string
  readonly taskIds: readonly string[]
  readonly layers: readonly SliceLayer[]
  readonly requirementIds: readonly string[]
  readonly inputs: Readonly<Record<string, string>>
  readonly expectedPaths: readonly string[]
  readonly apiOperations: readonly string[]
  readonly dataChanges: readonly string[]
  readonly testEvidence: readonly string[]
  readonly dependencies: readonly string[]
  readonly rollbackBoundary: string
  readonly completionConditions: readonly string[]
}

export interface DevelopmentPlan {
  /** Verified document locations relative to the workspace; hash keys remain feature-relative. */
  readonly artifactReadPaths?: readonly string[]
  readonly slices: readonly VerticalSlice[]
  readonly tasks: readonly PlannedTask[]
  readonly trace: RequirementTrace
  readonly artifactHashes: Readonly<Record<string, string>>
  readonly requirements: readonly string[]
}
import type { RequirementTrace } from './requirement-trace.js'
