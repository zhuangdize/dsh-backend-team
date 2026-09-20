import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ManifestReader, ServiceBoundaryResolver, createDetectorContext } from '../src/index.js'
import type { PackageManifest } from '../src/index.js'

const fixturesRoot = resolve(import.meta.dirname, '../../../tests/fixtures/projects')

function layout(root: string) {
  return {
    root,
    teamDir: resolve(root, '.backend-team'),
    stateDir: resolve(root, '.backend-team/state'),
    runtimeDir: resolve(root, '.backend-team/runtime'),
    cacheDir: resolve(root, '.backend-team/cache'),
    logsDir: resolve(root, '.backend-team/logs'),
    locksDir: resolve(root, '.backend-team/locks'),
    handoffDir: resolve(root, '.backend-team/handoff'),
  }
}

function resolver(manifests: ReadonlyMap<string, PackageManifest>, root = fixturesRoot, textFiles: ReadonlyMap<string, string> = new Map()) {
  return new ServiceBoundaryResolver({
    workspace: layout(root),
    context: createDetectorContext({ paths: [...manifests.keys(), ...textFiles.keys()], manifests, textFiles }),
  })
}

function monorepoResolver() {
  const root = resolve(fixturesRoot, 'monorepo')
  const reader = new ManifestReader(root)
  const manifests = new Map<string, PackageManifest>()
  for (const path of ['package.json', 'services/api/package.json', 'apps/web/package.json']) {
    const result = reader.readPackage(path)
    if (!result.ok) throw new Error(result.error.message)
    manifests.set(path, result.manifest)
  }
  return resolver(manifests, root)
}

describe('ServiceBoundaryResolver', () => {
  it('uses the root boundary for a root-only API', async () => {
    const decision = await resolver(new Map([['package.json', {
      dependencies: { express: '5.1.0' }, scripts: { start: 'node server.js' },
    }]])).resolve()

    expect(decision).toMatchObject({ status: 'selected', boundary: { relativeRoot: '.' } })
    if (decision.status === 'selected') expect(decision.boundary.evidence.every((item) => !item.path.startsWith('/'))).toBe(true)
  })

  it('uses bounded root source evidence when no dependency declaration exists', async () => {
    const decision = await resolver(
      new Map([['package.json', {}]]),
      fixturesRoot,
      new Map([['src/main.ts', "import { NestFactory } from '@nestjs/core'"]]),
    ).resolve()

    expect(decision).toMatchObject({ status: 'selected', boundary: { relativeRoot: '.', evidence: [expect.objectContaining({ kind: 'import', path: 'src/main.ts' })] } })
  })

  it('selects the only backend service in a mixed monorepo', async () => {
    const decision = await monorepoResolver().resolve()

    expect(decision).toMatchObject({ status: 'selected', boundary: { relativeRoot: 'services/api' } })
  })

  it('returns needs-user-selection for two equally plausible APIs without lexical tie breaking', async () => {
    const decision = await resolver(new Map([
      ['package.json', { workspaces: ['services/*'] }],
      ['services/api-a/package.json', { dependencies: { express: '5.1.0' }, scripts: { start: 'node server.js' } }],
      ['services/api-b/package.json', { dependencies: { fastify: '5.5.0' }, scripts: { start: 'node server.js' } }],
    ])).resolve()

    expect(decision.status).toBe('needs-user-selection')
    if (decision.status === 'needs-user-selection') expect(decision.candidates.map((candidate) => candidate.relativeRoot)).toEqual(['services/api-a', 'services/api-b'])
  })

  it('returns needs-user-selection when backend candidates differ by fewer than 20 points', async () => {
    const decision = await resolver(new Map([
      ['package.json', { workspaces: ['services/*'] }],
      ['services/api-a/package.json', { dependencies: { express: '5.1.0', mysql2: '3.14.3' }, scripts: { start: 'node server.js' } }],
      ['services/api-b/package.json', { dependencies: { fastify: '5.5.0' }, scripts: { start: 'node server.js' } }],
    ])).resolve()

    expect(decision.status).toBe('needs-user-selection')
  })

  it('honors an explicit manifest-backed backend path', async () => {
    const boundaryResolver = resolver(new Map([
      ['package.json', { workspaces: ['services/*'] }],
      ['services/api-a/package.json', { dependencies: { express: '5.1.0' }, scripts: { start: 'node server.js' } }],
      ['services/api-b/package.json', { dependencies: { fastify: '5.5.0' }, scripts: { start: 'node server.js' } }],
    ]))

    await expect(boundaryResolver.resolve('services/api-b')).resolves.toMatchObject({ status: 'selected', boundary: { relativeRoot: 'services/api-b' } })
  })

  it.each(['/absolute', '../services/api', '.envrc', 'secrets/api'])('rejects invalid or sensitive explicit paths: %s', async (requestedPath) => {
    const decision = await monorepoResolver().resolve(requestedPath)

    expect(decision).toEqual({ status: 'invalid-requested-path', candidates: [] })
  })

  it('rejects a sensitive directory in the middle of an otherwise manifest-backed requested path', async () => {
    const boundaryResolver = resolver(new Map([
      ['package.json', { workspaces: ['services/**'] }],
      ['services/.env/api/package.json', { dependencies: { express: '5.1.0' } }],
    ]))

    await expect(boundaryResolver.resolve('services/.env/api')).resolves.toEqual({ status: 'invalid-requested-path', candidates: [] })
  })

  it('never auto-selects manifests located beneath sensitive path segments', async () => {
    const decision = await resolver(new Map([
      ['package.json', { workspaces: ['services/**'] }],
      ['services/.env/api/package.json', { dependencies: { express: '5.1.0' } }],
      ['services/token/api/package.json', { dependencies: { fastify: '5.5.0' } }],
    ])).resolve()

    expect(decision).toEqual({ status: 'no-candidate', candidates: [] })
  })

  it('rejects nested .env ancestor paths consistently for explicit and automatic boundary resolution', async () => {
    const boundaryResolver = resolver(new Map([
      ['package.json', { workspaces: ['services/**'] }],
      ['services/src/.env/api/package.json', { dependencies: { express: '5.1.0' } }],
    ]))

    await expect(boundaryResolver.resolve('services/src/.env/api')).resolves.toEqual({ status: 'invalid-requested-path', candidates: [] })
    await expect(boundaryResolver.resolve()).resolves.toEqual({ status: 'no-candidate', candidates: [] })
  })

  it('rejects an explicit path whose on-disk ancestor is a symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'service-boundary-'))
    try {
      mkdirSync(join(root, 'services'))
      symlinkSync(fixturesRoot, join(root, 'services', 'escape'))
      const decision = await resolver(new Map([
        ['package.json', { workspaces: ['services/*'] }],
        ['services/escape/package.json', { dependencies: { express: '5.1.0' } }],
      ]), root).resolve('services/escape')

      expect(decision).toEqual({ status: 'invalid-requested-path', candidates: [] })
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('returns no-candidate for a frontend-only workspace', async () => {
    const decision = await resolver(new Map([
      ['package.json', { workspaces: ['apps/*'] }],
      ['apps/web/package.json', { dependencies: { react: '19.1.1' }, scripts: { start: 'vite' } }],
    ])).resolve()

    expect(decision).toEqual({ status: 'no-candidate', candidates: [] })
  })

  it('does not discard a fullstack package merely because it also declares a frontend dependency', async () => {
    const decision = await resolver(new Map([
      ['package.json', { workspaces: ['services/*'] }],
      ['services/fullstack/package.json', { dependencies: { express: '5.1.0', react: '19.1.1' }, scripts: { start: 'node server.js' } }],
    ])).resolve()

    expect(decision).toMatchObject({ status: 'selected', boundary: { relativeRoot: 'services/fullstack' } })
  })

  it('does not treat a React package with only a generic start script as a backend service', async () => {
    const decision = await resolver(new Map([
      ['package.json', { workspaces: ['apps/*'] }],
      ['apps/react-server/package.json', { dependencies: { react: '19.1.1' }, scripts: { start: 'node server.js' } }],
    ])).resolve()

    expect(decision).toEqual({ status: 'no-candidate', candidates: [] })
  })

  it('sorts bounded source paths before deriving detector evidence', async () => {
    const decision = await resolver(
      new Map([['package.json', {}]]),
      fixturesRoot,
      new Map([
        ['z/main.ts', "import { NestFactory } from '@nestjs/core'"],
        ['a/main.ts', "import { NestFactory } from '@nestjs/core'"],
      ]),
    ).resolve()

    expect(decision).toMatchObject({ status: 'selected', boundary: { evidence: [expect.objectContaining({ path: 'a/main.ts' })] } })
  })

  it.each(['secrets/api', 'services/.env/api', 'C:/service', '../service'])('rejects unsafe externally supplied persisted boundaries at runtime: %s', (relativeRoot) => {
    const boundaryResolver = resolver(new Map())
    const boundary = { relativeRoot, confidence: 'high' as const, evidence: [{ kind: 'manifest' as const, path: 'package.json', fact: 'declares a backend service', excerptHash: 'a'.repeat(64) }] }

    expect(() => boundaryResolver.resolveRuntime(boundary)).toThrow(/boundary|path|workspace/i)
  })

  it('fails closed for a persisted boundary with a non-string root', () => {
    const boundaryResolver = resolver(new Map())
    const boundary = { relativeRoot: null, confidence: 'high' as const, evidence: [{ kind: 'manifest' as const, path: 'package.json', fact: 'declares a backend service', excerptHash: 'a'.repeat(64) }] }

    expect(() => boundaryResolver.resolveRuntime(boundary as never)).toThrow(/boundary|path|workspace/i)
  })
})
