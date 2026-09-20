import { readFile } from 'node:fs/promises'
import type { FeatureArtifact, FeatureArtifacts } from './artifact-registry.js'
import { ArtifactRegistry } from './artifact-registry.js'

export type ArtifactGate = 'requirements' | 'design'
export type ArtifactValidationErrorCode =
  | 'FEATURE_DIRECTORY_INVALID' | 'MISSING_SPEC' | 'MISSING_CLARIFICATION' | 'MISSING_ACCEPTANCE_CRITERIA'
  | 'MISSING_PLAN' | 'MISSING_ARCHITECTURE' | 'MISSING_DATA_MODEL' | 'MISSING_OPENAPI'
  | 'MISSING_TEST_PLAN' | 'MISSING_DECISIONS' | 'MISSING_REQUIREMENT_SECTION'
  | 'EMPTY_ARTIFACT' | 'INVALID_OPENAPI'

export interface ArtifactValidationError {
  readonly code: ArtifactValidationErrorCode
  readonly file: string
  readonly heading: string
  readonly message: string
}

export interface ArtifactValidationResult {
  readonly gate: ArtifactGate
  readonly featureDirectory?: string
  readonly artifacts: readonly FeatureArtifact[]
  readonly errors: readonly ArtifactValidationError[]
  readonly valid: boolean
}

const requirementSections = Object.freeze([
  ['actors', 'Actors'], ['flows', 'Flows'], ['rules', 'Rules'], ['permissions', 'Permissions'],
  ['data and privacy', 'Data and Privacy'], ['integrations', 'Integrations'],
  ['non-functional requirements', 'Non-Functional Requirements'], ['non-goals', 'Non-Goals'],
] as const)
const designSections = Object.freeze([
  ['architecture.md', Object.freeze([['context', 'Context'], ['module boundaries', 'Module Boundaries'], ['request flow', 'Request Flow'], ['api and authentication', 'API and Authentication'], ['failure model', 'Failure Model'], ['observability', 'Observability'], ['alternatives', 'Alternatives'], ['risks', 'Risks']])],
  ['data-model.md', Object.freeze([['table purpose', 'Table Purpose'], ['fields and types', 'Fields and Types'], ['keys and constraints', 'Keys and Constraints'], ['indexes', 'Indexes'], ['relationships', 'Relationships'], ['lifecycle', 'Lifecycle'], ['sensitive data', 'Sensitive Data'], ['migration notes', 'Migration Notes']])],
  ['test-plan.md', Object.freeze([['requirement id', 'Requirement ID'], ['evidence type', 'Evidence Type'], ['command or scenario', 'Command or Scenario'], ['expected result', 'Expected Result'], ['status', 'Status']])],
] as const)

/** Performs the semantic checks needed before requirements and design approvals. */
export class ArtifactValidator {
  constructor(private readonly registry: ArtifactRegistry) {}

  async validateForGate(gate: ArtifactGate): Promise<ArtifactValidationResult> {
    let snapshot: FeatureArtifacts
    try { snapshot = await this.registry.snapshot() } catch (error: unknown) {
      return Object.freeze({ gate, artifacts: Object.freeze([]), errors: Object.freeze([errorResult('FEATURE_DIRECTORY_INVALID', '.specify/feature.json', 'feature directory', error instanceof Error ? error.message : String(error))]), valid: false })
    }
    const errors: ArtifactValidationError[] = []
    const files = new Map(snapshot.artifacts.map((artifact) => [artifact.path, artifact]))
    const text = async (path: string): Promise<string | undefined> => {
      const artifact = files.get(path)
      if (artifact === undefined) return undefined
      try { return await readFile(artifact.absolutePath, 'utf8') } catch (error: unknown) { errors.push(errorResult('EMPTY_ARTIFACT', path, path, error instanceof Error ? error.message : String(error))); return undefined }
    }
    const spec = await text('spec.md')
    if (spec === undefined) errors.push(errorResult('MISSING_SPEC', 'spec.md', 'specification', 'spec.md is required'))
    const clarification = await text('clarification.md')
    if (clarification === undefined) errors.push(errorResult('MISSING_CLARIFICATION', 'clarification.md', 'clarification', 'clarification.md is required'))
    if (spec !== undefined) {
      for (const [needle, heading] of requirementSections) if (!hasSection(spec, needle)) errors.push(errorResult('MISSING_REQUIREMENT_SECTION', 'spec.md', heading, `spec.md must contain a non-empty ${heading} section`))
      if (!hasSection(spec, 'acceptance criteria') || !/\n\s*\d+[.)]\s+\S+/u.test(spec)) errors.push(errorResult('MISSING_ACCEPTANCE_CRITERIA', 'spec.md', 'Acceptance Criteria', 'spec.md must contain numbered behavioral acceptance criteria'))
    }
    if (gate === 'design') {
      await requireText(text, files, 'plan.md', 'MISSING_PLAN', errors)
      for (const [path, sections] of designSections) {
        const content = await text(path)
        if (content === undefined) {
          errors.push(errorResult(path === 'architecture.md' ? 'MISSING_ARCHITECTURE' : path === 'data-model.md' ? 'MISSING_DATA_MODEL' : 'MISSING_TEST_PLAN', path, path, `${path} is required`))
        } else {
          for (const [needle, heading] of sections) {
            const sectionNeedle = String(needle)
            const sectionHeading = String(heading)
            if (!hasSection(content, sectionNeedle)) errors.push(errorResult('EMPTY_ARTIFACT', path, sectionHeading, `${path} must contain a non-empty ${sectionHeading} section`))
          }
        }
      }
      const decisions = await text('decisions.md')
      if (decisions === undefined) errors.push(errorResult('MISSING_DECISIONS', 'decisions.md', 'decisions', 'decisions.md is required'))
      const openapi = await text('contracts/openapi.yaml')
      if (openapi === undefined) errors.push(errorResult('MISSING_OPENAPI', 'contracts/openapi.yaml', 'openapi', 'contracts/openapi.yaml is required'))
      else if (!validOpenApi(openapi)) errors.push(errorResult('INVALID_OPENAPI', 'contracts/openapi.yaml', 'openapi', 'contracts/openapi.yaml must be a non-empty OpenAPI 3.1 YAML contract with info and paths'))
    }
    return Object.freeze({ gate, featureDirectory: snapshot.featureDirectory, artifacts: snapshot.artifacts, errors: Object.freeze(errors), valid: errors.length === 0 })
  }
}

async function requireText(text: (path: string) => Promise<string | undefined>, files: ReadonlyMap<string, FeatureArtifact>, path: string, code: ArtifactValidationErrorCode, errors: ArtifactValidationError[]): Promise<void> {
  if ((await text(path)) === undefined && !files.has(path)) errors.push(errorResult(code, path, path, `${path} is required`))
}

function hasSection(content: string, wanted: string): boolean {
  const heading = new RegExp(`^#{1,6}\\s+${escapeRegExp(wanted)}\\s*$`, 'imu')
  const match = heading.exec(content)
  if (match === null || match.index === undefined) return false
  const remainder = content.slice(match.index + match[0].length)
  const level = match[0].match(/^#+/u)?.[0].length
  if (level === undefined) return false
  const next = remainder.search(new RegExp(`^#{1,${level}}\\s+`, 'mu'))
  return remainder.slice(0, next === -1 ? undefined : next).trim().length > 0
}

function validOpenApi(content: string): boolean {
  if (content.trim().length === 0 || /^\s*[{}[\]]/u.test(content)) return false
  if (!/^openapi:\s*3\.1(?:\.\d+)?\s*$/mu.test(content)) return false
  if (!/^info:\s*$/mu.test(content) || !/^\s+title:\s*\S+/mu.test(content) || !/^\s+version:\s*\S+/mu.test(content)) return false
  if (!/^paths:\s*$/mu.test(content) || !/^\s{2,}\/[^\s:]+:\s*$/mu.test(content)) return false
  return !/^paths:\s*\{\s*\}\s*$/mu.test(content)
}

function errorResult(code: ArtifactValidationErrorCode, file: string, heading: string, message: string): ArtifactValidationError { return Object.freeze({ code, file, heading, message }) }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }
