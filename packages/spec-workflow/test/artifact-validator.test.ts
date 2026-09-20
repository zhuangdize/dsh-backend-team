import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactRegistry } from '../src/artifact-registry.js'
import { ArtifactValidator } from '../src/artifact-validator.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('feature artifact validator', () => {
  it('requires behavioral acceptance criteria before requirements approval', async () => {
    const { root, feature } = await fixture()
    await writeFile(join(feature, 'spec.md'), '# Feature\n\n## User Scenarios\n')
    const result = await new ArtifactValidator(new ArtifactRegistry(root)).validateForGate('requirements')
    expect(result.errors.map((error) => error.code)).toContain('MISSING_ACCEPTANCE_CRITERIA')
  })

  it('requires concrete extension artifacts before design approval', async () => {
    const { root, feature } = await fixture()
    await writeRequirements(feature)
    const result = await new ArtifactValidator(new ArtifactRegistry(root)).validateForGate('design')
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['MISSING_ARCHITECTURE', 'MISSING_DATA_MODEL', 'MISSING_OPENAPI', 'MISSING_TEST_PLAN']))
  })

  it('accepts complete requirements and design artifacts with a non-empty OpenAPI 3.1 contract', async () => {
    const { root, feature } = await fixture()
    await writeRequirements(feature)
    await writeFile(join(feature, 'plan.md'), '# Plan\n\n## Implementation Plan\nDescribe modules and migrations.\n')
    await writeFile(join(feature, 'architecture.md'), concreteArchitecture())
    await writeFile(join(feature, 'data-model.md'), concreteDataModel())
    await writeFile(join(feature, 'test-plan.md'), concreteTestPlan())
    await writeFile(join(feature, 'decisions.md'), '# Decisions\n\n## Decision 1\nUse PostgreSQL and a versioned migration.\n')
    await writeFile(join(feature, 'contracts/openapi.yaml'), 'openapi: 3.1.0\ninfo:\n  title: Orders API\n  version: 1.0.0\npaths:\n  /orders:\n    get:\n      responses:\n        "200":\n          description: List orders\n')

    const result = await new ArtifactValidator(new ArtifactRegistry(root)).validateForGate('design')
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('rejects an empty or non-3.1 OpenAPI contract with file and heading context', async () => {
    const { root, feature } = await fixture()
    await writeRequirements(feature)
    await writeFile(join(feature, 'plan.md'), '# Plan\n## Implementation Plan\nDetails\n')
    await writeFile(join(feature, 'architecture.md'), concreteArchitecture())
    await writeFile(join(feature, 'data-model.md'), concreteDataModel())
    await writeFile(join(feature, 'test-plan.md'), concreteTestPlan())
    await writeFile(join(feature, 'decisions.md'), '# Decisions\n## Decision 1\nA choice.\n')
    await writeFile(join(feature, 'contracts/openapi.yaml'), 'openapi: 3.0.3\ninfo:\n  title: Wrong\npaths: {}\n')

    const result = await new ArtifactValidator(new ArtifactRegistry(root)).validateForGate('design')
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'INVALID_OPENAPI', file: 'contracts/openapi.yaml', heading: 'openapi' })]))
  })
})

async function fixture(): Promise<{ root: string; feature: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifact-validator-'))
  roots.push(root)
  const feature = join(root, 'specs/001-orders')
  await mkdir(join(root, '.specify'), { recursive: true })
  await mkdir(join(feature, 'contracts'), { recursive: true })
  await writeFile(join(root, '.specify/feature.json'), JSON.stringify({ feature_directory: 'specs/001-orders' }))
  return { root, feature }
}

async function writeRequirements(feature: string): Promise<void> {
  await writeFile(join(feature, 'spec.md'), `# Orders\n\n## Actors\nCustomer and operator.\n## Flows\nCreate and list orders.\n## Rules\nOnly valid transitions.\n## Permissions\nCustomers see their own orders.\n## Data and Privacy\nOrder data is private.\n## Integrations\nPayment provider.\n## Non-Functional Requirements\nP95 under 300ms.\n## Non-Goals\nNo fulfillment service.\n## Acceptance Criteria\n1. Given a customer, when they create an order, then it is persisted.\n`)
  await writeFile(join(feature, 'clarification.md'), '# Clarification\n\n## Open Questions\nNone.\n')
}

function concreteArchitecture(): string { return '# Architecture\n## Context\nContext.\n## Module Boundaries\nModules.\n## Request Flow\nFlow.\n## API and Authentication\nAuth.\n## Failure Model\nFailures.\n## Observability\nMetrics.\n## Alternatives\nAlternative.\n## Risks\nRisk.\n' }
function concreteDataModel(): string { return '# Data Model\n## Table Purpose\nPurpose.\n## Fields and Types\n### person\nFields.\n## Keys and Constraints\nKeys.\n## Indexes\nIndexes.\n## Relationships\nRelations.\n## Lifecycle\nLifecycle.\n## Sensitive Data\nPrivacy.\n## Migration Notes\nMigrations.\n' }
function concreteTestPlan(): string { return '# Test Plan\n## Requirement ID\nREQ-1\n## Evidence Type\nIntegration\n## Command or Scenario\n### smoke\nnpm test\n## Expected Result\nPass\n## Status\nPlanned\n' }
