import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRuntimeManifest, parseSpecKitManifest, parseUvManifest, selectSpecKitArtifacts, selectUvArtifact, type RuntimeManifest } from '../src/runtime-manifest.js'
import * as publicApi from '../src/index.js'

const manifestRoot = resolve(import.meta.dirname, '../../../runtime-manifests')

describe('runtime manifests', () => {
  it('does not expose raw installers that can accept caller-constructed manifests', () => {
    expect(publicApi).not.toHaveProperty('UvInstaller')
    expect(publicApi).not.toHaveProperty('SpecKitInstaller')
  })

  it('selects the exact official uv artifact for the current architecture', async () => {
    const manifest = parseUvManifest(JSON.parse(await readFile(resolve(manifestRoot, 'uv-0.12.3.json'), 'utf8')))

    expect(selectUvArtifact(manifest, 'arm64')).toMatchObject({
      bytes: 17686637,
      sha256: '546f7f8a6c70ff13a3a9d2bc958db3427298cebf3e0cb756f9177133b7068843',
    })
    expect(selectUvArtifact(manifest, 'x64')).toMatchObject({
      bytes: 19547702,
      sha256: '4c9f52262a14da336e4a42ed24992d12d0c956acde87619e4611d321dffa602b',
    })
  })

  it('rejects malformed runtime manifests instead of accepting an incomplete install source', () => {
    expect(() => parseUvManifest({ version: '0.12.3', artifacts: {} })).toThrow(/manifest/i)
    expect(() => parseSpecKitManifest({ version: '0.16.5', git: 'https://github.com/github/spec-kit.git' })).toThrow(/manifest/i)
  })

  it('rejects uv artifact URLs with credentials even when they use HTTPS', async () => {
    const artifact = { component: 'uv', version: '0.12.3', license: 'MIT', source: 'https://github.com/astral-sh/uv', url: 'https://user:secret@releases.example.test/uv.tar.gz', bytes: 12, sha256: 'a'.repeat(64), allowedHosts: ['releases.example.test'], destination: '.backend-team/cache/uv.tar.gz' }
    expect(() => parseUvManifest({ component: 'uv', version: '0.12.3', license: 'MIT', source: 'https://github.com/astral-sh/uv', artifacts: { 'darwin-arm64': artifact, 'darwin-x64': { ...artifact, destination: '.backend-team/cache/uv-x64.tar.gz' } } })).toThrow(/manifest|credentials/i)
  })

  it('exposes a runtime-manifest contract that binds both pinned tools', async () => {
    const manifest: RuntimeManifest = parseRuntimeManifest({ uv: JSON.parse(await readFile(resolve(manifestRoot, 'uv-0.12.3.json'), 'utf8')), specKit: JSON.parse(await readFile(resolve(manifestRoot, 'spec-kit-0.16.5.json'), 'utf8')) })
    expect(manifest.specKit.executable).toBe('specify')
    expect(manifest.uv.artifacts['darwin-arm64'].bytes).toBe(17686637)
  })

  it('rejects unknown fields at the composite and artifact layers', async () => {
    const uv = JSON.parse(await readFile(resolve(manifestRoot, 'uv-0.12.3.json'), 'utf8')) as { artifacts: { 'darwin-arm64': Record<string, unknown> } }
    const specKit = JSON.parse(await readFile(resolve(manifestRoot, 'spec-kit-0.16.5.json'), 'utf8'))
    expect(() => parseRuntimeManifest({ uv, specKit, futurePolicy: 'ignored' })).toThrow(/manifest/i)
    uv.artifacts['darwin-arm64'].futureDigest = 'ignored'
    expect(() => parseUvManifest(uv)).toThrow(/artifact|manifest/i)
  })

  it('selects the complete architecture-specific Python closure without an online Git install', async () => {
    const manifest: RuntimeManifest = parseRuntimeManifest({ uv: JSON.parse(await readFile(resolve(manifestRoot, 'uv-0.12.3.json'), 'utf8')), specKit: JSON.parse(await readFile(resolve(manifestRoot, 'spec-kit-0.16.5.json'), 'utf8')) })
    const arm = selectSpecKitArtifacts(manifest.specKit, 'arm64'); const x64 = selectSpecKitArtifacts(manifest.specKit, 'x64')
    expect(arm).toEqual(expect.arrayContaining([expect.objectContaining({ component: 'python', bytes: 25156281, sha256: 'dbadb0ffe46f8bace50daaf8a0c5fc6903c003690776da9eb5269e33c856bb53' }), expect.objectContaining({ component: 'python-dependency', url: expect.stringContaining('cp313-cp313-macosx_11_0_arm64') })]))
    expect(x64).toEqual(expect.arrayContaining([expect.objectContaining({ component: 'python', bytes: 24927967, sha256: '187eed2282e9c3a5b6b14953d564ee25a9f35cf2c209c9fa292186ee48b0e4a1' }), expect.objectContaining({ component: 'python-dependency', url: expect.stringContaining('cp313-cp313-macosx_10_13_x86_64') })]))
    expect(arm.some((artifact) => artifact.url.startsWith('git+'))).toBe(false)
  })

  it('rejects incomplete and duplicate artifact metadata before a plan can be built', async () => {
    const raw = JSON.parse(await readFile(resolve(manifestRoot, 'spec-kit-0.16.5.json'), 'utf8')) as { artifacts: { common: Array<Record<string, unknown>> } }
    delete raw.artifacts.common[0]!.sha256
    expect(() => parseSpecKitManifest(raw)).toThrow(/artifact|manifest/i)
    const duplicate = JSON.parse(await readFile(resolve(manifestRoot, 'spec-kit-0.16.5.json'), 'utf8')) as { artifacts: { common: Array<Record<string, unknown>> } }
    duplicate.artifacts.common[1]!.destination = duplicate.artifacts.common[0]!.destination
    expect(() => parseSpecKitManifest(duplicate)).toThrow(/unique/i)
  })

  it.each([
    ['url', (artifact: Record<string, unknown>) => { artifact.url = 'https://files.pythonhosted.org/mirror/specify_cli-0.16.5-py3-none-any.whl' }],
    ['bytes', (artifact: Record<string, unknown>) => { artifact.bytes = Number(artifact.bytes) + 1 }],
    ['sha256', (artifact: Record<string, unknown>) => { artifact.sha256 = '0'.repeat(64) }],
    ['license', (artifact: Record<string, unknown>) => { artifact.license = 'Apache-2.0' }],
    ['source', (artifact: Record<string, unknown>) => { artifact.source = 'https://pypi.org/project/specify-cli/0.16.5/' }],
    ['allowedHosts', (artifact: Record<string, unknown>) => { artifact.allowedHosts = ['files.pythonhosted.org', 'mirror.example.test'] }],
  ])('rejects a %s drift even when the artifact version and filename remain pinned', async (_field, drift) => {
    const raw = JSON.parse(await readFile(resolve(manifestRoot, 'spec-kit-0.16.5.json'), 'utf8')) as { artifacts: { common: Array<Record<string, unknown>> } }
    drift(raw.artifacts.common[0]!)
    expect(() => parseSpecKitManifest(raw)).toThrow(/closure|manifest|artifact/i)
  })
})
