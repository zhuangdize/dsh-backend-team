import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { HarnessStructuralContext } from './structural-context.js'
import { HARNESS_CAPABILITIES, inspectStructuralContext } from './structural-context.js'
import type { HarnessCapability } from './structural-context.js'
import { trustedCompatibilityDocumentUrl } from './compatibility-locator.js'

const SemverSchema = z.string().regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  'must be an exact semantic version',
).refine((value) => {
  const prerelease = value.split('+', 1)[0]?.split('-', 2)[1]
  return !prerelease || prerelease.split('.').every((part) => !/^\d+$/.test(part) || !/^0\d/.test(part))
}, 'numeric prerelease identifiers cannot contain leading zeroes')
const NodeRangeSchema = z.string().regex(/^>=\d+ <\d+$/, 'must use an exact major Node range')
const CapabilitySchema = z.enum(HARNESS_CAPABILITIES)
const VerificationPlanSchema = z.object({ commands: z.array(z.string().min(1)).min(1) }).strict()
const EvidenceSchema = z.object({
  commands: z.array(z.string().min(1)).min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const EntryBaseSchema = z.object({
  version: SemverSchema,
  expectedCapabilities: z.array(CapabilitySchema).min(1),
  nodeRange: NodeRangeSchema,
  verificationPlan: VerificationPlanSchema,
}).strict().superRefine((entry, issue) => {
  if (new Set(entry.expectedCapabilities).size !== entry.expectedCapabilities.length) {
    issue.addIssue({ code: 'custom', path: ['expectedCapabilities'], message: 'capabilities must be unique' })
  }
  const [minimumText, maximumText] = entry.nodeRange.slice(2).split(' <')
  const minimum = Number(minimumText)
  const maximum = Number(maximumText)
  if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || maximum !== minimum + 1) {
    issue.addIssue({ code: 'custom', path: ['nodeRange'], message: 'Node range must cover one major version' })
  }
  if (entry.expectedCapabilities.length !== HARNESS_CAPABILITIES.length || HARNESS_CAPABILITIES.some((capability) => !entry.expectedCapabilities.includes(capability))) {
    issue.addIssue({ code: 'custom', path: ['expectedCapabilities'], message: 'all public Harness capabilities are required' })
  }
})

const PendingEntrySchema = EntryBaseSchema.extend({
  status: z.literal('pending-real-smoke'),
}).strict()
const VerifiedEntrySchema = EntryBaseSchema.extend({
  status: z.literal('verified'),
  verifiedAt: z.string().datetime().refine((value) => new Date(value).toISOString() === value, 'timestamp must be canonical UTC RFC3339'),
  evidence: EvidenceSchema,
}).strict().superRefine((entry, issue) => {
  if (JSON.stringify(entry.evidence.commands) !== JSON.stringify(entry.verificationPlan.commands)) {
    issue.addIssue({ code: 'custom', path: ['evidence', 'commands'], message: 'evidence commands must exactly match verification plan' })
  }
})
const EntrySchema = z.discriminatedUnion('status', [PendingEntrySchema, VerifiedEntrySchema])
export const HarnessCompatibilityMatrixSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(EntrySchema).min(1),
}).strict().superRefine((matrix, issue) => {
  const versions = matrix.entries.map((entry) => entry.version)
  if (new Set(versions).size !== versions.length) issue.addIssue({ code: 'custom', path: ['entries'], message: 'versions must be unique' })
})

export type HarnessCompatibilityEntry = z.infer<typeof EntrySchema>
export type HarnessCompatibilityMatrix = Readonly<{
  schemaVersion: 1
  entries: readonly HarnessCompatibilityEntry[]
}>

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function compareVersions(left: string, right: string): number {
  const parse = (version: string) => version.split(/[.+-]/, 4).slice(0, 3).map(Number)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0)
  }
  return left.localeCompare(right)
}

/** Internal parser used by tests and the build/runtime trust boundary. */
export function parseCompatibilityMatrix(input: unknown): HarnessCompatibilityMatrix {
  const parsed = HarnessCompatibilityMatrixSchema.parse(input)
  const entries = [...parsed.entries].sort((left, right) => compareVersions(left.version, right.version))
  return deepFreeze({ schemaVersion: parsed.schemaVersion, entries })
}

export function loadTrustedCompatibilityMatrix(): HarnessCompatibilityMatrix {
  const documentUrl = trustedCompatibilityDocumentUrl()
  return parseCompatibilityMatrix(JSON.parse(readFileSync(documentUrl, 'utf8')) as unknown)
}

export type CompatibilityMode = 'supported' | 'read-only'
export interface HarnessCapabilityReport {
  readonly version: string
  readonly mode: CompatibilityMode
  readonly entryStatus: HarnessCompatibilityEntry['status'] | 'unknown'
  readonly nodeVersion: string
  readonly reasons: readonly string[]
  readonly missingCapabilities: readonly HarnessCapability[]
}

function nodeSatisfies(version: string, range: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  const rangeMatch = /^>=(\d+) <(\d+)$/.exec(range)
  if (!match || !rangeMatch) return false
  const major = Number(match[1])
  return major >= Number(rangeMatch[1]) && major < Number(rangeMatch[2])
}

function evaluateCompatibility(version: string, matrix: HarnessCompatibilityMatrix | undefined, context?: HarnessStructuralContext): HarnessCapabilityReport {
  const nodeVersion = process.versions.node
  const reasons: string[] = []
  const structural = context ? inspectStructuralContext(context) : undefined
  const entry = matrix?.entries.find((candidate) => candidate.version === version)
  if (!matrix) reasons.push('trusted compatibility matrix failed strict validation')
  if (!entry) reasons.push('runtime version is not present in the exact compatibility matrix')
  if (entry?.status !== 'verified') reasons.push(entry ? `runtime version status is ${entry.status}` : 'runtime version is unknown')
  if (entry && !nodeSatisfies(nodeVersion, entry.nodeRange)) reasons.push(`Node.js ${nodeVersion} is outside tested range ${entry.nodeRange}`)
  const missingCapabilities = structural ? [...structural.missingCapabilities] : [...HARNESS_CAPABILITIES]
  if (structural) {
    reasons.push(...structural.reasons)
    if (entry) {
      for (const capability of entry.expectedCapabilities) {
        if (!structural.availableCapabilities.includes(capability) && !missingCapabilities.includes(capability)) missingCapabilities.push(capability)
      }
    }
  }
  if (entry && structural) {
    for (const capability of entry.expectedCapabilities) if (missingCapabilities.includes(capability) && !reasons.some((reason) => reason.includes(capability))) reasons.push(`required capability ${capability} is unavailable`)
  }
  return Object.freeze({
    version,
    mode: reasons.length === 0 ? 'supported' : 'read-only',
    entryStatus: entry?.status ?? 'unknown',
    nodeVersion,
    reasons: Object.freeze(reasons),
    missingCapabilities: Object.freeze(missingCapabilities),
  })
}

/** Public diagnostic assessment. Runtime version is unavailable from the official rc.6 Context. */
export function assessHarnessCompatibility(context?: HarnessStructuralContext): HarnessCapabilityReport {
  let matrix: HarnessCompatibilityMatrix | undefined
  try {
    matrix = loadTrustedCompatibilityMatrix()
  } catch {
    matrix = undefined
  }
  return evaluateCompatibility('unknown', matrix, context)
}
