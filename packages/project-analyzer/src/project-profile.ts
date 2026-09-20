import { WorkspaceLayoutSchema } from '@dsh-backend-team/contracts'
import type { WorkspaceLayout } from '@dsh-backend-team/contracts'
import { z } from 'zod'
import { ProjectEvidence } from './evidence.js'
import type { ProjectEvidence as ProjectEvidenceValue } from './evidence.js'

export const Confidence = z.enum(['high', 'medium', 'low'])
export type Confidence = z.infer<typeof Confidence>

export const ProjectKind = z.enum(['empty', 'node-service', 'non-node', 'monorepo', 'unknown'])
export type ProjectKind = z.infer<typeof ProjectKind>

export const DetectedValue = z.object({
  value: z.string().trim().min(1).max(96),
  confidence: Confidence,
  evidence: z.array(ProjectEvidence).min(1, 'detected value requires evidence'),
  conflicts: z.array(ProjectEvidence),
}).strict()
export type DetectedValue<T extends string> = Readonly<{
  value: T
  confidence: Confidence
  evidence: readonly ProjectEvidenceValue[]
  conflicts: readonly ProjectEvidenceValue[]
}>

const RelativeRoot = z.string().min(1).max(1024).refine(
  (value) => value === '.' || (!value.startsWith('/') && !value.includes('\\') && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')),
  'service boundary relative root must be workspace-relative',
)

export const ServiceBoundary = z.object({
  relativeRoot: RelativeRoot,
  confidence: Confidence,
  evidence: z.array(ProjectEvidence).min(1, 'service boundary requires evidence'),
}).strict()
export type ServiceBoundary = z.infer<typeof ServiceBoundary>

/** Runtime-only form; absoluteRoot is derived from WorkspaceLayout.root and never persisted as evidence. */
export interface ServiceBoundaryResolution {
  readonly relativeRoot: ServiceBoundary['relativeRoot']
  readonly absoluteRoot: string
  readonly workspace: WorkspaceLayout
}

/** Explicit contracts linkage for callers that provide a canonical workspace layout. */
export const ProjectAnalysisScopeSchema = z.object({ workspace: WorkspaceLayoutSchema }).strict()
export type ProjectAnalysisScope = z.infer<typeof ProjectAnalysisScopeSchema>

const NodeDeclaration = z.object({
  source: z.string().trim().min(1).max(128),
  range: z.string().trim().min(1).max(128),
  evidence: ProjectEvidence,
}).strict()
export type NodeDeclaration = z.infer<typeof NodeDeclaration>

type NodeVersion = readonly [number, number, number]

function parseNodeVersion(value: string): NodeVersion | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value.trim().replace(/^v(?=\d)/i, ''))
  if (!match) return undefined
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

function compareNodeVersions(left: NodeVersion, right: NodeVersion): number {
  for (const index of [0, 1, 2] as const) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function nextMajor(version: NodeVersion): NodeVersion {
  return [version[0] + 1, 0, 0]
}

function nextMinor(version: NodeVersion): NodeVersion {
  return [version[0], version[1] + 1, 0]
}

function rangeTokenAcceptsExactVersion(token: string, exact: NodeVersion): boolean {
  const comparison = /^(>=|>|<=|<)(\d+(?:\.\d+){0,2})$/.exec(token)
  if (comparison) {
    const comparedText = comparison[2]
    const compared = comparedText ? parseNodeVersion(comparedText) : undefined
    if (!compared) return false
    const order = compareNodeVersions(exact, compared)
    return (comparison[1] === '>=' && order >= 0)
      || (comparison[1] === '>' && order > 0)
      || (comparison[1] === '<=' && order <= 0)
      || (comparison[1] === '<' && order < 0)
  }

  const caret = /^\^(\d+(?:\.\d+){0,2})$/.exec(token)
  if (caret) {
    const lowerText = caret[1]
    const lower = lowerText ? parseNodeVersion(lowerText) : undefined
    if (!lower) return false
    const upper = lower[0] > 0 ? nextMajor(lower) : lower[1] > 0 ? [0, lower[1] + 1, 0] as NodeVersion : [0, 0, lower[2] + 1] as NodeVersion
    return compareNodeVersions(exact, lower) >= 0 && compareNodeVersions(exact, upper) < 0
  }

  const tilde = /^~(\d+(?:\.\d+){0,2})$/.exec(token)
  if (tilde) {
    const lowerText = tilde[1]
    const lower = lowerText ? parseNodeVersion(lowerText) : undefined
    if (!lower) return false
    return compareNodeVersions(exact, lower) >= 0 && compareNodeVersions(exact, nextMinor(lower)) < 0
  }

  const exactRange = parseNodeVersion(token)
  return exactRange !== undefined && compareNodeVersions(exact, exactRange) === 0
}

function declarationAcceptsExactVersion(range: string, exactVersion: string): boolean {
  const exact = parseNodeVersion(exactVersion)
  if (!exact) return false
  const alternatives = range.trim().split('||').map((alternative) => alternative.trim()).filter(Boolean)
  return alternatives.some((alternative) => {
    const tokens = alternative.split(/\s+/).filter(Boolean)
    return tokens.length > 0 && tokens.every((token) => rangeTokenAcceptsExactVersion(token, exact))
  })
}

export const DetectedNodeRuntime = z.object({
  declarations: z.array(NodeDeclaration),
  exactVersion: z.string().regex(/^\d+\.\d+\.\d+$/, 'selected Node version must be exact').optional(),
  selectionSource: z.string().trim().min(1).max(128).optional(),
  conflicts: z.array(ProjectEvidence),
  status: z.enum(['selected', 'needs-clarification', 'unsupported']),
}).strict().superRefine((runtime, context) => {
  if (runtime.status !== 'selected') {
    if (runtime.exactVersion) context.addIssue({ code: 'custom', path: ['exactVersion'], message: 'exactVersion is allowed only for a selected Node runtime' })
    if (runtime.selectionSource) context.addIssue({ code: 'custom', path: ['selectionSource'], message: 'selectionSource is allowed only for a selected Node runtime' })
    return
  }
  if (runtime.declarations.length === 0) {
    context.addIssue({ code: 'custom', path: ['declarations'], message: 'a selected Node runtime requires at least one declaration' })
    return
  }
  const exactVersion = runtime.exactVersion
  const selectionSource = runtime.selectionSource
  if (!exactVersion || !selectionSource) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'a selected Node runtime requires exactVersion and selectionSource' })
    return
  }
  const selectedDeclaration = runtime.declarations.find((declaration) => declaration.source === selectionSource)
  if (!selectedDeclaration) {
    context.addIssue({ code: 'custom', path: ['selectionSource'], message: 'selectionSource must identify a collected Node declaration' })
    return
  }
  if (runtime.conflicts.length > 0) {
    context.addIssue({ code: 'custom', path: ['conflicts'], message: 'a selected Node runtime cannot carry unresolved conflicts' })
  }
  const incompatibleDeclaration = runtime.declarations.find((declaration) => !declarationAcceptsExactVersion(declaration.range, exactVersion))
  if (incompatibleDeclaration) {
    context.addIssue({ code: 'custom', path: ['exactVersion'], message: `exactVersion must be compatible with every Node declaration, including ${incompatibleDeclaration.source}` })
  }
})
export type DetectedNodeRuntime = z.infer<typeof DetectedNodeRuntime>

export const BaselineIssue = z.object({
  code: z.string().trim().min(1).max(96),
  severity: z.enum(['info', 'warning', 'blocking']),
  message: z.string().trim().min(1).max(280),
  evidence: z.array(ProjectEvidence).min(1, 'baseline issue requires evidence'),
}).strict()
export type BaselineIssue = z.infer<typeof BaselineIssue>

const DetectedTechnology = DetectedValue.extend({
  category: z.enum(['framework', 'runtime', 'orm', 'database', 'workspace', 'language', 'other']),
}).strict()

const DatabaseRecommendation = z.object({
  target: z.enum(['preserve-existing', 'postgresql']),
  automation: z.enum(['automatic', 'requires-confirmation']),
}).strict()

export const ProjectProfileSchema = z.object({
  schemaVersion: z.literal(1),
  projectKind: ProjectKind,
  exists: z.boolean(),
  technologies: z.array(DetectedTechnology),
  nodeRuntime: DetectedNodeRuntime.nullable(),
  serviceBoundary: ServiceBoundary.nullable(),
  baselineIssues: z.array(BaselineIssue),
  databaseRecommendation: DatabaseRecommendation.nullable(),
}).strict().superRefine((profile, context) => {
  const hasExistingMysqlFact = profile.exists && profile.technologies.some(
    (technology) => technology.category === 'database' && technology.value.toLowerCase() === 'mysql',
  )
  const recommendsAutomaticPostgresql = profile.databaseRecommendation?.target === 'postgresql'
    && profile.databaseRecommendation.automation === 'automatic'

  if (hasExistingMysqlFact && recommendsAutomaticPostgresql) {
    context.addIssue({
      code: 'custom',
      path: ['databaseRecommendation'],
      message: 'an existing MySQL fact cannot receive an automatic PostgreSQL migration recommendation',
    })
  }
})

export type ProjectProfile = z.infer<typeof ProjectProfileSchema>
