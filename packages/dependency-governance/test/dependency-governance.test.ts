import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DependencyGovernance,
  LicensePolicy,
  buildCycloneDxBom,
  buildCycloneDxBomFromPackageLock,
  normalizeNpmAudit,
  NpmAuditAdapter,
  normalizeOsvResponse,
  OsvAdapter,
  LifecyclePolicy,
  writeCycloneDxBom,
  type DependencyProposal,
} from '../src/index.js'

const proposal = (license: string): DependencyProposal => ({
  name: 'example-package', version: '1.2.3', type: 'runtime', purpose: 'test utility',
  alternatives: ['a maintained in-house helper'], repository: 'https://github.com/example/example-package',
  licenses: [license], transitive: [], lifecycleScripts: {}, telemetry: 'none', network: 'none',
  maintenance: { lastRelease: '2026-01-01', repositoryArchived: false, evidence: 'reviewed' },
  replacementPath: 'remove the package and use the standard library', requestedFiles: ['package.json', 'package-lock.json'],
})

describe('dependency governance', () => {
  it.each(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'PostgreSQL'])('permits reviewed %s licenses', (license) => {
    expect(new LicensePolicy().classify(license)).toBe('normal-review')
  })

  it.each(['GPL-3.0', 'AGPL-3.0', 'SSPL-1.0', 'UNKNOWN'])('does not automatically permit %s', (license) => {
    expect(new LicensePolicy().classify(license)).not.toBe('normal-review')
  })

  it('denies unknown licenses and asks for a special review for reciprocal licenses', async () => {
    const governance = new DependencyGovernance({ npmAudit: async () => [], osv: async () => [] })
    await expect(governance.review(proposal('UNKNOWN'), { networkApproved: true, installApproved: true })).resolves.toMatchObject({ effect: 'deny' })
    await expect(governance.review(proposal('AGPL-3.0'), { networkApproved: true, installApproved: true })).resolves.toMatchObject({ effect: 'ask-special-license-review' })
  })

  it('blocks a severe unpatched vulnerability in a new dependency', async () => {
    const governance = new DependencyGovernance({
      npmAudit: async () => [{ id: 'GHSA-1', packageName: 'example-package', severity: 'critical', vulnerableRange: '<1.2.4', fixVersions: [], source: 'npm-audit' }],
      osv: async () => [],
    })
    await expect(governance.review(proposal('MIT'), { networkApproved: true, installApproved: true })).resolves.toMatchObject({ effect: 'deny', findings: [{ severity: 'critical' }] })
  })

  it('normalizes npm and OSV findings without losing source or fixed versions', () => {
    expect(normalizeNpmAudit({ vulnerabilities: { example: { severity: 'high', via: [{ source: 12, title: 'Issue', range: '<2', fixAvailable: { version: '2.0.0' } }] } } })).toEqual([
      expect.objectContaining({ packageName: 'example', severity: 'high', source: 'npm-audit', fixVersions: ['2.0.0'] }),
    ])
    expect(normalizeOsvResponse({ results: [{ packages: [{ package: { name: 'example', ecosystem: 'npm' }, vulnerabilities: [{ id: 'OSV-1', severity: [{ type: 'CVSS_V3', score: '9.8' }], affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '2.0.0' }] }] }] }] }] }] })).toEqual([
      expect.objectContaining({ id: 'OSV-1', packageName: 'example', source: 'osv', fixVersions: ['2.0.0'], severity: 'critical' }),
    ])
  })

  it('resolves querybatch vulnerability IDs through the official detail endpoint', async () => {
    const calls: string[] = []
    const adapter = new OsvAdapter({ fetch: async (input) => {
      calls.push(String(input))
      if (String(input).endsWith('/querybatch')) return new Response(JSON.stringify({ results: [{ vulns: [{ id: 'OSV-1', modified: '2026-01-01T00:00:00Z' }] }] }))
      return new Response(JSON.stringify({ id: 'OSV-1', summary: 'fixture', database_specific: { severity: 'HIGH' }, affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '2.0.0' }] }] }] }))
    } }, 'https://api.osv.dev/v1/querybatch')
    const finding = await adapter.query(proposal('MIT'), new AbortController().signal)
    expect(finding).toEqual([expect.objectContaining({ id: 'OSV-1', packageName: 'example-package', severity: 'high', fixVersions: ['2.0.0'] })])
    expect(calls).toEqual(['https://api.osv.dev/v1/querybatch', 'https://api.osv.dev/v1/vulns/OSV-1'])
  })

  it('generates a CycloneDX 1.5 BOM with package hashes and licenses', () => {
    const bom = buildCycloneDxBom({ serial: 'urn:uuid:test', components: [{ name: 'example', version: '1.2.3', purl: 'pkg:npm/example@1.2.3', hash: 'a'.repeat(64), licenses: ['MIT'] }] })
    expect(bom.bomFormat).toBe('CycloneDX')
    expect(bom.specVersion).toBe('1.5')
    expect(bom.components[0]).toMatchObject({ 'bom-ref': 'pkg:npm/example@1.2.3', name: 'example', version: '1.2.3', hashes: [{ alg: 'SHA-256' }], licenses: [{ license: { id: 'MIT' } }] })
  })

  it('builds a BOM from lockfile package entries', () => {
    const bom = buildCycloneDxBomFromPackageLock({ packages: {
      'node_modules/example': { name: 'example', version: '1.2.3', license: 'MIT', integrity: 'sha512-YQ==', dependencies: { transitive: '^1.0.0' } },
      'node_modules/transitive': { name: 'transitive', version: '1.0.0', license: 'MIT' },
    } }, 'urn:uuid:lock')
    expect(bom.components).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'example', version: '1.2.3', purl: 'pkg:npm/example@1.2.3', hashes: [{ alg: 'SHA-512', content: '61' }] })]))
    expect(bom.dependencies).toEqual([{ ref: 'pkg:npm/example@1.2.3', dependsOn: ['pkg:npm/transitive@1.0.0'] }])
  })

  it('defaults to blocked when network approval is absent', async () => {
    const audit = async () => { throw new Error('network must not be called') }
    const governance = new DependencyGovernance({ npmAudit: audit, osv: audit })
    await expect(governance.review(proposal('MIT'))).resolves.toMatchObject({ effect: 'blocked' })
  })

  it('keeps npm audit execution inside the workspace and fails closed on non-zero exit', async () => {
    expect(() => new NpmAuditAdapter({ run: async () => ({ code: 0, stdout: '{}', stderr: '' }) }, {
      npmExecutable: '/workspace/../outside/npm', cwd: '/workspace', workspaceRoot: '/workspace',
    })).toThrow(/workspace-local/)
    const calls: Array<{ executable: string; args: string[]; cwd: string; env?: Record<string, string> }> = []
    const adapter = new NpmAuditAdapter({ run: async (executable, args, options) => {
      calls.push({ executable, args, cwd: options.cwd, ...(options.env === undefined ? {} : { env: options.env }) })
      return { code: 1, stdout: JSON.stringify({ vulnerabilities: {} }), stderr: 'audit failed' }
    } }, { npmExecutable: '/workspace/.backend-team/node/bin/npm', cwd: '/workspace/project', workspaceRoot: '/workspace' })
    await expect(adapter.query()).rejects.toThrow(/exit code 1/)
    expect(calls[0]).toMatchObject({ executable: '/workspace/.backend-team/node/bin/npm', args: ['audit', '--json', '--ignore-scripts'], cwd: '/workspace/project' })
    expect(calls[0]?.env).toMatchObject({ NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_AUDIT: 'true' })
  })

  it('requires exact lifecycle package approval before rebuild', () => {
    const policy = new LifecyclePolicy()
    const reviewed = policy.review([{ packageName: 'native-addon', packageVersion: '1.0.0', scriptName: 'install', command: 'node-gyp rebuild' }])
    expect(reviewed.installArgs).toEqual(['install', '--ignore-scripts'])
    expect(() => policy.rebuildCommand(reviewed.scripts, [])).toThrow(/exact package/)
    expect(policy.rebuildCommand(reviewed.scripts, reviewed.scripts)).toEqual(['rebuild', 'native-addon'])
  })

  it('rejects an SBOM path that traverses a symlinked workspace directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sbom-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-sbom-outside-'))
    try {
      await mkdir(join(root, '.backend-team'))
      await symlink(outside, join(root, '.backend-team', 'runs'))
      await expect(writeCycloneDxBom(root, 'run-1', buildCycloneDxBom({ serial: 'urn:uuid:test', components: [] }))).rejects.toThrow(/SBOM directory/)
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
    }
  })
})
