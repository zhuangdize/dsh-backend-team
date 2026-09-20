import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DetectedNodeRuntime, ProjectAnalysisScopeSchema, ProjectEvidence, ProjectProfileSchema } from '../src/index.js'

const excerptHash = 'a'.repeat(64)
const manifestEvidence = {
  kind: 'manifest',
  path: 'package.json',
  fact: 'declares the detected dependency',
  excerptHash,
} as const

const selectedNodeRuntime = {
  declarations: [{ source: '.nvmrc', range: '24.19.0', evidence: { kind: 'config', path: '.nvmrc', fact: 'declares Node 24.19.0', excerptHash } }],
  exactVersion: '24.19.0',
  selectionSource: '.nvmrc',
  conflicts: [],
  status: 'selected',
} as const

describe('project profile schema', () => {
  it('accepts evidence-backed technology claims and an exact selected Node declaration', () => {
    const profile = ProjectProfileSchema.parse({
      schemaVersion: 1,
      projectKind: 'node-service',
      exists: true,
      technologies: [
        { value: 'nest', category: 'framework', confidence: 'high', evidence: [manifestEvidence], conflicts: [] },
        { value: 'postgresql', category: 'database', confidence: 'high', evidence: [manifestEvidence], conflicts: [] },
      ],
      nodeRuntime: selectedNodeRuntime,
      serviceBoundary: { relativeRoot: '.', confidence: 'high', evidence: [manifestEvidence] },
      baselineIssues: [],
      databaseRecommendation: { target: 'preserve-existing', automation: 'automatic' },
    })

    expect(profile.nodeRuntime?.exactVersion).toBe('24.19.0')
    expect(profile.technologies.map((technology) => technology.value)).toEqual(['nest', 'postgresql'])
  })

  it('requires a kind and excerpt hash for every evidence fact', () => {
    expect(ProjectEvidence.parse(manifestEvidence)).toMatchObject({ kind: 'manifest', excerptHash })
    expect(() => ProjectEvidence.parse({ path: 'package.json', fact: 'declares a dependency', sha256: excerptHash })).toThrow(/kind|excerptHash/i)
  })

  it('requires evidence for every detected technology', () => {
    expect(() => ProjectProfileSchema.parse({
      schemaVersion: 1,
      projectKind: 'node-service',
      exists: true,
      technologies: [{ value: 'express', category: 'framework', confidence: 'high', evidence: [], conflicts: [] }],
      nodeRuntime: null,
      serviceBoundary: null,
      baselineIssues: [],
      databaseRecommendation: null,
    })).toThrow(/evidence/i)
  })

  it('preserves conflicting Node declarations as requiring clarification', () => {
    const profile = ProjectProfileSchema.parse({
      schemaVersion: 1,
      projectKind: 'monorepo',
      exists: true,
      technologies: [],
      nodeRuntime: {
        declarations: [
          { source: 'package.json#engines.node', range: '>=24 <25', evidence: manifestEvidence },
          { source: 'services/api/package.json#engines.node', range: '>=20 <21', evidence: { kind: 'manifest', path: 'services/api/package.json', fact: 'declares Node 20 support', excerptHash } },
        ],
        conflicts: [{ kind: 'manifest', path: 'services/api/package.json', fact: 'conflicts with root Node declaration', excerptHash }],
        status: 'needs-clarification',
      },
      serviceBoundary: null,
      baselineIssues: [],
      databaseRecommendation: null,
    })

    expect(profile.nodeRuntime).toMatchObject({ status: 'needs-clarification', conflicts: [expect.objectContaining({ kind: 'manifest' })] })
  })

  it('rejects a selected Node runtime without a declaration or with an incompatible exact version', () => {
    expect(() => DetectedNodeRuntime.parse({
      declarations: [], exactVersion: '24.19.0', selectionSource: '.nvmrc', conflicts: [], status: 'selected',
    })).toThrow(/declaration/i)
    expect(() => DetectedNodeRuntime.parse({
      declarations: [{ source: '.nvmrc', range: '20.20.0', evidence: { kind: 'config', path: '.nvmrc', fact: 'declares Node 20.20.0', excerptHash } }],
      exactVersion: '24.19.0', selectionSource: '.nvmrc', conflicts: [], status: 'selected',
    })).toThrow(/compatible/i)
  })

  it.each(['needs-clarification', 'unsupported'] as const)('rejects selected Node fields when status is %s', (status) => {
    expect(() => DetectedNodeRuntime.parse({
      declarations: [], exactVersion: '24.19.0', selectionSource: '.nvmrc', conflicts: [], status,
    })).toThrow(/exactVersion|selectionSource/i)
  })

  it('rejects a selected Node runtime when a non-selected declaration is incompatible', () => {
    expect(() => DetectedNodeRuntime.parse({
      declarations: [
        { source: '.nvmrc', range: '24.19.0', evidence: { kind: 'config', path: '.nvmrc', fact: 'declares Node 24.19.0', excerptHash } },
        { source: 'package.json#engines.node', range: '20.20.0', evidence: manifestEvidence },
      ],
      exactVersion: '24.19.0', selectionSource: '.nvmrc', conflicts: [], status: 'selected',
    })).toThrow(/compatible/i)
  })

  it('rejects a selected Node runtime that carries recorded conflicts', () => {
    expect(() => DetectedNodeRuntime.parse({
      declarations: [{ source: '.nvmrc', range: '24.19.0', evidence: { kind: 'config', path: '.nvmrc', fact: 'declares Node 24.19.0', excerptHash } }],
      exactVersion: '24.19.0', selectionSource: '.nvmrc', conflicts: [manifestEvidence], status: 'selected',
    })).toThrow(/conflict/i)
  })

  it('accepts a selected Node runtime when every supported declaration is compatible', () => {
    expect(DetectedNodeRuntime.parse({
      declarations: [
        { source: '.nvmrc', range: '24.19.0', evidence: { kind: 'config', path: '.nvmrc', fact: 'declares Node 24.19.0', excerptHash } },
        { source: 'package.json#engines.node', range: '>=24 <25', evidence: manifestEvidence },
        { source: 'volta', range: '^24.18.0', evidence: { kind: 'config', path: 'package.json', fact: 'declares compatible Volta Node range', excerptHash } },
        { source: 'tool-versions', range: '~24.19.0', evidence: { kind: 'config', path: '.tool-versions', fact: 'declares compatible Node range', excerptHash } },
      ],
      exactVersion: '24.19.0', selectionSource: '.nvmrc', conflicts: [], status: 'selected',
    })).toMatchObject({ status: 'selected', exactVersion: '24.19.0' })
  })

  it('rejects absolute, directory, and traversing evidence paths', () => {
    for (const path of ['/package.json', '.', '../package.json']) {
      expect(() => ProjectEvidence.parse({ ...manifestEvidence, path })).toThrow(/relative|path/i)
    }
  })

  it('cannot recommend PostgreSQL migration for an existing MySQL project', () => {
    expect(() => ProjectProfileSchema.parse({
      schemaVersion: 1,
      projectKind: 'node-service',
      exists: true,
      technologies: [{ value: 'mysql', category: 'database', confidence: 'high', evidence: [manifestEvidence], conflicts: [] }],
      nodeRuntime: selectedNodeRuntime,
      serviceBoundary: null,
      baselineIssues: [],
      databaseRecommendation: { target: 'postgresql', automation: 'automatic' },
    })).toThrow(/MySQL|PostgreSQL|automatic/i)
  })

  it('links profile analysis to the contracts workspace layout without persisting absolute evidence paths', () => {
    const scope = ProjectAnalysisScopeSchema.parse({
      workspace: {
        root: '/work/app', teamDir: '/work/app/.backend-team', stateDir: '/work/app/.backend-team/state', runtimeDir: '/work/app/.backend-team/runtime', cacheDir: '/work/app/.backend-team/cache', logsDir: '/work/app/.backend-team/logs', locksDir: '/work/app/.backend-team/locks', handoffDir: '/work/app/.backend-team/handoff',
      },
    })

    expect(scope.workspace.root).toBe('/work/app')
    expect(() => ProjectEvidence.parse({ ...manifestEvidence, path: '/work/app/package.json' })).toThrow()
  })
})

describe('project fixtures', () => {
  it.each([
    ['nest-drizzle-postgres', ['@nestjs/platform-fastify', 'drizzle-orm', 'pg'], '24.19.0'],
    ['express-prisma-mysql', ['express', 'prisma', 'mysql2'], '20.20.0'],
  ])('contains the declared stack without URLs or secrets: %s', (fixture, dependencies, nodeVersion) => {
    const fixtureRoot = resolve(import.meta.dirname, '../../../tests/fixtures/projects', fixture)
    const manifest = readFileSync(resolve(fixtureRoot, 'package.json'), 'utf8')
    const nvmrc = readFileSync(resolve(fixtureRoot, '.nvmrc'), 'utf8').trim()

    for (const dependency of dependencies) expect(manifest).toContain(`\"${dependency}\"`)
    expect(nvmrc).toBe(nodeVersion)
    expect(manifest).not.toMatch(/https?:\/\/|password|secret|token/i)
  })

  it('includes safe lock, Prisma, non-Node, and nested workspace fixtures', () => {
    const fixturesRoot = resolve(import.meta.dirname, '../../../tests/fixtures/projects')
    const nestLock = readFileSync(resolve(fixturesRoot, 'nest-drizzle-postgres/package-lock.json'), 'utf8')
    const prismaSchema = readFileSync(resolve(fixturesRoot, 'express-prisma-mysql/prisma/schema.prisma'), 'utf8')
    const monorepoRoot = readFileSync(resolve(fixturesRoot, 'monorepo/package.json'), 'utf8')
    const apiManifest = readFileSync(resolve(fixturesRoot, 'monorepo/services/api/package.json'), 'utf8')
    const webManifest = readFileSync(resolve(fixturesRoot, 'monorepo/apps/web/package.json'), 'utf8')

    expect(nestLock).toContain('"lockfileVersion": 3')
    expect(nestLock).not.toMatch(/https?:\/\//)
    expect(prismaSchema).toContain('provider = "mysql"')
    expect(monorepoRoot).toContain('"services/*"')
    expect(apiManifest).toContain('"node": ">=20 <21"')
    expect(webManifest).toContain('"node": ">=24 <25"')
    for (const content of [nestLock, prismaSchema, monorepoRoot, apiManifest, webManifest]) {
      expect(content).not.toMatch(/https?:\/\/|password|secret|token/i)
    }
    expect(readFileSync(resolve(fixturesRoot, 'non-node/go.mod'), 'utf8')).toContain('module example.local/non-node')
  })
})
