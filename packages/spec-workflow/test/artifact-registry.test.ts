import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactRegistry } from '../src/artifact-registry.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(): Promise<{ root: string; feature: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifact-registry-'))
  roots.push(root)
  const feature = join(root, 'specs/001-orders')
  await (await import('node:fs/promises')).mkdir(join(feature, 'contracts'), { recursive: true })
  await (await import('node:fs/promises')).mkdir(join(root, '.specify'), { recursive: true })
  await writeFile(join(root, '.specify/feature.json'), JSON.stringify({ feature_directory: 'specs/001-orders' }))
  return { root, feature }
}

describe('feature artifact registry', () => {
  it('resolves the explicit environment feature directory before feature.json', async () => {
    const { root } = await fixture()
    const alternate = join(root, 'specs/002-explicit')
    await (await import('node:fs/promises')).mkdir(alternate, { recursive: true })
    await writeFile(join(root, '.specify/feature.json'), JSON.stringify({ feature_directory: 'specs/001-orders' }))
    await writeFile(join(alternate, 'spec.md'), '# Explicit\n')

    const snapshot = await new ArtifactRegistry(root, { environment: { SPECIFY_FEATURE_DIRECTORY: alternate } }).snapshot()
    expect(snapshot.featureDirectory).toBe(await realpath(alternate))
    expect(snapshot.artifacts.map((artifact) => artifact.path)).toEqual(['spec.md'])
  })

  it('rejects a feature directory outside workspace/specs', async () => {
    const { root } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-artifact-outside-'))
    roots.push(outside)
    await expect(new ArtifactRegistry(root, { environment: { SPECIFY_FEATURE_DIRECTORY: outside } }).snapshot()).rejects.toThrow(/specs|workspace/i)
  })

  it('snapshots exact file bytes and SHA-256 for known artifacts', async () => {
    const { root, feature } = await fixture()
    await writeFile(join(feature, 'spec.md'), '# Orders\n\nbytes matter\n')
    await writeFile(join(feature, 'contracts/openapi.yaml'), 'openapi: 3.1.0\n')

    const snapshot = await new ArtifactRegistry(root).snapshot()
    expect(snapshot.artifacts).toHaveLength(2)
    expect(snapshot.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'spec.md', bytes: (await readFile(join(feature, 'spec.md'))).byteLength, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: 'contracts/openapi.yaml', bytes: (await readFile(join(feature, 'contracts/openapi.yaml'))).byteLength, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]))
  })
})
