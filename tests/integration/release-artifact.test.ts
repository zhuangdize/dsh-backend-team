import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeReleaseMaterials, verifyReleaseMaterials } from '../../scripts/release-materials.mjs'

describe('release artifact policy', () => {
  it('keeps the checked-in runtime manifest blocked until native hashes exist', async () => {
    const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../../runtime-manifests/postgresql-18.6-darwin.json'), 'utf8')) as { status: string; artifacts: unknown[] }
    expect(manifest.status).toBe('pending-native-build')
    expect(manifest.artifacts).toHaveLength(0)
  })

  it('rejects a release when the Agent runtime fixture is only partially verified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-release-policy-'))
    try {
      const tarball = join(root, 'bundle.tgz')
      const digest = 'a'.repeat(64)
      const manifest = join(root, 'postgresql.json')
      const fixture = join(root, 'agent-runtime.json')
      const evidence = join(root, 'release-evidence.json')
      await writeFile(tarball, 'bundle')
      await writeFile(manifest, JSON.stringify(validManifest(digest)))
      await writeFile(fixture, JSON.stringify({ status: 'partial-verified', notProven: ['production binding remains blocked'] }))
      await writeFile(evidence, JSON.stringify(validEvidence()))
      await writeFile(`${tarball}.sha256`, `${digest}  ${tarball.split('/').at(-1)}\n`)

      const result = await run(process.execPath, [resolve(import.meta.dirname, '../../scripts/verify-release.mjs'), '--tarball', tarball, '--manifest', manifest, '--agent-fixture', fixture, '--evidence', evidence])
      expect(result.code).not.toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).toContain('INCOMPLETE_AGENT_RUNTIME_PROVENANCE')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a runtime manifest that does not contain both distinct native Darwin architectures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-release-architecture-'))
    try {
      const tarball = join(root, 'bundle.tgz')
      const digest = 'b'.repeat(64)
      const manifest = join(root, 'postgresql.json')
      const fixture = join(root, 'agent-runtime.json')
      const evidence = join(root, 'release-evidence.json')
      await writeFile(tarball, 'bundle')
      await writeFile(manifest, JSON.stringify({ ...validManifest(digest), artifacts: [validManifest(digest).artifacts[0], { ...validManifest(digest).artifacts[0], architecture: 'darwin-arm64' }] }))
      await writeFile(fixture, JSON.stringify(validAgentFixture()))
      await writeFile(evidence, JSON.stringify(validEvidence()))
      await writeFile(`${tarball}.sha256`, `${digest}  bundle.tgz\n`)

      const result = await run(process.execPath, [resolve(import.meta.dirname, '../../scripts/verify-release.mjs'), '--tarball', tarball, '--manifest', manifest, '--agent-fixture', fixture, '--evidence', evidence])
      expect(result.code).not.toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).toContain('INCOMPLETE_RUNTIME_PROVENANCE')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires an explicit tarball and its matching checksum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-release-checksum-'))
    try {
      const tarball = join(root, 'bundle.tgz')
      const digest = 'c'.repeat(64)
      const manifest = join(root, 'postgresql.json')
      const fixture = join(root, 'agent-runtime.json')
      const evidence = join(root, 'release-evidence.json')
      await writeFile(tarball, 'bundle')
      await writeFile(manifest, JSON.stringify(validManifest(digest)))
      await writeFile(fixture, JSON.stringify(validAgentFixture()))
      await writeFile(evidence, JSON.stringify(validEvidence()))

      const missingTarball = await run(process.execPath, [resolve(import.meta.dirname, '../../scripts/verify-release.mjs'), '--manifest', manifest, '--agent-fixture', fixture, '--evidence', evidence])
      expect(missingTarball.code).not.toBe(0)
      expect(`${missingTarball.stdout}\n${missingTarball.stderr}`).toContain('TARBALL_REQUIRED')

      const missingChecksum = await run(process.execPath, [resolve(import.meta.dirname, '../../scripts/verify-release.mjs'), '--tarball', tarball, '--manifest', manifest, '--agent-fixture', fixture, '--evidence', evidence])
      expect(missingChecksum.code).not.toBe(0)
      expect(`${missingChecksum.stdout}\n${missingChecksum.stderr}`).toContain('MISSING_TARBALL_CHECKSUM')

      await writeFile(`${tarball}.sha256`, `${'d'.repeat(64)}  bundle.tgz\n`)
      const mismatchedChecksum = await run(process.execPath, [resolve(import.meta.dirname, '../../scripts/verify-release.mjs'), '--tarball', tarball, '--manifest', manifest, '--agent-fixture', fixture, '--evidence', evidence])
      expect(mismatchedChecksum.code).not.toBe(0)
      expect(`${mismatchedChecksum.stdout}\n${mismatchedChecksum.stderr}`).toContain('TARBALL_HASH_MISMATCH')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires explicit passed evidence for coordinator, browser, model, and DbGate gates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-release-evidence-'))
    try {
      const tarball = join(root, 'bundle.tgz')
      const digest = 'e'.repeat(64)
      const manifest = join(root, 'postgresql.json')
      const fixture = join(root, 'agent-runtime.json')
      const evidence = join(root, 'release-evidence.json')
      await writeFile(tarball, 'bundle')
      await writeFile(manifest, JSON.stringify(validManifest(digest)))
      await writeFile(fixture, JSON.stringify(validAgentFixture()))
      await writeFile(`${tarball}.sha256`, `${sha256('bundle')}  bundle.tgz\n`)
      await writeFile(evidence, JSON.stringify({ ...validEvidence(), gates: { ...validEvidence().gates, 'browser-codex-chrome': { status: 'not-run', reason: 'pending' } } }))

      const result = await run(process.execPath, [resolve(import.meta.dirname, '../../scripts/verify-release.mjs'), '--tarball', tarball, '--manifest', manifest, '--agent-fixture', fixture, '--evidence', evidence])
      expect(result.code).not.toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).toContain('INCOMPLETE_RELEASE_EVIDENCE')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds a local archive to its SBOM, lockfile and license materials', async () => {
    const root = resolve(import.meta.dirname, '../..')
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-release-materials-'))
    try {
      const tarball = join(temporary, 'bundle.tgz')
      await writeFile(tarball, 'bundle')
      const result = await writeReleaseMaterials({ root, tarball, channel: 'local-development', packageFiles: ['package/LICENSES/THIRD_PARTY_NOTICES.md'] })
      const verified = await verifyReleaseMaterials({ root, tarball, channel: 'local-development' })
      expect(result.archiveSha256).toBe(sha256('bundle'))
      expect(verified.archiveSha256).toBe(result.archiveSha256)
      expect(verified.componentCount).toBeGreaterThan(0)
      const sbomPath = `${tarball}.cdx.json`
      const sbom = JSON.parse(await readFile(sbomPath, 'utf8')) as { components: unknown[] }
      sbom.components = sbom.components.slice(1)
      await writeFile(sbomPath, `${JSON.stringify(sbom)}\n`)
      await expect(verifyReleaseMaterials({ root, tarball, channel: 'local-development' })).rejects.toThrow(/release materials do not match|SBOM components do not match/)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('keeps a local material set blocked for release-candidate use until signed', async () => {
    const root = resolve(import.meta.dirname, '../..')
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-release-signature-'))
    try {
      const tarball = join(temporary, 'bundle.tgz')
      await writeFile(tarball, 'bundle')
      await writeReleaseMaterials({ root, tarball, channel: 'local-development', packageFiles: ['package/LICENSES/THIRD_PARTY_NOTICES.md'] })
      await expect(verifyReleaseMaterials({ root, tarball, channel: 'release-candidate' })).rejects.toThrow(/signature is not verified/)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('continues to verify legacy unsigned material sidecars', async () => {
    const root = resolve(import.meta.dirname, '../..')
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-release-legacy-materials-'))
    try {
      const tarball = join(temporary, 'bundle.tgz')
      await writeFile(tarball, 'bundle')
      await writeReleaseMaterials({ root, tarball, channel: 'local-development', packageFiles: ['package/LICENSES/THIRD_PARTY_NOTICES.md'] })
      const materialsPath = `${tarball}.materials.json`
      const materials = JSON.parse(await readFile(materialsPath, 'utf8')) as { distribution: Record<string, unknown> }
      materials.distribution = { signature: { status: 'not-attested', provider: null }, stableDownloadUrl: null, runtimeProvenance: 'external-release-gate' }
      await writeFile(materialsPath, `${JSON.stringify(materials)}\n`)
      await expect(verifyReleaseMaterials({ root, tarball, channel: 'local-development' })).resolves.toMatchObject({ archiveSha256: sha256('bundle') })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('accepts an externally verified signature only when it is bound to the archive digest', async () => {
    const root = resolve(import.meta.dirname, '../..')
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-release-attested-'))
    try {
      const tarball = join(temporary, 'bundle.tgz')
      await writeFile(tarball, 'bundle')
      const archiveSha256 = sha256('bundle')
      await writeReleaseMaterials({
        root,
        tarball,
        channel: 'release-candidate',
        packageFiles: ['package/LICENSES/THIRD_PARTY_NOTICES.md'],
        distribution: {
          signature: { status: 'verified', provider: 'release-signer', evidenceRef: 'attestation://bundle/1', artifactSha256: archiveSha256 },
          stableDownloadUrl: 'https://downloads.example.test/dsh-backend-team-bundle-0.1.0.tgz',
          runtimeProvenance: 'ci-release-gate',
        },
      })
      const verified = await verifyReleaseMaterials({ root, tarball, channel: 'release-candidate' })
      expect(verified.archiveSha256).toBe(archiveSha256)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('rejects a verified distribution whose signature digest does not match the archive', async () => {
    const root = resolve(import.meta.dirname, '../..')
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-release-attested-mismatch-'))
    try {
      const tarball = join(temporary, 'bundle.tgz')
      await writeFile(tarball, 'bundle')
      await expect(writeReleaseMaterials({
        root,
        tarball,
        channel: 'release-candidate',
        packageFiles: ['package/LICENSES/THIRD_PARTY_NOTICES.md'],
        distribution: {
          signature: { status: 'verified', provider: 'release-signer', evidenceRef: 'attestation://bundle/1', artifactSha256: '0'.repeat(64) },
          stableDownloadUrl: 'https://downloads.example.test/dsh-backend-team-bundle-0.1.0.tgz',
        },
      })).rejects.toThrow(/digest does not match/)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})

function validManifest(digest: string) {
  return {
    schemaVersion: 1,
    component: 'postgresql',
    version: '18.6',
    status: 'verified',
    sourceManifest: 'postgresql-source-18.6.json',
    artifacts: [
      { architecture: 'darwin-arm64', version: '18.6', url: 'https://release.example.test/postgresql-arm64.tar.xz', bytes: 10, sha256: digest, attestation: 'attest-arm64' },
      { architecture: 'darwin-x64', version: '18.6', url: 'https://release.example.test/postgresql-x64.tar.xz', bytes: 10, sha256: digest, attestation: 'attest-x64' },
    ],
  }
}

function validAgentFixture() {
  return {
    schemaVersion: 1,
    status: 'verified',
    harness: '0.1.0-rc.6',
    adapter: { entry: 'packages/harness-adapter/dist/harness-agent-runtime.js' },
    publicSurface: { create: 'ctx.agents.create({ sessionId, meta, agentOptions })' },
    observed: { assistantEvent: 'assistant/message', disposed: true },
    notProven: [],
  }
}

function validEvidence() {
  return {
    schemaVersion: 1,
    gates: {
      'production-coordinator': { status: 'passed', evidenceRef: 'artifacts/production-coordinator.json' },
      'browser-codex-chrome': { status: 'passed', evidenceRef: 'artifacts/browser/run-1.json' },
      'real-model-api': { status: 'passed', evidenceRef: 'artifacts/model/run-1.json', provider: 'qwen-4399', model: 'qwen3.8-flash', api: 'openai-responses' },
      'dbgate-gui': { status: 'passed', evidenceRef: 'artifacts/dbgate/run-1.json' },
    },
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function run(file: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, { cwd: resolve(import.meta.dirname, '../..'), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('close', (code) => resolveRun({ code, stdout, stderr }))
  })
}
