import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PolicyContext, PolicyDecision, PolicyEngine } from '@dsh-backend-team/contracts'
import { ManifestReader } from '../src/index.js'

const temporaryRoots: string[] = []

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'project-analyzer-manifest-'))
  temporaryRoots.push(root)
  return root
}

function policyContext(root: string): PolicyContext {
  return {
    workspace: {
      root,
      teamDir: join(root, '.backend-team'),
      stateDir: join(root, '.backend-team', 'state'),
      runtimeDir: join(root, '.backend-team', 'runtime'),
      cacheDir: join(root, '.backend-team', 'cache'),
      logsDir: join(root, '.backend-team', 'logs'),
      locksDir: join(root, '.backend-team', 'locks'),
      handoffDir: join(root, '.backend-team', 'handoff'),
    },
    phase: 'DISCOVER',
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true })
  delete (globalThis as Record<string, unknown>).__manifestExecuted
})

describe('ManifestReader', () => {
  it('parses package JSON as data and never executes a script value', () => {
    const root = workspace()
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'safe-project',
      engines: { node: '>=24 <25' },
      volta: { node: '24.19.0' },
      packageManager: 'npm@11.0.0',
      dependencies: { zod: '4.4.3' },
      scripts: { sentinel: 'globalThis.__manifestExecuted = true' },
      exports: './dist/index.js',
      privateField: 'must not be returned',
    }))

    const result = new ManifestReader(root).readPackage('package.json')

    expect(result).toEqual({
      ok: true,
      manifest: expect.objectContaining({
        name: 'safe-project',
        engines: { node: '>=24 <25' },
        volta: { node: '24.19.0' },
        packageManager: 'npm@11.0.0',
        dependencies: { zod: '4.4.3' },
        scripts: { sentinel: 'globalThis.__manifestExecuted = true' },
        exports: './dist/index.js',
      }),
    })
    expect((globalThis as Record<string, unknown>).__manifestExecuted).toBeUndefined()
    if (result.ok) expect(result.manifest).not.toHaveProperty('privateField')
  })

  it('returns safe structured errors for malformed and oversized manifests', () => {
    const malformedRoot = workspace()
    writeFileSync(join(malformedRoot, 'package.json'), '{not valid json')
    const oversizedRoot = workspace()
    writeFileSync(join(oversizedRoot, 'package.json'), '{"name":"' + 'x'.repeat(1024 * 1024) + '"}')

    const malformed = new ManifestReader(malformedRoot).readPackage('package.json')
    const oversized = new ManifestReader(oversizedRoot).readPackage('package.json')

    expect(malformed).toEqual({ ok: false, error: expect.objectContaining({ code: 'invalid-json' }) })
    expect(oversized).toEqual({ ok: false, error: expect.objectContaining({ code: 'too-large' }) })
    if (!malformed.ok) expect(malformed.error).not.toHaveProperty('raw')
  })

  it('refuses to read sensitive paths', () => {
    const root = workspace()
    writeFileSync(join(root, '.env'), 'PASSWORD=secret')

    const result = new ManifestReader(root).readPackage('.env')

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'sensitive-path', path: '.env' }) })
  })

  it('returns a safe error when policy denies a package manifest read', async () => {
    const root = workspace()
    writeFileSync(join(root, 'package.json'), '{"name":"denied"}')
    const policyEngine: PolicyEngine = {
      async authorize(): Promise<PolicyDecision> {
        return { effect: 'deny', ruleId: 'test-deny', reason: 'test denial' }
      },
    }

    const result = await new ManifestReader(root).readPackageAuthorized('package.json', { policyEngine, policyContext: policyContext(root) })

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'policy-denied', path: 'package.json' }) })
  })

  it('fails closed when an authorized read policy cannot bind the file descriptor', async () => {
    const root = workspace()
    writeFileSync(join(root, 'package.json'), '{"name":"safe"}')
    const policyEngine: PolicyEngine = {
      async authorize(): Promise<PolicyDecision> {
        return { effect: 'allow', ruleId: 'test-allow', reason: 'test allowance' }
      },
    }

    const result = await new ManifestReader(root).readPackageAuthorized('package.json', { policyEngine, policyContext: policyContext(root) })

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'policy-denied', path: 'package.json' }) })
  })

  it('does not allow a configured policy binding to be overridden per read', async () => {
    const root = workspace()
    writeFileSync(join(root, 'package.json'), '{"name":"safe"}')
    const configuredPolicy: PolicyEngine = {
      async authorize(): Promise<PolicyDecision> {
        return { effect: 'deny', ruleId: 'configured-deny', reason: 'configured denial' }
      },
    }
    const replacementPolicy: PolicyEngine = {
      async authorize(): Promise<PolicyDecision> {
        return { effect: 'allow', ruleId: 'replacement-allow', reason: 'replacement allowance' }
      },
    }
    const context = policyContext(root)
    const reader = new ManifestReader(root, { policyEngine: configuredPolicy, policyContext: context })

    const result = await reader.readPackageAuthorized('package.json', { policyEngine: replacementPolicy, policyContext: context })

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'policy-denied', path: 'package.json' }) })
  })

  it('parses bounded JSONC, YAML, and TOML documents as inert data', () => {
    const root = workspace()
    writeFileSync(join(root, 'data.jsonc'), '{\n  // comment\n  "name": "jsonc",\n}')
    writeFileSync(join(root, 'data.yaml'), 'name: yaml\nfeatures:\n  - safe\n')
    writeFileSync(join(root, 'data.toml'), 'name = "toml"\n[server]\nport = 3000\n')
    const reader = new ManifestReader(root)

    expect(reader.readDocument('data.jsonc')).toEqual({ ok: true, document: { format: 'jsonc', data: { name: 'jsonc' } } })
    expect(reader.readDocument('data.yaml')).toEqual({ ok: true, document: { format: 'yaml', data: { name: 'yaml', features: ['safe'] } } })
    expect(reader.readDocument('data.toml')).toEqual({ ok: true, document: { format: 'toml', data: { name: 'toml', server: { port: 3000 } } } })
  })

  it('returns safe errors for malformed, oversized, and sensitive documents', () => {
    const root = workspace()
    writeFileSync(join(root, 'bad.jsonc'), '{ invalid }')
    writeFileSync(join(root, 'large.yaml'), 'value: ' + 'x'.repeat(1024 * 1024))
    writeFileSync(join(root, '.env'), 'TOKEN=secret')
    const reader = new ManifestReader(root)

    const malformed = reader.readDocument('bad.jsonc')
    const oversized = reader.readDocument('large.yaml')
    const sensitive = reader.readDocument('.env')

    expect(malformed).toEqual({ ok: false, error: expect.objectContaining({ code: 'invalid-jsonc' }) })
    expect(oversized).toEqual({ ok: false, error: expect.objectContaining({ code: 'too-large' }) })
    expect(sensitive).toEqual({ ok: false, error: expect.objectContaining({ code: 'sensitive-path', path: '.env' }) })
    if (!malformed.ok) expect(malformed.error).not.toHaveProperty('raw')
  })
})
